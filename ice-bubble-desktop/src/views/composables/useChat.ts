/**
 * useChat.ts — 聊天消息状态管理 composable
 *
 * 管理 messages 列表、发送/流式状态、错误状态，
 * 通过 SSE 实时接收 assistant 消息，支持历史加载。
 */

import { ref, shallowRef, onUnmounted, type Ref } from 'vue'
import {
  sendChat,
  abortChat,
  getChatStream,
  SSEMessageEvent,
  SSEErrorEvent,
  SSEStatusEvent,
} from '@/api/chat'
import { api } from '@/api/client'

// ============ 类型 ============

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  /** optimistic update 标记，服务端确认后置 false */
  isLocal: boolean
  /** 发送失败时可重试 */
  sendFailed?: boolean
  // 时间线扩展字段（可选）
  agentName?: string | null
  avatar?: string | null
  model?: string | null
  // 原始字段（供前端过滤）
  messageType?: string | null
  sourceChannel?: string | null
}

interface UseChatOptions {
  /** 初始是否自动连接 SSE */
  autoConnect?: boolean
}

export interface UseChatReturn {
  messages: Ref<ChatMessage[]>
  loading: Ref<boolean>
  streaming: Ref<boolean>
  sending: Ref<boolean>
  error: Ref<string | null>
  send: (message: string) => Promise<void>
  abort: () => void
  connectSSE: () => void
  disconnectSSE: () => void
  reconnect: () => void
  loadHistory: (sessionKey: string, limit?: number) => Promise<void>
}

// ============ 实现 ============

let _localIdCounter = 0
// 分页状态（供加载更多使用）
let _hasMoreHistory = false
let _oldestTimestamp: string | null = null
// 导出供外部访问
export function getHistoryPagination() { return { hasMore: _hasMoreHistory, oldest: _oldestTimestamp } }
function genLocalId(): string {
  return `local_${Date.now()}_${++_localIdCounter}`
}



export function useChat(
  sessionKey: string | (() => string),
  _options?: UseChatOptions,
): UseChatReturn {
  // 支持传入 Ref 或直接传入 string 或 getter
  const getSessionKey = (): string =>
    typeof sessionKey === 'function' ? sessionKey() : sessionKey

  const messages: Ref<ChatMessage[]> = ref([])
  const loading = ref(false)
  const streaming = ref(false)
  const sending = ref(false)
  const error = ref<string | null>(null)

  /** SSE EventSource 实例 */
  const eventSource = shallowRef<EventSource | null>(null)

  // SSE 重试
  const MAX_RETRIES = 3
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  // ============ SSE 连接 ============

  function onSSEMessage(data: SSEMessageEvent) {
    retryCount = 0

    // Gateway pushes ALL messages (user + assistant) for the session.
    // Skip user messages — they were already added via optimistic update in send().
    if (data.role === 'user') {
      return
    }

    const assistantMsg: ChatMessage = {
      id: data.messageId,
      role: data.role,
      content: data.content,
      timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
      isLocal: false,
    }

    // Dedup: skip if a message with the same id already exists (e.g. history reload race)
    if (messages.value.some((m) => m.id === assistantMsg.id)) {
      return
    }

    streaming.value = false // complete message received, streaming done
    messages.value.push(assistantMsg)
  }

  function onSSEError(data: SSEErrorEvent) {
    error.value = data.message ?? 'SSE 连接错误'
    streaming.value = false
    disconnectSSE()

    if (retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount) * 1000 // 2s, 4s, 8s
      retryCount++
      retryTimer = setTimeout(() => {
        connectSSE()
      }, delay)
    }
  }

  function onSSEStatus(data: SSEStatusEvent) {
    if (!data.connected) {
      streaming.value = false
    }
  }

  function connectSSE() {
    disconnectSSE()
    const key = getSessionKey()
    if (!key) return

    const es = getChatStream(key, {
      onMessage: onSSEMessage,
      onError: onSSEError,
      onStatus: onSSEStatus,
    })

    eventSource.value = es
    error.value = null
    // Don't set streaming.value = true here.
    // Streaming should be true only while waiting for a response after sending.
    // The SSE connection stays open to receive messages at any time.
  }

  function disconnectSSE() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (eventSource.value) {
      eventSource.value.close()
      eventSource.value = null
    }
    streaming.value = false
  }

  function reconnect() {
    retryCount = 0
    error.value = null
    connectSSE()
  }

  // ============ 发送消息 ============

  async function send(message: string): Promise<void> {
    if (!message.trim()) return
    if (sending.value || streaming.value) return

    const key = getSessionKey()
    const trimmed = message.trim()

    // optimistic update：立即追加用户消息
    const userMsg: ChatMessage = {
      id: genLocalId(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      isLocal: true,
    }
    messages.value.push(userMsg)

    sending.value = true
    error.value = null

    try {
      const result = await sendChat(key, trimmed)
      if (!result.success) {
        // 标记消息为发送失败
        userMsg.sendFailed = true
        userMsg.isLocal = false
        error.value = result.error ?? '发送失败'
      } else {
        // 服务端确认，移除 local 标记
        userMsg.id = result.messageId ?? userMsg.id
        userMsg.isLocal = false
        // 消息已发送，等待 agent 回复（SSE 会设置 streaming=false）
        streaming.value = true
      }
    } catch (e: any) {
      userMsg.sendFailed = true
      userMsg.isLocal = false
      error.value = e.message ?? '网络错误'
    } finally {
      sending.value = false
    }
  }

  function abort(): void {
    const key = getSessionKey()
    abortChat(key).catch(() => {
      // abort 失败静默处理
    })
    disconnectSSE()

    // 追加系统中止消息
    messages.value.push({
      id: genLocalId(),
      role: 'system',
      content: '已中止生成',
      timestamp: Date.now(),
      isLocal: false,
    })
  }

  // ============ 加载历史消息 ============

  async function loadHistory(sessionKeyValue: string, limit = 100): Promise<void> {
    loading.value = true
    error.value = null
    try {
      // 使用 timeline API，自动继承噪音过滤（cron/Sender metadata/HEARTBEAT等）
      const res = await api.getChatTimeline(sessionKeyValue, { limit })
      const msgs = res.messages ?? []
      // timeline按时间倒序返回，反转为正序
      const historical: ChatMessage[] = msgs.reverse().map((m) => ({
        id: String(m.id),
        role: m.message_type === 'agent' ? 'assistant' : 'user',
        content: m.clean_content || m.content || '',
        timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
        isLocal: false,
        agentName: m.agent_name || undefined,
        avatar: m.avatar || null,
        model: m.model || null,
        messageType: m.message_type,
        sourceChannel: m.source_channel || null,
      }))
      messages.value = historical
      // 记录分页游标
      _hasMoreHistory = res.has_more
      _oldestTimestamp = res.pagination?.oldest ?? null
    } catch (e: any) {
      error.value = e.message ?? '加载历史消息失败'
    } finally {
      loading.value = false
    }
  }

  // ============ 清理 ============

  onUnmounted(() => {
    disconnectSSE()
  })

  return {
    messages,
    loading,
    streaming,
    sending,
    error,
    send,
    abort,
    connectSSE,
    disconnectSSE,
    reconnect,
    loadHistory,
  }
}
