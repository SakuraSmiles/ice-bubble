<script setup lang="ts">
/**
 * ChatTimeline — 聊天时间线主组件（瘦身后）
 *
 * 组合 useChatData + useGatewayStream + MessageBubble
 */
import { watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { Loading } from '@element-plus/icons-vue';
import { useChatData } from './chat/useChatData';
import { useGatewayStream } from './chat/useGatewayStream';
import MessageBubble from './chat/MessageBubble.vue';
import VirtualScroller from '@/components/VirtualScroller.vue';
import { gatewayClient } from '@/services/gateway-client';

const props = withDefaults(defineProps<{
  sessionKey?: string;
}>(), {
  sessionKey: undefined,
});

// ── 数据层 ──
const chatData = useChatData(() => props.sessionKey);

// ── Gateway 实时流 ──
const gwStream = useGatewayStream({
  getSessionKey: () => props.sessionKey,
  messages: chatData.messages,
  knownIds: chatData.knownIds,
  atBottom: chatData.atBottom,
  showTypingIndicator: chatData.showTypingIndicator,
  agentAvatar: chatData.agentAvatar,
  newMsgCount: chatData.newMsgCount,
  isSystemNoise: chatData.isSystemNoise,
  normalizeTimestamp: chatData.normalizeTimestamp,
  simpleHash: chatData.simpleHash,
  scrollToBottom: chatData.scrollToBottom,
});

// ── 时间/分组辅助 ──

function shouldShowTime(ts: string, groupIndex: number): boolean {
  if (groupIndex <= 0) return true;
  const prev = chatData.groupedMessages.value[groupIndex - 1];
  if (!prev) return true;
  const curDate = new Date(ts);
  const prevDate = new Date(prev.timestamp);
  if (curDate.getFullYear() === prevDate.getFullYear()
    && curDate.getMonth() === prevDate.getMonth()
    && curDate.getDate() === prevDate.getDate()
    && curDate.getHours() === prevDate.getHours()
    && curDate.getMinutes() === prevDate.getMinutes()) {
    return false;
  }
  return true;
}

/** 最后一条 agent 消息组的索引 */
const lastAgentGroupIndex = computed(() => {
  const groups = chatData.groupedMessages.value;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].type === 'agent') return i;
  }
  return -1;
});

// ── 重新生成 ──

async function regenerate() {
  const msgs = chatData.messages.value;
  // 找到最后的 agent 消息，往前找关联的 user 消息
  let lastAgentIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].message_type === 'agent') { lastAgentIdx = i; break; }
  }
  if (lastAgentIdx < 0) return;

  // 删除最后一条 agent 消息及之后的所有消息
  const removed = msgs.splice(lastAgentIdx);
  // 从 knownIds 中清除被删除的消息
  for (const m of removed) chatData.knownIds.delete(m.id);

  // 找到前一条 user 消息
  const lastUserMsg = [...msgs].reverse().find(m => m.message_type === 'user');
  if (!lastUserMsg) return;

  // 通过 Gateway 重新发送
  try {
    await gatewayClient.sendMessage(props.sessionKey!, lastUserMsg.content || '');
  } catch (e) {
    console.error('[ChatTimeline] regenerate failed', e);
  }
}

// ── 生命周期 ──

watch(() => props.sessionKey, async (newKey) => {
  if (newKey !== undefined) {
    chatData.reset();
    await chatData.loadLatest();
  }
});

onMounted(async () => {
  await chatData.loadLatest();
  gwStream.subscribe();
  chatData.checkBottom();
});

onUnmounted(() => {
  gwStream.unsubscribe();
});

defineExpose({
  getMessages: () => chatData.messages.value,
  addOptimisticMessage(content: string, role: string = 'user') {
    const msg = {
      id: `gw_${Date.now()}`,
      session_key: props.sessionKey || '',
      agent_id: role === 'user' ? 'user' : 'assistant',
      agent_name: role === 'user' ? 'You' : '',
      avatar: null,
      message_type: role === 'user' ? 'user' : 'agent',
      content,
      clean_content: content,
      content_summary: null,
      is_cron: false,
      is_system_noise: false,
      source_channel: role === 'user' ? 'desktop' : null,
      model: null,
      timestamp: new Date().toISOString(),
    } as any;
    chatData.knownIds.add(msg.id);
    chatData.messages.value = [...chatData.messages.value, msg];
    nextTick(() => chatData.scrollToBottom(false));
  },
});
</script>

<template>
  <div class="chat-wrap">
    <!-- 新消息提示 -->
    <div v-if="chatData.newMsgCount.value > 0" class="new-msg-banner" @click="chatData.goToBottom()">
      ↓ {{ chatData.newMsgCount.value }} 条新消息
    </div>

    <!-- 消息列表 -->
    <div :ref="(el: any) => { chatData.containerRef.value = el }" class="chat-scroll">
      <!-- 加载更多按钮 -->
      <div v-if="chatData.hasMore.value && !chatData.loading.value" class="load-more-bar">
        <button type="button" class="load-more-btn" @click="chatData.loadMore()" :disabled="chatData.loadingMore.value">
          {{ chatData.loadingMore.value ? '加载中...' : '↑ 加载更早消息' }}
        </button>
      </div>

      <!-- 首加载 -->
      <div v-if="chatData.loading.value && chatData.messages.value.length === 0" class="loading-tip">
        <el-icon class="is-loading" :size="20"><Loading /></el-icon>
        <span>加载中...</span>
      </div>
      <div v-else-if="chatData.messages.value.length === 0" class="empty-tip">暂无消息</div>

      <!-- 虚拟滚动消息列表 -->
      <VirtualScroller
        v-else
        :ref="(el: any) => { chatData.vsRef.value = el }"
        :items="chatData.groupedMessages.value"
        :item-height="120"
        :dynamic-height="true"
        container-height="100%"
        :overscan="5"
        class="vs-timeline"
        @scroll="chatData.onScroll()"
      >
        <template #default="{ item: grp, index: gi }">
          <!-- 日期分隔线 -->
          <div v-if="grp.type === 'date-divider'" class="date-divider">
            <span class="date-divider-line"></span>
            <span class="date-divider-text">{{ grp.dateLabel }}</span>
            <span class="date-divider-line"></span>
          </div>
          <MessageBubble
            v-else
            :group="grp"
            :group-index="gi"
            :is-last-agent-group="gi === lastAgentGroupIndex"
            :should-show-time="shouldShowTime"
            :format-time="chatData.formatTime"
            :extract-tool-name="chatData.extractToolName"
            :truncate-tool-content="chatData.truncateToolContent"
            :tool-summary="chatData.toolSummary"
            @regenerate="regenerate"
          />
        </template>
      </VirtualScroller>

      <!-- 打字指示器（放在 VirtualScroller 外部底部） -->
      <div v-if="chatData.showTypingIndicator.value" class="typing-indicator">
        <div class="agent-avatar-col">
          <div class="avatar-placeholder">?</div>
        </div>
        <div class="typing-bubble">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.new-msg-banner {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--el-color-primary);
  color: #fff;
  padding: 6px 18px;
  border-radius: 20px;
  font-size: 12px;
  cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
  white-space: nowrap;
}
.new-msg-banner:hover { opacity: 0.9; }

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--color-bg-canvas);
}

.load-more-bar {
  text-align: center;
  padding: 8px 0 4px;
}
.load-more-btn {
  background: transparent;
  border: 1px solid #e0e0e0;
  border-radius: 16px;
  padding: 5px 20px;
  font-size: 12px;
  color: #888;
  cursor: pointer;
  transition: all 0.2s;
}
.load-more-btn:hover {
  border-color: #5a7fb5;
  color: #5a7fb5;
  background: #f0f4fc;
}
.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.load-tip, .empty-tip, .loading-tip {
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 12px;
  padding: 20px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

/* 日期分隔线 */
.date-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 4px;
  user-select: none;
}
.date-divider-line {
  flex: 1;
  height: 1px;
  background: var(--el-border-color-lighter);
}
.date-divider-text {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
}

/* 打字指示器 */
.typing-indicator {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 4px 0;
  align-self: flex-start;
}
.typing-bubble {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 16px;
  background: #fff;
  border-radius: 16px 16px 16px 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent-blue);
  animation: dot-bounce 1.2s infinite ease-in-out both;
}
.typing-dot:nth-child(1) { animation-delay: -0.32s; }
.typing-dot:nth-child(2) { animation-delay: -0.16s; }
@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.agent-avatar-col {
  width: 28px;
  flex-shrink: 0;
}

.avatar-placeholder {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-accent-blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}
</style>
