<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { ADMIN_API_BASE } from '../../config';

// =========== DTO 接口 ===========

interface AdminTaskItem {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout';
  agent_id: string;
  child_session_key: string;
  run_id: string;
  mode: string;
  task_description: string;
  created_at: string;
  started_at: string;
  completed_at: string;
}

// =========== 状态 ===========

const tasks = ref<AdminTaskItem[]>([]);
const total = ref(0);
const loading = ref(false);
const expandedTaskId = ref<string | null>(null);
const scrollContainerRef = ref<HTMLElement | null>(null);

const PAGE_SIZE = 30;
let currentOffset = 0;
let allLoaded = false;

// 30 秒自动刷新
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// =========== 数据获取 ===========

async function fetchTasks(append = false): Promise<void> {
  if (loading.value) return;
  if (allLoaded && append) return;

  loading.value = true;
  try {
    const res = await fetch(`${ADMIN_API_BASE}/api/tasks?limit=${PAGE_SIZE}&offset=${append ? currentOffset : 0}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (append) {
      tasks.value = [...tasks.value, ...data.tasks];
    } else {
      tasks.value = data.tasks;
      currentOffset = 0;
    }
    total.value = data.total;
    currentOffset += data.tasks.length;
    if (tasks.value.length >= data.total) {
      allLoaded = true;
    }
  } catch (e) {
    console.error('获取任务列表失败:', e);
  } finally {
    loading.value = false;
  }
}

// =========== 滚动加载 ===========

function onScroll(): void {
  const container = scrollContainerRef.value;
  if (!container || loading.value || allLoaded) return;

  // 距底部 50px 时触发加载
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 50) {
    fetchTasks(true);
  }
}

// =========== 统计 ===========

const stats = computed(() => {
  let completed = 0, running = 0, queued = 0, failed = 0, timeout = 0;
  for (const t of tasks.value) {
    switch (t.status) {
      case 'completed': completed++; break;
      case 'running': running++; break;
      case 'queued': queued++; break;
      case 'failed': failed++; break;
      case 'timeout': timeout++; break;
    }
  }
  return { completed, running, queued, failed, timeout, total: tasks.value.length };
});

import { computed } from 'vue';

// =========== 工具函数 ===========

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✓';
    case 'running':   return '↻';
    case 'queued':    return '◷';
    case 'failed':    return '✗';
    case 'timeout':   return '⏱';
    default:          return '?';
  }
}

function statusTagType(status: string): '' | 'success' | 'primary' | 'info' | 'danger' | 'warning' {
  switch (status) {
    case 'completed': return 'success';
    case 'running':   return 'primary';
    case 'queued':    return 'info';
    case 'failed':    return 'danger';
    case 'timeout':   return 'warning';
    default:          return '';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed': return '完成';
    case 'running':   return '运行中';
    case 'queued':    return '排队';
    case 'failed':    return '失败';
    case 'timeout':   return '超时';
    default:          return status;
  }
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (isToday) return `${hh}:${mm}`;

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day} ${hh}:${mm}`;
}

function toggleTask(taskId: string): void {
  expandedTaskId.value = expandedTaskId.value === taskId ? null : taskId;
}

// =========== 生命周期 ===========

onMounted(() => {
  fetchTasks();
  refreshTimer = setInterval(() => fetchTasks(), 30_000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <div class="task-list-card">
    <!-- 头部统计 -->
    <div class="task-list-header">
      <span class="header-title">任务列表</span>
      <span class="header-stats">
        共 {{ total }} 个 |
        <span class="stat-completed">✅{{ stats.completed }}</span>
        <span class="stat-running">🔄{{ stats.running }}</span>
        <span class="stat-queued">⏳{{ stats.queued }}</span>
      </span>
    </div>

    <!-- 任务列表（独立滚动） -->
    <div ref="scrollContainerRef" class="task-list-body" @scroll="onScroll">
      <div v-if="!loading && tasks.length === 0" class="empty-state">
        暂无任务
      </div>

      <template v-for="task in tasks" :key="task.id">
        <div
          class="task-row"
          :class="{ expanded: expandedTaskId === task.id }"
          @click="toggleTask(task.id)"
        >
          <el-tag
            :type="statusTagType(task.status)"
            size="small"
            effect="plain"
            class="status-tag"
            round
          >
            {{ statusIcon(task.status) }} {{ statusLabel(task.status) }}
          </el-tag>

          <el-tag size="small" effect="plain" class="agent-tag">{{ task.agent_id }}</el-tag>

          <el-tooltip :content="task.title" placement="top" :show-after="300">
            <span class="task-title">{{ task.title }}</span>
          </el-tooltip>

          <span class="task-time">{{ formatTime(task.created_at) }}</span>
        </div>

        <div v-if="expandedTaskId === task.id" class="task-detail">
          <div class="detail-label">描述</div>
          <div class="detail-text">{{ task.task_description || '暂无描述' }}</div>
          <div class="detail-meta">
            <span>Agent: {{ task.agent_id }}</span>
            <span>创建: {{ formatTime(task.created_at) }}</span>
            <span v-if="task.completed_at">完成: {{ formatTime(task.completed_at) }}</span>
          </div>
        </div>
      </template>

      <!-- 加载更多指示器 -->
      <div v-if="loading && tasks.length > 0" class="loading-hint">
        加载中...
      </div>
      <div v-if="allLoaded && tasks.length > 0" class="end-hint">
        已加载全部 {{ total }} 个任务
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-list-card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.task-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color-light);
  flex-shrink: 0;
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-stats {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.header-stats .stat-completed { color: var(--el-color-success); }
.header-stats .stat-running   { color: var(--el-color-primary); }
.header-stats .stat-queued    { color: var(--el-text-color-secondary); }

.task-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.empty-state {
  padding: 24px 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.15s;
  min-height: 32px;
}

.task-row:hover {
  background: var(--el-fill-color-light);
}

.task-row.expanded {
  background: var(--el-fill-color);
}

.status-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 6px;
  height: 20px;
  line-height: 18px;
}

.agent-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 4px;
  height: 20px;
  line-height: 18px;
  min-width: 36px;
  text-align: center;
}

.task-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  font-family: var(--font-exo2, monospace);
  margin-left: 4px;
}

.task-detail {
  padding: 8px 12px 10px 12px;
  margin: 0 4px 4px 4px;
  background: var(--el-bg-color-page);
  border-radius: 4px;
  border: 1px solid var(--el-border-color-extra-light);
  font-size: 12px;
}

.detail-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.detail-text {
  color: var(--el-text-color-regular);
  line-height: 1.5;
  margin-bottom: 6px;
  word-break: break-word;
}

.detail-meta {
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  font-family: var(--font-exo2, monospace);
}

.loading-hint {
  padding: 8px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.end-hint {
  padding: 8px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
</style>
