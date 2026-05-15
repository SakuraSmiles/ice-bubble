/**
 * useGatewayStream — Gateway WebSocket 实时事件处理
 */
import { nextTick } from 'vue';
import { gatewayClient } from '@/services/gateway-client';
import type { TimelineMessage, ToolCallEntry } from './types';

interface UseGatewayStreamOptions {
  getSessionKey: () => string | undefined;
  messages: { value: TimelineMessage[] };
  knownIds: Set<string>;
  atBottom: { value: boolean };
  showTypingIndicator: { value: boolean };
  agentAvatar: { value: string | null };
  newMsgCount: { value: number };
  isSystemNoise: (content: string | null | undefined) => boolean;
  normalizeTimestamp: (ts: string | number | undefined) => string;
  simpleHash: (str: string) => number;
  scrollToBottom: (smooth?: boolean) => void;
}

export function useGatewayStream(opts: UseGatewayStreamOptions) {
  let unsubSessionMsg: (() => void) | null = null;
  let unsubChat: (() => void) | null = null;
  let unsubAgent: (() => void) | null = null;

  // ── helpers ──

  function extractText(msg: any): string {
    if (Array.isArray(msg.content)) return msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('');
    if (typeof msg.content === 'string') return msg.content;
    return '';
  }

  function extractAttachments(msg: any): TimelineMessage['attachments'] {
    const raw = msg?.attachments ?? msg?.media;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((att: any) => {
      const a: any = typeof att === 'string' ? { url: att } : att;
      if (a.dataUrl || a.data_url) {
        const du = a.dataUrl || a.data_url;
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

  function handleChatDelta(data: Record<string, unknown>, runId: string) {
    const msg = data.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const text = extractText(msg);
    if (!text) return;
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
      opts.knownIds.add(finalId);
    }
    opts.showTypingIndicator.value = false;
    if (opts.atBottom.value) nextTick(() => opts.scrollToBottom(false));
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

  function handleLifecycleEvent(_runId: string, phase?: string) {
    switch (phase) {
      case 'start': opts.showTypingIndicator.value = true; break;
      case 'end': case 'error': opts.showTypingIndicator.value = false; break;
    }
  }

  // ── 订阅/取消 ──

  function subscribe() {
    unsubSessionMsg = gatewayClient.on('session.message', (payload: unknown) => {
      const data = payload as Record<string, unknown> | undefined;
      if (!data) return;
      const msgSessionKey = data.sessionKey as string | undefined;
      if (opts.getSessionKey() && msgSessionKey !== opts.getSessionKey()) return;
      const msg = payloadToMessage(data);
      if (!msg || opts.knownIds.has(msg.id)) return;
      if (opts.isSystemNoise(msg.content)) return;
      const dup = opts.messages.value.find(m =>
        m.content && msg.content &&
        m.content.substring(0, 200) === msg.content.substring(0, 200) &&
        Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 5000
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
      opts.knownIds.add(msg.id);
      opts.messages.value = [...opts.messages.value, msg].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      if (opts.atBottom.value) { nextTick(() => opts.scrollToBottom(false)); } else { opts.newMsgCount.value++; }
    });

    unsubChat = gatewayClient.on('chat', (payload: unknown) => {
      const data = payload as Record<string, unknown> | undefined;
      if (!data || data.sessionKey !== opts.getSessionKey()) return;
      const runId = data.runId as string | undefined;
      const state = data.state as string | undefined;
      switch (state) {
        case 'delta': handleChatDelta(data, runId || ''); break;
        case 'final': handleChatFinal(data, runId || ''); break;
        case 'error': handleChatError(data, runId || ''); break;
      }
    });

    unsubAgent = gatewayClient.on('agent', (payload: unknown) => {
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

  return { subscribe, unsubscribe };
}
