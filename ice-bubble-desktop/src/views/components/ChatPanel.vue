<script setup lang="ts">
/**
 * ChatPanel.vue — 聊天主面板组件
 *
 * 组装 SessionSelector + MessageBubble 列表 + MessageInput，
 * 通过 useChat composable 管理消息状态和 SSE 连接。
 *
 * 布局：
 * ┌─────────────────────────────────────────┐
 * │  MessageList (滚动区域)                  │  ← 中部（flex:1 占满）
 * │    ├─ MessageBubble (user)              │
 * │    ├─ MessageBubble (assistant)        │
 * │    └─ MessageBubble (system)           │
 * ├─────────────────────────────────────────┤
 * │  [MessageInput @send @abort]            │  ← 底部
 * │  [SessionSelector v-model="currentKey"] │  ← 输入框下方，紧凑
 * └─────────────────────────────────────────┘
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useChatStore } from '@/stores/chatStore'
import { useChat } from '@/views/composables/useChat'
import type { SessionItem as SelectorSessionItem } from '@/views/components/SessionSelector.vue'
import SessionSelector from '@/views/components/SessionSelector.vue'
import MessageBubble from '@/views/components/MessageBubble.vue'
import MessageInput from '@/views/components/MessageInput.vue'

// ============ Store ============

const chatStore = useChatStore()

// ============ 当前 Session ============

const currentSessionKey = ref('')

// ============ useChat ============

/**
 * useChat 接收一个 getter 函数，使得 sessionKey 切换时
 * composable 内部所有操作始终读取最新值。
 */
const {
  messages: rawMessages,
  loading,
  streaming,
  sending,
  error,
  send: chatSend,
  abort: chatAbort,
  connectSSE,
  disconnectSSE,
  loadHistory,
  connectGatewayStream,
  disconnectGatewayStream,
} = useChat(() => currentSessionKey.value)

// ============ Session 数据适配 ============

/**
 * 将 chatStore.sessions 映射为 SessionSelector 期望的格式。
 * Store: sessionKey / agentId / agentName / label / lastMessage / lastActivity
 * Selector: sessionKey / agent / channel / lastActive / title? / agentName? / lastMessage?
 */
const selectorSessions = computed<SelectorSessionItem[]>(() =>
  chatStore.sessions.map((s) => ({
    sessionKey: s.sessionKey,
    agent: s.agentName ?? s.agentId,
    channel: s.label ?? '',
    lastActive: s.lastActivity ?? '',
    title: s.label,
    agentName: s.agentName ?? null,
    lastMessage: s.lastMessage ?? null,
    sessionStatus: s.sessionStatus ?? null,
  })),
)

/** 当前选中 session 的状态 */
const currentSessionStatus = computed(() => {
  const s = chatStore.sessions.find((s) => s.sessionKey === currentSessionKey.value)
  return s?.sessionStatus ?? null
})

/** 输入框是否可用：只有 running（进行中）的会话可以发消息 */
const inputEnabled = computed(() => {
  // 默认主会话总是可用
  if (currentSessionKey.value === 'agent:main:main') return true
  // 非主会话：只有 status 为 running 或未设置时可用（历史 session 可能没有 status 字段）
  return currentSessionStatus.value !== 'done'
})



// ============ 消息引用（auto-scroll） ============

const messageListRef = ref<HTMLElement | null>(null)

/**
 * 合并连续同 role 的消息为一条气泡。
 * 后端 timeline API 已处理噪音过滤，这里只做合并。
 */
const displayMessages = computed(() => {
  const merged: any[] = []
  for (const msg of rawMessages.value) {
    const trimmed = (msg.content ?? '').trim()
    if (!trimmed) continue
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content += '\n\n' + trimmed
      prev.timestamp = msg.timestamp
      if (msg.agentName) prev.agentName = msg.agentName
      if (msg.model) prev.model = msg.model
      if (msg.avatar) prev.avatar = msg.avatar
      if (msg.sourceChannel) prev.sourceChannel = msg.sourceChannel
    } else {
      merged.push({
        ...msg,
        isStreaming: false,
        isError: msg.sendFailed === true,
      })
    }
  }
  // 标记最后一条assistant为streaming
  if (merged.length > 0 && streaming.value) {
    const last = merged[merged.length - 1]
    if (last.role === 'assistant') last.isStreaming = true
  }
  return merged
})

// ============ Session 切换逻辑 ============

watch(currentSessionKey, async (newKey, oldKey) => {
  if (!newKey || newKey === oldKey) return

  // 切换 session 时断开旧连接，加载历史后重新连接
  disconnectSSE()
  disconnectGatewayStream()
  await loadHistory(newKey)
  connectSSE()
  connectGatewayStream()

  // 滚动到底部
  await nextTick()
  scrollToBottom()
})

// ============ 自动滚动 ============

/** 滚动到消息列表底部 */
function scrollToBottom() {
  if (messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
  }
}

/** 新消息到来时自动滚动 */
watch(
  () => rawMessages.value.length,
  () => {
    nextTick(() => scrollToBottom())
  },
)

// ============ 发送 / 中止 ============

async function handleSend(text: string) {
  await chatSend(text)
  await nextTick()
  scrollToBottom()
}

function handleAbort() {
  chatAbort()
}

// ============ 刷新 Session 列表 ============

async function handleRefreshSessions() {
  await chatStore.fetchSessions()
}

// ============ 生命周期 ============

onMounted(async () => {
  // 加载 session 列表
  await chatStore.fetchSessions()

  // 设置默认 session
  if (!currentSessionKey.value && chatStore.sessions.length > 0) {
    currentSessionKey.value = chatStore.sessions[0].sessionKey
  } else if (!currentSessionKey.value) {
    currentSessionKey.value = chatStore.getDefaultSessionKey()
  }

  // 加载初始历史消息
  if (currentSessionKey.value) {
    await loadHistory(currentSessionKey.value)
    // 建立 SSE 连接，实时接收新消息
    connectSSE()
    connectGatewayStream()
  }
})
</script>

<template>
  <div class="chat-panel">
    <!-- ========== 中部：消息列表 ========== -->
    <div
      ref="messageListRef"
      class="chat-message-list"
    >
      <!-- 空状态 -->
      <div
        v-if="displayMessages.length === 0 && !loading"
        class="message-list-empty"
      >
        <span class="empty-icon">💬</span>
        <span class="empty-text">开始对话吧</span>
      </div>

      <!-- 加载中 -->
      <div
        v-if="loading"
        class="message-list-loading"
      >
        <span class="loading-spinner" />
        <span class="loading-text">加载中...</span>
      </div>

      <!-- 消息气泡列表 -->
      <template v-for="msg in displayMessages" :key="msg.id">
        <MessageBubble
          :message="msg"
          @retry="(msgId: string) => chatSend(rawMessages.find(m => m.id === msgId)?.content ?? '')"
        />
      </template>

      <!-- 流式输出中的占位提示 -->
      <div
        v-if="streaming && displayMessages.length === 0"
        class="streaming-placeholder"
      >
        <span class="streaming-dot" />
        <span class="streaming-dot" />
        <span class="streaming-dot" />
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="chat-error-bar">
      <span class="error-text">{{ error }}</span>
    </div>

    <!-- ========== 底部：消息输入 + Session 选择器 ========== -->
    <footer class="chat-footer">
      <MessageInput
        :disabled="!inputEnabled"
        :loading="sending"
        :streaming="streaming"
        :target-session-key="currentSessionKey"
        :placeholder="inputEnabled ? '输入消息，Enter 发送，Shift+Enter 换行' : '此会话已完成，不可发送消息'"
        @send="handleSend"
        @abort="handleAbort"
      />
      <SessionSelector
        v-model="currentSessionKey"
        :sessions="selectorSessions"
        :loading="chatStore.loading"
        @refresh="handleRefreshSessions"
      />
    </footer>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--el-bg-color, #ffffff);
  border: 1px solid var(--el-border-color, #e8e8e8);
  border-radius: 8px;
  overflow: hidden;
}

/* ---------- 消息列表 ---------- */
.chat-message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 消息列表滚动条 */
.chat-message-list::-webkit-scrollbar {
  width: 6px;
}

.chat-message-list::-webkit-scrollbar-thumb {
  background: var(--el-border-color-darker, #c0c4cc);
  border-radius: 3px;
}

.chat-message-list::-webkit-scrollbar-track {
  background: transparent;
}

/* 空状态 */
.message-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--el-text-color-placeholder, #a0a0a0);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
}

/* 加载中 */
.message-list-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--el-text-color-secondary, #909399);
  font-size: 13px;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--el-border-color, #dcdfe6);
  border-top-color: var(--el-color-primary, #409eff);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.loading-text {
  font-size: 13px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 流式占位 */
.streaming-placeholder {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 16px;
  align-self: flex-start;
  background: var(--el-fill-color-light, #f0f2f5);
  border-radius: 12px;
  border-bottom-left-radius: 4px;
}

.streaming-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-primary, #409eff);
  animation: dot-bounce 1.2s infinite ease-in-out both;
}

.streaming-dot:nth-child(1) { animation-delay: -0.32s; }
.streaming-dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
  40% { transform: scale(1); opacity: 1; }
}

/* ---------- 错误提示 ---------- */
.chat-error-bar {
  flex-shrink: 0;
  padding: 8px 16px;
  background: var(--el-color-danger-light-9, #fef0f0);
  border-top: 1px solid var(--el-color-danger-light-5, #fab6b6);
}

.error-text {
  font-size: 12px;
  color: var(--el-color-danger, #f56c6c);
}

/* ---------- 底部 ---------- */
.chat-footer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--el-border-color, #e8e8e8);
  padding: 8px 12px 6px;
  gap: 6px;
}
</style>
