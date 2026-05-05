<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import MarkdownContent from './MarkdownContent.vue';
import EmptyState from './EmptyState.vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/client.ts';
import type { MessageDTO } from '../api/client.ts';
import type { SessionDTO } from '../api/client.ts';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent' | string;
  content: string;
  timestamp: string;
  type?: string;
}

const props = defineProps<{
  session: SessionDTO | null;
}>();

const messages = ref<ChatMessage[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(true);
const error = ref('');
const chatContainerRef = ref<HTMLElement | null>(null);

function formatTime(dateString: string): string {
  const d = new Date(dateString);
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const seconds = d.getSeconds().toString().padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function fetchMessages(reset = false) {
  if (!props.session) return;

  if (reset) {
    messages.value = [];
    hasMore.value = true;
  }

  if (!hasMore.value) return;

  const isLoading = reset ? loading.value : loadingMore.value;
  if (isLoading) return;

  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = '';

  try {
    const data = await api.getSessionMessages(props.session.session_key);

    let msgs: ChatMessage[] = [];
    if (Array.isArray(data)) {
      // 旧版兼容：直接返回数组
      msgs = (data as MessageDTO[]).map(m => ({
        id: m.id,
        sender: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'agent' : m.role,
        content: m.content,
        timestamp: m.created_at,
      }));
    } else if (data.messages && Array.isArray(data.messages)) {
      // 标准格式：{ messages: MessageDTO[] }
      msgs = (data.messages as MessageDTO[]).map(m => ({
        id: m.id,
        sender: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'agent' : m.role,
        content: m.content,
        timestamp: m.created_at,
      }));
    }

    if (reset) {
      messages.value = msgs;
    } else {
      // Prepend older messages
      const existingIds = new Set(messages.value.map(m => m.id));
      const newMsgs = msgs.filter(m => !existingIds.has(m.id));
      messages.value = [...newMsgs, ...messages.value];
    }

    hasMore.value = msgs.length === 20;
  } catch (e: any) {
    error.value = e.message || '获取消息失败';
    ElMessage.error('获取消息失败: ' + (e.message || e));
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function loadMore() {
  if (hasMore.value && !loadingMore.value) {
    fetchMessages(false);
  }
}

function isUserMessage(msg: ChatMessage): boolean {
  const sender = (msg.sender || '').toLowerCase();
  return sender === 'user' || sender === 'human' || sender === 'you';
}

watch(() => props.session, (newSession) => {
  if (!newSession) {
    messages.value = [];
    hasMore.value = true;
    return;
  }
  fetchMessages(true);
});

// Scroll to bottom when messages change
watch(messages, async () => {
  await nextTick();
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
  }
}, { deep: true });

defineExpose({ fetchMessages });
</script>

<template>
  <div class="chat-panel">
    <!-- 会话信息头部 -->
    <div class="chat-header" v-if="session">
      <div class="session-info">
        <el-tag size="small" type="info">{{ session.agent_id }}</el-tag>
        <span class="session-key-full" :title="session.session_key">{{ session.session_key }}</span>
      </div>
      <div class="header-meta">
        <span class="meta-item">
          <span class="meta-label">渠道</span>
          <span class="meta-value">{{ session.channel }}</span>
        </span>
        <span class="meta-item">
          <span class="meta-label">消息</span>
          <span class="meta-value">{{ session.message_count }}</span>
        </span>
        <span class="meta-item">
          <span class="meta-label">最后消息</span>
          <span class="meta-value">{{ session.last_message_at ? formatTime(session.last_message_at) : '-' }}</span>
        </span>
      </div>
    </div>

    <!-- 空状态 -->
    <EmptyState v-if="!session" icon="💬" title="选择左侧会话查看聊天记录" />

    <!-- 消息区域 -->
    <template v-else>
      <div class="chat-messages-wrap" ref="chatContainerRef">
        <!-- 加载更多 -->
        <div class="load-more-row" v-if="hasMore && messages.length > 0">
          <el-button size="small" :loading="loadingMore" @click="loadMore">
            加载更多
          </el-button>
        </div>

        <!-- 加载中 -->
        <div class="loading-row" v-if="loading && messages.length === 0">
          <el-icon class="is-loading"><Refresh /></el-icon>
          <span>加载中...</span>
        </div>

        <!-- 错误 -->
        <div class="error-row" v-if="error && messages.length === 0">
          {{ error }}
        </div>

        <!-- 无消息 -->
        <EmptyState v-if="!loading && messages.length === 0 && !error" icon="💬" title="暂无消息记录" />

        <!-- 消息气泡 -->
        <div class="messages-list">
          <div
            v-for="msg in messages"
            :key="msg.id"
            class="message-row"
            :class="{ 'message-row-user': isUserMessage(msg), 'message-row-agent': !isUserMessage(msg) }"
          >
            <div class="bubble" :class="{ 'bubble-user': isUserMessage(msg), 'bubble-agent': !isUserMessage(msg) }">
              <div class="bubble-sender">
                {{ isUserMessage(msg) ? '你' : msg.sender || 'Agent' }}
              </div>
              <MarkdownContent :content="msg.content" class="bubble-content" />
              <div class="bubble-time">{{ formatTime(msg.timestamp) }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 400px;
  background: var(--color-bg);
}

.chat-header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.session-key-full {
  font-size: 12px;
  font-family: monospace;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-meta {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.meta-label {
  color: var(--color-text-secondary);
}

.meta-value {
  color: var(--color-text);
  font-family: monospace;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
  color: var(--color-text-secondary);
}

.chat-messages-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.load-more-row {
  text-align: center;
  margin-bottom: 12px;
}

.loading-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.error-row {
  text-align: center;
  padding: 24px;
  color: var(--color-accent-red);
  font-size: 13px;
}

.empty-messages {
  text-align: center;
  padding: 48px 24px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.messages-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message-row {
  display: flex;
  width: 100%;
}

.message-row-user {
  justify-content: flex-end;
}

.message-row-agent {
  justify-content: flex-start;
}

.bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  position: relative;
}

.bubble-user {
  background: var(--color-accent-blue-subtle);
  color: var(--color-text);
  border-bottom-right-radius: 4px;
  border: 1px solid var(--color-border-subtle);
}

.bubble-agent {
  background: var(--color-bg-subtle);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-bottom-left-radius: 4px;
}

.bubble-sender {
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  opacity: 0.75;
}

.bubble-content {
  word-break: break-word;
  white-space: pre-wrap;
}

.bubble-time {
  font-size: 10px;
  margin-top: 4px;
  opacity: 0.6;
  text-align: right;
}
</style>
