<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO } from '../api/client';

/**
 * Agent 概览接口，对接 Admin API /api/data/agents/overview
 */
interface AgentOverview {
  agent_id: string;
  agent_name: string;
  workspace: string | null;
  status: string;
  last_active_at: string;
  current_tasks: Array<{ session_key: string; updated_at: string }>;
  messages_today: number;
}

// Agent 概览数据（来自真实 API）
const agentOverviewData = ref<{ agents: AgentOverview[] } | null>(null);

/**
 * 获取 Agent 概览数据
 */
async function fetchAgentOverview() {
  try {
    const res = await fetch('/api/agents/overview');
    agentOverviewData.value = await res.json();
  } catch (e) {
    console.error('获取 Agent 概览失败', e);
  }
}

/**
 * Agent 统计数据（由 agentOverviewData 计算得出）
 *
 * online: 有活动的 agent（工作 + 活跃）
 * running: 正在执行任务的 agent（工作，即有活跃 sessions）
 */
const agentStats = computed(() => {
  const agents = agentOverviewData.value?.agents ?? [];
  return {
    online: agents.filter((a) => a.status === '工作' || a.status === '活跃').length,
    running: agents.filter((a) => a.status === '工作').length,
    total: agents.length,
  };
});

/**
 * 当前任务列表（由 agentOverviewData 计算得出，取每个 Agent 的前 3 个任务）
 */
const mockTasks = computed(() => {
  const tasks: Array<{ agentId: string; title: string; status: string }> = [];
  const agents = agentOverviewData.value?.agents ?? [];
  for (const agent of agents) {
    for (const task of agent.current_tasks.slice(0, 3)) {
      tasks.push({
        agentId: agent.agent_id,
        title: task.session_key.split(':').pop() ?? task.session_key,
        status: '工作',
      });
    }
  }
  return tasks;
});

// 获取状态文本和颜色（与 AgentOverviewService.calculateAgentStatus 共用同一语义）
function getAgentStatusInfo(status: string): { text: string; color: string } {
  switch (status) {
    case '工作':
      return { text: '工作', color: 'var(--el-color-success)' };
    case '活跃':
      return { text: '活跃', color: 'var(--el-color-success-light)' };
    case '休假':
      return { text: '休假', color: 'var(--el-color-warning)' };
    case '离线':
      return { text: '离线', color: 'var(--el-color-info)' };
    case '失联':
      return { text: '失联', color: 'var(--el-color-danger)' };
    default:
      return { text: '未知', color: 'var(--el-text-color-secondary)' };
  }
}

// 获取任务状态图标
function getTaskStatusIcon(status: string): string {
  switch (status) {
    case 'running':
      return '🔄';
    case 'done':
      return '✅';
    case 'paused':
      return '⏸️';
    default:
      return '🔄';
  }
}

// 获取在线 Agent 数量
function getOnlineCount(): number {
  return agentStats.value.online;
}

// 统计数据
const stats = ref<MonitorStats>({
  totalRequests: 0,
  successCount: 0,
  failureCount: 0,
  successRate: 0,
  currentLatency: 0,
  avgLatency: 0,
  minLatency: 0,
  maxLatency: 0
});

// 模块列表
const moduleList = ref<ModuleDTO[]>([]);

// 定时器
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let agentRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 刷新监控数据
 */
function refreshData(): void {
  stats.value = apiMonitor.getStats();
}

/**
 * 刷新模块数据
 */
async function refreshModules(): Promise<void> {
  try {
    const data = await api.getModules();
    moduleList.value = data.modules || [];
  } catch (e) {
    console.error('获取模块列表失败:', e);
  }
}

/**
 * 格式化延迟显示
 */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 获取延迟等级颜色
 */
function getLatencyColor(ms: number): string {
  if (ms < 50) return 'var(--el-color-success)';
  if (ms < 100) return 'var(--el-color-warning)';
  return 'var(--el-color-danger)';
}

/**
 * 获取成功率等级
 */
function getSuccessRateType(rate: number): string {
  if (rate >= 99) return 'success';
  if (rate >= 95) return 'warning';
  return 'danger';
}

// 获取模块延迟（排除admin）
function getModuleLatency(mod: ModuleDTO): number {
  return mod.status?.latencyMs || 0;
}

// 最大模块延迟（用于条形图）
const maxModuleLatency = ref(1);

// 获取模块延迟条形图宽度
function getModuleLatencyWidth(mod: ModuleDTO): string {
  const latency = getModuleLatency(mod);
  return `${Math.min((latency / maxModuleLatency.value) * 100, 100)}%`;
}

// 过滤掉admin模块
const filteredModules = ref<ModuleDTO[]>([]);

onMounted(() => {
  fetchAgentOverview();
  refreshData();
  refreshModules();
  // 定时刷新数据
  refreshTimer = setInterval(() => {
    refreshData();
    refreshModules();
  }, 5000);
  // Agent 概览每 30 秒刷新一次
  agentRefreshTimer = setInterval(fetchAgentOverview, 30000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (agentRefreshTimer) {
    clearInterval(agentRefreshTimer);
    agentRefreshTimer = null;
  }
});

// 监听模块列表变化，更新maxModuleLatency
import { watch } from 'vue';
watch(moduleList, (newList) => {
  const filtered = newList.filter((m: ModuleDTO) => m.moduleKey !== 'admin');
  filteredModules.value = filtered;
  if (filtered.length > 0) {
    const max = Math.max(...filtered.map((m: ModuleDTO) => getModuleLatency(m)), 1);
    maxModuleLatency.value = max;
  }
}, { immediate: true });
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统概览" />

    <el-card class="content-area" shadow="never">
      <!-- 左右分栏布局 -->
      <div class="main-layout">
        <!-- 左侧：延迟监控卡片（窄） -->
        <div class="left-panel">
          <!-- 延迟监控卡片 -->
          <el-card class="latency-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <span>延迟监控</span>
                <el-tag size="small" type="info">实时</el-tag>
              </div>
            </template>
            
            <div class="latency-stats">
              <div class="latency-stat">
                <span class="label">前端→Admin</span>
                <span class="value" :style="{ color: getLatencyColor(stats.avgLatency) }">
                  {{ formatLatency(stats.avgLatency) }}
                </span>
              </div>
              
              <div class="latency-stat">
                <span class="label">延迟范围</span>
                <span class="value small">
                  {{ formatLatency(stats.minLatency) }} ~ {{ formatLatency(stats.maxLatency) }}
                </span>
              </div>
              
              <div class="latency-stat">
                <span class="label">成功率</span>
                <el-tag :type="getSuccessRateType(stats.successRate)" size="small">
                  {{ stats.successRate }}%
                </el-tag>
              </div>
            </div>

            <el-divider style="margin: 12px 0" />

            <div class="module-section">
              <div class="section-title">模块延迟</div>
              <div class="module-list" v-if="filteredModules.length > 0">
                <div class="module-item" v-for="mod in filteredModules" :key="mod.moduleKey">
                  <span class="module-name">{{ mod.name }}</span>
                  <div class="module-bar-wrapper">
                    <div 
                      class="module-bar" 
                      :style="{ 
                        width: getModuleLatencyWidth(mod), 
                        backgroundColor: getLatencyColor(getModuleLatency(mod))
                      }"
                    ></div>
                  </div>
                  <span class="module-latency" :style="{ color: getLatencyColor(getModuleLatency(mod)) }">
                    {{ formatLatency(getModuleLatency(mod)) }}
                  </span>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="30" />
            </div>
          </el-card>

          <!-- Agent 概览卡片 -->
          <el-card class="agent-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <span>Agent 概览</span>
                <el-tag size="small" type="success">{{ getOnlineCount() }} 个在线</el-tag>
              </div>
            </template>

            <div class="agent-list">
              <div class="agent-item" v-for="agent in (agentOverviewData?.agents ?? [])" :key="agent.agent_id">
                <div class="agent-info">
                  <span class="agent-name">{{ agent.agent_name }}</span>
                  <span class="agent-status" :style="{ color: getAgentStatusInfo(agent.status).color }">
                    {{ getAgentStatusInfo(agent.status).text }}
                  </span>
                </div>
                <div class="agent-tasks">
                  <span class="task-count" v-if="agent.current_tasks.length > 0">任务: {{ agent.current_tasks.length }}</span>
                  <span class="msg-count" v-if="agent.messages_today > 0">消息: {{ agent.messages_today }}</span>
                </div>
              </div>
            </div>

            <el-divider style="margin: 12px 0" />

            <div class="tasks-section">
              <div class="section-title">当前任务</div>
              <div class="task-list">
                <div class="task-item" v-for="task in mockTasks" :key="task.title">
                  <span class="task-icon">{{ getTaskStatusIcon(task.status) }}</span>
                  <span class="task-agent">{{ task.agentId }}:</span>
                  <span class="task-title">{{ task.title }}</span>
                </div>
              </div>
            </div>
          </el-card>
        </div>

        <!-- 右侧：主内容区 -->
        <div class="right-panel">
          <el-card class="main-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <span>概览</span>
              </div>
            </template>
            <div class="placeholder-content">
              <el-empty description="功能开发中..." :image-size="60" />
            </div>
          </el-card>
        </div>
      </div>
    </el-card>

    <AppFooter />
  </div>
</template>

<style scoped>
.overview-page {
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

.content-area :deep(.el-card__body) {
  padding: 16px;
}

/* 左右分栏布局 */
.main-layout {
  display: flex;
  gap: 16px;
  height: 100%;
}

/* 左侧：延迟监控（窄） */
.left-panel {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Agent 概览卡片 */
.agent-card {
  width: 100%;
  flex-shrink: 0;
}

.agent-card :deep(.el-card__header) {
  padding: 12px 16px;
}

.agent-card :deep(.el-card__body) {
  padding: 12px 16px;
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.agent-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  border: 1px solid var(--el-border-color-extra-light);
}

.agent-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.agent-status {
  font-size: 12px;
  font-weight: 500;
}

.agent-tasks {
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
}

.task-count {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.msg-count {
  font-size: 11px;
  color: var(--el-color-primary);
}

.tasks-section {
  margin-top: 4px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding-left: 8px;
}

.task-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.task-agent {
  font-weight: 500;
  color: var(--el-color-primary);
}

.task-title {
  color: var(--el-text-color-regular);
}

.latency-card {
  height: 100%;
}

.latency-card :deep(.el-card__header) {
  padding: 12px 16px;
}

.latency-card :deep(.el-card__body) {
  padding: 12px 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

/* 延迟统计 */
.latency-stats {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.latency-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.latency-stat .label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.latency-stat .value {
  font-size: 16px;
  font-weight: 600;
  font-family: var(--font-exo2);
}

.latency-stat .value.small {
  font-size: 12px;
}

/* 模块列表 */
.module-section {
  margin-top: 4px;
}

.section-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.module-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.module-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.module-name {
  width: 80px;
  font-size: 11px;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bar-wrapper {
  flex: 1;
  height: 4px;
  background: var(--el-fill-color);
  border-radius: 2px;
  overflow: hidden;
}

.module-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease, background-color 0.3s ease;
}

.module-latency {
  width: 50px;
  text-align: right;
  font-size: 10px;
  font-family: var(--font-exo2);
  font-weight: 500;
  flex-shrink: 0;
}

/* 右侧：主内容（宽） */
.right-panel {
  flex: 1;
  min-width: 0;
}

.main-card {
  height: 100%;
}

.main-card :deep(.el-card__body) {
  padding: 0;
}

.placeholder-content {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}
</style>
