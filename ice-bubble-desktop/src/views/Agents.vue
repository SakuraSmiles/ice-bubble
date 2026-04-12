<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppFooter from '../components/AppFooter.vue';
import PageHeader from '../components/PageHeader.vue';

interface Agent {
  agent_id: string;
  agent_name: string | null;
  session_count: number;
  message_count: number;
  first_active_at: string | null;
  last_active_at: string | null;
  updated_at: string;
  avatar: string | null;
  model: string | null;
}

interface ActivityDay {
  date: string;
  count: number;
}

const agents = ref<Agent[]>([]);
const loading = ref(false);
const totalAgents = ref(0);
const totalSessions = ref(0);
const totalMessages = ref(0);
// agentId → ActivityDay[]
const activityMap = ref<Record<string, ActivityDay[]>>({});

// 热力图 tooltip 状态
const tooltipState = ref({
  visible: false,
  x: 0,
  y: 0,
  date: '',
  count: 0
});

function showTooltip(event: MouseEvent, day: ActivityDay) {
  if (day.date === '') return;
  tooltipState.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    date: day.date,
    count: day.count
  };
}

function hideTooltip() {
  tooltipState.value.visible = false;
}

async function fetchAgents() {
  loading.value = true;
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    agents.value = data.agents || [];
    totalAgents.value = data.count || 0;
    totalSessions.value = agents.value.reduce((sum, a) => sum + (a.session_count || 0), 0);
    totalMessages.value = agents.value.reduce((sum, a) => sum + (a.message_count || 0), 0);

    // 并行获取所有 agent 的活动热力图数据
    const activityResults = await Promise.allSettled(
      agents.value.map(a =>
        fetch(`/api/agents/${encodeURIComponent(a.agent_id)}/activity?days=90`)
          .then(r => r.json())
          .then(d => ({ agentId: a.agent_id, activity: d.activity || [] }))
          .catch(() => ({ agentId: a.agent_id, activity: [] as ActivityDay[] }))
      )
    );

    const newMap: typeof activityMap.value = {};
    for (const result of activityResults) {
      if (result.status === 'fulfilled') {
        newMap[result.value.agentId] = result.value.activity;
      }
    }
    activityMap.value = newMap;
  } catch (e: any) {
    ElMessage.error('获取成员列表失败: ' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

/**
 * 生成最近 N 天的完整日期网格（周一开始，7行×N/7列）
 */
function generateDateGrid(days: number = 90): string[] {
  const dates: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

/**
 * 根据消息数量返回热力图等级 (0-4)
 */
function getActivityLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

/**
 * 获取某 agent 的活动热力图网格（补充缺失日期，count=0）
 */
function getHeatmapGrid(agentId: string, days: number = 90): ActivityDay[] {
  const activity = activityMap.value[agentId] || [];
  const activityByDate = new Map(activity.map(a => [a.date, a.count]));
  return generateDateGrid(days).map(date => ({
    date,
    count: activityByDate.get(date) ?? 0,
  }));
}

/**
 * 将一维日期数组转换为周视图网格（4行×7列，右对齐，今天在右侧）
 */
function toWeekGrid(activity: ActivityDay[]): ActivityDay[][] {
  const today = new Date();

  // 构建日期到count的映射
  const activityMap = new Map(activity.map(d => [d.date, d.count]));

  const result: ActivityDay[][] = [];

  // 生成4行数据
  // 列头：周日到周一（从左到右）
  // 日(0) 六(1) 五(2) 四(3) 三(4) 二(5) 一(6)
  // 第一行从今天开始，往右排（日期递增）
  for (let row = 0; row < 4; row++) {
    const week: ActivityDay[] = [];
    for (let col = 0; col < 7; col++) {
      // col=0 是周日(最左), col=6 是一(最右)
      // daysAgo 越小日期越新
      // formula: daysAgo = row * 7 + (6 - col)
      const daysAgo = row * 7 + (6 - col);
      
      if (daysAgo < 0) {
        week.push({ date: '', count: -1 });
      } else {
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        const dateStr = d.toISOString().split('T')[0];
        week.push({ date: dateStr, count: activityMap.get(dateStr) ?? 0 });
      }
    }
    result.push(week);
  }

  return result;
}

function formatTime(dateString: string | null): string {
  if (!dateString) return '-';
  const d = new Date(dateString);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function getAvatarUrl(avatar: string | null): string | null {
  if (!avatar) return null;
  return `/api/resources/avatars/${avatar}`;
}

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return '-';
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return formatTime(dateString);
}

function getActivityStatus(lastActiveAt: string | null): { label: string; type: string } {
  if (!lastActiveAt) return { label: '未知', type: 'info' };
  const now = Date.now();
  const date = new Date(lastActiveAt).getTime();
  const diff = now - date;
  const hours = diff / 3600000;
  if (hours < 1) return { label: '活跃', type: 'success' };
  if (hours < 24) return { label: '活跃', type: 'success' };
  if (hours < 72) return { label: '较久未活跃', type: 'warning' };
  return { label: '长时间未活跃', type: 'info' };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await fetchAgents();
  refreshTimer = setInterval(fetchAgents, 30000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

const subtitle = computed(() => `${totalAgents.value} 个成员，${totalSessions.value} 个会话，${totalMessages.value} 条消息`);
</script>

<template>
  <div class="agents-page">
    <PageHeader title="成员" :subtitle="subtitle">
      <el-button circle size="small" :loading="loading" @click="fetchAgents" title="刷新">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </PageHeader>

    <el-card class="content-area">
      <div v-if="agents.length === 0 && !loading" class="empty-msg">暂无成员</div>
      <div v-if="agents.length === 0 && loading" class="empty-msg">加载中...</div>
      <div v-if="agents.length > 0" class="cards-grid">
        <el-card v-for="agent in agents" :key="agent.agent_id" class="agent-card">
          <div class="card-content">
          <!-- 左侧信息 -->
          <div class="agent-left">
            <div class="agent-avatar">
              <el-avatar v-if="getAvatarUrl(agent.avatar)"
                :size="88"
                :src="getAvatarUrl(agent.avatar)!"
                fit="cover"
                style="background: #fff; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
              >
              </el-avatar>
              <el-avatar v-else
                :size="88"
                fit="cover"
                style="background: #fff; color: var(--color-accent-blue); border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
              >
                {{ agent.agent_id.substring(0, 1).toUpperCase() }}
              </el-avatar>
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
            <div class="agent-status-top">
              <el-tag :type="getActivityStatus(agent.last_active_at).type" size="small">
                {{ getActivityStatus(agent.last_active_at).label }}
              </el-tag>
            </div>
            <div class="stat-row">
              <div class="stat-item">
                <div class="stat-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2.5 3.5a.5.5 0 01.5-.5H13a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0 4a.5.5 0 01.5-.5h6a.5.5 0 010 1H3a.5.5 0 01-.5-.5z"/>
                </svg>
              </div>
              <div class="stat-content">
                <span class="stat-value">{{ agent.session_count }}</span>
                <span class="stat-label">会话</span>
              </div>
            </div>
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
              </div>
            </div>
            </div>
          </div>

          <!-- 活动热力图 -->
          <div class="agent-heatmap">
            <div class="heatmap-grid">
              <div
                v-for="(week, wi) in toWeekGrid(getHeatmapGrid(agent.agent_id, 90))"
                :key="wi"
                class="heatmap-week"
              >
                <div
                  v-for="(day, di) in week"
                  :key="di"
                  :class="['heatmap-cell', 'level-' + (day.count < 0 ? -1 : getActivityLevel(day.count))]"
                  @mouseenter="showTooltip($event, day)"
                  @mouseleave="hideTooltip"
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
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.agents-page {
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 32px;
  box-sizing: border-box;
  min-height: calc(100vh - 1px);
}

.content-area {
  flex: 1;
  margin-bottom: 20px;
}

.empty-msg {
  text-align: center;
  padding: 40px;
  color: var(--color-text-secondary);
}

.cards-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  box-sizing: border-box;
}

.agent-card {
  width: 100%;
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
  min-width: 110px;
  flex-shrink: 0;
}

.agent-avatar {
  margin-bottom: 2px;
  background: #fff;
  border-radius: 50%;
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
  align-items: center;
  gap: 0;
  margin-top: 2px;
}

.model-label {
  font-size: 10px;
  color: var(--color-text-secondary);
  display: none;
}

.model-value {
  font-size: 11px;
  color: var(--color-accent-blue);
  font-family: monospace;
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

.stat-row {
  display: flex;
  gap: 32px;
}

.stat-item {
  display: flex;
  align-items: center;
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
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  font-family: monospace;
  line-height: 1;
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
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
  font-family: monospace;
}

.time-value.highlight {
  color: var(--color-accent-blue);
  font-weight: 500;
}

/* ===== 活动热力图 ===== */
.agent-heatmap {
  flex: 1;
}

.heatmap-grid {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.heatmap-week {
  display: flex;
  flex-direction: row-reverse;
  gap: 5px;
}

.heatmap-cell {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
}

.heatmap-cell.level--1 {
  background: transparent;
}

.heatmap-cell.level-0 { background: #ebedf0; }
.heatmap-cell.level-1 { background: #9be9a7; }
.heatmap-cell.level-2 { background: #40c463; }
.heatmap-cell.level-3 { background: #30a14e; }
.heatmap-cell.level-4 { background: #216e39; }

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
</style>
