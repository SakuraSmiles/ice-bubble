<script setup lang="ts">
import { ref, watch, computed, nextTick, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { gatewayClient } from '@/services/gateway-client';
import { request } from '../api/client';
import ConnectionAlert from '../components/ConnectionAlert.vue';
import AppFooter from '../components/AppFooter.vue';
import PageHeader from '../components/PageHeader.vue';
import ChatTimeline from './components/ChatTimeline.vue';
import SessionList from './components/SessionList.vue';
import { Loading } from '@element-plus/icons-vue';

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
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);
const timelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);

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
  try {
    // 通过 Gateway sessions API 轻量查找 main agent 的 direct session
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
      router.replace('/workspace/' + encodeURIComponent(mainDirect.key));
      return;
    }
  } catch { /* ignore */ }
  // 找不到则跳转到全部会话
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
  inputText.value = '';
  resetInputHeight();
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
    <PageHeader v-if="view === 'chat'" title="聊天">
      <ConnectionAlert />
    </PageHeader>

    <PageHeader v-else-if="view === 'list'" :title="(agentId || 'Agent') + ' — 会话列表'">
      <ConnectionAlert />
    </PageHeader>

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
  align-items: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border-subtle);
  flex-shrink: 0;
  background: var(--color-bg-canvas);
}

.chat-input-wrapper {
  flex: 1;
  position: relative;
  display: flex;
  align-items: flex-end;
  border: 1px solid var(--color-border);
  border-radius: 10px;
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
  border-radius: 10px;
  padding: 10px 48px 10px 14px;
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
  opacity: 0.2;
  cursor: not-allowed;
}
</style>
