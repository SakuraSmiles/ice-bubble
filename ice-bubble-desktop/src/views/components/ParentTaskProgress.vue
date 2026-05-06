<script setup lang="ts">
import { computed } from 'vue';
import { API_BASE } from '../../config';
import type { TaskItemDTO, ParentTaskDTO, AgentDTO } from '../../api/client';

// =========== Props ===========

interface Props {
  parentTask: ParentTaskDTO | null;
  agents?: AgentDTO[];
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  parentTask: null,
  agents: () => [],
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
  if (!props.parentTask?.agent_groups) return [] as TaskItemDTO[];
  const items: TaskItemDTO[] = [];
  for (const g of props.parentTask.agent_groups) {
    items.push(...(g.active_children || []));
    items.push(...(g.completed_children || []));
  }
  return items;
});

/** 是否有子任务 */
const hasChildren = computed(() => allChildren.value.length > 0);

/** 涉及到的 agent 列表（main 永远显示 + 实际执行者） */
const involvedAgents = computed(() => {
  if (!props.agents) return [] as AgentDTO[];
  const result: AgentDTO[] = [];
  const seen = new Set<string>();
  // main 永远排第一（任务发起者）
  const mainAgent = props.agents.find(a => a.agent_id === 'main');
  if (mainAgent) {
    result.push(mainAgent);
    seen.add('main');
  }
  // 追加实际派发的子 agent
  if (props.parentTask?.agent_groups) {
    for (const g of props.parentTask.agent_groups) {
      if (seen.has(g.agent_id)) continue;
      const agent = props.agents.find(a => a.agent_id === g.agent_id);
      if (agent) {
        result.push(agent);
        seen.add(g.agent_id);
      }
    }
  }
  return result;
});

/** 获取 agent 头像 URL */
function getAvatarUrl(agent: AgentDTO): string {
  if (agent.avatar) return `${API_BASE}/resources/avatars/${agent.avatar}`;
  return `${API_BASE}/resources/avatars/${agent.agent_id}.png`;
}

/** 进度标签 */
const progressLabel = computed(() => {
  if (!hasChildren.value) {
    // 无子任务时：父任务自身算 1 个任务项
    const done = props.parentTask?.status === 'completed' || props.parentTask?.status === 'DONE';
    return done ? '1/1' : '0/1';
  }
  const tasks = allChildren.value;
  const done = tasks.filter(t => t.status === 'DONE' || t.status === 'completed').length;
  return `${done}/${tasks.length}`;
});

/** 状态标签列表 */
const statusTags = computed(() => {
  if (!hasChildren.value) {
    // 无子任务时：一个点代表父任务自身
    const done = props.parentTask?.status === 'completed' || props.parentTask?.status === 'DONE';
    return [{ done }];
  }
  const tasks = allChildren.value;
  return tasks.map(t => ({
    done: t.status === 'DONE' || t.status === 'completed',
  }));
});
</script>

<template>
  <el-skeleton v-if="loading" :rows="1" animated style="padding: 10px; background: var(--el-fill-color-light); border-radius: 6px;" />
  <div v-else-if="parentTask" class="parent-task-progress">
    <div class="parent-task-title">{{ truncateTaskTitle(parentTask.title, 35) }}</div>
    <!-- 涉及的 Agent 头像（半堆叠效果） -->
    <div v-if="involvedAgents.length > 0" class="agent-avatars">
      <img
        v-for="(agent, i) in involvedAgents"
        :key="agent.agent_id"
        :src="getAvatarUrl(agent)"
        :alt="agent.agent_name ?? undefined"
        :title="agent.agent_name ?? undefined"
        class="agent-avatar-stack"
        :style="{ zIndex: involvedAgents.length - i }"
        @error="($event.target as HTMLImageElement).style.display='none'"
      />
    </div>
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
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  transition: border-color 0.2s;
}

.parent-task-progress:hover {
  border-color: var(--el-border-color);
}

.parent-task-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
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
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-border-color-lighter);
  transition: background 0.25s ease, transform 0.2s ease;
  flex-shrink: 0;
}

.dot.done {
  background: var(--el-color-success);
}

.progress-label {
  font-size: 12px;
  font-family: var(--font-exo2, monospace);
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
  font-weight: 500;
}

/* Agent 头像半堆叠 */
.agent-avatars {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
  padding-left: 0;
}

.agent-avatar-stack {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--el-bg-color);
  object-fit: cover;
  margin-left: -6px;
  transition: transform 0.15s ease, margin-left 0.15s ease;
  background: var(--el-fill-color-light);
  flex-shrink: 0;
}

.agent-avatar-stack:first-child {
  margin-left: 0;
}

.agent-avatar-stack:hover {
  transform: translateY(-2px) scale(1.15);
  margin-right: 4px;
  z-index: 999 !important;
}
</style>
