<script setup lang="ts">
/**
 * DesignChat.vue — 设计对话面板
 */

import { ref, nextTick, watch, computed } from 'vue';
import { useDesignStore } from '@/stores/designStore';
import MessageInput from '@/views/components/MessageInput.vue';
import MarkdownContent from '@/components/MarkdownContent.vue';

const store = useDesignStore();

const messagesRef = ref<HTMLDivElement | null>(null);
const inputRef = ref<InstanceType<typeof MessageInput> | null>(null);

// 合并历史消息 + 当前流式文本
const displayMessages = computed(() => {
  const msgs = [...store.messages];
  if (store.streamText) {
    msgs.push({
      role: 'assistant',
      content: store.streamText,
      timestamp: Date.now(),
      _streaming: true,
    });
  }
  return msgs;
});

// 自动滚动到底部
watch(
  () => store.streamText.length,
  () => scrollToBottom(),
);

watch(
  () => store.messages.length,
  () => nextTick(scrollToBottom),
);

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
    }
  });
}

function handleSend(message: string) {
  store.sendMessage(message);
  nextTick(() => inputRef.value?.focus());
}

function handleAbort() {
  store.abortStream();
}
</script>

<template>
  <div class="design-chat">
    <!-- 消息列表 -->
    <div ref="messagesRef" class="chat-messages">
      <div v-if="store.messages.length === 0 && !store.isStreaming" class="chat-welcome">
        <span class="welcome-icon">✨</span>
        <h3>描述你想要的设计</h3>
        <p>例如：设计一个现代风格的登录页面，使用蓝色主题</p>
      </div>

      <div
        v-for="(msg, i) in displayMessages"
        :key="i"
        class="chat-msg"
        :class="`chat-msg--${msg.role}`"
      >
        <div class="chat-msg-avatar">
          <span v-if="msg.role === 'user'" class="avatar-user">你</span>
          <span v-else class="avatar-ai">AI</span>
        </div>
        <div class="chat-msg-content">
          <MarkdownContent v-if="msg.role === 'assistant'" :content="msg.content" />
          <div v-else class="user-text">{{ msg.content }}</div>
        </div>
      </div>
    </div>

    <!-- 输入框 -->
    <MessageInput
      ref="inputRef"
      placeholder="描述你的设计需求..."
      :streaming="store.isStreaming"
      @send="handleSend"
      @abort="handleAbort"
    />
  </div>
</template>

<style scoped>
.design-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chat-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  text-align: center;
}

.welcome-icon {
  font-size: 48px;
  opacity: 0.5;
}

.chat-welcome h3 {
  font-size: 18px;
  color: var(--el-text-color-primary);
  margin: 0;
  font-weight: 600;
}

.chat-welcome p {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 0;
  max-width: 400px;
}

.chat-msg {
  display: flex;
  gap: 10px;
  max-width: 85%;
}

.chat-msg--user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.chat-msg--assistant {
  align-self: flex-start;
}

.chat-msg-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.avatar-user {
  background: var(--el-color-primary-light-7, #c6e2ff);
  color: var(--el-color-primary);
}

.avatar-ai {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.chat-msg-content {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.chat-msg--user .chat-msg-content {
  background: var(--el-color-primary);
  color: #fff;
  border-top-right-radius: 4px;
}

.chat-msg--assistant .chat-msg-content {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  border-top-left-radius: 4px;
}

.user-text {
  white-space: pre-wrap;
}

/* Markdown 样式覆盖 */
.chat-msg-content :deep(.md-content) {
  font-size: 14px;
}

.chat-msg-content :deep(.md-content p) {
  margin: 0 0 8px;
}

.chat-msg-content :deep(.md-content p:last-child) {
  margin-bottom: 0;
}

.chat-msg-content :deep(.md-content code) {
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 13px;
}
</style>
