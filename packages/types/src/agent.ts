/**
 * Agent 数据传输对象
 *
 * Collector 对外暴露的 Agent 视图。
 */
export interface AgentDTO {
    agentId: string;
    agentName: string | null;
    workspace?: string | null;
    source?: string | null;
    configJson: string;
    status: string;
    lastSeenAt: string;
    createdAt: string;
    updatedAt: string;
}
