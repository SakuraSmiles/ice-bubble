/**
 * OpenClaw 原始数据类型定义
 * 
 * 基于真实数据反向分析，参考文档：OpenClaw-Session数据格式参考.md
 */

// ==================== 基础事件类型 ====================

/**
 * 基础事件
 */
export interface BaseEvent {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;  // ISO 8601
}

/**
 * 事件类型枚举
 */
export type EventType = 
  | 'session'
  | 'model_change'
  | 'thinking_level_change'
  | 'custom'
  | 'message';

/**
 * OpenClaw 事件（联合类型）
 */
export type OpenClawEvent = 
  | SessionEvent
  | ModelChangeEvent
  | ThinkingLevelChangeEvent
  | CustomEvent
  | MessageEvent;

// ==================== 具体事件类型 ====================

/**
 * Session 元数据事件
 */
export interface SessionEvent extends BaseEvent {
  type: 'session';
  version: number;
  cwd: string;
}

/**
 * 模型变更事件
 */
export interface ModelChangeEvent extends BaseEvent {
  type: 'model_change';
  provider: string;
  modelId: string;
}

/**
 * Thinking 级别变更事件
 */
export interface ThinkingLevelChangeEvent extends BaseEvent {
  type: 'thinking_level_change';
  thinkingLevel: 'low' | 'medium' | 'high';
}

/**
 * 自定义事件
 */
export interface CustomEvent extends BaseEvent {
  type: 'custom';
  customType: string;
  data: Record<string, unknown>;
}

/**
 * 消息事件
 */
export interface MessageEvent extends BaseEvent {
  type: 'message';
  message: Message;
}

// ==================== 消息类型 ====================

/**
 * 消息
 */
export interface Message {
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContentItem[];
  timestamp: number;  // Unix timestamp (ms)
  
  // AI 回复特有字段
  api?: 'anthropic-messages' | 'ollama';
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  stopReason?: 'toolUse' | 'stop' | 'end_turn';
  responseId?: string;
  
  // 工具结果特有字段
  toolCallId?: string;
  toolName?: string;
  details?: ToolResultDetails;
  isError?: boolean;
}

/**
 * 消息角色枚举
 */
export type MessageRole = 
  | 'user'
  | 'assistant'
  | 'toolResult';

// ==================== 消息内容类型 ====================

/**
 * 消息内容项（联合类型）
 */
export type MessageContentItem = 
  | TextContent
  | ThinkingContent
  | ToolCallContent;

/**
 * 文本内容
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Thinking 内容
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature: string;
}

/**
 * 工具调用内容
 */
export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ==================== Token 使用统计 ====================

/**
 * Token 使用统计
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ==================== ToolResult Details ====================

/**
 * ToolResult Details
 */
export interface ToolResultDetails {
  status: 'completed' | 'approval-pending' | 'error';
  exitCode?: number;
  durationMs?: number;
  aggregated?: string;
  cwd?: string;
  
  // Approval 相关字段
  approvalId?: string;
  approvalSlug?: string;
  expiresAtMs?: number;
  host?: string;
  command?: string;
  warningText?: string;
}

// ==================== 类型守卫 ====================

/**
 * 判断是否为 MessageEvent
 */
export function isMessageEvent(event: OpenClawEvent): event is MessageEvent {
  return event.type === 'message';
}

/**
 * 判断是否为 SessionEvent
 */
export function isSessionEvent(event: OpenClawEvent): event is SessionEvent {
  return event.type === 'session';
}

/**
 * 判断是否为 ModelChangeEvent
 */
export function isModelChangeEvent(event: OpenClawEvent): event is ModelChangeEvent {
  return event.type === 'model_change';
}

/**
 * 判断是否为 User 消息
 */
export function isUserMessage(message: Message): boolean {
  return message.role === 'user';
}

/**
 * 判断是否为 Assistant 消息
 */
export function isAssistantMessage(message: Message): boolean {
  return message.role === 'assistant';
}

/**
 * 判断是否为 ToolResult 消息
 */
export function isToolResultMessage(message: Message): boolean {
  return message.role === 'toolResult';
}
