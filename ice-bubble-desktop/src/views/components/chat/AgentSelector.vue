<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';

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

const rootRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const dropdownPos = ref({ top: 0, left: 0 });

function updatePosition() {
  if (!rootRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  dropdownPos.value = {
    top: rect.bottom + 4,
    left: rect.left,
  };
}

function toggle() {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    nextTick(updatePosition);
  }
}

function close() {
  isOpen.value = false;
}

function select(opt: AgentOption) {
  emit('update:modelValue', opt);
  isOpen.value = false;
}

function onDocClick(e: MouseEvent) {
  if (isOpen.value && rootRef.value && !rootRef.value.contains(e.target as Node)) {
    close();
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
});

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

const dropdownStyle = computed(() => ({
  top: `${dropdownPos.value.top}px`,
  left: `${dropdownPos.value.left}px`,
}));
</script>

<template>
  <div class="agent-selector" ref="rootRef">
    <button
      class="agent-btn"
      :class="{ 'is-open': isOpen, 'is-disabled': disabled }"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="agent-btn__label">{{ displayLabel }}</span>
      <svg class="agent-btn__arrow" :class="{ 'is-open': isOpen }" width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="isOpen" class="agent-dropdown-wrap">
        <div class="agent-overlay" @click="close"></div>
        <div class="agent-dropdown" :style="dropdownStyle" @click.stop>
          <template v-for="(group, gi) in groupedAgents" :key="group.platform">
            <div v-if="gi > 0" class="agent-divider"></div>
            <div class="agent-group-label">{{ group.tag }}</div>
            <div
              v-for="opt in group.items"
              :key="opt.platform + ':' + opt.agent"
              class="agent-item"
              :class="{ 'is-active': modelValue.platform === opt.platform && modelValue.agent === opt.agent }"
              @click="select(opt)"
            >
              {{ opt.label }}
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.agent-selector {
  display: inline-flex;
  position: relative;
}

.agent-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  background: transparent;
  color: #57606a;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  font-family: inherit;
  margin: 0;
  outline: none;
  transition: color 0.15s, background 0.15s;
}
.agent-btn:hover {
  color: #24292f;
  background: rgba(0, 0, 0, 0.04);
}
.agent-btn.is-open {
  color: #24292f;
  background: rgba(0, 0, 0, 0.06);
}
.agent-btn.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-btn__label {
  font-weight: 500;
  white-space: nowrap;
}

.agent-btn__arrow {
  flex-shrink: 0;
  opacity: 0.4;
  transition: transform 0.2s;
}
.agent-btn__arrow.is-open {
  transform: rotate(180deg);
}
</style>

<!-- 下拉菜单挂载在 body 上，不能 scoped -->
<style>
.agent-dropdown-wrap {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
}
.agent-overlay {
  position: fixed;
  inset: 0;
}
.agent-dropdown {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 4px 0;
}
.agent-divider {
  height: 1px;
  margin: 4px 8px;
  background: #d0d7de;
}
.agent-group-label {
  padding: 8px 12px 4px;
  font-size: 11px;
  color: #8b949e;
  letter-spacing: 0.5px;
  line-height: 1;
}
.agent-item {
  padding: 6px 12px;
  color: #57606a;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.agent-item:hover {
  color: #24292f;
  background: rgba(0, 0, 0, 0.04);
}
.agent-item.is-active {
  color: #24292f;
  font-weight: 600;
}
</style>
