<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/client';
import { formatRelativeTime } from '../utils/format';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import type { SessionDTO } from '../api/client.ts';
import LoadingSkeleton from './components/LoadingSkeleton.vue';
import EmptyState from '../components/EmptyState.vue';

const allSessions = ref<SessionDTO[]>([]);
const loading = ref(false);
const refreshSpin = ref(false);
const searchQuery = ref('');
const agentFilter = ref('');
const statusFilter = ref<'all' | 'pinned' | 'hidden'>('all');
const pinnedKeys = ref<Set<string>>(new Set());
const hiddenKeys = ref<Set<string>>(new Set());
const currentPage = ref(1);
const pageSize = ref(20);

// Load pinned/hidden from localStorage
function loadLocalState() {
  try {
    const p = localStorage.getItem('sessions-pinned');
    if (p) pinnedKeys.value = new Set(JSON.parse(p));
    const h = localStorage.getItem('sessions-hidden');
    if (h) hiddenKeys.value = new Set(JSON.parse(h));
  } catch { /* ignore */ }
}

function savePinned() {
  localStorage.setItem('sessions-pinned', JSON.stringify([...pinnedKeys.value]));
}
function saveHidden() {
  localStorage.setItem('sessions-hidden', JSON.stringify([...hiddenKeys.value]));
}

const totalAgents = computed(() => new Set(allSessions.value.map(s => s.agent_id)).size);
const subtitle = computed(() => `共 ${allSessions.value.length} 个会话，${totalAgents.value} 个 Agent`);

// Unique agents for filter dropdown
const agentOptions = computed(() => {
  const ids = new Set(allSessions.value.map(s => s.agent_id));
  return [...ids].sort();
});

// Filtered + searched list
const filteredSessions = computed(() => {
  let list = [...allSessions.value];

  // Agent filter
  if (agentFilter.value) {
    list = list.filter(s => s.agent_id === agentFilter.value);
  }

  // Search
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(s =>
      s.session_key.toLowerCase().includes(q) ||
      s.agent_id.toLowerCase().includes(q) ||
      s.channel.toLowerCase().includes(q)
    );
  }

  // Status filter
  if (statusFilter.value === 'pinned') {
    list = list.filter(s => pinnedKeys.value.has(s.session_key));
  } else if (statusFilter.value === 'hidden') {
    list = list.filter(s => hiddenKeys.value.has(s.session_key));
  }

  // Default exclude hidden (unless explicitly viewing hidden)
  if (statusFilter.value !== 'hidden') {
    list = list.filter(s => !hiddenKeys.value.has(s.session_key));
  }

  // Sort: pinned first, then by last_message_at desc
  list.sort((a, b) => {
    const aPinned = pinnedKeys.value.has(a.session_key) ? 1 : 0;
    const bPinned = pinnedKeys.value.has(b.session_key) ? 1 : 0;
    if (bPinned !== aPinned) return bPinned - aPinned;
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });

  return list;
});

const pagedSessions = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return filteredSessions.value.slice(start, start + pageSize.value);
});

function getShortKey(key: string): string {
  const parts = key.split(':');
  const localIdx = parts.indexOf('local');
  if (localIdx >= 0) return parts.slice(localIdx).join(':');
  return key;
}

function isPinned(key: string) { return pinnedKeys.value.has(key); }
function isHidden(key: string) { return hiddenKeys.value.has(key); }

function togglePin(key: string) {
  if (pinnedKeys.value.has(key)) pinnedKeys.value.delete(key);
  else pinnedKeys.value.add(key);
  savePinned();
}

function toggleHide(key: string) {
  if (hiddenKeys.value.has(key)) hiddenKeys.value.delete(key);
  else hiddenKeys.value.add(key);
  saveHidden();
}

async function fetchAllSessions() {
  loading.value = true;
  refreshSpin.value = true;
  try {
    const data = await api.getSessions({ limit: 200 });
    allSessions.value = data.sessions || [];
  } catch (e: any) {
    ElMessage.error('获取会话列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
    refreshSpin.value = false;
  }
}

async function handleRefresh() {
  await fetchAllSessions();
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  loadLocalState();
  await fetchAllSessions();
  refreshTimer = setInterval(() => fetchAllSessions(), 30000);
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
        <el-icon :class="{ spinning: refreshSpin }"><Refresh /></el-icon>
      </el-button>
    </PageHeader>

    <div v-loading="loading" class="content-wrapper">
      <!-- 过滤栏 -->
      <div class="filter-bar">
        <el-input
          v-model="searchQuery"
          placeholder="搜索会话..."
          clearable
          class="search-input"
          prefix-icon="Search"
        />
        <el-select
          v-model="agentFilter"
          placeholder="全部 Agent"
          clearable
          class="filter-select"
        >
          <el-option
            v-for="agent in agentOptions"
            :key="agent"
            :label="agent"
            :value="agent"
          />
        </el-select>
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="pinned">已置顶</el-radio-button>
          <el-radio-button value="hidden">已隐藏</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 空状态 -->
      <EmptyState v-if="filteredSessions.length === 0 && !loading" icon="💬" :title="searchQuery || agentFilter || statusFilter !== 'all' ? '无匹配会话' : '暂无会话'" />

      <!-- 加载骨架屏 -->
      <div v-if="filteredSessions.length === 0 && loading" class="loading-skeleton-area">
        <LoadingSkeleton type="list" :rows="8" />
      </div>

      <!-- 会话表格 -->
      <el-table
        v-if="pagedSessions.length > 0"
        :data="pagedSessions"
        class="session-table"
        :header-cell-style="{ background: 'transparent', color: 'var(--el-text-color-secondary)', fontWeight: 500 }"
        :row-class-name="(data: any) => isPinned(data.row?.session_key) ? 'pinned-row' : ''"
      >
        <el-table-column label="会话" min-width="300" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="session-key-cell">
              <span v-if="isPinned(row.session_key)" class="pin-indicator" title="已置顶">📌</span>
              <span class="session-key">{{ getShortKey(row.session_key) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="agent-id">{{ row.agent_id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="渠道" min-width="80" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="channel-text">{{ row.channel }}</span>
          </template>
        </el-table-column>
        <el-table-column label="消息数" width="90" align="right">
          <template #default="{ row }">
            <span class="msg-count">{{ row.message_count ?? 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最后活动" width="120" align="right">
          <template #default="{ row }">
            <span class="last-active">{{ formatRelativeTime(row.last_message_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center" fixed="right">
          <template #default="{ row }">
            <div class="action-buttons">
              <el-tooltip :content="isPinned(row.session_key) ? '取消置顶' : '置顶'" placement="top">
                <el-button
                  link
                  size="small"
                  @click.stop="togglePin(row.session_key)"
                  :class="{ 'is-active': isPinned(row.session_key) }"
                >
                  📌
                </el-button>
              </el-tooltip>
              <el-tooltip :content="isHidden(row.session_key) ? '取消隐藏' : '隐藏'" placement="top">
                <el-button
                  link
                  size="small"
                  @click.stop="toggleHide(row.session_key)"
                  :class="{ 'is-active': isHidden(row.session_key) }"
                >
                  👁️
                </el-button>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div v-if="filteredSessions.length > pageSize" class="pagination-wrapper">
        <el-pagination
          v-model:current-page="currentPage"
          :page-size="pageSize"
          :total="filteredSessions.length"
          layout="total, prev, pager, next"
          small
          background
        />
      </div>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.sessions-page {
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.content-wrapper {
  flex: 1;
  min-height: 0;
  padding: 8px 24px 0;
  overflow-y: auto;
}

.content-wrapper::-webkit-scrollbar {
  width: 6px;
}
.content-wrapper::-webkit-scrollbar-track {
  background: transparent;
}
.content-wrapper::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, 0.3);
  border-radius: 3px;
}
.content-wrapper::-webkit-scrollbar-thumb:hover {
  background: rgba(144, 147, 153, 0.5);
}

/* 过滤栏 */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.search-input {
  width: 280px;
}

.filter-select {
  width: 180px;
}

/* 表格 */
.session-table {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: transparent;
  --el-table-row-hover-bg-color: var(--el-fill-color-light);
  --el-table-border-color: var(--el-border-color);
  --el-table-text-color: var(--el-text-color-primary);
  --el-table-header-text-color: var(--el-text-color-secondary);
  width: 100%;
}

.session-table :deep(.el-table__body-wrapper::-webkit-scrollbar) {
  width: 6px;
}
.session-table :deep(.el-table__body-wrapper::-webkit-scrollbar-thumb) {
  background: rgba(144, 147, 153, 0.3);
  border-radius: 3px;
}

.session-key-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pin-indicator {
  flex-shrink: 0;
  font-size: 12px;
}

.session-key {
  font-family: var(--font-exo2);
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.agent-id {
  font-family: var(--font-exo2);
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.channel-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.msg-count {
  font-family: var(--font-exo2);
  font-size: 13px;
  font-weight: 500;
  color: var(--el-color-primary);
}

.last-active {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: var(--font-exo2);
}

.action-buttons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.action-buttons .el-button {
  font-size: 16px;
  padding: 4px;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.action-buttons .el-button:hover,
.action-buttons .el-button.is-active {
  opacity: 1;
}

.pinned-row {
  background: var(--el-fill-color-lighter) !important;
}

/* 分页 */
.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0;
}

/* 骨架屏 */
.loading-skeleton-area {
  padding: 16px;
}

/* 刷新按钮旋转动画 */
:deep(.spinning) {
  animation: spin 0.5s linear;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
