<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import ChatPanel from '../components/ChatPanel.vue';
import type { Session } from '../components/SessionList.vue';

const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null);

const allSessions = ref<Session[]>([]);
const loading = ref(false);
const selectedSession = ref<Session | null>(null);
const selectedSessionKey = ref<string | null>(null);
const searchQuery = ref('');

const totalSessions = computed(() => allSessions.value.length);
const totalAgents = computed(() => new Set(allSessions.value.map(s => s.agent_id)).size);

const subtitle = computed(() =>
  `共 ${totalSessions.value} 个会话，分布在 ${totalAgents.value} 个 Agent`
);

// Session dropdown options: sorted by last_message_at desc
const sessionOptions = computed(() => {
  let list = [...allSessions.value];

  // Filter by search query
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(s =>
      s.session_key.toLowerCase().includes(q) ||
      s.agent_id.toLowerCase().includes(q) ||
      s.channel.toLowerCase().includes(q)
    );
  }

  // Sort by last_message_at desc
  list.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });

  return list.map(s => ({
    value: s.session_key,
    label: s.session_key,
    session: s,
    _agentId: s.agent_id,
    _channel: s.channel,
    _lastAt: s.last_message_at,
    _count: s.message_count,
  }));
});

function simplifySessionKey(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 2) {
    const uuid = parts[parts.length - 1];
    const shortUuid = uuid.length > 8 ? uuid.substring(0, 8) + '…' : uuid;
    return `${parts[1]}:${shortUuid}`;
  }
  return key;
}

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

async function fetchAllSessions() {
  loading.value = true;
  try {
    const res = await fetch('/api/data/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allSessions.value = data.sessions || [];
  } catch (e: any) {
    ElMessage.error('获取会话列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

function handleSelectSession(key: string) {
  const session = allSessions.value.find(s => s.session_key === key) ?? null;
  selectedSession.value = session;
  selectedSessionKey.value = key;
}

async function handleRefresh() {
  await fetchAllSessions();
  if (selectedSession.value) {
    chatPanelRef.value?.fetchMessages();
  }
}

onMounted(async () => {
  await fetchAllSessions();
});
</script>

<template>
  <div class="sessions-page">
    <PageHeader :title="'会话管理'" :subtitle="subtitle">
      <el-button circle size="small" :loading="loading" @click="handleRefresh" title="刷新">
        <el-icon><Refresh /></el-icon>
      </el-button>

      <el-select
        v-model="selectedSessionKey"
        placeholder="选择会话"
        filterable
        clearable
        :filter-method="(val: string) => { searchQuery = val; }"
        @change="(key: string) => handleSelectSession(key)"
        @clear="() => { selectedSession = null; selectedSessionKey = null; }"
        class="session-selector"
        no-data-text="无匹配会话"
        placeholder-text="选择会话"
      >
        <template #empty>
          <div class="dropdown-empty">无匹配会话</div>
        </template>

        <el-option
          v-for="opt in sessionOptions"
          :key="opt.value"
          :value="opt.value"
          :label="simplifySessionKey(opt.label)"
          class="session-option"
        >
          <div class="session-option-inner">
            <div class="option-top">
              <el-tag size="small" type="info" class="agent-tag">{{ opt._agentId }}</el-tag>
              <span class="option-key">{{ simplifySessionKey(opt.label) }}</span>
            </div>
            <div class="option-meta">
              <span class="option-channel">{{ opt._channel }}</span>
              <span class="option-count">{{ opt._count }} 条</span>
              <span class="option-time">{{ formatRelativeTime(opt._lastAt) }}</span>
            </div>
          </div>
        </el-option>
      </el-select>
    </PageHeader>

    <div class="content-area">
      <ChatPanel
        v-if="selectedSession"
        ref="chatPanelRef"
        :session="selectedSession"
      />

      <div v-else class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-text">请从右上角选择会话</div>
      </div>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.sessions-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 32px;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.session-selector {
  min-width: 300px;
  max-width: 400px;
}

.content-area {
  flex: 1;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  min-height: 400px;
  background: var(--color-bg);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
  margin-bottom: 12px;
}

.empty-text {
  font-size: 14px;
  color: var(--color-text-secondary);
}

.dropdown-empty {
  padding: 12px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* Dropdown option custom styles */
.session-option-inner {
  padding: 4px 0;
  width: 100%;
}

.option-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.agent-tag {
  flex-shrink: 0;
}

.option-key {
  font-size: 12px;
  font-family: monospace;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 2px;
}

.option-channel,
.option-count,
.option-time {
  font-size: 11px;
  color: var(--color-text-secondary);
}
</style>
