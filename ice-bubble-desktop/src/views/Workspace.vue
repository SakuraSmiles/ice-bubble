<script setup lang="ts">
import { ref, watch, computed, nextTick, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatInputStore } from '@/stores/chat-input';
import { gatewayClient } from '@/services/gateway-client';
import { request } from '../api/client';
import AppFooter from '../components/AppFooter.vue';
import PageHeader from '../components/PageHeader.vue';
import ChatTimeline from './components/ChatTimeline.vue';
import SessionList from './components/SessionList.vue';

import { Loading } from '@element-plus/icons-vue';
import { getMainSessionKey, setMainSessionKey } from './components/chat/session-cache';
import AgentSelector from './components/chat/AgentSelector.vue';
import type { AgentOption } from './components/chat/AgentSelector.vue';
import { sendOpenCodeChat } from '../api/opencode';

const route = useRoute();
const router = useRouter();

const gatewayConnected = inject<{ value: boolean }>('gatewayConnected') ?? { value: false };

// Mock 数据已移至 Tasks.vue（工作台视图）

const rawKey = computed(() => route.params.key as string || '');
const sessionKey = computed(() => rawKey.value ? decodeURIComponent(rawKey.value) : '');

// 解析 agent_id: 从 "agent:main:..." 中提取第二个段
const agentId = computed(() => {
  const m = rawKey.value.match(/^agent:([^:]+)/);
  return m ? m[1] : '';
});

// 视图状态：list 或 chat（无 UUID 时强制显示 list）
const view = ref<'list' | 'chat' | 'loading'>('list');
const inputText = ref('');

// 聊天输入缓存
const chatInputStore = useChatInputStore();
chatInputStore.bind(sessionKey, inputText);
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);
const timelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

// ===== Agent 选择 =====
const selectedAgent = ref<AgentOption>({ platform: 'openclaw', agent: 'main', label: '虾头', emoji: '🦐', tag: 'OpenClaw' });
const openCodeSessionId = ref<string | undefined>();

// Agent 处理状态
const isAgentProcessing = computed(() => {
  const r = timelineRef.value as any;
  const v = r?.isProcessing;
  return typeof v === 'object' && v !== null && 'value' in v ? v.value : !!v;
});
const isBusy = computed(() => sending.value || isAgentProcessing.value);
const canSteer = computed(() => isAgentProcessing.value && inputText.value.trim().length > 0);
const aborting = ref(false);

// ===== 附件 =====
interface ChatAttachment {
  id: string;
  file: File;
  preview: string;
  dataUrl: string;
}
const attachments = ref<ChatAttachment[]>([]);

function addAttachment(file: File): boolean {
  if (!file.type.startsWith('image/')) return false;
  if (attachments.value.length >= 4) {
    console.warn('[chat] 最多支持 4 张图片');
    return false;
  }
  const preview = URL.createObjectURL(file);
  const id = crypto.randomUUID();
  const att = { id, file, preview, dataUrl: '' };
  attachments.value.push(att);
  const reader = new FileReader();
  reader.onload = () => {
    const idx = attachments.value.findIndex(a => a.id === id);
    if (idx >= 0) attachments.value.splice(idx, 1, { ...attachments.value[idx], dataUrl: reader.result as string });
  };
  reader.readAsDataURL(file);
  return true;
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(attachments.value[idx].preview);
    attachments.value.splice(idx, 1);
  }
}

function clearAttachments() {
  attachments.value.forEach(a => URL.revokeObjectURL(a.preview));
  attachments.value = [];
}

function onFileSelect() {
  fileInputRef.value?.click();
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  for (const file of Array.from(input.files)) {
    if (!addAttachment(file)) break;
  }
  input.value = '';
}

function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        addAttachment(file);
        break;
      }
    }
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragOver.value = true;
}

function onDragLeave() {
  dragOver.value = false;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!addAttachment(file)) break;
  }
}

const canSend = computed(() => {
  return !!sessionKey.value;
});

watch(sessionKey, async (key) => {
  if (key) {
    view.value = 'chat';
  } else if (route.path === '/chat') {
    // /chat 路由无 key：轻量查找 main agent 的 direct session 并自动跳转
    view.value = 'loading';
    autoRedirectChat();
  } else {
    view.value = 'list';
  }
}, { immediate: true });

// /chat 路由自动跳转到 main agent 的 direct session
async function autoRedirectChat() {
  // 1. 优先读缓存
  const cached = getMainSessionKey();
  if (cached) {
    router.replace('/workspace/' + encodeURIComponent(cached));
    return;
  }

  // 2. 无缓存 → 查 Gateway
  try {
    const res = await request('/gateway/sessions');
    if (!res.ok) return;
    const data = await res.json();
    const sessions = (data.sessions || []) as any[];
    const mainDirect = sessions
      .filter((s: any) => {
        const m = s.key.match(/^agent:([^:]+)/);
        return m && m[1] === 'main' && s.key.includes(':direct:');
      })
      .sort((a: any, b: any) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return tb - ta;
      })[0];
    if (mainDirect) {
      setMainSessionKey(mainDirect.key);
      router.replace('/workspace/' + encodeURIComponent(mainDirect.key));
      return;
    }
  } catch { /* ignore */ }
  // 3. 找不到则跳转到全部会话
  router.replace('/sessions');
}

// =========== Session 选择 ===========
function onSessionSelect(sessionKeyStr: string) {
  router.push('/workspace/' + encodeURIComponent(sessionKeyStr));
}

// =========== 发送消息 ===========
async function sendMessage() {
  const text = inputText.value.trim();
  if ((!text && attachments.value.length === 0) || !sessionKey.value || sending.value) return;

  // Steer: Agent 处理中时追加消息
  if (isAgentProcessing.value) {
    if (!text && attachments.value.length === 0) return;
    try {
      await gatewayClient.steerSession(sessionKey.value, text);
      inputText.value = '';
      resetInputHeight();
      nextTick(() => inputRef.value?.focus());
      return;
    } catch (e) {
      console.error('追加消息失败', e);
      return;
    }
  }

  sending.value = true;
  const hasAttachments = attachments.value.length > 0;
  if (hasAttachments) {
    console.log('[chat] attachments:', attachments.value.length, attachments.value.map(a => ({ id: a.id, name: a.file.name, type: a.file.type, size: a.file.size })));
  }

  // 构建附件 payload
  const attachmentPayloads = attachments.value.map(att => {
    const base64 = att.dataUrl.split(',')[1] || '';
    return {
      type: 'image',
      mimeType: att.file.type,
      fileName: att.file.name,
      content: base64,
    };
  });

  // 保存附件 dataUrl 用于乐观消息展示
  const attachmentDataUrls = attachments.value.map(a => a.dataUrl).filter(Boolean);
  inputText.value = '';
  resetInputHeight();
  clearAttachments();
  try {
    // ===== OpenCode 分支 =====
    if (selectedAgent.value.platform === 'opencode') {
      const result = await sendOpenCodeChat({
        agent: selectedAgent.value.agent as 'build' | 'plan',
        message: text,
        sessionId: openCodeSessionId.value,
      });
      openCodeSessionId.value = result.sessionId;
      // 添加用户消息到本地消息列表
      timelineRef.value?.addOptimisticMessage(text, 'user');
      // 添加 agent 回复到本地消息列表
      nextTick(() => {
        timelineRef.value?.addOptimisticMessage(result.content, 'agent');
      });
      return;
    }

    if (gatewayConnected.value) {
      await gatewayClient.sendMessage(sessionKey.value, text || '(图片)', attachmentPayloads.length > 0 ? attachmentPayloads : undefined);
      timelineRef.value?.addOptimisticMessage(hasAttachments && !text ? '' : text, 'user', attachmentDataUrls);
    } else {
      const res = await request('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: sessionKey.value, message: text || '(图片)', attachments: attachmentPayloads.length > 0 ? attachmentPayloads : undefined }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      timelineRef.value?.addOptimisticMessage(hasAttachments && !text ? '' : text, 'user', attachmentDataUrls);
    }
  } catch (e) {
    inputText.value = text;
    console.error('发送失败', e);
  } finally {
    sending.value = false;
    nextTick(() => inputRef.value?.focus());
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (isBusy.value && !sending.value) return; // 处理中 Enter 不发送
    sendMessage();
  } else if (e.key === 'Escape' && isBusy.value && !sending.value) {
    handleAbort();
  }
}

async function handleAbort() {
  if (aborting.value || !isAgentProcessing.value || !sessionKey.value) return;
  aborting.value = true;
  try {
    await gatewayClient.abortTurn(sessionKey.value);
  } catch (e) {
    console.error('中止失败', e);
  }
  setTimeout(() => { aborting.value = false; }, 800);
}

// ===== 输入框尺寸 =====
// 行高 22.4px (14px * 1.6)，加 padding 10px 上下
const INPUT_LINE_HEIGHT = 22.4;
const TEXT_DEFAULT_LINES = 3;
const TEXT_MIN_LINES = 3;
const TEXT_MAX_LINES = 12;
const textDefaultHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_DEFAULT_LINES + 20); // ~87px
const textMinHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_MIN_LINES + 20);
const textMaxHeight = Math.round(INPUT_LINE_HEIGHT * TEXT_MAX_LINES + 20); // ~289px

const isDragging = ref(false);
let dragStartY = 0;
let dragStartHeight = 0;

const textareaHeight = ref(textDefaultHeight);

function autoResize() {
  const el = inputRef.value;
  if (!el || isDragging.value) return;
  // 先重置测量内容高度
  el.style.height = 'auto';
  const contentH = el.scrollHeight;
  const newH = Math.max(textMinHeight, Math.min(textMaxHeight, contentH));
  textareaHeight.value = newH;
}

function resetInputHeight() {
  textareaHeight.value = textDefaultHeight;
}

function onResizeDragStart(e: MouseEvent) {
  e.preventDefault();
  isDragging.value = true;
  dragStartY = e.clientY;
  dragStartHeight = textareaHeight.value;
  document.addEventListener('mousemove', onResizeDragMove);
  document.addEventListener('mouseup', onResizeDragEnd);
}

function onResizeDragMove(e: MouseEvent) {
  if (!isDragging.value) return;
  const delta = e.clientY - dragStartY;
  // 手柄在卡片上方：往上拖(delta<0)应增大高度，往下拖(delta>0)应缩小
  const newH = Math.max(textMinHeight, Math.min(textMaxHeight, dragStartHeight - delta));
  textareaHeight.value = newH;
}

function onResizeDragEnd() {
  isDragging.value = false;
  document.removeEventListener('mousemove', onResizeDragMove);
  document.removeEventListener('mouseup', onResizeDragEnd);
}
</script>

<template>
  <div class="workspace-page">
    <PageHeader v-if="view === 'chat'" title="聊天" />

    <PageHeader v-else-if="view === 'list'" :title="(agentId || 'Agent') + ' — 会话列表'" />

    <!-- 加载中状态（无白色容器） -->
    <div v-if="view === 'loading'" class="loading-state">
      <el-icon class="is-loading" :size="20" color="var(--color-text-tertiary)"><Loading /></el-icon>
      <span>正在查找会话...</span>
    </div>

    <div v-else class="workspace-body">
      <!-- Session 列表视图 -->
      <SessionList v-if="view === 'list'" :agent-id="agentId" @select="onSessionSelect" />

      <!-- 聊天视图 -->
      <template v-else>
        <div class="workspace-content">
          <ChatTimeline ref="timelineRef" :key="sessionKey" :session-key="sessionKey" />
        <!-- Agent 选择器 -->
        <div class="agent-selector-bar" v-if="canSend">
          <AgentSelector v-model="selectedAgent" :disabled="sending || isBusy" />
        </div>
        <div class="chat-input-bar" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop" :class="{ 'drag-over': dragOver }">
          <input ref="fileInputRef" type="file" accept="image/*" multiple class="file-input-hidden" @change="onFileChange" />
          <div v-if="attachments.length > 0" class="attachment-preview-bar">
            <div v-for="att in attachments" :key="att.id" class="attachment-preview-item">
              <img :src="att.preview" :alt="att.file.name" />
              <button class="attachment-remove" @click="removeAttachment(att.id)">&times;</button>
            </div>
          </div>
          <!-- 拖拽手柄：在卡片上方外部 -->
          <div class="resize-handle" @mousedown="onResizeDragStart"></div>
          <!-- 输入卡片：文本区 + 操作栏 -->
          <div class="chat-input-card" :class="{ 'is-processing': isBusy || aborting }">
            <div class="chat-textarea-zone" :style="{ height: textareaHeight + 'px' }">
              <textarea
                ref="inputRef"
                v-model="inputText"
                class="chat-input"
                :placeholder="isAgentProcessing ? '追加消息到当前回复…' : (canSend ? '输入消息… (Enter 发送, Shift+Enter 换行)' : '此会话已完成，不可发送消息')"
                :disabled="!canSend"
                @keydown="onKeyDown"
                @input="autoResize"
                @paste="onPaste"
              />
            </div>
            <div v-if="canSend" class="chat-action-row">
              <span class="action-hint">Enter 发送 / Shift+Enter 换行</span>
              <div class="chat-input-actions">
                <button class="attach-btn" title="添加图片" @click="onFileSelect">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                <!-- 中止按钮（Agent 处理中显示） -->
                <button v-if="(isBusy && !sending) || aborting" class="abort-btn" :class="{ 'abort-btn--done': aborting }" title="停止生成 (Esc)" @click="handleAbort">
                  <svg v-if="!aborting" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="3" width="10" height="10" rx="2" />
                  </svg>
                  <svg v-else width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 8.5l3 3L13 4.5" />
                  </svg>
                </button>
                <!-- 追加按钮（steer，Agent 处理中且有输入） -->
                <button v-else-if="canSteer" class="steer-btn" title="追加消息" @click="sendMessage">
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
                  </svg>
                </button>
                <!-- 发送按钮（空闲时显示） -->
                <button v-else class="send-btn" :disabled="sending || (!inputText.trim() && attachments.length === 0)" @click="sendMessage">
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.5 1.5l13 5-13 5V8.5l8-1.5-8-1.5V1.5z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div><!-- /workspace-content -->
      </template>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
.workspace-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  margin: 0 20px 8px;
  background: var(--color-bg-canvas);
  border-radius: 8px;
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 聊天视图容器 */
.workspace-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ===== Agent 选择栏 ===== */
.agent-selector-bar {
  display: flex;
  align-items: center;
  padding: 6px 16px 0;
  flex-shrink: 0;
  background: var(--color-bg-canvas);
}

/* ===== 输入框区域 ===== */
.chat-input-bar {
  display: flex;
  flex-direction: column;
  padding: 0 16px 16px;
  flex-shrink: 0;
  background: var(--color-bg-canvas);
  border-radius: 0 0 8px 8px;
  transition: all 0.2s ease;
}

/* 拖拽手柄：卡片上方外部 */
.resize-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 10px;
  cursor: ns-resize;
  user-select: none;
  margin-bottom: 2px;
}

.resize-handle::after {
  content: '';
  display: block;
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: var(--color-border);
  transition: background 0.15s;
}

.resize-handle:hover::after,
.resize-handle:active::after {
  background: var(--color-text-tertiary);
}

/* 输入卡片：文本区 + 操作栏上下分区 */
.chat-input-card {
 display: flex;
 flex-direction: column;
 background: #fff;
 border-radius: 12px;
 border: 1px solid var(--color-border);
 box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
 overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.chat-input-card:focus-within {
  border-color: var(--color-accent-blue);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(9, 105, 218, 0.1);
}

/* Agent 处理中输入框卡片 */
.chat-input-card.is-processing {
  border-color: var(--color-accent-blue);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(9, 105, 218, 0.1);
}

/* 文本区（默认3行高） */
.chat-textarea-zone {
 flex-shrink: 0;
 overflow: hidden;
}

.chat-input {
  display: block;
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  color: var(--color-text);
  background: transparent;
  outline: none;
  line-height: 1.6;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: var(--color-text-tertiary);
}

.chat-input:disabled {
  opacity: 0.5;
}

/* 操作栏（固定1行，底部） */
.chat-action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border-lighter);
  flex-shrink: 0;
}

.action-hint {
  font-size: 11px;
  color: var(--color-text-placeholder);
  user-select: none;
}

/* ===== 按钮组 ===== */
.chat-input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent-blue);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.send-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(9,105,218,0.3);
}

.send-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  background: var(--color-text-quaternary, #d1d5db);
}

/* 中止按钮 */
.abort-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--el-color-danger, #f56c6c);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.abort-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(245, 108, 108, 0.3);
}
.abort-btn--done {
  background: var(--el-color-success, #67c23a) !important;
}

/* 追加按钮（steer） */
.steer-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent-blue);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.steer-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(9, 105, 218, 0.3);
}

/* ===== 附件按钮 ===== */
.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.attach-btn:hover {
  color: var(--color-text-secondary);
  background: var(--color-bg-overlay);
}

.file-input-hidden {
  display: none;
}

/* ===== 附件预览 ===== */
.attachment-preview-bar {
  display: flex;
  gap: 8px;
  padding: 0 0 8px;
  flex-wrap: wrap;
}

.attachment-preview-item {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  transition: box-shadow 0.15s;
}

.attachment-preview-item:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}

.attachment-preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s;
}

.attachment-remove:hover {
  background: rgba(220, 38, 38, 0.8);
}

/* ===== 拖拽高亮 ===== */
.chat-input-bar.drag-over {
  border: 2px dashed var(--color-accent-blue);
  background: rgba(9, 105, 218, 0.04);
}
</style>
