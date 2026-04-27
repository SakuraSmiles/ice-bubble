<script setup lang="ts">
import { ref } from 'vue';
import AgentTodoList from './AgentTodoList.vue';
import type { TaskItemDTO, ParentTaskDTO, AgentDTO } from '../../api/client';

// =========== Props ===========

interface Props {
  agents: AgentDTO[];
  parentTask: ParentTaskDTO | null;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  agents: () => [],
  parentTask: null,
  loading: false,
});

// =========== 工具函数 ===========

/** 获取指定 agent 的所有子任务 */
function getAgentTasks(agentId: string): TaskItemDTO[] {
  if (!props.parentTask?.agent_groups) return [];
  const group = props.parentTask.agent_groups.find(g => g.agent_id === agentId);
  if (!group) return [];
  return [...(group.active_children || []), ...(group.completed_children || [])];
}

// =========== 计算属性 ===========

/** 获取单个 agent 的任务进度 */
function getAgentProgress(agentId: string): { done: number; total: number } {
  const tasks = getAgentTasks(agentId);
  const done = tasks.filter(t => t.status === 'DONE' || t.status === 'completed').length;
  return { done, total: tasks.length };
}

/** 获取 agent 的进度迷你点 */
function getAgentMiniDots(agentId: string): { filled: number; total: number } {
  const { done, total } = getAgentProgress(agentId);
  const displayTotal = Math.min(total, 5);
  const filled = total === 0 ? 0 : Math.round((done / total) * displayTotal);
  return { filled, total: displayTotal };
}

/** Agent 状态映射为显示文本 */
function getStatusLabel(status: import("../../api/client").AgentStatus): string {
  if (status === '工作') return '工作中';
  if (status === '活跃') return '活跃';
  if (status === '离线') return '离线';
  return status;
}

// =========== 展开状态管理 ===========

/** 该 agent 是否有子任务 */
function hasTasks(agentId: string): boolean {
  const { total } = getAgentProgress(agentId);
  return total > 0;
}

/** 过滤出有子任务的 agent */
function filterWithTasks(agents: AgentDTO[]): AgentDTO[] {
  return agents.filter(a => hasTasks(a.agent_id));
}

/** 检测是否工作中/活跃状态 */
function isActiveStatus(status: import("../../api/client").AgentStatus): boolean {
  return status === '工作' || status === '活跃';
}

/** 默认展开状态：工作中/活跃的展开，离线的折叠 */
function getDefaultExpanded(agent: AgentDTO): boolean {
  return isActiveStatus(agent.status);
}

/** 初始化展开状态映射 */
const expandedAgents = ref<Record<string, boolean>>({});

/** 确保某 agent 有展开状态记录 */
function ensureExpanded(agentId: string, agent: AgentDTO) {
  if (expandedAgents.value[agentId] === undefined) {
    expandedAgents.value[agentId] = getDefaultExpanded(agent);
  }
}

/** 切换展开/折叠 */
function toggleExpand(agentId: string, agent: AgentDTO) {
  ensureExpanded(agentId, agent);
  expandedAgents.value[agentId] = !expandedAgents.value[agentId];
}

/** 获取 agent 展开状态 */
function isExpanded(agentId: string, agent: AgentDTO): boolean {
  ensureExpanded(agentId, agent);
  return expandedAgents.value[agentId];
}
</script>

<template>
  <div class="agent-task-tree">
    <!-- 骨架屏 -->
    <div v-if="loading" class="tree-loading">
      <div class="skeleton-header"></div>
      <div class="skeleton-row" v-for="i in 3" :key="i"></div>
    </div>

    <!-- 主体内容 -->
    <template v-else>
      <!-- Agent 列表 -->
      <div class="tree-card">
      <div class="tree-list">
        <div
          class="tree-agent-row"
          v-for="agent in filterWithTasks(agents)"
          :key="agent.agent_id"
          :class="{ 'is-active': isActiveStatus(agent.status) }"
        >
          <!-- Agent 行（可点击展开/折叠） -->
          <div class="tree-agent-header" @click="toggleExpand(agent.agent_id, agent)">
            <!-- Agent 名称 -->
            <span class="agent-name">{{ agent.agent_name || agent.agent_id }}</span>

            <!-- 进度迷你点 -->
            <span class="mini-dots">
              <span
                v-for="i in getAgentMiniDots(agent.agent_id).total"
                :key="i"
                class="mini-dot"
                :class="{ 'is-filled': i <= getAgentMiniDots(agent.agent_id).filled }"
              ></span>
            </span>

            <!-- 完成数/总数 -->
            <span class="agent-count">
              {{ getAgentProgress(agent.agent_id).done }}/{{ getAgentProgress(agent.agent_id).total }}
            </span>

            <!-- 状态标签 -->
            <span class="agent-status-tag" :class="'status-tag--' + agent.status">
              {{ getStatusLabel(agent.status) }}
            </span>

            <!-- 展开/折叠图标 (右侧) -->
            <span class="expand-icon" :class="{ 'is-expanded': isExpanded(agent.agent_id, agent) }"></span>
          </div>

          <!-- 展开的子任务列表 -->
          <Transition name="tree-expand">
            <div class="tree-agent-children" v-if="isExpanded(agent.agent_id, agent)">
              <AgentTodoList
                :parent-task="parentTask"
                :agents="[agent]"
                :loading="loading"
              />
            </div>
          </Transition>
        </div>
      </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 容器 */
.agent-task-tree {
  display: flex;
  flex-direction: column;
  gap: 0;
  background: transparent;
}

/* 与 ParentTaskProgress 无缝拼接的卡片 */
.tree-card {
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-light);
  border-top: none;
  border-radius: 0 0 6px 6px;
}

/* 骨架屏 */
.tree-loading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
}

.skeleton-header {
  height: 18px;
  background: var(--el-fill-color);
  border-radius: 4px;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.skeleton-row {
  height: 30px;
  background: var(--el-fill-color);
  border-radius: 4px;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 迷你进度点 */
.mini-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}

.mini-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  transition: background 0.2s, border-color 0.2s;
}

.mini-dot.is-filled {
  background: var(--el-color-success);
  border-color: var(--el-color-success);
}

/* Agent 列表 */
.tree-list {
  display: flex;
  flex-direction: column;
  background: transparent;
}

/* Agent 行 */
.tree-agent-row {
  display: flex;
  flex-direction: column;
  /* 行分隔线 — 参考 GitHub PR/issue list 风格 */
  border-bottom: 1px solid var(--el-border-color-lightest);
}

.tree-agent-row:last-child {
  border-bottom: none;
}

.tree-agent-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  background: transparent;
}

.tree-agent-header:hover {
  background: var(--el-fill-color-lighter);
}

/* 展开图标 — 纯 CSS chevron（右侧） */
.expand-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.expand-icon::before {
  content: '';
  display: block;
  width: 5px;
  height: 5px;
  border-right: 2px solid var(--el-text-color-secondary);
  border-bottom: 2px solid var(--el-text-color-secondary);
  transform: rotate(-45deg);
  transition: transform 0.2s ease;
}

.expand-icon.is-expanded::before {
  transform: rotate(45deg);
}

/* Agent 名称 */
.agent-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  flex: none;
  margin-right: auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 完成数/总数 */
.agent-count {
  font-family: var(--font-exo2, monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

/* 状态标签 */
.agent-status-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.status-tag--工作,
.status-tag--工作中 {
  background: var(--el-color-success-light);
  color: var(--el-color-success);
}

.status-tag--活跃 {
  background: var(--el-color-primary-light);
  color: var(--el-color-primary);
}

.status-tag--休假 {
  background: var(--el-color-warning-light);
  color: var(--el-color-warning);
}

.status-tag--离线 {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.status-tag--失联 {
  background: var(--el-color-danger-light);
  color: var(--el-color-danger);
}

/* 子任务展开区 */
.tree-agent-children {
  padding: 8px 14px;
  background: var(--el-bg-color);
  border-radius: 8px;
  margin: 6px 14px;
}

/* 展开过渡动画 */
.tree-expand-enter-active,
.tree-expand-leave-active {
  transition: opacity 0.2s ease, max-height 0.25s ease;
  overflow: hidden;
}

.tree-expand-enter-from,
.tree-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.tree-expand-enter-to,
.tree-expand-leave-from {
  opacity: 1;
  max-height: 600px;
}
</style>
