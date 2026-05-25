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

const groupedAgents = computed(() => {
  const groups: { platform: string; tag: string; items: AgentOption[] }[] = [];
  const platformNames: Record<string, string> = { openclaw: 'OpenClaw', opencode: 'OpenCode' };
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

const displayLabel = computed(() => {
  const v = props.modelValue;
  return v.label || v.agent || '选择 Agent';
});
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled" @command="select" @visible-change="(v: boolean) => isOpen = v" :popper-class="'agent-dropdown-popper'">
    <button class="agent-selector-btn" :class="{ 'is-open': isOpen }">
      <span class="agent-label">{{ displayLabel }}</span>
      <svg class="agent-arrow" width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <template #dropdown>
      <el-dropdown-menu size="small">
        <template v-for="(group, gi) in groupedAgents" :key="group.platform">
          <el-dropdown-item :divided="gi > 0" disabled class="agent-group-header">
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
/* ── trigger 按钮 ── */
.agent-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 8px 0 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  color: #555;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
  flex-shrink: 0;
  font-family: inherit;
  margin: 0;
  outline: none;
}
.agent-selector-btn:hover,
.agent-selector-btn:focus-visible {
  color: #333;
  background: rgba(0, 0, 0, 0.05);
  border-color: rgba(0, 0, 0, 0.18);
}
.agent-selector-btn.is-open {
  color: #333;
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.2);
}

.agent-label {
  font-weight: 500;
  white-space: nowrap;
}

.agent-arrow {
  flex-shrink: 0;
  opacity: 0.4;
  transition: transform 0.2s;
}
.is-open .agent-arrow {
  transform: rotate(180deg);
}
</style>

<!-- 下拉菜单挂载在 body 上，不能 scoped -->
<style>
/* ── 重置 el-tooltip__trigger（el-dropdown 自动添加的类）── */
.agent-selector-btn.el-tooltip__trigger {
  color: inherit;
  background: inherit;
}

/* ── popper 容器：通过CSS变量让el-dropdown自己处理hover/active ── */
.agent-dropdown-popper {
  --el-dropdown-menuItem-hover-fill: var(--color-bg-overlay, rgba(0,0,0,0.04));
  --el-dropdown-menuItem-hover-color: var(--color-text-primary, #24292f);
  --el-dropdown-box-shadow: none;
}
.agent-dropdown-popper .el-dropdown-menu {
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 140px;
  background: #fff;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
.agent-dropdown-popper .el-dropdown-menu__item {
  color: #555;
  margin: 0;
  padding: 7px 12px;
  line-height: 1.3;
  font-size: 12px;
}

/* 分组标题 */
.agent-dropdown-popper .agent-group-header {
  font-size: 11px;
  color: var(--color-text-tertiary, #8b949e);
  letter-spacing: 0.5px;
  padding: 8px 10px 2px;
  cursor: default;
  line-height: 1;
}
.agent-dropdown-popper .agent-group-header:hover {
  background: transparent !important;
  color: var(--color-text-tertiary, #8b949e) !important;
}

/* 分隔线 */
.agent-dropdown-popper .el-dropdown-menu__item--divided::before {
  margin: 0 4px;
  border-color: var(--color-border, rgba(0,0,0,0.06));
}
</style>
