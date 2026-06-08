<script setup lang="ts">
/**
 * ConnectionStatusBar — 全局 WebSocket 连接状态栏
 *
 * 状态对应：
 *   CONNECTED    → 🟢 已连接（默认折叠）
 *   CONNECTING   → 🟡 连接中
 *   RECONNECTING → 🟡 重连中(第N次) + 倒计时 + 进度条
 *   FAILED       → 🔴 连接失败 + 手动重连按钮
 *   IDLE         → 灰色 未连接
 *   DISCONNECTED → 灰色 已断开 + 连接按钮
 */
import { computed, ref } from 'vue'
import type { WebSocketManager } from '@/services/websocket-manager'
import type { ConnectionState } from '@/types/connection'

const props = defineProps<{
  manager: WebSocketManager
}>()

const expanded = ref(false)

/** 是否显示状态栏（CONNECTED 且无队列时折叠/隐藏） */
const visible = computed(() => {
  const state = props.manager.state.value
  if (state === 'CONNECTED' && props.manager.queueStatus.value.size === 0) return false
  if (state === 'IDLE') return false
  return true
})

/** 连接状态配置映射 */
interface StatusConfig {
  color: string
  bgColor: string
  icon: string
  text: string
  showProgress: boolean
  showButton: boolean
  buttonText: string
}

const statusMap: Record<ConnectionState, StatusConfig> = {
  CONNECTED: {
    color: '#1a7f37',
    bgColor: '#dafbe1',
    icon: '🟢',
    text: '已连接',
    showProgress: false,
    showButton: false,
    buttonText: '',
  },
  CONNECTING: {
    color: '#9a6700',
    bgColor: '#fff8c5',
    icon: '🟡',
    text: '连接中…',
    showProgress: false,
    showButton: false,
    buttonText: '',
  },
  RECONNECTING: {
    color: '#9a6700',
    bgColor: '#fff8c5',
    icon: '🟡',
    text: '重连中…',
    showProgress: true,
    showButton: true,
    buttonText: '立即重连',
  },
  FAILED: {
    color: '#cf222e',
    bgColor: '#ffebe9',
    icon: '🔴',
    text: '连接失败',
    showProgress: false,
    showButton: true,
    buttonText: '重试连接',
  },
  IDLE: {
    color: '#8c959f',
    bgColor: '#f6f8fa',
    icon: '⚪',
    text: '未连接',
    showProgress: false,
    showButton: true,
    buttonText: '连接',
  },
  DISCONNECTED: {
    color: '#8c959f',
    bgColor: '#f6f8fa',
    icon: '⚪',
    text: '已断开',
    showProgress: false,
    showButton: true,
    buttonText: '连接',
  },
}

const config = computed(() => statusMap[props.manager.state.value])

/** 重连详情文本 */
const reconnectText = computed(() => {
  const info = props.manager.retryInfo.value
  if (!info) return ''
  return `第 ${info.attempt}/${info.maxRetries} 次 · ${Math.ceil(info.nextRetryIn / 1000)}s 后重试`
})

/** 重连进度（0~1） */
const retryProgress = computed(() => {
  const info = props.manager.retryInfo.value
  if (!info) return 0
  return info.attempt / info.maxRetries
})

/** 队列提示 */
const queueHint = computed(() => {
  const qs = props.manager.queueStatus.value
  if (qs.size === 0) return ''
  return `· ${qs.size} 条消息等待发送`
})

/** 错误详情 */
const errorDetail = computed(() => {
  const err = props.manager.lastError.value
  return err?.message ?? ''
})

/** 点击展开/折叠 */
function toggleExpand() {
  expanded.value = !expanded.value
}

/** 手动重连 / 连接 */
function handleAction() {
  props.manager.manualReconnect()
}
</script>

<template>
  <Transition name="status-bar">
    <div
      v-if="visible"
      class="connection-status-bar"
      :class="[`status-${manager.state.value.toLowerCase()}`]"
      @click="toggleExpand"
    >
      <div class="status-bar-main">
        <span class="status-icon">{{ config.icon }}</span>
        <span class="status-text">
          {{ config.text }}
          <template v-if="manager.state.value === 'RECONNECTING'">
            {{ reconnectText }}
          </template>
          <template v-if="queueHint">
            {{ queueHint }}
          </template>
        </span>

        <!-- 手动操作按钮 -->
        <button
          v-if="config.showButton"
          class="status-action-btn"
          :style="{ color: config.color, borderColor: config.color }"
          @click.stop="handleAction"
        >
          {{ config.buttonText }}
        </button>

        <!-- 展开箭头 -->
        <span
          v-if="errorDetail"
          class="status-expand-arrow"
          :class="{ expanded }"
        >
          ▾
        </span>
      </div>

      <!-- 重连进度条 -->
      <div v-if="config.showProgress" class="status-progress-bar">
        <div
          class="status-progress-fill"
          :style="{ width: `${retryProgress * 100}%`, backgroundColor: config.color }"
        />
      </div>

      <!-- 展开详情 -->
      <Transition name="status-detail">
        <div v-if="expanded && errorDetail" class="status-detail">
          <div class="status-detail-label">错误详情</div>
          <div class="status-detail-content">{{ errorDetail }}</div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<style scoped>
.connection-status-bar {
  background: var(--color-bg-inset);
  border-bottom: 1px solid var(--color-border-lighter);
  padding: 0 16px;
  cursor: default;
  user-select: none;
  position: relative;
  z-index: 10;
}

.status-bar-main {
  display: flex;
  align-items: center;
  height: 32px;
  gap: 8px;
  font-size: 12px;
  line-height: 32px;
}

.status-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.status-text {
  flex: 1;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-action-btn {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 10px;
  border: 1px solid;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}
.status-action-btn:hover {
  opacity: 0.8;
}

.status-expand-arrow {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: 10px;
  transition: transform 0.2s;
}
.status-expand-arrow.expanded {
  transform: rotate(180deg);
}

.status-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(0, 0, 0, 0.06);
}
.status-progress-fill {
  height: 100%;
  transition: width 1s linear;
  border-radius: 0 1px 1px 0;
}

.status-detail {
  padding: 6px 0 8px;
  border-top: 1px solid var(--color-border-lighter);
}
.status-detail-label {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-bottom: 2px;
}
.status-detail-content {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: monospace;
  word-break: break-all;
}

/* 状态背景微调 */
.status-connected .status-bar-main { background: #dafbe10d; }
.status-connecting .status-bar-main,
.status-reconnecting .status-bar-main { background: #fff8c50d; }
.status-failed .status-bar-main { background: #ffebe90d; }

/* 过渡动画 */
.status-bar-enter-active { transition: all 0.3s ease; }
.status-bar-leave-active { transition: all 0.2s ease; }
.status-bar-enter-from,
.status-bar-leave-to { opacity: 0; transform: translateY(-100%); }

.status-detail-enter-active { transition: all 0.2s ease; }
.status-detail-leave-active { transition: all 0.15s ease; }
.status-detail-enter-from,
.status-detail-leave-to { opacity: 0; max-height: 0; overflow: hidden; }
</style>
