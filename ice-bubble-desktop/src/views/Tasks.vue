<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import EmptyState from '../components/EmptyState.vue';
import { formatTime } from '../utils/format';
import { API_BASE } from '../config';
import { authFetch } from '../api/client';

interface SubagentTask {
  session_key: string;
  label: string | null;
  agent_id: string;
  session_status: string;
  spawned_by: string | null;
  spawn_depth: number;
  created_at: string;
  last_message_at: string | null;
  first_message_at: string | null;
  message_count: number;
}

const tasks = ref<SubagentTask[]>([]);
const loading = ref(false);
const refreshSpin = ref(false);
const total = ref(0);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchTasks() {
  loading.value = true;
  try {
    const res = await authFetch(`${API_BASE}/subagent-tasks?limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    tasks.value = data.tasks ?? [];
    total.value = data.total ?? 0;
  } catch (e) {
    console.error('获取任务列表失败:', e);
  } finally {
    loading.value = false;
  }
}

function handleRefresh() {
  refreshSpin.value = true;
  fetchTasks().finally(() => {
    setTimeout(() => { refreshSpin.value = false; }, 500);
  });
}

function statusType(status: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'running': return 'success';
    case 'done': case 'completed': return 'info';
    case 'failed': case 'error': return 'danger';
    default: return 'warning';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running': return '运行中';
    case 'done': case 'completed': return '已完成';
    case 'failed': case 'error': return '失败';
    default: return status;
  }
}

onMounted(() => {
  fetchTasks();
  pollTimer = setInterval(fetchTasks, 30000);
});

onUnmounted(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});
</script>

<template>
  <div class="tasks-page">
    <PageHeader title="任务" subtitle="子 Agent 任务列表" :loading="loading" @refresh="handleRefresh">
      <el-text type="info" size="small">共 {{ total }} 个任务</el-text>
    </PageHeader>

    <el-card class="content-area" shadow="never">
      <EmptyState v-if="!loading && tasks.length === 0" description="暂无子 Agent 任务" />

      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.session_key" class="task-item">
          <div class="task-top">
            <span class="task-label" :title="task.session_key">
              {{ task.label || task.session_key }}
            </span>
            <el-tag :type="statusType(task.session_status)" size="small" effect="plain">
              {{ statusLabel(task.session_status) }}
            </el-tag>
          </div>
          <div class="task-meta">
            <span class="meta-item">
              <el-icon size="12"><component :is="null" /></el-icon>
              Agent: {{ task.agent_id }}
            </span>
            <span v-if="task.spawned_by" class="meta-item">
              父任务: {{ task.spawned_by }}
            </span>
            <span class="meta-item">
              消息: {{ task.message_count }}
            </span>
            <span v-if="task.created_at" class="meta-item">
              创建: {{ formatTime(task.created_at) }}
            </span>
            <span v-if="task.last_message_at" class="meta-item">
              最后活动: {{ formatTime(task.last_message_at) }}
            </span>
          </div>
        </div>
      </div>
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.tasks-page {
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-canvas);
  border-radius: var(--radius);
  margin: 8px 24px;
  overflow: hidden;
}

.content-area :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-item {
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-extra-light);
}

.task-item .task-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.task-item .task-label {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-family: var(--font-exo2);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
