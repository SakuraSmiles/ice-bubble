<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useNow } from '@/composables/useNow';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import type { SessionDTO } from '@/api/client';
import { useSessionPreferencesStore } from '@/stores/sessionPreferencesStore';
import { gatewayClient } from '@/services/gateway-client';

const router = useRouter();
const prefsStore = useSessionPreferencesStore();

const allSessions = ref<SessionDTO[]>([]); // for filtering
const loading = ref(false);
const collapsedAgents = ref<Set<string>>(new Set());
const offset = ref(0);
const total = ref(0);
const PAGE_SIZE = 50;

let unsubSessionsChanged: (() => void) | null = null;

// ====== 按 agent 分组 ======
const agentGroups = computed(() => {
  const visible = allSessions.value.filter(s => !prefsStore.isHidden(s.session_key));
  const map = new Map<string, SessionDTO[]>();
  for (const s of visible) {
    const agentId = s.agent_id || 'unknown';
    const list = map.get(agentId) || [];
    list.push(s);
    map.set(agentId, list);
  }
  // Sort each group by time
  for (const [, list] of map) {
    list.sort((a, b) => {
      const ta = a.updated_at || a.last_message_at || a.created_at;
      const tb = b.updated_at || b.last_message_at || b.created_at;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
  }
  return map;
});

const agentIds = computed(() => {
  // Sort agents: pinned sessions' agents first, then by latest message time
  return Array.from(agentGroups.value.keys()).sort((a, b) => {
    const aList = agentGroups.value.get(a) || [];
    const bList = agentGroups.value.get(b) || [];
    const aTime = aList[0]?.last_message_at || aList[0]?.updated_at || '';
    const bTime = bList[0]?.last_message_at || bList[0]?.updated_at || '';
    return new Date(bTime).getTime() - new Date(aTime).getTime();
  });
});

// ====== 加载更多 ======
async function loadMore() {
  if (loading.value) return;
  if (offset.value >= total.value && allSessions.value.length > 0) return;
  loading.value = true;
  try {
    const data = await api.getUnifiedSessions({ limit: PAGE_SIZE, offset: offset.value });
    const list = data.sessions || [];
    allSessions.value = offset.value === 0 ? list : [...allSessions.value, ...list];
    total.value = data.total || 0;
    offset.value += list.length;
  } catch (e) {
    console.error('Failed to load sessions:', e);
  } finally {
    loading.value = false;
  }
}

// ====== 操作 ======
function handlePin(key: string) {
  prefsStore.togglePin(key);
}

function handleHide(key: string) {
  prefsStore.toggleHide(key);
}

function handleClick(s: SessionDTO) {
  router.push(`/workspace/${encodeURIComponent(s.session_key)}`);
}

function goBack() {
  router.back();
}

// ====== 辅助 ======
function formatTitle(s: SessionDTO): string {
  if (s.label) return s.label;
  if (s.agent_name) return s.agent_name;
  const parts = s.session_key.split(':');
  const last = parts[parts.length - 1];
  if (/^[0-9a-f]{8}-/i.test(last)) {
    return parts.slice(1, parts.length - 1).join(':') || '未知';
  }
  return parts.slice(1).join(':') || s.session_key;
}

const nowRef = useNow();

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const diffMs = nowRef.value - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function agentColor(agentId: string): string {
  const colors = [
    '#4CAF50', '#2196F3', '#FF9800', '#9C27B0',
    '#F44336', '#00BCD4', '#795548', '#607D8B',
    '#E91E63', '#3F51B5', '#009688', '#FF5722',
  ];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function toggleAgent(agentId: string) {
  if (collapsedAgents.value.has(agentId)) {
    collapsedAgents.value.delete(agentId);
  } else {
    collapsedAgents.value.add(agentId);
  }
}

// ====== 滚动加载 ======
function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
    loadMore();
  }
}

// ====== 生命周期 ======
onMounted(async () => {
  if (!prefsStore.loaded) {
    await prefsStore.fetchPreferences();
  }
  await loadMore();

  unsubSessionsChanged = gatewayClient.on('sessions.changed', () => {
    offset.value = 0;
    loadMore();
  });
});

onUnmounted(() => {
  if (unsubSessionsChanged) { unsubSessionsChanged(); unsubSessionsChanged = null; }
});
</script>

<template>
  <div class="all-sessions">
    <!-- 顶部导航 -->
    <div class="all-sessions-header">
      <button class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </button>
      <h2 class="page-title">📋 全部会话</h2>
      <span class="session-count">{{ allSessions.length }} / {{ total || allSessions.length }}</span>
    </div>

    <!-- 会话列表 -->
    <div class="all-sessions-body" @scroll="onScroll">
      <template v-for="agentId in agentIds" :key="agentId">
        <div class="agent-group">
          <div class="agent-group-header" @click="toggleAgent(agentId)">
            <el-icon class="agent-arrow" :class="{ collapsed: collapsedAgents.has(agentId) }">
              <ArrowRight />
            </el-icon>
            <div
              class="agent-group-avatar"
              :style="{ background: agentColor(agentId) }"
            >
              {{ agentId.charAt(0).toUpperCase() }}
            </div>
            <span class="agent-group-name">{{ agentId }}</span>
            <span class="agent-group-count">{{ (agentGroups.get(agentId) || []).length }}</span>
          </div>

          <div v-show="!collapsedAgents.has(agentId)" class="agent-group-sessions">
            <div
              v-for="s in agentGroups.get(agentId) || []"
              :key="s.session_key"
              class="session-card"
              @click="handleClick(s)"
            >
              <div class="session-card-main">
                <div class="session-card-header">
                  <div
                    class="session-card-avatar"
                    :style="{ background: s.avatar ? 'transparent' : agentColor(s.agent_id) }"
                  >
                    <img v-if="s.avatar" :src="`/api/resources/avatars/${s.avatar}`" class="avatar-img" />
                    <template v-else>{{ (s.agent_id || '?').charAt(0).toUpperCase() }}</template>
                  </div>
                  <div class="session-card-info">
                    <div class="session-card-title">{{ formatTitle(s) }}</div>
                    <div class="session-card-time">
                      {{ formatTime(s.last_message_at || s.updated_at) }}
                      <span v-if="s.message_count" class="msg-count">· {{ s.message_count }} 条消息</span>
                    </div>
                  </div>
                </div>
                <div class="session-card-preview">
                  {{ truncate(s.last_message, 80) || '暂无消息' }}
                </div>
              </div>
              <div class="session-card-actions" @click.stop>
                <button
                  class="action-btn"
                  :class="{ active: prefsStore.isPinned(s.session_key) }"
                  :title="prefsStore.isPinned(s.session_key) ? '取消置顶' : '置顶到侧栏'"
                  @click="handlePin(s.session_key)"
                >
                  📌
                </button>
                <button
                  class="action-btn"
                  :class="{ active: prefsStore.isHidden(s.session_key) }"
                  :title="prefsStore.isHidden(s.session_key) ? '取消隐藏' : '隐藏会话'"
                  @click="handleHide(s.session_key)"
                >
                  🚫
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="loading" class="loading-indicator">加载中...</div>
      <div v-else-if="offset >= total && allSessions.length > 0" class="loading-indicator end">
        已加载全部 {{ total }} 条会话
      </div>
    </div>
  </div>
</template>

<style scoped>
.all-sessions {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.all-sessions-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 6px);
  background: var(--color-bg-canvas);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.back-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--color-text);
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.session-count {
  font-size: 13px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  margin-left: auto;
}

.all-sessions-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.all-sessions-body::-webkit-scrollbar {
  width: 6px;
}

.all-sessions-body::-webkit-thumb {
  background: rgba(144, 147, 153, 0.2);
  border-radius: 3px;
}

/* Agent 分组 */
.agent-group {
  margin-bottom: 20px;
}

.agent-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius, 6px);
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;
}

.agent-group-header:hover {
  background: var(--el-fill-color-light);
}

.agent-arrow {
  transition: transform 0.2s;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.agent-arrow.collapsed {
  transform: rotate(-90deg);
}

.agent-group-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}

.agent-group-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.agent-group-count {
  font-size: 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
}

/* 会话卡片 */
.agent-group-sessions {
  padding-left: 8px;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-card {
  display: flex;
  align-items: stretch;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius, 8px);
  cursor: pointer;
  transition: all 0.15s;
}

.session-card:hover {
  border-color: var(--color-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.session-card-main {
  flex: 1;
  min-width: 0;
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.session-card-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  overflow: hidden;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.session-card-info {
  min-width: 0;
  flex: 1;
}

.session-card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-card-time {
  font-size: 12px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
  margin-top: 2px;
}

.msg-count {
  margin-left: 6px;
}

.session-card-preview {
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.5;
}

/* 操作按钮 */
.session-card-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  flex-shrink: 0;
}

.action-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.15s;
}

.session-card:hover .action-btn {
  opacity: 1;
}

.action-btn:hover {
  background: var(--el-fill-color-light);
}

.action-btn.active {
  opacity: 1;
  background: var(--el-fill-color-light);
}

/* 加载指示 */
.loading-indicator {
  text-align: center;
  padding: 20px;
  font-size: 13px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
}

.loading-indicator.end {
  color: var(--color-text-tertiary);
}
</style>
