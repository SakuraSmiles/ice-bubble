<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useNow } from '@/composables/useNow';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import type { SessionDTO } from '@/api/client';
import { useSessionPreferencesStore } from '@/stores/sessionPreferencesStore';
import { gatewayClient } from '@/services/gateway-client';

const router = useRouter();
const prefsStore = useSessionPreferencesStore();

// ====== 数据加载 ======
const allSessions = ref<SessionDTO[]>([]);
const loading = ref(false);

let unsubSessionsChanged: (() => void) | null = null;

async function fetchAllSessions() {
  loading.value = true;
  try {
    const data = await api.getUnifiedSessions({ limit: 10000, offset: 0 });
    allSessions.value = data.sessions || [];
  } catch (e) {
    console.error('Failed to load sessions:', e);
  } finally {
    loading.value = false;
  }
}

// ====== 过滤条件 ======
const filterAgent = ref('');
const filterKeyword = ref('');
const filterTimeRange = ref('all');
const filterStatus = ref('');
const filterMark = ref('all');

// ====== 客户端过滤 ======
const filteredSessions = computed(() => {
  const now = Date.now();
  return allSessions.value.filter(s => {
    // Agent 过滤
    if (filterAgent.value && s.agent_id !== filterAgent.value) return false;

    // 关键词过滤
    if (filterKeyword.value) {
      const kw = filterKeyword.value.toLowerCase();
      const title = s.label || s.agent_name || '';
      const lastMsg = s.last_message || '';
      if (!title.toLowerCase().includes(kw) && !lastMsg.toLowerCase().includes(kw)) return false;
    }

    // 时间范围过滤
    if (filterTimeRange.value !== 'all') {
      const ts = s.updated_at || s.last_message_at || s.created_at;
      if (!ts) return false;
      const sessionTime = new Date(ts).getTime();
      let cutoff: number;
      switch (filterTimeRange.value) {
        case 'today':
          cutoff = new Date().setHours(0, 0, 0, 0);
          break;
        case '7days':
          cutoff = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case '30days':
          cutoff = now - 30 * 24 * 60 * 60 * 1000;
          break;
        default:
          cutoff = 0;
      }
      if (sessionTime < cutoff) return false;
    }

    // 会话状态过滤
    if (filterStatus.value) {
      if (filterStatus.value === 'active') {
        if (s.session_status === 'completed') return false;
      } else if (filterStatus.value === 'completed') {
        if (s.session_status !== 'completed') return false;
      }
    }

    // 标记筛选
    if (filterMark.value === 'pinned') {
      if (!prefsStore.isPinned(s.session_key)) return false;
    } else if (filterMark.value === 'hidden') {
      if (!prefsStore.isHidden(s.session_key)) return false;
    }

    // 隐藏的会话只在"已隐藏"筛选时显示
    if (filterMark.value !== 'hidden' && prefsStore.isHidden(s.session_key)) return false;

    return true;
  });
});

// ====== 分页 ======
const currentPage = ref(1);
const pageSize = ref(20);
const pageSizes = [20, 50, 100] as const;
void pageSizes; // used in template



// 过滤条件变化时重置到第 1 页
watch([filterAgent, filterKeyword, filterTimeRange, filterStatus, filterMark], () => {
  currentPage.value = 1;
});

// ====== 排序（时间倒序）======
const sortedSessions = computed(() => {
  return [...filteredSessions.value].sort((a, b) => {
    const ta = a.last_message_at || a.updated_at || a.created_at;
    const tb = b.last_message_at || b.updated_at || b.created_at;
    return new Date(tb).getTime() - new Date(ta).getTime();
  });
});

// ====== 分页（基于排序后数据）======
const pagedSessions = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return sortedSessions.value.slice(start, start + pageSize.value);
});

const filteredTotal = computed(() => sortedSessions.value.length);

// Agent 下拉选项（从全量数据生成）
const agentOptions = computed(() => {
  const ids = new Set(allSessions.value.map(s => s.agent_id).filter(Boolean));
  return Array.from(ids).sort();
});

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



// ====== 生命周期 ======
onMounted(async () => {
  if (!prefsStore.loaded) {
    await prefsStore.fetchPreferences();
  }
  await fetchAllSessions();

  unsubSessionsChanged = gatewayClient.on('sessions.changed', () => {
    fetchAllSessions();
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
      <span class="session-count">{{ filteredTotal }} 条会话</span>
    </div>

    <!-- 过滤栏 -->
    <div class="filter-bar">
      <div class="filter-row">
        <el-select
          v-model="filterAgent"
          placeholder="全部 Agent"
          clearable
          class="filter-item filter-agent"
        >
          <el-option
            v-for="id in agentOptions"
            :key="id"
            :label="id"
            :value="id"
          />
        </el-select>

        <el-input
          v-model="filterKeyword"
          placeholder="搜索标题或消息内容…"
          clearable
          class="filter-item filter-keyword"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-select
          v-model="filterTimeRange"
          placeholder="时间范围"
          class="filter-item filter-time"
        >
          <el-option label="全部" value="all" />
          <el-option label="今天" value="today" />
          <el-option label="最近7天" value="7days" />
          <el-option label="最近30天" value="30days" />
        </el-select>

        <el-select
          v-model="filterStatus"
          placeholder="会话状态"
          clearable
          class="filter-item filter-status"
        >
          <el-option label="活跃" value="active" />
          <el-option label="已完成" value="completed" />
        </el-select>

        <el-radio-group v-model="filterMark" class="filter-item filter-mark" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="pinned">已置顶</el-radio-button>
          <el-radio-button value="hidden">已隐藏</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 会话列表 -->
    <div class="all-sessions-body">
      <template v-if="pagedSessions.length > 0">
              <div
                v-for="s in pagedSessions"
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
      </template>

      <div v-else-if="!loading" class="empty-result">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">没有找到匹配的会话</div>
        <div class="empty-hint">尝试调整过滤条件</div>
      </div>

      <div v-if="loading" class="loading-indicator">加载中...</div>
    </div>

    <!-- 分页器 -->
    <div v-if="filteredTotal > 0" class="pagination-wrapper">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="pageSizes"
        :total="filteredTotal"
        layout="total, sizes, prev, pager, next, jumper"
        background
        small
      />
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

/* 过滤栏 */
.filter-bar {
  flex-shrink: 0;
  padding: 12px 24px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-canvas);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.filter-item {
  flex-shrink: 0;
}

.filter-agent {
  width: 160px;
}

.filter-keyword {
  width: 220px;
}

.filter-time {
  width: 130px;
}

.filter-status {
  width: 120px;
}

.filter-mark {
  flex-shrink: 1;
}

/* 会话列表 */
.all-sessions-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.all-sessions-body::-webkit-scrollbar {
  width: 6px;
}

.all-sessions-body::-webkit-thumb {
  background: rgba(144, 147, 153, 0.2);
  border-radius: 3px;
}

/* 空结果 */
.empty-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--color-text-tertiary, var(--color-text-secondary));
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.6;
}

.empty-text {
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 13px;
  opacity: 0.7;
}

/* 会话卡片 */
.all-sessions-body > .session-card + .session-card {
  margin-top: 6px;
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

/* 分页器 */
.pagination-wrapper {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--color-border-subtle);
}

@media (max-width: 768px) {
  .filter-agent,
  .filter-keyword,
  .filter-time,
  .filter-status {
    width: 100%;
  }
}
</style>
