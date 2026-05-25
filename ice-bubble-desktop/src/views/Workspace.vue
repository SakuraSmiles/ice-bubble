<script setup lang="ts">
/**
 * Workspace.vue — 聊天页面（重构版）
 *
 * 状态管理原则：
 *   1. URL 是唯一的状态来源（/workspace/:key 和 /chat）。
 *   2. Agent 切换通过 onAgentSwitch() 显式处理，不用 watch(selectedAgent)。
 *   3. OpenCode 和 OpenClaw 是两种独立模式，各走各的路径。
 *   4. ChatTimeline 在 view 切换时保持挂载（同一 key），避免消息丢失。
 */
import { ref, reactive, watch, computed, nextTick, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatInputStore } from '@/stores/chat-input'
import { gatewayClient } from '@/services/gateway-client'
import { request } from '../api/client'
import AppFooter from '../components/AppFooter.vue'
import PageHeader from '../components/PageHeader.vue'
import ChatTimeline from './components/ChatTimeline.vue'
import OpenCodeChatPanel from './components/chat/OpenCodeChatPanel.vue'
import SessionList from './components/SessionList.vue'
import { Loading } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { getMainSessionKey } from './components/chat/session-cache'
import AgentSelector from './components/chat/AgentSelector.vue'
import type { AgentOption } from './components/chat/AgentSelector.vue'
import { sendOpenCodeChat } from '../api/opencode'

// ============================================================
// 基础设施
// ============================================================
const route = useRoute()
const router = useRouter()
const gatewayConnected = inject<{ value: boolean }>('gatewayConnected') ?? { value: false }

// ============================================================
// URL 解析（唯一的状态来源）
// ============================================================
const urlSessionKey = computed(() => {
  const key = route.params.key as string || ''
  return key ? decodeURIComponent(key) : ''
})

// 从 sessionKey 提取 agent ID（如 "agent:main:xxx" → "main"）
const urlAgentId = computed(() => {
  const m = urlSessionKey.value.match(/^agent:([^:]+)/)
  return m ? m[1] : ''
})

// ============================================================
// Agent 状态
// ============================================================
const selectedAgent = ref<AgentOption>({
  platform: 'openclaw', agent: 'main', label: '虾头', emoji: '🦐', tag: 'OpenClaw',
})

// 各 agent 的会话缓存，key: "platform:agent", value: sessionKey 或 sessionId
const agentSessionMap = reactive<Record<string, string>>({})

function getAgentKey(agent: AgentOption): string {
  return `${agent.platform}:${agent.agent}`
}

// OpenCode 专用 sessionId（不参与 URL 路由）
const openCodeSessionId = ref<string | undefined>()

const isOpenCodeMode = computed(() => selectedAgent.value.platform === 'opencode')

// 当前会话标识：OpenClaw → sessionKey，OpenCode → sessionId（仅用于 API 调用）
const activeSessionKey = computed(() => {
  if (urlSessionKey.value) return urlSessionKey.value
  if (!isOpenCodeMode.value) {
    return agentSessionMap[getAgentKey(selectedAgent.value)] || ''
  }
  return ''
})

// ChatTimeline 的 key（变化时重建组件；同一 agent 内保持稳定）
const timelineKey = computed(() => {
  if (urlSessionKey.value) return urlSessionKey.value
  if (isOpenCodeMode.value) return `opencode-${selectedAgent.value.agent}`
  return `nocap-${selectedAgent.value.agent}`
})

// ChatTimeline 的 session-key prop：
//   OpenClaw → 真实 sessionKey；OpenCode → 空字符串（消息通过 addOptimisticMessage 管理）
const timelineSessionKey = computed(() => {
  return isOpenCodeMode.value ? '' : activeSessionKey.value || ''
})

// 输入框缓存的 context key
const inputContextKey = computed(() => {
  if (isOpenCodeMode.value) return `opencode:${selectedAgent.value.agent}`
  return activeSessionKey.value || `nocap:${selectedAgent.value.agent}`
})

// ============================================================
// 视图状态机
// ============================================================
type ViewState = 'loading' | 'list' | 'chat' | 'no-session'
const view = ref<ViewState>('loading')

// 从 ?platform=xxx&agent=xxx 还原 Agent
function initAgentFromQuery() {
  const q = route.query
  const platform = q.platform as string
  const agentParam = q.agent as string
  if (platform === 'opencode' && (agentParam === 'build' || agentParam === 'plan')) {
    selectedAgent.value = {
      platform: 'opencode', agent: agentParam, label: agentParam,
      emoji: agentParam === 'build' ? '🔨' : '📋', tag: 'OpenCode',
    }
  } else if (platform === 'openclaw' && agentParam === 'main') {
    selectedAgent.value = {
      platform: 'openclaw', agent: 'main', label: '虾头', emoji: '🦐', tag: 'OpenClaw',
    }
  }
}

// ============================================================
// 会话加载
// ============================================================

/** 加载指定 agent 的最近一次会话，返回 session key/id（无会话返回 null） */
async function loadRecentSession(agent: AgentOption): Promise<string | null> {
  const agentKey = getAgentKey(agent)
  try {
    if (agent.platform === 'opencode') {
      const res = await request(`/sessions?agent_id=opencode:${encodeURIComponent(agent.agent)}&platform=opencode&limit=1`)
      if (!res.ok) return null
      const data = await res.json()
      const sessions = (data.sessions || []) as any[]
      if (sessions.length === 0) return null
      const latest = sessions.sort((a: any, b: any) =>
        new Date(b.last_message_at || b.updated_at || 0).getTime()
        - new Date(a.last_message_at || a.updated_at || 0).getTime(),
      )[0]
      const sid = latest.session_key || latest.session_id || latest.id
      if (!sid) return null
      agentSessionMap[agentKey] = sid
      return sid
    }
    // OpenClaw
    const res = await request(`/sessions/unified?agentId=${encodeURIComponent(agent.agent)}&limit=1`)
    if (!res.ok) return null
    const data = await res.json()
    const sessions = (data.sessions || []) as any[]
    if (sessions.length === 0) return null
    const latest = sessions.sort((a: any, b: any) =>
      new Date(b.last_message_at || b.updated_at || 0).getTime()
      - new Date(a.last_message_at || a.updated_at || 0).getTime(),
    )[0]
    const sk = latest.session_key || latest.key
    if (!sk) return null
    agentSessionMap[agentKey] = sk
    return sk
  } catch {
    return null
  }
}

/** 解析 /chat 路由：查缓存 → 缓存命中跳转 → 否则 API 加载 → 无会话则 no-session */
async function resolveChatRoute() {
  const agent = selectedAgent.value
  const agentKey = getAgentKey(agent)

  // 1. 内存缓存命中
  if (agentSessionMap[agentKey]) {
    if (agent.platform === 'openclaw') {
      router.replace('/workspace/' + encodeURIComponent(agentSessionMap[agentKey]))
    } else {
      openCodeSessionId.value = agentSessionMap[agentKey]
      view.value = 'chat'
    }
    return
  }

  // 2. main agent 的 localStorage 缓存（仅 OpenClaw）
  if (agent.platform === 'openclaw' && agent.agent === 'main') {
    const cached = getMainSessionKey()
    if (cached) {
      agentSessionMap[agentKey] = cached
      router.replace('/workspace/' + encodeURIComponent(cached))
      return
    }
  }

  // 3. API 加载最近会话
  view.value = 'loading'
  const sk = await loadRecentSession(agent)

  if (sk) {
    if (agent.platform === 'openclaw') {
      router.replace('/workspace/' + encodeURIComponent(sk))
    } else {
      openCodeSessionId.value = sk
      view.value = 'chat'
    }
  } else {
    view.value = 'no-session'
  }
}

// ============================================================
// 路由监听（唯一入口，URL → view state）
// ============================================================
let resolveSeq = 0

watch(
  () => route.path,
  async () => {
    // /workspace/:key → OpenClaw 聊天视图
    if (urlSessionKey.value) {
      const agentId = urlAgentId.value || 'main'
      if (selectedAgent.value.platform !== 'openclaw' || selectedAgent.value.agent !== agentId) {
        selectedAgent.value = {
          platform: 'openclaw', agent: agentId, label: agentId,
          emoji: '🦐', tag: 'OpenClaw',
        }
      }
      agentSessionMap[getAgentKey(selectedAgent.value)] = urlSessionKey.value
      view.value = 'chat'
      return
    }

    // /chat → 初始化 Agent + 解析路由
    resolveSeq++
    const seq = resolveSeq
    initAgentFromQuery()
    await resolveChatRoute()
    // 防止竞态：如果 resolveChatRoute 之后有新的路由变化，忽略本次结果
    if (resolveSeq === seq && view.value === 'loading') {
      view.value = 'no-session'
    }
  },
  { immediate: true },
)

// ============================================================
// Agent 切换（用户显式操作 — AgentSelector @update:model-value）
// ============================================================
async function onAgentSwitch(newAgent: AgentOption) {
  const oldAgent = selectedAgent.value
  if (newAgent.platform === oldAgent.platform && newAgent.agent === oldAgent.agent) return

  // 处理中 → 确认
  if (isBusy.value) {
    try {
      await ElMessageBox.confirm(
        '当前会话正在生成回复，确定切换吗？', '提示',
        { type: 'warning', confirmButtonText: '确定切换', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }

  // 更新 Agent 状态
  selectedAgent.value = newAgent

  // 如果当前在 session URL 上，或者跨平台切换 → 导航到 /chat，由路由 watcher 接管
  if (urlSessionKey.value || oldAgent.platform !== newAgent.platform) {
    router.push('/chat')
    return
  }

  // 已在 /chat 且同平台 → 直接解析
  await resolveChatRoute()
}

// ============================================================
// 会话列表选择 → 导航
// ============================================================
function onSessionSelect(sessionKeyStr: string) {
  router.push('/workspace/' + encodeURIComponent(sessionKeyStr))
}

// ============================================================
// 输入框
// ============================================================
const inputText = ref('')
const chatInputStore = useChatInputStore()
chatInputStore.bind(inputContextKey, inputText)

const sending = ref(false)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const timelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null)
const openCodePanelRef = ref<InstanceType<typeof OpenCodeChatPanel> | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

// ============================================================
// Agent 处理状态（从 ChatTimeline 暴露）
// ============================================================
const isAgentProcessing = computed(() => {
  if (isOpenCodeMode.value) return false
  const r = timelineRef.value as any
  const v = r?.isProcessing
  return typeof v === 'object' && v !== null && 'value' in v ? v.value : !!v
})
const isBusy = computed(() => sending.value || isAgentProcessing.value)
const canSteer = computed(() => isAgentProcessing.value && inputText.value.trim().length > 0)
const aborting = ref(false)

// ============================================================
// 附件
// ============================================================
interface ChatAttachment {
  id: string
  file: File
  preview: string
  dataUrl: string
}
const attachments = ref<ChatAttachment[]>([])

function addAttachment(file: File): boolean {
  if (!file.type.startsWith('image/')) return false
  if (attachments.value.length >= 4) { console.warn('[chat] 最多支持 4 张图片'); return false }
  const preview = URL.createObjectURL(file)
  const id = crypto.randomUUID()
  const att: ChatAttachment = { id, file, preview, dataUrl: '' }
  attachments.value.push(att)
  const reader = new FileReader()
  reader.onload = () => {
    const idx = attachments.value.findIndex(a => a.id === id)
    if (idx >= 0) {
      attachments.value[idx] = { ...attachments.value[idx], dataUrl: reader.result as string }
    }
  }
  reader.readAsDataURL(file)
  return true
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx >= 0) {
    URL.revokeObjectURL(attachments.value[idx].preview)
    attachments.value.splice(idx, 1)
  }
}

function clearAttachments() {
  attachments.value.forEach(a => URL.revokeObjectURL(a.preview))
  attachments.value = []
}

function onFileSelect() { fileInputRef.value?.click() }
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    if (!addAttachment(file)) break
  }
  input.value = ''
}
function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files
  if (files && files.length > 0) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) { addAttachment(file); break }
    }
  }
}
function onDragOver(e: DragEvent) { e.preventDefault(); dragOver.value = true }
function onDragLeave() { dragOver.value = false }
function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files) return
  for (const file of Array.from(files)) {
    if (!addAttachment(file)) break
  }
}

// ============================================================
// 发送能力
// ============================================================
const canSend = computed(() => isOpenCodeMode.value || !!activeSessionKey.value)

// ============================================================
// 发送消息
// ============================================================
async function sendMessage() {
  const text = inputText.value.trim()
  const isOpenCode = isOpenCodeMode.value
  if ((!text && attachments.value.length === 0) || (!activeSessionKey.value && !isOpenCode) || sending.value) return

  // ===== Steer（追加消息） =====
  if (isAgentProcessing.value) {
    if (!text && attachments.value.length === 0) return
    try {
      await gatewayClient.steerSession(activeSessionKey.value, text)
      inputText.value = ''
      resetInputHeight()
      nextTick(() => inputRef.value?.focus())
      return
    } catch (e) {
      console.error('追加消息失败', e)
      return
    }
  }

  sending.value = true
  const hasAttachments = attachments.value.length > 0

  // 构建附件 payload
  const attachmentPayloads = attachments.value.map(att => {
    const base64 = att.dataUrl.split(',')[1] || ''
    return { type: 'image', mimeType: att.file.type, fileName: att.file.name, content: base64 }
  })
  const attachmentDataUrls = attachments.value.map(a => a.dataUrl).filter(Boolean)

  inputText.value = ''
  resetInputHeight()
  clearAttachments()

  try {
    // ===== OpenCode 分支 =====
    if (isOpenCode) {
      // 先添加用户消息（立即显示，不等待 API）
      openCodePanelRef.value?.addOptimisticMessage(text, 'user')

      const result = await sendOpenCodeChat({
        agent: selectedAgent.value.agent as 'build' | 'plan',
        message: text,
        sessionId: openCodeSessionId.value,
      })
      openCodeSessionId.value = result.sessionId
      agentSessionMap[getAgentKey(selectedAgent.value)] = result.sessionId

      // 如果是首次创建会话，切换视图
      if (view.value !== 'chat') view.value = 'chat'

      // 添加 agent 回复
      openCodePanelRef.value?.addOptimisticMessage(result.content, 'agent')
      return
    }

    // ===== OpenClaw 分支 =====
    if (gatewayConnected.value) {
      await gatewayClient.sendMessage(
        activeSessionKey.value,
        text || '(图片)',
        attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
      )
      timelineRef.value?.addOptimisticMessage(
        hasAttachments && !text ? '' : text,
        'user',
        attachmentDataUrls,
      )
    } else {
      const res = await request('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: activeSessionKey.value,
          message: text || '(图片)',
          attachments: attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
        }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      timelineRef.value?.addOptimisticMessage(
        hasAttachments && !text ? '' : text,
        'user',
        attachmentDataUrls,
      )
    }
  } catch (e) {
    inputText.value = text
    console.error('发送失败', e)
  } finally {
    sending.value = false
    nextTick(() => inputRef.value?.focus())
  }
}

// ============================================================
// 键盘操作
// ============================================================
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (isBusy.value && !sending.value) return
    sendMessage()
  } else if (e.key === 'Escape' && isBusy.value && !sending.value) {
    handleAbort()
  }
}

async function handleAbort() {
  if (aborting.value || !isAgentProcessing.value || !activeSessionKey.value) return
  aborting.value = true
  try {
    await gatewayClient.abortTurn(activeSessionKey.value)
  } catch (e) {
    console.error('中止失败', e)
  }
  setTimeout(() => { aborting.value = false }, 800)
}

// ============================================================
// 输入框尺寸（拖拽调整）
// ============================================================
const INPUT_LINE_HEIGHT = 22.4
const TEXT_DEFAULT_LINES = 3
const TEXT_MIN_LINES = 3
const TEXT_MAX_LINES = 12
const textDefaultHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_DEFAULT_LINES + 20)
const textMinHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_MIN_LINES + 20)
const textMaxHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_MAX_LINES + 20)

const isDragging = ref(false)
let dragStartY = 0
let dragStartHeight = 0
const textareaHeight = ref(textDefaultHeight)

function autoResize() {
  const el = inputRef.value
  if (!el || isDragging.value) return
  el.style.height = 'auto'
  const contentH = el.scrollHeight
  const newH = Math.max(textMinHeight, Math.min(textMaxHeight, contentH))
  textareaHeight.value = newH
}

function resetInputHeight() {
  textareaHeight.value = textDefaultHeight
}

function onResizeDragStart(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  dragStartY = e.clientY
  dragStartHeight = textareaHeight.value
  document.addEventListener('mousemove', onResizeDragMove)
  document.addEventListener('mouseup', onResizeDragEnd)
}

function onResizeDragMove(e: MouseEvent) {
  if (!isDragging.value) return
  const delta = e.clientY - dragStartY
  const newH = Math.max(textMinHeight, Math.min(textMaxHeight, dragStartHeight - delta))
  textareaHeight.value = newH
}

function onResizeDragEnd() {
  isDragging.value = false
  document.removeEventListener('mousemove', onResizeDragMove)
  document.removeEventListener('mouseup', onResizeDragEnd)
}

// ============================================================
// PageHeader 文案
// ============================================================
const headerTitle = computed(() => {
  if (view.value === 'chat') return '聊天'
  if (view.value === 'list') return `${selectedAgent.value.emoji} ${selectedAgent.value.label} — 会话列表`
  return `${selectedAgent.value.label} — 新对话`
})

const headerSubtitle = computed(() => {
  if (view.value === 'chat') return `${selectedAgent.value.emoji} ${selectedAgent.value.label} ${selectedAgent.value.tag}`
  return undefined
})
</script>

<template>
  <div class="workspace-page">
    <PageHeader :title="headerTitle" :subtitle="headerSubtitle" />

    <!-- 加载中 -->
    <div v-if="view === 'loading'" class="loading-state">
      <el-icon class="is-loading" :size="20" color="var(--color-text-tertiary)"><Loading /></el-icon>
      <span>正在查找会话...</span>
    </div>

    <!-- 会话列表视图 -->
    <div v-else class="workspace-body">
      <SessionList
        v-if="view === 'list'"
        :agent-id="selectedAgent.platform === 'openclaw' ? selectedAgent.agent : urlAgentId"
        :platform="selectedAgent.platform"
        @select="onSessionSelect"
      />

      <!-- 聊天视图（chat + no-session 共用 ChatTimeline，输入区不同） -->
      <template v-else>
        <div class="workspace-content">
          <!-- 空状态提示（仅在无会话且无消息时显示） -->
          <div v-if="view === 'no-session'" class="empty-chat-state">
            <div class="empty-chat-hint">
              {{ isOpenCodeMode ? '发送消息开始新对话' : '暂无会话，请从会话列表选择或等待创建' }}
            </div>
          </div>

          <!-- OpenCode 模式：独立消息面板 -->
          <OpenCodeChatPanel
            v-if="isOpenCodeMode"
            ref="openCodePanelRef"
            :session-id="openCodeSessionId"
          />
          <!-- OpenClaw 模式：消息时间线 -->
          <ChatTimeline
            v-else
            ref="timelineRef"
            :key="timelineKey"
            :session-key="timelineSessionKey"
          />

          <!-- 输入区 -->
          <div
            class="chat-input-bar"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
            :class="{ 'drag-over': dragOver }"
          >
            <input ref="fileInputRef" type="file" accept="image/*" multiple class="file-input-hidden" @change="onFileChange" />

            <div v-if="attachments.length > 0" class="attachment-preview-bar">
              <div v-for="att in attachments" :key="att.id" class="attachment-preview-item">
                <img :src="att.preview" :alt="att.file.name" />
                <button class="attachment-remove" @click="removeAttachment(att.id)">&times;</button>
              </div>
            </div>

            <div class="resize-handle" @mousedown="onResizeDragStart"></div>

            <div class="chat-input-card" :class="{ 'is-processing': isBusy || aborting }">
              <div class="chat-textarea-zone" :style="{ height: textareaHeight + 'px' }">
                <!-- chat 视图 → 完整功能 -->
                <textarea
                  v-if="view === 'chat'"
                  ref="inputRef"
                  v-model="inputText"
                  class="chat-input"
                  :placeholder="isAgentProcessing ? '追加消息到当前回复…' : (canSend ? '输入消息… (Enter 发送, Shift+Enter 换行)' : '此会话已完成，不可发送消息')"
                  :disabled="!canSend"
                  @keydown="onKeyDown"
                  @input="autoResize"
                  @paste="onPaste"
                />
                <!-- no-session 视图 → 简化 -->
                <textarea
                  v-else
                  ref="inputRef"
                  v-model="inputText"
                  class="chat-input"
                  :placeholder="isOpenCodeMode ? '输入消息开始新对话… (Enter 发送, Shift+Enter 换行)' : '从会话列表选择一个会话…'"
                  :disabled="!isOpenCodeMode"
                  @keydown="onKeyDown"
                  @input="autoResize"
                  @paste="onPaste"
                />
              </div>

              <!-- 操作栏：chat 视图 → 完整按钮组 -->
              <div v-if="view === 'chat' && canSend" class="chat-action-row">
                <span class="action-hint">Enter 发送 / Shift+Enter 换行</span>
                <div class="chat-input-actions">
                  <AgentSelector :model-value="selectedAgent" :disabled="sending || isBusy" size="small" class="toolbar-agent-selector" @update:model-value="onAgentSwitch" />
                  <button class="attach-btn" title="添加图片" @click="onFileSelect">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                  <button v-if="(isBusy && !sending) || aborting" class="abort-btn" :class="{ 'abort-btn--done': aborting }" title="停止生成 (Esc)" @click="handleAbort">
                    <svg v-if="!aborting" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
                    <svg v-else width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3L13 4.5" /></svg>
                  </button>
                  <button v-else-if="canSteer" class="steer-btn" title="追加消息" @click="sendMessage">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
                  </button>
                  <button v-else class="send-btn" :disabled="sending || (!inputText.trim() && attachments.length === 0)" @click="sendMessage">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5l13 5-13 5V8.5l8-1.5-8-1.5V1.5z"/></svg>
                  </button>
                </div>
              </div>

              <!-- 操作栏：no-session 视图 → 简化版 -->
              <div v-if="view === 'no-session'" class="chat-action-row">
                <span class="action-hint">Enter 发送 / Shift+Enter 换行</span>
                <div class="chat-input-actions">
                  <AgentSelector :model-value="selectedAgent" size="small" class="toolbar-agent-selector" @update:model-value="onAgentSwitch" />
                  <button class="send-btn" :disabled="!isOpenCodeMode || (!inputText.trim() && attachments.length === 0)" @click="sendMessage">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5l13 5-13 5V8.5l8-1.5-8-1.5V1.5z"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.workspace-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.empty-chat-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 16px 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.empty-chat-hint {
  font-size: 13px;
  color: var(--color-text-tertiary);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  margin: 0 20px 8px;
  background: var(--color-bg-canvas);
  border-radius: 8px;
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.workspace-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ===== 输入框区域 ===== */
.chat-input-bar {
  display: flex;
  flex-direction: column;
  padding: 0 16px 16px;
  flex-shrink: 0;
  background: var(--color-bg-canvas);
  border-radius: 0 0 8px 8px;
  transition: all 0.2s ease;
}

.resize-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 10px;
  cursor: ns-resize;
  user-select: none;
  margin-bottom: 2px;
}

.resize-handle::after {
  content: '';
  display: block;
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: var(--color-border);
  transition: background 0.15s;
}

.resize-handle:hover::after,
.resize-handle:active::after {
  background: var(--color-text-tertiary);
}

.chat-input-card {
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.chat-input-card:focus-within {
  border-color: var(--color-accent-blue);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(9, 105, 218, 0.1);
}
.chat-input-card.is-processing {
  border-color: var(--color-accent-blue);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(9, 105, 218, 0.1);
}

.chat-textarea-zone {
  flex-shrink: 0;
  overflow: hidden;
}

.chat-input {
  display: block;
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  color: var(--color-text);
  background: transparent;
  outline: none;
  line-height: 1.6;
  overflow-y: auto;
}
.chat-input::placeholder {
  color: var(--color-text-tertiary);
}
.chat-input:disabled {
  opacity: 0.5;
}

.chat-action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border-lighter);
  flex-shrink: 0;
}

.action-hint {
  font-size: 11px;
  color: var(--color-text-placeholder);
  user-select: none;
}

.chat-input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent-blue);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.send-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(9, 105, 218, 0.3);
}
.send-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  background: var(--color-text-quaternary, #d1d5db);
}

.abort-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--el-color-danger, #f56c6c);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.abort-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(245, 108, 108, 0.3);
}
.abort-btn--done {
  background: var(--el-color-success, #67c23a) !important;
}

.steer-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent-blue);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.steer-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(9, 105, 218, 0.3);
}

.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.attach-btn:hover {
  color: var(--color-text-secondary);
  background: var(--color-bg-overlay);
}

.file-input-hidden {
  display: none;
}

.attachment-preview-bar {
  display: flex;
  gap: 8px;
  padding: 0 0 8px;
  flex-wrap: wrap;
}

.attachment-preview-item {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  transition: box-shadow 0.15s;
}
.attachment-preview-item:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}
.attachment-preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s;
}
.attachment-remove:hover {
  background: rgba(220, 38, 38, 0.8);
}

.chat-input-bar.drag-over {
  border: 2px dashed var(--color-accent-blue);
  background: rgba(9, 105, 218, 0.04);
}
</style>
