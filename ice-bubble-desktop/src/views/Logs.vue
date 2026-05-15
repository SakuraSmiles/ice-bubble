<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLogger } from '@/composables/useLogger'

const { logs, clearLogs, exportLogs } = useLogger()

type Tab = 'all' | 'log' | 'warn' | 'error' | 'network'
const activeTab = ref<Tab>('all')
const keyword = ref('')

const filteredLogs = computed(() => {
  let result = logs
  if (activeTab.value !== 'all') {
    result = result.filter(l => l.type === activeTab.value)
  }
  if (keyword.value.trim()) {
    const kw = keyword.value.toLowerCase()
    result = result.filter(l =>
      l.message.toLowerCase().includes(kw) ||
      (l.detail && l.detail.toLowerCase().includes(kw))
    )
  }
  // 倒序：最新在上面
  return [...result].reverse()
})

const tabCounts = computed(() => {
  const c = { all: logs.length, log: 0, warn: 0, error: 0, network: 0 }
  for (const l of logs) c[l.type]++
  return c
})

function typeColor(type: string) {
  switch (type) {
    case 'warn': return 'var(--el-color-warning)'
    case 'error': return 'var(--el-color-danger)'
    case 'network': return 'var(--el-color-primary)'
    default: return 'var(--el-text-color-secondary)'
  }
}

function typeClass(type: string) {
  switch (type) {
    case 'error': return 'log-entry--error'
    case 'warn': return 'log-entry--warn'
    case 'network': return 'log-entry--network'
    default: return ''
  }
}

function typeLabel(type: string) {
  switch (type) {
    case 'warn': return 'WARN'
    case 'error': return 'ERR'
    case 'network': return 'NET'
    default: return 'LOG'
  }
}

const ITEM_HEIGHT = 32
const VISIBLE_COUNT = 100

const scrollTop = ref(0)
const containerRef = ref<HTMLElement>()

const visibleLogs = computed(() => {
  const start = Math.floor(scrollTop.value / ITEM_HEIGHT)
  const end = Math.min(start + VISIBLE_COUNT + 20, filteredLogs.value.length)
  return {
    items: filteredLogs.value.slice(start, end),
    offset: start * ITEM_HEIGHT,
    totalHeight: filteredLogs.value.length * ITEM_HEIGHT,
  }
})

function onScroll() {
  if (containerRef.value) {
    scrollTop.value = containerRef.value.scrollTop
  }
}

function autoScrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = 0 // 倒序排列，最新在顶部，scrollTop=0 即最新
  }
}
</script>

<template>
  <div class="logs-page">
    <!-- 工具栏 -->
    <div class="logs-toolbar">
      <div class="tabs">
        <button
          v-for="tab in (['all', 'log', 'warn', 'error', 'network'] as Tab[])"
          :key="tab"
          class="tab-btn"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >
          {{ tab === 'all' ? '全部' : tab === 'log' ? '信息' : tab === 'warn' ? '警告' : tab === 'error' ? '错误' : '网络' }}
          <span class="tab-count">{{ tabCounts[tab] }}</span>
        </button>
      </div>
      <div class="actions">
        <el-input
          v-model="keyword"
          placeholder="搜索日志..."
          clearable
          size="small"
          style="width: 200px"
        />
        <el-button size="small" @click="autoScrollToBottom">最新</el-button>
        <el-button size="small" @click="clearLogs">清空</el-button>
        <el-button size="small" @click="exportLogs">导出</el-button>
      </div>
    </div>

    <!-- 日志列表 -->
    <div ref="containerRef" class="logs-list" @scroll="onScroll">
      <div :style="{ height: visibleLogs.totalHeight + 'px', position: 'relative' }">
        <div :style="{ transform: `translateY(${visibleLogs.offset}px)` }">
          <div
            v-for="entry in visibleLogs.items"
            :key="entry.id"
            class="log-entry"
            :class="typeClass(entry.type)"
          >
            <span class="log-time">{{ entry.timestamp }}</span>
            <span class="log-tag" :style="{ color: typeColor(entry.type) }">{{ typeLabel(entry.type) }}</span>
            <span class="log-msg" :title="entry.detail ? entry.message + '\n' + entry.detail : entry.message">
              {{ entry.message }}
            </span>
            <span v-if="entry.detail" class="log-detail" :title="entry.detail">{{ entry.detail }}</span>
          </div>
        </div>
      </div>
      <div v-if="filteredLogs.length === 0" class="logs-empty">暂无日志</div>
    </div>
  </div>
</template>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  gap: 8px;
  background: var(--color-bg);
}

.logs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.tabs {
  display: flex;
  gap: 2px;
  background: var(--el-fill-color-light);
  border-radius: var(--radius);
  padding: 2px;
}

.tab-btn {
  padding: 4px 10px;
  font-size: 12px;
  border: none;
  background: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

.tab-btn:hover {
  color: var(--el-text-color-primary);
}

.tab-btn.active {
  background: var(--color-bg-inset);
  color: var(--el-text-color-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.tab-count {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}

.tab-btn.active .tab-count {
  color: var(--el-color-primary);
}

.actions {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}

.logs-list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-bg-inset);
}

.logs-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.log-entry {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 8px;
  gap: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  line-height: 32px;
  white-space: nowrap;
  overflow: hidden;
  transition: background-color 100ms ease;
}

.log-entry--error {
  background: #ffebe9;
}
.log-entry--error .log-tag {
  color: #cf222e;
}
.log-entry--warn {
  background: #fff8c5;
}
.log-entry--warn .log-tag {
  color: #9a6700;
}
.log-entry--network {
  background: #ddf4ff;
}
.log-entry--network .log-tag {
  color: #0969da;
}
.log-entry:hover {
  background-color: var(--ib-hover-bg-light);
}

.log-time {
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
  width: 86px;
  font-size: 11px;
}

.log-tag {
  flex-shrink: 0;
  width: 28px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
}

.log-msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-text-color-primary);
}

.log-detail {
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-text-color-placeholder);
  font-size: 11px;
}
</style>
