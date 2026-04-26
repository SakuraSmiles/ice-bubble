<script setup lang="ts">
import { computed } from 'vue';

// =========== 类型定义 ===========

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

interface Props {
  parentTask: ParentTask | null;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  parentTask: null,
  loading: false,
});

// =========== 工具函数 ===========

/** 截断任务标题 */
function truncateTaskTitle(title: string, maxLen: number = 35): string {
  if (!title) return '';
  const cleaned = title.replace(/^#+\s+/gm, '').trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '…';
}

/** 获取所有子任务（平铺） */
const allChildren = computed(() => {
  if (!props.parentTask?.agent_groups) return [] as TaskItem[];
  const items: TaskItem[] = [];
  for (const g of props.parentTask.agent_groups) {
    items.push(...(g.active_children || []));
    items.push(...(g.completed_children || []));
  }
  return items;
});

/** 进度标签 */
const progressLabel = computed(() => {
  const tasks = allChildren.value;
  const done = tasks.filter(t => t.status === 'DONE' || t.status === 'completed').length;
  return `${done}/${tasks.length}`;
});

/** 状态标签列表 */
const statusTags = computed(() => {
  const tasks = allChildren.value;
  return tasks.map(t => ({
    done: t.status === 'DONE' || t.status === 'completed',
  }));
});
</script>

<template>
  <el-skeleton v-if="loading" :rows="1" animated style="padding: 10px; background: var(--el-fill-color-light); border-radius: 6px;" />
  <div v-else-if="parentTask && allChildren.length > 0" class="parent-task-progress">
    <div class="parent-task-title">{{ truncateTaskTitle(parentTask.title, 35) }}</div>
    <div class="progress-row">
      <div class="progress-dots">
        <span
          v-for="(tag, i) in statusTags"
          :key="i"
          class="dot"
          :class="{ done: tag.done }"
        />
      </div>
      <span class="progress-label">{{ progressLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.parent-task-progress {
  padding: 10px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  transition: border-color 0.2s;
}

.parent-task-progress:hover {
  border-color: var(--el-border-color);
}

.parent-task-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-dots {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-border-color-lighter);
  transition: background 0.25s ease, transform 0.2s ease;
  flex-shrink: 0;
}

.dot.done {
  background: var(--el-color-success);
  transform: scale(1.15);
  box-shadow: 0 0 0 1.5px rgba(26, 127, 55, 0.15);
}

.progress-label {
  font-size: 11px;
  font-family: var(--font-exo2, monospace);
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
  font-weight: 500;
}
</style>
