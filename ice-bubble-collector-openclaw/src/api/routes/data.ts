/**
 * Data 路由 - collector 数据查询接口
 *
 * 供 admin 模块通过 HTTP API 获取 collector 的数据
 *
 * GET /api/data/sessions - 获取 sessions 列表
 * GET /api/data/messages - 获取 messages 列表
 * GET /api/data/stats    - 获取数据统计
 *
 * @module api/routes/data
 */

import { Router, type Request, type Response } from 'express';
import { Logger } from '../../utils/logger.js';
import type { FileCollector } from '../../collectors/FileCollector.js';
import type { Session, SessionMessage } from '../../types/index.js';

const dataLogger = new Logger('DataRoute');

/**
 * 创建 data 路由
 *
 * @param collector - FileCollector 实例（用于访问 SQLite 数据）
 */
export function createDataRouter(collector: FileCollector): Router {
    const router = Router();

    /**
     * GET /api/data/sessions
     *
     * Query params:
     *   - limit: number (default 100, max 1000)
     *   - offset: number (default 0)
     *   - since: ISO timestamp string (optional, for future incremental query)
     *
     * Response:
     *   { count: number, sessions: Session[] }
     */
    router.get('/sessions', async (req: Request, res: Response) => {
        try {
            const limit = Math.min(parseInt(String(req.query.limit ?? '100')), 1000);
            const offset = parseInt(String(req.query.offset ?? '0'));
            const since = req.query.since ? String(req.query.since) : undefined;

            const result = await collector.getSessions({ limit, offset, since });

            // 转换 Date 为 ISO 字符串以便 JSON 序列化
            const sessions = result.sessions.map(sessionToJson);

            res.json({
                count: result.count,
                sessions,
            });
            dataLogger.debug(`返回 ${result.count} 条 sessions`);
        } catch (error) {
            dataLogger.error('获取 sessions 失败', error as Error);
            res.status(500).json({
                error: '获取 sessions 失败',
                code: 'SESSIONS_FETCH_FAILED',
            });
        }
    });

    /**
     * GET /api/data/messages
     *
     * Query params:
     *   - session_key: string (optional, filter by session)
     *   - limit: number (default 100, max 1000)
     *   - offset: number (default 0)
     *   - since: ISO timestamp string (optional)
     *
     * Response:
     *   { count: number, messages: SessionMessage[] }
     */
    router.get('/messages', async (req: Request, res: Response) => {
        try {
            const sessionKey = req.query.session_key ? String(req.query.session_key) : undefined;
            const limit = Math.min(parseInt(String(req.query.limit ?? '100')), 1000);
            const offset = parseInt(String(req.query.offset ?? '0'));
            const since = req.query.since ? String(req.query.since) : undefined;

            const result = await collector.getMessages({ sessionKey, limit, offset, since });

            // 转换 Date 为 ISO 字符串以便 JSON 序列化
            const messages = result.messages.map(messageToJson);

            res.json({
                count: result.count,
                messages,
            });
            const sessionLog = sessionKey ? ` (session: ${sessionKey})` : ' (all sessions)';
            dataLogger.debug(`返回 ${result.count} 条 messages${sessionLog}`);
        } catch (error) {
            dataLogger.error('获取 messages 失败', error as Error);
            res.status(500).json({
                error: '获取 messages 失败',
                code: 'MESSAGES_FETCH_FAILED',
            });
        }
    });

    /**
     * GET /api/data/stats
     *
     * Response:
     *   { sessionCount, messageCount, agentCount, lastUpdated }
     */
    router.get('/stats', async (_req: Request, res: Response) => {
        try {
            const stats = await collector.getDataStats();
            res.json(stats);
            dataLogger.debug('返回数据统计', stats);
        } catch (error) {
            dataLogger.error('获取统计失败', error as Error);
            res.status(500).json({
                error: '获取统计失败',
                code: 'STATS_FETCH_FAILED',
            });
        }
    });

    return router;
}

/**
 * Session 对象转换为 JSON 友好格式
 */
function sessionToJson(s: Session): Record<string, unknown> {
    return {
        session_key: s.sessionKey,
        agent_id: s.agentId,
        channel: s.channel,
        account_id: s.accountId ?? null,
        peer_id: s.peerId ?? null,
        guild_id: s.guildId ?? null,
        created_at: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
        updated_at: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
        message_count: s.messageCount,
        last_message_at: s.lastMessageAt
            ? (s.lastMessageAt instanceof Date ? s.lastMessageAt.toISOString() : s.lastMessageAt)
            : null,
    };
}

/**
 * SessionMessage 对象转换为 JSON 友好格式
 */
function messageToJson(m: SessionMessage): Record<string, unknown> {
    return {
        id: m.id ?? null,
        session_key: m.sessionKey,
        message_type: m.messageType,
        content: m.content ?? null,
        model: m.model ?? null,
        tokens_input: m.tokensInput ?? null,
        tokens_output: m.tokensOutput ?? null,
        tools_json: m.toolsJson ?? null,
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
        created_at: m.createdAt
            ? (m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt)
            : null,
    };
}
