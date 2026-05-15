<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { Copy, RefreshCw } from 'lucide-vue-next';
import MarkdownContent from '../../../components/MarkdownContent.vue';
import { API_BASE } from '../../../config';
import type { MsgGroup } from './types';
import ToolCallBadge from './ToolCallBadge.vue';

const props = defineProps<{
  group: MsgGroup;
  groupIndex: number;
  isLastAgentGroup: boolean;
  shouldShowTime: (ts: string, index: number) => boolean;
  formatTime: (ts: string) => string;
  extractToolName: (content: string | null) => string;
  truncateToolContent: (content: string | null, maxLen?: number) => string;
  toolSummary: (grp: MsgGroup) => string;
}>();

const emit = defineEmits<{
  (e: 'regenerate'): void;
}>();

function copyMessage() {
  const text = props.group.messages.map(m => m.clean_content || m.content || '').join('\n');
  if (!text.trim()) return;
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success({ message: '已复制到剪贴板', duration: 1500, grouping: true });
  }).catch(() => {
    ElMessage.error('复制失败');
  });
}

function regenerate() {
  emit('regenerate');
}
</script>

<template>
  <!-- 用户消息 -->
  <div v-if="group.type === 'user' && group.messages.length > 0" class="msg-row msg-row--user" :data-msg-id="group.messages[0]?.id">
    <div class="bubble bubble--user">
      <span v-if="shouldShowTime(group.timestamp, groupIndex)" class="bubble-time">{{ formatTime(group.timestamp) }}</span>
      <MarkdownContent :content="group.messages[0]?.clean_content || group.messages[0]?.content || ''" />
    </div>
  </div>

  <!-- Agent 消息 -->
  <div v-else-if="group.messages.length > 0" class="msg-row msg-row--agent" :class="{ 'msg-row--streaming': group.messages[0]?.streamState === 'streaming' }" :data-msg-id="group.messages[0]?.id">
    <div class="agent-avatar-col">
      <img v-if="group.avatar" :src="`${API_BASE}/resources/avatars/${group.avatar}`" class="avatar" />
      <div class="avatar-placeholder" v-else>{{ (group.agentName || '?')[0] }}</div>
    </div>
    <div class="agent-content-col">
      <div class="msg-header msg-header--agent">
        <span class="agent-label-name">{{ group.agentName }}</span>
        <span v-if="group.messages[0]?.model" class="model-tag">{{ group.messages[0].model }}</span>
        <span v-if="shouldShowTime(group.timestamp, groupIndex)" class="msg-time">{{ formatTime(group.timestamp) }}</span>
      </div>
      <div class="bubble bubble--agent bubble-wrapper">
        <!-- 操作按钮 -->
        <div class="action-bar">
          <button class="action-btn" title="复制消息" @click="copyMessage">
            <Copy :size="13" />
          </button>
          <button
            v-if="isLastAgentGroup && group.messages[0]?.streamState === 'complete'"
            class="action-btn"
            title="重新生成"
            @click="regenerate"
          >
            <RefreshCw :size="13" />
          </button>
        </div>

        <!-- 工具调用实时展示 -->
        <ToolCallBadge v-if="group.messages[0]?.toolCalls?.length" :tool-calls="group.messages[0].toolCalls" />

        <div class="bubble-text" v-for="(m, mi) in group.messages" :key="mi">
          <MarkdownContent :content="m.clean_content || m.content || ''" />
          <span v-if="m.streamState === 'streaming'" class="streaming-cursor">▊</span>
        </div>

        <!-- 工具消息折叠 -->
        <details v-if="group.toolMsgs.length > 0 && group.messages[0]?.streamState !== 'streaming' && group.messages[0]?.streamState !== 'thinking'" class="tool-details">
          <summary>{{ toolSummary(group) }}{{ group.hiddenToolCount > 0 ? `，还有 ${group.hiddenToolCount} 条` : '' }}</summary>
          <div v-for="(tm, ti) in group.toolMsgs" :key="ti" class="tool-item">
            <div class="tool-item-header">{{ extractToolName(tm.content) }}</div>
            <pre class="tool-item-body">{{ truncateToolContent(tm.content) }}</pre>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 90%;
}
.msg-row--user { align-self: flex-end; align-items: flex-end; }
.msg-row--agent {
  align-self: flex-start;
  align-items: flex-start;
  flex-direction: row;
  gap: 10px;
}

.agent-avatar-col {
  width: 28px;
  flex-shrink: 0;
  padding-top: 2px;
}

.agent-content-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.avatar, .avatar-placeholder {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-placeholder {
  background: var(--color-accent-blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 0 6px;
}
.msg-header--agent { justify-content: flex-start; }

.msg-time { white-space: nowrap; }

.bubble-time {
  display: block;
  text-align: right;
  font-size: 10px;
  color: #aaa;
  margin-bottom: 4px;
}

.agent-label-name {
  font-weight: 500;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.bubble {
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
}
.bubble--user {
  background: var(--color-accent-blue-subtle);
  color: var(--color-text);
  border-radius: 16px 4px 16px 16px;
  border: 1px solid var(--color-border-subtle);
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.bubble--user:hover {
  background: #c8e6ff;
  box-shadow: 0 1px 4px rgba(9, 105, 218, 0.12);
}
.bubble--user .bubble-time {
  color: var(--color-text-tertiary);
}
.bubble--user :deep(pre),
.bubble--user :deep(code) {
  background: rgba(0,0,0,0.06);
  color: var(--color-text);
  border-radius: 6px;
}

.bubble-wrapper {
  position: relative;
  background: #fff;
  color: #222;
  border-radius: 16px 16px 16px 4px;
  max-width: 100%;
  padding: 10px 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.bubble-wrapper:hover {
  background: #fafbfc;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
}

/* 操作按钮 */
.action-bar {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 150ms ease;
}
.bubble-wrapper:hover .action-bar {
  opacity: 1;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.05);
  color: #999;
  cursor: pointer;
  transition: all 150ms ease;
  padding: 0;
}
.action-btn:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #555;
}

.bubble-text {
  margin-bottom: 2px;
}

.model-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 10px;
  color: var(--color-accent-blue);
  background: var(--color-accent-blue-subtle);
  padding: 1px 5px;
  border-radius: 3px;
}

/* 工具折叠 */
.tool-details {
  margin-top: 8px;
  border-top: 1px solid #eee;
}
.tool-details summary {
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 11px;
  padding: 4px 0;
}
.tool-details summary:hover { color: #5a7fb5; }
.tool-item {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--color-bg-subtle);
  border-radius: 8px;
  font-size: 11px;
}
.tool-item-header {
  font-weight: 600;
  color: var(--color-accent-blue);
  font-size: 11px;
  margin-bottom: 4px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}
.tool-item-body {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: #666;
}

/* 流式光标 */
.streaming-cursor {
  display: inline-block;
  animation: blink 1s step-end infinite;
  color: var(--color-accent-blue);
  font-weight: bold;
  margin-left: 1px;
}
@keyframes blink {
  50% { opacity: 0; }
}
</style>
