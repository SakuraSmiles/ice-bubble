<script setup lang="ts">
/**
 * SessionSelector.vue — 会话选择下拉组件
 * 位于输入框下方，按 agent 分组展示 session 列表
 * 每个 agent 最多展示最近 3 个 session，顶部固定「主会话」选项
 */
import { computed } from 'vue'
import { Refresh } from '@element-plus/icons-vue'

// ============ 类型 ============

/** Session 列表项（与后端 /api/sessions 响应字段对齐） */
export interface SessionItem {
  sessionKey: string
  agent: string
  channel: string
  lastActive: string
  title?: string
  agentName?: string | null
  lastMessage?: string | null
}

// ============ Props / Emits ============

interface Props {
  /** 当前选中的 sessionKey */
  modelValue: string
  /** 全量 session 列表 */
  sessions: SessionItem[]
  /** 加载状态，默认 false */
  loading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', sessionKey: string): void
  (e: 'refresh'): void
}>()

// ============ 计算属性 ============

const MAIN_SESSION_KEY = 'agent:main:main'

/** 固定的主会话选项（始终在最顶部） */
const mainSessionOption = {
  sessionKey: MAIN_SESSION_KEY,
  label: '🏠 主会话（冰镇虾头）',
  isMainSession: true as const,
}

/** 按 agent 分组后的 session 列表（每个 agent 最多 3 个） */
const groupedSessions = computed(() => {
  const map = new Map<string, SessionItem[]>()

  for (const session of props.sessions) {
    const agent = session.agent || 'unknown'
    if (!map.has(agent)) {
      map.set(agent, [])
    }
    map.get(agent)!.push(session)
  }

  // 每组内按 lastActive 倒序，只保留最近 3 个
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ta = a.lastActive ? new Date(a.lastActive).getTime() : 0
      const tb = b.lastActive ? new Date(b.lastActive).getTime() : 0
      return tb - ta
    })
    // 限制每 agent 最多 3 个
    if (list.length > 3) {
      list.splice(3)
    }
  }

  // 转为数组，main 组排第一，其余按最新 lastActive 排序
  return Array.from(map.entries())
    .map(([agent, sessions]) => ({ agent, sessions }))
    .sort((a, b) => {
      if (a.agent === 'main') return -1
      if (b.agent === 'main') return 1
      const aLatest = a.sessions[0]?.lastActive
        ? new Date(a.sessions[0].lastActive).getTime()
        : 0
      const bLatest = b.sessions[0]?.lastActive
        ? new Date(b.sessions[0].lastActive).getTime()
        : 0
      return bLatest - aLatest
    })
})

/** 当前选中值（默认为主会话） */
const selectedValue = computed({
  get: () => props.modelValue || MAIN_SESSION_KEY,
  set: (val: string) => emit('update:modelValue', val),
})

// ============ 方法 ============

/** 格式化最后活跃时间（14:30 或 昨天 20:15） */
function formatTime(lastActive: string): string {
  if (!lastActive) return ''
  const date = new Date(lastActive)
  const now = new Date()
  const todayStr = now.toDateString()
  const dateStr = date.toDateString()
  if (dateStr === todayStr) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dateStr === yesterday.toDateString()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
    date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 生成 session 的主标签：有label优先显示label，否则 agent名称 · 最后消息摘要(前20字) */
function formatLabel(item: SessionItem | undefined): string {
  if (!item) return '选择会话'
  // 有 label 的 session 直接显示 label（如 "审计-前端可用性"、"拆分-dev"）
  if (item.title) return item.title
  const agentName = item.agentName ?? item.agent
  const msg = item.lastMessage ? item.lastMessage.substring(0, 20) : ''
  if (msg) return `${agentName} · ${msg}`
  return agentName
}

/** 刷新列表 */
function handleRefresh() {
  emit('refresh')
}
</script>

<template>
  <div class="session-selector">
    <el-select
      v-model="selectedValue"
      placeholder="选择会话"
      filterable
      :loading="loading"
      no-data-text="暂无 session"
      :visible-item-count="10"
      popper-class="session-selector-dropdown"
      placement="bottom-start"
      class="selector-inner"
    >
      <!-- 前缀图标 -->
      <template #prefix>
        <span style="color:#999;font-size:12px;">💬</span>
      </template>

      <template #empty>
        <div class="dropdown-empty">暂无 session</div>
      </template>

      <!-- 主会话固定选项（不分组，始终在最顶部） -->
      <el-option
        :key="mainSessionOption.sessionKey"
        :value="mainSessionOption.sessionKey"
        :label="mainSessionOption.label"
      >
        <div class="session-option-inner main-session-option">
          <div class="option-main">
            <span class="option-label">{{ mainSessionOption.label }}</span>
            <span
              v-if="mainSessionOption.sessionKey === selectedValue"
              class="option-active-dot"
            ></span>
          </div>
        </div>
      </el-option>

      <!-- 分隔 -->
      <el-option
        disabled
        value="__divider__"
        label="──────────────"
        class="dropdown-divider"
      />

      <el-option-group
        v-for="group in groupedSessions"
        :key="group.agent"
        :label="(group.sessions[0]?.agentName || group.agent) + ' (' + group.sessions.length + ')'"
      >
        <el-option
          v-for="item in group.sessions"
          :key="item.sessionKey"
          :value="item.sessionKey"
          :label="formatLabel(item)"
        >
          <div class="session-option-inner">
            <div class="option-main">
              <span class="option-label">{{ formatLabel(item) }}</span>
              <span
                v-if="item.sessionKey === selectedValue"
                class="option-active-dot"
              ></span>
            </div>
            <div class="option-sub">{{ formatTime(item.lastActive) }}</div>
          </div>
        </el-option>
      </el-option-group>
    </el-select>

    <!-- 刷新按钮 -->
    <el-button
      circle
      size="small"
      :loading="loading"
      title="刷新 session 列表"
      @click="handleRefresh"
      class="refresh-btn"
    >
      <Refresh />
    </el-button>
  </div>
</template>

<style scoped>
.session-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 12px;
}

.selector-inner {
  flex: 1;
  min-width: 0;
}

.selector-prefix {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}

.current-key {
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.refresh-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
}

.main-session-option {
  font-weight: 600;
}

.dropdown-divider {
  pointer-events: none;
  opacity: 0.5;
  font-size: 11px;
  text-align: center;
}

.session-option-inner {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  gap: 2px;
  padding: 2px 0;
}

.option-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.option-sub {
  font-size: 11px;
  color: var(--el-text-color-secondary, #909399);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-active-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--el-color-primary);
  flex-shrink: 0;
}

.dropdown-empty {
  padding: 12px;
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}
</style>

<style>
/* 全局：下拉弹层样式 */
.session-selector-dropdown .el-select-dropdown__item {
  font-size: 13px;
}

.session-selector-dropdown .el-select-dropdown__item-group {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
