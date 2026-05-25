/**
 * Summary 端点 — GET /sessions/pending-summary + PUT /sessions/summary
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';
import { toBeijingTime, segmentMessages, mergeWithExisting, type RawMessage } from './helpers.js';

export function createSummaryRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const router = Router();

  /**
   * GET /api/sessions/pending-summary
   * 返回需要 AI 总结的 session 列表
   */
  router.get('/sessions/pending-summary', (_req: Request, res: Response) => {
    const db = repository.getDb();
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    const sessions = db.prepare(`
      SELECT session_key, spawn_depth, agent_id, last_summarized_msg_id, summary
      FROM admin_sessions
      WHERE session_key NOT LIKE '%.trajectory'
        AND session_key NOT LIKE '%.checkpoint'
        AND session_key NOT LIKE 'agent:daily-reporter:%'
        AND message_count > 1
        AND last_message_at >= datetime('now', '-7 days')
        AND (summary IS NULL OR last_message_at > summary_updated_at)
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 20
    `).all() as Array<{
      session_key: string;
      spawn_depth: number | null;
      agent_id: string | null;
      last_summarized_msg_id: number | null;
      summary: string | null;
    }>;

    const result = sessions.map(s => {
      const afterId = s.last_summarized_msg_id ?? 0;
      const isMain = (s.spawn_depth ?? 0) === 0;

      const messages = db.prepare(`
        SELECT id, message_type, content, timestamp
        FROM admin_messages
        WHERE session_key = ?
          AND id > ?
          AND message_type IN ('user', 'agent')
          AND content NOT LIKE 'Sender%'
          AND content NOT LIKE 'System%'
          AND instr(content, '[Subagent') = 0
        ORDER BY timestamp ASC
        LIMIT 100
      `).all(s.session_key, afterId) as Array<{
        id: number;
        message_type: string;
        content: string | null;
        timestamp: string;
      }>;

      const rawMsgs: RawMessage[] = messages.map(m => ({
        id: m.id,
        type: m.message_type,
        content: m.content,
        timestamp: m.timestamp,
        beijing_time: toBeijingTime(m.timestamp),
      }));

      if (rawMsgs.length === 0) {
        return {
          session_key: s.session_key,
          spawn_depth: s.spawn_depth ?? 0,
          agent_id: s.agent_id,
          new_messages: [],
        };
      }

      if (!isMain) {
        return {
          session_key: s.session_key,
          spawn_depth: s.spawn_depth ?? 0,
          agent_id: s.agent_id,
          summary_type: 'single',
          new_messages: rawMsgs,
        };
      }

      const newSegments = segmentMessages(rawMsgs);
      const mergedSegments = mergeWithExisting(newSegments, s.summary);

      for (const seg of mergedSegments) {
        if (seg.needs_regenerate) {
          const fullMsgs = db.prepare(`
            SELECT id, message_type, content, timestamp
            FROM admin_messages
            WHERE session_key = ?
              AND message_type IN ('user', 'agent')
              AND content NOT LIKE 'Sender%'
              AND content NOT LIKE 'System%'
              AND instr(content, '[Subagent') = 0
              AND timestamp <= ?
            ORDER BY timestamp ASC
          `).all(s.session_key, messages[messages.length - 1].timestamp) as Array<{
            id: number;
            message_type: string;
            content: string | null;
            timestamp: string;
          }>;
          seg.messages = fullMsgs.map(m => ({
            id: m.id,
            type: m.message_type,
            content: m.content,
            timestamp: m.timestamp,
            beijing_time: toBeijingTime(m.timestamp),
          }));
        }
      }

      return {
        session_key: s.session_key,
        spawn_depth: 0,
        agent_id: s.agent_id,
        summary_type: 'segmented',
        last_summarized_msg_id: s.last_summarized_msg_id ?? 0,
        segments: mergedSegments.map(seg => ({
          index: seg.index,
          from: seg.from,
          to: seg.to,
          needs_regenerate: seg.needs_regenerate ?? false,
          existing_text: seg.existing_text,
          messages: seg.messages?.map(m => ({
            id: m.id,
            type: m.type,
            content: m.content,
            beijing_time: m.beijing_time,
          })),
        })),
      };
    });

    res.json({ sessions: result });
  });

  /**
   * PUT /api/sessions/summary
   * 批量更新 session 摘要
   */
  router.put('/sessions/summary', (req: Request, res: Response) => {
    const db = repository.getDb();
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    const { updates } = req.body as {
      updates: Array<{
        session_key: string;
        summary_type?: 'single' | 'segmented';
        summary?: string;
        segments?: Array<{ index: number; text: string }>;
        last_summarized_msg_id: number;
      }>;
    };

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'updates array is required' });
      return;
    }

    const now = new Date().toISOString();
    let updated = 0;

    const upsert = db.transaction(() => {
      for (const item of updates) {
        const session = db.prepare(
          'SELECT summary, spawn_depth FROM admin_sessions WHERE session_key = ?'
        ).get(item.session_key) as { summary: string | null; spawn_depth: number | null } | undefined;

        if (!session) continue;

        let finalSummary: string;

        if (item.summary_type === 'segmented') {
          let existingSegments: Array<{ index: number; from: string; to: string; text?: string; needs_regenerate?: boolean }> = [];
          if (session.summary) {
            try {
              const parsed = JSON.parse(session.summary);
              if (parsed.segments) existingSegments = parsed.segments;
            } catch { /* ignore */ }
          }

          for (const newSeg of item.segments ?? []) {
            const idx = newSeg.index;
            const found = existingSegments.find(es => es.index === idx);
            if (found) {
              found.text = newSeg.text;
              delete found.needs_regenerate;
            } else {
              existingSegments.push({ index: idx, from: '', to: '', text: newSeg.text });
            }
          }
          finalSummary = JSON.stringify({ segments: existingSegments });
        } else {
          finalSummary = item.summary ?? '';
        }

        db.prepare(`
          UPDATE admin_sessions
          SET summary = ?, summary_updated_at = ?, last_summarized_msg_id = ?
          WHERE session_key = ?
        `).run(finalSummary, now, item.last_summarized_msg_id, item.session_key);
        updated++;
      }
    });

    upsert();
    res.json({ updated });
  });

  return router;
}
