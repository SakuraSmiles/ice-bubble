/**
 * OpenClaw 原始数据转换器
 * 
 * 功能：将 OpenClaw 原始事件格式转换为 UnifiedMessage 统一格式
 * 
 * 参考：
 * - docs/数据转换映射.md
 * - docs/OpenClaw-Session数据格式参考.md
 */

import {
  OpenClawEvent,
  MessageEvent,
  Message,
  TextContent,
  ToolCallContent,
  isMessageEvent,
} from '../types/openclaw.js';

import {
  UnifiedMessage,
  ToolCall,
} from '../types/index.js';

import { Logger } from '../utils/logger.js';

const converterLogger = new Logger('Converter');

// ==================== 主转换入口 ====================

/**
 * 将 OpenClaw 事件转换为 UnifiedMessage（安全版本）
 * 
 * 增强功能：
 * - 完整的错误处理和日志记录
 * - 支持多种消息格式（标准、简化、扁平化）
 * - 自动修复常见格式问题
 * 
 * @param event - OpenClaw 原始事件
 * @param sessionKey - Session Key
 * @returns UnifiedMessage 或 null
 */
export function convertOpenClawEvent(
  event: OpenClawEvent,
  sessionKey: string
): UnifiedMessage | null {
  try {
    // 安全检查：验证基本结构
    if (!event || typeof event !== 'object') {
      converterLogger.warn('无效的事件对象:', { eventType: typeof event });
      return null;
    }

    // 尝试修复和标准化事件格式
    const normalizedEvent = normalizeEventFormat(event) as unknown as OpenClawEvent;
    
    // 只处理 MessageEvent
    if (!isMessageEvent(normalizedEvent)) {
      return null;
    }

    const messageEvent = normalizedEvent as MessageEvent;
    
    // 验证 message 对象是否存在
    if (!messageEvent.message) {
      converterLogger.warn('缺少 message 字段', { eventId: messageEvent.id });
      return null;
    }
    
    // 根据消息角色路由到不同的转换函数
    switch (messageEvent.message.role) {
      case 'user':
        return convertUserMessage(messageEvent, sessionKey);
      
      case 'assistant':
        return convertAssistantMessage(messageEvent, sessionKey);
      
      case 'toolResult':
        return convertToolResultMessage(messageEvent, sessionKey);
      
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 未知消息角色，需要动态访问
        converterLogger.warn(`未知的消息角色: ${(messageEvent.message as { role?: unknown }).role}`);
        return null;
    }
  } catch (error) {
    converterLogger.error('转换失败', error instanceof Error ? error : new Error(String(error)), { eventPreview: JSON.stringify(event).slice(0, 500) });
    return null;
  }
}

/**
 * 标准化事件格式
 * 
 * 支持多种格式：
 * 1. 标准 OpenClaw 格式：{ type: 'message', message: { role: ..., content: ... } }
 * 2. 简化格式：{ role: 'user', content: '...' } （自动包装为标准格式）
 * 3. 扁平化格式：{ type: 'message', role: 'user', content: [...] } （message 字段提升到顶层）
 */
function normalizeEventFormat(event: unknown): Record<string, unknown> {
  // 类型守卫：确保 event 是非 null 对象
  if (event === null || typeof event !== 'object') {
    return {};
  }
  const e = event as Record<string, unknown>;
  // 如果已经是标准格式，直接返回
  if (e.type === 'message' && e.message && typeof e.message === 'object' && (e.message as Record<string, unknown>).role) {
    return e;
  }
  
  // 扁平化格式：message 的字段被提升到顶层
  if (e.type === 'message' && e.role && !e.message) {
    return {
      ...e,
      parentId: e.parentId || null,
      message: {
        role: e.role,
        content: Array.isArray(e.content) ? e.content : [{ type: 'text', text: String(e.content || '') }],
        timestamp: e.timestamp || Date.now(),
      },
    };
  }
  
  // 简化格式：只有 role 和 content
  if (e.role && !e.type) {
    return {
      type: 'message',
      id: e.id || `generated-${Date.now()}`,
      parentId: e.parentId || null,
      timestamp: e.timestamp || new Date().toISOString(),
      message: {
        role: e.role,
        content: Array.isArray(e.content) ? e.content : [{ type: 'text', text: String(e.content || '') }],
        timestamp: e.timestamp || Date.now(),
      },
    };
  }
  
  // 无法识别的格式，返回原始对象
  return e;
}

// ==================== User 消息转换 ====================

/**
 * 转换用户消息
 * 
 * @param event - MessageEvent（role: user）
 * @param sessionKey - Session Key
 * @returns UnifiedMessage
 * 
 * @example
 * const userMessage = {
 *   type: 'message',
 *   id: 'bedd2c2c',
 *   parentId: 'babae8ca',
 *   timestamp: '2026-04-03T04:16:30.643Z',
 *   message: {
 *     role: 'user',
 *     content: [{ type: 'text', text: '帮我分析错误' }],
 *     timestamp: 1775189790619
 *   }
 * };
 * 
 * const unified = convertUserMessage(userMessage, sessionKey);
 * // unified.messageType === 'user'
 * // unified.content === '帮我分析错误'
 */
export function convertUserMessage(
  event: MessageEvent,
  sessionKey: string
): UnifiedMessage {
  // 提取文本内容（只提取 text 类型）
  const textContent = extractTextContent(event.message.content);

  return {
    id: event.id,
    sessionKey,
    messageType: 'user',
    timestamp: new Date(event.timestamp),
    source: 'file',
    content: textContent,
    metadata: {
      eventId: event.id,
      parentId: event.parentId || undefined,
      contentCount: event.message.content.length,
      // 保留原始消息时间戳
      messageTimestamp: event.message.timestamp,
    },
    raw: event,
  };
}

// ==================== Assistant 消息转换 ====================

/**
 * 转换 AI 回复消息
 * 
 * @param event - MessageEvent（role: assistant）
 * @param sessionKey - Session Key
 * @returns UnifiedMessage
 * 
 * @example
 * const assistantMessage = {
 *   type: 'message',
 *   id: '79381d9b',
 *   timestamp: '2026-04-03T04:16:33.704Z',
 *   message: {
 *     role: 'assistant',
 *     content: [
 *       { type: 'thinking', thinking: '...', thinkingSignature: '...' },
 *       { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'ls' } },
 *       { type: 'text', text: '我来帮你分析' }
 *     ],
 *     api: 'anthropic-messages',
 *     provider: 'minimax-cn',
 *     model: 'MiniMax-M2.7',
 *     usage: { input: 36, output: 78, totalTokens: 13149, cost: { total: 0.000135 } },
 *     stopReason: 'toolUse',
 *     responseId: '061e721fe126c3448a74f7a585e4e451'
 *   }
 * };
 * 
 * const unified = convertAssistantMessage(assistantMessage, sessionKey);
 * // unified.messageType === 'agent'
 * // unified.model === 'MiniMax-M2.7'
 * // unified.tools === [{ name: 'exec', input: { command: 'ls' }, result: undefined }]
 */
export function convertAssistantMessage(
  event: MessageEvent,
  sessionKey: string
): UnifiedMessage {
  const message = event.message;
  
  // 提取文本内容（仅 text 类型）
  const textContent = extractTextContent(message.content);

  // 提取工具调用
  const tools = extractToolCalls(message.content);

  // 构造 Token 统计
  const tokens = message.usage ? {
    input: message.usage.input,
    output: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    cost: message.usage.cost ? {
      total: message.usage.cost.total,
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cacheRead: message.usage.cost.cacheRead,
      cacheWrite: message.usage.cost.cacheWrite,
    } : undefined,
  } : undefined;

  return {
    id: event.id,
    sessionKey,
    messageType: 'agent',
    timestamp: new Date(event.timestamp),
    source: 'file',
    content: textContent,
    model: message.model,
    tokens,
    tools: tools.length > 0 ? tools : undefined,
    metadata: {
      eventId: event.id,
      parentId: event.parentId || undefined,
      provider: message.provider,
      api: message.api,
      stopReason: message.stopReason,
      responseId: message.responseId,
      // 标记是否包含 thinking 内容
      thinkingIncluded: message.content.some(c => c.type === 'thinking'),
      // 记录所有内容类型
      contentTypes: message.content.map(c => c.type),
      // 消息时间戳
      messageTimestamp: message.timestamp,
    },
    raw: event,
  };
}

// ==================== ToolResult 消息转换 ====================

/**
 * 转换工具结果消息
 * 
 * @param event - MessageEvent（role: toolResult）
 * @param sessionKey - Session Key
 * @returns UnifiedMessage
 * 
 * @example
 * const toolResultMessage = {
 *   type: 'message',
 *   id: 'f04ed3dc',
 *   timestamp: '2026-04-03T04:16:33.969Z',
 *   message: {
 *     role: 'toolResult',
 *     toolCallId: 'call_function_okm0dl5ye5bd_1',
 *     toolName: 'exec',
 *     content: [{ type: 'text', text: 'Approval required (id bc5f3f08...)' }],
 *     details: {
 *       status: 'approval-pending',
 *       approvalId: 'bc5f3f08-2378-4069-a0e5-17e3a1f6522a',
 *       command: 'wc -l /path/to/file',
 *       cwd: '/home/dabai/.openclaw/workspace/dev/config'
 *     },
 *     isError: false
 *   }
 * };
 * 
 * const unified = convertToolResultMessage(toolResultMessage, sessionKey);
 * // unified.messageType === 'tool'
 * // unified.tools === [{ name: 'exec', result: { status: 'approval-pending', ... } }]
 */
export function convertToolResultMessage(
  event: MessageEvent,
  sessionKey: string
): UnifiedMessage {
  const message = event.message;
  
  // 提取文本内容
  const textContent = extractTextContent(message.content);

  // 构造工具结果
  const tools: ToolCall[] = [{
    name: message.toolName!,
    input: {} as Record<string, unknown>, // toolResult 没有 input
    result: {
      status: message.details?.status || 'unknown',
      approvalId: message.details?.approvalId,
      output: textContent,
    },
    durationMs: message.details?.durationMs,
  }];

  // 构造 Approval 信息（仅在 approval-pending 状态时）
  const approvalInfo = message.details?.status === 'approval-pending' ? {
    id: message.details.approvalId,
    slug: message.details.approvalSlug,
    command: message.details.command,
    expiresAt: message.details.expiresAtMs ? new Date(message.details.expiresAtMs) : undefined,
  } : undefined;

  return {
    id: event.id,
    sessionKey,
    messageType: 'tool',
    timestamp: new Date(event.timestamp),
    source: 'file',
    content: textContent,
    tools,
    metadata: {
      eventId: event.id,
      parentId: event.parentId || undefined,
      toolCallId: message.toolCallId,
      isError: message.isError,
      // 执行详情
      status: message.details?.status,
      exitCode: message.details?.exitCode,
      durationMs: message.details?.durationMs,
      cwd: message.details?.cwd,
      aggregated: message.details?.aggregated,
      // Approval 信息
      approval: approvalInfo,
      // 消息时间戳
      messageTimestamp: message.timestamp,
    },
    raw: event,
  };
}

// ==================== 辅助函数 ====================

/**
 * 从消息内容数组中提取文本内容
 * 
 * @param content - 消息内容数组
 * @returns 合并后的文本内容（多个 text 项用换行符连接）
 * 
 * @example
 * const content = [
 *   { type: 'text', text: '第一段' },
 *   { type: 'thinking', thinking: '...' },
 *   { type: 'text', text: '第二段' }
 * ];
 * 
 * extractTextContent(content); // '第一段\n第二段'
 */
function extractTextContent(content: Message['content']): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

/**
 * 从消息内容数组中提取工具调用
 * 
 * @param content - 消息内容数组
 * @returns ToolCall 数组
 * 
 * @example
 * const content = [
 *   { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'ls' } },
 *   { type: 'toolCall', id: 'call_2', name: 'read_file', arguments: { path: '/tmp/file' } }
 * ];
 * 
 * const tools = extractToolCalls(content);
 * // [{ name: 'exec', input: { command: 'ls' } }, { name: 'read_file', input: { path: '/tmp/file' } }]
 */
function extractToolCalls(content: Message['content']): ToolCall[] {
  return content
    .filter((c): c is ToolCallContent => c.type === 'toolCall')
    .map(c => ({
      name: c.name,
      input: c.arguments,
      result: undefined, // toolCall 中没有 result
    }));
}

// ==================== 边界情况处理 ====================

/**
 * 验证转换结果
 * 
 * @param message - UnifiedMessage
 * @returns 是否有效
 * 
 * @example
 * const unified = convertUserMessage(event, sessionKey);
 * if (!validateUnifiedMessage(unified)) {
 *   console.error('Invalid message:', unified);
 * }
 */
export function validateUnifiedMessage(message: UnifiedMessage): boolean {
  // 检查必填字段
  if (!message.id || !message.sessionKey || !message.messageType || !message.timestamp || !message.source) {
    console.error('Missing required fields:', message);
    return false;
  }

  // 检查 messageType 是否合法
  if (!['user', 'agent', 'tool'].includes(message.messageType)) {
    console.error('Invalid messageType:', message.messageType);
    return false;
  }

  // 检查 source 是否合法
  if (!['websocket', 'file', 'http'].includes(message.source)) {
    console.error('Invalid source:', message.source);
    return false;
  }

  return true;
}

/**
 * 处理空内容的消息
 * 
 * @param event - MessageEvent
 * @returns 是否应该跳过此消息
 * 
 * @example
 * if (shouldSkipEmptyMessage(event)) {
 *   console.log('Skipping empty message');
 *   continue;
 * }
 */
export function shouldSkipEmptyMessage(event: MessageEvent): boolean {
  const message = event.message;
  
  // 如果 content 为空数组，跳过
  if (!message.content || message.content.length === 0) {
    return true;
  }

  // 如果没有任何 text 内容，且不是 toolResult，跳过
  const hasText = message.content.some(c => c.type === 'text');
  if (!hasText && message.role !== 'toolResult') {
    return true;
  }

  return false;
}
