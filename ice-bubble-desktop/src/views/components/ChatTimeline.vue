<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { Loading } from '@element-plus/icons-vue';
import MarkdownContent from '../../components/MarkdownContent.vue';
import { gatewayClient } from '@/services/gateway-client';
import { API_BASE } from '../../config';
import { request } from '../../api/client';

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
  id: string;
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
/** Gateway 消息的最早 timestamp（作为 Admin 历史的"分界线"） */
let gatewayBoundary: string | null = null;
const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(true);
const newMsgCount = ref(0);
const atBottom = ref(true);
const containerRef = ref<HTMLElement | null>(null);

const PAGE_SIZE = 50;

/** 统一 timestamp 格式为 ISO 字符串（兼容 Unix ms、数字字符串、ISO 字符串） */
function normalizeTimestamp(ts: string | number | undefined): string {
  if (!ts) return new Date().toISOString();
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (ts.includes('T') || ts.includes('Z')) return ts;
  const num = Number(ts);
  if (!isNaN(num) && num > 1e12) return new Date(num).toISOString();
  return ts;
}
/** 已知消息去重集合（Gateway 用 gw_ 前缀，Admin 用 admin_ 前缀） */
let knownIds = new Set<string>();
/** Admin 分页游标（timestamp），避免去重导致的死循环 */
let adminPageCursor: string | null = null;
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
const filters = computed(() => {
  // 从 sessionKey 提取 agentId（如 "agent:main:main" → "main"），用 agent_ids 过滤以覆盖所有 session
  const agentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];
  return `exclude_system_noise=true&exclude_cron=true&message_types=user,agent${agentId ? `&agent_ids=${agentId}` : ''}`;
});

/** 重置 Admin 分页游标（session 切换或 loadLatest 时调用） */
function resetAdminCursor() {
  adminPageCursor = null;
}

/** 滚到底部 */
function scrollToBottom(smooth = true) {
  const el = containerRef.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

/** 初始加载：最新 N 条 */
async function loadLatest() {
  loading.value = true;
  knownIds.clear();
  gatewayBoundary = null;
  resetAdminCursor();

  try {
    let gatewayMsgs: TimelineMessage[] = [];

    // Step 1: Gateway 取最新消息（≤10 条）
    if (props.sessionKey) {
      try {
        const historyUrl = `/chat/history?sessionKey=${encodeURIComponent(props.sessionKey)}&limit=10`;
        const historyRes = await request(historyUrl);
        if (historyRes.ok) {
          const result = await historyRes.json() as any;
          const rawMsgs = result?.messages ?? result?.history ?? result ?? [];
          const arr = Array.isArray(rawMsgs) ? rawMsgs : [];
          gatewayMsgs = gatewayMsgsToTimeline(arr);

          if (gatewayMsgs.length > 0) {
            // 记录分界线：Gateway 最早消息的 timestamp
            gatewayBoundary = gatewayMsgs[0].timestamp;
            gatewayMsgs.forEach(m => knownIds.add(m.id));
          }
        }
      } catch (e) {
        console.warn('[ChatTimeline] Gateway loadLatest failed, falling back to Admin', e);
      }
    }

    // Step 2: Admin 取历史消息
    let adminMsgs: TimelineMessage[] = [];
    const adminUrl = gatewayBoundary
      ? `/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(new Date(new Date(gatewayBoundary).getTime() - 1).toISOString())}&${filters.value}`
      : `/messages/timeline?limit=${PAGE_SIZE}&${filters.value}`;

    const res = await request(adminUrl);
    if (res.ok) {
      const data: TimelineResponse = await res.json();
      adminMsgs = (data.messages || []).map(m => ({
        ...m,
        id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
      }));
      adminMsgs = adminMsgs.filter(m => !knownIds.has(m.id));
      adminMsgs = adminMsgs.filter(m => !isTimelineSystemNoise(m));
      adminMsgs.forEach(m => knownIds.add(m.id));
      // 如果 Admin 返回空但有 gatewayBoundary，说明当前 session 消息可能未同步到 Admin
      // 保守保留 hasMore=true，让 loadMore 去探查（历史上可能有大量数据）
      if (adminMsgs.length === 0 && gatewayBoundary) {
        hasMore.value = true;
      } else {
        hasMore.value = data.has_more;
      }
    }

    // Step 3: 合并（历史在前，最新在后），按 timestamp 排序
    const merged = [...adminMsgs, ...gatewayMsgs].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    setMessages(merged);
    await fetchAgentAvatar();

    // 如果消息不够撑满容器，继续加载
    await fillScrollable();
  } catch (e) {
    console.error('加载聊天记录失败', e);
  } finally {
    loading.value = false;
  }
}

/** 加载更多历史 —— 有 sessionKey 走 Admin 分页，无 sessionKey 走 Admin 分页 */
async function loadMore() {
  if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
  loadingMore.value = true;
  const el = containerRef.value;
  const prevScrollTop = el?.scrollTop ?? 0;
  const prevScrollHeight = el?.scrollHeight ?? 0;

  try {
    // 使用 adminPageCursor 作为分页游标（如果已初始化），否则用当前最早消息的 timestamp
    let beforeTs: string;
    if (adminPageCursor) {
      beforeTs = adminPageCursor;
    } else {
      const oldest = messages.value[0].timestamp;
      beforeTs = new Date(new Date(oldest).getTime() - 1).toISOString();
    }
    const url = `/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(beforeTs)}&${filters.value}`;
    const res = await request(url);
    if (!res.ok) { hasMore.value = false; return; }
    const data: TimelineResponse = await res.json();
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      hasMore.value = data.has_more; return;
    }

    // Admin ID 加前缀 + 过滤系统噪音 + 内容去重
    const adminMsgs = data.messages.map(m => ({
        ...m, id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
      }))
      .filter(m => !isTimelineSystemNoise(m));
    // 先用 knownIds 过滤，再用 contentKey 去重
    const idFiltered = adminMsgs.filter(m => !knownIds.has(m.id));
    const newMsgs = dedupByContent(idFiltered, messages.value);

    // 更新游标：用 Admin 返回的消息中最早的 timestamp - 1ms 作为下次的 before
    // 这样即使 newMsgs 为空，下次请求也会返回不同的数据，避免去重死循环
    const earliestReturned = adminMsgs.reduce((min, m) => {
      const t = new Date(m.timestamp).getTime();
      return t < min ? t : min;
    }, Infinity);
    if (earliestReturned < Infinity) {
      adminPageCursor = new Date(earliestReturned - 1).toISOString();
    }

    if (newMsgs.length === 0) {
      // 这批全部重复，但游标已推进，下次会请求更早的数据
      hasMore.value = data.has_more;
      return;
    }
    newMsgs.forEach(m => knownIds.add(m.id));
    messages.value = [...newMsgs, ...messages.value];
    hasMore.value = data.has_more;
  } catch (e) {
    console.error('加载更多失败', e);
  } finally {
    loadingMore.value = false;
    await nextTick();
    if (el) {
      const delta = el.scrollHeight - prevScrollHeight;
      el.scrollTop = prevScrollTop + delta;
    }
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

    // 使用 -1ms 而非 +1ms：与 loadMore 对齐
    const beforeCursor = new Date(new Date(oldest).getTime() - 1).toISOString();
    const res = await request(`/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(beforeCursor)}&${filters.value}`);
    if (!res.ok) break;
    const data: TimelineResponse = await res.json();
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      hasMore.value = data.has_more;
      break;
    }

    const newMsgs = data.messages.map(m => ({
        ...m, id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
      })).filter(m => !knownIds.has(m.id)).filter(m => !isTimelineSystemNoise(m));
    if (newMsgs.length === 0) {
      hasMore.value = data.has_more;
      break;
    }

    newMsgs.forEach(m => knownIds.add(m.id));
    messages.value = [...newMsgs, ...messages.value].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    hasMore.value = data.has_more;

    await nextTick();
    batches++;
  }
}

/** 从 Gateway 历史消息的 content 提取纯文本 */
function extractContentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('');
  return String(content ?? '');
}

/** 生成 TimelineMessage 对象 */
function makeMsg(
  type: 'user' | 'agent' | 'tool',
  agentId: string, agentName: string | null, model: string | null,
  content: string, timestamp: string,
  rawId: any, avatar: string | null, runId?: string,
): TimelineMessage {
  const stableId = typeof rawId === 'number' || typeof rawId === 'string'
    ? `gw_${rawId}`
    : `gw_${simpleHash(`${type}:${timestamp}:${content.substring(0, 80)}`)}`;
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

/** 将 Gateway 历史消息数组转为 TimelineMessage 数组 */
function gatewayMsgsToTimeline(rawMessages: any[]): TimelineMessage[] {
  const result: TimelineMessage[] = [];
  const sessionAgentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];

  for (const m of rawMessages) {
    const role = m.role as string;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'toolResult') continue;

    const runId = m.runId as string | undefined;
    const timestamp = normalizeTimestamp(m.timestamp);

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
        if (isSystemNoise(m.content)) continue;
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
          case 'thinking': break;
          case 'toolCall':
          case 'tool_call':
            toolCallBlocks.push(block);
            break;
        }
      }

      const combinedText = textParts.join('');
      if (!isSystemNoise(combinedText)) {
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

/** 判断内容是否为系统噪音（不应在聊天界面显示） */
function isSystemNoise(content: string | null | undefined): boolean {
  if (!content) return true;
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (trimmed === 'NO_REPLY') return true;
  if (trimmed === 'HEARTBEAT_OK') return true;
  if (trimmed.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) return true;
  // exec 完成通知、定时任务 delivery 等系统注入
  if (/^An async command completion event was triggered/.test(trimmed)) return true;
  if (/^\[Inter-session message\]/.test(trimmed)) return true;
  if (/^Sender \(untrusted metadata\)/.test(trimmed)) return true;
  return false;
}

/** 空内容过滤：排除内容为空的用户消息（如 HEARTBEAT_OK, NO_REPLY 等系统注入） */
function isEmptyUserMsg(m: TimelineMessage): boolean {
  return m.message_type === 'user' && !m.content && !m.clean_content;
}

/** 过滤 Admin timeline 中的系统噪音消息（subagent 通知、heartbeat、元数据包裹等） */
function isTimelineSystemNoise(m: TimelineMessage): boolean {
  const content = m.content || '';
  const clean = m.clean_content || '';
  // 空 content 的 agent 消息（纯工具调用产生的占位符）
  if (m.message_type === 'agent' && !content.trim() && !clean.trim()) return true;
  // content 以 Sender metadata 开头且 clean_content 为空（元数据包裹，无实际内容）
  if (content.startsWith('Sender (untrusted metadata):') && !clean.trim()) return true;
  // NO_REPLY
  if (clean.trim() === 'NO_REPLY') return true;
  return false;
}

/** 清洗 Admin content 中的 OpenClaw 系统元数据，返回纯用户文本 */
function stripOpenClawMetadata(text: string): string {
  if (!text) return text;
  // 去除 Sender (untrusted metadata) JSON 块
  let cleaned = text.replace(/Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*\n*/g, '');
  // 去除行首的时间戳前缀，如 [Tue 2026-05-05 10:55 GMT+8]
  cleaned = cleaned.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/gm, '');
  return cleaned.trim() || text;
}

/** 内容级去重 key（基于 content 前 200 字符，不含 timestamp） */
function contentKey(m: TimelineMessage): string {
  const text = (m.clean_content || m.content || '').substring(0, 200).trim();
  return text;
}

/** 从候选消息中去掉与已有消息内容重复的条目 */
function dedupByContent(msgs: TimelineMessage[], existing: TimelineMessage[]): TimelineMessage[] {
  const existingKeys = new Set(existing.map(m => contentKey(m)));
  const seenInBatch = new Set<string>();
  return msgs.filter(m => {
    const ck = contentKey(m);
    if (existingKeys.has(ck)) return false; // 与已有消息重复
    if (seenInBatch.has(ck)) return false;   // 同批内重复
    seenInBatch.add(ck);
    return true;
  });
}

function setMessages(msgs: TimelineMessage[]) {
  knownIds.clear();
  const seen = new Set<string>();
  const seenContent = new Set<string>();
  const filtered = msgs.filter(m => {
    if (isEmptyUserMsg(m)) return false;
    if (seen.has(m.id)) return false;
    // 二次去重：同一 content + 同一 timestamp 不会出现两次
    const ck = contentKey(m);
    if (seenContent.has(ck)) return false;
    seenContent.add(ck);
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
    // 过滤实时推送的系统噪音
    if (isSystemNoise(msg.content)) return;
    // 二次去重：内容+时间戳匹配（防止流式 final 和 session.message 推送重复）
    const dup = messages.value.find(m =>
      m.content && msg.content &&
      m.content.substring(0, 200) === msg.content.substring(0, 200) &&
      Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 5000
    );
    if (dup) return;

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

  // 2. chat — 流式 agent 回复
  unsubChat = gatewayClient.on('chat', (payload: unknown) => {
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

  // 3. agent — 工具调用 / 生命周期
  unsubAgent = gatewayClient.on('agent', (payload: unknown) => {
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
    id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
      id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
  const rawFinalId = data.messageId ?? data.id ?? Date.now();
  const finalId = typeof rawFinalId === 'number' || typeof rawFinalId === 'string'
    ? `gw_${rawFinalId}`
    : `gw_${Date.now()}`;

  const idx = findStreamMsgIndex(runId);

  if (idx >= 0) {
    // 最终内容是系统噪音 → 移除这条消息
    if (isSystemNoise(finalText)) {
      messages.value.splice(idx, 1);
      showTypingIndicator.value = false;
      return;
    }
    messages.value[idx] = {
      ...messages.value[idx],
      id: finalId,
      content: finalText || messages.value[idx].content || '',
      clean_content: finalText || messages.value[idx].clean_content || '',
      streamState: 'complete',
      avatar: messages.value[idx].avatar || agentAvatar.value,
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
      id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

  const rawId = data.id as number | string | undefined;
  const fallbackId = rawId !== undefined
    ? `gw_${rawId}`
    : `gw_${simpleHash(
        `${(data.sessionKey as string) || ''}:${(data.timestamp as string) || ''}:${(content || '').substring(0, 80)}`
      )}`;

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
    timestamp: normalizeTimestamp(data.timestamp as string | number | undefined),
  };
}


/** 从 Admin API 获取当前 agent 的 avatar，并回填已有消息 */
async function fetchAgentAvatar() {
  try {
    const agentId = props.sessionKey?.match(/^agent:([^:]+)/)?.[1];
    if (!agentId) return;
    const res = await request('/agents');
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

// =========== 生命周期 ===========
watch(() => props.sessionKey, (newKey) => {
  // 当 sessionKey 变化时重新加载（:key 也触发重建，但 watch 提供双重保障）
  if (newKey !== undefined) {
    agentAvatar.value = null;
    knownIds.clear();
    gatewayBoundary = null;
    resetAdminCursor();
    messages.value = [];
    loadLatest();
  }
});

onMounted(async () => {
  // 先加载最新消息，确保 knownIds 填充后再注册实时事件，避免竞态导致消息重复
  await loadLatest();
  // Gateway 实时事件（增量更新）——在初始加载完成后注册
  subscribeGatewayEvents();
  await nextTick();
  scrollToBottom(false);
  checkBottom();
});

onUnmounted(() => {
  unsubscribeGatewayEvents();
});

defineExpose({
  getMessages: () => messages.value,
  addOptimisticMessage(content: string, role: string = 'user') {
    const msg: TimelineMessage = {
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

function shouldShowTime(ts: string, groupIndex: number): boolean {
  if (groupIndex <= 0) return true;
  const prev = groupedMessages.value[groupIndex - 1];
  if (!prev) return true;
  const curDate = new Date(ts);
  const prevDate = new Date(prev.timestamp);
  // 同一分钟内不重复
  if (curDate.getFullYear() === prevDate.getFullYear()
    && curDate.getMonth() === prevDate.getMonth()
    && curDate.getDate() === prevDate.getDate()
    && curDate.getHours() === prevDate.getHours()
    && curDate.getMinutes() === prevDate.getMinutes()) {
    return false;
  }
  return true;
}

function toolSummary(grp: MsgGroup): string {
  const visible = grp.toolMsgs.length;
  const total = visible + grp.hiddenToolCount;
  const names = [...new Set(grp.toolMsgs.map(tm => extractToolName(tm.content)))];
  const nameStr = names.length > 0 ? names.join(', ') : '';
  const nameLabel = nameStr ? ` (${nameStr})` : '';
  return `🔧 ${total} tools${nameLabel}`;
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
        <button type="button" class="load-more-btn" @click="loadMore" :disabled="loadingMore">
          {{ loadingMore ? '加载中...' : '↑ 加载更早消息' }}
        </button>
      </div>

      <!-- 首加载 -->
      <div v-if="loading && messages.length === 0" class="loading-tip">
        <el-icon class="is-loading" :size="20"><Loading /></el-icon>
        <span>加载中...</span>
      </div>
      <div v-else-if="messages.length === 0" class="empty-tip">暂无消息</div>

      <!-- 消息组 -->
      <template v-for="(grp, gi) in groupedMessages" :key="gi">
        <!-- 用户消息 -->
        <div v-if="grp.type === 'user' && grp.messages.length > 0" class="msg-row msg-row--user" :data-msg-id="grp.messages[0]?.id">
          <div class="bubble bubble--user">
            <span v-if="shouldShowTime(grp.timestamp, gi)" class="bubble-time">{{ formatTime(grp.timestamp) }}</span>
            <MarkdownContent :content="grp.messages[0]?.clean_content || grp.messages[0]?.content || ''" />
          </div>
        </div>

        <!-- Agent 消息 -->
        <div v-else-if="grp.messages.length > 0" class="msg-row msg-row--agent" :class="{ 'msg-row--streaming': grp.messages[0]?.streamState === 'streaming' }" :data-msg-id="grp.messages[0]?.id">
          <!-- 头像列 -->
          <div class="agent-avatar-col">
            <img
              v-if="grp.avatar"
              :src="`${API_BASE}/resources/avatars/${grp.avatar}`"
              class="avatar"
            />
            <div class="avatar-placeholder" v-else>{{ (grp.agentName || '?')[0] }}</div>
          </div>
          <!-- 内容列 -->
          <div class="agent-content-col">
            <div class="msg-header msg-header--agent">
              <span class="agent-label-name">{{ grp.agentName }}</span>
              <span v-if="grp.messages[0]?.model" class="model-tag">{{ grp.messages[0].model }}</span>
              <span v-if="shouldShowTime(grp.timestamp, gi)" class="msg-time">{{ formatTime(grp.timestamp) }}</span>
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
                <MarkdownContent :content="m.clean_content || m.content || ''" />
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

/* 滚动区域 */
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
  width: 28px;
  flex-shrink: 0;
  padding-top: 2px;
}

/* Agent 内容列 */
.agent-content-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.avatar, .avatar-placeholder {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-placeholder {
  background: var(--color-accent-blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

/* Agent 内容包裹（用于对齐头部+气泡） */

/* 消息头顶部（时间 + 名称/渠道） */
.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 0 6px;
}
.msg-header--user {
  justify-content: flex-end;
}

.msg-time {
  white-space: nowrap;
}

.bubble-time {
  display: block;
  text-align: right;
  font-size: 10px;
  color: #aaa;
  margin-bottom: 4px;
}

.agent-label-name {
  font-weight: 500;
  color: var(--color-text-secondary);
  font-size: 12px;
}

/* 气泡 */
.bubble {
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
}
.bubble--user {
  background: var(--color-accent-blue-subtle);
  color: var(--color-text);
  border-radius: 16px 4px 16px 16px;
  border: 1px solid var(--color-border-subtle);
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.bubble--user:hover {
  background: #c8e6ff;
  box-shadow: 0 1px 4px rgba(9, 105, 218, 0.12);
}
.bubble--user .bubble-time {
  color: var(--color-text-tertiary);
}
.bubble--user :deep(pre),
.bubble--user :deep(code) {
  background: rgba(0,0,0,0.06);
  color: var(--color-text);
  border-radius: 6px;
}
.bubble--agent {
  background: #fff;
  color: #222;
  border-radius: 16px 16px 16px 4px;
  max-width: 100%;
  padding: 10px 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.bubble--agent:hover {
  background: #fafbfc;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
}

.bubble-text {
  margin-bottom: 2px;
}

/* 消息渠道标签 - 代码风格 */
.channel-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 9px;
  color: var(--color-text-tertiary);
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
}

/* 模型标签 */
.model-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 10px;
  color: var(--color-accent-blue);
  background: var(--color-accent-blue-subtle);
  padding: 1px 5px;
  border-radius: 3px;
}

/* 工具折叠 */
.tool-details {
  margin-top: 8px;
  border-top: 1px solid #eee;
}
.tool-details summary {
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 11px;
  padding: 4px 0;
}
.tool-details summary:hover {
  color: #5a7fb5;
}
.tool-item {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--color-bg-subtle);
  border-radius: 8px;
  font-size: 11px;
}
.tool-item-header {
  font-weight: 600;
  color: var(--color-accent-blue);
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
  color: var(--color-accent-blue);
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
  border-radius: 8px;
  font-size: 11px;
  font-family: 'SF Mono', 'Consolas', monospace;
  background: #f0f1f3;
  color: #666;
  border-left: 3px solid #ccc;
  transition: all 0.2s;
}
.tool-badge--result { background: #e8f5e9; color: #388e3c; border-left-color: #4caf50; }
.tool-badge--error { background: #ffebee; color: #d32f2f; border-left-color: #f44336; }
.tool-badge--start { background: #fff3e0; color: #e65100; border-left-color: #ff9800; }
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
