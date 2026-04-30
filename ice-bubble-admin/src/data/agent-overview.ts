/**
 * ice-bubble Admin - Agent 概览聚合服务
 *
 * 职责：
 * - 调用 collector 原始 API 获取 sessions/messages 数据
 * - 在 admin 层赋予业务语义（running/idle/error 状态、当前任务、今日消息数）
 * - 不在 collector 层做业务聚合（collector 只负责基础数据采集）
 *
 * @module data/agent-overview
 */

import type { CollectorClient } from './collector-client.js';
import type { DataRepository } from '../storage/data-repository.js';

// ============================================================================
// OpenClaw 标准状态枚举（用于 API 返回）
// ============================================================================
export enum OpenClawStatus {
  active = 'active',
  idle = 'idle',
  offline = 'offline',
}

// ============================================================================
// Task 增强字段
// ============================================================================
export enum TaskEnhancementStatus {
  working = 'working',
  idle = 'idle',
  none = 'none',
}

export type TaskEnhancementSource = 'available' | 'unavailable' | 'none';

export interface TaskEnhancement {
  status: TaskEnhancementStatus;
  pending_count: number;
  source: TaskEnhancementSource;
}

/**
 * 标准化 Agent 状态
 * 将内部计算状态映射为 OpenClaw 标准枚举
 *
 * 映射规则：
 * - '工作' / '活跃' → 'active'（有活动）
 * - '休假'         → 'idle'（暂时离开）
 * - '离线' / '失联' → 'offline'（无活动或失联）
 *
 * @param calculatedStatus - calculateAgentStatus 的返回值
 */
export function normalizeAgentStatus(calculatedStatus: AgentStatus): OpenClawStatus {
  switch (calculatedStatus) {
    case '工作':
    case '活跃':
      return OpenClawStatus.active;
    case '休假':
      return OpenClawStatus.idle;
    case '离线':
    case '失联':
    default:
      return OpenClawStatus.offline;
  }
}

// ============================================================================
// 内部状态类型（原有逻辑保持不变）
// ============================================================================
export type AgentStatus = '失联' | '工作' | '活跃' | '休假' | '离线';

export interface AgentOverviewItem {
    agent_id: string;
    agent_name: string;
    workspace: string | null;
    status: AgentStatus;
    last_active_at: string;
    latest_message: string | null;
}

export interface AgentOverviewResult {
    agents: AgentOverviewItem[];
}

/**
 * 统一状态计算函数
 *
 * 规则：
 * - session 有更新（2 分钟内）→ 工作
 * - lastActiveAt < 2 分钟           → 工作（data-sync 延迟缓冲）
 * - lastActiveAt < 24 小时          → 活跃
 * - lastActiveAt < 72 小时          → 休假
 * - lastActiveAt >= 72 小时         → 离线
 * - lastActiveAt 为空               → 失联
 *
 * @param sessionsRecentCnt - 该 agent 在窗口期内的 session 数量（> 0 表示有实时活动）
 * @param lastActiveAt        - 该 agent 最后活跃时间
 * @param collectorFailed    - collector 是否离线（离线时不用 sessions 判断）
 */
export function calculateAgentStatus(
    sessionsRecentCnt: number,
    lastActiveAt: string | null,
    collectorFailed: boolean,
): AgentStatus {
    // 有实时 session 活动（collector 在线且窗口内有更新）
    if (!collectorFailed && sessionsRecentCnt > 0) {
        return '工作';
    }
    // 基于 lastActiveAt 判断
    if (!lastActiveAt) return '失联';
    const diff = Date.now() - new Date(lastActiveAt).getTime();
    const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
    if (diff < ACTIVE_THRESHOLD_MS) return '工作';
    if (diff < 24 * 3600 * 1000) return '活跃';
    if (diff < 72 * 3600 * 1000) return '休假';
    return '离线';
}

/**
 * Agent 概览聚合服务
 *
 * 数据来源：
 * - admin_agents 表：agent 基本信息（名称、工作空间）
 * - collector /api/data/sessions：实时 sessions 活跃度
 * - collector /api/data/messages：今日消息统计
 */
export class AgentOverviewService {
    private repository: DataRepository;
    private collector: CollectorClient;
    /** 活跃阈值（毫秒）：5 分钟内有 session 更新视为 running */
    constructor(repository: DataRepository, collector: CollectorClient) {
        this.repository = repository;
        this.collector = collector;
    }

    /**
     * 获取所有 Agent 的概览数据
     */
    async getAgentsOverview(): Promise<AgentOverviewResult> {
        // 1. 从 admin_agents 获取所有已注册 agent 的基本信息
        const adminAgents = this.repository.getAgents();

        // 2. 从 collector 获取近 2 分钟内有更新的 sessions（用于判断工作状态）
        const now = Date.now();
        const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
        const fiveMinAgo = new Date(now - ACTIVE_THRESHOLD_MS).toISOString();

        let recentSessions: Array<{ session_key: string; agent_id: string; updated_at: string }> = [];
        let collectorFailed = false;
        try {
            const sessionsResult = await this.collector.getSessions({
                since: fiveMinAgo,
                limit: 1000,
            });
            recentSessions = sessionsResult.sessions;
        } catch (err) {
            collectorFailed = true;
            console.error('[AgentOverview] collector sessions 获取失败，使用 last_active_at fallback:', err);
        }

        // 3. 构建 sessions by agent_id 索引
        const sessionsByAgent = new Map<string, Array<{ session_key: string; updated_at: string }>>();
        if (!collectorFailed) {
            for (const s of recentSessions) {
                if (!sessionsByAgent.has(s.agent_id)) {
                    sessionsByAgent.set(s.agent_id, []);
                }
                sessionsByAgent.get(s.agent_id)!.push({
                    session_key: s.session_key,
                    updated_at: s.updated_at,
                });
            }
        }

        // 4. 批量获取每个 agent 的最新输出消息
        const agentIds = adminAgents.map(a => a.agent_id);
        const latestMessages = this.repository.getLatestAgentMessages(agentIds);

        // 5. 组装每个 agent 的概览数据
        const agents: AgentOverviewItem[] = [];

        for (const adminAgent of adminAgents) {
            const agentId = adminAgent.agent_id;
            const sessionsRecentCnt = (sessionsByAgent.get(agentId) ?? []).length;

            // 统一状态计算
            const status = calculateAgentStatus(
                sessionsRecentCnt,
                adminAgent.last_active_at,
                collectorFailed,
            );

            agents.push({
                agent_id: agentId,
                agent_name: adminAgent.agent_name ?? agentId,
                workspace: adminAgent.workspace ?? null,
                status,
                last_active_at: adminAgent.last_active_at ?? new Date(0).toISOString(),
                latest_message: latestMessages.get(agentId) ?? null,
            });
        }

        return { agents };
    }
}
