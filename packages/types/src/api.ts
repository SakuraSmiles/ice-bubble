import type { SessionDTO } from './session.js';
import type { AgentDTO } from './agent.js';
import type { SessionEvent } from './session.js';
import type { CollectorStats } from './collector.js';

// ========== Sessions API ==========

export interface GetSessionsResponse {
    count: number;
    maxTimeUpdated?: number;
    sessions: SessionDTO[];
}

// ========== Messages API ==========

/**
 * Collector 端消息 API 响应格式
 *
 * 注意：这是 HTTP API 的 wire format，字段使用 snake_case
 * （对应 collector 端 SQLite 列名）。不应与 UnifiedMessage 混淆。
 */
export interface MessageItemDTO {
    id: number | null;
    sessionKey: string;
    messageType: string;
    content: string | null;
    model: string | null;
    tokensInput: number | null;
    tokensOutput: number | null;
    costTotal: number | null;
    costInput: number | null;
    costOutput: number | null;
    toolsJson: string | null;
    timestamp: string;
    createdAt: string | null;
}

export interface GetMessagesResponse {
    count: number;
    maxTimeUpdated?: number;
    messages: MessageItemDTO[];
}

// ========== Agents API ==========

export interface GetAgentsResponse {
    count: number;
    agents: AgentDTO[];
}

// ========== Events API ==========

export interface GetEventsResponse {
    count: number;
    events: SessionEvent[];
}

// ========== Stats API ==========

export type GetStatsResponse = CollectorStats;
