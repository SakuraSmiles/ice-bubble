/**
 * Flows 端点 — GET /sessions/flows
 * 智能会话流：按时间段合并相邻会话，gap < 20min 视为同一工作流
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';

export function createFlowsRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const router = Router();

  router.get('/sessions/flows', (req: Request, res: Response) => {
    const days = Math.min(parseInt(String(req.query.days ?? '7')), 90) || 7;
    const gapMs = 20 * 60 * 1000; // 20分钟 gap 阈值

    const db = repository.getDb();
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    // 基础过滤（与 timeline 一致）
    const baseWhere = `
      s.session_key NOT LIKE '%.trajectory'
      AND s.session_key NOT LIKE '%.checkpoint'
      AND s.session_key NOT LIKE 'agent:daily-reporter:%'
      AND s.message_count > 1
      AND NOT (s.message_count <= 3
        AND s.last_message_at IS NOT NULL AND s.first_message_at IS NOT NULL
        AND (julianday(s.last_message_at) - julianday(s.first_message_at)) * 86400 < 120)
    `;
    const dreamingExclude = `
      AND s.session_key NOT IN (
        SELECT DISTINCT session_key FROM admin_messages
        WHERE message_type = 'user'
          AND (content LIKE '%dream diary%' OR content LIKE '%dreaming%')
      )
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
        s.summary
      FROM admin_sessions s
      LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
      WHERE ${baseWhere}${dreamingExclude}
        AND s.last_message_at >= datetime('now', '-${days} days')
      ORDER BY s.last_message_at ASC
    `).all() as any[];

    if (rows.length === 0) {
      res.json({ flows: [], total: 0 });
      return;
    }

    // ===== 按 (agent_id, spawn_depth) 分组 =====
    const agentGroups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.agent_id}__${row.spawn_depth}`;
      if (!agentGroups.has(key)) agentGroups.set(key, []);
      agentGroups.get(key)!.push(row);
    }

    // ===== 构建 SessionFlow =====
    const allFlows: Array<{
      id: string;
      agent_id: string;
      agent_name: string | null;
      avatar: string | null;
      start_at: string;
      end_at: string;
      duration_minutes: number;
      message_count: number;
      spawn_depth: number;
      sessions_count: number;
      summary: string | null;
      gap_minutes: number;
    }> = [];

    for (const sessions of agentGroups.values()) {
      sessions.sort((a, b) => (a.last_message_at || '').localeCompare(b.last_message_at || ''));

      let currentFlow = createFlowFromSession(sessions[0]);

      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        const prevEnd = new Date(prev.last_message_at || prev.first_message_at || 0).getTime();
        const currStart = new Date(curr.first_message_at || curr.last_message_at || 0).getTime();
        const gap = currStart - prevEnd;

        if (gap < gapMs) {
          const prevStart = new Date(prev.first_message_at || prev.last_message_at || 0).getTime();
          const currEnd = new Date(curr.last_message_at || curr.first_message_at || 0).getTime();
          currentFlow.end_at = curr.last_message_at || currentFlow.end_at;
          currentFlow.start_at = (new Date(prevStart).getTime() < new Date(currentFlow.start_at).getTime())
            ? prev.first_message_at || currentFlow.start_at
            : currentFlow.start_at;
          currentFlow.duration_minutes = Math.round((currEnd - prevStart) / 60000);
          currentFlow.message_count += curr.message_count;
          currentFlow.sessions_count += 1;
          if (curr.summary && !currentFlow.summary) {
            currentFlow.summary = curr.summary;
          } else if (curr.summary && currentFlow.summary) {
            if (curr.summary.length > currentFlow.summary.length) {
              currentFlow.summary = curr.summary;
            }
          }
        } else {
          allFlows.push(currentFlow);
          currentFlow = { ...createFlowFromSession(curr), gap_minutes: Math.round(gap / 60000) };
        }
      }
      allFlows.push(currentFlow);
    }

    // ===== 按日期分组 =====
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const flowGroups = new Map<string, typeof allFlows>();
    for (const flow of allFlows) {
      const d = new Date(flow.end_at);
      const dateStr = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
      if (!flowGroups.has(dateStr)) flowGroups.set(dateStr, []);
      flowGroups.get(dateStr)!.push(flow);
    }

    const flows = Array.from(flowGroups.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateStr, items]) => {
        const [y, m, day] = dateStr.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        const today2 = new Date(); today2.setHours(0, 0, 0, 0);
        const yesterday2 = new Date(today2); yesterday2.setDate(yesterday2.getDate() - 1);
        let label: string;
        if (d.getTime() === today2.getTime()) label = '今天';
        else if (d.getTime() === yesterday2.getTime()) label = '昨天';
        else label = `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
        items.sort((a, b) => b.end_at.localeCompare(a.end_at));
        return { label, sortKey: dateStr, flows: items };
      });

    res.json({ flows, total: allFlows.length });
  });

  function createFlowFromSession(s: any) {
    const start = new Date(s.first_message_at || s.last_message_at || 0).getTime();
    const end = new Date(s.last_message_at || s.first_message_at || 0).getTime();
    return {
      id: s.session_key,
      agent_id: s.agent_id,
      agent_name: s.agent_name,
      avatar: s.avatar,
      start_at: s.first_message_at,
      end_at: s.last_message_at,
      duration_minutes: Math.round((end - start) / 60000),
      message_count: s.message_count,
      spawn_depth: s.spawn_depth,
      sessions_count: 1,
      summary: s.summary,
      gap_minutes: 0,
    };
  }

  return router;
}
