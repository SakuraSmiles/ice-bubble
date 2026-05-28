/**
 * Session 数据传输对象
 *
 * Collector 对外暴露的 Session 视图，是 HTTP API 的响应类型。
 */
export interface SessionDTO {
    sessionKey: string;
    agentId: string;
    channel: string;
    accountId?: string | null;
    peerId?: string | null;
    guildId?: string | null;
    createdAt: string | null;
    updatedAt: string;
    messageCount: number;
    lastMessageAt: string | null;
    label?: string | null;
    status?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    spawnedBy?: string | null;
    spawnDepth?: number | null;
}

/**
 * Session 事件
 */
export interface SessionEvent {
    id?: number;
    sessionKey: string;
    eventType: string;
    eventId?: string | null;
    dataJson: string;
    timestamp: string;
    createdAt?: string;
}
