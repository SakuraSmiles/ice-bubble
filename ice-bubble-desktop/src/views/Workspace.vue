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

const route = useRoute();
const router = useRouter();

const gatewayConnected = inject<{ value: boolean }>('gatewayConnected') ?? { value: false };

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

// ===== 附件 =====
interface ChatAttachment {
  id: string;
  file: File;
  preview: string;
}
const attachments = ref<ChatAttachment[]>([]);

function addAttachment(file: File): boolean {
  if (!file.type.startsWith('image/')) return false;
  if (attachments.value.length >= 4) {
    console.warn('[chat] 最多支持 4 张图片');
    return false;
  }
  const preview = URL.createObjectURL(file);
  attachments.value.push({ id: crypto.randomUUID(), file, preview });
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
  if (!text || !sessionKey.value || sending.value) return;
  sending.value = true;
  const hasAttachments = attachments.value.length > 0;
  if (hasAttachments) {
    console.log('[chat] attachments:', attachments.value.length, attachments.value.map(a => ({ id: a.id, name: a.file.name, type: a.file.type, size: a.file.size })));
  }
  inputText.value = '';
  resetInputHeight();
  clearAttachments();
  try {
    if (gatewayConnected.value) {
      await gatewayClient.sendMessage(sessionKey.value, text);
      timelineRef.value?.addOptimisticMessage(text, 'user');
    } else {
      const res = await request('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: sessionKey.value, message: text }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      timelineRef.value?.addOptimisticMessage(text, 'user');
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
    sendMessage();
  }
}

function autoResize() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function resetInputHeight() {
  const el = inputRef.value;
  if (el) el.style.height = 'auto';
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
        <ChatTimeline ref="timelineRef" :key="sessionKey" :session-key="sessionKey" />
        <div class="chat-input-bar" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop" :class="{ 'drag-over': dragOver }">
          <input ref="fileInputRef" type="file" accept="image/*" multiple class="file-input-hidden" @change="onFileChange" />
          <div v-if="attachments.length > 0" class="attachment-preview-bar">
            <div v-for="att in attachments" :key="att.id" class="attachment-preview-item">
              <img :src="att.preview" :alt="att.file.name" />
              <button class="attachment-remove" @click="removeAttachment(att.id)">&times;</button>
            </div>
          </div>
          <div class="chat-input-card">
            <textarea
              ref="inputRef"
              v-model="inputText"
              class="chat-input"
              :placeholder="canSend ? '输入消息… (Enter 发送, Shift+Enter 换行)' : '此会话已完成，不可发送消息'"
              rows="1"
              :disabled="!canSend || sending"
              @keydown="onKeyDown"
              @input="autoResize"
              @paste="onPaste"
            />
            <div v-if="canSend" class="chat-input-actions">
              <button class="attach-btn" title="添加图片" @click="onFileSelect">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                </svg>
              </button>
              <button class="send-btn" :disabled="sending || (!inputText.trim() && attachments.length === 0)" @click="sendMessage">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 1.5l13 5-13 5V8.5l8-1.5-8-1.5V1.5z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
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

/* ===== 输入框 ===== */
.chat-input-bar {
  display: flex;
  flex-direction: column;
  padding: 12px 16px 16px;
  flex-shrink: 0;
  background: var(--color-bg-canvas);
 border-radius: 0 0 8px 8px;
  transition: all 0.2s ease;
}

.chat-input-card {
 flex: 1;
 display: flex;
 align-items: center;
 background: #fff;
 border-radius: 12px;
 border: 1px solid var(--color-border);
 box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
 transition: border-color 0.15s, box-shadow 0.15s;
}

.chat-input-card:focus-within {
  border-color: var(--color-accent-blue);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(9, 105, 218, 0.1);
}

.chat-input {
  flex: 1;
  resize: none;
  border: none;
  border-radius: 12px;
  padding: 10px 8px;
  font-size: 14px;
  font-family: inherit;
  color: var(--color-text);
  background: transparent;
  outline: none;
  line-height: 1.6;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: var(--color-text-tertiary);
}

.chat-input:disabled {
  opacity: 0.5;
}

/* ===== 按钮组 ===== */
.chat-input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  flex-shrink: 0;
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
