/**
 * Tasks REST API
 *
 * GET /api/tasks            - 任务列表（支持 agent_id 筛选）
 * GET /api/tasks/stats       - 任务统计
 * GET /api/tasks/:id         - 单个任务
 * GET /api/agents/:id/tasks - 某个 agent 的任务列表
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { withFileLock, readStore, writeStore } from '../utils/file-lock.js';
import { TaskRepository } from '../storage/task-repository.js';
import type { Task, TaskStatus, TaskType } from '../types/task.js';
import type { OpenClawTaskStore } from '../types/task.js';

export function createTasksRouter(repository: TaskRepository, taskStorePath?: string): Router {
  const router = Router();

  /**
   * POST /api/tasks
   * 创建新任务
   * Body: {
   *   title: string,        // 任务标题
   *   agent_id: string,     // 分配给哪个 agent
   *   priority?: string,    // priority: low|medium|high|critical
   *   type?: string,        // type: TODO|LOOP|CHAIN|SUBAGENT
   *   description?: string,  // 任务描述
   *   parent_id?: string,   // 父任务 ID（可选）
   *   idempotency_key?: string, // 幂等键（可选）
   * }
   */
  router.post('/tasks', (req: Request, res: Response) => {
    if (!taskStorePath) {
      res.status(500).json({ error: 'taskStorePath not configured', code: 'CONFIG_MISSING' });
      return;
    }

    try {
      const { title, agent_id, priority, type, description, parent_id, idempotency_key } = req.body;

      // 验证必填字段
      if (!title || !agent_id) {
        res.status(400).json({ error: 'title 和 agent_id 是必填字段' });
        return;
      }

      // 生成任务 ID（T5 fix: 用 crypto.randomUUID() 避免并发重复）
      const id = randomUUID();
      const now = new Date().toISOString();

      // 创建任务对象
      const task = {
        id,
        title,
        status: 'pending' as TaskStatus,
        priority: priority || 'medium',
        agent_id,
        type: type || 'TODO',
        description: description || '',
        parent_id: parent_id || null,
        children_ids: [],
        created_at: now,
        updated_at: now,
        terminated_by: null,
        loop_target: null,
        idempotency_key: idempotency_key || undefined
      };

      // 如果指定了父任务，先验证父任务存在
      if (parent_id) {
        const parent = repository.findById(parent_id);
        if (!parent) {
          res.status(404).json({ error: '父任务不存在', code: 'PARENT_NOT_FOUND', parent_id });
          return;
        }
      }

      // 幂等插入
      const result = repository.upsertTask(task, idempotency_key);

      if (result.isNew && parent_id) {
        // 新建的子任务：追加 ID 到父任务的 children_ids
        const updated = repository.appendChildId(parent_id, id);
        if (!updated) {
          logger.error(`Failed to update parent children_ids: parent=${parent_id}, child=${id}`);
        }
      }

      if (result.isNew) {
        res.status(201).json(result.task);
      } else {
        res.status(200).json(result.task);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('POST /api/tasks failed', { error: msg });
      res.status(500).json({ error: '创建任务失败', code: 'TASK_CREATE_FAILED' });
    }
  });

  /**
   * GET /api/tasks/stats
   * 任务统计（各状态数量）
   * Query: agent_id（可选）
   * 注意：此路由必须放在 /:id 之前，避免被截获
   */
  router.get('/tasks/stats', (req: Request, res: Response) => {
    try {
      const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
      const stats = repository.getStats(agent_id);
      res.json({ agent_id: agent_id ?? null, stats });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/tasks/stats failed', { error: msg });
      res.status(500).json({ error: '获取统计失败', code: 'STATS_FAILED' });
    }
  });

  /**
   * GET /api/tasks
   * 任务列表，支持分页和筛选
   * Query: agent_id, status, type, limit, offset
   * 注意：此路由必须放在 /:id 之前，避免被截获
   */
  router.get('/tasks', (req: Request, res: Response) => {
    try {
      const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
      const status = req.query.status ? String(req.query.status) as TaskStatus : undefined;
      const type = req.query.type ? String(req.query.type) as TaskType : undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
      const offset = parseInt(String(req.query.offset ?? '0'));

      const result = repository.findTasks({ agent_id, status, type, limit, offset });

      res.json({
        count: result.tasks.length,
        total: result.total,
        limit,
        offset,
        tasks: result.tasks
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/tasks failed', { error: msg });
      res.status(500).json({ error: '获取任务列表失败', code: 'TASKS_LIST_FAILED' });
    }
  });

  /**
   * GET /api/tasks/workspace
   * 获取工作台视图：最近更新的父任务，每个父任务按 agent_id 分组子任务，
   * 每组分离 active（pending/in_progress）和 completed
   */
  router.get('/tasks/workspace', (_req: Request, res: Response) => {
    try {
      const parents = repository.findLatestParentTasks(3);

      const result = parents.map(parent => {
        const children = repository.findByParentId(parent.id);

        // 按 agent_id 分组
        const groups: Record<string, Task[]> = {};
        for (const child of children) {
          if (!groups[child.agent_id]) {
            groups[child.agent_id] = [];
          }
          groups[child.agent_id].push(child);
        }

        // 构建 agent_groups
        const agentGroups = Object.entries(groups).map(([agent_id, agentChildren]) => ({
          agent_id,
          active_children: agentChildren
            .filter(c => c.status === 'pending' || c.status === 'in_progress')
            .map(c => ({ id: c.id, title: c.title, status: c.status, updated_at: c.updated_at })),
          completed_children: agentChildren
            .filter(c => c.status === 'completed')
            .map(c => ({ id: c.id, title: c.title, status: c.status, updated_at: c.updated_at }))
        }));

        return {
          id: parent.id,
          title: parent.title,
          status: parent.status,
          updated_at: parent.updated_at,
          agent_groups: agentGroups
        };
      });

      res.json({ parents: result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/tasks/workspace failed', { error: msg });
      res.status(500).json({ error: '获取工作台任务失败', code: 'WORKSPACE_TASKS_FAILED' });
    }
  });

  /**
   * GET /api/tasks/latest
   * 获取所有非 completed 状态的任务，按 agent_id 分组
   */
  router.get('/tasks/latest', (_req: Request, res: Response) => {
    try {
      const allPending = repository.findTasks({ status: 'pending' });
      const allInProgress = repository.findTasks({ status: 'in_progress' });
      const allTasks: Task[] = [...allPending.tasks, ...allInProgress.tasks];

      // 按 agent_id 分组，每个 agent 最多 5 个
      const agents: Record<string, Task[]> = {};
      for (const task of allTasks) {
        if (!agents[task.agent_id]) {
          agents[task.agent_id] = [];
        }
        if (agents[task.agent_id].length < 5) {
          agents[task.agent_id].push(task);
        }
      }

      res.json({ agents });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/tasks/latest failed', { error: msg });
      res.status(500).json({ error: '获取最新任务失败', code: 'LATEST_TASK_FAILED' });
    }
  });

  /**
   * GET /api/tasks/:id
   * 获取单个任务
   */
  router.get('/tasks/:id', (req: Request, res: Response) => {
    try {
      const task = repository.findById(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found', id: req.params.id });
        return;
      }
      res.json(task);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/tasks/:id failed', { error: msg });
      res.status(500).json({ error: '获取任务失败', code: 'TASK_GET_FAILED' });
    }
  });

  /**
   * GET /api/agents/:agent_id/tasks
   * 获取指定 agent 的所有任务
   */
  router.get('/agents/:agent_id/tasks', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
      const offset = parseInt(String(req.query.offset ?? '0'));
      const result = repository.findByAgentId(req.params.agent_id, limit, offset);

      res.json({
        agent_id: req.params.agent_id,
        count: result.tasks.length,
        total: result.total,
        limit,
        offset,
        tasks: result.tasks
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GET /api/agents/:agent_id/tasks failed', { error: msg });
      res.status(500).json({ error: '获取 agent 任务列表失败', code: 'AGENT_TASKS_FAILED' });
    }
  });

  /**
   * PATCH /api/tasks/:id/status
   * 更新任务状态，写入 task-store.json 的 statusUpdates（供 collector 同步）
   * Body: { "status": "in_progress" | "completed" | "failed" | "cancelled" }
   */
  router.patch('/tasks/:id/status', (req: Request, res: Response) => {
    if (!taskStorePath) {
      res.status(500).json({ error: 'taskStorePath not configured', code: 'CONFIG_MISSING' });
      return;
    }

    try {
      const { id } = req.params;
      const { status } = req.body as { status?: TaskStatus };

      if (!status) {
        res.status(400).json({ error: 'status is required', code: 'STATUS_REQUIRED' });
        return;
      }

      const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}`, code: 'INVALID_STATUS' });
        return;
      }

      // T1+T4 fix: 用文件锁保护读-改-写整个临界区，防止并发 PATCH 互相覆盖
      withFileLock(taskStorePath, () => {
        let store: OpenClawTaskStore;
        try {
          store = JSON.parse(readStore(taskStorePath));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[tasks] Failed to parse task store: ${msg}`);
          return;
        }
        if (!store.statusUpdates) store.statusUpdates = {};
        store.statusUpdates[id] = {
          status,
          updated_at: new Date().toISOString()
        };
        writeStore(taskStorePath, JSON.stringify(store, null, 2));
      });

      // 同时更新本地 SQLite（如果任务已在本地）
      repository.updateTaskStatus(id, status);

      logger.info(`Task status updated via API: ${id} -> ${status}`);
      res.json({ id, status, updated: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('PATCH /api/tasks/:id/status failed', { error: msg });
      res.status(500).json({ error: '更新任务状态失败', code: 'STATUS_UPDATE_FAILED' });
    }
  });

  /**
   * DELETE /api/tasks/:id
   * 删除指定任务（标记为 cancelled），并同步到 task-store.json
   * T6 fix: 级联取消子任务
   * T7 fix: 同步写入 statusUpdates 供 collector 持久化
   */
  router.delete('/tasks/:id', (req: Request, res: Response) => {
    if (!taskStorePath) {
      res.status(500).json({ error: 'taskStorePath not configured', code: 'CONFIG_MISSING' });
      return;
    }

    try {
      const id = req.params.id;
      const existed = repository.findById(id);
      if (!existed) {
        res.status(404).json({ error: 'Task not found', id });
        return;
      }

      const now = new Date().toISOString();
      const cancelledIds: string[] = [id];

      // T6: 查找子任务并一并标记为 cancelled
      const children = repository.findByParentId(id);
      for (const child of children) {
        repository.updateTaskStatus(child.id, 'cancelled');
        cancelledIds.push(child.id);
      }

      // T7: 同步写入 task-store.json statusUpdates（由 collector 持久化到 SQLite）
      withFileLock(taskStorePath, () => {
        let store: OpenClawTaskStore;
        try {
          store = JSON.parse(readStore(taskStorePath));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[tasks] Failed to parse task store: ${msg}`);
          return;
        }
        if (!store.statusUpdates) store.statusUpdates = {};
        for (const taskId of cancelledIds) {
          store.statusUpdates[taskId] = { status: 'cancelled', updated_at: now };
        }
        writeStore(taskStorePath, JSON.stringify(store, null, 2));
      });

      res.json({ id, status: 'cancelled', childrenCancelled: children.length, updated: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('DELETE /api/tasks/:id failed', { error: msg });
      res.status(500).json({ error: '删除任务失败', code: 'TASK_DELETE_FAILED' });
    }
  });

  return router;
}
