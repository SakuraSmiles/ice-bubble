<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useNow } from '@/composables/useNow';

interface SessionItem {
  session_key: string;
  agent_id: string;
  message_count: number;
  last_message_at: string;
  created_at: string;
  session_status: string;
  model?: string;
}

const props = defineProps<{
  agentId: string;
}>();

const emit = defineEmits<{
  (e: 'select', sessionKey: string): void;
}>();

const sessions = ref<SessionItem[]>([]);
const loading = ref(false);
const error = ref('');

const sortedSessions = computed(() =>
  [...sessions.value].sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()),
);

const nowRef = useNow();

function relativeTime(dateStr: string): string {
  const now = nowRef.value;
  const diff = now - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function statusLabel(s: string): string {
  switch (s) {
    case 'running': return '进行中';
    case 'done': return '已完成';
    case 'failed': return '失败';
    case 'timeout': return '超时';
    default: return s || '未知';
  }
}

function statusType(s: string): string {
  switch (s) {
    case 'running': return 'primary';
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'timeout': return 'warning';
    default: return 'info';
  }
}

function formatCount(n: number): string {
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

async function fetchSessions() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(`/api/sessions/unified?agentId=${encodeURIComponent(props.agentId)}&limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessions.value = (data.sessions || []).map((s: any) => ({
      session_key: s.session_key || s.key || '',
      agent_id: s.agent_id || props.agentId,
      message_count: s.message_count || 0,
      last_message_at: s.last_message_at || s.updated_at || s.created_at || '',
      created_at: s.created_at || '',
      session_status: s.status || s.session_status || '',
      model: s.model || '',
    }));
  } catch (e: any) {
    error.value = e.message || '加载失败';
    sessions.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(fetchSessions);
</script>

<template>
  <div class="session-list">
    <!-- Loading -->
    <div v-if="loading" class="session-list-loading">
      <div v-for="i in 5" :key="i" class="skeleton-card">
        <div class="skeleton-line long"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="session-list-error">
      <p>{{ error }}</p>
      <button class="retry-btn" @click="fetchSessions">重试</button>
    </div>

    <!-- Empty -->
    <div v-else-if="sortedSessions.length === 0" class="session-list-empty">
      <p>暂无会话记录</p>
    </div>

    <!-- List -->
    <div v-else class="session-list-items">
      <div
        v-for="session in sortedSessions"
        :key="session.session_key"
        class="session-card"
        :class="{ 'session-card--running': session.session_status === 'running' }"
        @click="emit('select', session.session_key)"
      >
        <div class="session-card__top">
          <el-tag :type="(statusType(session.session_status) as any)" size="small" effect="plain">
            {{ statusLabel(session.session_status) }}
          </el-tag>
          <span v-if="session.model" class="session-card__model">{{ session.model }}</span>
          <span class="session-card__time">{{ relativeTime(session.last_message_at) }}</span>
        </div>
        <div class="session-card__meta">
          <span class="session-card__count">{{ formatCount(session.message_count) }} 条消息</span>
          <span class="session-card__created">创建于 {{ new Date(session.created_at).toLocaleDateString('zh-CN') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.session-list-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-extra-light);
  cursor: pointer;
  transition: all 0.15s;
}

.session-card:hover {
  border-color: var(--el-border-color);
  background: var(--el-fill-color);
}

.session-card--running {
  border-left: 3px solid var(--el-color-primary);
}

.session-card--running:hover {
  border-left-color: var(--el-color-primary);
}

.session-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.session-card__model {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  padding: 2px 6px;
  border-radius: 4px;
}

.session-card__time {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  margin-left: auto;
}

.session-card__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Loading skeleton */
.session-list-loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: var(--el-fill-color);
}

.skeleton-line.long { width: 60%; }
.skeleton-line.short { width: 35%; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.skeleton-card {
  animation: pulse 1.5s infinite;
}

.session-list-error,
.session-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.retry-btn {
  padding: 6px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: transparent;
  color: var(--el-text-color-primary);
  cursor: pointer;
  font-size: 13px;
}

.retry-btn:hover {
  background: var(--el-fill-color-light);
}

@media (max-width: 640px) {
  .session-list { padding: 12px; }
  .session-card { padding: 10px 12px; }
  .session-card__meta { flex-wrap: wrap; gap: 6px; }
}
</style>
