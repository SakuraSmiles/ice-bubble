<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { apiMonitor, type MonitorStats } from '../utils/monitor';
import PageHeader from '../components/PageHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import { api } from '../api/client';
import type { ModuleDTO } from '../api/client';

/**
 * Agent 概览接口，对接 Admin API /api/agents
 * （/api/agents/overview 不返回 avatar，改用 /api/agents）
 */
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

/**
 * Agent 运行时状态（用于控制动画和流式输出）
 */
interface AgentRuntimeState {
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 流式输出中的当前内容 */
  streamingContent: string;
  /** 上一次完整的消息（流式结束后用于从头显示） */
  lastCompleteMessage: string;
  /** 流式输出目标总长度（用于估算） */
  targetLength: number;
  /** 流式输出定时器 */
  streamTimer: ReturnType<typeof setTimeout> | null;
  /** 当前显示的消息（流式时用 streamingContent，结束后用 lastCompleteMessage） */
  displayMessage: string;
}

/** 每个 Agent 的运行时状态 */
const agentRuntimeStates = ref<Record<string, AgentRuntimeState>>({});

/** 消息元素引用（用于流式输出时滚动） */
const messageRefs = ref<Record<string, HTMLElement>>({});

// Agent 概览数据（来自 /api/agents，过滤工作/活跃）
const agentOverviewData = ref<{ agents: AgentOverview[] } | null>(null);

/** Token 统计数据（今日） */
const tokenStatsMap = ref<TokenStatsMap>({});

/**
 * 获取 Agent 概览数据（使用 /api/agents 以获得 avatar 字段）
 */
async function fetchAgentOverview() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    // /api/agents 返回 { agents: [...] }
    agentOverviewData.value = data;
    // 清理已消失 agent 的 runtime state，防止内存泄漏
    const currentAgentIds = new Set((data.agents ?? []).map((a: AgentOverview) => a.agent_id));
    for (const agentId of Object.keys(agentRuntimeStates.value)) {
      if (!currentAgentIds.has(agentId)) {
        const state = agentRuntimeStates.value[agentId];
        if (state.streamTimer) {
          clearTimeout(state.streamTimer);
        }
        delete agentRuntimeStates.value[agentId];
      }
    }
  } catch (e) {
    console.error('获取 Agent 概览失败', e);
  }
}

/**
 * 获取今日 Token 统计数据
 */
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
  } catch (e) {
    console.error('获取 Token 统计失败', e);
  }
}

/**
 * 获取 Agent 的 Token 消耗显示
 */
function getAgentTokenDisplay(agentId: string): string {
  const stats = tokenStatsMap.value[agentId];
  if (!stats) return '-';
  const total = stats.total_tokens_input + stats.total_tokens_output;
  if (total >= 1000000) {
    return (total / 1000000).toFixed(1) + 'M';
  } else if (total >= 1000) {
    return (total / 1000).toFixed(1) + 'K';
  }
  return total.toString();
}

/** 显示所有 agent，至少显示3个 */
const onlineAgents = computed(() => {
  const agents = agentOverviewData.value?.agents ?? [];
  // 优先显示在线的（工作/活跃/工作中），不够3个时补充离线的
  const online = agents.filter((a) => a.status === '工作' || a.status === '活跃' || a.status === '工作中');
  const offline = agents.filter((a) => a.status !== '工作' && a.status !== '活跃' && a.status !== '工作中');
  const combined = [...online, ...offline];
  // 至少显示3个
  return combined.slice(0, Math.max(3, combined.length));
});

/** 监听 agent 数据变化，检测消息更新 */
watch(agentOverviewData, (newData) => {
  if (!newData?.agents) return;
  for (const agent of newData.agents) {
    const state = getAgentRuntime(agent.agent_id);
    const cleanedMsg = (agent.latest_message || '').replace(/\s+/g, ' ').trim();
    
    // 检测消息是否变化
    if (cleanedMsg !== state.lastCompleteMessage && !state.isStreaming) {
      // 新消息且不在流式输出中，触发处理
      handleNewMessage(agent.agent_id, cleanedMsg, isWorkingStatus(agent.status));
    } else if (cleanedMsg !== state.lastCompleteMessage && state.isStreaming) {
      // 消息在流式输出过程中发生变化（如长消息分片到达），重启流式
      if (state.streamTimer) {
        clearTimeout(state.streamTimer);
        state.streamTimer = null;
      }
      handleNewMessage(agent.agent_id, cleanedMsg, isWorkingStatus(agent.status));
    } else if (state.isStreaming && !isWorkingStatus(agent.status)) {
      // 流式输出中但状态变为非工作，立即完成流式
      if (state.streamTimer) {
        clearTimeout(state.streamTimer);
        state.streamTimer = null;
      }
      state.isStreaming = false;
      state.streamingContent = '';
      state.displayMessage = state.lastCompleteMessage;
    }
  }
});

/** 头像 URL 构造（与 Agents.vue 共用同一逻辑） */
function getAvatarUrl(avatar: string | null): string | null {
  if (!avatar) return null;
  return `/api/resources/avatars/${avatar}`;
}

/**
 * 获取/初始化 Agent 运行时状态
 */
function getAgentRuntime(agentId: string): AgentRuntimeState {
  if (!agentRuntimeStates.value[agentId]) {
    agentRuntimeStates.value[agentId] = {
      isStreaming: false,
      streamingContent: '',
      lastCompleteMessage: '',
      targetLength: 0,
      streamTimer: null,
      displayMessage: ''
    };
  }
  return agentRuntimeStates.value[agentId];
}

/**
 * 处理新消息：检测是否需要流式输出
 * @param agentId agent ID
 * @param newMessage 新收到的完整消息
 * @param isWorking 是否处于工作中状态
 */
function handleNewMessage(agentId: string, newMessage: string, isWorking: boolean) {
  const state = getAgentRuntime(agentId);
  
  // 清理消息
  const cleanedMsg = (newMessage || '').replace(/\s+/g, ' ').trim();
  if (!cleanedMsg) {
    state.displayMessage = '';
    state.lastCompleteMessage = '';
    return;
  }
  
  // 如果正在流式输出，先停止
  if (state.streamTimer) {
    clearTimeout(state.streamTimer);
    state.streamTimer = null;
  }
  
  if (isWorking) {
    // 工作中状态：启动流式输出
    state.isStreaming = true;
    state.lastCompleteMessage = cleanedMsg;
    state.targetLength = cleanedMsg.length;
    startStreaming(agentId, cleanedMsg);
  } else {
    // 非工作中（活跃/完成）：直接显示完整消息
    state.isStreaming = false;
    state.streamingContent = '';
    state.displayMessage = cleanedMsg;
    state.lastCompleteMessage = cleanedMsg;
  }
}

/**
 * 启动流式输出效果
 */
function startStreaming(agentId: string, fullMessage: string) {
  const state = getAgentRuntime(agentId);
  const chars = fullMessage.split('');
  let currentIndex = 0;
  const BASE_SPEED = 15; // 基础速度：每字符15ms
  const MIN_DELAY = 5;
  const MAX_DELAY = 50;
  
  function streamNext() {
    if (currentIndex >= chars.length) {
      // 流式输出完成，切换到完整显示（回到首行）
      state.isStreaming = false;
      state.streamingContent = '';
      state.displayMessage = state.lastCompleteMessage;
      state.streamTimer = null;
      // 流式完成，滚动回顶部
      scrollMessageToTop(agentId);
      return;
    }
    
    currentIndex++;
    state.streamingContent = chars.slice(0, currentIndex).join('');
    state.displayMessage = state.streamingContent;
    
    // 模拟打字机效果：随机速度模拟人类输入节奏
    const delay = MIN_DELAY + Math.random() * Math.min(MAX_DELAY, BASE_SPEED * Math.pow(1.05, currentIndex));
    state.streamTimer = setTimeout(() => streamNext(), delay);
    
    // 流式输出时滚动到底部（下一帧执行）
    nextTick(() => scrollMessageToBottom(agentId));
  }
  
  streamNext();
}

/**
 * 滚动消息到底部（流式输出时可见最新内容）
 */
function scrollMessageToBottom(agentId: string) {
  const el = messageRefs.value[agentId];
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * 滚动消息到顶部（流式完成后）
 */
function scrollMessageToTop(agentId: string) {
  const el = messageRefs.value[agentId];
  if (el) {
    el.scrollTop = 0;
  }
}

/**
 * 检测 Agent 状态是否为"工作中"
 */
function isWorkingStatus(status: string): boolean {
  return status === '工作' || status === '工作中';
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
  fetchTokenStats();
  refreshData();
  refreshModules();
  // 定时刷新数据
  refreshTimer = setInterval(() => {
    refreshData();
    refreshModules();
  }, 5000);
  // Agent 概览每 30 秒刷新一次
  agentRefreshTimer = setInterval(() => {
    fetchAgentOverview();
    fetchTokenStats();
  }, 30000);
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
  // 清理所有流式输出定时器
  for (const state of Object.values(agentRuntimeStates.value)) {
    if (state.streamTimer) {
      clearTimeout(state.streamTimer);
      state.streamTimer = null;
    }
  }
});

// 监听模块列表变化，更新maxModuleLatency
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

          <!-- Agent 概览 -->
          <div class="agent-list">
              <div class="agent-item" :class="{ 'is-working': isWorkingStatus(agent.status) }" v-for="agent in onlineAgents" :key="agent.agent_id">
                <div class="agent-top">
                  <div class="avatar-wrapper" :class="{ 'is-working': isWorkingStatus(agent.status) }">
                    <el-avatar v-if="getAvatarUrl(agent.avatar)"
                      :size="36"
                      :src="getAvatarUrl(agent.avatar)!"
                      fit="cover"
                      class="agent-avatar"
                    />
                    <el-avatar v-else
                      :size="36"
                      fit="cover"
                      class="agent-avatar"
                      style="color: var(--color-accent-blue); font-size: 14px;"
                    >
                      {{ agent.agent_id.substring(0, 1).toUpperCase() }}
                    </el-avatar>
                    <!-- 状态指示器 -->
                    <span class="status-dot" :class="'status-dot--' + agent.status"></span>
                  </div>
                  <span class="agent-name">{{ agent.agent_name || agent.agent_id }}</span>
                  <el-tag
                    size="small"
                    effect="plain"
                    class="agent-model-tag"
                  >
                    {{ getAgentTokenDisplay(agent.agent_id) }}
                  </el-tag>
                </div>
                <div class="agent-msg-wrapper">
                  <div 
                    class="agent-msg"
                    :class="{ 
                      'agent-msg--streaming': getAgentRuntime(agent.agent_id).isStreaming,
                      'agent-msg--empty': !getAgentRuntime(agent.agent_id).displayMessage
                    }"
                    :ref="el => { if (el) messageRefs[agent.agent_id] = el as HTMLElement }"
                  >
                    <template v-if="getAgentRuntime(agent.agent_id).displayMessage">{{ getAgentRuntime(agent.agent_id).displayMessage }}</template>
                    <template v-else>暂无输出</template>
                  </div>
                </div>
              </div>
              <el-empty v-if="onlineAgents.length === 0" description="暂无在线 Agent" :image-size="40" />
            </div>
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
  gap: 8px;
}

.agent-item {
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-extra-light);
  height: 120px;
  overflow: hidden;
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

/* 消息区域 wrapper - 固定高度用于流式滚动 */
.agent-item .agent-msg-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding-left: 8px;
  margin-top: 8px;  /* 与头像区域保持间距 */
}

.agent-item .agent-msg {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
  /* 多行截断（3行） */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  word-break: break-word;
  flex: 1;
  min-height: 0;
}

/* 流式输出时：保持3行高度，持续滚动显示最新内容（终端效果） */
.agent-item .agent-msg--streaming {
  color: var(--el-text-color-primary);
  -webkit-line-clamp: unset;
  overflow-y: hidden;  /* 隐藏滚动条 */
  text-overflow: initial;
  white-space: pre-wrap;
  flex: 1;
}

.agent-item .agent-msg--empty {
  color: var(--el-text-color-placeholder);
  font-style: italic;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

/* 闪烁光标（流式输出时） */
.agent-item .agent-msg--streaming::after {
  content: '▍';
  display: inline;
  animation: blink 0.8s step-end infinite;
  color: var(--color-accent-blue);
  margin-left: 1px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* 工作中状态动画 - 整体设计 */
.avatar-wrapper {
  position: relative;
  display: inline-flex;
}

/* 工作中：头像蓝色边框呼吸 */
.avatar-wrapper.is-working .agent-avatar {
  border-color: var(--color-accent-blue);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
  animation: avatar-working 2s ease-in-out infinite;
}

@keyframes avatar-working {
  0%, 100% {
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
    border-color: var(--color-accent-blue);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.25);
    border-color: var(--color-accent-blue);
  }
}

/* 状态指示器（头像右上角） */
.avatar-wrapper .status-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--el-bg-color);
  border-radius: 50%;
}

/* 状态颜色 */
.status-dot--工作,
.status-dot--活跃 { background: var(--el-color-success); }
.status-dot--休假 { background: var(--el-color-warning); }
.status-dot--离线 { background: var(--el-color-info); }
.status-dot--失联 { background: var(--el-color-danger); }
.status-dot--工作中 { background: var(--el-color-success); }

/* 工作中状态：圆点呼吸动画 */
.avatar-wrapper.is-working .status-dot {
  animation: dot-breathe 1.5s ease-in-out infinite;
}

@keyframes dot-breathe {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.4);
  }
  50% {
    transform: scale(1.15);
    opacity: 0.85;
    box-shadow: 0 0 0 4px rgba(64, 158, 255, 0);
  }
}

/* 工作中卡片 - 四边流光边框效果 */
.agent-item.is-working {
  position: relative;
  background: var(--el-fill-color-light);
}

/* 流光边框 - 光线沿边框流动效果 */
.agent-item.is-working::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 8px;
  padding: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(64, 158, 255, 0.6) 30%,
    #409eff 50%,
    rgba(64, 158, 255, 0.6) 70%,
    transparent 100%
  );
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
