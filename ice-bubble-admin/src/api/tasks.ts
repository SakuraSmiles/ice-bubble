/**
 * 任务查询 API
 *
 * GET /api/tasks                    → 任务列表（支持 agent_id, status 过滤，按 created_at 倒序）
 * GET /api/tasks/stats              → 任务统计（总数、各状态数量）
 * GET /api/tasks/:id                → 任务详情
 */

import { Router, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';

export interface TasksRouterConfig {
  db: Database;
}

export function createTasksRouter(config: TasksRouterConfig): Router {
  const { db } = config;
  const router = Router();

  /**
   * GET /api/tasks
   * 任务列表（支持 agent_id, status 过滤，按 created_at 倒序）
   */
  router.get('/', (req: Request, res: Response) => {
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));

    const tasks = getTasks(db, { agent_id, status, limit, offset });

    res.json({
      count: tasks.length,
      limit,
      offset,
      tasks,
    });
  });

  /**
   * GET /api/tasks/stats
   * 任务统计（总数、各状态数量）
   */
  router.get('/stats', (_req: Request, res: Response) => {
    const stats = getTaskStats(db);
    res.json(stats);
  });

  /**
   * GET /api/tasks/:id
   * 任务详情
   */
  router.get('/:id', (req: Request, res: Response) => {
    const task = getTaskById(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found', id: req.params.id });
      return;
    }
    res.json(task);
  });

  return router;
}

// ============================================================================
// 数据访问函数（直接从 admin_tasks 表读取，使用参数化查询）
// ============================================================================

export interface AdminTask {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout';
  agent_id: string;
  requester_session_key: string;
  child_session_key: string;
  run_id: string;
  mode: string;
  task_description: string;
  result_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  agent_id: string | null;
  requester_session_key: string;
  child_session_key: string | null;
  run_id: string | null;
  mode: string | null;
  task_description: string | null;
  result_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

/**
 * 获取任务列表（从 admin_tasks 表）
 */
function getTasks(
  db: Database,
  params: {
    agent_id?: string;
    status?: string;
    limit: number;
    offset: number;
  }
): AdminTask[] {
  const { agent_id, status, limit, offset } = params;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (agent_id) {
    conditions.push('agent_id = ?');
    values.push(agent_id);
  }
  if (status) {
    conditions.push('status = ?');
    values.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM admin_tasks ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as TaskRow[];

  return rows.map(mapRowToTask);
}

/**
 * 获取任务详情
 */
function getTaskById(db: Database, id: string): AdminTask | null {
  const row = db.prepare('SELECT * FROM admin_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? mapRowToTask(row) : null;
}

/**
 * 获取任务统计
 */
function getTaskStats(db: Database): {
  total: number;
  by_status: Record<string, number>;
} {
  // 总数
  const totalRow = db.prepare('SELECT COUNT(*) as total FROM admin_tasks').get() as { total: number };

  // 各状态数量
  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM admin_tasks
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const by_status: Record<string, number> = {};
  for (const row of statusRows) {
    by_status[row.status] = row.count;
  }

  return { total: totalRow.total, by_status };
}

/**
 * 将数据库行映射为 AdminTask
 */
function mapRowToTask(row: TaskRow): AdminTask {
  return {
    id: row.id,
    title: row.title,
    status: row.status as AdminTask['status'],
    agent_id: row.agent_id || '',
    requester_session_key: row.requester_session_key,
    child_session_key: row.child_session_key || '',
    run_id: row.run_id || '',
    mode: row.mode || '',
    task_description: row.task_description || '',
    result_summary: row.result_summary,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}
