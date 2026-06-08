/**
 * useChatData — 消息列表数据管理（重构版）
 *
 * 关键设计决策：
 *   1. knownIds → shallowRef<Set<string>>（响应式引用，解决闭包引用断裂）
 *   2. idAlias 归一化映射（Admin/Gateway ID 互去重）
 *   3. generation counter 生命周期管理（替代 boolean active flag）
 *   4. session key 守卫（异步操作中防止缓存污染）
 *   5. 统一 optimistic message 管理
 *   6. syncCache() 统一缓存写入入口
 */
import { ref, shallowRef, computed, nextTick } from 'vue';
import { request } from '../../../api/client';
import { API_BASE } from '../../../config';
import type { TimelineMessage, TimelineResponse, GatewayMessage, GatewayContentBlock, GatewayToolCallBlock, GatewayHistoryResponse, MediaBatchResponse, MediaBatchItem, MsgGroup } from './types';

import { parseMediaAttached, stripMediaAttachedMarkers, detectInlineImages } from './media-parser';
import { messageCache } from '@/stores/message-cache';

export function useChatData(getSessionKey: () => string | undefined) {
  const messages = ref<TimelineMessage[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const hasMore = ref(true);
  const newMsgCount = ref(0);
  const atBottom = ref(true);
  const containerRef = ref<HTMLElement | null>(null);
  const showTypingIndicator = ref(false);
  const agentAvatar = ref<string | null>(null);

  // ── P0: knownIds 改为 shallowRef<Set<string>> ──
  const knownIds = shallowRef<Set<string>>(new Set<string>());

  // ── P0: idAlias 归一化映射（所有别名 → 唯一主 key）──
  const idAlias = shallowRef<Map<string, string>>(new Map<string, string>());

  // ── P0: generation counter 生命周期管理（替代 boolean active flag）──
  const generation = ref(0);

  // ── P1: 统一 optimistic message 管理 ──
  const optimisticMap = new Map<string, string>(); // optimisticId → realId mapping

  let adminPageCursor: string | null = null;
  const PAGE_SIZE = 30;
  const MAX_MESSAGES = 1000;
  const TRIM_TO = 800;

  // ── 定时轮询 ──
  const POLL_INTERVAL = 15_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPollTimestamp: string | null = null;

  // ── 辅助函数 ──

  /** Register an alias: aliasId → canonicalId */
  function registerAlias(aliasId: string, canonicalId: string) {
    if (aliasId === canonicalId) return;
    const map = new Map(idAlias.value);
    map.set(aliasId, canonicalId);
    idAlias.value = map;
    // Also update knownIds if canonicalId is known
    const ids = new Set(knownIds.value);
    if (ids.has(canonicalId) && !ids.has(aliasId)) {
      ids.add(aliasId);
      knownIds.value = ids;
    }
  }

  /** Resolve an ID through alias map to find if it's already known */
  function resolveId(id: string): string {
    return idAlias.value.get(id) || id;
  }

  /** Check if an ID (or its alias) is already known */
  function hasId(id: string): boolean {
    if (knownIds.value.has(id)) return true;
    const canonical = idAlias.value.get(id);
    return canonical ? knownIds.value.has(canonical) : false;
  }

  /** Add an ID to known set and register it */
  function addId(id: string) {
    const ids = new Set(knownIds.value);
    ids.add(id);
    knownIds.value = ids;
  }

  /** Match two messages from different sources by session_key + clean_content hash + timestamp ±2s */
  function matchMessageByContent(
    msgA: { session_key?: string; clean_content?: string | null; timestamp: string },
    msgB: { session_key?: string; clean_content?: string | null; timestamp: string },
  ): boolean {
    if (msgA.session_key && msgB.session_key && msgA.session_key !== msgB.session_key) return false;
    const contentA = (msgA.clean_content || '').substring(0, 200);
    const contentB = (msgB.clean_content || '').substring(0, 200);
    if (!contentA || !contentB) return false;
    if (simpleHash(contentA) !== simpleHash(contentB)) return false;
    const tsA = new Date(msgA.timestamp).getTime();
    const tsB = new Date(msgB.timestamp).getTime();
    return Math.abs(tsA - tsB) <= 30000; // ±30s window (covers collector sync latency)
  }

  /** Try to find an existing message that matches the given one (for cross-source dedup) */
  function findMatchingMessage(
    msg: TimelineMessage,
  ): TimelineMessage | null {
    // Quick check by alias first
    const canonical = resolveId(msg.id);
    if (knownIds.value.has(canonical)) return null; // Already known under canonical

    // Content-based matching for cross-source dedup
    for (const existing of messages.value) {
      if (matchMessageByContent(existing, msg)) {
        return existing;
      }
    }
    return null;
  }

  // ── Polling ──

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollNewMessages, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollNewMessages() {
    const sessionKey = getSessionKey();
    if (!sessionKey) return;
    const gen = generation.value;

    try {
      const sinceParam = lastPollTimestamp
        ? `&since=${encodeURIComponent(lastPollTimestamp)}`
        : '';
      const res = await request(`/messages/timeline?limit=20&${getActiveFilters()}${sinceParam}`);
      if (!res.ok || generation.value !== gen) return;
      const data: TimelineResponse = await res.json();
      if (generation.value !== gen) return;

      const incoming: TimelineMessage[] = [];
      for (const m of (data.messages || [])) {
        const mapped: TimelineMessage = {
          ...m,
          id: `admin_${m.id}`,
          clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
          is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
        };
        if (isTimelineSystemNoise(mapped)) continue;
        if (hasId(mapped.id)) continue;
        // Cross-source dedup: check if a gw_ equivalent exists
        const match = findMatchingMessage(mapped);
        if (match) {
          registerAlias(mapped.id, match.id);
          continue; // Don't insert duplicate
        }
        incoming.push(mapped);
      }

      if (incoming.length === 0) return;

      const latestTs = incoming.reduce((max, m) => {
        const t = new Date(m.timestamp).getTime();
        return t > max ? t : max;
      }, 0);
      if (latestTs > 0) {
        lastPollTimestamp = new Date(latestTs).toISOString();
      }

      incoming.forEach(m => addId(m.id));
      const merged = [...messages.value, ...incoming].sort(stableMsgSort);
      messages.value = merged;

      if (atBottom.value) {
        await nextTick();
        scrollToBottom(false);
      } else {
        newMsgCount.value += incoming.length;
      }

      enforceMessageLimit();
      syncCache();
    } catch {
      // 轮询失败静默忽略
    }
  }

  /** Immediate poll — called externally when a chat.final event arrives to
   *  catch user messages that the Gateway did not broadcast via session.message.
   *  Polls Admin timeline first, then fetches Gateway /chat/history for
   *  guaranteed coverage (Admin sync may lag, but Gateway history is authoritative). */
  async function pollNow() {
    const sk = getSessionKey();
    const gen = generation.value;
    await pollNewMessages();
    // Also pull Gateway history — it always contains user messages
    if (sk) {
      refreshInBackground(sk, gen);
    }
  }

  // ── 工具函数（保留不变） ──

  function normalizeTimestamp(ts: string | number | undefined): string {
    if (!ts) return new Date().toISOString();
    if (typeof ts === 'number') return new Date(ts).toISOString();
    if (ts.includes('T') || ts.includes('Z')) return ts;
    const num = Number(ts);
    if (!isNaN(num) && num > 1e12) return new Date(num).toISOString();
    return ts;
  }

  function simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function isAssistantTurnFailed(content: string | null): boolean {
    if (!content) return false;
    return /\[assistant turn failed[^\]]*\]/i.test(content);
  }

  function isSystemNoise(content: string | null | undefined): boolean {
    if (!content) return true;
    const trimmed = content.trim();
    if (!trimmed || trimmed === 'NO_REPLY' || trimmed === 'HEARTBEAT_OK') return true;
    if (trimmed.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) return true;
    if (/^An async command completion event was triggered/.test(trimmed)) return true;
    if (/^\[Inter-session message\]/.test(trimmed)) return true;
    if (/^Sender \(untrusted metadata\)/.test(trimmed)) return true;
    return false;
  }

  function isEmptyUserMsg(m: TimelineMessage): boolean {
    return m.message_type === 'user' && !m.content && !m.clean_content;
  }

  function isTimelineSystemNoise(m: TimelineMessage): boolean {
    const content = m.content || '';
    const clean = m.clean_content || '';
    if (content.startsWith('Sender (untrusted metadata):') && !clean.trim()) return true;
    if ((clean.trim() || content.trim()) === 'NO_REPLY') return true;
    return false;
  }

  function stripOpenClawMetadata(text: string): string {
    if (!text) return text;
    let cleaned = text.replace(/Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*\n*/g, '');
    cleaned = cleaned.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/gm, '');
    return cleaned.trim() || text;
  }

  // ── P0: setMessages 简化为纯赋值（去掉内置去重） ──

  // Fix 3: stable sort — tiebreak same-millisecond messages by ID (numeric part)
  function stableMsgSort(a: TimelineMessage, b: TimelineMessage): number {
    const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (diff !== 0) return diff;
    const numA = parseInt(a.id.replace(/^[a-z]+_/, ''), 10) || 0;
    const numB = parseInt(b.id.replace(/^[a-z]+_/, ''), 10) || 0;
    return numA - numB;
  }

  function setMessages(msgs: TimelineMessage[]) {
    const seen = new Set<string>();
    const filtered = msgs.filter(m => {
      if (isEmptyUserMsg(m) || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    filtered.sort(stableMsgSort);
    messages.value = filtered;
    knownIds.value = new Set(seen);
  }

  // ── P1: 统一缓存写入入口 ──

  function syncCache() {
    const sk = getSessionKey();
    if (!sk || generation.value === 0) return;
    messageCache.set(sk, {
      messages: messages.value,
      knownIds: [...knownIds.value],
      idAlias: [...idAlias.value.entries()],
      hasMore: hasMore.value,
      adminPageCursor,
      agentAvatar: agentAvatar.value,
      cachedAt: Date.now(),
    });
  }

  // ── P1: 统一 optimistic message 管理 ──

  function addOptimisticMessage(
    content: string,
    role: string = 'user',
    attachmentDataUrls?: string[],
    optimisticId?: string,
  ) {
    const id = optimisticId || `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const msg: TimelineMessage = {
      id,
      _optimistic: optimisticId ? true : undefined,
      _sendFailed: false,
      session_key: getSessionKey() || '',
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
      attachments: attachmentDataUrls?.map(dataUrl => ({
        type: 'image',
        mimeType: 'image/jpeg',
        fileName: 'image',
        content: '',
        dataUrl,
      })),
    } as any;
    addId(id);
    messages.value = [...messages.value, msg];
    nextTick(() => scrollToBottom(false));
    return id;
  }

  function resolveOptimisticMessage(optimisticId: string, realId: string) {
    const idx = messages.value.findIndex(m => m.id === optimisticId);
    if (idx >= 0) {
      const msg = messages.value[idx];
      messages.value[idx] = { ...msg, id: realId, streamState: undefined } as any;
      // Update knownIds: remove optimistic, add real
      const ids = new Set(knownIds.value);
      ids.delete(optimisticId);
      ids.add(realId);
      knownIds.value = ids;
      // Register alias for cross-source dedup
      registerAlias(optimisticId, realId);
    }
    optimisticMap.delete(optimisticId);
  }

  function markOptimisticFailed(optimisticId: string) {
    const idx = messages.value.findIndex(m => m.id === optimisticId);
    if (idx >= 0) {
      messages.value[idx] = { ...messages.value[idx], _sendFailed: true } as any;
    }
    optimisticMap.delete(optimisticId);
  }

  /**
   * 为用户历史消息加载附件，基于内容解析（media attached 标记）而非时间戳匹配。
   */
  async function enrichAttachmentsFromContent(msgs: TimelineMessage[]): Promise<void> {
    const userMsgs = msgs.filter(m => m.message_type === 'user' && (!m.attachments || m.attachments.length === 0));
    if (userMsgs.length === 0) return;

    const msgMediaMap = new Map<TimelineMessage, string[]>();
    for (const m of userMsgs) {
      const refs = parseMediaAttached(m.content || '');
      if (refs.length > 0) {
        msgMediaMap.set(m, refs.map(r => r.fileName));
      }
    }

    const allIds = [...new Set([...msgMediaMap.values()].flat())];
    if (allIds.length === 0) return;

    let mediaItems: Array<{ id: string; mimeType?: string; fileName?: string }> = [];
    try {
      const res = await request(`/media/batch?ids=${allIds.join(',')}`);
      if (res.ok) {
        const data = await res.json() as MediaBatchResponse;
        mediaItems = data.items || [];
      }
    } catch (e) {
      console.warn('[enrich] media batch query failed', e);
    }
    if (mediaItems.length === 0) return;

    const mediaMap = new Map(mediaItems.map(item => [item.id, item]));

    let changed = false;
    for (const [m, ids] of msgMediaMap) {
      const items = ids.map(id => mediaMap.get(id)).filter((x): x is MediaBatchItem => !!x);
      if (items.length > 0) {
        m.attachments = items.map((item: MediaBatchItem) => ({
          type: 'image' as const,
          mimeType: item.mimeType || 'image/png',
          fileName: item.fileName || 'image',
          content: '',
          dataUrl: `${API_BASE}/media/file/${item.id}`,
        }));
        m.content = stripMediaAttachedMarkers(m.content || '');
        if (m.clean_content) m.clean_content = stripMediaAttachedMarkers(m.clean_content);
        if (m.attachments.length > 0) {
          const cleaned = m.content
            ?.replace(/^\[.*?\]\s*/, '')
            .trim();
          if (cleaned === '(图片)' || cleaned === '' || cleaned === '图片') {
            m.content = '';
            if (m.clean_content) m.clean_content = '';
          }
        }
        changed = true;
      }
    }
    if (changed) messages.value = [...messages.value];
  }

  function extractContentText(content: string | GatewayContentBlock[] | unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return (content as GatewayContentBlock[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    return String(content ?? '');
  }

  function makeMsg(
    type: 'user' | 'agent' | 'tool',
    agentId: string, agentName: string | null, model: string | null,
    content: string, timestamp: string,
    rawId: string | number | unknown, avatar: string | null, runId?: string,
  ): TimelineMessage {
    const stableId = typeof rawId === 'number' || typeof rawId === 'string'
      ? `gw_${rawId}`
      : `gw_${simpleHash(`${type}:${timestamp}:${content.substring(0, 80)}`)}`;
    return {
      id: stableId,
      session_key: getSessionKey() || '',
      agent_id: type === 'user' ? 'user' : agentId,
      agent_name: type === 'user' ? 'You' : agentName,
      avatar: avatar ?? agentAvatar.value ?? null,
      message_type: type,
      content: content || null,
      clean_content: content || null,
      content_summary: null,
      is_cron: false,
      is_system_noise: false,
      is_turn_failed: isAssistantTurnFailed(content),
      is_system_context: 0,
      source_channel: 'webchat',
      model: model || null,
      timestamp,
      streamRunId: runId,
    };
  }

  function gatewayMsgsToTimeline(rawMessages: GatewayMessage[]): TimelineMessage[] {
    const result: TimelineMessage[] = [];
    const sessionAgentId = getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
    for (const m of rawMessages) {
      const role = m.role as string;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'toolResult') continue;
      const runId = m.runId as string | undefined;
      const timestamp = normalizeTimestamp(m.timestamp);

      if (role === 'user') {
        let text = extractContentText(m.content);
        if (!text.trim() || text.trim() === 'NO_REPLY' || text.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) continue;
        const msg = makeMsg('user', 'user', 'You', null, text, timestamp, m.id, null, runId);
        const inlineImages = detectInlineImages(m);
        if (inlineImages.length > 0) {
          msg.attachments = inlineImages.map(img => ({
            type: 'image' as const,
            mimeType: 'image/png',
            fileName: 'image',
            content: '',
            dataUrl: img.dataUrl,
          }));
        }
        result.push(msg);
        continue;
      }

      if (role === 'assistant') {
        if (typeof m.content === 'string') {
          if (isSystemNoise(m.content)) continue;
          result.push(makeMsg('agent', m.agentName || sessionAgentId || 'assistant', m.agentName ?? null, m.model ?? null, m.content, timestamp, m.id, null, runId));
          continue;
        }
        if (!Array.isArray(m.content)) continue;
        let textParts: string[] = [];
        let toolCallBlocks: GatewayToolCallBlock[] = [];
        for (const block of m.content) {
          switch (block.type) {
            case 'text': textParts.push(block.text ?? ''); break;
            case 'thinking': break;
            case 'toolCall': case 'tool_call': toolCallBlocks.push(block as GatewayToolCallBlock); break;
          }
        }
        const combinedText = textParts.join('');
        if (!isSystemNoise(combinedText)) {
          result.push(makeMsg('agent', m.agentName || sessionAgentId || 'assistant', m.agentName ?? null, m.model ?? null, combinedText, timestamp, m.id, null, runId));
        }
        for (const tc of toolCallBlocks) {
          const toolName = tc.toolName || tc.name || 'unknown';
          const toolContent = `Tool: ${toolName}\nArgs: ${JSON.stringify(tc.arguments ?? tc.args ?? {}, null, 2)}`;
          result.push(makeMsg('tool', m.agentName || sessionAgentId || 'assistant', m.agentName ?? null, m.model ?? null, toolContent, timestamp, m.id, null, runId));
        }
        continue;
      }

      if (role === 'tool' || role === 'toolResult') {
        let text = extractContentText(m.content);
        if (!text.trim()) continue;
        result.push(makeMsg('tool', sessionAgentId || 'assistant', null, null, text.substring(0, 500), timestamp, m.id, null, runId));
      }
    }
    result.sort(stableMsgSort);
    return result;
  }

  // ── Session Chain 状态 ──
  const chainSessions = ref<Array<{
    session_key: string;
    agent_id: string;
    agent_name: string | null;
    avatar: string | null;
    channel: string | null;
    message_count: number;
    user_message_count: number;
    first_message_at: string | null;
    last_message_at: string | null;
    first_message: string | null;
    label: string | null;
  }>>([]);
  const chainCurrentIndex = ref(-1);
  const chainHasOlder = ref(false);

  // ── Session Chain 获取 ──
  async function fetchSessionChain(sessionKey: string): Promise<void> {
    try {
      const res = await request(`/sessions/chain?session_key=${encodeURIComponent(sessionKey)}`);
      if (!res.ok) return;
      const data = await res.json();
      chainSessions.value = data.chain || [];
      chainCurrentIndex.value = data.currentIndex;
      chainHasOlder.value = data.has_older;
    } catch (e) {
      console.warn('[useChatData] fetchSessionChain failed', e);
    }
  }

  // ── chainFilters: 跨 session 查询参数 ──
  const chainFilters = computed<string | null>(() => {
    const chainKeys = chainSessions.value
      .filter(s => s.message_count > 0)
      .map(s => s.session_key);
    if (chainKeys.length <= 1) return null;
    const agentId = getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
    const parts = [
      `session_keys=${chainKeys.map(k => encodeURIComponent(k)).join(',')}`,
      'exclude_system_noise=true',
      'exclude_cron=true',
      'message_types=user,agent',
    ];
    if (agentId) parts.push(`agent_ids=${agentId}`);
    return parts.join('&');
  });

  // ── 消息硬上限淘汰 ──
  function enforceMessageLimit() {
    if (messages.value.length > MAX_MESSAGES) {
      const trimmed = messages.value.slice(-TRIM_TO);
      const newKnownIds = new Set<string>();
      for (const m of trimmed) newKnownIds.add(m.id);
      knownIds.value = newKnownIds;
      messages.value = trimmed;
    }
  }

  /** Helper: get active filters (chainFilters or fallback to filters) */
  function getActiveFilters(): string {
    return chainFilters.value || filters.value;
  }

  // ── 过滤 ──

  const filters = computed(() => {
    const sessionKey = getSessionKey();
    const agentId = sessionKey?.match(/^agent:([^:]+)/)?.[1];
    const parts = [`session_key=${encodeURIComponent(sessionKey || '')}`, 'exclude_system_noise=true', 'exclude_cron=true', 'message_types=user,agent'];
    if (agentId) parts.push(`agent_ids=${agentId}`);
    return parts.join('&');
  });

  // ── 滚动（保留不变） ──

  function checkBottom() {
    const el = containerRef.value;
    if (!el) return;
    atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function scrollToBottom(smooth = true) {
    const el = containerRef.value;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  function onScroll() { checkBottom(); }
  function goToBottom() { scrollToBottom(); newMsgCount.value = 0; }

  // ── 加载 ──

  function resetAdminCursor() { adminPageCursor = null; }

  async function fetchAgentAvatar() {
    try {
      const agentId = getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
      if (!agentId) return;
      const res = await request('/agents');
      if (!res.ok) return;
      const data = await res.json() as { agents?: Array<{ id?: string; agent_id?: string; avatar?: string | null }> };
      const agents = data?.agents ?? [];
      const match = agents.find(a => (a.id || a.agent_id) === agentId);
      const avatar = match?.avatar ?? null;
      agentAvatar.value = avatar;
      if (avatar) {
        messages.value = messages.value.map(m => m.message_type === 'agent' && !m.avatar ? { ...m, avatar } : m);
      }
    } catch (e) {
      console.warn('[ChatTimeline] fetchAgentAvatar failed', e);
    }
  }

  async function fillScrollable() {
    const el = containerRef.value;
    if (!el) return;
    let batches = 0;
    while (batches < 1 && hasMore.value) {
      if (el.scrollHeight > el.clientHeight + 10) break;
      const oldest = messages.value[0]?.timestamp;
      if (!oldest) break;
      const beforeCursor = new Date(new Date(oldest).getTime() - 1).toISOString();
      const res = await request(`/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(beforeCursor)}&${filters.value}`);
      if (!res.ok) break;
      const data: TimelineResponse = await res.json();
      if (!Array.isArray(data.messages) || data.messages.length === 0) { hasMore.value = data.has_more; break; }
      const newMsgs = data.messages.map(m => ({
        ...m, id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
        is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
      })).filter(m => !isTimelineSystemNoise(m)).filter(m => !hasId(m.id));

      if (newMsgs.length === 0) { hasMore.value = data.has_more; break; }
      newMsgs.forEach(m => addId(m.id));
      messages.value = [...newMsgs, ...messages.value].sort(stableMsgSort);
      hasMore.value = data.has_more;
      await nextTick();
      batches++;
      const newUserMsgs = messages.value.filter(m => m.id.startsWith('admin_') && m.message_type === 'user' && !m.attachments?.length);
      if (newUserMsgs.length > 0) enrichAttachmentsFromContent(newUserMsgs);
    }
  }

  async function loadLatest() {
    const sessionKey = getSessionKey();
    const gen = ++generation.value; // Increment generation counter

    // P1: 有 sessionKey 时先查缓存
    if (sessionKey) {
      const cached = messageCache.get(sessionKey);
      if (cached) {
        messages.value = cached.messages;
        knownIds.value = new Set(cached.knownIds);
        // Restore idAlias if present
        if (cached.idAlias) {
          idAlias.value = new Map(cached.idAlias as Array<[string, string]>);
        }
        hasMore.value = cached.hasMore;
        adminPageCursor = cached.adminPageCursor;
        agentAvatar.value = cached.agentAvatar;
        loading.value = false;
        // 后台静默刷新
        refreshInBackground(sessionKey, gen);
        if (messages.value.length > 0) {
          const latest = messages.value[messages.value.length - 1];
          lastPollTimestamp = latest.timestamp;
        }
        startPolling();
        nextTick(() => scrollToBottom(false));
        return;
      }
    }

    loading.value = true;
    knownIds.value = new Set();
    idAlias.value = new Map();
    resetAdminCursor();

    try {
      // Step 1: 获取 session chain
      if (sessionKey) {
        await fetchSessionChain(sessionKey);
      }

      let adminMsgs: TimelineMessage[] = [];
      let adminHasMore = false;

      // Step 2: 请求 Admin timeline（使用 chain filters）
      try {
        const activeFilters = getActiveFilters();
        const adminUrl = `/messages/timeline?limit=${PAGE_SIZE}&${activeFilters}`;
        const res = await request(adminUrl);
        if (res.ok) {
          const data: TimelineResponse = await res.json();
          adminMsgs = (data.messages || []).map(m => ({
            ...m,
            id: `admin_${m.id}`,
            clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
            is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
          }));
          adminHasMore = data.has_more;
        }
      } catch (e) {
        console.warn('[ChatTimeline] Admin timeline fetch failed', e);
      }

      // 先用 Admin 数据渲染
      const filteredAdminMsgs = adminMsgs.filter(m => !isTimelineSystemNoise(m));
      filteredAdminMsgs.forEach(m => addId(m.id));
      hasMore.value = adminHasMore;
      setMessages(filteredAdminMsgs);

      // Step 2: 异步加载 Gateway history（带 session key 守卫 + generation 守卫）
      if (sessionKey) {
        const capturedSessionKey = sessionKey;
        Promise.resolve().then(async () => {
          if (generation.value !== gen) return;
          try {
            const historyUrl = `/chat/history?sessionKey=${encodeURIComponent(capturedSessionKey)}&limit=10`;
            const historyRes = await request(historyUrl);
            if (!historyRes.ok || generation.value !== gen) return;
            if (getSessionKey() !== capturedSessionKey) return; // session key 守卫

            const result = await historyRes.json() as GatewayHistoryResponse | GatewayMessage[];
            if (generation.value !== gen) return;
            const rawMsgs = Array.isArray(result) ? result : ((result as GatewayHistoryResponse)?.messages ?? (result as GatewayHistoryResponse)?.history ?? []);
            const arr = Array.isArray(rawMsgs) ? rawMsgs : [];
            const gatewayMsgs = gatewayMsgsToTimeline(arr);
            if (gatewayMsgs.length === 0) return;

            // 增量合并：检查 knownIds + cross-source dedup
            const newGwMsgs: TimelineMessage[] = [];
            for (const m of gatewayMsgs) {
              if (hasId(m.id)) continue;
              // Check if an admin_ equivalent already exists
              const match = findMatchingMessage(m);
              if (match) {
                registerAlias(m.id, match.id);
                continue;
              }
              newGwMsgs.push(m);
            }
            if (newGwMsgs.length === 0) return;
            newGwMsgs.forEach(m => addId(m.id));

            const merged = [...messages.value, ...newGwMsgs].sort(stableMsgSort);
            messages.value = merged;

            syncCache();
          } catch (e) {
            console.warn('[ChatTimeline] Gateway loadLatest failed, using Admin data only', e);
          }
        });
      }

      // fetchAgentAvatar 不阻塞渲染
      fetchAgentAvatar();
      enrichAttachmentsFromContent(filteredAdminMsgs);
      await fillScrollable();
    } catch (e) {
      console.error('加载聊天记录失败', e);
    } finally {
      if (generation.value !== gen) return;
      loading.value = false;
      await nextTick();
      scrollToBottom(false);

      syncCache();

      if (messages.value.length > 0) {
        const latest = messages.value[messages.value.length - 1];
        lastPollTimestamp = latest.timestamp;
      }
      startPolling();
    }
  }

  async function refreshInBackground(sessionKey: string, parentGen?: number) {
    const gen = parentGen ?? generation.value;
    try {
      const res = await request(`/chat/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=10`);
      if (!res.ok || generation.value !== gen) return;
      if (getSessionKey() !== sessionKey) return; // session key 守卫

      const result = await res.json() as GatewayHistoryResponse | GatewayMessage[];
      if (generation.value !== gen) return;
      const rawMsgs = Array.isArray(result) ? result : ((result as GatewayHistoryResponse)?.messages ?? (result as GatewayHistoryResponse)?.history ?? []);
      const arr = Array.isArray(rawMsgs) ? rawMsgs : [];
      const newMsgs = gatewayMsgsToTimeline(arr);

      let changed = false;
      for (const m of newMsgs) {
        if (hasId(m.id)) continue;
        const match = findMatchingMessage(m);
        if (match) {
          registerAlias(m.id, match.id);
          continue;
        }
        addId(m.id);
        messages.value = [...messages.value, m].sort(stableMsgSort);
        changed = true;
      }
      if (changed) syncCache();
    } catch {
      // 静默失败
    }
  }

  async function loadMore() {
    if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
    if (messages.value.length >= MAX_MESSAGES) {
      // 淘汰最旧的消息，留出 loadMore 空间
      messages.value = messages.value.slice(-TRIM_TO);
      const newKnownIds = new Set<string>();
      for (const m of messages.value) newKnownIds.add(m.id);
      knownIds.value = newKnownIds;
    }
    loadingMore.value = true;
    const el = containerRef.value;
    const prevScrollTop = el?.scrollTop ?? 0;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const gen = generation.value;

    try {
      let beforeTs: string;
      if (adminPageCursor) {
        beforeTs = adminPageCursor;
      } else {
        const oldest = messages.value[0].timestamp;
        beforeTs = new Date(new Date(oldest).getTime() - 1).toISOString();
      }
      const url = `/messages/timeline?limit=${PAGE_SIZE}&before=${encodeURIComponent(beforeTs)}&${getActiveFilters()}`;
      const res = await request(url);
      if (!res.ok || generation.value !== gen) { hasMore.value = false; return; }
      const data: TimelineResponse = await res.json();
      if (!Array.isArray(data.messages) || data.messages.length === 0) { hasMore.value = data.has_more; return; }

      const adminMsgs = data.messages.map(m => ({
        ...m, id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
        is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
      })).filter(m => !isTimelineSystemNoise(m));

      const newMsgs = adminMsgs.filter(m => !hasId(m.id));

      const earliestReturned = adminMsgs.reduce((min, m) => {
        const t = new Date(m.timestamp).getTime();
        return t < min ? t : min;
      }, Infinity);
      if (earliestReturned < Infinity) {
        adminPageCursor = new Date(earliestReturned - 1).toISOString();
      }

      if (newMsgs.length === 0) { hasMore.value = data.has_more; return; }
      newMsgs.forEach(m => addId(m.id));
      messages.value = [...newMsgs, ...messages.value];
      hasMore.value = data.has_more;
      enforceMessageLimit();
      enrichAttachmentsFromContent(newMsgs);
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

  // ── 消息分组（保留不变） ──

  // Fix 2: also filter timeline system noise (cron/heartbeat) in Overview timeline
  const visibleMessages = computed(() => messages.value.filter(m => !m.is_system_context && !isTimelineSystemNoise(m)));

  const groupedMessages = computed(() => {
    const groups: import('./types').MsgGroup[] = [];
    let current: import('./types').MsgGroup | null = null;

    for (const msg of visibleMessages.value) {
      const role = msg.message_type === 'tool' ? 'agent' : msg.message_type;
      if (role === 'user') {
        if (current) { groups.push(current); current = null; }
        groups.push({ type: 'user', agentId: '', agentName: '', avatar: null, timestamp: msg.timestamp, messages: [msg], toolMsgs: [], hiddenToolCount: 0 });
      } else if (role === 'agent') {
        if (current && current.type === 'agent' && current.agentId === msg.agent_id) {
          if (msg.message_type === 'tool') { current.toolMsgs.push(msg); } else { current.messages.push(msg); }
        } else if (msg.message_type === 'tool' && current && current.type === 'agent') {
          current.toolMsgs.push(msg);
        } else {
          if (current) groups.push(current);
          current = {
            type: 'agent', agentId: msg.agent_id, agentName: msg.agent_name, avatar: msg.avatar,
            timestamp: msg.timestamp,
            messages: msg.message_type === 'tool' ? [] : [msg],
            toolMsgs: msg.message_type === 'tool' ? [msg] : [],
            hiddenToolCount: 0,
          };
          if (current && current.messages.length === 0) {
            current.messages.push({ id: msg.id, content: '', clean_content: '', message_type: 'agent' as const, agent_id: msg.agent_id, agent_name: msg.agent_name, timestamp: msg.timestamp, session_key: '', avatar: null, content_summary: null, is_cron: false, is_system_noise: false, source_channel: null, model: null } satisfies TimelineMessage);
          }
        }
      }
    }
    if (current) groups.push(current);

    const withDividers: import('./types').MsgGroup[] = [];
    let lastDateStr = '';
    for (const grp of groups) {
      const grpDate = new Date(grp.timestamp);
      const dateStr = `${grpDate.getFullYear()}-${grpDate.getMonth()}-${grpDate.getDate()}`;
      if (dateStr !== lastDateStr) {
        lastDateStr = dateStr;
        withDividers.push({
          type: 'date-divider',
          agentId: '',
          agentName: null,
          avatar: null,
          timestamp: grp.timestamp,
          messages: [],
          toolMsgs: [],
          hiddenToolCount: 0,
          dateLabel: formatDateLabel(grp.timestamp),
        });
      }
      withDividers.push(grp);
    }

    // 插入 session-divider：检测相邻消息的 session_key 变化
    const withSessionDividers: MsgGroup[] = [];
    let lastSessionKey = '';
    for (const grp of withDividers) {
      if (grp.type !== 'date-divider' && grp.messages.length > 0) {
        const grpSessionKey = grp.messages[0].session_key || '';
        if (lastSessionKey && grpSessionKey && grpSessionKey !== lastSessionKey) {
          withSessionDividers.push({
            type: 'session-divider',
            agentId: '',
            agentName: null,
            avatar: null,
            timestamp: grp.timestamp,
            messages: [],
            toolMsgs: [],
            hiddenToolCount: 0,
            sessionLabel: getSessionLabel(grpSessionKey),
            dateLabel: formatDateLabel(grp.timestamp),
          });
        }
        if (grpSessionKey) lastSessionKey = grpSessionKey;
      }
      withSessionDividers.push(grp);
    }

    for (const grp of withSessionDividers) {
      if (grp.toolMsgs.length > 3) {
        grp.hiddenToolCount = grp.toolMsgs.length - 2;
        grp.toolMsgs = grp.toolMsgs.slice(0, 2);
      }
    }
    return withSessionDividers;
  });

  // ── 重置（session 切换时） ──
  function getSessionLabel(sessionKey: string): string {
    const chainSession = chainSessions.value.find(s => s.session_key === sessionKey);
    if (chainSession?.label) return chainSession.label;
    if (chainSession?.first_message) {
      const truncated = chainSession.first_message.substring(0, 40);
      return truncated.length < chainSession.first_message.length ? truncated + '...' : truncated;
    }
    const parts = sessionKey.split(':');
    return parts.slice(-2).join(':');
  }

  // ── 重置（session 切换时） ──
  function reset() {
    generation.value = 0;
    chainSessions.value = [];
    chainCurrentIndex.value = -1;
    agentAvatar.value = null;
    knownIds.value = new Set();
    idAlias.value = new Map();
    optimisticMap.clear();
    resetAdminCursor();
    messages.value = [];
    stopPolling();
    lastPollTimestamp = null;
  }

  // ── 工具辅助（给模板用） ──

  function extractToolName(content: string | null): string {
    if (!content) return 'tool';
    const match = content.match(/Tool:\s*(\S+)/) || content.match(/"tool"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
    const firstLine = content.split('\n')[0].trim();
    return firstLine.length < 60 ? firstLine : 'tool';
  }

  function truncateToolContent(content: string | null, maxLen = 150): string {
    if (!content) return '';
    return content.length <= maxLen ? content : content.substring(0, maxLen) + '...';
  }

  function formatDateLabel(ts: string): string {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatTime(ts: string) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return time;
    if (diffDays === 1) return `昨天 ${time}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`;
  }

  function toolSummary(grp: import('./types').MsgGroup): string {
    const total = grp.toolMsgs.length + grp.hiddenToolCount;
    const names = [...new Set(grp.toolMsgs.map(tm => extractToolName(tm.content)))];
    const nameStr = names.length > 0 ? names.join(', ') : '';
    return `🔧 ${total} tools${nameStr ? ` (${nameStr})` : ''}`;
  }

  return {
    messages, loading, loadingMore, hasMore, newMsgCount, atBottom,
    containerRef, showTypingIndicator, agentAvatar,
    knownIds, idAlias, isSystemNoise, normalizeTimestamp, simpleHash,
    scrollToBottom, onScroll, goToBottom, checkBottom,
    loadLatest, loadMore, reset, fetchAgentAvatar, startPolling, stopPolling, pollNow,
    groupedMessages,
    extractToolName, truncateToolContent, formatTime, toolSummary,
    // P1: 统一 optimistic message 管理
    addOptimisticMessage,
    resolveOptimisticMessage,
    markOptimisticFailed,
    // P1: 统一缓存写入
    syncCache,
    // P0: ID 管理
    hasId, addId, resolveId, registerAlias,
    // Session Chain
    chainSessions, chainCurrentIndex, chainHasOlder, fetchSessionChain,
    getSessionLabel,
  };
}
