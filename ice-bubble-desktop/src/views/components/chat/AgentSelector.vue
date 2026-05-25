<script setup lang="ts">
import { ref, computed } from 'vue';

export interface AgentOption {
  platform: 'openclaw' | 'opencode';
  agent: string;
  label: string;
  emoji: string;
  tag: string;
}

const props = withDefaults(defineProps<{
  modelValue: AgentOption;
  disabled?: boolean;
  agents: AgentOption[];
}>(), {
  agents: () => [],
});

const emit = defineEmits<{
  'update:modelValue': [value: AgentOption];
}>();

const isOpen = ref(false);

function select(opt: AgentOption) {
  emit('update:modelValue', opt);
  isOpen.value = false;
}

// Platform badge color config
const platformConfig: Record<string, { color: string; bg: string; border: string }> = {
  openclaw: { color: '#67c23a', bg: 'rgba(103, 194, 58, 0.12)', border: 'rgba(103, 194, 58, 0.25)' },
  opencode: { color: '#409eff', bg: 'rgba(64, 158, 255, 0.10)', border: 'rgba(64, 158, 255, 0.25)' },
};

const currentPlatform = computed(() => platformConfig[props.modelValue.platform] ?? platformConfig.openclaw);
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled" @command="select" v-model:visible="isOpen">
    <button
      class="agent-selector-btn"
      :class="{ 'is-open': isOpen }"
      @click="isOpen = !isOpen"
    >
      <span class="agent-dot" :style="{ background: currentPlatform.color }"></span>
      <span class="agent-label">{{ modelValue.label }}</span>
      <span class="agent-tag" :style="{ color: currentPlatform.color }">{{ modelValue.tag }}</span>
      <svg class="agent-arrow" width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <template #dropdown>
      <el-dropdown-menu class="agent-dropdown-menu">
        <el-dropdown-item
          v-for="opt in agents" :key="opt.platform + ':' + opt.agent"
          :command="opt"
          :class="{ 'is-active': modelValue.platform === opt.platform && modelValue.agent === opt.agent }"
        >
          <span class="opt-row">
            <span class="opt-dot" :style="{ background: platformConfig[opt.platform]?.color }"></span>
            <span class="opt-name">{{ opt.label }}</span>
            <span class="opt-tag" :style="{ color: platformConfig[opt.platform]?.color }">{{ opt.tag }}</span>
          </span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.agent-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  height: 34px;
  min-width: 120px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
  flex-shrink: 0;
}
.agent-selector-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  border-color: rgba(255, 255, 255, 0.1);
}
.agent-selector-btn.is-open {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
}

.agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.agent-label {
  font-weight: 500;
  white-space: nowrap;
}
.agent-tag {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.7;
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

/* ===== Dropdown items (scoped, override el-dropdown-menu via deep) =====
   The el-dropdown-menu is teleported to body, so scoped styles won't apply.
   We use :global for the dropdown menu overrides. */
</style>

<style>
/* Dropdown menu — global because el-dropdown teleports to <body> */
.agent-dropdown-menu {
  border: 1px solid var(--el-border-color-darker, rgba(255,255,255,0.08)) !important;
  border-radius: 8px !important;
  padding: 4px !important;
  min-width: 140px;
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


.opt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.opt-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.opt-name {
  font-weight: 500;
  font-size: 12px;
}
.opt-tag {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.65;
  margin-left: auto;
}
</style>
