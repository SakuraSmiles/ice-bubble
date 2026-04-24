<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import type { TimelineMessageDTO } from '../../api/client';

// =========== 数据加载 ===========
const messages = ref<TimelineMessageDTO[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const hasMore = ref(true);
const newMessageCount = ref(0);
const isAtBottom = ref(true);
const containerRef = ref<HTMLElement | null>(null);

const PAGE_SIZE = 50;

async function loadMessages() {
  try {
    loading.value = true;
    error.value = null;
    const res = await fetch('/api/messages/timeline?limit=' + PAGE_SIZE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages.value = data.messages || [];
    hasMore.value = messages.value.length >= PAGE_SIZE;
    newMessageCount.value = 0;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  try {
    loadingMore.value = true;
    const before = messages.value[0]?.timestamp;
    const res = await fetch('/api/messages/timeline?limit=' + PAGE_SIZE + '&before=' + encodeURIComponent(before));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const older = data.messages || [];
    if (older.length > 0) {
      messages.value = [...older, ...messages.value];
    }
    hasMore.value = older.length >= PAGE_SIZE;
  } catch (e) {
    console.error('加载更多失败', e);
  } finally {
    loadingMore.value = false;
  }
}

function checkAtBottom() {
  const el = containerRef.value;
  if (!el) return;
  isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}

function scrollToBottom(smooth = true) {
  const el = containerRef.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  newMessageCount.value = 0;
}

function onScroll() {
  checkAtBottom();
  const el = containerRef.value;
  if (!el) return;
  if (el.scrollTop < 80) {
    loadMore();
  }
}

// 自动刷新
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastTimestamp = '';

watch(messages, (newMsgs) => {
  if (newMsgs.length > 0) {
    const latest = newMsgs[newMsgs.length - 1].timestamp;
    if (lastTimestamp && latest !== lastTimestamp) {
      // 有新消息
      if (!isAtBottom.value) {
        newMessageCount.value++;
      } else {
        nextTick(() => scrollToBottom());
      }
    }
    lastTimestamp = latest;
  }
}, { deep: true });

onMounted(async () => {
  await loadMessages();
  await nextTick();
  scrollToBottom(false);
  checkAtBottom();

  refreshTimer = setInterval(async () => {
    if (isAtBottom.value) {
      await loadMessages();
      await nextTick();
      scrollToBottom(false);
    }
  }, 5000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

// =========== 对外暴露 ===========
defineExpose({
  getMessages: () => messages.value,
});

// =========== 消息分组 ===========
const groupedMessages = computed(() => {
  const groups: Array<{
    type: 'user' | 'agent' | 'tool';
    agentName: string;
    agentAvatar: string | null;
    messages: TimelineMessageDTO[];
    timestamp: string;
  }> = [];

  const allMessages = [...messages.value]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let currentGroup: TimelineMessageDTO[] = [];
  let currentAgentName = '';
  let currentType = '';

  for (const msg of allMessages) {
    const isUserMsg = msg.message_type === 'user';
    const isAgentMsg = msg.message_type === 'agent';

    if (
      currentGroup.length === 0 ||
      (isAgentMsg && (currentType === 'user' || currentType === 'tool')) ||
      (isAgentMsg && currentAgentName !== msg.agent_name) ||
      isUserMsg
    ) {
      if (currentGroup.length > 0) {
        const first = currentGroup[0];
        groups.push({
          type: first.message_type as 'user' | 'agent' | 'tool',
          agentName: first.agent_name,
          agentAvatar: first.avatar,
          messages: currentGroup,
          timestamp: first.timestamp,
        });
      }
      currentGroup = [msg];
      currentAgentName = msg.agent_name;
      currentType = msg.message_type;
    } else {
      currentGroup.push(msg);
    }
  }

  if (currentGroup.length > 0) {
    const first = currentGroup[0];
    groups.push({
      type: first.message_type as 'user' | 'agent' | 'tool',
      agentName: first.agent_name,
      agentAvatar: first.avatar,
      messages: currentGroup,
      timestamp: first.timestamp,
    });
  }

  return groups;
});

// =========== 工具概览 ===========
function getToolSummary(groupMessages: TimelineMessageDTO[]): string {
  const toolCalls = groupMessages.filter(m => m.message_type === 'tool');
  const types = new Set<string>();
  toolCalls.forEach(m => {
    const content = m.content || '';
    if (content.includes('file') || content.includes('write') || content.includes('edit')) {
      types.add('📝 文件编辑');
    } else if (content.includes('shell') || content.includes('exec') || content.includes('command')) {
      types.add('💻 Shell');
    } else if (content.includes('api') || content.includes('http') || content.includes('fetch')) {
      types.add('📡 API响应');
    } else {
      types.add('🔧 工具调用');
    }
  });
  return `🔧 调用了 ${toolCalls.length} 次工具 ${Array.from(types).join(' ')}`;
}
</script>

<template>
  <div class="chat-container">
    <!-- 加载状态 -->
    <div v-if="loading && messages.length === 0" class="timeline-loading">
      <span>加载中...</span>
    </div>

    <div v-else-if="error && messages.length === 0" class="timeline-error">
      <span>{{ error }}</span>
      <button @click="loadMessages">重试</button>
    </div>

    <template v-else>
      <!-- 新消息提示 -->
      <div v-if="newMessageCount > 0" class="new-message-banner" @click="scrollToBottom()">
        <span>↓ {{ newMessageCount }} 条新消息</span>
      </div>

      <!-- 消息列表 -->
      <div
        ref="containerRef"
        class="chat-body"
        @scroll="onScroll"
      >
        <!-- 加载历史 -->
        <div v-if="loadingMore" class="load-more-tip">加载更多...</div>

        <div
          v-for="(group, gi) in groupedMessages"
          :key="gi"
          :class="['message-group', `group-${group.type}`]"
        >
          <!-- 用户消息 -->
          <div v-if="group.type === 'user'" class="user-message">
            <div class="user-bubble">
              <div v-for="(msg, mi) in group.messages" :key="mi" class="user-text">
                {{ msg.content }}
              </div>
            </div>
          </div>

          <!-- Agent 消息 -->
          <div v-else-if="group.type === 'agent'" class="agent-message">
            <img
              v-if="group.agentAvatar"
              :src="`/api/resources/avatars/${group.agentAvatar}`"
              :alt="group.agentName"
              class="agent-avatar"
            />
            <div class="agent-bubble">
              <div class="agent-name">{{ group.agentName }}</div>
              <div class="agent-content">
                <div v-for="(msg, mi) in group.messages.filter(m => m.message_type === 'agent')" :key="mi">
                  {{ msg.content }}
                </div>
              </div>
              <div v-if="group.messages.some(m => m.message_type === 'tool')" class="tool-summary">
                <details>
                  <summary>{{ getToolSummary(group.messages) }}</summary>
                  <div
                    v-for="(msg, mi) in group.messages.filter(m => m.message_type === 'tool')"
                    :key="mi"
                    class="tool-detail"
                  >
                    <div class="tool-content">{{ msg.content?.substring(0, 300) }}</div>
                  </div>
                </details>
              </div>
              <div class="message-time">
                {{ new Date(group.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.timeline-loading,
.timeline-error {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--el-text-color-secondary);
}

.timeline-error {
  flex-direction: column;
  gap: 12px;
}

/* 新消息提示条 */
.new-message-banner {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--el-color-primary);
  color: #fff;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 12px;
  cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
}

.new-message-banner:hover {
  opacity: 0.9;
}

/* 消息列表 */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;
}

.load-more-tip {
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  padding: 8px;
}

/* 消息组 */
.message-group {
  display: flex;
}

.user-message {
  display: flex;
  justify-content: flex-end;
  width: 100%;
}

.user-bubble {
  max-width: 70%;
  background: var(--el-color-primary);
  color: white;
  padding: 10px 16px;
  border-radius: 16px 16px 4px 16px;
}

.user-text {
  line-height: 1.5;
  font-size: 14px;
}

.agent-message {
  display: flex;
  gap: 10px;
  width: 100%;
}

.agent-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.agent-bubble {
  flex: 1;
  background: var(--el-fill-color-light);
  padding: 10px 14px;
  border-radius: 16px 16px 16px 4px;
  max-width: 80%;
}

.agent-name {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
  color: var(--el-color-primary);
}

.agent-content {
  line-height: 1.5;
  font-size: 13px;
  margin-bottom: 6px;
}

.tool-summary {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.tool-summary summary {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.tool-detail {
  margin-top: 4px;
  padding: 6px;
  background: var(--el-fill-color);
  border-radius: 4px;
  font-size: 11px;
}

.tool-content {
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.message-time {
  margin-top: 4px;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}
</style>
