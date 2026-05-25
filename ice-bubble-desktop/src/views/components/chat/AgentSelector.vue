<script setup lang="ts">
import { ref, computed } from 'vue';

export interface AgentOption {
  platform: 'openclaw' | 'opencode';
  agent: string;
  label: string;
  emoji: string;
  tag: string;
}

const props = defineProps<{
  modelValue: AgentOption;
  disabled?: boolean;
  agents: AgentOption[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: AgentOption];
}>();

const isOpen = ref(false);

function select(opt: AgentOption) {
  emit('update:modelValue', opt);
  isOpen.value = false;
}

// 按平台分组
const groupedAgents = computed(() => {
  const groups: { platform: string; tag: string; items: AgentOption[] }[] = [];
  const platformNames: Record<string, string> = {
    openclaw: 'OpenClaw',
    opencode: 'OpenCode',
  };
  for (const a of props.agents) {
    const last = groups[groups.length - 1];
    if (last && last.platform === a.platform) {
      last.items.push(a);
    } else {
      groups.push({ platform: a.platform, tag: platformNames[a.platform] || a.platform, items: [a] });
    }
  }
  return groups;
});

// 当前显示文本
const displayLabel = computed(() => {
  const v = props.modelValue;
  return v.label || v.agent || '选择 Agent';
});
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled" @command="select" v-model:visible="isOpen">
    <button
      class="agent-selector-btn"
      :class="{ 'is-open': isOpen }"
      @click="isOpen = !isOpen"
    >
      <span class="agent-label">{{ displayLabel }}</span>
      <svg class="agent-arrow" width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <template #dropdown>
      <el-dropdown-menu class="agent-dropdown-menu">
        <template v-for="(group, gi) in groupedAgents" :key="group.platform">
          <el-dropdown-item
            v-if="gi > 0"
            divided
            disabled
            class="agent-group-header"
          >
            {{ group.tag }}
          </el-dropdown-item>
          <el-dropdown-item
            v-for="opt in group.items"
            :key="opt.platform + ':' + opt.agent"
            :command="opt"
            :class="{ 'is-active': modelValue.platform === opt.platform && modelValue.agent === opt.agent }"
          >
            <span class="opt-name">{{ opt.label }}</span>
          </el-dropdown-item>
        </template>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.agent-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 34px;
  min-width: 100px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.9);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
  flex-shrink: 0;
}
.agent-selector-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
}
.agent-selector-btn.is-open {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.14);
}
.agent-label {
  font-weight: 500;
  white-space: nowrap;
}
.agent-arrow {
  flex-shrink: 0;
  opacity: 0.35;
  transition: transform 0.2s;
}
.is-open .agent-arrow {
  transform: rotate(180deg);
}
</style>

<style>
.agent-dropdown-menu {
  border: 1px solid var(--el-border-color-darker, rgba(255,255,255,0.08)) !important;
  border-radius: 8px !important;
  padding: 4px !important;
  min-width: 130px;
}
.agent-dropdown-menu .el-dropdown-menu__item {
  color: var(--el-text-color-primary, rgba(255,255,255,0.85)) !important;
  border-radius: 5px !important;
  padding: 6px 10px !important;
  line-height: 1.4 !important;
  height: auto !important;
  font-size: 13px !important;
}
.agent-dropdown-menu .el-dropdown-menu__item:hover {
  background: var(--el-fill-color-light, rgba(255,255,255,0.1)) !important;
}
.agent-dropdown-menu .el-dropdown-menu__item.is-active {
  background: var(--el-fill-color, rgba(255,255,255,0.06)) !important;
}
/* 平台分组标题 */
.agent-dropdown-menu .agent-group-header {
  font-size: 11px !important;
  opacity: 0.45 !important;
  letter-spacing: 0.5px;
  padding: 8px 10px 2px !important;
  cursor: default !important;
}
.agent-dropdown-menu .agent-group-header:hover {
  background: transparent !important;
}

.opt-name {
  font-weight: 500;
  font-size: 13px;
}
</style>
