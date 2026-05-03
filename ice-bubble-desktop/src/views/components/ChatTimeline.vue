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
interface ToolCallEntry {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  phase: 'start' | 'end' | 'result' | 'partial' | 'error';
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface TimelineMessage {
  id: number;
  session_key: string;
  agent_id: string;
  agent_name: string | null;
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
  streamRunId?: string;
  streamState?: 'thinking' | 'streaming' | 'complete' | 'error';
  toolCalls?: ToolCallEntry[];
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
const useGateway = ref(false);
const showTypingIndicator = ref(false);
const agentAvatar = ref<string | null>(null);

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
    // 当有 sessionKey 时，优先使用 Gateway chat.history（数据完整）
    if (props.sessionKey) {
      // 使用 HTTP 代理获取 Gateway 历史消息（不依赖 WS 连接）
      console.log('[ChatTimeline] loadLatest via HTTP /api/chat/history, sessionKey:', props.sessionKey);
      const historyUrl = `/api/chat/history?sessionKey=${encodeURIComponent(props.sessionKey)}&limit=500`;
      const historyRes = await fetch(historyUrl, { credentials: 'include' });
      if (historyRes.ok) {
        const result = await historyRes.json() as any;
        const rawMsgs = result?.messages ?? result?.history ?? result ?? [];
        const arr = Array.isArray(rawMsgs) ? rawMsgs : [];

        const allMsgs = gatewayMsgsToTimeline(arr);
        const latest = allMsgs.slice(-INITIAL_LIMIT);
        console.log('[ChatTimeline] Gateway result:', allMsgs.length, 'displayed:', latest.length);
        setMessages(latest);
        useGateway.value = true;
        hasMore.value = allMsgs.length > INITIAL_LIMIT;
        // Gateway 不返回 avatar，从 Admin API 补充
        await fetchAgentAvatar();
        return; // Gateway 模式不需要 fillScrollable
      }
    }

    // 降级：使用 Admin timeline API
    useGateway.value = false;
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
    if (useGateway.value) {
      // Gateway 模式：通过 Gateway API 加载更早历史
      const oldest = messages.value[0].timestamp;
      const gwRes = await fetch(
        `/api/chat/history?sessionKey=${encodeURIComponent(props.sessionKey!)}&limit=50&before=${encodeURIComponent(oldest)}`,
        { credentials: 'include' }
      );
      if (!gwRes.ok) { hasMore.value = false; return; }
      const gwResult = await gwRes.json() as any;
      const rawMsgs = gwResult?.messages ?? gwResult?.history ?? gwResult ?? [];
      const arr = Array.isArray(rawMsgs) ? rawMsgs : [];
      const olderMsgs = gatewayMsgsToTimeline(arr);
      if (olderMsgs.length === 0) { hasMore.value = false; return; }
      messages.value = [...olderMsgs, ...messages.value];
      olderMsgs.forEach(m => knownIds.add(m.id));
      hasMore.value = olderMsgs.length >= 50;
    } else {
      // Admin 降级模式：原有逻辑
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
  if (useGateway.value) return; // Gateway 模式不需要 Admin 轮询
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
  // Gateway 模式不需要用 Admin timeline 补充
  if (useGateway.value) return;
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
let unsubAgent: (() => void) | null = null;

/** 当收到 session.message 事件时，实时追加到时间线 */
function subscribeGatewayEvents() {
  // 1. session.message — 新消息追加
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

  // 2. chat — 流式 agent 回复（仅 Gateway 模式）
  unsubChat = gatewayClient.on('chat', (payload: unknown) => {
    if (!useGateway.value) return;
    const data = payload as Record<string, unknown> | undefined;
    if (!data) return;
    if (data.sessionKey !== props.sessionKey) return;

    const runId = data.runId as string | undefined;
    const state = data.state as string | undefined;

    switch (state) {
      case 'delta': handleChatDelta(data, runId || ''); break;
      case 'final': handleChatFinal(data, runId || ''); break;
      case 'error': handleChatError(data, runId || ''); break;
    }
  });

  // 3. agent — 工具调用 / 生命周期（Phase 2）
  unsubAgent = gatewayClient.on('agent', (payload: unknown) => {
    if (!useGateway.value) return;
    const data = payload as Record<string, unknown> | undefined;
    if (!data) return;
    if (data.sessionKey !== props.sessionKey) return;

    const stream = data.stream as string | undefined;
    const runId = data.runId as string | undefined;
    const innerData = data.data as Record<string, unknown> | undefined;
    const phase = innerData?.phase as string | undefined;

    if (stream === 'tool') {
      handleToolEvent(data, runId || '');
    } else if (stream === 'lifecycle') {
      handleLifecycleEvent(runId || '', phase);
    }
  });
}

function unsubscribeGatewayEvents() {
  if (unsubSessionMsg) { unsubSessionMsg(); unsubSessionMsg = null; }
  if (unsubChat) { unsubChat(); unsubChat = null; }
  if (unsubAgent) { unsubAgent(); unsubAgent = null; }
  showTypingIndicator.value = false;
}

// =========== chat 事件处理 ===========

/** Gateway content 始终是 [{type:"text", text:"..."}] 数组格式 */
function extractText(msg: any): string {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('');
  }
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

/** 通过 streamRunId 查找流式消息索引 */
function findStreamMsgIndex(runId: string): number {
  return messages.value.findIndex(
    m => m.streamRunId === runId && m.streamState !== 'complete' && m.streamState !== 'error'
  );
}

/** 确保已有流式消息（工具调用在文本之前到达时创建空占位） */
function ensureStreamMsg(runId: string) {
  if (findStreamMsgIndex(runId) >= 0) return;

  showTypingIndicator.value = false;
  const sessionAgentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];
  messages.value = [...messages.value, {
    id: -Date.now(),
    session_key: props.sessionKey || '',
    agent_id: sessionAgentId || 'assistant',
    agent_name: null,
    avatar: agentAvatar.value,
    message_type: 'agent',
    content: '',
    clean_content: '',
    content_summary: null,
    is_cron: false,
    is_system_noise: false,
    source_channel: null,
    model: null,
    timestamp: new Date().toISOString(),
    streamRunId: runId,
    streamState: 'thinking' as const,
    toolCalls: [],
  }];
}

/** 处理 delta：创建或更新流式气泡（累积文本，replace 语义） */
function handleChatDelta(data: Record<string, unknown>, runId: string) {
  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;
  const text = extractText(msg);
  if (!text) return;

  const idx = findStreamMsgIndex(runId);

  if (idx >= 0) {
    // 已有流式消息 → 替换内容（累积文本，非追加）
    messages.value[idx] = {
      ...messages.value[idx],
      content: text,
      clean_content: text,
      streamState: 'streaming',
    };
  } else {
    // 创建新的流式消息
    showTypingIndicator.value = false;
    const sessionAgentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];
    const streamMsg: TimelineMessage = {
      id: -Date.now(),
      session_key: props.sessionKey || '',
      agent_id: sessionAgentId || 'assistant',
      agent_name: (data.agentName as string) || null,
      avatar: agentAvatar.value,
      message_type: 'agent',
      content: text,
      clean_content: text,
      content_summary: null,
      is_cron: false,
      is_system_noise: false,
      source_channel: null,
      model: (data.model as string) || null,
      timestamp: new Date().toISOString(),
      streamRunId: runId,
      streamState: 'streaming',
      toolCalls: [],
    };
    messages.value = [...messages.value, streamMsg];
    // 不 add 到 knownIds（负数 id 不应进入去重集合）
  }

  if (atBottom.value) nextTick(() => scrollToBottom(false));
}

/** 处理 final：完成流式气泡 */
function handleChatFinal(data: Record<string, unknown>, runId: string) {
  const msg = data.message as Record<string, unknown> | undefined;
  const finalText = msg ? extractText(msg) : null;
  const finalId = (data.messageId ?? data.id ?? Date.now()) as number;

  const idx = findStreamMsgIndex(runId);

  if (idx >= 0) {
    messages.value[idx] = {
      ...messages.value[idx],
      id: finalId,
      content: finalText || messages.value[idx].content || '',
      clean_content: finalText || messages.value[idx].clean_content || '',
      streamState: 'complete',
      timestamp: new Date().toISOString(),
    };
    knownIds.add(finalId);
  }

  showTypingIndicator.value = false;
  if (atBottom.value) nextTick(() => scrollToBottom(false));
}

/** 处理 error：显示错误 */
function handleChatError(data: Record<string, unknown>, runId: string) {
  const errorMsg = (data.errorMessage as string) || '回复出错';

  const idx = findStreamMsgIndex(runId);

  if (idx >= 0) {
    messages.value[idx] = {
      ...messages.value[idx],
      content: `❌ **错误：** ${errorMsg}`,
      clean_content: `错误：${errorMsg}`,
      streamState: 'error',
      streamRunId: undefined,
    };
  } else {
    messages.value = [...messages.value, {
      id: -Date.now(),
      session_key: props.sessionKey || '',
      agent_id: 'system',
      agent_name: null,
      avatar: null,
      message_type: 'agent',
      content: `❌ **错误：** ${errorMsg}`,
      clean_content: `错误：${errorMsg}`,
      content_summary: null,
      is_cron: false,
      is_system_noise: false,
      source_channel: null,
      model: null,
      timestamp: new Date().toISOString(),
    }];
  }

  showTypingIndicator.value = false;
  if (atBottom.value) nextTick(() => scrollToBottom(false));
}

// =========== agent 事件处理 ===========

/** 处理工具调用事件 */
function handleToolEvent(data: Record<string, unknown>, runId: string) {
  const inner = data.data as Record<string, unknown> | undefined;
  if (!inner) return;
  const phase = inner.phase as string;

  const toolEntry: ToolCallEntry = {
    toolCallId: (inner.toolCallId || inner.id || '') as string,
    toolName: (inner.toolName || inner.name || 'unknown') as string,
    args: (inner.args as Record<string, unknown>) || {},
    phase: phase as ToolCallEntry['phase'],
    result: inner.result as string | undefined,
    error: inner.error as string | undefined,
    startedAt: Date.now(),
  };

  if (phase === 'start') {
    // 确保已有流式消息（可能在文本开始前就调用工具）
    ensureStreamMsg(runId);

    const idx = findStreamMsgIndex(runId);
    if (idx >= 0 && messages.value[idx].toolCalls) {
      messages.value[idx].toolCalls!.push(toolEntry);
    }
  } else if (phase === 'end' || phase === 'result') {
    const idx = findStreamMsgIndex(runId);
    if (idx >= 0 && messages.value[idx].toolCalls) {
      const tcs = messages.value[idx].toolCalls!;
      const lastTc = [...tcs].reverse().find(
        tc => tc.toolCallId === toolEntry.toolCallId || tc.toolName === toolEntry.toolName
      );
      if (lastTc) {
        lastTc.phase = phase === 'end' ? 'result' : phase;
        lastTc.result = toolEntry.result || lastTc.result;
        lastTc.error = toolEntry.error || lastTc.error;
        lastTc.finishedAt = Date.now();
      }
    }
  }
}

/** 处理生命周期事件 */
function handleLifecycleEvent(_runId: string, phase?: string) {
  switch (phase) {
    case 'start':
      showTypingIndicator.value = true;
      break;
    case 'end':
    case 'error':
      showTypingIndicator.value = false;
      break;
  }
}

// =========== 工具辅助函数 ===========

function toolEmoji(toolName: string): string {
  const map: Record<string, string> = {
    read: '📖', write: '📝', exec: '⚡', web_search: '🔍',
    web_fetch: '🌐', browser: '🖥️', canvas: '🎨', message: '💬',
    edit: '✏️', process: '🔄', memory_get: '🧠', memory_search: '🔎',
  };
  return map[toolName] || '🔧';
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function payloadToMessage(data: Record<string, unknown>): TimelineMessage | null {
  const content = data.content as string | undefined;
  const role = data.role as string | undefined;

  // id 和 content 必须有其中一个
  if (!data.id && !content) return null;

  const msgType = role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'agent';

  const stableId = data.id as number | undefined;
  const fallbackId = stableId ?? simpleHash(
    `${(data.sessionKey as string) || ''}:${(data.timestamp as string) || ''}:${(content || '').substring(0, 80)}`
  );

  return {
    id: fallbackId,
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


/** 从 Admin API 获取当前 agent 的 avatar，并回填已有消息 */
async function fetchAgentAvatar() {
  try {
    const agentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];
    if (!agentId) return;
    const res = await fetch('/api/agents', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json() as any;
    const agents: any[] = data?.agents ?? [];
    const match = agents.find((a: any) => (a.id || a.agent_id) === agentId);
    const avatar = match?.avatar ?? null;
    agentAvatar.value = avatar;
    // 回填已有 agent 消息
    if (avatar) {
      messages.value = messages.value.map(m =>
        m.message_type === 'agent' && !m.avatar
          ? { ...m, avatar }
          : m
      );
    }
  } catch (e) {
    console.warn('[ChatTimeline] fetchAgentAvatar failed', e);
  }
}

// =========== Gateway 消息映射 ===========
/**
 * 将 Gateway 消息列表映射为 TimelineMessage 列表
 * 含过滤：跳过系统上下文、空内容、NO_REPLY 等
 */
function extractContentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('');
  return String(content ?? '');
}

function makeMsg(
  type: 'user' | 'agent' | 'tool',
  agentId: string, agentName: string | null, model: string | null,
  content: string, timestamp: string,
  rawId: any, avatar: string | null, runId?: string,
): TimelineMessage {
  const stableId = typeof rawId === 'number' ? rawId
    : typeof rawId === 'string' ? simpleHash(rawId)
    : simpleHash(`${type}:${timestamp}:${content.substring(0, 80)}`);
  return {
    id: stableId,
    session_key: props.sessionKey || '',
    agent_id: type === 'user' ? 'user' : agentId,
    agent_name: type === 'user' ? 'You' : agentName,
    avatar: avatar ?? agentAvatar.value ?? null,
    message_type: type,
    content: content || null,
    clean_content: content || null,
    content_summary: null,
    is_cron: false,
    is_system_noise: false,
    is_system_context: 0,
    source_channel: 'webchat',
    model: model || null,
    timestamp,
    streamRunId: runId,
  };
}

function gatewayMsgsToTimeline(rawMessages: any[]): TimelineMessage[] {
  const result: TimelineMessage[] = [];
  const sessionAgentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];

  for (const m of rawMessages) {
    const role = m.role as string;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'toolResult') continue;

    const runId = m.runId as string | undefined;
    const timestamp = m.timestamp
      ? (typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : m.timestamp)
      : new Date().toISOString();

    // ── 用户消息 ──
    if (role === 'user') {
      let text = extractContentText(m.content);
      if (!text.trim() || text.trim() === 'NO_REPLY') continue;
      if (text.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) continue;
      result.push(makeMsg('user', 'user', 'You', null, text, timestamp, m.id, null, runId));
      continue;
    }

    // ── assistant 消息：拆分 text 和 toolCall ──
    if (role === 'assistant') {
      if (typeof m.content === 'string') {
        if (!m.content.trim() || m.content.trim() === 'NO_REPLY') continue;
        if (m.content.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) continue;
        result.push(makeMsg('agent', m.agentName || sessionAgentId || 'assistant', m.agentName || null, m.model, m.content, timestamp, m.id, null, runId));
        continue;
      }
      if (!Array.isArray(m.content)) continue;

      // 拆分 content blocks
      let textParts: string[] = [];
      let toolCallBlocks: any[] = [];
      for (const block of m.content) {
        switch (block.type) {
          case 'text': textParts.push(block.text ?? ''); break;
          case 'thinking': break; // 暂不展示
          case 'toolCall':
          case 'tool_call':
            toolCallBlocks.push(block);
            break;
        }
      }

      const combinedText = textParts.join('');
      if (combinedText.trim() && !combinedText.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && combinedText.trim() !== 'NO_REPLY') {
        result.push(makeMsg('agent', m.agentName || sessionAgentId || 'assistant', m.agentName || null, m.model, combinedText, timestamp, m.id, null, runId));
      }

      // 每个 toolCall block 生成一条 tool 消息
      for (const tc of toolCallBlocks) {
        const toolName = tc.toolName || tc.name || 'unknown';
        const toolContent = `Tool: ${toolName}\nArgs: ${JSON.stringify(tc.arguments ?? tc.args ?? {}, null, 2)}`;
        result.push(makeMsg('tool', m.agentName || sessionAgentId || 'assistant', m.agentName || null, m.model, toolContent, timestamp, m.id, null, runId));
      }
      continue;
    }

    // ── toolResult 消息 ──
    if (role === 'tool' || role === 'toolResult') {
      let text = extractContentText(m.content);
      if (!text.trim()) continue;
      result.push(makeMsg('tool', sessionAgentId || 'assistant', null, null, text.substring(0, 500), timestamp, m.id, null, runId));
    }
  }

  result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return result;
}

// =========== 生命周期 ===========
watch(() => props.sessionKey, (newKey) => {
  // 当 sessionKey 变化时重新加载（:key 也触发重建，但 watch 提供双重保障）
  if (newKey !== undefined) {
    useGateway.value = false;
    agentAvatar.value = null;
    knownIds.clear();
    messages.value = [];
    loadLatest();
  }
});

onMounted(async () => {
  await loadLatest();
  await nextTick();
  // 如果初始加载后内容没撑满容器，继续加载更多直到撑满或耗尽（仅 Admin 模式）
  await fillScrollable();
  scrollToBottom(false);
  checkBottom();

  // Gateway 实时事件（增量更新）
  subscribeGatewayEvents();

  // 保留轮询作为降级方案（仅 Admin 模式生效）
  pollTimer = setInterval(() => {
    if (!useGateway.value) {
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
  agentName: string | null;
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
        if (current && current.messages.length === 0) {
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
        <div v-if="grp.type === 'user' && grp.messages.length > 0" class="msg-row msg-row--user" :data-msg-id="grp.messages[0]?.id">
          <div class="msg-header msg-header--user">
            <span class="msg-time">{{ formatTime(grp.timestamp) }}</span>
            <span v-if="grp.messages[0]?.source_channel" class="channel-tag">{{ grp.messages[0].source_channel }}</span>
          </div>
          <div class="bubble bubble--user">
            <MarkdownContent :content="grp.messages[0]?.clean_content || grp.messages[0]?.content || ''" />
          </div>
        </div>

        <!-- Agent 消息 -->
        <div v-else-if="grp.messages.length > 0" class="msg-row msg-row--agent" :class="{ 'msg-row--streaming': grp.messages[0]?.streamState === 'streaming' }" :data-msg-id="grp.messages[0]?.id">
          <!-- 头像列 -->
          <div class="agent-avatar-col">
            <img
              v-if="grp.avatar"
              :src="`/api/resources/avatars/${grp.avatar}`"
              class="avatar"
            />
            <div class="avatar-placeholder" v-else>{{ (grp.agentName || '?')[0] }}</div>
          </div>
          <!-- 内容列 -->
          <div class="agent-content-col">
            <div class="msg-header msg-header--agent">
              <span class="agent-label-name">{{ grp.agentName }}</span>
              <span v-if="grp.messages[0]?.model" class="model-tag">{{ grp.messages[0].model }}</span>
              <span class="msg-time">{{ formatTime(grp.timestamp) }}</span>
            </div>
            <div class="bubble bubble--agent">
              <!-- 工具调用实时展示 -->
              <div
                v-if="grp.messages[0]?.toolCalls?.length"
                class="tool-calls-inline"
              >
                <div
                  v-for="tc in grp.messages[0].toolCalls"
                  :key="tc.toolCallId || tc.toolName"
                  class="tool-badge"
                  :class="`tool-badge--${tc.phase}`"
                >
                  <span class="tool-icon">{{ toolEmoji(tc.toolName) }}</span>
                  <span class="tool-name">{{ formatToolName(tc.toolName) }}</span>
                  <span v-if="tc.phase === 'start'" class="tool-status spinning">⏳</span>
                  <span v-else-if="tc.phase === 'result'" class="tool-status">✅</span>
                  <span v-else-if="tc.phase === 'error'" class="tool-status">❌</span>
                </div>
              </div>

              <div class="bubble-text" v-for="(m, mi) in grp.messages" :key="mi">
                <MarkdownContent :content="m.content || ''" />
                <span
                  v-if="m.streamState === 'streaming'"
                  class="streaming-cursor"
                >▊</span>
              </div>
              <!-- 工具消息折叠（完成后折叠，流式时不显示） -->
              <details v-if="grp.toolMsgs.length > 0 && grp.messages[0]?.streamState !== 'streaming' && grp.messages[0]?.streamState !== 'thinking'" class="tool-details">
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

      <!-- 打字指示器 -->
      <div v-if="showTypingIndicator" class="typing-indicator">
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

/* 流式光标闪烁 */
.streaming-cursor {
  display: inline-block;
  animation: blink 1s step-end infinite;
  color: var(--el-color-primary);
  font-weight: bold;
  margin-left: 1px;
}
@keyframes blink {
  50% { opacity: 0; }
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
  background: #f7f8fa;
  border-radius: 14px 14px 14px 4px;
}
.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a0a4b0;
  animation: dot-bounce 1.2s infinite ease-in-out both;
}
.typing-dot:nth-child(1) { animation-delay: -0.32s; }
.typing-dot:nth-child(2) { animation-delay: -0.16s; }
@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* 工具调用 badge（实时展示） */
.tool-calls-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.tool-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-family: 'SF Mono', 'Consolas', monospace;
  background: #f0f1f3;
  color: #666;
  transition: all 0.2s;
}
.tool-badge--result { background: #e8f5e9; color: #388e3c; }
.tool-badge--error { background: #ffebee; color: #d32f2f; }
.tool-badge--start { background: #fff3e0; color: #e65100; }
.tool-icon { font-size: 12px; }
.tool-name { font-size: 11px; }
.tool-status.spinning {
  animation: spin 1.5s linear infinite;
  display: inline-block;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
