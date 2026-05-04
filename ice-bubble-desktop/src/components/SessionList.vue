<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useNow } from '@/composables/useNow';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api, type SessionDTO } from '../api/client.ts';

const props = defineProps<{
  selectedSession: string | null;
  filterAgent: string;
}>();

const emit = defineEmits<{
  (e: 'select', session: SessionDTO): void;
  (e: 'refresh'): void;
}>();

const sessions = ref<SessionDTO[]>([]);
const loading = ref(false);
const error = ref('');

const filteredSessions = computed(() => {
  let list = props.filterAgent && props.filterAgent !== 'all'
    ? sessions.value.filter(s => s.agent_id === props.filterAgent)
    : sessions.value;

  return list.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });
});

const nowRef = useNow();

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return '';
  const now = nowRef.value;
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
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function formatTime(dateString: string | null): string {
  if (!dateString) return '';
  const d = new Date(dateString);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function getDisplayTitle(s: SessionDTO): string {
  if (s.label) return s.label;
  if (s.last_message) return s.last_message.slice(0, 40) + (s.last_message.length > 40 ? '...' : '');
  // Simplify session_key: take last 2 segments
  const parts = s.session_key.split(':');
  return parts.slice(-2).join(':');
}

function getPreview(s: SessionDTO): string {
  if (s.last_message) return s.last_message.slice(0, 50) + (s.last_message.length > 50 ? '...' : '');
  return '';
}

function agentDotColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function agentTooltip(s: SessionDTO): string {
  const name = s.agent_name || s.agent_id;
  return `${name} (${s.agent_id})`;
}

async function fetchSessions() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.getUnifiedSessions();
    sessions.value = data.sessions || [];
  } catch (e: any) {
    error.value = e.message || '获取会话列表失败';
    ElMessage.error('获取会话列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

function selectSession(session: SessionDTO) {
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

    <div class="session-scroll" v-loading="loading">
      <div v-if="error" class="error-msg">{{ error }}</div>

      <div v-else-if="filteredSessions.length === 0 && !loading" class="empty-msg">
        暂无会话
      </div>

      <div
        v-for="session in filteredSessions"
        :key="session.session_key"
        class="session-item"
        :class="{ selected: selectedSession === session.session_key }"
        :title="agentTooltip(session)"
        @click="selectSession(session)"
      >
        <span
          class="agent-dot"
          :style="{ backgroundColor: agentDotColor(session.agent_id) }"
        ></span>
        <div class="session-content">
          <div class="session-row-1">
            <span class="session-title">{{ getDisplayTitle(session) }}</span>
            <span
              v-if="session.last_message_at"
              class="session-time"
              :title="formatTime(session.last_message_at)"
            >{{ formatRelativeTime(session.last_message_at) }}</span>
          </div>
          <div v-if="getPreview(session) && session.label" class="session-row-2">
            {{ getPreview(session) }}
          </div>
          <div class="session-row-3">
            <span class="msg-count">{{ session.message_count }} 条消息</span>
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

.session-scroll {
  flex: 1;
  overflow-y: auto;
}

.session-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 16px 10px 14px;
  cursor: pointer;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}

.session-item:hover {
  background: var(--color-bg-subtle);
}

.session-item.selected {
  background: rgba(64, 158, 255, 0.06);
  border-left-color: var(--color-accent-blue);
}

.agent-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}

.session-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.session-row-1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.session-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.session-time {
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.7;
  flex-shrink: 0;
  white-space: nowrap;
}

.session-row-2 {
  font-size: 12px;
  color: var(--color-text-secondary);
  opacity: 0.65;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row-3 {
  margin-top: 2px;
}

.msg-count {
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.5;
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
