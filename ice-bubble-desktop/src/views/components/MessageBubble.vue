<script setup lang="ts">
/**
 * MessageBubble — 复用 ChatTimeline 消息时间线样式的消息气泡组件
 *
 * 支持 user / assistant / system 三种角色，复用时间线的头像、
 * agent 名、Markdown 渲染、时间戳等展示方式。
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
    // 时间线扩展字段（可选）
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
    <div class="msg-header msg-header--user">
      <span v-if="message.sourceChannel" class="channel-tag">{{ message.sourceChannel }}</span>
      <span class="msg-time">{{ formatTime(message.timestamp) }}</span>
    </div>
    <div class="bubble bubble--user">
      <MarkdownContent :content="message.content" />
    </div>
  </div>

  <!-- assistant 消息 -->
  <div v-else class="msg-row msg-row--agent">
    <!-- 头像列 -->
    <div class="agent-avatar-col">
      <img
        v-if="message.avatar"
        :src="`/api/resources/avatars/${message.avatar}`"
        class="avatar"
        alt=""
      />
      <div v-else class="avatar-placeholder">{{ agentInitial }}</div>
    </div>
    <!-- 内容列 -->
    <div class="agent-content-col">
      <div class="msg-header msg-header--agent">
        <span class="agent-label-name">{{ message.agentName || 'Assistant' }}</span>
        <span v-if="message.model" class="model-tag">{{ message.model }}</span>
        <span class="msg-time">{{ formatTime(message.timestamp) }}</span>
        <span v-if="message.isStreaming" class="streaming-dot">●</span>
      </div>
      <div class="bubble bubble--agent" :class="{ 'is-error': message.isError }">
        <MarkdownContent :content="message.content" />
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
/* 消息行 */
.msg-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 90%;
}
.msg-row--user {
  align-self: flex-end;
  align-items: flex-end;
}
.msg-row--agent {
  align-self: flex-start;
  align-items: flex-start;
  flex-direction: row;
  gap: 10px;
}
.msg-row--system {
  align-self: center;
  padding: 6px 0;
}

.system-text {
  font-size: 12px;
  color: #999;
  background: #f5f5f5;
  padding: 4px 14px;
  border-radius: 12px;
}

/* Agent 头像列 */
.agent-avatar-col {
  width: 30px;
  flex-shrink: 0;
  padding-top: 2px;
}

.agent-content-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.avatar,
.avatar-placeholder {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-placeholder {
  background: var(--el-color-primary-light-3);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
}

/* 消息头部 */
.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #999;
  padding: 0 6px;
}
.msg-header--user {
  justify-content: flex-end;
}
.msg-time {
  white-space: nowrap;
}
.agent-label-name {
  font-weight: 600;
  color: #5a7fb5;
  font-size: 12px;
}

/* 气泡 */
.bubble {
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.bubble--user {
  background: #e8eaf6;
  color: #333;
  border-radius: 14px 14px 4px 14px;
}
.bubble--agent {
  background: #f7f8fa;
  color: #222;
  border-radius: 14px 14px 14px 4px;
  max-width: 100%;
}
.bubble.is-error {
  border: 1px solid var(--el-color-danger-light-5);
  background: #fef0f0;
}

/* 渠道 & 模型标签 */
.channel-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 9px;
  color: #9aa0a6;
  background: #f0f1f3;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
}
.model-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 9px;
  color: #8ab4f8;
  background: #e8f0fe;
  padding: 1px 6px;
  border-radius: 3px;
}

/* 流式指示器 */
.streaming-dot {
  color: var(--el-color-primary);
  animation: blink 1s ease-in-out infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

/* 重试按钮 */
.retry-btn {
  background: transparent;
  border: 1px solid var(--el-color-danger-light-5);
  color: var(--el-color-danger);
  padding: 4px 12px;
  border-radius: 14px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 4px;
  transition: all 0.2s;
}
.retry-btn:hover {
  background: var(--el-color-danger-light-9);
}

/* MarkdownContent 内部样式微调 */
.bubble :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: #1e1e2e;
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
  background: #f0f1f3;
  padding: 1px 6px;
  border-radius: 4px;
  color: #e06c75;
}
.bubble--user :deep(:not(pre) > code) {
  background: rgba(0, 0, 0, 0.06);
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
  border-left: 3px solid var(--el-color-primary-light-3);
  background: rgba(0, 0, 0, 0.02);
  border-radius: 0 4px 4px 0;
}
</style>
