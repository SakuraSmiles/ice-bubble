<script setup lang="ts">
/**
 * MessageBubble.vue — 聊天消息气泡组件
 *
 * 支持三种角色：
 * - user:      右对齐蓝色气泡
 * - assistant: 左对齐灰色气泡（Markdown 渲染）
 * - system:    居中小字灰色提示
 *
 * 附加状态：isStreaming（闪烁光标）、isError（重试按钮）
 */

import { computed } from 'vue'

// ============ Props / Emits ============

interface Props {
  message: {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp?: number | string
    isStreaming?: boolean
    isError?: boolean
  }
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'retry', messageId: string): void
}>()

// ============ 计算属性 ============

const isAssistant = computed(() => props.message.role === 'assistant')
const isSystem = computed(() => props.message.role === 'system')

/** 格式化时间戳 */
const formattedTime = computed(() => {
  const ts = props.message.timestamp
  if (!ts) return ''
  const date = new Date(typeof ts === 'number' ? ts : ts)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
})

/** 简单 Markdown 转 HTML：代码块、行内代码、加粗、换行 */
const renderedContent = computed(() => {
  let text = props.message.content
  // 代码块
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.slice(3, -3).replace(/^\w*\n/, '')
    return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`
  })
  // 行内代码
  text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
  // 加粗
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 换行
  text = text.replace(/\n/g, '<br>')
  return text
})

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
</script>

<template>
  <div
    class="message-bubble"
    :class="[`role-${message.role}`, { 'is-streaming': message.isStreaming, 'is-error': message.isError }]"
  >
    <!-- system 消息 -->
    <template v-if="isSystem">
      <span class="system-text">{{ message.content }}</span>
    </template>

    <!-- user / assistant 消息 -->
    <template v-else>
      <div class="bubble-body">
        <div v-if="isAssistant" class="bubble-content markdown-body" v-html="renderedContent" />
        <div v-else class="bubble-content">{{ message.content }}</div>

        <!-- 流式输出光标 -->
        <span v-if="message.isStreaming" class="streaming-cursor" />
      </div>

      <!-- 重试按钮 -->
      <button
        v-if="message.isError"
        class="btn-retry"
        @click="emit('retry', message.id)"
      >
        重试
      </button>

      <!-- 时间戳 -->
      <span v-if="formattedTime" class="bubble-time">{{ formattedTime }}</span>
    </template>
  </div>
</template>

<style scoped>
.message-bubble {
  display: flex;
  flex-direction: column;
  max-width: 80%;
  margin-bottom: 12px;
}

/* ---------- 对齐 ---------- */
.message-bubble.role-user {
  align-items: flex-end;
  align-self: flex-end;
}

.message-bubble.role-assistant {
  align-items: flex-start;
  align-self: flex-start;
}

.message-bubble.role-system {
  align-items: center;
  align-self: center;
  max-width: 100%;
}

/* ---------- system ---------- */
.system-text {
  font-size: 12px;
  color: var(--el-text-color-placeholder, #a0a0a0);
  padding: 4px 0;
}

/* ---------- 气泡主体 ---------- */
.bubble-body {
  position: relative;
  padding: 10px 14px;
  border-radius: 12px;
  word-break: break-word;
  line-height: 1.6;
  font-size: 14px;
}

/* user 气泡 */
.role-user .bubble-body {
  background: var(--el-color-primary, #409eff);
  color: #fff;
  border-bottom-right-radius: 4px;
}

/* assistant 气泡 */
.role-assistant .bubble-body {
  background: var(--el-fill-color-light, #f0f2f5);
  color: var(--el-text-color-primary, #303133);
  border-bottom-left-radius: 4px;
}

/* ---------- Markdown 渲染样式 ---------- */
.markdown-body :deep(.code-block) {
  margin: 8px 0;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  line-height: 1.5;
}

.markdown-body :deep(.inline-code) {
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
}

.markdown-body :deep(pre) {
  margin: 0;
}

.markdown-body :deep(strong) {
  font-weight: 600;
}

/* ---------- 流式光标 ---------- */
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  background: var(--el-color-primary, #409eff);
  vertical-align: text-bottom;
  animation: cursor-blink 0.8s steps(2) infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ---------- 重试按钮 ---------- */
.btn-retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 4px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--el-color-danger, #f56c6c);
  background: transparent;
  border: 1px solid var(--el-color-danger-light-5, #fab6b6);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-retry:hover {
  background: var(--el-color-danger-light-9, #fef0f0);
}

/* ---------- 时间戳 ---------- */
.bubble-time {
  font-size: 11px;
  color: var(--el-text-color-placeholder, #a0a0a0);
  margin-top: 2px;
  padding: 0 4px;
}
</style>
