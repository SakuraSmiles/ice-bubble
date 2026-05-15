<script setup lang="ts">
import { computed } from 'vue';
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

// 解析消息内容中的 MEDIA:<url> 指令，返回清洗后的内容和提取的 URL 列表
function extractMedia(content: string): { cleaned: string; urls: string[] } {
  const urls: string[] = [];
  const lines = content.split('\n');
  const cleanedLines = lines.filter(line => {
    if (line.startsWith('MEDIA:')) {
      const url = line.slice(6).trim();
      if (url) urls.push(url);
      return false;
    }
    return true;
  });
  return { cleaned: cleanedLines.join('\n'), urls };
}

// 预处理 Agent 消息：提取 MEDIA: 指令，分离显示内容和图片 URL
const messagesWithMedia = computed(() => {
  return props.group.messages.map(m => {
    const raw = m.clean_content || m.content || '';
    const { cleaned, urls } = extractMedia(raw);
    return { message: m, displayContent: cleaned, mediaUrls: urls };
  });
});

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

function isImageOnlyPlaceholder(content: string | null | undefined): boolean {
  if (!content) return false;
  return /^\(图片\)$/i.test(content.trim());
}

function previewImage(src: string) {
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(`<html><head><title>Image Preview</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${src}"></body></html>`);
    win.document.close();
  }
}
</script>

<template>
  <!-- 用户消息 -->
  <div v-if="group.type === 'user' && group.messages.length > 0" class="msg-row msg-row--user" :data-msg-id="group.messages[0]?.id">
    <div class="bubble bubble--user">
      <span v-if="shouldShowTime(group.timestamp, groupIndex)" class="bubble-time">{{ formatTime(group.timestamp) }}</span>
      <template v-if="isImageOnlyPlaceholder(group.messages[0]?.content) && group.messages[0]?.attachments?.length">
        <!-- 纯图片消息：只显示图片，不显示占位文字 -->
      </template>
      <MarkdownContent v-else-if="isImageOnlyPlaceholder(group.messages[0]?.content)" :content="'🖼️ [图片已发送]'" class="image-placeholder-text" />
      <MarkdownContent v-else-if="group.messages[0]?.clean_content || group.messages[0]?.content" :content="group.messages[0]?.clean_content || group.messages[0]?.content || ''" />
      <div v-if="group.messages[0]?.attachments?.length" class="bubble-images">
        <img
          v-for="(att, ai) in group.messages[0].attachments"
          :key="ai"
          :src="att.dataUrl || `data:${att.mimeType};base64,${att.content}`"
          class="bubble-image"
          loading="lazy"
          @click="previewImage(att.dataUrl || `data:${att.mimeType};base64,${att.content}`)"
        />
      </div>
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

        <div class="bubble-text" v-for="(item, mi) in messagesWithMedia" :key="mi">
          <MarkdownContent :content="item.displayContent" />
          <div v-if="item.mediaUrls.length > 0" class="media-gallery">
            <a
              v-for="(url, ui) in item.mediaUrls"
              :key="ui"
              :href="url"
              target="_blank"
              rel="noopener noreferrer"
              class="media-link"
            >
              <img :src="url" class="media-image" alt="Media" loading="lazy" />
            </a>
          </div>
          <div v-if="item.message.attachments?.length" class="bubble-images bubble-images--agent">
            <img
              v-for="(att, ai) in item.message.attachments"
              :key="ai"
              :src="att.dataUrl || `data:${att.mimeType};base64,${att.content}`"
              class="bubble-image bubble-image--agent"
              loading="lazy"
              @click="previewImage(att.dataUrl || `data:${att.mimeType};base64,${att.content}`)"
            />
          </div>
          <span v-if="item.message.streamState === 'streaming'" class="streaming-cursor">▊</span>
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

/* MEDIA: 图片展示 */
.media-gallery {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.media-link {
  display: block;
  line-height: 0;
}

.media-image {
  max-width: 100%;
  max-height: 400px;
  border-radius: 8px;
  display: block;
  border: 1px solid var(--color-border-subtle, #e5e7eb);
  cursor: pointer;
  transition: opacity 150ms ease;
}

.media-image:hover {
  opacity: 0.9;
}

/* 用户消息图片 */
.bubble-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.bubble-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 8px;
  object-fit: cover;
  cursor: pointer;
  transition: opacity 150ms ease, transform 150ms ease;
}
.bubble-image:hover {
  opacity: 0.9;
  transform: scale(1.02);
}
.bubble-images--agent {
  margin-top: 8px;
  flex-wrap: nowrap;
}
.bubble-image--agent {
  max-width: 320px;
  max-height: 320px;
}

/* 图片占位文字 */
.image-placeholder-text {
  color: var(--color-text-tertiary, #999);
  font-style: italic;
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
