/**
 * Session 列表端点 — GET /sessions + GET /sessions/grouped
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';

export function createListRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const router = Router();

  /**
   * GET /api/sessions
   * 获取 sessions 列表
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const channel = req.query.channel ? String(req.query.channel) : undefined;
    const platform = req.query.platform ? String(req.query.platform) : undefined;

    const result = repository.getSessions({ limit, offset, agent_id, channel, platform });

    // Build agent name lookup map
    const agents = repository.getAgents();
    const agentMap = new Map(agents.map(a => [a.agent_id, a]));

    // Enrich sessions with agent_name, avatar and last_message
    const sessionKeys = result.sessions.map(s => s.session_key);
    const lastMessageMap = new Map<string, string>();
    if (sessionKeys.length > 0) {
      // Direct DB access for batch last_message query
      try {
        const db = repository.getDb();
        if (db) {
          const rows = db.prepare(`
            SELECT m.session_key, substr(m.content, 1, 60) as content
            FROM admin_messages m
            INNER JOIN (
              SELECT session_key, MAX(timestamp) as max_ts
              FROM admin_messages
              WHERE session_key IN (${sessionKeys.map(() => '?').join(',')})
              GROUP BY session_key
            ) latest ON m.session_key = latest.session_key AND m.timestamp = latest.max_ts
          `).all(...sessionKeys) as { session_key: string; content: string }[];
          for (const row of rows) {
            lastMessageMap.set(row.session_key, row.content);
          }
        }
      } catch (e) {
        // Non-critical: last_message enrichment can fail silently
      }
    }

    const sessions = result.sessions.map(s => {
      const agent = agentMap.get(s.agent_id ?? '');
      return {
        ...s,
        agent_name: agent?.agent_name ?? null,
        avatar: agent?.avatar ?? null,
        last_message: lastMessageMap.get(s.session_key) ?? null,
      };
    });

    res.json({
      count: sessions.length,
      total: result.total,
      limit,
      offset,
      sessions,
    });
  });

  /**
   * GET /api/sessions/grouped
   * 获取按 agent 分组的 sessions（用于 Desktop 下拉列表）
   */
  router.get('/sessions/grouped', (req: Request, res: Response) => {
    const limitPerAgent = Math.min(parseInt(String(req.query.limitPerAgent ?? '5')), 20);
    const groups = repository.getGroupedSessions(limitPerAgent);
    res.json({
      count: groups.reduce((sum, g) => sum + g.sessions.length, 0),
      total: groups.reduce((sum, g) => sum + g.totalCount, 0),
      limitPerAgent,
      groups,
    });
  });

  return router;
}
