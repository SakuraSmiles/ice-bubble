<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import MarkdownContent from '../../components/MarkdownContent.vue';
import { gatewayClient } from '@/services/gateway-client';

// =========== Props ===========
const props = withDefaults(defineProps<{
  sessionKey?: string;
}>(), {
  sessionKey: undefined,
});

// =========== 类型定义 ===========
interface TimelineMessage {
  id: number;
  session_key: string;
  agent_id: string;
  agent_name: string;
  avatar: string | null;
  message_type: 'user' | 'agent' | 'tool';
  content: string | null;
  clean_content: string | null;
  content_summary: string | null;
  is_cron: boolean;
  is_system_noise: boolean;
  is_system_context?: number | boolean;
  source_channel: string | null;
  model: string | null;
  timestamp: string;
}

interface TimelineResponse {
  messages: TimelineMessage[];
  has_more: boolean;
  pagination: {
    oldest: string | null;
    newest: string | null;
    total_in_range: number;
  };
  meta: {
    agents_in_range: string[];
    filter_applied: Record<string, unknown>;
  };
}

// =========== 数据 ===========
const messages = ref<TimelineMessage[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(true);
const newMsgCount = ref(0);
const atBottom = ref(true);
const containerRef = ref<HTMLElement | null>(null);

const PAGE_SIZE = 50;
/** 初始加载量（更大，减少首次撑不满概率） */
const INITIAL_LIMIT = 100;
let knownIds = new Set<number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

// =========== 加载逻辑 ===========

/** 检查当前是否在底部 */
function checkBottom() {
  const el = containerRef.value;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  atBottom.value = gap < 60;
}

/** 默认过滤参数：排除系统噪音和定时任务（computed，确保 prop 变化后 filter 正确） */
const filters = computed(() =>
  `exclude_system_noise=true&exclude_cron=true${props.sessionKey ? `&session_key=${encodeURIComponent(props.sessionKey)}` : ''}`
);

/** 滚到底部 */
function scrollToBottom(smooth = true) {
  const el = containerRef.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

/** 初始加载：最新 N 条 */
async function loadLatest() {
  loading.value = true;
  try {
    const url = `/api/messages/timeline?limit=${INITIAL_LIMIT}&${filters.value}`;
    console.log('[ChatTimeline] loadLatest url:', url, 'sessionKey:', props.sessionKey);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`loadLatest HTTP ${res.status}`);
    const data: TimelineResponse = await res.json();
    console.log('[ChatTimeline] loadLatest result:', data.messages?.length, 'has_more:', data.has_more);
    setMessages(data.messages);
    hasMore.value = data.has_more;
    // 如果初始加载后内容没撑满容器，继续加载更多直到撑满或耗尽
    await fillScrollable();
  } catch (e) {
    console.error('加载聊天记录失败', e);
  } finally {
    loading.value = false;
  }
}

/** 加载更多历史 —— 追加到列表前面，然后恢复滚动位置 */
async function loadMore() {
  if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
  loadingMore.value = true;

  // 记录加载前的滚动高度和第一条消息 id
  const el = containerRef.value;
  const prevScrollTop = el?.scrollTop ?? 0;
  const prevScrollHeight = el?.scrollHeight ?? 0;

  try {
    const oldest = messages.value[0].timestamp;
    const res = await fetch(`/api/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}&${filters.value}`, { credentials: 'include' });
    if (!res.ok) return;
    const data: TimelineResponse = await res.json();
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      hasMore.value = false;
      return;
    }
    const newMsgs = data.messages.filter(m => !knownIds.has(m.id));
    if (newMsgs.length > 0) {
      messages.value = [...newMsgs, ...messages.value].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      newMsgs.forEach(m => knownIds.add(m.id));
      hasMore.value = !!data.has_more;
    }
  } catch (e) {
    console.error('加载更多失败', e);
  } finally {
    loadingMore.value = false;
  }

  // 恢复滚动位置：新内容加到顶部后，把滚动条往上推 delta 高度
  // 这样用户看到的内容保持不变（浏览器默认 scrollTop 不变）
  await nextTick();
  if (el) {
    const delta = el.scrollHeight - prevScrollHeight;
    el.scrollTop = prevScrollTop + delta;
  }
}

/** 轮询最新消息 — 使用 since 获取增量，避免活跃 session 消息被淹没 */
async function pollLatest() {
  // 用已知最新消息的 timestamp 作为 since，只拉增量
  const newestTs = messages.value.length > 0
    ? messages.value[messages.value.length - 1].timestamp
    : undefined;

  const sinceParam = newestTs ? `&since=${encodeURIComponent(newestTs)}` : '';
  const res = await fetch(`/api/messages/timeline?limit=50&${filters.value}${sinceParam}`, { credentials: 'include' });
  if (!res.ok) return;
  const data: TimelineResponse = await res.json();
  if (!Array.isArray(data.messages) || data.messages.length === 0) return;

  // 过滤出真正的新消息，同时排除空内容用户消息
  const newMsgs = data.messages.filter(m => !knownIds.has(m.id) && !isEmptyUserMsg(m));
  if (newMsgs.length === 0) return;

  // 加到列表末尾，按时间排序
  newMsgs.forEach(m => knownIds.add(m.id));
  messages.value = [...messages.value, ...newMsgs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  if (atBottom.value) {
    await nextTick();
    scrollToBottom(false);
  } else {
    newMsgCount.value += newMsgs.length;
  }
}

/** 点击新消息提示跳到底部 */
function goToBottom() {
  scrollToBottom();
  newMsgCount.value = 0;
}

/**
 * 如果内容未撑满容器，最多加载 2 批历史直到撑满或耗尽
 */
async function fillScrollable() {
  const el = containerRef.value;
  if (!el) return;

  let batches = 0;
  while (batches < 2 && hasMore.value) {
    if (el.scrollHeight > el.clientHeight + 10) break;

    const oldest = messages.value[0]?.timestamp;
    if (!oldest) break;

    const res = await fetch(`/api/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}&${filters.value}`, { credentials: 'include' });
    if (!res.ok) break;
    const data: TimelineResponse = await res.json();
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      hasMore.value = false;
      break;
    }

    const newMsgs = data.messages.filter(m => !knownIds.has(m.id));
    if (newMsgs.length === 0) break;

    newMsgs.forEach(m => knownIds.add(m.id));
    messages.value = [...newMsgs, ...messages.value].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    hasMore.value = data.has_more;

    await nextTick();
    batches++;
  }
}

/** 空内容过滤：排除内容为空的用户消息（如 HEARTBEAT_OK, NO_REPLY 等系统注入） */
function isEmptyUserMsg(m: TimelineMessage): boolean {
  return m.message_type === 'user' && !m.content && !m.clean_content;
}

function setMessages(msgs: TimelineMessage[]) {
  knownIds.clear();
  const seen = new Set<number>();
  const filtered = msgs.filter(m => {
    if (isEmptyUserMsg(m)) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  filtered.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  messages.value = filtered;
  filtered.forEach(m => knownIds.add(m.id));
}

// =========== 滚动事件 ===========
/** 仅用于检测是否在底部（新消息自动滚） */
function onScroll() {
  checkBottom();
}

// =========== Gateway 实时事件 ===========
let unsubSessionMsg: (() => void) | null = null;
let unsubChat: (() => void) | null = null;

/** 当收到 session.message 事件时，实时追加到时间线 */
function subscribeGatewayEvents() {
  // 监听会话消息（实时推送所有会话的新消息）
  unsubSessionMsg = gatewayClient.on('session.message', (payload: unknown) => {
    const data = payload as Record<string, unknown> | undefined;
    if (!data) return;

    // 如果有 sessionKey prop，只处理该会话的消息
    const msgSessionKey = data.sessionKey as string | undefined;
    if (props.sessionKey && msgSessionKey !== props.sessionKey) return;

    // 将 push 过来的消息转为 TimelineMessage 格式并追加
    const msg = payloadToMessage(data);
    if (!msg || knownIds.has(msg.id)) return;

    knownIds.add(msg.id);
    messages.value = [...messages.value, msg].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (atBottom.value) {
      nextTick(() => scrollToBottom(false));
    } else {
      newMsgCount.value++;
    }
  });

  // 监听 chat 事件（Agent 回复增量）
  unsubChat = gatewayClient.on('chat', (payload: unknown) => {
    const data = payload as Record<string, unknown> | undefined;
    if (!data) return;

    const msgSessionKey = data.sessionKey as string | undefined;
    if (props.sessionKey && msgSessionKey !== props.sessionKey) return;

    const msg = payloadToMessage(data);
    if (!msg || knownIds.has(msg.id)) return;

    knownIds.add(msg.id);
    messages.value = [...messages.value, msg].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (atBottom.value) {
      nextTick(() => scrollToBottom(false));
    } else {
      newMsgCount.value++;
    }
  });
}

/** 将 Gateway 事件 payload 转为 TimelineMessage 格式 */
function payloadToMessage(data: Record<string, unknown>): TimelineMessage | null {
  const id = data.id as number | undefined;
  const content = data.content as string | undefined;
  const role = data.role as string | undefined;

  // id 和 content 必须有其中一个
  if (!id && !content) return null;

  const msgType = role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'agent';

  return {
    id: id ?? Date.now(),
    session_key: (data.sessionKey as string) || '',
    agent_id: (data.agentId as string) || (role === 'user' ? 'user' : 'assistant'),
    agent_name: (data.agentName as string) || (role === 'user' ? 'You' : ''),
    avatar: (data.avatar as string) ?? null,
    message_type: msgType,
    content: content ?? null,
    clean_content: content ?? null,
    content_summary: null,
    is_cron: false,
    is_system_noise: false,
    source_channel: (data.sourceChannel as string) ?? null,
    model: (data.model as string) ?? null,
    timestamp: (data.timestamp as string) || new Date().toISOString(),
  };
}

function unsubscribeGatewayEvents() {
  if (unsubSessionMsg) { unsubSessionMsg(); unsubSessionMsg = null; }
  if (unsubChat) { unsubChat(); unsubChat = null; }
}

// =========== 生命周期 ===========
watch(() => props.sessionKey, (newKey) => {
  // 当 sessionKey 变化时重新加载（:key 也触发重建，但 watch 提供双重保障）
  if (newKey !== undefined) {
    knownIds.clear();
    messages.value = [];
    loadLatest();
  }
});

onMounted(async () => {
  await loadLatest();
  await nextTick();
  // 如果初始加载后内容没撑满容器，继续加载更多直到撑满或耗尽
  await fillScrollable();
  scrollToBottom(false);
  checkBottom();

  // Gateway 实时事件（增量更新）
  subscribeGatewayEvents();

  // 保留轮询作为降级方案（Gateway 未连接时生效）
  pollTimer = setInterval(() => {
    if (!gatewayClient.isConnected) {
      pollLatest();
    }
  }, 5000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  unsubscribeGatewayEvents();
});

defineExpose({
  getMessages: () => messages.value,
  addOptimisticMessage(content: string, role: string = 'user') {
    const msg: TimelineMessage = {
      id: Date.now(),
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
    };
    knownIds.add(msg.id);
    messages.value = [...messages.value, msg];
    nextTick(() => scrollToBottom(false));
  },
});

// =========== 过滤系统上下文消息 ===========
const visibleMessages = computed(() =>
  messages.value.filter(m => !m.is_system_context)
);

// =========== 消息分组 ===========
type MsgGroup = {
  type: 'user' | 'agent';
  agentId: string;
  agentName: string;
  avatar: string | null;
  timestamp: string;
  messages: TimelineMessage[];
  toolMsgs: TimelineMessage[];
  hiddenToolCount: number;
};

const groupedMessages = computed(() => {
  const groups: MsgGroup[] = [];
  let current: MsgGroup | null = null;

  for (const msg of visibleMessages.value) {
    const role = msg.message_type === 'tool' ? 'agent' : msg.message_type;
    if (role === 'user') {
      // 用户消息独立成组
      if (current) { groups.push(current); current = null; }
      groups.push({
        type: 'user',
        agentId: '',
        agentName: '',
        avatar: null,
        timestamp: msg.timestamp,
        messages: [msg],
        toolMsgs: [],
        hiddenToolCount: 0,
      });
    } else if (role === 'agent') {
      // tool 消息不能独立成组，必须合并到前置 agent 消息组
      if (current && current.type === 'agent' && current.agentId === msg.agent_id) {
        if (msg.message_type === 'tool') {
          current.toolMsgs.push(msg);
        } else {
          current.messages.push(msg);
        }
      } else if (msg.message_type === 'tool' && current && current.type === 'agent') {
        // tool 消息跟随当前 agent 组（即使 agent_id 不同也尽量合并）
        current.toolMsgs.push(msg);
      } else {
        if (current) groups.push(current);
        current = {
          type: 'agent',
          agentId: msg.agent_id,
          agentName: msg.agent_name,
          avatar: msg.avatar,
          timestamp: msg.timestamp,
          messages: msg.message_type === 'tool' ? [] : [msg],
          toolMsgs: msg.message_type === 'tool' ? [msg] : [],
          hiddenToolCount: 0,
        };
        // 工具消息独立成组时，至少赋一个占位消息避免渲染报错
        if (current.messages.length === 0) {
          current.messages.push({
            id: msg.id,
            content: '',
            clean_content: '',
            message_type: 'agent',
            agent_id: msg.agent_id,
            agent_name: msg.agent_name,
            timestamp: msg.timestamp,
          } as any);
        }
      }
    }
  }
  if (current) groups.push(current);

  // 合并连续 tool 消息：超过 3 条时只保留前 2 条 + 统计信息
  for (const grp of groups) {
    if (grp.toolMsgs.length > 3) {
      grp.hiddenToolCount = grp.toolMsgs.length - 2;
      grp.toolMsgs = grp.toolMsgs.slice(0, 2);
    }
  }

  return groups;
});

// =========== 工具函数 ===========
/** 从工具消息内容中提取工具名称 */
function extractToolName(content: string | null): string {
  if (!content) return 'tool';
  // 尝试匹配 "Tool: xxx" 或 JSON 格式中的 tool 字段
  const match = content.match(/Tool:\s*(\S+)/) || content.match(/"tool"\s*:\s*"([^"]+)"/);
  if (match) return match[1];
  // 尝试在第一行找到工具名
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length < 60) return firstLine;
  return 'tool';
}

function truncateToolContent(content: string | null, maxLen = 150): string {
  if (!content) return '';
  if (content.length <= maxLen) return content;
  return content.substring(0, maxLen) + '...';
}

function formatTime(ts: string) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function toolSummary(grp: MsgGroup): string {
  const visible = grp.toolMsgs.length;
  const total = visible + grp.hiddenToolCount;
  const names = [...new Set(grp.toolMsgs.map(tm => extractToolName(tm.content)))];
  const nameStr = names.length > 0 ? names.join(', ') : '';
  const nameLabel = nameStr ? ` (${nameStr})` : '';
  return `🛠 调用了 ${total} 次工具${nameLabel}`;
}
</script>

<template>
  <div class="chat-wrap">
    <!-- 新消息提示 -->
    <div v-if="newMsgCount > 0" class="new-msg-banner" @click="goToBottom">
      ↓ {{ newMsgCount }} 条新消息
    </div>

    <!-- 消息列表 -->
    <div ref="containerRef" class="chat-scroll" @scroll="onScroll">
      <!-- 加载更多按钮（在列表顶部显示） -->
      <div v-if="hasMore && !loading" class="load-more-bar">
        <button class="load-more-btn" @click="loadMore" :disabled="loadingMore">
          {{ loadingMore ? '加载中...' : '↑ 加载更早消息' }}
        </button>
      </div>

      <!-- 首加载 -->
      <div v-if="loading && messages.length === 0" class="empty-tip">加载中...</div>
      <div v-else-if="messages.length === 0" class="empty-tip">暂无消息</div>

      <!-- 消息组 -->
      <template v-for="(grp, gi) in groupedMessages" :key="gi">
        <!-- 用户消息 -->
        <div v-if="grp.type === 'user'" class="msg-row msg-row--user" :data-msg-id="grp.messages[0].id">
          <div class="msg-header msg-header--user">
            <span class="msg-time">{{ formatTime(grp.timestamp) }}</span>
            <span v-if="grp.messages[0]?.source_channel" class="channel-tag">{{ grp.messages[0].source_channel }}</span>
          </div>
          <div class="bubble bubble--user">
            <MarkdownContent :content="grp.messages[0]?.clean_content || grp.messages[0]?.content || ''" />
          </div>
        </div>

        <!-- Agent 消息 -->
        <div v-else class="msg-row msg-row--agent" :data-msg-id="grp.messages[0].id">
          <!-- 头像列 -->
          <div class="agent-avatar-col">
            <img
              v-if="grp.avatar"
              :src="`/api/resources/avatars/${grp.avatar}`"
              class="avatar"
            />
            <div class="avatar-placeholder" v-else>{{ grp.agentName[0] }}</div>
          </div>
          <!-- 内容列 -->
          <div class="agent-content-col">
            <div class="msg-header msg-header--agent">
              <span class="agent-label-name">{{ grp.agentName }}</span>
              <span v-if="grp.messages[0]?.model" class="model-tag">{{ grp.messages[0].model }}</span>
              <span class="msg-time">{{ formatTime(grp.timestamp) }}</span>
            </div>
            <div class="bubble bubble--agent">
              <div class="bubble-text" v-for="(m, mi) in grp.messages" :key="mi">
                <MarkdownContent :content="m.content || ''" />
              </div>
              <!-- 工具消息折叠 -->
              <details v-if="grp.toolMsgs.length > 0" class="tool-details">
                <summary>{{ toolSummary(grp) }}{{ grp.hiddenToolCount > 0 ? `，还有 ${grp.hiddenToolCount} 条` : '' }}</summary>
                <div v-for="(tm, ti) in grp.toolMsgs" :key="ti" class="tool-item">
                  <div class="tool-item-header">{{ extractToolName(tm.content) }}</div>
                  <pre class="tool-item-body">{{ truncateToolContent(tm.content) }}</pre>
                </div>
              </details>
            </div>
          </div>
        </div>
      </template>
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

/* 新消息提示 - 底部 */
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

/* 滚动区域 - 类微信聊天背景 */
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: #fff;
}

/* 加载更多按钮 */
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

.load-tip, .empty-tip {
  text-align: center;
  color: #999;
  font-size: 12px;
  padding: 20px 0;
}

/* 消息行 */
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

/* Agent 头像列 */
.agent-avatar-col {
  width: 30px;
  flex-shrink: 0;
  padding-top: 2px;
}

/* Agent 内容列 */
.agent-content-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.avatar, .avatar-placeholder {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-placeholder {
  background: var(--el-color-primary-light-3);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
}

/* Agent 内容包裹（用于对齐头部+气泡） */

/* 消息头顶部（时间 + 名称/渠道） */
.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #999;
  padding: 0 6px;
}
.msg-header--user {
  justify-content: flex-end;
}

.msg-time {
  white-space: nowrap;
}

.agent-label-name {
  font-weight: 600;
  color: #5a7fb5;
  font-size: 12px;
}

/* 气泡 */
.bubble {
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.bubble--user {
  background: #e8eaf6;
  color: #333;
  border-radius: 14px 14px 4px 14px;
}
.bubble--agent {
  background: #f7f8fa;
  color: #222;
  border-radius: 14px 14px 14px 4px;
  max-width: 100%;
}

.bubble-text {
  margin-bottom: 2px;
}

/* 消息渠道标签 - 代码风格 */
.channel-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 9px;
  color: #9aa0a6;
  background: #f0f1f3;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
}

/* 模型标签 */
.model-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 9px;
  color: #8ab4f8;
  background: #e8f0fe;
  padding: 1px 6px;
  border-radius: 3px;
}

/* 工具折叠 */
.tool-details {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e8e8e8;
}
.tool-details summary {
  cursor: pointer;
  color: #888;
  font-size: 11px;
}
.tool-details summary:hover {
  color: #5a7fb5;
}
.tool-item {
  margin-top: 6px;
  padding: 6px 8px;
  background: #f7f7f7;
  border-radius: 4px;
  font-size: 11px;
}
.tool-item-header {
  font-weight: 600;
  color: #5a7fb5;
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
</style>
