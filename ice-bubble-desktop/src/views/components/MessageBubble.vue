<script setup lang="ts">
/**
 * MessageBubble — 聊天气泡组件
 */
import { computed } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'

interface Props {
  message: {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp?: string | number
    isStreaming?: boolean
    isError?: boolean
    agentId?: string
    agentName?: string
    avatar?: string | null
    model?: string | null
    sourceChannel?: string | null
  }
}

const props = defineProps<{
  message: Props['message']
}>()

const emit = defineEmits<{
  (e: 'retry', messageId: string): void
}>()

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

function formatTime(ts?: string | number): string {
  if (!ts) return ''
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts as string)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

const agentInitial = computed(() => {
  const name = props.message.agentName
  return name ? name[0] : '🤖'
})
</script>

<template>
  <!-- system 消息 -->
  <div v-if="isSystem" class="msg-row msg-row--system">
    <span class="system-text">{{ message.content }}</span>
  </div>

  <!-- user 消息 -->
  <div v-else-if="isUser" class="msg-row msg-row--user">
    <div class="msg-header">
      <span v-if="message.sourceChannel" class="channel-tag">{{ message.sourceChannel }}</span>
      <span class="msg-time">{{ formatTime(message.timestamp) }}</span>
    </div>
    <div class="bubble bubble--user">
      <MarkdownContent :content="message.content" />
    </div>
  </div>

  <!-- assistant 消息 -->
  <div v-else class="msg-row msg-row--agent">
    <div class="agent-avatar-col">
      <img
        v-if="message.avatar"
        :src="`/api/resources/avatars/${message.avatar}`"
        class="avatar"
        alt=""
      />
      <div v-else class="avatar-placeholder">{{ agentInitial }}</div>
    </div>
    <div class="agent-content-col">
      <div class="msg-header">
        <span class="agent-label-name">{{ message.agentName || 'Assistant' }}</span>
        <span v-if="message.model" class="model-tag">{{ message.model }}</span>
        <span class="msg-time">{{ formatTime(message.timestamp) }}</span>
        <span v-if="message.isStreaming" class="streaming-dot">●</span>
      </div>
      <div class="bubble bubble--agent" :class="{ 'is-error': message.isError }">
        <MarkdownContent :content="message.content" /><span v-if="message.isStreaming" class="streaming-cursor">▍</span>
      </div>
      <button
        v-if="message.isError"
        class="retry-btn"
        @click="emit('retry', message.id)"
      >
        🔄 重试
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ===== 消息行 ===== */
.msg-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.msg-row--user {
  flex-direction: column;
  align-items: flex-end;
  max-width: 75%;
  align-self: flex-end;
}

.msg-row--agent {
  flex-direction: row;
  align-items: flex-start;
  align-self: flex-start;
}

.msg-row--system {
  justify-content: center;
  padding: 6px 0;
}

.system-text {
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--el-fill-color-light);
  padding: 4px 14px;
  border-radius: 12px;
}

/* ===== Agent 头像 ===== */
.agent-avatar-col {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  padding-top: 20px;
}

.avatar,
.avatar-placeholder {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  background: var(--color-accent-blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.agent-content-col {
  flex: 1;
  min-width: 0;
  max-width: 800px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ===== 消息头部 ===== */
.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
  padding: 0 2px;
}

.msg-time {
  white-space: nowrap;
}

.agent-label-name {
  font-weight: 600;
  color: var(--color-text);
  font-size: 12px;
}

/* ===== 气泡 ===== */
.bubble {
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.bubble--user {
  background: var(--color-accent-blue);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
}

.bubble--agent {
  background: var(--color-bg-inset);
  color: var(--color-text);
  border-radius: 14px 14px 14px 4px;
  border: 1px solid var(--color-border-subtle);
}

.bubble.is-error {
  border-color: var(--color-accent-red-subtle);
  background: var(--color-accent-red-subtle);
}

/* ===== 标签 ===== */
.channel-tag {
  font-family: var(--font-eurostile), monospace;
  font-size: 10px;
  color: var(--color-text-tertiary);
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 3px;
}

.model-tag {
  font-family: var(--font-eurostile), monospace;
  font-size: 10px;
  color: var(--color-accent-blue);
  background: var(--color-accent-blue-subtle);
  padding: 1px 6px;
  border-radius: 3px;
}

/* ===== 流式指示器 ===== */
.streaming-dot {
  color: var(--color-accent-blue);
  animation: blink 1s ease-in-out infinite;
}

.streaming-cursor {
  display: inline-block;
  animation: blink 1s step-end infinite;
  color: var(--el-color-primary);
  margin-left: 1px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

/* ===== 重试按钮 ===== */
.retry-btn {
  background: transparent;
  border: 1px solid var(--color-accent-red-subtle);
  color: var(--color-accent-red);
  padding: 4px 12px;
  border-radius: 14px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 4px;
  transition: all 0.2s;
}

.retry-btn:hover {
  background: var(--color-accent-red-subtle);
}

/* ===== Markdown 内部样式 ===== */
.bubble :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--color-primary, #24292e);
  color: #cdd6f4;
  border-radius: 8px;
  font-size: 13px;
  overflow-x: auto;
}

.bubble :deep(code) {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
}

.bubble :deep(:not(pre) > code) {
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--color-accent-red);
}

.bubble--user :deep(:not(pre) > code) {
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.9);
}

.bubble :deep(p) {
  margin: 6px 0;
}

.bubble :deep(p:first-child) {
  margin-top: 0;
}

.bubble :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble :deep(ul),
.bubble :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}

.bubble :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--color-accent-blue);
  background: var(--color-accent-blue-subtle);
  border-radius: 0 4px 4px 0;
}
</style>
