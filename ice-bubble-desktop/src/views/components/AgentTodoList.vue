<script setup lang="ts">
import LoadingSkeleton from './LoadingSkeleton.vue';
import { formatRelativeTime } from '../../utils/format';
import type { TaskItemDTO, ParentTaskDTO, AgentDTO } from '../../api/client';

// =========== Props ===========

interface Props {
  parentTask: ParentTaskDTO | null;
  agents: AgentDTO[];
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
function getAgentTasks(agentId: string): TaskItemDTO[] {
  if (!props.parentTask?.agent_groups) return [];
  const group = props.parentTask.agent_groups.find(g => g.agent_id === agentId);
  if (!group) return [];
  return [...(group.active_children || []), ...(group.completed_children || [])];
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
                <span v-if="task.status === 'IN_PROGRESS' || task.status === 'in_progress'" class="todo-spinner"></span>
              </span>
              <span class="todo-title" :title="task.title">{{ truncateTaskTitle(task.title) }}</span>
              <span v-if="task.status === 'DONE' || task.status === 'completed'" class="todo-time">{{ formatRelativeTime(task.updated_at ?? null) }}</span>
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
  gap: 8px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-primary);
  transition: background 0.15s;
}

.todo-item:hover {
  background: var(--el-fill-color-lighter);
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
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
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
  opacity: 0.4;
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
  background: var(--el-color-success);
  border: none;
  color: white;
}

@keyframes todo-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.todo-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.todo-time {
  margin-left: auto;
  padding-left: 8px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
}

.todo-empty {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  text-align: center;
  padding: 14px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
</style>
