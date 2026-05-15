<script setup lang="ts">
import type { ToolCallEntry } from './types';

defineProps<{
  toolCalls: ToolCallEntry[];
}>();

const toolEmojiMap: Record<string, string> = {
  read: '📖', write: '📝', exec: '⚡', web_search: '🔍',
  web_fetch: '🌐', browser: '🖥️', canvas: '🎨', message: '💬',
  edit: '✏️', process: '🔄', memory_get: '🧠', memory_search: '🔎',
};

function toolEmoji(name: string): string {
  return toolEmojiMap[name] || '🔧';
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
</script>

<template>
  <div v-if="toolCalls.length" class="tool-calls-inline">
    <div
      v-for="tc in toolCalls"
      :key="tc.toolCallId || tc.toolName"
      class="tool-badge"
      :class="`tool-badge--${tc.phase}`"
    >
      <span class="tool-icon">{{ toolEmoji(tc.toolName) }}</span>
      <span class="tool-name">{{ formatToolName(tc.toolName) }}</span>
      <span v-if="tc.phase === 'start'" class="tool-status spinning">⏳</span>
      <span v-else-if="tc.phase === 'result'" class="tool-status">✅</span>
      <span v-else-if="tc.phase === 'error'" class="tool-status">❌</span>
    </div>
  </div>
</template>

<style scoped>
.tool-calls-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.tool-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-family: 'SF Mono', 'Consolas', monospace;
  background: #f0f1f3;
  color: #666;
  border-left: 3px solid #ccc;
  transition: all 0.2s;
}
.tool-badge--result { background: #e8f5e9; color: #388e3c; border-left-color: #4caf50; }
.tool-badge--error { background: #ffebee; color: #d32f2f; border-left-color: #f44336; }
.tool-badge--start { background: #fff3e0; color: #e65100; border-left-color: #ff9800; }
.tool-icon { font-size: 12px; }
.tool-name { font-size: 11px; }
.tool-status.spinning {
  animation: spin 1.5s linear infinite;
  display: inline-block;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
