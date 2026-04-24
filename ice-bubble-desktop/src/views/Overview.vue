<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO } from '../api/client';
import ChatTimeline from './components/ChatTimeline.vue';


// =========== 接口定义 ===========

interface AgentOverview {
  agent_id: string;
  agent_name: string;
  avatar: string | null;
  workspace: string | null;
  status: string;
  model: string | null;
  last_active_at: string;
  latest_message: string | null;
}

interface TokenStats {
  total_tokens_input: number;
  total_tokens_output: number;
  total_cost: number;
  message_count: number;
}

interface TokenStatsMap {
  [agentId: string]: TokenStats;
}

interface AgentRuntimeState {
  isStreaming: boolean;
  streamingContent: string;
  lastCompleteMessage: string;
  targetLength: number;
  streamTimer: ReturnType<typeof setTimeout> | null;
  displayMessage: string;
}

/** 每个 Agent 的运行时状态 */
const agentRuntimeStates = ref<Record<string, AgentRuntimeState>>({});

/** 消息元素引用（用于流式输出时滚动） */
const messageRefs = ref<Record<string, HTMLElement>>({});

// Agent 概览数据
const agentOverviewData = ref<{ agents: AgentOverview[] } | null>(null);

/** Token 统计数据（今日） */
const tokenStatsMap = ref<TokenStatsMap>({});

// =========== Task 模块相关 ===========

type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'pending' | 'in_progress' | 'completed';

interface TaskItem {
  task_id: string;
  title: string;
  status: TaskStatus;
}

interface AgentTasks {
  tasks: TaskItem[];
  loading: boolean;
  error: string | null;
}

const agentTasksMap = ref<Record<string, AgentTasks>>({});

// =========== 最新任务模块相关 ===========

interface LatestTaskData {
  parent: {
    id: string;
    title: string;
    status: string;
    priority: string;
    agent_id: string;
    type: string;
    created_at: string;
    updated_at: string;
  } | null;
  subtasks: TaskItem[];
  agents: Record<string, TaskItem[]>;
}

const latestTaskData = ref<LatestTaskData | null>(null);
const latestTaskLoading = ref(false);
const latestTaskError = ref<string | null>(null);

/** 获取最新任务 */
async function fetchLatestTask(): Promise<void> {
  latestTaskLoading.value = true;
  latestTaskError.value = null;
  try {
    const res = await fetch('/api/tasks/latest');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestTaskData.value = data;
  } catch (e) {
    console.error('获取最新任务失败', e);
    latestTaskError.value = e instanceof Error ? e.message : '获取失败';
    latestTaskData.value = null;
  } finally {
    latestTaskLoading.value = false;
  }
}

/** 获取 Agent 的任务数据 */
function getAgentTasks(agentId: string): AgentTasks {
  if (!agentTasksMap.value[agentId]) {
    agentTasksMap.value[agentId] = { tasks: [], loading: false, error: null };
  }
  return agentTasksMap.value[agentId];
}

/** 获取 Agent 的任务列表 */
async function fetchAgentTasks(agentId: string): Promise<void> {
  const at = getAgentTasks(agentId);
  at.loading = true;
  at.error = null;
  try {
    const res = await fetch(`/api/agents/${agentId}/tasks`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let rawTasks: any[] = Array.isArray(data) ? data : (data.tasks || []);
    const statusMap: Record<string, TaskStatus> = {
      pending: 'TODO', in_progress: 'IN_PROGRESS', completed: 'DONE', blocked: 'TODO'
    };
    at.tasks = rawTasks.map(t => ({
      task_id: t.id, title: t.title || t.task_id, status: statusMap[t.status] ?? 'TODO'
    }));
  } catch (e) {
    console.error(`获取 Agent ${agentId} 任务失败`, e);
    at.error = e instanceof Error ? e.message : '获取失败';
    at.tasks = [];
  } finally {
    at.loading = false;
  }
}

/** 批量获取所有在线 Agent 的任务 */
async function fetchAllAgentTasks(): Promise<void> {
  const agents = agentOverviewData.value?.agents ?? [];
  await Promise.all(agents.map(a => fetchAgentTasks(a.agent_id)));
}

// =========== 核心功能函数 ===========

/** 获取/初始化 Agent 运行时状态 */
function getAgentRuntime(agentId: string): AgentRuntimeState {
  if (!agentRuntimeStates.value[agentId]) {
    agentRuntimeStates.value[agentId] = {
      isStreaming: false, streamingContent: '', lastCompleteMessage: '',
      targetLength: 0, streamTimer: null, displayMessage: ''
    };
  }
  return agentRuntimeStates.value[agentId];
}

/** 检测 Agent 状态是否为"工作中" */
function isWorkingStatus(status: string): boolean {
  return status === '工作' || status === '工作中';
}

/** 处理新消息 */
function handleNewMessage(agentId: string, newMessage: string, isWorking: boolean) {
  const state = getAgentRuntime(agentId);
  const cleanedMsg = (newMessage || '').replace(/\s+/g, ' ').trim();
  if (!cleanedMsg) {
    state.displayMessage = ''; state.lastCompleteMessage = ''; return;
  }
  if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
  if (isWorking) {
    state.isStreaming = true; state.lastCompleteMessage = cleanedMsg;
    state.targetLength = cleanedMsg.length; startStreaming(agentId, cleanedMsg);
  } else {
    state.isStreaming = false; state.streamingContent = '';
    state.displayMessage = cleanedMsg; state.lastCompleteMessage = cleanedMsg;
  }
}

/** 启动流式输出 */
function startStreaming(agentId: string, fullMessage: string) {
  const state = getAgentRuntime(agentId);
  const chars = fullMessage.split('');
  let currentIndex = 0;
  const BASE_SPEED = 15; const MIN_DELAY = 5; const MAX_DELAY = 50;

  function streamNext() {
    if (currentIndex >= chars.length) {
      state.isStreaming = false; state.streamingContent = '';
      state.displayMessage = state.lastCompleteMessage; state.streamTimer = null;
      scrollMessageToTop(agentId); return;
    }
    currentIndex++;
    state.streamingContent = chars.slice(0, currentIndex).join('');
    state.displayMessage = state.streamingContent;
    const delay = MIN_DELAY + Math.random() * Math.min(MAX_DELAY, BASE_SPEED * Math.pow(1.05, currentIndex));
    state.streamTimer = setTimeout(() => streamNext(), delay);
    nextTick(() => scrollMessageToBottom(agentId));
  }
  streamNext();
}

function scrollMessageToBottom(agentId: string) {
  const el = messageRefs.value[agentId];
  if (el) el.scrollTop = el.scrollHeight;
}

function scrollMessageToTop(agentId: string) {
  const el = messageRefs.value[agentId];
  if (el) el.scrollTop = 0;
}

/** 头像 URL */
function getAvatarUrl(avatar: string | null): string | null {
  if (!avatar) return null;
  return `/api/resources/avatars/${avatar}`;
}

/** 获取 Agent 的 Token 消耗显示 */
function getAgentTokenDisplay(agentId: string): string {
  const stats = tokenStatsMap.value[agentId];
  if (!stats) return '-';
  const total = stats.total_tokens_input + stats.total_tokens_output;
  if (total >= 1000000) return (total / 1000000).toFixed(1) + 'M';
  if (total >= 1000) return (total / 1000).toFixed(1) + 'K';
  return total.toString();
}

/** Agent 列表：优先工作中，至少3个 */
const onlineAgents = computed(() => {
  const agents = agentOverviewData.value?.agents ?? [];
  // 只显示"活跃"状态的 agent
  const active = agents.filter(a => a.status === '活跃' || isWorkingStatus(a.status));
  // 不足3个时，用最近活跃的离线 agent 补充
  const inactive = agents
    .filter(a => a.status !== '活跃' && !isWorkingStatus(a.status))
    .sort((a, b) => new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime());
  const result = [...active, ...inactive];
  return result.slice(0, 3);
});

/** 监听 agent 数据变化 */
watch(agentOverviewData, (newData) => {
  if (!newData?.agents) return;
  for (const agent of newData.agents) {
    const state = getAgentRuntime(agent.agent_id);
    const cleanedMsg = (agent.latest_message || '').replace(/\s+/g, ' ').trim();
    if (cleanedMsg !== state.lastCompleteMessage && !state.isStreaming) {
      handleNewMessage(agent.agent_id, cleanedMsg, isWorkingStatus(agent.status));
    } else if (cleanedMsg !== state.lastCompleteMessage && state.isStreaming) {
      if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
      handleNewMessage(agent.agent_id, cleanedMsg, isWorkingStatus(agent.status));
    } else if (state.isStreaming && !isWorkingStatus(agent.status)) {
      if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
      state.isStreaming = false; state.streamingContent = '';
      state.displayMessage = state.lastCompleteMessage;
    }
  }
});

// =========== 模块监控 ===========

const stats = ref<MonitorStats>({
  totalRequests: 0, successCount: 0, failureCount: 0,
  successRate: 0, currentLatency: 0, avgLatency: 0, minLatency: 0, maxLatency: 0
});

const moduleList = ref<ModuleDTO[]>([]);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let agentRefreshTimer: ReturnType<typeof setInterval> | null = null;

function refreshData(): void { stats.value = apiMonitor.getStats(); }

async function refreshModules(): Promise<void> {
  try {
    const data = await api.getModules();
    moduleList.value = data.modules || [];
  } catch (e) { console.error('获取模块列表失败:', e); }
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getLatencyColor(ms: number): string {
  if (ms < 50) return 'var(--el-color-success)';
  if (ms < 100) return 'var(--el-color-warning)';
  return 'var(--el-color-danger)';
}

function getSuccessRateType(rate: number): string {
  if (rate >= 99) return 'success';
  if (rate >= 95) return 'warning';
  return 'danger';
}

function getModuleLatency(mod: ModuleDTO): number { return mod.status?.latencyMs || 0; }
const maxModuleLatency = ref(1);

function getModuleLatencyWidth(mod: ModuleDTO): string {
  const latency = getModuleLatency(mod);
  return `${Math.min((latency / maxModuleLatency.value) * 100, 100)}%`;
}

const filteredModules = ref<ModuleDTO[]>([]);

// =========== Token 统计 ===========

async function fetchTokenStats() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`/api/agents/token-summary?date=${today}`);
    const data = await res.json();
    const statsMap: TokenStatsMap = {};
    if (data.summary && Array.isArray(data.summary)) {
      for (const item of data.summary) {
        statsMap[item.agent_id] = {
          total_tokens_input: item.total_tokens_input,
          total_tokens_output: item.total_tokens_output,
          total_cost: item.total_cost || 0,
          message_count: item.message_count
        };
      }
    }
    tokenStatsMap.value = statsMap;
  } catch (e) { console.error('获取 Token 统计失败', e); }
}

// =========== 数据获取 ===========

async function fetchAgentOverview() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    agentOverviewData.value = data;
    // 清理已消失 agent 的 runtime state
    const currentIds = new Set((data.agents ?? []).map((a: AgentOverview) => a.agent_id));
    for (const id of Object.keys(agentRuntimeStates.value)) {
      if (!currentIds.has(id)) {
        const s = agentRuntimeStates.value[id];
        if (s.streamTimer) clearTimeout(s.streamTimer);
        delete agentRuntimeStates.value[id];
      }
    }
    for (const id of Object.keys(agentTasksMap.value)) {
      if (!currentIds.has(id)) delete agentTasksMap.value[id];
    }
    await fetchAllAgentTasks();
  } catch (e) { console.error('获取 Agent 概览失败', e); }
}

async function fetchAll(isLoading: boolean = false) {
  if (isLoading) loading.value = true;
  await Promise.all([refreshModules(), fetchAgentOverview(), fetchTokenStats(), fetchLatestTask()]);
  if (isLoading) loading.value = false;
}

const loading = ref(false);

onMounted(() => {
  refreshData();
  fetchAll(true);
  refreshTimer = setInterval(() => { refreshData(); refreshModules(); }, 5000);
  agentRefreshTimer = setInterval(() => { fetchAgentOverview(); fetchTokenStats(); }, 30000);
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (agentRefreshTimer) { clearInterval(agentRefreshTimer); agentRefreshTimer = null; }
  for (const s of Object.values(agentRuntimeStates.value)) {
    if (s.streamTimer) { clearTimeout(s.streamTimer); s.streamTimer = null; }
  }
});

watch(moduleList, (newList) => {
  const filtered = newList.filter((m: ModuleDTO) => m.moduleKey !== 'admin');
  filteredModules.value = filtered;
  if (filtered.length > 0) {
    maxModuleLatency.value = Math.max(...filtered.map((m: ModuleDTO) => getModuleLatency(m)), 1);
  }
}, { immediate: true });
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统概览" :loading="loading" @refresh="fetchAll(true)" />

    <el-card class="content-area" shadow="never">
      <div class="main-layout">
        <!-- 左侧面板 -->
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
                    <div class="module-bar" :style="{
                      width: getModuleLatencyWidth(mod),
                      backgroundColor: getLatencyColor(getModuleLatency(mod))
                    }"></div>
                  </div>
                  <span class="module-latency" :style="{ color: getLatencyColor(getModuleLatency(mod)) }">
                    {{ formatLatency(getModuleLatency(mod)) }}
                  </span>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="30" />
            </div>
          </el-card>

          <!-- Agent 概览列表 -->
          <div class="agent-list">
            <div class="agent-item" :class="{ 'is-working': isWorkingStatus(agent.status) }"
              v-for="agent in onlineAgents" :key="agent.agent_id">
              <div class="agent-top">
                <div class="avatar-wrapper" :class="{ 'is-working': isWorkingStatus(agent.status) }">
                  <el-avatar v-if="getAvatarUrl(agent.avatar)" :size="36" :src="getAvatarUrl(agent.avatar)!"
                    fit="cover" class="agent-avatar" />
                  <el-avatar v-else :size="36" fit="cover" class="agent-avatar"
                    style="color: var(--color-accent-blue); font-size: 14px;">
                    {{ agent.agent_id.substring(0, 1).toUpperCase() }}
                  </el-avatar>
                  <span class="status-dot" :class="'status-dot--' + agent.status"></span>
                </div>
                <span class="agent-name">{{ agent.agent_name || agent.agent_id }}</span>
                <el-tag size="small" effect="plain" class="agent-model-tag">
                  {{ getAgentTokenDisplay(agent.agent_id) }}
                </el-tag>
              </div>

              <!-- 任务 TODO 列表 -->
              <div class="agent-todo-list">
                <template v-if="getAgentTasks(agent.agent_id).tasks.length > 0">
                  <div
                    class="todo-item"
                    :class="{ 'todo-item--done': task.status === 'DONE' }"
                    v-for="task in getAgentTasks(agent.agent_id).tasks"
                    :key="task.task_id"
                  >
                    <span class="todo-icon">
                      <template v-if="task.status === 'DONE'">✅</template>
                      <template v-else>⚪</template>
                    </span>
                    <span class="todo-title">{{ task.title }}</span>
                  </div>
                </template>
                <div v-else class="todo-empty">暂无任务</div>
              </div>
            </div>
            <el-empty v-if="onlineAgents.length === 0" description="暂无在线 Agent" :image-size="40" />
          </div>

        </div>

        <!-- 右侧：ChatTimeline -->
        <div class="right-panel">
          <ChatTimeline />
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
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.content-area :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  padding: 16px;
  overflow: visible;
}

/* 左右分栏布局 */
.main-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

/* 左侧面板 */
.left-panel {
  max-width: 30%;
  min-width: 280px;
  flex-shrink: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

/* 延迟监控卡片 */
.latency-card {
  flex-shrink: 0;
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

/* Agent 列表 */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-item {
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-extra-light);
  min-height: 100px;
  overflow: hidden;
  position: relative;
}

.agent-item .agent-top {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.agent-item .agent-avatar {
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-extra-light);
}

.agent-item .agent-name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-item .agent-model-tag {
  flex-shrink: 0;
  font-family: var(--font-exo2);
  font-size: 10px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color-extra-light);
}

/* 任务状态 */
/* 任务列表 */
.agent-item .agent-todo-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding-left: 8px;
}

.agent-item .todo-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}

.agent-item .todo-item--done .todo-title {
  text-decoration: line-through;
  color: var(--el-text-color-placeholder);
}

.agent-item .todo-icon {
  font-size: 10px;
  flex-shrink: 0;
  margin-top: 1px;
}

.agent-item .todo-title {
  word-break: break-word;
}

.agent-item .todo-empty {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-style: italic;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* 状态指示器 */
.avatar-wrapper {
  position: relative;
  display: inline-flex;
}

.avatar-wrapper.is-working .agent-avatar {
  border-color: var(--color-accent-blue);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
  animation: avatar-working 2s ease-in-out infinite;
}

@keyframes avatar-working {
  0%, 100% { box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15); border-color: var(--color-accent-blue); }
  50% { box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.25); border-color: var(--color-accent-blue); }
}

.avatar-wrapper .status-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--el-bg-color);
  border-radius: 50%;
}

.status-dot--工作,
.status-dot--活跃 { background: var(--el-color-success); }
.status-dot--休假 { background: var(--el-color-warning); }
.status-dot--离线 { background: var(--el-color-info); }
.status-dot--失联 { background: var(--el-color-danger); }
.status-dot--工作中 { background: var(--el-color-success); }

.avatar-wrapper.is-working .status-dot {
  animation: dot-breathe 1.5s ease-in-out infinite;
}

@keyframes dot-breathe {
  0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.4); }
  50% { transform: scale(1.15); opacity: 0.85; box-shadow: 0 0 0 4px rgba(64, 158, 255, 0); }
}

/* 工作中卡片流光边框 */
.agent-item.is-working::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 8px;
  padding: 2px;
  background: linear-gradient(90deg,
    transparent 0%, rgba(64, 158, 255, 0.6) 30%, #409eff 50%, rgba(64, 158, 255, 0.6) 70%, transparent 100%);
  background-size: 200% 100%;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: border-shimmer 3s ease-in-out infinite;
}

@keyframes border-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 右侧：主内容区 */
.right-panel {
  flex: 1;
  min-width: 0;
  height: 600px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
