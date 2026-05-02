/**
 * 子 Agent 任务查询 API
 *
 * GET /api/subagent-tasks → 子 agent 任务列表（从 admin_sessions 表查询 spawn_depth > 0 的记录）
 */

import { Router, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';

export interface TasksRouterConfig {
  db: Database;
}

/**
 * GET /api/subagent-tasks
 * 子 agent 任务列表（从 admin_sessions 表查询 spawn_depth > 0 的记录）
 */
export function createSubagentTasksRouter(config: TasksRouterConfig): Router {
  const { db } = config;
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));

    const conditions: string[] = [
      'message_count > 0',
      "session_key NOT LIKE '%.trajectory'",
    ];
    const values: unknown[] = [];

    if (agent_id) {
      conditions.push('agent_id = ?');
      values.push(agent_id);
    }
    if (status) {
      conditions.push('session_status = ?');
      values.push(status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM admin_sessions ${whereClause}`).get(...values) as { total: number };

    const tasks = db.prepare(`
      SELECT session_key, label, agent_id, session_status, spawned_by, spawn_depth,
             created_at, last_message_at, first_message_at, message_count
      FROM admin_sessions ${whereClause}
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);

    res.json({
      count: tasks.length,
      total: countRow.total,
      limit,
      offset,
      tasks,
    });
  });

  return router;
}
