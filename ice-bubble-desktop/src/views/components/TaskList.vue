<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
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

interface AdminTasksResponse {
  tasks: AdminTaskItem[];
  total: number;
  limit: number;
  offset: number;
}

// =========== 状态 ===========

const tasks = ref<AdminTaskItem[]>([]);
const total = ref(0);
const loading = ref(false);
const expandedTaskId = ref<string | null>(null);

// 30 秒自动刷新
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// =========== 数据获取 ===========

async function fetchTasks(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetch(`${ADMIN_API_BASE}/api/tasks?limit=50&offset=0`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: AdminTasksResponse = await res.json();
    // 后端已按 created_at 倒序返回，前端保持原序
    tasks.value = data.tasks;
    total.value = data.total;
  } catch (e) {
    console.error('获取任务列表失败:', e);
  } finally {
    loading.value = false;
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

// =========== 工具函数 ===========

/** 从 title 中提取主标题：取第一行，如果是 "## 任务：xxx" 格式则取冒号后内容 */
function extractMainTitle(title: string): string {
  const firstLine = title.split('\n')[0].trim();
  // 匹配 "## 任务："、"## Task：" 等格式
  const headingMatch = firstLine.match(/^##\s*(?:任务|Task)[：:]\s*(.+)/i);
  if (headingMatch) return headingMatch[1].trim();
  return firstLine;
}

/** 截断标题，超过 maxLen 加省略号 */
function truncateTitle(title: string, maxLen = 30): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen) + '…';
}

/** 状态对应的色条颜色 */
function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'var(--el-color-success)';
    case 'running':   return 'var(--el-color-primary)';
    case 'queued':    return 'var(--el-text-color-placeholder)';
    case 'failed':    return 'var(--el-color-danger)';
    case 'timeout':   return 'var(--el-color-warning)';
    default:          return 'var(--el-border-color)';
  }
}

/** 状态对应的小圆点颜色类名 */
function statusDotClass(status: string): string {
  switch (status) {
    case 'completed': return 'dot--success';
    case 'running':   return 'dot--primary';
    case 'queued':    return 'dot--muted';
    case 'failed':    return 'dot--danger';
    case 'timeout':   return 'dot--warning';
    default:          return 'dot--muted';
  }
}

/** 状态中文标签 */
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

/** 格式化时间：今天的显示 HH:mm，其他显示 MM-DD HH:mm */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (isToday) {
    return `${hh}:${mm}`;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day} ${hh}:${mm}`;
}

/** 展开/收起任务详情 */
function toggleTask(taskId: string): void {
  expandedTaskId.value = expandedTaskId.value === taskId ? null : taskId;
}

// =========== 生命周期 ===========

onMounted(() => {
  fetchTasks();
  refreshTimer = setInterval(fetchTasks, 30_000);
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
      <div class="header-pills">
        <span class="pill pill--muted">{{ stats.total }}</span>
        <span v-if="stats.running > 0" class="pill pill--primary">{{ stats.running }}</span>
        <span v-if="stats.completed > 0" class="pill pill--success">{{ stats.completed }}</span>
        <span v-if="stats.failed > 0" class="pill pill--danger">{{ stats.failed }}</span>
        <span v-if="stats.queued > 0" class="pill pill--queued">{{ stats.queued }}</span>
      </div>
    </div>

    <!-- 任务列表 -->
    <div class="task-list-body" v-loading="loading && tasks.length === 0">
      <div v-if="!loading && tasks.length === 0" class="empty-state">
        暂无任务
      </div>

      <template v-for="task in tasks" :key="task.id">
        <div
          class="task-row"
          :class="{ expanded: expandedTaskId === task.id }"
          @click="toggleTask(task.id)"
        >
          <!-- 左侧状态色条 -->
          <span class="status-bar" :style="{ backgroundColor: statusColor(task.status) }"></span>

          <!-- 状态小圆点 + 标签 -->
          <span class="status-indicator">
            <span class="status-dot" :class="statusDotClass(task.status)"></span>
            <span class="status-text">{{ statusLabel(task.status) }}</span>
          </span>

          <!-- Agent 标签（小圆点 + 文字） -->
          <span class="agent-label">
            <span class="agent-dot"></span>
            <span>{{ task.agent_id }}</span>
          </span>

          <!-- 标题（渐变遮罩截断） -->
          <el-tooltip :content="extractMainTitle(task.title)" placement="top" :show-after="300">
            <span class="task-title-wrapper">
              <span class="task-title">{{ truncateTitle(extractMainTitle(task.title)) }}</span>
            </span>
          </el-tooltip>

          <!-- 时间 -->
          <span class="task-time">{{ formatTime(task.created_at) }}</span>
        </div>

        <!-- 展开的详情（带过渡动画） -->
        <transition name="expand">
          <div v-if="expandedTaskId === task.id" class="task-detail">
            <div class="detail-label">描述</div>
            <div class="detail-text">{{ task.task_description || '暂无描述' }}</div>
            <div class="detail-meta">
              <span>Agent: {{ task.agent_id }}</span>
              <span>创建: {{ formatTime(task.created_at) }}</span>
              <span v-if="task.completed_at">完成: {{ formatTime(task.completed_at) }}</span>
            </div>
          </div>
        </transition>
      </template>
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
  max-height: 100%;
}

/* ===== 头部 ===== */

.task-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color-light);
  flex-shrink: 0;
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* pill 统计栏 */
.header-pills {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-exo2, monospace);
  line-height: 1;
}

.pill--muted {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.pill--success {
  background: rgba(var(--el-color-success-rgb), 0.1);
  color: var(--el-color-success);
}

.pill--primary {
  background: rgba(var(--el-color-primary-rgb), 0.1);
  color: var(--el-color-primary);
}

.pill--danger {
  background: rgba(var(--el-color-danger-rgb), 0.1);
  color: var(--el-color-danger);
}

.pill--queued {
  background: var(--el-fill-color);
  color: var(--el-text-color-placeholder);
}

/* ===== 列表体 ===== */

.task-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0;
}

.empty-state {
  padding: 24px 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

/* ===== 任务行 ===== */

.task-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 0;
  cursor: pointer;
  transition: background 0.15s;
  min-height: 30px;
  position: relative;
}

.task-row:hover {
  background: var(--el-fill-color-light);
}

.task-row.expanded {
  background: var(--el-fill-color);
}

/* 左侧状态色条 */
.status-bar {
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  transition: background-color 0.2s;
}

/* 状态指示器（圆点 + 文字） */
.status-indicator {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot--success { background: var(--el-color-success); }
.dot--primary { background: var(--el-color-primary); }
.dot--muted   { background: var(--el-text-color-placeholder); }
.dot--danger  { background: var(--el-color-danger); }
.dot--warning { background: var(--el-color-warning); }

.status-text {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  min-width: 28px;
}

/* Agent 标签（柔和样式） */
.agent-label {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  padding: 1px 6px 1px 5px;
  border-radius: 8px;
  max-width: 80px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.agent-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--el-color-info-light-3);
  flex-shrink: 0;
}

/* 标题（渐变遮罩截断） */
.task-title-wrapper {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  mask-image: linear-gradient(to right, #000 70%, transparent 100%);
  -webkit-mask-image: linear-gradient(to right, #000 70%, transparent 100%);
}

.task-title {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 时间 */
.task-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  font-family: var(--font-exo2, monospace);
  margin-left: 2px;
}

/* ===== 详情面板 ===== */

.task-detail {
  padding: 8px 12px 10px 18px;
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

/* ===== 展开收起过渡动画 ===== */

.expand-enter-active {
  transition: max-height 0.25s ease, opacity 0.2s ease;
  overflow: hidden;
}

.expand-leave-active {
  transition: max-height 0.2s ease, opacity 0.15s ease;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-bottom: 0;
}

.expand-enter-to,
.expand-leave-from {
  max-height: 300px;
  opacity: 1;
}
</style>
