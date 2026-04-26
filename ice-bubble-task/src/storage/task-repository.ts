/**
 * Task 数据仓库
 */

import type Database from 'better-sqlite3';
import type { Task, TaskInsert, TaskStatus, TaskType } from '../types/task.js';

export class TaskRepository {
  constructor(private db: Database.Database) {}

  /**
   * 根据 idempotency_key 查找任务
   */
  findByIdempotencyKey(key: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as Task | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * 插入或更新任务（upsert by id）
   * 支持幂等插入：如果传入了 idempotencyKey 且已存在，则返回现有任务
   * @returns { task, isNew }
   */
  upsertTask(task: TaskInsert, idempotencyKey?: string): { task: Task; isNew: boolean } {
    // 幂等检查
    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { task: existing, isNew: false };
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, status, priority, agent_id, type,
        parent_id, children_ids, description, loop_target,
        created_at, updated_at, terminated_by, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.title,
      task.status,
      task.priority,
      task.agent_id,
      task.type,
      task.parent_id ?? null,
      JSON.stringify(task.children_ids ?? []),
      task.description ?? '',
      task.loop_target ?? null,
      task.created_at,
      task.updated_at,
      task.terminated_by ?? null,
      idempotencyKey ?? null
    );

    return { task: this.rowToTask(task as Task), isNew: true };
  }

  /**
   * 批量 upsert
   * 支持 idempotency_key 列，避免并发重复创建任务。
   */
  upsertTasks(tasks: TaskInsert[]): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, status, priority, agent_id, type,
        parent_id, children_ids, description, loop_target,
        created_at, updated_at, terminated_by, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items: TaskInsert[]) => {
      for (const t of items) {
        stmt.run(
          t.id,
          t.title,
          t.status,
          t.priority,
          t.agent_id,
          t.type,
          t.parent_id ?? null,
          JSON.stringify(t.children_ids ?? []),
          t.description ?? '',
          t.loop_target ?? null,
          t.created_at,
          t.updated_at,
          t.terminated_by ?? null,
          t.idempotency_key ?? null
        );
      }
    });

    insertMany(tasks);
    return tasks.length;
  }

  /**
   * 查询所有任务（支持分页和 agent_id 筛选）
   */
  findTasks(opts: {
    agent_id?: string;
    status?: TaskStatus;
    type?: TaskType;
    limit?: number;
    offset?: number;
  } = {}): { tasks: Task[]; total: number } {
    const { agent_id, status, type, limit = 50, offset = 0 } = opts;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (agent_id) {
      conditions.push('agent_id = ?');
      params.push(agent_id);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM tasks ${where}`).get(...params) as { count: number };

    const rows = this.db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Task[];

    const tasks = rows.map(r => this.rowToTask(r));

    return { tasks, total: countRow.count };
  }

  /**
   * 根据 ID 获取单个任务
   */
  findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * 根据 agent_id 获取任务列表
   */
  findByAgentId(agent_id: string, limit = 50, offset = 0): { tasks: Task[]; total: number } {
    return this.findTasks({ agent_id, limit, offset });
  }

  /**
   * 根据父任务 ID 获取子任务
   */
  findByParentId(parent_id: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC').all(parent_id) as Task[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * 获取所有父任务（parent_id 为 null），按更新时间降序
   * 按 created_at DESC 排序，最新创建的父任务排最前面
   * updated_at 可能因为状态变更而被更新，导致不反映真实创建顺序
   */
  findParentTasks(): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY created_at DESC"
    ).all() as Task[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * 获取最近更新的父任务，按 updated_at DESC 排序
   * @param limit 返回的父任务数量，默认 3
   */
  findLatestParentTasks(limit: number = 3): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE parent_id IS NULL AND status != 'cancelled' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as Task[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * 统计各状态的任务数量（按 agent_id）
   */
  getStats(agent_id?: string): Record<string, number> {
    const where = agent_id ? 'WHERE agent_id = ?' : '';
    const params = agent_id ? [agent_id] : [];
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM tasks ${where} GROUP BY status`
    ).all(...params) as { status: string; count: number }[];

    return Object.fromEntries(rows.map(r => [r.status, r.count]));
  }

  /**
   * 更新任务状态，并刷新 updated_at 时间戳
   */
  updateTaskStatus(id: string, status: TaskStatus): boolean {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `);
    const result = stmt.run(status, new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * 查询超过指定天数未更新的 pending 任务（用于 TTL 清理）
   */
  getTasksOlderThan(ttlDays: number): Task[] {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE updated_at < ? AND status = 'pending' ORDER BY updated_at ASC`
    ).all(cutoff) as Task[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * 将数据库行转为 Task（处理 children_ids JSON 解析）
   */
  private rowToTask(row: Task & { children_ids: string | string[] }): Task {
    return {
      ...row,
      children_ids: typeof row.children_ids === 'string' ? JSON.parse(row.children_ids) : row.children_ids
    };
  }
}
