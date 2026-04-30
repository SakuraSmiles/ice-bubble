<script setup lang="ts">
/**
 * MessageInput.vue — 聊天消息输入组件
 *
 * - 多行 textarea，自适应高度（最大 4 行）
 * - Enter 发送，Shift+Enter 换行
 * - 发送按钮（主色）+ 中止按钮（红色，仅 streaming 时显示）
 * - loading 状态：发送后按钮变中止，输入框显示加载
 */

import { ref, computed } from 'vue'

// ============ Props / Emits ============

interface Props {
  /** 禁用输入 */
  disabled?: boolean
  /** 正在发送中 */
  loading?: boolean
  /** 正在流式输出（显示中止按钮） */
  streaming?: boolean
  /** 占位文本 */
  placeholder?: string
  /** 目标 session key（仅用于 aria-label） */
  targetSessionKey?: string
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  loading: false,
  streaming: false,
  placeholder: '输入消息...',
  targetSessionKey: '',
})

const emit = defineEmits<{
  (e: 'send', message: string): void
  (e: 'abort'): void
}>()

// ============ Refs ============

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const inputText = ref('')

// ============ 样式常量 ============

const MIN_HEIGHT = 40   // px（单行高度）
const MAX_HEIGHT = 160  // px（最大 4 行）

// ============ 计算属性 ============

const canSend = computed(() => {
  return !props.disabled && !props.loading && !props.streaming && inputText.value.trim().length > 0
})

// ============ 方法 ============

/** 自适应 textarea 高度 */
function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  const scrollHeight = el.scrollHeight
  el.style.height = Math.min(Math.max(scrollHeight, MIN_HEIGHT), MAX_HEIGHT) + 'px'
}

/** 输入事件 */
function onInput() {
  autoResize()
}

/** 键盘事件 */
function onKeydown(e: KeyboardEvent) {
  // Enter（无 Shift）→ 发送
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
    return
  }
  // Shift+Enter → 换行（默认行为）
}

/** 发送消息 */
function handleSend() {
  const text = inputText.value.trim()
  if (!text || !canSend.value) return

  emit('send', text)

  // 清空并重置高度
  inputText.value = ''
  if (textareaRef.value) {
    textareaRef.value.style.height = MIN_HEIGHT + 'px'
  }
  textareaRef.value?.focus()
}

/** 中止生成 */
function handleAbort() {
  emit('abort')
}

/** 聚焦到输入框 */
function focus() {
  textareaRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    class="message-input"
    :class="{
      'is-disabled': disabled,
      'is-loading': loading,
      'is-streaming': streaming,
    }"
  >
    <!-- textarea 区 -->
    <div class="input-area">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :placeholder="placeholder"
        :disabled="disabled || loading || streaming"
        :aria-label="targetSessionKey ? `输入消息到 ${targetSessionKey}` : '输入消息'"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
      />

      <!-- loading 遮罩（流式输出中） -->
      <div v-if="loading" class="input-loading-overlay">
        <span class="loading-dot" />
        <span class="loading-dot" />
        <span class="loading-dot" />
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-area">
      <!-- 中止按钮（仅 streaming 时显示） -->
      <button
        v-if="streaming"
        type="button"
        class="btn btn-abort"
        title="中止生成"
        aria-label="中止生成"
        @click="handleAbort"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
      </button>

      <!-- 发送按钮 -->
      <button
        v-else
        type="button"
        class="btn btn-send"
        :class="{ 'is-loading': loading }"
        :disabled="!canSend"
        title="发送（Enter）"
        aria-label="发送消息"
        @click="handleSend"
      >
        <svg v-if="!loading" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 8L2 14V8.5L7 8L2 7.5V2L14 8Z" fill="currentColor" />
        </svg>
        <span v-else class="spinner" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.message-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: var(--el-fill-color-light, #f5f7fa);
  border-top: 1px solid var(--el-border-color, #e8e8e8);
  border-radius: 0 0 8px 8px;
  transition: opacity 0.2s;
}

.message-input.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* ---------- 输入区 ---------- */
.input-area {
  flex: 1;
  min-width: 0;
  position: relative;
}

.input-textarea {
  width: 100%;
  min-height: 40px;
  max-height: 160px;
  padding: 8px 12px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--el-text-color-primary, #303133);
  background: #fff;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 8px;
  resize: none;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
  overflow-y: auto;
}

.input-textarea::placeholder {
  color: var(--el-text-color-placeholder, #a0a0a0);
}

.input-textarea:focus {
  border-color: var(--el-color-primary, #409eff);
}

/* streaming 时 textarea 样式 */
.is-streaming .input-textarea {
  border-color: var(--el-color-danger, #f56c6c);
  border-style: dashed;
}

/* loading 遮罩 */
.input-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 8px;
  pointer-events: none;
}

.loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-primary, #409eff);
  animation: dot-bounce 1.2s infinite ease-in-out both;
}

.loading-dot:nth-child(1) { animation-delay: -0.32s; }
.loading-dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
  40% { transform: scale(1); opacity: 1; }
}

/* ---------- 按钮区 ---------- */
.action-area {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;
  outline: none;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 发送按钮 */
.btn-send {
  background: var(--el-color-primary, #409eff);
  color: #fff;
}

.btn-send:not(:disabled):hover {
  background: var(--el-color-primary-light-3, #79bbff);
}

.btn-send:not(:disabled):active {
  background: var(--el-color-primary-dark-2, #337ecc);
}

/* 发送按钮 loading */
.btn-send.is-loading {
  pointer-events: none;
}

/* 中止按钮 */
.btn-abort {
  background: var(--el-color-danger, #f56c6c);
  color: #fff;
}

.btn-abort:not(:disabled):hover {
  background: var(--el-color-danger-light-3, #f89898);
}

.btn-abort:not(:disabled):active {
  background: var(--el-color-danger-dark-2, #c45656);
}

/* spinner */
.spinner {
  display: block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
