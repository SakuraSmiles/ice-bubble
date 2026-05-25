/**
 * OpenCode 原始类型 + UnifiedMessage 目标类型
 */

export type { OpenCodeProject, OpenCodeSession, OpenCodeMessage, OpenCodePart } from './opencode.js';
export type {
    MessageData,
    UserMessageData,
    AssistantMessageData,
    TokenInfo,
    PartData,
    TextPartData,
    ToolPartData,
    ToolState,
    ReasoningPartData,
    StepStartPartData,
    StepFinishPartData,
    CompactionPartData,
    PatchPartData,
    SessionWithProject,
    MessageWithParts,
} from './opencode.js';

// ==================== UnifiedMessage 目标类型 ====================
// 核心接口定义，与 collector-openclaw 保持一致

export interface ToolCall {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
}

export interface UnifiedMessage {
    /** 消息唯一标识（用于去重），格式: {sessionKey}:{timestamp}:{messageType}:{hash} */
    id: string;
    /** Session Key */
    sessionKey: string;
    /** 消息类型 */
    messageType: 'user' | 'agent' | 'tool';
    /** 消息时间戳 */
    timestamp: Date;
    /** 数据来源 */
    source: 'websocket' | 'file' | 'http' | 'sqlite';
    /** 消息内容 */
    content?: string;
    /** AI 模型 */
    model?: string;
    /** Token 统计 */
    tokens?: {
        input: number;
        output: number;
        totalTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: {
            total?: number;
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
        };
    };
    /** 工具调用列表 */
    tools?: ToolCall[];
    /** 原始数据 */
    raw?: unknown;
    /** 元数据 */
    metadata?: Record<string, unknown>;
}
