import type { MessageRole, DataSource } from './common.js';

/** 工具调用 */
export interface ToolCall {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
}

/** Token 统计 */
export interface TokenUsage {
    input: number;
    output: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: TokenCost;
}

export interface TokenCost {
    total?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/**
 * 统一消息格式 — 所有 Collector 的标准输出
 *
 * 这是处理层的标准输入，每个 Collector 必须将各自的数据源
 * 转换为此格式。
 *
 * @example
 * const msg: UnifiedMessage = {
 *   id: 'agent:agent-001:discord:direct:peer-456:2026-04-08T10:00:00Z:user:a1b2c3',
 *   sessionKey: 'agent:agent-001:discord:direct:peer-456',
 *   messageType: 'user',
 *   timestamp: new Date('2026-04-08T10:00:00Z'),
 *   source: 'websocket',
 *   content: '帮我分析错误',
 *   metadata: { userId: 'user-789' }
 * };
 */
export interface UnifiedMessage {
    /** 消息唯一标识，格式: {sessionKey}:{timestamp}:{messageType}:{hash} */
    id: string;

    /** Session Key, 格式: agent:{agentId}:{channel}:{accountId}:{type}:{targetId} */
    sessionKey: string;

    /** 消息类型 */
    messageType: MessageRole;

    /** 消息时间戳 */
    timestamp: Date;

    /** 数据来源 */
    source: DataSource;

    /** 消息文本内容 */
    content?: string;

    /** AI 模型标识，仅 agent 类型消息 */
    model?: string;

    /** Token 使用统计 + 费用，仅 agent 类型消息 */
    tokens?: TokenUsage;

    /** 工具调用列表，仅 agent / tool 类型消息 */
    tools?: ToolCall[];

    /** 原始数据（调试用） */
    raw?: unknown;

    /**
     * 扩展元数据
     * 常用字段：userId, agentId, channel, eventId
     */
    metadata?: Record<string, unknown>;
}
