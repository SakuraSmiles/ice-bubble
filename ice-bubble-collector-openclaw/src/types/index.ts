/**
 * OpenClaw Collector - Type Definitions
 */

// ==================== 采集模式 ====================
export enum CollectionMode {
    WEBSOCKET_ONLY = 'WEBSOCKET_ONLY',
    FILE_ONLY = 'FILE_ONLY',
    HTTP_ONLY = 'HTTP_ONLY',
    HYBRID_PRIORITY = 'HYBRID_PRIORITY',
    HYBRID_REDUNDANT = 'HYBRID_REDUNDANT',
}

// ==================== Session 相关 ====================
export interface Session {
    sessionKey: string;
    agentId: string;
    channel: string;
    accountId?: string;
    peerId?: string;
    guildId?: string;
    createdAt: Date;
    updatedAt: Date;
    messageCount: number;
    lastMessageAt?: Date;
}

export interface SessionMessage {
    id?: number;
    sessionKey: string;
    messageType: 'user' | 'agent' | 'tool';
    content?: string;
    model?: string;
    tokensInput?: number;
    tokensOutput?: number;
    toolsJson?: string;
    timestamp: Date;
    createdAt?: Date;
}

// ==================== Agent 相关 ====================
export interface Agent {
    agentId: string;
    agentName?: string;
    configJson?: string;
    status: 'online' | 'offline' | 'busy';
    lastSeenAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

// ==================== Tool 相关 ====================
export interface Tool {
    toolName: string;
    description?: string;
    callCount: number;
    avgDurationMs?: number;
    lastCalledAt?: Date;
}

export interface ToolCall {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
}

// ==================== 采集日志 ====================
export interface CollectionLog {
    id?: number;
    collectorType: 'websocket' | 'file' | 'http';
    eventType?: string;
    sessionKey?: string;
    status: 'success' | 'failed' | 'pending';
    errorMessage?: string;
    durationMs?: number;
    createdAt: Date;
}

// ==================== WebSocket 事件 ====================
export interface WSEvent {
    type: string;
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    payload?: unknown;
}

export interface WSMessage {
    type: 'req' | 'res' | 'event';
    id: string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { code: number; message: string };
}

// ==================== 配置 ====================
export interface CollectorConfig {
    mode: CollectionMode;
    websocket: WebSocketConfig;
    file: FileConfig;
    http: HTTPConfig;
}

export interface WebSocketConfig {
    enabled: boolean;
    priority: number;
    url: string;
    token: string;
    reconnect: {
        enabled: boolean;
        interval: number;
        maxRetries: number;
    };
    subscriptions: Array<{
        method: string;
        params: Record<string, unknown>;
    }>;
}

export interface FileConfig {
    enabled: boolean;
    priority: number;
    basePath: string;
    watchInterval: number;
    checkInterval: number;
    incremental: boolean;
}

export interface HTTPConfig {
    enabled: boolean;
    priority: number;
    baseUrl: string;
    token: string;
    fullSync: string; // cron expression
    incrementalQuery: boolean;
}
