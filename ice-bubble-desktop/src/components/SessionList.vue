<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';

export interface Session {
  session_key: string;
  agent_id: string;
  channel: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string;
}

interface GroupedSessions {
  agent_id: string;
  sessions: Session[];
}

const props = defineProps<{
  selectedSession: string | null;
  filterAgent: string;
}>();

const emit = defineEmits<{
  (e: 'select', session: Session): void;
  (e: 'refresh'): void;
}>();

const sessions = ref<Session[]>([]);
const loading = ref(false);
const error = ref('');

const groupedSessions = computed<GroupedSessions[]>(() => {
  let filtered = props.filterAgent && props.filterAgent !== 'all'
    ? sessions.value.filter(s => s.agent_id === props.filterAgent)
    : sessions.value;

  const map = new Map<string, Session[]>();
  for (const s of filtered) {
    const list = map.get(s.agent_id) || [];
    list.push(s);
    map.set(s.agent_id, list);
  }

  // Sort groups by most recent session activity
  const groups: GroupedSessions[] = [];
  map.forEach((sessions, agent_id) => {
    // Sort sessions within group by last_message_at desc
    sessions.sort((a, b) => {
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
    groups.push({ agent_id, sessions });
  });

  // Sort groups by most recent message
  groups.sort((a, b) => {
    const ta = a.sessions[0]?.last_message_at
      ? new Date(a.sessions[0].last_message_at).getTime() : 0;
    const tb = b.sessions[0]?.last_message_at
      ? new Date(b.sessions[0].last_message_at).getTime() : 0;
    return tb - ta;
  });

  return groups;
});

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return '-';
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const d = new Date(dateString);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatTime(dateString: string | null): string {
  if (!dateString) return '-';
  const d = new Date(dateString);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function simplifySessionKey(key: string): string {
  // agent:main:local:default:direct:UUID -> main:direct:UUID (last segment)
  const parts = key.split(':');
  if (parts.length >= 2) {
    const uuid = parts[parts.length - 1];
    const shortUuid = uuid.length > 8 ? uuid.substring(0, 8) + '...' : uuid;
    return `${parts[1]}:${shortUuid}`;
  }
  return key;
}

async function fetchSessions() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('http://localhost:13000/api/data/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessions.value = data.sessions || [];
  } catch (e: any) {
    error.value = e.message || '获取会话列表失败';
    ElMessage.error('获取会话列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

function selectSession(session: Session) {
  emit('select', session);
}

defineExpose({ fetchSessions });

onMounted(() => {
  fetchSessions();
});
</script>

<template>
  <div class="session-list-panel">
    <div class="panel-header">
      <span class="panel-title">会话列表</span>
      <el-button circle size="small" :loading="loading" @click="fetchSessions">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>

    <div class="session-groups" v-loading="loading">
      <div v-if="error" class="error-msg">{{ error }}</div>

      <div v-else-if="groupedSessions.length === 0 && !loading" class="empty-msg">
        暂无会话
      </div>

      <div
        v-for="group in groupedSessions"
        :key="group.agent_id"
        class="session-group"
      >
        <div class="group-header">
          <el-tag size="small" type="info">{{ group.agent_id }}</el-tag>
          <span class="group-count">{{ group.sessions.length }} 个会话</span>
        </div>

        <div
          v-for="session in group.sessions"
          :key="session.session_key"
          class="session-item"
          :class="{ selected: selectedSession === session.session_key }"
          @click="selectSession(session)"
        >
          <div class="session-top">
            <el-tag size="small" type="info" class="agent-tag">{{ session.agent_id }}</el-tag>
            <span class="session-key">{{ simplifySessionKey(session.session_key) }}</span>
          </div>
          <div class="session-meta">
            <span class="message-count">{{ session.message_count }} 条消息</span>
            <span class="last-time" :title="formatTime(session.last_message_at)">
              {{ formatRelativeTime(session.last_message_at) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.session-groups {
  flex: 1;
  overflow-y: auto;
}

.session-group {
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border-light, #eee);
}

.session-group:last-child {
  border-bottom: none;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px 8px;
}

.group-count {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.session-item {
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}

.session-item:hover {
  background: var(--color-bg-subtle);
}

.session-item.selected {
  background: var(--color-bg-subtle);
  border-left-color: var(--color-accent-blue);
}

.session-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.agent-tag {
  flex-shrink: 0;
}

.session-key {
  font-size: 12px;
  font-family: monospace;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.message-count {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.last-time {
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.error-msg {
  padding: 16px;
  color: var(--color-accent-red);
  font-size: 12px;
}

.empty-msg {
  padding: 32px 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}
</style>
