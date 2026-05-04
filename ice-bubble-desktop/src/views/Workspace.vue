<script setup lang="ts">
import { ref, watch, computed, nextTick, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { gatewayClient } from '@/services/gateway-client';
import ConnectionAlert from '../components/ConnectionAlert.vue';
import AppFooter from '../components/AppFooter.vue';
import ChatTimeline from './components/ChatTimeline.vue';
import SessionList from './components/SessionList.vue';

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
const view = ref<'list' | 'chat'>('list');
const agentName = ref('');
const label = ref('');
const status = ref('');
const created = ref('');
const inputText = ref('');
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);
const timelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);

// =========== 会话信息 ===========
async function loadSessionInfo() {
  if (!sessionKey.value) return;
  try {
    const res = await fetch('/api/gateway/sessions');
    if (!res.ok) return;
    const data = await res.json();
    const found = (data.sessions || []).find((s: any) => s.key === sessionKey.value);
    if (found) {
      const m = found.key.match(/^agent:([^:]+)/);
      agentName.value = m ? m[1] : '';
      const dName = found.displayName || '';
      label.value = found.label || (dName ? dName.replace(/^[a-z-]+:/, '') : found.key.split(':').pop() || '');
      status.value = found.status || '';
      created.value = found.updatedAt ? new Date(found.updatedAt).toLocaleString() : '';
    }
  } catch (e) {
    // ignore
  }
}

function statusLabel(s: string | null): string {
  switch (s) {
    case 'running': return '进行中';
    case 'done': return '已完成';
    case 'failed': return '失败';
    case 'timeout': return '超时';
    default: return '';
  }
}

function statusType(s: string | null): string {
  switch (s) {
    case 'running': return 'primary';
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'timeout': return 'warning';
    default: return 'info';
  }
}

const canSend = computed(() => {
  if (!sessionKey.value) return false;
  if (!status.value || status.value === 'running' || status.value === 'done') return true;
  return false;
});

watch(sessionKey, async (key) => {
  if (key) {
    view.value = 'chat';
    await loadSessionInfo();
  } else {
    view.value = 'list';
  }
}, { immediate: true });

// =========== Session 选择 ===========
function onSessionSelect(sessionKeyStr: string) {
  router.push('/workspace/' + encodeURIComponent(sessionKeyStr));
}

function goBackToList() {
  router.push('/workspace/agent:' + agentId.value);
}

// =========== 发送消息 ===========
async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || !sessionKey.value || sending.value) return;
  sending.value = true;
  inputText.value = '';
  resetInputHeight();
  try {
    if (gatewayConnected.value) {
      await gatewayClient.sendMessage(sessionKey.value, text);
      timelineRef.value?.addOptimisticMessage(text, 'user');
    } else {
      const res = await fetch('/api/chat/send', {
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
    <header class="workspace-header">
      <div class="header-top">
        <div class="header-left">
          <!-- chat 视图: 返回列表；list 视图: 返回首页 -->
          <button class="back-btn" @click="view === 'chat' ? goBackToList() : router.push('/')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
            </svg>
          </button>
          <div class="title-area">
            <h1 v-if="view === 'chat'" class="page-title">{{ label || '会话详情' }}</h1>
            <h1 v-else class="page-title">{{ agentId || 'Agent' }} — 会话列表</h1>
            <span class="page-subtitle">{{ view === 'chat' ? agentName : '' }}</span>
          </div>
        </div>
        <div class="header-actions">
          <el-tag v-if="view === 'chat' && status" :type="statusType(status)" size="small" effect="plain">
            {{ statusLabel(status) }}
          </el-tag>
          <span v-if="view === 'chat' && created" class="meta-time">{{ new Date(created).toLocaleString('zh-CN') }}</span>
        </div>
      </div>
      <ConnectionAlert />
    </header>

    <div class="workspace-body">
      <!-- Session 列表视图 -->
      <SessionList v-if="view === 'list'" :agent-id="agentId" @select="onSessionSelect" />

      <!-- 聊天视图 -->
      <template v-else>
        <ChatTimeline ref="timelineRef" :key="sessionKey" :session-key="sessionKey" />
        <div class="chat-input-bar">
          <div class="chat-input-wrapper">
            <textarea
              ref="inputRef"
              v-model="inputText"
              class="chat-input"
              :placeholder="canSend ? '输入消息… (Enter 发送, Shift+Enter 换行)' : '此会话已完成，不可发送消息'"
              rows="3"
              :disabled="!canSend || sending"
              @keydown="onKeyDown"
              @input="autoResize"
            />
            <button v-if="canSend" class="send-btn" :disabled="sending || !inputText.trim()" @click="sendMessage">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 1.5l13 5-13 5V8.5l8-1.5-8-1.5V1.5z"/>
              </svg>
            </button>
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

.workspace-header {
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0;
  flex-shrink: 0;
}

.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.back-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--color-text);
}

.title-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.2;
  letter-spacing: -0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.page-subtitle {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-weight: 400;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding-top: 6px;
  flex-shrink: 0;
}

.meta-time {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  margin: 8px 24px;
  background: var(--color-bg-canvas);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ===== 输入框 ===== */
.chat-input-bar {
  display: flex;
  align-items: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  background: var(--color-bg-canvas);
  border-radius: 0 0 var(--radius) var(--radius);
}

.chat-input-wrapper {
  flex: 1;
  position: relative;
  display: flex;
  align-items: flex-end;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-inset);
  transition: border-color 0.15s;
}

.chat-input-wrapper:focus-within {
  border-color: var(--color-accent-blue);
}

.chat-input {
  flex: 1;
  resize: none;
  border: none;
  border-radius: var(--radius);
  padding: 8px 44px 8px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--color-text);
  background: transparent;
  outline: none;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: var(--color-text-tertiary);
}

.chat-input:disabled {
  opacity: 0.5;
}

.send-btn {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: var(--color-accent-blue);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.send-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.send-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}
</style>
