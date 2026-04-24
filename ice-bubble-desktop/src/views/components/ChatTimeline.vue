<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';

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

/** 默认过滤参数：排除系统噪音和定时任务 */
const DEFAULT_FILTERS = 'exclude_system_noise=true&exclude_cron=true';

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
    const res = await fetch(`/api/messages/timeline?limit=${PAGE_SIZE}&${DEFAULT_FILTERS}`);
    const data: TimelineResponse = await res.json();
    setMessages(data.messages);
    hasMore.value = data.has_more;
  } catch (e) {
    console.error('加载聊天记录失败', e);
  } finally {
    loading.value = false;
  }
}

/** 加载更多历史（滚动到顶部时触发） */
async function loadMore() {
  if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
  loadingMore.value = true;
  try {
    const oldest = messages.value[0].timestamp;
    const res = await fetch(`/api/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}&${DEFAULT_FILTERS}`);
    const data: TimelineResponse = await res.json();
    if (data.messages.length > 0) {
      // 去重后追加到前面
      const newMsgs = data.messages.filter(m => !knownIds.has(m.id));
      if (newMsgs.length > 0) {
        messages.value = [...newMsgs, ...messages.value];
        newMsgs.forEach(m => knownIds.add(m.id));
      }
      hasMore.value = data.has_more;
      // 如果返回不足量，说明没有了
      if (data.messages.length < PAGE_SIZE) {
        hasMore.value = false;
      }
    } else {
      hasMore.value = false;
    }
  } catch (e) {
    console.error('加载更多失败', e);
  } finally {
    loadingMore.value = false;
  }
}

/** 轮询最新消息 */
async function pollLatest() {
  const res = await fetch(`/api/messages/timeline?limit=20&${DEFAULT_FILTERS}`);
  const data: TimelineResponse = await res.json();
  if (!data.messages || data.messages.length === 0) return;

  // 过滤出真正的新消息
  const newMsgs = data.messages.filter(m => !knownIds.has(m.id));
  if (newMsgs.length === 0) return;

  // 加到列表末尾
  // 按时间排序插入（新消息可能比现有最新消息更早）
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

/** 设置消息 & 更新已知 ID 集合 */
function setMessages(msgs: TimelineMessage[]) {
  knownIds.clear();
  messages.value = msgs.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  msgs.forEach(m => knownIds.add(m.id));
}

// =========== 滚动事件 ===========
function onScroll() {
  checkBottom();
  // 滚动到顶部附近时加载更多
  const el = containerRef.value;
  if (!el || el.scrollTop > 100) return;
  loadMore();
}

// =========== 生命周期 ===========
onMounted(async () => {
  await loadLatest();
  await nextTick();
  scrollToBottom(false);
  checkBottom();

  // 每 5 秒轮询
  pollTimer = setInterval(pollLatest, 5000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

defineExpose({ getMessages: () => messages.value });

// =========== 消息分组 ===========
type MsgGroup = {
  type: 'user' | 'agent';
  agentId: string;
  agentName: string;
  avatar: string | null;
  timestamp: string;
  messages: TimelineMessage[];
  toolMsgs: TimelineMessage[];
};

const groupedMessages = computed(() => {
  const groups: MsgGroup[] = [];
  let current: MsgGroup | null = null;

  for (const msg of messages.value) {
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
      });
    } else if (role === 'agent') {
      // 同 agent 连续 agent 消息合并
      if (current && current.type === 'agent' && current.agentId === msg.agent_id) {
        if (msg.message_type === 'tool') {
          current.toolMsgs.push(msg);
        } else {
          current.messages.push(msg);
        }
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
        };
      }
    }
  }
  if (current) groups.push(current);
  return groups;
});

// =========== 工具函数 ===========
function formatTime(ts: string) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function toolSummary(toolMsgs: TimelineMessage[]): string {
  return `🛠 调用了 ${toolMsgs.length} 次工具`;
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
      <!-- 加载更多 -->
      <div v-if="loadingMore" class="load-tip">加载更多...</div>

      <!-- 首加载 -->
      <div v-if="loading && messages.length === 0" class="empty-tip">加载中...</div>
      <div v-else-if="messages.length === 0" class="empty-tip">暂无消息</div>

      <!-- 消息组 -->
      <template v-for="(grp, gi) in groupedMessages" :key="gi">
        <!-- 用户消息 -->
        <div v-if="grp.type === 'user'" class="msg-row msg-row--user">
          <div class="bubble bubble--user">
            {{ grp.messages[0]?.clean_content || grp.messages[0]?.content }}
          </div>
          <div class="meta meta--user">{{ formatTime(grp.timestamp) }}</div>
        </div>

        <!-- Agent 消息 -->
        <div v-else class="msg-row msg-row--agent">
          <img
            v-if="grp.avatar"
            :src="`/api/resources/avatars/${grp.avatar}`"
            class="avatar"
          />
          <div class="avatar-placeholder" v-else>{{ grp.agentName[0] }}</div>

          <div class="bubble bubble--agent">
            <div class="bubble-agent-name">{{ grp.agentName }}</div>
            <div class="bubble-text" v-for="(m, mi) in grp.messages" :key="mi">
              {{ m.content }}
            </div>
            <!-- 工具消息折叠 -->
            <details v-if="grp.toolMsgs.length > 0" class="tool-details">
              <summary>{{ toolSummary(grp.toolMsgs) }}</summary>
              <div v-for="(tm, ti) in grp.toolMsgs" :key="ti" class="tool-item">
                {{ tm.content?.substring(0, 300) }}...
              </div>
            </details>
            <div class="bubble-time">{{ formatTime(grp.timestamp) }}</div>
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

/* 滚动区域 */
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scroll-behavior: smooth;
}

.load-tip, .empty-tip {
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  padding: 16px 0;
}

/* 消息行 */
.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 90%;
}
.msg-row--user { align-self: flex-end; flex-direction: row-reverse; }
.msg-row--agent { align-self: flex-start; }

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

/* 气泡 */
.bubble {
  padding: 8px 14px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}
.bubble--user {
  background: #e3f2fd;
  color: var(--el-text-color-primary);
  border-radius: 14px 14px 4px 14px;
}
.bubble--agent {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  border-radius: 14px 14px 14px 4px;
  max-width: 100%;
}

.bubble-agent-name {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
  color: var(--el-color-primary);
}

.bubble-text {
  margin-bottom: 2px;
}

.meta {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  align-self: flex-end;
  padding-bottom: 4px;
  white-space: nowrap;
}
.meta--user { margin-right: 4px; }

.bubble-time {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  margin-top: 4px;
}

/* 工具折叠 */
.tool-details {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.tool-details summary {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.tool-item {
  margin-top: 4px;
  padding: 6px;
  background: var(--el-fill-color);
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
