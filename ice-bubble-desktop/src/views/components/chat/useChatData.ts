/**
 * useChatData — 消息列表数据管理
 */
import { ref, computed, nextTick } from 'vue';
import { request } from '../../../api/client';
import { API_BASE } from '../../../config';
import type { TimelineMessage, TimelineResponse, GatewayMessage, GatewayContentBlock, GatewayToolCallBlock, GatewayHistoryResponse, MediaBatchResponse, MediaBatchItem } from './types';

import { parseMediaAttached, stripMediaAttachedMarkers, detectInlineImages } from './media-parser';

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

  let knownIds = new Set<string>();
  let adminPageCursor: string | null = null;
  const PAGE_SIZE = 30;

  // ── 工具函数 ──

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
    if (m.message_type === 'agent' && !content.trim() && !clean.trim()) return true;
    if (content.startsWith('Sender (untrusted metadata):') && !clean.trim()) return true;
    if (clean.trim() === 'NO_REPLY') return true;
    return false;
  }

  function stripOpenClawMetadata(text: string): string {
    if (!text) return text;
    let cleaned = text.replace(/Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*\n*/g, '');
    cleaned = cleaned.replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/gm, '');
    return cleaned.trim() || text;
  }

  function contentKey(m: TimelineMessage): string {
    return (m.clean_content || m.content || '').substring(0, 200).trim();
  }

  function dedupByContent(msgs: TimelineMessage[], existing: TimelineMessage[]): TimelineMessage[] {
    const existingKeys = new Set(existing.map(m => contentKey(m)));
    const seenInBatch = new Set<string>();
    return msgs.filter(m => {
      const ck = contentKey(m);
      if (existingKeys.has(ck) || seenInBatch.has(ck)) return false;
      seenInBatch.add(ck);
      return true;
    });
  }

  function setMessages(msgs: TimelineMessage[]) {
    knownIds.clear();
    const seen = new Set<string>();
    const seenContent = new Set<string>();
    const filtered = msgs.filter(m => {
      if (isEmptyUserMsg(m) || seen.has(m.id)) return false;
      const ck = contentKey(m);
      if (seenContent.has(ck)) return false;
      seenContent.add(ck);
      seen.add(m.id);
      return true;
    });
    filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    messages.value = filtered;
    filtered.forEach(m => knownIds.add(m.id));
  }

  /**
   * 为用户历史消息加载附件，基于内容解析（media attached 标记）而非时间戳匹配。
   */
  async function enrichAttachmentsFromContent(msgs: TimelineMessage[]): Promise<void> {
    const userMsgs = msgs.filter(m => m.message_type === 'user' && (!m.attachments || m.attachments.length === 0));
    if (userMsgs.length === 0) return;

    // 批量收集所有需要查询的 media ID
    const msgMediaMap = new Map<TimelineMessage, string[]>();
    for (const m of userMsgs) {
      const refs = parseMediaAttached(m.content || '');
      if (refs.length > 0) {
        msgMediaMap.set(m, refs.map(r => r.fileName));
      }
    }

    // 批量查询 media 元数据
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

    // 按 ID 索引
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
        // 如果有附件且文本只是占位符（如「(图片)」），清空文本
        if (m.attachments.length > 0) {
          const cleaned = m.content
            ?.replace(/^\[.*?\]\s*/, '')  // 移除时间戳前缀
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
        // 处理 Gateway history 的 images 字段（inline base64 images）
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
    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return result;
  }

  // ── 过滤 ──

  const filters = computed(() => {
    const agentId = getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
    return `exclude_system_noise=true&exclude_cron=true&message_types=user,agent${agentId ? `&agent_ids=${agentId}` : ''}`;
  });

  // ── 滚动 ──

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
      })).filter(m => !knownIds.has(m.id)).filter(m => !isTimelineSystemNoise(m));
      if (newMsgs.length === 0) { hasMore.value = data.has_more; break; }
      newMsgs.forEach(m => knownIds.add(m.id));
      messages.value = [...newMsgs, ...messages.value].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      hasMore.value = data.has_more;
      await nextTick();
      batches++;
      // Load attachments for newly added messages
      const newUserMsgs = messages.value.filter(m => m.id.startsWith('admin_') && m.message_type === 'user' && !m.attachments?.length);
      if (newUserMsgs.length > 0) enrichAttachmentsFromContent(newUserMsgs);
    }
  }

  async function loadLatest() {
    loading.value = true;
    knownIds.clear();
    resetAdminCursor();

    try {
      // 并行请求 Gateway history 和 Admin timeline
      const sessionKey = getSessionKey();

      const gatewayPromise = (async (): Promise<TimelineMessage[]> => {
        if (!sessionKey) return [];
        try {
          const historyUrl = `/chat/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=10`;
          const historyRes = await request(historyUrl);
          if (historyRes.ok) {
            const result = await historyRes.json() as GatewayHistoryResponse | GatewayMessage[];
            const rawMsgs = Array.isArray(result) ? result : ((result as GatewayHistoryResponse)?.messages ?? (result as GatewayHistoryResponse)?.history ?? []);
            const arr = Array.isArray(rawMsgs) ? rawMsgs : [];
            return gatewayMsgsToTimeline(arr);
          }
        } catch (e) {
          console.warn('[ChatTimeline] Gateway loadLatest failed, falling back to Admin', e);
        }
        return [];
      })();

      const adminPromise = (async (): Promise<{ msgs: TimelineMessage[]; has_more: boolean }> => {
        try {
          const adminUrl = `/messages/timeline?limit=${PAGE_SIZE}&${filters.value}`;
          const res = await request(adminUrl);
          if (res.ok) {
            const data: TimelineResponse = await res.json();
            const msgs = (data.messages || []).map(m => ({
              ...m,
              id: `admin_${m.id}`,
              clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
              is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
            }));
            return { msgs, has_more: data.has_more };
          }
        } catch (e) {
          console.warn('[ChatTimeline] Admin timeline fetch failed', e);
        }
        return { msgs: [], has_more: false };
      })();

      const [gatewayMsgs, adminResult] = await Promise.all([gatewayPromise, adminPromise]);

      // 注册 gateway IDs 到 knownIds（用于去重）
      gatewayMsgs.forEach(m => knownIds.add(m.id));

      // 过滤 admin 消息：去除与 gateway 重复的 + 系统噪音
      const adminMsgs = adminResult.msgs
        .filter(m => !knownIds.has(m.id))
        .filter(m => !isTimelineSystemNoise(m));
      adminMsgs.forEach(m => knownIds.add(m.id));
      hasMore.value = adminResult.has_more;

      const merged = [...adminMsgs, ...gatewayMsgs].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      setMessages(merged);

      // fetchAgentAvatar 不阻塞渲染，后台加载
      fetchAgentAvatar();
      enrichAttachmentsFromContent(merged); // 后台加载附件
      await fillScrollable();
    } catch (e) {
      console.error('加载聊天记录失败', e);
    } finally {
      loading.value = false;
      await nextTick();
      scrollToBottom(false);
    }
  }

  async function loadMore() {
    if (loadingMore.value || !hasMore.value || messages.value.length === 0) return;
    loadingMore.value = true;
    const el = containerRef.value;
    const prevScrollTop = el?.scrollTop ?? 0;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    try {
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
      if (!Array.isArray(data.messages) || data.messages.length === 0) { hasMore.value = data.has_more; return; }

      const adminMsgs = data.messages.map(m => ({
        ...m, id: `admin_${m.id}`,
        clean_content: m.clean_content || stripOpenClawMetadata(m.content || '') || m.content,
        is_turn_failed: isAssistantTurnFailed(m.clean_content || m.content),
      })).filter(m => !isTimelineSystemNoise(m));

      const idFiltered = adminMsgs.filter(m => !knownIds.has(m.id));
      const newMsgs = dedupByContent(idFiltered, messages.value);

      const earliestReturned = adminMsgs.reduce((min, m) => {
        const t = new Date(m.timestamp).getTime();
        return t < min ? t : min;
      }, Infinity);
      if (earliestReturned < Infinity) {
        adminPageCursor = new Date(earliestReturned - 1).toISOString();
      }

      if (newMsgs.length === 0) { hasMore.value = data.has_more; return; }
      newMsgs.forEach(m => knownIds.add(m.id));
      messages.value = [...newMsgs, ...messages.value];
      hasMore.value = data.has_more;
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

  // ── 消息分组 ──

  const visibleMessages = computed(() => messages.value.filter(m => !m.is_system_context));

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

    // Insert date-divider groups between messages on different dates
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

    for (const grp of withDividers) {
      if (grp.toolMsgs.length > 3) {
        grp.hiddenToolCount = grp.toolMsgs.length - 2;
        grp.toolMsgs = grp.toolMsgs.slice(0, 2);
      }
    }
    return withDividers;
  });

  // ── 重置（session 切换时） ──

  function reset() {
    agentAvatar.value = null;
    knownIds.clear();
    resetAdminCursor();
    messages.value = [];
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
    knownIds, isSystemNoise, normalizeTimestamp, simpleHash,
    scrollToBottom, onScroll, goToBottom, checkBottom,
    loadLatest, loadMore, reset, fetchAgentAvatar,
    groupedMessages,
    extractToolName, truncateToolContent, formatTime, toolSummary,
  };
}
