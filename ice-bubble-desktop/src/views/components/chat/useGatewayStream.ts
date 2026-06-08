/**
 * useGatewayStream — Gateway WebSocket 实时事件处理
 */
import { nextTick, ref, type Ref } from 'vue';
import { wsManager } from '@/services/websocket-manager';
import type { TimelineMessage, ToolCallEntry, GatewayMessage, GatewayContentBlock } from './types';

interface UseGatewayStreamOptions {
  getSessionKey: () => string | undefined;
  messages: { value: TimelineMessage[] };
  knownIds: { value: Set<string> };
  addId: (id: string) => void;
  hasId: (id: string) => boolean;
  registerAlias: (aliasId: string, canonicalId: string) => void;
  atBottom: { value: boolean };
  showTypingIndicator: { value: boolean };
  agentAvatar: { value: string | null };
  newMsgCount: { value: number };
  isSystemNoise: (content: string | null | undefined) => boolean;
  normalizeTimestamp: (ts: string | number | undefined) => string;
  simpleHash: (str: string) => number;
  scrollToBottom: (smooth?: boolean) => void;
  /** Poll on chat.final to fill in missing user messages (Admin + Gateway history) */
  pollNow?: () => Promise<void>;
  onProcessingChange?: (processing: boolean) => void;
  onRunIdChange?: (runId: string | null) => void;
}

export function useGatewayStream(opts: UseGatewayStreamOptions) {
  let unsubSessionMsg: (() => void) | null = null;
  let unsubChat: (() => void) | null = null;
  let unsubAgent: (() => void) | null = null;

  const activeRunId: Ref<string | null> = ref(null);
  const isProcessing: Ref<boolean> = ref(false);

  // Flag to poll Admin once per run when the first agent reply arrives
  // (Gateway session.message does not broadcast user messages, so we need
  //  an immediate Admin poll to fill in the missing user message.)


  // ── helpers ──

  function extractText(msg: unknown): string {
    const content = (msg as Record<string, unknown>)?.content;
    if (Array.isArray(content)) return (content as GatewayContentBlock[]).filter(c => c.type === 'text').map(c => c.text || '').join('');
    if (typeof content === 'string') return content;
    return '';
  }

  function extractAttachments(msg: unknown): TimelineMessage['attachments'] {
    const m = msg as Record<string, unknown>;
    const raw = (m?.attachments ?? m?.media) as unknown[] | undefined;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((rawAtt: unknown) => {
      const att = typeof rawAtt === 'string' ? { url: rawAtt } : rawAtt as Record<string, unknown>;
      const a = att as { dataUrl?: string; data_url?: string; type?: string; mimeType?: string; fileName?: string; filename?: string; content?: string; url?: string };
      if (a.dataUrl || a.data_url) {
        const du = a.dataUrl || a.data_url || '';
        const match = du.match(/^data:([^;]+);base64,(.+)$/);
        return {
          type: a.type || 'image',
          mimeType: a.mimeType || match?.[1] || 'image/png',
          fileName: a.fileName || a.filename || `attachment.${guessExt(match?.[1] || '')}`,
          content: match?.[2] || '',
          dataUrl: du,
        };
      }
      if (a.content && a.mimeType) {
        return {
          type: a.type || 'image',
          mimeType: a.mimeType,
          fileName: a.fileName || a.filename || `attachment.${guessExt(a.mimeType)}`,
          content: a.content,
          dataUrl: `data:${a.mimeType};base64,${a.content}`,
        };
      }
      if (a.url) {
        return {
          type: 'image',
          mimeType: a.mimeType || 'image/png',
          fileName: a.fileName || a.filename || 'attachment.png',
          content: '',
          dataUrl: a.url,
        };
      }
      return null;
    }).filter((a): a is NonNullable<typeof a> => !!a);
  }

  function guessExt(mimeType: string): string {
    const map: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    return map[mimeType] || 'bin';
  }

  function findStreamMsgIndex(runId: string): number {
    return opts.messages.value.findIndex(m => m.streamRunId === runId && m.streamState !== 'complete' && m.streamState !== 'error');
  }

  function stableMsgSort(a: TimelineMessage, b: TimelineMessage): number {
    const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (diff !== 0) return diff;
    const numA = parseInt(a.id.replace(/^[a-z]+_/, ''), 10) || 0;
    const numB = parseInt(b.id.replace(/^[a-z]+_/, ''), 10) || 0;
    return numA - numB;
  }

  function ensureStreamMsg(runId: string) {
    if (findStreamMsgIndex(runId) >= 0) return;
    opts.showTypingIndicator.value = false;
    const sessionAgentId = opts.getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
    opts.messages.value = [...opts.messages.value, {
      id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      session_key: opts.getSessionKey() || '',
      agent_id: sessionAgentId || 'assistant',
      agent_name: null,
      avatar: opts.agentAvatar.value,
      message_type: 'agent',
      content: '', clean_content: '', content_summary: null,
      is_cron: false, is_system_noise: false, source_channel: null, model: null,
      timestamp: new Date().toISOString(),
      streamRunId: runId, streamState: 'thinking' as const, toolCalls: [],
    }];
  }

  function payloadToMessage(data: Record<string, unknown>): TimelineMessage | null {
    const content = data.content as string | undefined;
    const role = data.role as string | undefined;
    if (!data.id && !content) return null;
    const msgType = role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'agent';
    const rawId = data.id as number | string | undefined;
    const fallbackId = rawId !== undefined
      ? `gw_${rawId}`
      : `gw_${opts.simpleHash(`${(data.sessionKey as string) || ''}:${(data.timestamp as string) || ''}:${(content || '').substring(0, 80)}`)}`;
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
      is_cron: false, is_system_noise: false,
      source_channel: (data.sourceChannel as string) ?? null,
      model: (data.model as string) ?? null,
      timestamp: opts.normalizeTimestamp(data.timestamp as string | number | undefined),
      attachments: extractAttachments(data),
    };
  }

  // ── chat handlers ──

  function setProcessing(v: boolean) {
    if (isProcessing.value !== v) {
      isProcessing.value = v;
      opts.onProcessingChange?.(v);
    }
  }

  function setActiveRunId(id: string | null) {
    if (activeRunId.value !== id) {
      activeRunId.value = id;
      opts.onRunIdChange?.(id);
    }
  }

  function handleChatDelta(data: Record<string, unknown>, runId: string) {
    const msg = data.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const text = extractText(msg);
    if (!text) return;
    if (!isProcessing.value) setProcessing(true);
    if (activeRunId.value !== runId) setActiveRunId(runId);
    const idx = findStreamMsgIndex(runId);

    if (idx >= 0) {
      opts.messages.value[idx] = { ...opts.messages.value[idx], content: text, clean_content: text, streamState: 'streaming' };
    } else {
      opts.showTypingIndicator.value = false;
      const sessionAgentId = opts.getSessionKey()?.match(/^agent:([^:]+)/)?.[1];
      const streamMsg: TimelineMessage = {
        id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_key: opts.getSessionKey() || '',
        agent_id: sessionAgentId || 'assistant',
        agent_name: (data.agentName as string) || null,
        avatar: opts.agentAvatar.value,
        message_type: 'agent',
        content: text, clean_content: text, content_summary: null,
        is_cron: false, is_system_noise: false, source_channel: null,
        model: (data.model as string) || null,
        timestamp: new Date().toISOString(),
        streamRunId: runId, streamState: 'streaming', toolCalls: [],
      };
      opts.messages.value = [...opts.messages.value, streamMsg];
    }
    if (opts.atBottom.value) nextTick(() => opts.scrollToBottom(false));
  }

  function handleChatFinal(data: Record<string, unknown>, runId: string) {
    const msg = data.message as Record<string, unknown> | undefined;
    const finalText = msg ? extractText(msg) : null;
    const rawFinalId = data.messageId ?? data.id ?? Date.now();
    const finalId = typeof rawFinalId === 'number' || typeof rawFinalId === 'string'
      ? `gw_${rawFinalId}` : `gw_${Date.now()}`;
    const idx = findStreamMsgIndex(runId);

    const attachments = (msg ? extractAttachments(msg) : undefined)
      || extractAttachments(data)
      || undefined;
    if (idx >= 0) {
      if (opts.isSystemNoise(finalText)) {
        opts.messages.value.splice(idx, 1);
        opts.showTypingIndicator.value = false;
        return;
      }
      opts.messages.value[idx] = {
        ...opts.messages.value[idx],
        id: finalId,
        content: finalText || opts.messages.value[idx].content || '',
        clean_content: finalText || opts.messages.value[idx].clean_content || '',
        streamState: 'complete',
        avatar: opts.messages.value[idx].avatar || opts.agentAvatar.value,
        timestamp: new Date().toISOString(),
        attachments: attachments || opts.messages.value[idx].attachments,
      };
      opts.addId(finalId);
    }
    opts.showTypingIndicator.value = false;
    setActiveRunId(null);
    setProcessing(false);
    if (opts.atBottom.value) nextTick(() => opts.scrollToBottom(false));

    // 流式文本中 MEDIA: 已被 Gateway 剥离，通过 chat.history 获取完整内容以渲染图片
    const sessionKey = opts.getSessionKey();
    if (sessionKey && wsManager.isConnected) {
      setTimeout(async () => {
        try {
          // 获取最近 5 条消息，增加匹配概率
          const res = await wsManager.clientRef.getChatHistory(sessionKey, 5);
          const history = res as { messages?: GatewayMessage[] } | null;
          const messages = history?.messages || [];
          if (messages.length === 0) return;
          // 优先按消息 ID 精确匹配
          let targetMsg: GatewayMessage | null = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            const text = extractText(messages[i]);
            if (text && text.includes('MEDIA:')) {
              const msgId = messages[i].id;
              if (msgId && (String(msgId) === String(rawFinalId) ||
                  messages[i].id === data.id ||
                  messages[i].messageId === data.messageId)) {
                targetMsg = messages[i];
                break;
              }
            }
          }
          // ID 匹配失败，兜底取最近含 MEDIA: 的消息
          if (!targetMsg) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const text = extractText(messages[i]);
              if (text && text.includes('MEDIA:')) {
                targetMsg = messages[i];
                break;
              }
            }
          }
          if (!targetMsg) return;
          const fullText = extractText(targetMsg);
          const curIdx = opts.messages.value.findIndex(
            m => m.streamRunId === runId || m.id === finalId
          );
          if (curIdx < 0) return;
          opts.messages.value[curIdx] = {
            ...opts.messages.value[curIdx],
            content: fullText,
            clean_content: fullText,
          };
        } catch { /* ignore */ }
      }, 800);
    }
  }

  function handleChatError(data: Record<string, unknown>, runId: string) {
    const errorMsg = (data.errorMessage as string) || '回复出错';
    const idx = findStreamMsgIndex(runId);

    if (idx >= 0) {
      opts.messages.value[idx] = { ...opts.messages.value[idx], content: `❌ **错误：** ${errorMsg}`, clean_content: `错误：${errorMsg}`, streamState: 'error', streamRunId: undefined };
    } else {
      opts.messages.value = [...opts.messages.value, {
        id: `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_key: opts.getSessionKey() || '', agent_id: 'system', agent_name: null, avatar: null,
        message_type: 'agent',
        content: `❌ **错误：** ${errorMsg}`, clean_content: `错误：${errorMsg}`,
        content_summary: null, is_cron: false, is_system_noise: false, source_channel: null, model: null,
        timestamp: new Date().toISOString(),
      }];
    }
    opts.showTypingIndicator.value = false;
    setActiveRunId(null);
    setProcessing(false);
    if (opts.atBottom.value) nextTick(() => opts.scrollToBottom(false));
  }

  function handleChatAborted(_data: Record<string, unknown>, runId: string) {
    const idx = findStreamMsgIndex(runId);
    if (idx >= 0) {
      const content = opts.messages.value[idx].content || '';
      opts.messages.value[idx] = { ...opts.messages.value[idx], content, clean_content: content, streamState: 'aborted' as const };
    } else {
      // 兜底：找不到对应消息时，将所有仍在 streaming 的消息标记为 aborted
      opts.messages.value.forEach((m, i) => {
        if (m.streamState === 'streaming' || m.streamState === 'thinking') {
          const c = m.content || '';
          opts.messages.value[i] = { ...m, content: c, clean_content: c, streamState: 'aborted' as const };
        }
      });
    }
    opts.showTypingIndicator.value = false;
    setActiveRunId(null);
    setProcessing(false);
    if (opts.atBottom.value) nextTick(() => opts.scrollToBottom(false));
  }

  // ── agent handlers ──

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
      ensureStreamMsg(runId);
      const idx = findStreamMsgIndex(runId);
      if (idx >= 0 && opts.messages.value[idx].toolCalls) {
        opts.messages.value[idx].toolCalls!.push(toolEntry);
      }
    } else if (phase === 'end' || phase === 'result') {
      const idx = findStreamMsgIndex(runId);
      if (idx >= 0 && opts.messages.value[idx].toolCalls) {
        const tcs = opts.messages.value[idx].toolCalls!;
        const lastTc = [...tcs].reverse().find(tc => tc.toolCallId === toolEntry.toolCallId || tc.toolName === toolEntry.toolName);
        if (lastTc) {
          lastTc.phase = phase === 'end' ? 'result' : phase;
          lastTc.result = toolEntry.result || lastTc.result;
          lastTc.error = toolEntry.error || lastTc.error;
          lastTc.finishedAt = Date.now();
        }
      }
    }
  }

  function handleLifecycleEvent(runId: string, phase?: string) {
    switch (phase) {
      case 'start':
        opts.showTypingIndicator.value = true;
        if (!isProcessing.value) setProcessing(true);
        if (runId && activeRunId.value !== runId) setActiveRunId(runId);
        break;
      case 'end': case 'error':
        opts.showTypingIndicator.value = false;
        // 不在此处设 false，等 final/aborted/error (chat 事件) 统一处理
        break;
    }
  }

  // ── 订阅/取消 ──

  function subscribe() {
    unsubSessionMsg = wsManager.clientRef.on('session.message', (payload: unknown) => {
      const data = payload as Record<string, unknown> | undefined;
      if (!data) return;
      // Broadcast event — accept messages for the active session or messages with
      // no sessionKey (e.g. system notifications). Do NOT block cross-client broadcasts.
      const msgSessionKey = data.sessionKey as string | undefined;
      const mySessionKey = opts.getSessionKey();
      if (mySessionKey && msgSessionKey && msgSessionKey !== mySessionKey) {
        return;
      }
      const msg = payloadToMessage(data);
      if (!msg || opts.hasId(msg.id)) return;
      if (opts.isSystemNoise(msg.content)) return;
      const dup = opts.messages.value.find(m =>
        m.content && msg.content &&
        m.content.substring(0, 200) === msg.content.substring(0, 200) &&
        Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 2000
      );
      if (dup) {
        // 合并 attachments（流式 chat final 可能不含附件，session.message 才有）
        if (msg.attachments && msg.attachments.length > 0 && (!dup.attachments || dup.attachments.length === 0)) {
          opts.messages.value = opts.messages.value.map(m =>
            m === dup ? { ...m, attachments: msg.attachments } : m
          );
        }
        return;
      }
      opts.addId(msg.id);
      opts.messages.value = [...opts.messages.value, msg].sort(stableMsgSort);
      if (opts.atBottom.value) { nextTick(() => opts.scrollToBottom(false)); } else { opts.newMsgCount.value++; }
    });

    unsubChat = wsManager.clientRef.on('chat', (payload: unknown) => {
      const data = payload as Record<string, unknown> | undefined;
      if (!data) return;
      if (data.sessionKey !== opts.getSessionKey()) {
        if (data.state === 'delta' || data.state === 'final') console.debug('[GW stream] sessionKey mismatch:', data.sessionKey, '!=', opts.getSessionKey());
        return;
      }
      const runId = data.runId as string | undefined;
      const state = data.state as string | undefined;
      switch (state) {
        case 'start': setProcessing(true); if (runId) setActiveRunId(runId); break;
        default: break;
        case 'delta': handleChatDelta(data, runId || ''); break;
        case 'final': handleChatFinal(data, runId || ''); opts.pollNow?.(); break;
        case 'error': handleChatError(data, runId || ''); break;
        case 'aborted': handleChatAborted(data, runId || ''); break;
      }
    });

    unsubAgent = wsManager.clientRef.on('agent', (payload: unknown) => {
      const data = payload as Record<string, unknown> | undefined;
      if (!data || data.sessionKey !== opts.getSessionKey()) return;
      const stream = data.stream as string | undefined;
      const runId = data.runId as string | undefined;
      const innerData = data.data as Record<string, unknown> | undefined;
      const phase = innerData?.phase as string | undefined;
      if (stream === 'tool') { handleToolEvent(data, runId || ''); }
      else if (stream === 'lifecycle') { handleLifecycleEvent(runId || '', phase); }
    });
  }

  function unsubscribe() {
    if (unsubSessionMsg) { unsubSessionMsg(); unsubSessionMsg = null; }
    if (unsubChat) { unsubChat(); unsubChat = null; }
    if (unsubAgent) { unsubAgent(); unsubAgent = null; }
    opts.showTypingIndicator.value = false;
  }

  return { subscribe, unsubscribe, activeRunId, isProcessing };
}
