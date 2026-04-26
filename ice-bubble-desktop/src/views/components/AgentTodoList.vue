<script setup lang="ts">
import LoadingSkeleton from './LoadingSkeleton.vue';

// =========== 类型定义 ===========
// 与 Overview.vue 保持一致（status 用 string，兼容新旧数据格式）

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

interface Props {
  parentTask: ParentTask | null;
  agents: AgentOverview[];
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  parentTask: null,
  agents: () => [],
  loading: false,
});

// =========== 工具函数 ===========

/** 截断任务标题，去除 Markdown 标记 */
function truncateTaskTitle(title: string, maxLen: number = 35): string {
  if (!title) return '';
  const cleaned = title.replace(/^#+\s+/gm, '').trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '...';
}

/** 获取指定 agent 在该父任务下的所有子任务 */
function getAgentTasks(agentId: string): TaskItem[] {
  if (!props.parentTask?.agent_groups) return [];
  const group = props.parentTask.agent_groups.find(g => g.agent_id === agentId);
  if (!group) return [];
  return [...(group.active_children || []), ...(group.completed_children || [])];
}

/** 格式化相对时间 */
function formatRelativeTime(isoStr: string | undefined): string {
  if (!isoStr) return '';
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h前`;
  const days = Math.floor(hours / 24);
  return `${days}d前`;
}


</script>

<template>
  <!-- 骨架屏 -->
  <LoadingSkeleton v-if="loading" type="card" height="120px" />

  <!-- 有数据时渲染 -->
  <template v-else>
    <div class="agent-list">
      <div class="agent-item" v-for="agent in agents" :key="agent.agent_id">
        <div class="agent-todo-list">
          <template v-if="getAgentTasks(agent.agent_id).length > 0">
            <div
              class="todo-item"
              :class="'todo-item--' + task.status.toLowerCase()"
              v-for="task in getAgentTasks(agent.agent_id)"
              :key="task.task_id"
            >
              <span class="todo-dot" :class="'todo-dot--' + task.status.toLowerCase()">
                <span v-if="task.status === 'DONE' || task.status === 'completed'" class="todo-checkmark">✓</span>
                <span v-else-if="task.status === 'IN_PROGRESS' || task.status === 'in_progress'" class="todo-spinner"></span>
              </span>
              <span class="todo-title" :title="task.title">{{ truncateTaskTitle(task.title) }}</span>
              <span v-if="task.status === 'DONE' || task.status === 'completed'" class="todo-time">{{ formatRelativeTime(task.updated_at) }}</span>
            </div>
          </template>
          <div v-else class="todo-empty">暂无任务</div>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* Agent 列表 */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-item {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  background: transparent;
  border: none;
  min-height: auto;
  overflow: hidden;
}

/* 任务列表 */
.agent-todo-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding-left: 8px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-primary);
}

.todo-item--todo .todo-title,
.todo-item--pending .todo-title {
  color: var(--el-text-color-secondary);
}

.todo-item--in_progress .todo-title,
.todo-item--in-progress .todo-title {
  color: var(--el-color-primary);
}

.todo-item--done .todo-title,
.todo-item--completed .todo-title {
  text-decoration: line-through;
  color: var(--el-text-color-placeholder);
}

.todo-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  position: relative;
}

.todo-dot--todo,
.todo-dot--pending {
  border: 1.5px solid var(--el-text-color-placeholder);
  background: transparent;
}

.todo-dot--in_progress,
.todo-dot--in-progress {
  border: 2px solid;
  border-color: var(--el-color-primary) transparent var(--el-color-primary) var(--el-color-primary);
  animation: todo-spin 0.8s linear infinite;
  background: transparent;
}

.todo-dot--done,
.todo-dot--completed {
  border: 1.5px solid var(--el-text-color-placeholder);
  background: transparent;
  color: var(--el-color-success);
}

.todo-checkmark {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 800;
  line-height: 0;
  margin-top: -6px;
  margin-left: 2px;
}

@keyframes todo-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.todo-title {
  word-break: break-word;
}

.todo-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
}

.todo-empty {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  text-align: center;
  padding: 8px 4px;
}
</style>
