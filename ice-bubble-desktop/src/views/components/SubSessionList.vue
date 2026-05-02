<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '@/api/client';
import type { SessionDTO } from '@/api/client';
import { gatewayClient } from '@/services/gateway-client';

const router = useRouter();
const route = useRoute();

function parseAgentId(key: string): string {
  const m = key.match(/^agent:([^:]+)/);
  return m ? m[1] : '';
}

function getSessionLabel(s: SessionDTO): string {
  if (s.label) return s.label;
  return s.session_key.split(':').pop() || s.session_key;
}

const sessions = ref<SessionDTO[]>([]);
const currentFilter = ref<string | null>(null);
const allAgents = ref<string[]>([]);
let timer: ReturnType<typeof setInterval> | null = null;
let unsubSessionsChanged: (() => void) | null = null;

const DISPLAY_LIMIT = 15;

function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'running': return '进行中';
    case 'done': return '已完成';
    case 'failed': return '失败';
    case 'timeout': return '超时';
    default: return '';
  }
}

function statusType(status: string | null | undefined): string {
  switch (status) {
    case 'running': return 'primary';
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'timeout': return 'warning';
    default: return 'info';
  }
}

function formatTitle(s: SessionDTO): string {
  return getSessionLabel(s);
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function isActive(key: string): boolean {
  return route.path === `/workspace/${encodeURIComponent(key)}`;
}

async function fetchSessions() {
  try {
    const params: { limit: number; agentId?: string } = { limit: DISPLAY_LIMIT };
    if (currentFilter.value) params.agentId = currentFilter.value;
    const data = await api.getUnifiedSessions(params);
    let list = data.sessions || [];

    // 如果未在服务端过滤，客户端再兜底
    if (!currentFilter.value) {
      list.sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
    }

    sessions.value = list;

    // 收集 agent 列表（仅无过滤时更新）
    if (!currentFilter.value) {
      const agentSet = new Set(list.map(s => s.agent_id).filter(Boolean) as string[]);
      allAgents.value = Array.from(agentSet).sort();
    }
  } catch (e) {
    // 静默失败
  }
}

function setFilter(agent: string | null) {
  currentFilter.value = agent;
  sessions.value = [];
  fetchSessions();
}

function handleClick(session: SessionDTO) {
  router.push(`/workspace/${encodeURIComponent(session.session_key)}`);
}

onMounted(() => {
  fetchSessions();

  // Gateway 实时事件：会话列表变化时立即刷新
  unsubSessionsChanged = gatewayClient.on('sessions.changed', () => {
    fetchSessions();
  });

  // 保留轮询作为降级方案
  timer = setInterval(() => {
    if (!gatewayClient.isConnected) {
      fetchSessions();
    }
  }, 60000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (unsubSessionsChanged) { unsubSessionsChanged(); unsubSessionsChanged = null; }
});
</script>

<template>
  <div class="session-list">
    <div class="session-list-header">
      <span class="session-list-title">会话</span>
    </div>
    <!-- Agent 筛选标签 -->
    <div class="filter-bar">
      <button
        class="filter-tag"
        :class="{ active: !currentFilter }"
        @click="setFilter(null)"
      >全部</button>
      <button
        v-for="agent in allAgents"
        :key="agent"
        class="filter-tag"
        :class="{ active: currentFilter === agent }"
        @click="setFilter(agent)"
      >{{ agent }}</button>
    </div>
    <!-- 会话列表 -->
    <div class="session-list-body">
      <div v-if="sessions.length === 0" class="session-empty">
        暂无会话
      </div>
      <div
        v-for="s in sessions"
        :key="s.session_key"
        class="session-item"
        :class="{ active: isActive(s.session_key) }"
        @click="handleClick(s)"
      >
        <div class="session-item-main">
          <span class="session-item-title">{{ formatTitle(s) }}</span>
          <span class="session-item-sub">
            {{ s.agent_name || parseAgentId(s.session_key) }}
            <template v-if="s.channel"> · {{ s.channel }}</template>
            <template v-if="s.message_count"> · {{ s.message_count }}msg</template>
          </span>
        </div>
        <div class="session-item-meta">
          <el-tag
            v-if="statusLabel(s.session_status)"
            :type="statusType(s.session_status)"
            size="small"
            effect="plain"
            class="session-status"
          >
            {{ statusLabel(s.session_status) }}
          </el-tag>
          <span class="session-time">{{ formatTime(s.updated_at) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.session-list-header {
  padding: 10px 16px 4px;
  flex-shrink: 0;
}

.session-list-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* 筛选标签 */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 10px 8px;
  flex-shrink: 0;
}

.filter-tag {
  padding: 2px 8px;
  font-size: 11px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.filter-tag:hover {
  background: var(--el-fill-color-light);
  color: var(--color-text);
}

.filter-tag.active {
  background: var(--color-accent-blue-subtle);
  color: var(--color-accent-blue);
  font-weight: 500;
}

/* 会话列表 */
.session-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.session-list-body::-webkit-scrollbar {
  width: 4px;
}

.session-list-body::-webkit-track {
  background: transparent;
}

.session-list-body::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, 0.2);
  border-radius: 2px;
}

.session-empty {
  text-align: center;
  padding: 20px 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  font-size: 12px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius, 6px);
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 1px;
}

.session-item:hover {
  background: var(--el-fill-color-light);
}

.session-item.active {
  background: var(--color-accent-blue-subtle, rgba(64, 158, 255, 0.08));
}

.session-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.session-item-title {
  font-size: 13px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.session-item-sub {
  font-size: 11px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.session-time {
  font-size: 11px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  white-space: nowrap;
}
</style>
