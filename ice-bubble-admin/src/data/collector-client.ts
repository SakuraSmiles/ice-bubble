/**
 * ice-bubble Admin - Collector HTTP 客户端
 *
 * 通过 HTTP API 从 collector 获取数据（不直接访问 collector 的 SQLite）
 *
 * @module data/collector-client
 */

export interface CollectorClientConfig {
    /** collector HTTP API 基础地址 */
    baseUrl: string;
}

export interface CollectorSession {
    session_key: string;
    agent_id: string;
    channel: string;
    account_id: string | null;
    peer_id: string | null;
    guild_id: string | null;
    created_at: string | null;
    updated_at: string;
    message_count: number;
    last_message_at: string | null;
    label?: string | null;
    status?: string | null;
    model?: string | null;
    model_provider?: string | null;
    spawned_by?: string | null;
    spawn_depth?: number | null;
}

export interface CollectorMessage {
    id: number | null;
    message_id: string | null;
    session_key: string;
    message_type: string;
    content: string | null;
    model: string | null;
    tokens_input: number | null;
    tokens_output: number | null;
    cost_total: number | null;
    cost_input: number | null;
    cost_output: number | null;
    tools_json: string | null;
    timestamp: string;
    created_at: string | null;
}

export interface CollectorStats {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    lastUpdated: string | null;
}

export interface GetSessionsResponse {
    count: number;
    max_time_updated?: number;
    sessions: CollectorSession[];
}

export interface GetMessagesResponse {
    count: number;
    max_time_updated?: number;
    max_id?: number | null;      // ID 游标（null = Collector 不支持 after_id）
    messages: CollectorMessage[];
}

export interface CollectorAgent {
    agent_id: string;
    agent_name: string;
    workspace?: string | null;
    source?: string | null;
    config_json: string;
    status: string;
    last_seen_at: string;
    created_at: string;
    updated_at: string;
}

export interface CollectorEvent {
    id: number;
    session_key: string;
    event_type: string;
    event_id: string | null;
    data_json: string;
    timestamp: string;
    created_at: string;
}

export interface GetEventsResponse {
    count: number;
    events: CollectorEvent[];
}

export interface GetAgentsResponse {
    count: number;
    agents: CollectorAgent[];
}

/**
 * Collector HTTP 客户端
 *
 * 通过 REST API 与 collector 通信，获取 sessions、messages、stats 数据
 */
export class CollectorClient {
    private baseUrl: string;

    constructor(config: CollectorClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, ''); // 去除末尾斜杠
    }

    /**
     * 获取 sessions 列表
     *
     * @param params.limit - 每页数量 (default 100, max 1000)
     * @param params.offset - 偏移量 (default 0)
     * @param params.since - ISO 时间戳，仅返回该时间之后更新的记录
     */
    async getSessions(params?: {
        limit?: number;
        offset?: number;
        since?: string;
    }): Promise<GetSessionsResponse> {
        const searchParams = new URLSearchParams();
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
        if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
        if (params?.since) searchParams.set('since', params.since);

        const url = `${this.baseUrl}/api/data/sessions${searchParams.toString() ? '?' + searchParams.toString() : ''}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!response.ok) {
            throw new Error(`Failed to get sessions: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<GetSessionsResponse>;
    }

    /**
     * 获取 messages 列表
     *
     * @param params.session_key - 可选，session 标识（不填则返回所有消息）
     * @param params.limit - 每页数量 (default 100, max 1000)
     * @param params.offset - 偏移量 (default 0) — 仅在 since 模式生效
     * @param params.since - ISO 时间戳，仅返回该时间之后的消息
     * @param params.after_id - ID 游标（优先于 since/offset），仅返回 id > after_id 的消息
     */
    async getMessages(params: {
        session_key?: string;
        limit?: number;
        offset?: number;
        since?: string;
        after_id?: number;
    }): Promise<GetMessagesResponse> {
        const searchParams = new URLSearchParams();
        if (params.session_key) searchParams.set('session_key', params.session_key);
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
        if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
        if (params?.since) searchParams.set('since', params.since);
        if (params?.after_id !== undefined && params.after_id > 0) searchParams.set('after_id', String(params.after_id));

        const url = `${this.baseUrl}/api/data/messages?${searchParams.toString()}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!response.ok) {
            throw new Error(`Failed to get messages: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<GetMessagesResponse>;
    }

    /**
     * 获取 agents 列表
     */
    async getAgents(): Promise<CollectorAgent[]> {
        const url = `${this.baseUrl}/api/data/agents`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!response.ok) {
            throw new Error(`Failed to get agents: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as GetAgentsResponse;
        return data.agents;
    }

    /**
     * 获取 session events 列表
     *
     * @param params.event_type - 可选，事件类型过滤
     * @param params.limit - 每页数量 (default 100, max 1000)
     * @param params.offset - 偏移量 (default 0)
     * @param params.since - ISO 时间戳，仅返回该时间之后的事件
     */
    async getEvents(params?: {
        event_type?: string;
        limit?: number;
        offset?: number;
        since?: string;
    }): Promise<GetEventsResponse> {
        const searchParams = new URLSearchParams();
        if (params?.event_type) searchParams.set('event_type', params.event_type);
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
        if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
        if (params?.since) searchParams.set('since', params.since);

        const url = `${this.baseUrl}/api/data/events?${searchParams.toString()}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!response.ok) {
            throw new Error(`Failed to get events: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<GetEventsResponse>;
    }

    /**
     * 获取 collector 数据统计
     */
    async getStats(): Promise<CollectorStats> {
        const url = `${this.baseUrl}/api/data/stats`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!response.ok) {
            throw new Error(`Failed to get stats: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<CollectorStats>;
    }

}
