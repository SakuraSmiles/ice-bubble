<script setup lang="ts">
/**
 * OpenCodeChatPanel — OpenCode 模式专用消息面板
 *
 * 轻量级聊天组件，不依赖 Gateway 流式连接。
 * 消息通过 props 或 addOptimisticMessage 传入。
 * 支持 sessionId 时从 Admin API 加载历史消息。
 */
import { ref, watch, nextTick, onMounted } from 'vue'
import { Loading } from '@element-plus/icons-vue'
import MarkdownContent from '../../../components/MarkdownContent.vue'
import { api } from '../../../api/client'

export interface ChatMessage {
  role: 'user' | 'agent'
  content: string
  timestamp?: number
}

const props = withDefaults(defineProps<{
  sessionId?: string
}>(), {
  sessionId: undefined,
})

const messages = ref<ChatMessage[]>([])
const containerRef = ref<HTMLDivElement | null>(null)
const loading = ref(false)

// ── 加载历史 ──

async function loadHistory() {
  if (!props.sessionId) return
  loading.value = true
  try {
    const data = await api.getSessionMessages(props.sessionId, { limit: 50 })
    messages.value = (data.messages || []).map(m => ({
      role: m.role === 'user' ? 'user' : 'agent',
      content: m.content || '',
      timestamp: new Date(m.created_at).getTime(),
    }))
  } catch (e) {
    console.error('[OpenCodeChatPanel] 加载历史消息失败', e)
  } finally {
    loading.value = false
    nextTick(scrollToBottom)
  }
}

watch(() => props.sessionId, (newId) => {
  if (newId) {
    messages.value = []
    loadHistory()
  }
})

onMounted(() => {
  if (props.sessionId) loadHistory()
})

// ── 滚动 ──

function scrollToBottom(smooth = true) {
  const el = containerRef.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

// ── 时间格式化 ──

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── 暴露方法（兼容 ChatTimeline 接口） ──

defineExpose({
  isProcessing: { value: false },
  activeRunId: null,
  getMessages: () => messages.value,
  addOptimisticMessage(content: string, role: string = 'user') {
    messages.value = [...messages.value, {
      role: role === 'user' ? 'user' : 'agent',
      content,
      timestamp: Date.now(),
    }]
    nextTick(() => scrollToBottom())
  },
  clear() {
    messages.value = []
  },
})
</script>

<template>
  <div class="opencode-chat">
    <div ref="containerRef" class="opencode-chat-scroll">
      <!-- 加载中 -->
      <div v-if="loading && messages.length === 0" class="oc-loading">
        <el-icon class="is-loading" :size="18"><Loading /></el-icon>
        <span>加载中...</span>
      </div>

      <!-- 空状态 -->
      <div v-else-if="messages.length === 0" class="oc-empty">
        发送消息开始对话
      </div>

      <!-- 消息列表 -->
      <template v-for="(msg, i) in messages" :key="i">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="oc-msg oc-msg--user">
          <div class="oc-bubble oc-bubble--user">
            <span v-if="msg.timestamp" class="oc-time">{{ formatTime(msg.timestamp) }}</span>
            <MarkdownContent :content="msg.content" />
          </div>
        </div>

        <!-- Agent 消息 -->
        <div v-else class="oc-msg oc-msg--agent">
          <div class="oc-avatar">
            <div class="oc-avatar-placeholder">🤖</div>
          </div>
          <div class="oc-agent-body">
            <span class="oc-agent-label">OpenCode</span>
            <div class="oc-bubble oc-bubble--agent">
              <MarkdownContent :content="msg.content" />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.opencode-chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.opencode-chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--color-bg-canvas);
}

.oc-loading,
.oc-empty {
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 13px;
  padding: 40px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

/* ── 消息行 ── */

.oc-msg {
  display: flex;
  gap: 10px;
  max-width: 88%;
}
.oc-msg--user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.oc-msg--agent {
  align-self: flex-start;
  flex-direction: row;
}

/* ── 气泡 ── */

.oc-bubble {
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
}

.oc-bubble--user {
  background: var(--color-accent-blue-subtle);
  color: var(--color-text);
  border-radius: 16px 4px 16px 16px;
  border: 1px solid var(--color-border-subtle);
}
.oc-bubble--user:hover {
  background: #c8e6ff;
}
.oc-bubble--user :deep(pre),
.oc-bubble--user :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  color: var(--color-text);
  border-radius: 6px;
}

.oc-bubble--agent {
  background: #fff;
  color: #222;
  border-radius: 16px 16px 16px 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

/* ── 时间 ── */

.oc-time {
  display: block;
  text-align: right;
  font-size: 10px;
  color: #aaa;
  margin-bottom: 4px;
}

/* ── Agent 头像 ── */

.oc-avatar {
  width: 28px;
  flex-shrink: 0;
  padding-top: 2px;
}
.oc-avatar-placeholder {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-accent-blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.oc-agent-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.oc-agent-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  padding: 0 6px;
}
</style>
