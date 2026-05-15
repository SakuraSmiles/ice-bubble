<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Search } from '@element-plus/icons-vue';
import { useNow } from '@/composables/useNow';
import { api } from '@/api/client';
import type { SessionDTO } from '@/api/client';
import { useSessionPreferencesStore } from '@/stores/sessionPreferencesStore';
import { gatewayClient } from '@/services/gateway-client';
import { API_BASE } from '../config';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingSkeleton from './components/LoadingSkeleton.vue';

const prefsStore = useSessionPreferencesStore();

// ====== 数据加载 ======
const allSessions = ref<SessionDTO[]>([]);
const loading = ref(false);
const refreshSpin = ref(false);

let unsubSessionsChanged: (() => void) | null = null;

async function fetchAllSessions() {
  loading.value = true;
  refreshSpin.value = true;
  try {
    const data = await api.getUnifiedSessions({ limit: 200, offset: 0 });
    allSessions.value = data.sessions || [];
  } catch (e) {
    console.error('Failed to load sessions:', e);
  } finally {
    loading.value = false;
    refreshSpin.value = false;
  }
}

// ====== 过滤条件 ======
const filterAgent = ref('');
const filterKeyword = ref('');
const filterTimeRange = ref('all');
const filterStatus = ref('');
const filterMark = ref('all');
const showAdvancedFilter = ref(false);

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

const subtitle = computed(() => `${filteredTotal.value} 条会话`);

// Agent 下拉选项（从全量数据生成）
const agentOptions = computed(() => {
  const ids = new Set(allSessions.value.map(s => s.agent_id).filter(Boolean));
  return Array.from(ids).sort();
});

// ====== 操作 ======
function handlePin(key: string) {
  prefsStore.togglePin(key);
  ElMessage.success({ message: prefsStore.isPinned(key) ? '已置顶' : '已取消置顶', duration: 2000, grouping: true });
}

function handleHide(key: string) {
  prefsStore.toggleHide(key);
  ElMessage.success({ message: '已隐藏', duration: 2000, grouping: true });
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

/** 转义 HTML 特殊字符，防止 XSS */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, ch => map[ch] || ch);
}

/** 对文本做转义后高亮匹配关键词（大小写不敏感） */
function highlightText(text: string, keyword: string): string {
  if (!keyword) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedKw = escapeHtml(keyword);
  // 用正则替换（不区分大小写），保留原始大小写
  const regex = new RegExp(escapedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(regex, m => `<mark>${m}</mark>`);
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
  <div class="sessions-page">
    <PageHeader title="会话" :subtitle="subtitle">
      <el-button circle size="small" :disabled="loading" @click="fetchAllSessions()" title="刷新">
        <el-icon :class="{ spinning: refreshSpin }"><Refresh /></el-icon>
      </el-button>
    </PageHeader>

    <div v-loading="loading" class="content-wrapper">
      <EmptyState
        v-if="pagedSessions.length === 0 && !loading"
        icon="🔍"
        title="没有找到匹配的会话"
        description="尝试调整过滤条件"
      />

      <LoadingSkeleton v-if="pagedSessions.length === 0 && loading" type="list" :rows="6" />

      <template v-if="pagedSessions.length > 0">
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

            <el-button
              :type="showAdvancedFilter ? 'primary' : 'default'"
              size="default"
              class="filter-toggle"
              @click="showAdvancedFilter = !showAdvancedFilter"
            >
              {{ showAdvancedFilter ? '收起筛选' : '更多筛选' }}
            </el-button>
          </div>

          <!-- 高级筛选（折叠） -->
          <div v-if="showAdvancedFilter" class="filter-advanced">
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

        <!-- 会话卡片列表 -->
        <div class="cards-grid">
          <div
            v-for="s in pagedSessions"
            :key="s.session_key"
            class="session-card"
          >
            <div class="session-card-main">
              <div class="session-card-header">
                <div
                  class="session-card-avatar"
                  :style="{ background: s.avatar ? 'transparent' : agentColor(s.agent_id) }"
                >
                  <img v-if="s.avatar" :src="`${API_BASE}/resources/avatars/${s.avatar}`" class="avatar-img" />
                  <template v-else>{{ (s.agent_id || '?').charAt(0).toUpperCase() }}</template>
                </div>
                <div class="session-card-info">
                  <div class="session-card-title" v-html="highlightText(formatTitle(s), filterKeyword)" />
                  <div class="session-card-time">
                    {{ formatTime(s.last_message_at || s.updated_at) }}
                    <span v-if="s.message_count" class="msg-count">· {{ s.message_count }} 条消息</span>
                  </div>
                </div>
              </div>
              <div class="session-card-preview">
                <span v-html="highlightText(truncate(s.last_message, 80) || '暂无消息', filterKeyword)" />
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

        <!-- 分页器 -->
        <div v-if="filteredTotal > pageSize" class="pagination-area">
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :total="filteredTotal"
            layout="total, prev, pager, next"
            small
          />
        </div>
      </template>
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
  padding: 8px 24px 12px;
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
  margin-bottom: 12px;
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

.filter-toggle {
  flex-shrink: 0;
}

.filter-advanced {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border-subtle);
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

/* 会话卡片列表 */
.cards-grid {
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
  border-left: 3px solid transparent;
  border-radius: var(--el-border-radius-base);
  transition: all 200ms ease;
}

.session-card:hover {
  border-color: var(--color-border);
  box-shadow: var(--ib-card-hover-shadow);
  transform: var(--ib-card-hover-lift);
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
  color: var(--color-text-tertiary);
  margin-top: 3px;
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

.session-card-preview :deep(mark),
.session-card-title :deep(mark) {
  background: #fff3bf;
  color: inherit;
  border-radius: 2px;
  padding: 0 2px;
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
  opacity: 0.5;
  transition: all 0.2s ease;
}

.session-card:hover .action-btn {
  opacity: 1;
}

.action-btn:hover {
  background: var(--color-bg-subtle);
}

.action-btn.active {
  opacity: 1;
  background: var(--color-bg-subtle);
}

/* 分页器 */
.pagination-area {
  display: flex;
  justify-content: center;
  padding: 16px 0;
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

@media (max-width: 768px) {
  .filter-agent,
  .filter-keyword,
  .filter-time,
  .filter-status {
    width: 100%;
  }
}
</style>
