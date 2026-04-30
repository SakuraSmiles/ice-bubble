<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO, TimelineResponseDTO, WorkspaceTasksDTO, AgentDTO, ParentTaskDTO, AgentGroupDTO } from '../api/client';
// 子组件
import StatusDropdown from './components/StatusDropdown.vue';
import RecentSessions from './components/RecentSessions.vue';
import AgentTaskTree from './components/AgentTaskTree.vue';
import ParentTaskProgress from './components/ParentTaskProgress.vue';
import TaskList from './components/TaskList.vue';
import ChatPanel from './components/ChatPanel.vue';


// =========== 接口定义 ===========

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
const agentOverviewData = ref<{ agents: AgentDTO[] } | null>(null);



// =========== 最近任务模块相关 ===========

// TaskItemDTO, AgentGroupDTO, ParentTaskDTO 已从 api/client 导入
// WorkspaceTasksDTO === WorkspaceTasks


const workspaceTasks = ref<WorkspaceTasksDTO | null>(null);
const latestTaskLoading = ref(false);

// =========== 数据状态卡片 ===========

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
    const res = await fetch('/api/messages/timeline?limit=1');
    if (!res.ok) return;
    const data: TimelineResponseDTO = await res.json();
    extractDataStatus(data);
  } catch {
    // 静默忽略，等待下次轮询
  }
}

/** 获取工作区任务（按父任务聚合） */
async function fetchLatestTask(): Promise<void> {
  latestTaskLoading.value = true;
  try {
    const data = await api.getWorkspaceTasks();
    workspaceTasks.value = data as WorkspaceTasksDTO;
  } catch (e) {
    console.error('获取工作区任务失败', e);
    workspaceTasks.value = null;
  } finally {
    latestTaskLoading.value = false;
  }
}

/** 最近的父任务（按 updated_at 排序取第一个） */
const recentParentTask = computed<ParentTaskDTO | null>(() => {
  const parents = workspaceTasks.value?.parents ?? [];
  if (!parents.length) return null;
  return [...parents].sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )[0];
});

/** 最近父任务是否包含子任务 */
const hasSubTasks = computed(() => {
  const groups = recentParentTask.value?.agent_groups ?? [];
  return groups.some((g: AgentGroupDTO) =>
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
    .sort((a, b) => (new Date(b.last_active_at ?? 0).getTime()) - (new Date(a.last_active_at ?? 0).getTime()));
  // 不足 3 个时用最近活跃离线 agent 补充
  if (working.length >= 3) return working;
  const offline = agents
    .filter(a => a.status !== '活跃' && !isWorkingStatus(a.status))
    .sort((a, b) => (new Date(b.last_active_at ?? 0).getTime()) - (new Date(a.last_active_at ?? 0).getTime()));
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
    // 30s 任务：fetchAgentOverview + fetchLatestTask + fetchDataStatus（每 3 ticks）
    if (tickCounter % 3 === 0) {
      pollPending = true;
      fetchAgentOverview();
      fetchLatestTask().finally(() => { pollPending = false; });
      pollPending = true;
      fetchDataStatus().finally(() => { pollPending = false; });
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
    const data = await api.getAgents();
    agentOverviewData.value = data;
    // 清理已消失 agent 的 runtime state
    const currentIds = new Set((data.agents ?? []).map((a) => a.agent_id));
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
  startPolling();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  for (const s of Object.values(agentRuntimeStates.value)) {
    if (s.streamTimer) { clearTimeout(s.streamTimer); s.streamTimer = null; }
  }
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

    <el-card class="content-area" shadow="never">
      <div class="main-layout">
        <!-- 左侧面板 -->
        <div class="left-panel">
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

          <!-- 任务列表 -->
          <TaskList />
        </div>

        <!-- 右侧：最近会话 + 聊天面板 -->
        <div class="right-panel">
          <RecentSessions :loading="loading" />
          <div class="chat-section">
            <ChatPanel />
          </div>
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
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 左右分栏布局 */
.main-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 左侧面板 */
.left-panel {
  width: 24%;
  min-width: 280px;
  height: calc(100vh - 200px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
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
  height: calc(100vh - 200px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
}

.chat-section {
  flex: 1;
  min-height: 0;
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

/* ===== 父子任务 wrapper ===== */
.task-section {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  max-height: 40%;
  overflow-y: auto;
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
