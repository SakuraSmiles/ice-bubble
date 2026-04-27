<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO, TimelineResponseDTO } from '../api/client';
// 子组件
import SystemHealth from './components/SystemHealth.vue';
import RecentSessions from './components/RecentSessions.vue';
import AgentTaskTree from './components/AgentTaskTree.vue';
import ParentTaskProgress from './components/ParentTaskProgress.vue';


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
  session_count?: number;
  message_count?: number;
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



// =========== 最近任务模块相关 ===========

interface TaskItem {
  task_id: string;
  title: string;
  status: string;
  updated_at?: string;
}

interface AgentGroup {
  agent_id: string;
  active_children: TaskItem[];
  completed_children: TaskItem[];
}

interface ParentTask {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  agent_groups: AgentGroup[];
}

interface WorkspaceTasks {
  parents: ParentTask[];
}

const workspaceTasks = ref<WorkspaceTasks | null>(null);
const latestTaskLoading = ref(false);

// =========== 数据状态卡片 ===========

interface DataStatus {
  todayFiltered: number;
  lastCompaction: string | null;
  lastMemoryFlush: string | null;
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
    };
  }
}

/** 定时拉取 timeline meta 以更新数据状态 */
async function fetchDataStatus(): Promise<void> {
  try {
    const res = await fetch('/api/messages/timeline?limit=1');
    if (!res.ok) return;
    const data: TimelineResponseDTO = await res.json();
    extractDataStatus(data);
  } catch {
    // 静默忽略，等待下次轮询
  }
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '--';
  const then = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHr < 24) return `${diffHr}小时前`;
  const thenDay = then.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (thenDay === yesterday.toDateString()) {
    return `昨天 ${then.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${then.getMonth() + 1}-${then.getDate().toString().padStart(2, '0')}`;
}

/** 获取工作区任务（按父任务聚合） */
async function fetchLatestTask(): Promise<void> {
  latestTaskLoading.value = true;
  try {
    const res = await fetch('/api/tasks/workspace');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    workspaceTasks.value = data;
  } catch (e) {
    console.warn('通过 proxy 获取失败，尝试直连 Task API', e);
    try {
      const res = await fetch('http://localhost:13102/api/tasks/workspace');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      workspaceTasks.value = data;
    } catch (e2) {
      console.error('获取工作区任务完全失败', e2);
      workspaceTasks.value = null;
    }
  } finally {
    latestTaskLoading.value = false;
  }
}

/** 最近的父任务（按 updated_at 排序取第一个） */
const recentParentTask = computed<ParentTask | null>(() => {
  const parents = workspaceTasks.value?.parents ?? [];
  if (!parents.length) return null;
  return [...parents].sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )[0];
});

/** 最近父任务是否包含子任务 */
const hasSubTasks = computed(() => {
  const groups = recentParentTask.value?.agent_groups ?? [];
  return groups.some(g =>
    (g.active_children && g.active_children.length > 0) ||
    (g.completed_children && g.completed_children.length > 0)
  );
});

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

/** Agent 列表：所有工作中 agent 全部展示，不足 3 个时用最近活跃离线 agent 补充 */
const onlineAgents = computed(() => {
  const agents = agentOverviewData.value?.agents ?? [];
  // 工作中 / 活跃的 agent 全部展示（移除 slice(0, 3) 硬限制）
  const working = agents
    .filter(a => a.status === '活跃' || isWorkingStatus(a.status))
    .sort((a, b) => new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime());
  // 不足 3 个时用最近活跃离线 agent 补充
  if (working.length >= 3) return working;
  const offline = agents
    .filter(a => a.status !== '活跃' && !isWorkingStatus(a.status))
    .sort((a, b) => new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime());
  return [...working, ...offline];
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
let dataStatusTimer: ReturnType<typeof setInterval> | null = null;

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
    // 旧端点已废弃，不再调用 fetchAllAgentTasks
  } catch (e) { console.error('获取 Agent 概览失败', e); }
}

async function fetchAll(isLoading: boolean = false) {
  if (isLoading) loading.value = true;
  await Promise.all([refreshModules(), fetchAgentOverview(), fetchLatestTask()]);
  if (isLoading) loading.value = false;
}

const loading = ref(false);

onMounted(() => {
  refreshData();
  fetchAll(true);
  fetchDataStatus();
  refreshTimer = setInterval(() => { refreshData(); refreshModules(); }, 5000);
  agentRefreshTimer = setInterval(() => { fetchAgentOverview(); fetchLatestTask(); }, 30000);
  dataStatusTimer = setInterval(() => { fetchDataStatus(); }, 30000);
});

onUnmounted(() => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (agentRefreshTimer) { clearInterval(agentRefreshTimer); agentRefreshTimer = null; }
  if (dataStatusTimer) { clearInterval(dataStatusTimer); dataStatusTimer = null; }
  for (const s of Object.values(agentRuntimeStates.value)) {
    if (s.streamTimer) { clearTimeout(s.streamTimer); s.streamTimer = null; }
  }
});
</script>

<template>
  <div class="overview-page">
    <PageHeader title="工作台" subtitle="系统概览" :loading="loading" @refresh="fetchAll(true)" />

    <el-card class="content-area" shadow="never">
      <div class="main-layout">
        <!-- 左侧面板 -->
        <div class="left-panel">
          <!-- 系统健康状态（延迟监控 + 模块延迟） -->
          <SystemHealth
            :stats="stats"
            :modules="moduleList"
            :loading="loading"
          />

          <!-- 数据状态 -->
          <div v-if="dataStatus" class="data-status">
            <div class="data-status-title">数据状态</div>
            <div class="data-status-rows">
              <div class="data-status-row">
                <span class="data-status-label">今日过滤</span>
                <span class="data-status-value is-number">{{ dataStatus.todayFiltered ?? 0 }}</span>
              </div>
              <div class="data-status-row">
                <span class="data-status-label">最近压缩</span>
                <span class="data-status-value" :class="{ 'is-empty': !dataStatus.lastCompaction }">
                  {{ formatRelativeTime(dataStatus.lastCompaction) }}
                </span>
              </div>
              <div class="data-status-row">
                <span class="data-status-label">最近记忆</span>
                <span class="data-status-value" :class="{ 'is-empty': !dataStatus.lastMemoryFlush }">
                  {{ formatRelativeTime(dataStatus.lastMemoryFlush) }}
                </span>
              </div>
            </div>
          </div>

          <!-- 父任务 + 子任务（wrapper 容器） -->
          <div v-if="recentParentTask" class="task-section">
            <ParentTaskProgress
              :parent-task="recentParentTask"
              :agents="onlineAgents"
              :loading="loading"
            />
            <AgentTaskTree
              v-if="hasSubTasks"
              :agents="onlineAgents"
              :parent-task="recentParentTask"
              :loading="loading"
            />
          </div>
        </div>

        <!-- 右侧：最近会话（ChatTimeline） -->
        <div class="right-panel">
          <RecentSessions :loading="loading" />
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
  width: 24%;
  min-width: 280px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
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

.agent-item .agent-model-name {
  margin: 1px 0 0 44px;
  font-family: var(--font-exo2);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
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
  min-width: 0;
  flex: 1;
  height: calc(100vh - 240px);
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

/* ===== 数据状态 ===== */
.data-status {
  padding: 10px 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
}

.data-status-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.data-status-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.data-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.data-status-label {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.data-status-value {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-exo2, ui-monospace, monospace);
  color: var(--el-text-color-primary);
}

.data-status-value.is-number {
  color: var(--el-color-primary);
}

.data-status-value.is-empty {
  color: var(--el-text-color-placeholder);
  font-weight: 400;
}

/* ===== 父子任务 wrapper ===== */
.task-section {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  overflow: hidden;
}

/* 子任务区用背景色自然区分，无需分割线 */

/* wrapper 内的 ParentTaskProgress 去掉自有边框 */
.task-section .parent-task-progress {
  border: none;
  border-radius: 0;
}

/* AgentTaskTree 在 wrapper 内时去掉边框和圆角 */
.task-section .tree-card {
  border: none;
  border-radius: 0;
}
</style>
