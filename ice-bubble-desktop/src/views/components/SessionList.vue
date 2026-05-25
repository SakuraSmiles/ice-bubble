<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useNow } from '@/composables/useNow';
import { request } from '../../api/client';

interface SessionItem {
  session_key: string;
  agent_id: string;
  agent_name: string | null;
  label: string | null;
  avatar: string | null;
  last_message: string | null;
  message_count: number;
  last_message_at: string;
  created_at: string;
  session_status: string;
  model?: string;
}

const props = defineProps<{
  agentId: string;
  platform?: string;
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

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
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

function getDisplayTitle(s: SessionItem): string {
  if (s.label) return s.label;
  if (s.last_message) return s.last_message.slice(0, 40) + (s.last_message.length > 40 ? '...' : '');
  const parts = s.session_key.split(':');
  return parts.slice(-2).join(':');
}

function getPreview(s: SessionItem): string {
  if (!s.last_message) return '';
  return s.last_message.slice(0, 50) + (s.last_message.length > 50 ? '...' : '');
}

function agentDotColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function agentTooltip(s: SessionItem): string {
  const name = s.agent_name || s.agent_id;
  return `${name} (${s.agent_id})`;
}

async function fetchSessions() {
  loading.value = true;
  error.value = '';
  try {
    const res = await request(`/sessions/unified?agentId=${encodeURIComponent(props.agentId)}&platform=${encodeURIComponent(props.platform || 'openclaw')}&limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessions.value = (data.sessions || []).map((s: any) => ({
      session_key: s.session_key || s.key || '',
      agent_id: s.agent_id || props.agentId,
      agent_name: s.agent_name || null,
      label: s.label || null,
      avatar: s.avatar || null,
      last_message: s.last_message || null,
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
        :title="agentTooltip(session)"
        @click="emit('select', session.session_key)"
      >
        <div class="session-card__body">
          <span
            class="agent-dot"
            :style="{ backgroundColor: agentDotColor(session.agent_id) }"
          ></span>
          <div class="session-card__content">
            <div class="session-card__row1">
              <span class="session-card__title">{{ getDisplayTitle(session) }}</span>
              <span class="session-card__time">{{ relativeTime(session.last_message_at) }}</span>
            </div>
            <div v-if="getPreview(session) && session.label" class="session-card__row2">
              {{ getPreview(session) }}
            </div>
            <div class="session-card__row3">
              <span>{{ session.message_count }} 条消息</span>
              <el-tag :type="(statusType(session.session_status) as any)" size="small" effect="plain">
                {{ statusLabel(session.session_status) }}
              </el-tag>
              <span v-if="session.model" class="session-card__model">{{ session.model }}</span>
            </div>
          </div>
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

.session-card__body {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.agent-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}

.session-card__content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.session-card__row1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.session-card__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.session-card__time {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
  white-space: nowrap;
}

.session-card__row2 {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  opacity: 0.65;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-card__row3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.session-card__model {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  padding: 1px 6px;
  border-radius: 4px;
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
  .session-card__row3 { flex-wrap: wrap; gap: 6px; }
}
</style>
