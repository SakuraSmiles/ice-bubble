<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import type { TimelineMessageDTO } from '../../api/client';

// =========== 对外暴露 ===========
defineExpose({
  getMessages: () => messages.value,
  cronMessages: cronMessages.value,
});

// =========== 数据加载 ===========
const messages = ref<TimelineMessageDTO[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function loadMessages() {
  try {
    loading.value = true;
    error.value = null;
    const res = await fetch('/api/messages/timeline?limit=200');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages.value = data.messages || [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

// 自动刷新
let refreshTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  loadMessages();
  refreshTimer = setInterval(loadMessages, 30000);
});

import { onUnmounted } from 'vue';
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

// =========== 定时任务消息过滤 ===========
const cronKeywords = [
  '任务状态巡检', '任务状态巡检员', '超时无进展',
  '子任务进度监控', '暂无活跃子任务',
  'Channel is required', 'no configured channels detected',
];

const cronMessages = ref<TimelineMessageDTO[]>([]);

const visibleMessages = computed(() => {
  const result: TimelineMessageDTO[] = [];
  const cronMsgs: TimelineMessageDTO[] = [];
  for (const msg of messages.value) {
    if (msg.message_type === 'system') continue;
    const content = msg.content || '';
    const isCron = cronKeywords.some(kw => content.includes(kw));
    if (isCron) {
      cronMsgs.push(msg);
    } else {
      result.push(msg);
    }
  }
  cronMessages.value = cronMsgs;
  return result;
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

  const allMessages = visibleMessages.value
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let currentGroup: TimelineMessageDTO[] = [];
  let currentAgentName = '';
  let currentType = '';

  for (const msg of allMessages) {
    const isToolMsg = msg.message_type === 'tool';
    const isUserMsg = msg.message_type === 'user';
    const isAgentMsg = msg.message_type === 'agent';

    // 决定是否开始新组
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
  <div class="chat-timeline">
    <div v-if="loading && messages.length === 0" class="timeline-loading">
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="timeline-error">
      <span>{{ error }}</span>
      <button @click="loadMessages">重试</button>
    </div>

    <div v-else class="timeline-content">
      <div
        v-for="(group, gi) in groupedMessages"
        :key="gi"
        :class="['message-group', `group-${group.type}`]"
      >
        <div v-if="group.type === 'user'" class="user-message">
          <div class="user-bubble">
            <div v-for="(msg, mi) in group.messages" :key="mi" class="user-text">
              {{ msg.content }}
            </div>
          </div>
        </div>

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
  </div>
</template>

<style scoped>
.chat-timeline {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.timeline-loading,
.timeline-error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--el-text-color-secondary);
}

.timeline-error {
  flex-direction: column;
  gap: 12px;
}

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
}

.agent-message {
  display: flex;
  gap: 12px;
  width: 100%;
}

.agent-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}

.agent-bubble {
  flex: 1;
  background: var(--el-fill-color-light);
  padding: 12px 16px;
  border-radius: 16px 16px 16px 4px;
  max-width: 85%;
}

.agent-name {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--el-color-primary);
}

.agent-content {
  line-height: 1.6;
  font-size: 14px;
  margin-bottom: 8px;
}

.tool-summary {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.tool-summary summary {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.tool-detail {
  margin-top: 4px;
  padding: 8px;
  background: var(--el-fill-color);
  border-radius: 4px;
  font-size: 12px;
}

.tool-content {
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.message-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
</style>
