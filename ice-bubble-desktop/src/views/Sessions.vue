<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/client.ts';
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

const sessionOptions = computed(() => {
  let list = [...allSessions.value];

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(s =>
      s.session_key.toLowerCase().includes(q) ||
      s.agent_id.toLowerCase().includes(q) ||
      s.channel.toLowerCase().includes(q)
    );
  }

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

const SESSIONS_LIMIT_PER_AGENT = 5;

const groupedSessions = computed(() => {
  const groups: Record<string, { sessions: typeof sessionOptions.value; totalCount: number }> = {};
  
  for (const opt of sessionOptions.value) {
    const agentId = opt._agentId;
    if (!groups[agentId]) {
      groups[agentId] = { sessions: [], totalCount: 0 };
    }
    groups[agentId].sessions.push(opt);
    groups[agentId].totalCount++;
  }
  
  // Sort sessions within each group by last_message_at desc
  for (const group of Object.values(groups)) {
    group.sessions.sort((a, b) => {
      const ta = a._lastAt ? new Date(a._lastAt).getTime() : 0;
      const tb = b._lastAt ? new Date(b._lastAt).getTime() : 0;
      return tb - ta;
    });
  }
  
  // Convert to array, limit displayed sessions per agent, sort groups by most recent
  return Object.entries(groups)
    .map(([agentId, group]) => ({
      agentId,
      sessions: group.sessions.slice(0, SESSIONS_LIMIT_PER_AGENT),
      totalCount: group.totalCount,
    }))
    .sort((a, b) => {
      const aLatest = a.sessions[0]?._lastAt ? new Date(a.sessions[0]._lastAt).getTime() : 0;
      const bLatest = b.sessions[0]?._lastAt ? new Date(b.sessions[0]._lastAt).getTime() : 0;
      return bLatest - aLatest;
    });
});


function getShortKey(key: string): string {
  // 格式化: agent:main:local:default:direct:UUID -> local:direct:UUID
  const parts = key.split(':');
  // 找到 'local' 的位置，从那里开始保留
  const localIdx = parts.indexOf('local');
  if (localIdx >= 0) {
    return parts.slice(localIdx).join(':');
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
  // 确保 loading 状态可见（请求太快需要模拟延迟）
  await new Promise(r => setTimeout(r, 500));
  try {
    const data = await api.getSessions({ limit: 50 });
    allSessions.value = data.sessions || [];
    // 自动选中第一条会话
    if (allSessions.value.length > 0 && !selectedSessionKey.value) {
      const first = allSessions.value[0];
      selectedSession.value = first;
      selectedSessionKey.value = first.session_key;
      chatPanelRef.value?.fetchMessages();
    }
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

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await fetchAllSessions();
  // 每 30 秒自动刷新会话列表和当前会话消息
  refreshTimer = setInterval(() => {
    fetchAllSessions();
    if (selectedSession.value) {
      chatPanelRef.value?.fetchMessages();
    }
  }, 30000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <div class="sessions-page">
    <PageHeader :title="'会话'" :subtitle="subtitle">
      <el-button circle size="small" :disabled="loading" @click="handleRefresh" title="刷新">
        <el-icon><Refresh /></el-icon>
      </el-button>

      <el-select
        v-model="selectedSessionKey"
        placeholder="选择会话"
        filterable
        :filter-method="(val: string) => { searchQuery = val; }"
        @change="(key: string) => handleSelectSession(key)"
        class="session-selector"
        no-data-text="无匹配会话"
        placeholder-text="选择会话"
        :visible-item-count="12"
        popper-class="session-dropdown"
        placement="bottom-end"
      >
        <template #empty>
          <div class="dropdown-empty">无匹配会话</div>
        </template>

        <el-option-group
          v-for="group in groupedSessions"
          :key="group.agentId"
          :label="group.agentId + ' (' + group.totalCount + ')'"
        >
          <el-option
            v-for="opt in group.sessions"
            :key="opt.value"
            :value="opt.value"
            :label="getShortKey(opt.label)"
          >
            <div class="session-option-inner">
              <span class="option-key">{{ getShortKey(opt.label) }}</span>
              <span class="option-meta">
                <span class="option-count">{{ opt._count }}</span>
                <span class="option-time">{{ formatRelativeTime(opt._lastAt) }}</span>
              </span>
            </div>
          </el-option>
        </el-option-group>
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
  width: 420px;
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
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  min-height: 400px;
  background: var(--el-bg-color);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
  margin-bottom: 12px;
}

.empty-text {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.dropdown-empty {
  padding: 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* Dropdown option styles - with tree indent */
.session-option-inner {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  font-size: 12px;
}

.option-key {
  font-size: 12px;
  font-family: monospace;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  max-width: 300px;
}

.option-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.option-count {
  color: var(--el-color-primary);
  font-weight: 500;
  min-width: 35px;
  text-align: right;
}

.option-time {
  min-width: 45px;
  text-align: right;
}
</style>

<style>
/* Global dropdown popper styles */
.session-dropdown.el-select__dropdown {
  max-height: 70vh !important;
  width: 420px !important;
}

.session-dropdown .el-select-dropdown__wrap {
  max-height: 70vh !important;
  overflow-y: auto !important;
}

.session-dropdown .el-select-dropdown__list {
  padding: 0 !important;
}

.session-dropdown .el-select-dropdown__item {
  margin-left: 30px !important;
  padding: 6px 16px !important;
  height: auto !important;
  min-height: 28px !important;
  line-height: 1.4 !important;
  border-left: 2px solid var(--el-border-color);
}

.session-dropdown .el-select-dropdown__item-group {
  background-color: var(--el-fill-color-light) !important;
  padding: 8px 16px !important;
  font-weight: 600 !important;
  color: var(--el-text-color-primary) !important;
  font-size: 12px !important;
  position: sticky !important;
  top: 0 !important;
  z-index: 10 !important;
}

.session-dropdown .el-select-dropdown__item-group::before {
  content: "👤 " !important;
  margin-right: 4px;
}

.session-dropdown .el-select-dropdown__item.is-selected {
  background-color: var(--el-color-primary-light-9) !important;
  font-weight: 500 !important;
}

.session-dropdown .el-select-dropdown__item.is-disabled {
  display: none !important;
}
</style>
