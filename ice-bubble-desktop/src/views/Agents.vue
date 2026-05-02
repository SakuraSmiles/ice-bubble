<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { formatTime, formatRelativeTime, truncatePath, formatNumber } from '../utils/format';
import { api, AgentWithActivityDTO } from '../api/client';
import AppFooter from '../components/AppFooter.vue';
import PageHeader from '../components/PageHeader.vue';
import LoadingSkeleton from './components/LoadingSkeleton.vue';
import EmptyState from '../components/EmptyState.vue';

interface ActivityDay {
  date: string;
  count: number;
}

const agents = ref<AgentWithActivityDTO[]>([]);
const loading = ref(false);
const refreshSpin = ref(false);
const totalAgents = ref(0);
const totalSessions = ref(0);
const totalMessages = ref(0);
// agentId → ActivityDay[]
const activityMap = ref<Record<string, ActivityDay[]>>({});

/** 将统一状态映射为 el-tag type */
function getStatusTagType(status: string): string {
  switch (status) {
    case '工作':
    case '活跃': return 'success';
    case '休假':  return 'warning';
    case '失联':  return 'danger';
    default:     return 'info';
  }
}


function getTokenTrend(agent: AgentWithActivityDTO): { text: string; class: string } {
  if (!agent.todayTokenStats || !agent.yesterdayTokenStats) return { text: '', class: '' };
  const today = agent.todayTokenStats.total_tokens_input + agent.todayTokenStats.total_tokens_output;
  const yesterday = agent.yesterdayTokenStats.total_tokens_input + agent.yesterdayTokenStats.total_tokens_output;
  if (yesterday <= 0) return { text: '', class: '' };
  const diff = today - yesterday;
  const sign = diff >= 0 ? '+' : '-';
  const className = diff >= 0 ? 'trend-up' : 'trend-down';
  return { text: `${sign}${formatNumber(Math.abs(diff))}`, class: className };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let heavyDataTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 计算动态热力图阈值（基于百分位数）
 * 返回 [t1-t5]，将数据分为6个等级
 * level-0: count = 0
 * level-1 ~ level-5: 基于 P16, P33, P50, P66, P83 划分
 */
function getDynamicThresholds(activity: ActivityDay[]): number[] {
  // 只统计有活动的日期（count > 0）
  const counts = activity
    .map(d => d.count)
    .filter(c => c > 0);
  
  if (counts.length < 6) {
    // 数据太少，使用固定阈值（6档等分）
    const max = Math.max(...counts, 1);
    const step = max / 6;
    return [1, 2, 3, 4, 5].map(i => Math.floor(step * i));
  }
  
  // 排序
  const sorted = [...counts].sort((a, b) => a - b);
  const n = sorted.length;
  
  // 计算百分位数：P16, P33, P50, P66, P83
  const p16 = sorted[Math.floor(n * 0.166)];
  const p33 = sorted[Math.floor(n * 0.333)];
  const p50 = sorted[Math.floor(n * 0.5)];
  const p66 = sorted[Math.floor(n * 0.666)];
  const p83 = sorted[Math.floor(n * 0.833)];
  
  // 返回阈值：[level-1上限, level-2上限, ..., level-5上限]
  return [p16, p33, p50, p66, p83];
}

/**
 * 根据动态阈值获取热力图等级 (0-5)
 */
function getActivityLevel(count: number, thresholds: number[]): number {
  if (count === 0) return 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (count <= thresholds[i]) return i + 1;
  }
  return 5;
}

// 计算属性：所有 agent 的热力图阈值（动态百分位）
const heatmapThresholdsMap = computed(() => {
  const result: Record<string, number[]> = {};
  for (const agentId of Object.keys(activityMap.value)) {
    const activity = activityMap.value[agentId] || [];
    result[agentId] = getDynamicThresholds(activity);
  }
  return result;
});

// 计算属性：所有 agent 的热力图网格数据（解决响应式问题）
const heatmapGridMap = computed(() => {
  const result: Record<string, ActivityDay[][]> = {};
  for (const agentId of Object.keys(activityMap.value)) {
    const activity = activityMap.value[agentId] || [];
    const activityByDate = new Map(activity.map(a => [a.date, a.count]));
    const today = new Date();
    const grid: ActivityDay[][] = [];
    
    // 计算今天的列位置：col 0=周日, col 6=周六
    const todayCol = (today.getDay() + 6) % 7; // 周一→6, 周二→5, ..., 周六→0
    
    for (let row = 0; row < 5; row++) {
      const week: ActivityDay[] = [];
      for (let col = 0; col < 7; col++) {
        // 今天所在的列永远 col 6，通过相对位置计算其他列
        const daysAgo = row * 7 + (todayCol - col);
        if (daysAgo < 0) {
          week.push({ date: '', count: -1 });
        } else {
          const d = new Date(today);
          d.setDate(d.getDate() - daysAgo);
          // 使用本地日期，避免 toISOString() 在凌晨时区问题
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          const dateStr = `${y}-${m}-${day}`;
          week.push({ date: dateStr, count: activityByDate.get(dateStr) ?? 0 });
        }
      }
      grid.push(week);
    }
    result[agentId] = grid;
  }
  return result;
});

// 热力图 tooltip 状态
const tooltipState = ref({
  visible: false,
  x: 0,
  y: 0,
  date: '',
  count: 0
});

function showTooltip(event: MouseEvent, day: ActivityDay, agentId: string) {
  if (day.date === '') return;
  // 实时从 activityMap 获取最新数据
  const activity = activityMap.value[agentId] || [];
  const latestCount = activity.find(a => a.date === day.date)?.count ?? 0;
  tooltipState.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    date: day.date,
    count: latestCount
  };
}

function hideTooltip() {
  tooltipState.value.visible = false;
}

/**
 * 静默更新 agents 基本信息（无 loading 动画）
 * 用于 30s 定时器，避免频繁打断用户操作
 */
async function fetchAgentsBasic() {
  try {
    const data = await api.getAgents();
    const newAgents = data.agents || [];

    // 合并更新：保留现有的 activity、token_stats 等字段
    const merged = newAgents.reduce((map, a) => {
      const existing = agents.value.find(ex => ex.agent_id === a.agent_id);
      map[a.agent_id] = existing ? { ...existing, ...a, activity: existing.activity } : { ...a, activity: [] };
      return map;
    }, {} as Record<string, AgentWithActivityDTO>);

    agents.value = Object.values(merged);
    totalAgents.value = data.count || 0;
    totalSessions.value = agents.value.reduce((sum, a) => sum + (a.session_count || 0), 0);
    totalMessages.value = agents.value.reduce((sum, a) => sum + (a.message_count || 0), 0);
  } catch (e: any) {
    console.warn('[Agents] 静默更新失败:', e.message);
  }
}

/**
 * 批量获取所有 agent 的活动热力图数据（使用新的批量接口）
 */
async function fetchActivity(days = 90) {
  try {
    const data = await api.getAgentsWithActivity(days);
    const newMap: Record<string, ActivityDay[]> = {};
    for (const agent of (data.agents || [])) {
      newMap[agent.agent_id] = agent.activity || [];
    }
    activityMap.value = newMap;
  } catch (e: any) {
    console.warn('[Agents] 获取热力图数据失败:', e.message);
  }
}

/**
 * 获取 Token 统计数据（今日 + 昨日）
 */
async function fetchTokenStats() {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // 计算昨天的日期
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // 并行获取：今日数据 + 昨日数据
    const [todayRes, yesterdayRes] = await Promise.all([
      api.getTokenSummary(undefined, today),
      api.getTokenSummary(undefined, yesterdayStr)
    ]);

    // 构建 map 便于快速查找
    const todayMap = new Map(todayRes.summary.map(s => [s.agent_id, s]));
    const yesterdayMap = new Map(yesterdayRes.summary.map(s => [s.agent_id, s]));

    // 填充到 agents
    for (const agent of agents.value) {
      const todayStats = todayMap.get(agent.agent_id);
      const yesterdayStats = yesterdayMap.get(agent.agent_id);

      // token_stats: 总览数据（用于显示主数据，即今日）
      agent.token_stats = todayStats ? {
        agent_id: todayStats.agent_id,
        total_tokens_input: todayStats.total_tokens_input,
        total_tokens_output: todayStats.total_tokens_output,
        total_cost: todayStats.total_cost,
        cost_input: todayStats.cost_input,
        cost_output: todayStats.cost_output,
        message_count: todayStats.message_count
      } : null;

      // todayTokenStats: 今日数据
      agent.todayTokenStats = todayStats ? {
        agent_id: todayStats.agent_id,
        total_tokens_input: todayStats.total_tokens_input,
        total_tokens_output: todayStats.total_tokens_output,
        total_cost: todayStats.total_cost,
        cost_input: todayStats.cost_input,
        cost_output: todayStats.cost_output,
        message_count: todayStats.message_count
      } : null;

      // yesterdayTokenStats: 昨日数据
      agent.yesterdayTokenStats = yesterdayStats ? {
        agent_id: yesterdayStats.agent_id,
        total_tokens_input: yesterdayStats.total_tokens_input,
        total_tokens_output: yesterdayStats.total_tokens_output,
        total_cost: yesterdayStats.total_cost,
        cost_input: yesterdayStats.cost_input,
        cost_output: yesterdayStats.cost_output,
        message_count: yesterdayStats.message_count
      } : null;
    }
  } catch (e: any) {
    console.warn('[Agents] 获取 Token 统计失败:', e.message);
  }
}

/**
 * 完整初始化/刷新：agents + activity + loading 动画
 */
async function fetchAll(withActivity = true) {
  loading.value = true;
  refreshSpin.value = true;
  try {
    await fetchAgentsBasic();
    if (withActivity) {
      await Promise.all([fetchActivity(), fetchTokenStats()]);
    }
  } finally {
    loading.value = false;
    refreshSpin.value = false;
  }
}

function getAvatarUrl(avatar: string | null): string | null {
  if (!avatar) return null;
  return `/api/resources/avatars/${avatar}`;
}

function startTimers() {
  // 30秒：静默刷新基础数据（agents基本信息，不触发loading）
  refreshTimer = setInterval(() => fetchAgentsBasic(), 30000);

  // 5分钟：刷新重型数据（activity热力图 + token统计，不触发loading）
  heavyDataTimer = setInterval(() => {
    Promise.all([fetchActivity(), fetchTokenStats()]);
  }, 300000);  // 5分钟 = 300秒
}

onMounted(async () => {
  await fetchAll(true);
  startTimers();
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (heavyDataTimer) {
    clearInterval(heavyDataTimer);
    heavyDataTimer = null;
  }
});

const subtitle = computed(() => `${totalAgents.value} 个成员，${totalSessions.value} 个会话，${totalMessages.value} 条消息`);
</script>

<template>
  <div class="agents-page">
    <PageHeader title="成员" :subtitle="subtitle">
      <el-button circle size="small" :disabled="loading" @click="fetchAll(true)" title="刷新">
        <el-icon :class="{ spinning: refreshSpin }"><Refresh /></el-icon>
      </el-button>
    </PageHeader>

    <div v-loading="loading" class="content-wrapper">
        <EmptyState v-if="agents.length === 0 && !loading" title="暂无成员" icon="👤" />

        <!-- 加载骨架屏：成员卡片骨架 -->
        <div v-if="agents.length === 0 && loading" class="loading-skeleton-area">
          <LoadingSkeleton type="card" :rows="1" height="140px" v-for="i in 4" :key="i" />
        </div>

        <div v-if="agents.length > 0" class="cards-grid">
        <el-card v-for="agent in agents" :key="agent.agent_id" class="agent-card">
          <div class="card-content">
          <!-- 左侧信息 -->
          <div class="agent-left">
            <div class="agent-avatar-wrapper">
              <div class="agent-avatar">
                <el-avatar v-if="getAvatarUrl(agent.avatar)"
                  :size="88"
                  :src="getAvatarUrl(agent.avatar)!"
                  fit="cover"
                  class="agent-avatar"
                >
                </el-avatar>
                <el-avatar v-else
                  :size="88"
                  fit="cover"
                  class="agent-avatar"
                  style="color: var(--color-accent-blue);"
                >
                  {{ agent.agent_id.substring(0, 1).toUpperCase() }}
                </el-avatar>
              </div>
              <!-- GitHub 风格状态指示器 -->
              <el-tag :type="getStatusTagType(agent.status)" size="small" effect="plain" class="avatar-status">
                {{ agent.status }}
              </el-tag>
            </div>
            <div class="agent-name">
              <span class="name-text">{{ agent.agent_name || agent.agent_id }}</span>
            </div>
            <div class="agent-model">
              <span class="model-value">{{ agent.model || '-' }}</span>
            </div>
          </div>

          <!-- 中间统计 + 热力图 整体 -->
          <div class="agent-middle">
          <!-- 中间统计 -->
          <div class="agent-stats">
            <div class="agent-workspace">
              <span class="workspace-value">{{ truncatePath(agent.workspace) }}</span>
            </div>
            <div class="stat-row">
              <div class="stat-item">
                <div class="stat-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M14 1a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1h12zM2 0a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V2a2 2 0 00-2-2H2z"/>
                  <path d="M3 4h10v1H3V4zm0 3h10v1H3V7zm0 3h7v1H3v-1z"/>
                </svg>
              </div>
              <div class="stat-content">
                <span class="stat-value">{{ agent.message_count }}</span>
                <span class="stat-label">消息</span>
                <div class="token-breakdown">
                  <span>({{ agent.session_count }} 会话)</span>
                </div>
              </div>
            </div>
            <div class="stat-item" v-if="agent.todayTokenStats">
              <div class="stat-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M8 4v8M6 6.5c0-1.1.9-2 2-2s2 .9 2 2c0 1.1-.9 2-2 2s-2 .9-2 2 1 2 2 2"/>
                </svg>
              </div>
              <div class="stat-content">
                <div class="token-main-row">
                  <span class="stat-value token-cost-value">{{ formatNumber(agent.todayTokenStats.total_tokens_input + agent.todayTokenStats.total_tokens_output) }}</span>
                  <span class="token-trend" :class="getTokenTrend(agent).class">{{ getTokenTrend(agent).text }}</span>
                </div>
                <span class="stat-label">Tokens</span>
                <div class="token-breakdown">
                  <span>↓ {{ formatNumber(agent.todayTokenStats.total_tokens_input) }}</span>
                  <span>↑ {{ formatNumber(agent.todayTokenStats.total_tokens_output) }}</span>
                </div>
              </div>
            </div>
            </div>
            <div class="source-row">
              <span class="source-label">来源</span>
              <span class="source-value">{{ agent.source }}</span>
            </div>
          </div>



          <!-- 活动热力图 -->
          <div class="agent-heatmap">
            <div class="heatmap-grid">
              <div
                v-for="(week, wi) in (heatmapGridMap[agent.agent_id] || [])"
                :key="wi"
                class="heatmap-week"
              >
                <div
                  v-for="(day, di) in week"
                  :key="di"
                  :class="['heatmap-cell', 'level-' + (day.count < 0 ? -1 : getActivityLevel(day.count, heatmapThresholdsMap[agent.agent_id] || [0,2,5,10,20]))]"
                  @mouseenter="showTooltip($event, day, agent.agent_id)"
                  @mouseleave="hideTooltip"
                  :data-count="day.count"
                ></div>
              </div>
            </div>
          </div>

            <!-- 热力图 Tooltip -->
            <div
              v-if="tooltipState.visible"
              class="heatmap-tooltip"
              :style="{ left: tooltipState.x + 'px', top: tooltipState.y + 'px' }"
            >
              <div class="tooltip-date">{{ tooltipState.date }}</div>
              <div class="tooltip-count">{{ tooltipState.count }} 条消息</div>
            </div>
          </div>

          <!-- 分隔线 -->
          <div class="agent-divider"></div>

          <!-- 右侧时间信息 -->
          <div class="agent-times">
            <div class="time-item">
              <span class="time-label">最近活跃</span>
              <span class="time-value highlight">{{ formatRelativeTime(agent.last_active_at) }}</span>
            </div>
            <div class="time-item">
              <span class="time-label">最后更新</span>
              <span class="time-value">{{ formatTime(agent.updated_at) }}</span>
            </div>
          </div>
          </div>
        </el-card>
      </div>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.agents-page {
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

.empty-msg {
  text-align: center;
  padding: 40px;
  color: var(--color-text-secondary);
}

.loading-skeleton-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.cards-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0;
}

.agent-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.card-content {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  gap: 24px;
  min-height: 120px;
  box-sizing: border-box;
}

:deep(.el-card__body) {
  padding: 0;
}

.agent-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 160px;
  flex-shrink: 0;
}

.agent-avatar {
  margin-bottom: 2px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.agent-avatar-wrapper {
  position: relative;
  display: inline-block;
}

.avatar-status {
  position: absolute;
  bottom: 2px;
  right: -4px;
}

.agent-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text);
}

.agent-status {
  display: none;  /* 隐藏原来的状态标签位置 */
}

.agent-model {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  margin-top: 2px;
  width: 100%;
}

.model-label {
  font-size: 10px;
  color: var(--color-text-secondary);
  display: none;
}

.model-value {
  font-size: 12px;
  color: var(--color-accent-blue);
  font-family: var(--font-exo2);
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  text-align: center;
}

.agent-middle {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 0;
}

.agent-divider {
  width: 1px;
  height: 80px;
  background: var(--color-border);
  flex-shrink: 0;
}

.agent-stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.agent-status-top {
  display: flex;
  align-items: center;
}

.agent-workspace {
  margin-top: 6px;
}

.workspace-value {
  font-size: 16px;
  font-family: var(--font-exo2);
  color: var(--color-accent-blue);
  max-width: 350px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}

.source-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.source-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.source-value {
  font-size: 12px;
  color: var(--color-accent-blue);
  font-family: var(--font-exo2);
}

.stat-row {
  display: flex;
  gap: 32px;
  align-items: center;
  margin: 10px 0;
}

.stat-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.stat-icon {
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
}

.stat-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text);
  font-family: var(--font-exo2);
  line-height: 1;
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.token-breakdown {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 2px;
}

.token-main-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.token-trend {
  font-size: 12px;
  font-weight: 500;
}

.token-trend.trend-up {
  color: var(--el-color-success);
}

.token-trend.trend-down {
  color: var(--el-color-danger);
}

.agent-times {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 120px;
  flex-shrink: 0;
}

.time-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.time-label {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.time-value {
  font-size: 13px;
  color: var(--color-text);
  font-family: var(--font-exo2);
}

.time-value.highlight {
  color: var(--color-accent-blue);
  font-weight: 500;
}

.workspace-path {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
  font-size: 11px;
  color: var(--color-text-secondary, #888);
}

/* ===== Token 统计 ===== */
.agent-token-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 16px;
  border-right: 1px solid var(--color-border);
  min-width: 140px;
}

.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.token-row.today {
  margin-top: 4px;
}

.token-label {
  color: var(--color-text-secondary);
  min-width: 32px;
}

.token-value {
  font-family: var(--font-exo2);
  color: var(--color-text);
  font-weight: 500;
}

.token-value.cost {
  color: var(--color-accent-blue);
  font-weight: 600;
  font-size: 14px;
}

.token-value.muted {
  color: var(--color-text-secondary);
  font-style: italic;
}

.token-cost {
  font-family: var(--font-exo2);
  color: var(--color-text-secondary);
  font-size: 11px;
}

.token-cost-value {
  font-family: var(--font-exo2);
  font-weight: 600;
}

.token-divider {
  height: 1px;
  background: var(--color-border);
  margin: 4px 0;
}

/* ===== 活动热力图 ===== */
.agent-heatmap {
  flex: 1;
}

.heatmap-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.heatmap-week {
  display: flex;
  flex-direction: row-reverse;
  gap: 4px;
}

.heatmap-cell {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
}

.heatmap-cell.level--1 {
  background: transparent;
}

.heatmap-cell.level-0 { background: #ebedf0; }
.heatmap-cell.level-1 { background: #c6e48b; }
.heatmap-cell.level-2 { background: #7bc06e; }
.heatmap-cell.level-3 { background: #4a9340; }
.heatmap-cell.level-4 { background: #2d6827; }
.heatmap-cell.level-5 { background: #216e39; }

/* 热力图 Tooltip */
.heatmap-tooltip {
  position: fixed;
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  z-index: 9999;
  pointer-events: none;
  transform: translate(-50%, -100%);
  margin-top: -10px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.heatmap-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: rgba(0, 0, 0, 0.85);
}

.tooltip-date {
  font-weight: 600;
  margin-bottom: 2px;
}

.tooltip-count {
  color: rgba(255, 255, 255, 0.8);
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
