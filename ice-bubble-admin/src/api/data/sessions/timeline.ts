/**
 * Timeline 端点 — GET /sessions/timeline
 * 纯 SQLite 查询，返回按日期分组的树状会话时间线（不走 Gateway）
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';
import { stripTimestampPrefix, extractTaskTitle, smartTruncate } from './helpers.js';

export function createTimelineRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const router = Router();

  router.get('/sessions/timeline', (req: Request, res: Response) => {
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const days = Math.min(parseInt(String(req.query.days ?? '7')), 90) || 7;

    const db = repository.getDb();
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    // ====== 通用过滤条件 ======
    const baseWhere = `
      s.session_key NOT LIKE '%.trajectory'
      AND s.session_key NOT LIKE '%.checkpoint'
      AND s.session_key NOT LIKE 'agent:daily-reporter:%'
      AND s.message_count > 1
      AND NOT (s.message_count <= 3
        AND s.last_message_at IS NOT NULL AND s.first_message_at IS NOT NULL
        AND (julianday(s.last_message_at) - julianday(s.first_message_at)) * 86400 < 120)
    `;
    // dreaming 会话排除（通过 content 关键词）
    const dreamingExclude = `
      AND s.session_key NOT IN (
        SELECT DISTINCT session_key FROM admin_messages
        WHERE message_type = 'user'
          AND (content LIKE '%dream diary%' OR content LIKE '%dreaming%')
      )
      -- 排除所有 user 消息只有系统注入或为空的会话（纯自动任务）
      AND NOT (
        NOT EXISTS (
          SELECT 1 FROM admin_messages m2
          WHERE m2.session_key = s.session_key
            AND m2.message_type = 'user'
            AND m2.content IS NOT NULL AND m2.content != ''
            AND m2.content NOT LIKE 'Sender (untrusted metadata)%'
            AND m2.content NOT LIKE 'System (untrusted):%'
            AND m2.content NOT LIKE 'System:%'
        )
      )
    `;

    // ====== 查所有会话（平铺，不分主/子）======
    const values: unknown[] = [];
    let filter = baseWhere + dreamingExclude + `
      AND s.last_message_at >= datetime('now', '-${days} days')
    `;
    if (agent_id) {
      filter += ` AND s.agent_id = ?`;
      values.push(agent_id);
    }

    const rows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        a.agent_name,
        a.avatar,
        s.message_count,
        s.first_message_at,
        s.last_message_at,
        s.session_status,
        COALESCE(s.spawn_depth, 0) as spawn_depth,
        COALESCE(sums.input_tokens, 0) as input_tokens,
        COALESCE(sums.output_tokens, 0) as output_tokens,
        s.summary,
        (SELECT m.content FROM admin_messages m
          WHERE m.session_key = s.session_key AND m.message_type = 'user'
            AND m.content IS NOT NULL AND m.content != ''
            AND m.content NOT LIKE 'Sender (untrusted metadata)%'
            AND m.content NOT LIKE 'System (untrusted):%'
            AND m.content NOT LIKE 'System:%'
            AND instr(m.content, '[Subagent Context]') = 0
          ORDER BY m.timestamp ASC LIMIT 1
        ) as first_message,
        (SELECT m.content FROM admin_messages m
          WHERE m.session_key = s.session_key AND m.message_type = 'agent'
          ORDER BY m.timestamp DESC LIMIT 1
        ) as last_message
      FROM admin_sessions s
      LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
      LEFT JOIN (
        SELECT session_key, SUM(tokens_input) as input_tokens, SUM(tokens_output) as output_tokens
        FROM admin_messages GROUP BY session_key
      ) sums ON sums.session_key = s.session_key
      WHERE ${filter}
      GROUP BY s.session_key
      ORDER BY s.last_message_at DESC NULLS LAST
    `).all(...values) as any[];

    // 应用智能截断
    // 对于 subagent：如果 first_message 为空（系统注入被过滤），取第二条 user 消息
    const subagentKeys = rows
      .filter(r => r.spawn_depth > 0 && !r.first_message)
      .map(r => r.session_key);
    const subagentFirstMsgMap = new Map<string, string>();
    if (subagentKeys.length > 0) {
      const subRows = db.prepare(`
        SELECT session_key, content FROM (
          SELECT session_key, content,
            ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY timestamp ASC) as rn
          FROM admin_messages
          WHERE session_key IN (${subagentKeys.map(() => '?').join(',')})
            AND message_type = 'user'
            AND content IS NOT NULL AND content != ''
            AND content NOT LIKE 'Sender (untrusted metadata)%'
            AND content NOT LIKE 'System (untrusted):%'
            AND content NOT LIKE 'System:%'
            AND instr(content, '[Subagent Context]') = 0
        ) WHERE rn = 2
      `).all(...subagentKeys) as { session_key: string; content: string }[];
      for (const row of subRows) {
        subagentFirstMsgMap.set(row.session_key, row.content);
      }
    }

    const timeline = rows.map(r => ({
      ...r,
      task_title: r.spawn_depth > 0 && !r.first_message
        ? extractTaskTitle(r.last_message)
        : null,
      first_message: smartTruncate(
        stripTimestampPrefix(r.first_message || subagentFirstMsgMap.get(r.session_key)),
        400
      ),
      last_message: smartTruncate(stripTimestampPrefix(r.last_message), 300),
    }));

    res.json({ timeline, total: timeline.length });
  });

  return router;
}
