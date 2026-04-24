/**
 * OpenClaw 任务采集器
 *
 * 从 ~/.openclaw/workspace/tasks/task-store.json 读取任务数据，
 * 解析后写入 SQLite。采集任务和状态变更两部分，采集后只清除已采集的部分。
 */

import { existsSync } from 'fs';
import { withFileLock, readStore, writeStore } from '../utils/file-lock.js';
import type { CollectorInterface } from './collector-interface.js';
import type { CollectResult, OpenClawTaskSource, OpenClawTaskStore, TaskInsert } from '../types/task.js';
import { Logger } from '../utils/logger.js';
import { TaskRepository } from '../storage/task-repository.js';

const logger = new Logger('OpenClawCollector');

export class OpenClawCollector implements CollectorInterface {
  readonly name = 'openclaw';

  constructor(
    private taskStorePath: string,
    private repository: TaskRepository
  ) {}

  async isAvailable(): Promise<boolean> {
    return existsSync(this.taskStorePath);
  }

  async collect(): Promise<CollectResult> {
    const result: CollectResult = { collected: 0, updated: 0, errors: [] };

    try {
      if (!existsSync(this.taskStorePath)) {
        logger.debug('task-store.json not found, skip');
        return result;
      }

      // T1 fix: 用文件锁包裹整个读-改-写过程，防止 API 并发写入造成数据覆盖
      withFileLock(this.taskStorePath, () => {
        const content = readStore(this.taskStorePath);
        const store: OpenClawTaskStore = JSON.parse(content);

        // 1. 初始化 store 结构（防止 undefined 报错）
        if (!store.tasks) store.tasks = {};
        if (!store.statusUpdates) store.statusUpdates = {};

        // 2. 采集新建/更新的任务
        const tasks: TaskInsert[] = Object.values(store.tasks as Record<string, OpenClawTaskSource>).map((t: OpenClawTaskSource) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          agent_id: t.agent_id,
          type: t.type,
          parent_id: t.parent_id,
          children_ids: t.children_ids ?? [],
          description: t.description ?? '',
          loop_target: t.loop_target ?? null,
          created_at: t.created_at,
          updated_at: t.updated_at,
          terminated_by: t.terminated_by ?? null,
        }));

        if (tasks.length > 0) {
          const count = this.repository.upsertTasks(tasks);
          result.collected = count;
          result.updated = count;
          // 采集后清除已同步的 tasks（仅从内存对象删除，不影响文件）
          for (const task of tasks) {
            delete store.tasks[task.id];
          }
          logger.info(`Collected ${count} tasks from OpenClaw`);
        }

        // 3. 采集状态变更
        const updates = store.statusUpdates || {};
        for (const [taskId, update] of Object.entries(updates)) {
          this.repository.updateTaskStatus(taskId, update.status);
          result.updated++;
          // 采集后清除已同步的 statusUpdates（仅从内存对象删除）
          delete store.statusUpdates[taskId];
        }

        if (Object.keys(updates).length > 0) {
          logger.info(`Synced ${Object.keys(updates).length} status updates`);
        }

        // 4. 写回文件：只保留未被采集的 entries，保留 counter
        // T2 fix: 不写空的 statusUpdates: {}，避免覆盖采集期间新到达的 statusUpdates
        const savedCounter = store.counter ?? 0;
        writeStore(this.taskStorePath, JSON.stringify({
          tasks: store.tasks,        // 剩余未采集的 tasks（正常情况下为空）
          counter: savedCounter,
          statusUpdates: store.statusUpdates  // 保留新产生的、未被本次采集的 statusUpdates
        }, null, 2));
      });

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`OpenClaw collect error: ${msg}`);
      logger.error('Collect failed', { error });
    }

    return result;
  }
}

/**
 * 创建 OpenClaw 采集器实例
 */
export function createOpenClawCollector(
  taskStorePath: string,
  repository: TaskRepository
): CollectorInterface {
  return new OpenClawCollector(taskStorePath, repository);
}
