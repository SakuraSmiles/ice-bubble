<script setup lang="ts">
/**
 * SessionSelector.vue — 会话选择下拉组件
 * 位于输入框下方，按 agent 分组展示 session 列表
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

const DEFAULT_SESSION = 'agent:main:main'

/** 按 agent 分组后的 session 列表 */
const groupedSessions = computed(() => {
  const map = new Map<string, SessionItem[]>()

  for (const session of props.sessions) {
    const agent = session.agent || 'unknown'
    if (!map.has(agent)) {
      map.set(agent, [])
    }
    map.get(agent)!.push(session)
  }

  // 每组内按 lastActive 倒序
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ta = a.lastActive ? new Date(a.lastActive).getTime() : 0
      const tb = b.lastActive ? new Date(b.lastActive).getTime() : 0
      return tb - ta
    })
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

/** 当前选中值（确保有默认值） */
const selectedValue = computed({
  get: () =>
    props.modelValue ||
    (props.sessions.length > 0 ? props.sessions[0].sessionKey : DEFAULT_SESSION),
  set: (val: string) => emit('update:modelValue', val),
})

// ============ 方法 ============

/** 生成 session 的短标签（省略前缀） */
function formatLabel(item: SessionItem | undefined): string {
  if (!item) return '选择会话'
  if (item.title) return item.title
  const parts = item.sessionKey.split(':')
  // agent:xxx:local:direct:UUID -> local:direct:UUID
  const localIdx = parts.indexOf('local')
  if (localIdx >= 0) {
    return parts.slice(localIdx).join(':')
  }
  return item.sessionKey
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
      <!-- 工具栏：刷新按钮 -->
      <template #prefix>
        <div class="selector-prefix">
          <span class="current-key">{{ formatLabel(sessions.find(s => s.sessionKey === selectedValue) ?? sessions[0]) }}</span>
        </div>
      </template>

      <template #empty>
        <div class="dropdown-empty">暂无 session</div>
      </template>

      <el-option-group
        v-for="group in groupedSessions"
        :key="group.agent"
        :label="group.agent + ' (' + group.sessions.length + ')'"
      >
        <el-option
          v-for="item in group.sessions"
          :key="item.sessionKey"
          :value="item.sessionKey"
          :label="formatLabel(item)"
        >
          <div class="session-option-inner">
            <span class="option-label">{{ formatLabel(item) }}</span>
            <span
              v-if="item.sessionKey === selectedValue"
              class="option-active-dot"
            ></span>
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
  gap: 8px;
  width: 100%;
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
}

.session-option-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
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
