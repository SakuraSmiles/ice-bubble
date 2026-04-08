/**
 * OpenClaw Collector - Type Definitions
 */

// ==================== OpenClaw 原始类型 ====================
export * from './openclaw';

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

// ==================== 统一数据格式 ====================

/**
 * 统一消息格式 - 所有采集器的输出格式
 * 
 * 这是处理层的标准输入格式，所有采集器必须输出此格式
 * 
 * @example
 * const message: UnifiedMessage = {
 *   id: 'agent:agent-001:discord:acc-123:direct:peer-456:2026-04-08T10:00:00Z:user:a1b2c3',
 *   sessionKey: 'agent:agent-001:discord:acc-123:direct:peer-456',
 *   messageType: 'user',
 *   timestamp: new Date('2026-04-08T10:00:00Z'),
 *   source: 'websocket',
 *   content: '帮我分析错误',
 *   metadata: { userId: 'user-789' }
 * };
 */
export interface UnifiedMessage {
    // ==================== 必填字段 ====================
    
    /**
     * 消息唯一标识（用于去重）
     * 格式: {sessionKey}:{timestamp}:{messageType}:{hash}
     */
    id: string;
    
    /**
     * Session Key
     * 格式: agent:{agentId}:{channel}:{accountId}:{type}:{targetId}
     */
    sessionKey: string;
    
    /**
     * 消息类型
     * - user: 用户消息
     * - agent: AI 回复
     * - tool: 工具调用
     */
    messageType: 'user' | 'agent' | 'tool';
    
    /**
     * 消息时间戳
     */
    timestamp: Date;
    
    /**
     * 数据来源
     * - websocket: WebSocket 实时推送
     * - file: 文件系统读取
     * - http: HTTP API 查询
     */
    source: 'websocket' | 'file' | 'http';
    
    // ==================== 可选字段 ====================
    
    /**
     * 消息内容（文本）
     */
    content?: string;
    
    /**
     * AI 模型（仅 agent 类型）
     * @example 'claude-3-5-sonnet'
     */
    model?: string;
    
    /**
     * Token 统计（仅 agent 类型）
     */
    tokens?: {
        input: number;
        output: number;
    };
    
    /**
     * 工具调用列表（仅 agent 和 tool 类型）
     */
    tools?: ToolCall[];
    
    /**
     * 原始数据（用于调试和扩展）
     * 保存采集器获取的原始 JSON 对象
     */
    raw?: unknown;
    
    /**
     * 元数据
     * 包含额外的上下文信息，如 userId、agentId 等
     */
    metadata?: {
        userId?: string;
        agentId?: string;
        channel?: string;
        eventId?: string;
        [key: string]: unknown;
    };
}

// ==================== 采集器接口 ====================

/**
 * 采集器接口 - 所有采集器必须实现
 * 
 * @example
 * class WebSocketCollector implements Collector {
 *   start(): EventEmitter {
 *     const emitter = new EventEmitter();
 *     // ... 获取数据并转换
 *     emitter.emit('message', unifiedMessage);
 *     return emitter;
 *   }
 *   
 *   stop(): void {
 *     // 清理资源
 *   }
 * }
 */
export interface Collector {
    /**
     * 启动采集器
     * @returns EventEmitter - 触发 'message' 事件，传递 UnifiedMessage
     */
    start(): NodeJS.EventEmitter;
    
    /**
     * 停止采集器
     */
    stop(): void;
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

// ==================== SQLite 配置 ====================
export interface SQLiteManagerConfig {
    /**
     * 数据库文件路径
     * @example './data/collector.db'
     */
    dbPath: string;

    /**
     * 是否启用 WAL 模式
     * @default true
     */
    walMode?: boolean;

    /**
     * 是否启用外键约束
     * @default true
     */
    foreignKeys?: boolean;

    /**
     * 自动清理配置
     */
    autoClean?: {
        enabled: boolean;
        daysToKeep: number; // 保留天数
        schedule: string; // cron 表达式
    };
}
