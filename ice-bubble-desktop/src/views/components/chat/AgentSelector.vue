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
}>();

const emit = defineEmits<{
  'update:modelValue': [value: AgentOption];
}>();

const openclawOption: AgentOption = { platform: 'openclaw', agent: 'main', label: '虾头', emoji: '🦐', tag: 'OpenClaw' };
const opencodeOptions: AgentOption[] = [
  { platform: 'opencode', agent: 'build', label: 'build', emoji: '🔨', tag: 'OpenCode' },
  { platform: 'opencode', agent: 'plan', label: 'plan', emoji: '📋', tag: 'OpenCode' },
];

const isOpen = ref(false);

function select(opt: AgentOption) {
  emit('update:modelValue', opt);
  isOpen.value = false;
}

const currentLabel = computed(() => {
  const v = props.modelValue;
  return `${v.emoji} ${v.label}  ${v.tag}`;
});
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled" @command="select" v-model:visible="isOpen">
    <button class="agent-selector-btn" :class="{ 'is-opencode': modelValue.platform === 'opencode' }" @click="isOpen = !isOpen">
      <span class="agent-selector-label">{{ currentLabel }}</span>
      <svg class="agent-selector-arrow" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item :command="openclawOption" :class="{ 'is-active': modelValue.platform === 'openclaw' }">
          <span class="agent-option">
            <span class="agent-option-emoji">{{ openclawOption.emoji }}</span>
            <span class="agent-option-text">
              <span class="agent-option-name">{{ openclawOption.label }}</span>
              <span class="agent-option-tag">{{ openclawOption.tag }}</span>
            </span>
          </span>
        </el-dropdown-item>
        <el-dropdown-item divided v-for="opt in opencodeOptions" :key="opt.agent" :command="opt" :class="{ 'is-active': modelValue.platform === 'opencode' && modelValue.agent === opt.agent }">
          <span class="agent-option">
            <span class="agent-option-emoji">{{ opt.emoji }}</span>
            <span class="agent-option-text">
              <span class="agent-option-name">{{ opt.label }}</span>
              <span class="agent-option-tag">{{ opt.tag }}</span>
            </span>
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
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}
.agent-selector-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
}
.agent-selector-btn.is-opencode {
  border-color: rgba(64, 158, 255, 0.3);
  background: rgba(64, 158, 255, 0.08);
  color: rgba(64, 200, 255, 0.9);
}
.agent-selector-btn.is-opencode:hover {
  background: rgba(64, 158, 255, 0.14);
}
.agent-selector-label {
  white-space: nowrap;
}
.agent-selector-arrow {
  flex-shrink: 0;
  opacity: 0.5;
  transition: transform 0.2s;
}

.agent-option {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-option-emoji {
  font-size: 16px;
  flex-shrink: 0;
}
.agent-option-text {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-option-name {
  font-weight: 500;
  font-size: 13px;
}
.agent-option-tag {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.45);
  font-weight: 400;
}
</style>
