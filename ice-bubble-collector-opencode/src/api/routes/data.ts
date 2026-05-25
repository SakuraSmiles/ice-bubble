/**
 * Data 路由 - OpenCode 数据查询接口
 *
 * 响应格式与 collector-openclaw 对齐，让 Admin CollectorClient 无需区分。
 *
 * GET /api/data/sessions  → OpenCode sessions 列表
 * GET /api/data/messages  → OpenCode messages 列表
 * GET /api/data/stats     → 数据统计
 * GET /api/data/agents    → Agent 列表
 * GET /api/data/events    → 空实现（OpenCode 无 events 概念）
 *
 * @module api/routes/data
 */

import { Router, type Request, type Response } from 'express';
import { Logger } from '../../utils/logger.js';
import { convertSession, convertMessages, type ConvertedSession } from '../../converters/opencode-to-unified.js';
import type { SQLiteCollector } from '../../collectors/sqlite-collector.js';
import type { UnifiedMessage } from '../../types/index.js';

const dataLogger = new Logger('DataRoute');

export function createDataRouter(collector: SQLiteCollector): Router {
    const router = Router();

    // ==================== Sessions ====================

    router.get('/sessions', (_req: Request, res: Response) => {
        try {
            const rawSessions = collector.getSessions();
            const sessions = rawSessions.map((s) => convertSession(s));

            // 转换为 CollectorClient 期望的格式
            const result = {
                count: sessions.length,
                max_time_updated: collector.getMaxSessionUpdated(),
                sessions: sessions.map(sessionToApiFormat),
            };

            res.json(result);
            dataLogger.debug(`返回 ${result.count} 条 sessions`);
        } catch (error) {
            dataLogger.error('获取 sessions 失败', error as Error);
            res.status(500).json({
                error: '获取 sessions 失败',
                code: 'SESSIONS_FETCH_FAILED',
            });
        }
    });

    // ==================== Messages ====================

    router.get('/messages', (req: Request, res: Response) => {
        try {
            const sessionKey = req.query.session_key ? String(req.query.session_key) : undefined;
            const sinceParam = req.query.since ? String(req.query.since) : undefined;
            const limit = Math.min(parseInt(String(req.query.limit ?? '1000')), 1000);

            let unifiedMessages: UnifiedMessage[];

            if (sessionKey) {
                // 按查询特定 session
                const raw = collector.getSessionMessages(sessionKey);
                unifiedMessages = convertMessages(raw);
            } else if (sinceParam) {
                // 增量查询
                const sinceTimestamp = parseSince(sinceParam);
                const raw = collector.getMessages(sinceTimestamp);
                unifiedMessages = convertMessages(raw);
            } else {
                // 全量：获取所有 session 的 messages
                // NOTE: O(N) 加载所有 session messages 再 slice，数据量尚可（~8K 条）
                const sessions = collector.getSessions();
                const all: UnifiedMessage[] = [];
                for (const s of sessions) {
                    const raw = collector.getSessionMessages(s.id);
                    all.push(...convertMessages(raw));
                }
                unifiedMessages = all;
            }

            // 按时间排序
            unifiedMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

            // 应用 offset + limit 分页
            const offsetNum = parseInt(String(req.query.offset ?? '0')) || 0;
            const limited = unifiedMessages.slice(offsetNum, offsetNum + limit);

            const result = {
                count: limited.length,
                max_time_updated: collector.getMaxTimeUpdated(),
                messages: limited.map(messageToApiFormat),
            };

            res.json(result);
            dataLogger.debug(`返回 ${result.count} 条 messages`);
        } catch (error) {
            dataLogger.error('获取 messages 失败', error as Error);
            res.status(500).json({
                error: '获取 messages 失败',
                code: 'MESSAGES_FETCH_FAILED',
            });
        }
    });

    // ==================== Stats ====================

    router.get('/stats', (_req: Request, res: Response) => {
        try {
            const stats = collector.getStats();
            const agents = collector.getAgents();

            res.json({
                sessionCount: stats.sessionCount,
                messageCount: stats.messageCount,
                agentCount: agents.length,
                lastUpdated: stats.lastPollAt,
            });
            dataLogger.debug('返回数据统计');
        } catch (error) {
            dataLogger.error('获取统计失败', error as Error);
            res.status(500).json({
                error: '获取统计失败',
                code: 'STATS_FETCH_FAILED',
            });
        }
    });

    // ==================== Agents ====================

    router.get('/agents', (_req: Request, res: Response) => {
        try {
            const agents = collector.getAgents();
            const now = new Date().toISOString();

            const result = {
                count: agents.length,
                agents: agents.map((a) => ({
                    agent_id: a.agent ? ('opencode:' + a.agent) : 'opencode:unknown',
                    agent_name: a.agent || 'unknown',
                    workspace: null,
                    source: 'opencode',
                    config_json: '{}',
                    status: 'active',
                    last_seen_at: now,
                    created_at: now,
                    updated_at: now,
                })),
            };

            res.json(result);
            dataLogger.debug(`返回 ${result.count} 条 agents`);
        } catch (error) {
            dataLogger.error('获取 agents 失败', error as Error);
            res.status(500).json({
                error: '获取 agents 失败',
                code: 'AGENTS_FETCH_FAILED',
            });
        }
    });

    // ==================== Events (空实现) ====================

    router.get('/events', (_req: Request, res: Response) => {
        // OpenCode 无 events 概念，返回空列表
        res.json({ count: 0, events: [] });
    });

    return router;
}

// ==================== 格式转换 ====================

/**
 * ConvertedSession → CollectorSession 格式
 */
function sessionToApiFormat(s: ConvertedSession): Record<string, unknown> {
    return {
        session_key: s.sessionKey,
        agent_id: s.agent ? ('opencode:' + s.agent) : ('opencode:model:' + (s.model || 'unknown')),
        channel: 'opencode',
        account_id: null,
        peer_id: null,
        guild_id: null,
        created_at: s.createdAt.toISOString(),
        updated_at: s.updatedAt.toISOString(),
        message_count: 0,
        last_message_at: null,
        label: s.title ?? null,
        status: s.timeArchived ? 'archived' : 'active',
        model: s.model ?? null,
        model_provider: null,
        spawned_by: null,
        spawn_depth: null,
    };
}

/**
 * UnifiedMessage → CollectorMessage 格式
 */
function messageToApiFormat(m: UnifiedMessage): Record<string, unknown> {
    const toolsJson = m.tools ? JSON.stringify(m.tools) : null;

    return {
        id: m.id,
        session_key: m.sessionKey,
        message_type: m.messageType,
        content: m.content ?? null,
        model: m.model ?? null,
        tokens_input: m.tokens?.input ?? null,
        tokens_output: m.tokens?.output ?? null,
        cost_total: m.tokens?.cost?.total ?? null,
        cost_input: m.tokens?.cost?.input ?? null,
        cost_output: m.tokens?.cost?.output ?? null,
        tools_json: toolsJson,
        timestamp: m.timestamp.toISOString(),
        created_at: null,
    };
}

/**
 * 解析 since 参数
 * 支持 ISO 字符串或毫秒时间戳
 */
function parseSince(since: string): number {
    const num = Number(since);
    if (!isNaN(num) && num > 0) {
        return num < 1e12 ? num * 1000 : num;
    }
    const ms = new Date(since).getTime();
    return isNaN(ms) ? 0 : ms;
}
