<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import {
  ChatDotRound, Connection, Calendar, Monitor
} from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api, request } from '../api/client';
import { gatewayClient } from '@/services/gateway-client';
import type { ModuleDTO, TimelineResponseDTO } from '../api/client';
// 子组件
import StatusDropdown from './components/StatusDropdown.vue';
import RecentSessions from './components/RecentSessions.vue';

// =========== 数据状态卡片 ===========

// =========== 统计卡片 ===========

interface StatsData {
  sessionCount: number;
  messageCount: number;
  agentCount: number;
  todayMessageCount: number;
  lastSyncTime: string | null;
}

const statsData = ref<StatsData | null>(null);

async function fetchStats(): Promise<void> {
  try {
    const res = await request('/stats');
    if (!res.ok) return;
    statsData.value = await res.json();
  } catch {
    // silent
  }
}

interface DataStatus {
  todayFiltered: number;
  lastCompaction: string | null;
  lastMemoryFlush: string | null;
  todayRetryCount: number;
  todayModelChangeCount: number;
}

const dataStatus = ref<DataStatus | null>(null);

/** 从 timeline 响应中提取 system_status */
function extractDataStatus(data: TimelineResponseDTO): void {
  const ss = data.meta?.system_status;
  if (ss) {
    dataStatus.value = {
      todayFiltered: ss.todayFiltered,
      lastCompaction: ss.lastCompaction ?? null,
      lastMemoryFlush: ss.lastMemoryFlush ?? null,
      todayRetryCount: (ss as any).todayRetryCount ?? 0,
      todayModelChangeCount: (ss as any).todayModelChangeCount ?? 0,
    };
  }
}

/** 定时拉取 timeline meta 以更新数据状态 */
async function fetchDataStatus(): Promise<void> {
  try {
    const res = await request('/messages/timeline?limit=1');
    if (!res.ok) return;
    const data: TimelineResponseDTO = await res.json();
    extractDataStatus(data);
  } catch {
    // 静默忽略，等待下次轮询
  }
}

// =========== 模块监控 ===========

const stats = ref<MonitorStats>({
  totalRequests: 0, successCount: 0, failureCount: 0,
  successRate: 0, currentLatency: 0, avgLatency: 0, minLatency: 0, maxLatency: 0
});

const moduleList = ref<ModuleDTO[]>([]);

// =========== 统一轮询系统 ===========
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollPending = false;
let tickCounter = 0; // 每 tick 自增，用于内部分频

function startPolling(): void {
  const interval = document.visibilityState === 'hidden' ? 30000 : 10000;
  pollTimer = setInterval(() => {
    if (pollPending) return;
    tickCounter++;
    // 10s 任务（近似原 5s）：refreshData + refreshModules（每 tick）
    pollPending = true;
    refreshData();
    refreshModules().finally(() => { pollPending = false; });
    // 30s 任务：fetchAgentOverview + fetchDataStatus + fetchStats（每 3 ticks）
    if (tickCounter % 3 === 0) {
      pollPending = true;
      fetchAgentOverview();
      pollPending = true;
      fetchDataStatus().finally(() => { pollPending = false; });
      pollPending = true;
      fetchStats().finally(() => { pollPending = false; });
    }
  }, interval);
}

function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 监听页面可见性，隐藏时降频
function onVisibilityChange(): void {
  stopPolling();
  tickCounter = 0;
  if (document.visibilityState === 'visible') {
    startPolling();
  }
}

function refreshData(): void { stats.value = apiMonitor.getStats(); }

async function refreshModules(): Promise<void> {
  try {
    const data = await api.getModules();
    moduleList.value = data.modules || [];
  } catch (e) { console.error('获取模块列表失败:', e); }
}

// =========== 数据获取 ===========

async function fetchAgentOverview() {
  try {
    await api.getAgents();
  } catch (e) { console.error('获取 Agent 概览失败', e); }
}

async function fetchAll(isLoading: boolean = false) {
  if (isLoading) loading.value = true;
  await Promise.all([refreshModules(), fetchAgentOverview()]);
  if (isLoading) loading.value = false;
}

const loading = ref(false);

// =========== Gateway 事件取消订阅 ===========
let unsubSessionMsg: (() => void) | null = null;

onMounted(() => {
  refreshData();
  fetchAll(true);
  fetchDataStatus();
  fetchStats();
  startPolling();
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Gateway 实时事件：新消息到达时让 ChatTimeline 组件通过内部监听更新
  // ChatTimeline（via RecentSessions）内部已监听 session.message 事件
  // 这里只监听 sessions.changed 来触发 agent overview 的增量刷新
  gatewayClient.on('sessions.changed', () => {
    // 会话列表变化时刷新 agent 概览（不阻塞）
    fetchAgentOverview();
  });

  // 监听 session.message 触发 agent 状态刷新
  unsubSessionMsg = gatewayClient.on('session.message', () => {
    // 新消息到达，刷新 agent 概览以更新 latest_message
    fetchAgentOverview();
  });
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (unsubSessionMsg) { unsubSessionMsg(); unsubSessionMsg = null; }
});
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统概览" :loading="loading" @refresh="fetchAll(true)">
      <StatusDropdown
        :stats="stats"
        :modules="moduleList"
        :data-status="dataStatus"
      />
    </PageHeader>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <el-statistic title="消息总数" :value="statsData?.messageCount ?? 0">
          <template #prefix><el-icon><ChatDotRound /></el-icon></template>
        </el-statistic>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <el-statistic title="会话总数" :value="statsData?.sessionCount ?? 0">
          <template #prefix><el-icon><Connection /></el-icon></template>
        </el-statistic>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <el-statistic title="今日消息" :value="statsData?.todayMessageCount ?? 0">
          <template #prefix><el-icon><Calendar /></el-icon></template>
        </el-statistic>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <el-statistic title="Agent 数量" :value="statsData?.agentCount ?? 0">
          <template #prefix><el-icon><Monitor /></el-icon></template>
        </el-statistic>
      </el-card>
    </div>

    <el-card class="content-area" shadow="never">
      <div class="main-layout">
        <RecentSessions :loading="loading" />
      </div>
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.overview-page {
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* 统计卡片行 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 8px 24px;
}

@media (max-width: 768px) {
  .stats-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

.stat-card {
  background: var(--color-bg-canvas);
  border-radius: var(--radius);
  border: 1px solid var(--el-border-color-extra-light);
}

.stat-card :deep(.el-card__body) {
  padding: 16px;
}

.stat-card :deep(.el-statistic__head) {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-bottom: 4px;
}

.stat-card :deep(.el-statistic__content) {
  color: var(--el-text-color-primary);
  font-family: var(--font-exo2);
}

.stat-card :deep(.el-statistic__prefix) {
  margin-right: 6px;
  color: var(--color-accent-blue);
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-canvas);
  border-radius: var(--radius);
  margin: 8px 24px;
  overflow: hidden;
}

.content-area :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 左右分栏布局 */
.main-layout {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}


</style>
