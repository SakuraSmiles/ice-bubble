/**
 * Agent 状态轮询调度器
 *
 * 定时查询 pending 任务，按 agent_id 分组。
 * 各 agent 可通过 API 更新任务状态，状态变更写入 task-store.json，
 * 由 OpenClawCollector 同步到 SQLite。
 */

import { readFileSync } from 'fs';
import { logger } from '../utils/logger.js';
import { withFileLock, readStore, writeStore } from '../utils/file-lock.js';
import { TaskRepository } from '../storage/task-repository.js';
import type { OpenClawTaskStore } from '../types/task.js';

export class AgentStatusScheduler {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private repository: TaskRepository,
    private taskStorePath: string,
    /** T10 fix: 从 config 读取轮询间隔 */
    collectIntervalMs: number = 30000
  ) {
    this.intervalMs = collectIntervalMs;
  }

  start() {
    if (this.timer) return; // 避免重复启动
    logger.info(`[AgentScheduler] 启动，间隔 ${this.intervalMs}ms`);
    this.timer = setInterval(() => this.sync(), this.intervalMs);
    // 立即执行一次
    this.sync();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[AgentScheduler] 已停止');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async sync() {
    try {
      // 1. 查询所有 pending 任务
      const pendingTasks = this.repository.findTasks({ status: 'pending', limit: 1000 });

      if (pendingTasks.tasks.length === 0) {
        return;
      }

      // 2. 按 agent_id 分组
      const byAgent = new Map<string, string[]>();
      for (const task of pendingTasks.tasks) {
        const list = byAgent.get(task.agent_id) || [];
        list.push(task.id);
        byAgent.set(task.agent_id, list);
      }

      // 3. 记录分组日志（供调试）
      for (const [agent_id, taskIds] of byAgent) {
        logger.debug(`[AgentScheduler] agent=${agent_id} has ${taskIds.length} pending tasks`, {
          tasks: taskIds.slice(0, 5) // 只打前 5 个
        });
      }

      // 4. 检查 task-store.json 中是否有遗留的 statusUpdates
      // T9 fix: 发现遗留更新时主动同步到 SQLite，防止数据丢失
      try {
        const content = readFileSync(this.taskStorePath, 'utf-8');
        const store: OpenClawTaskStore = JSON.parse(content);
        const updates = store.statusUpdates || {};
        if (Object.keys(updates).length > 0) {
          logger.info(`[AgentScheduler] 发现 ${Object.keys(updates).length} 个待同步的状态变更，开始修复...`);

          // 将遗留更新同步到 SQLite，然后清空 statusUpdates
          withFileLock(this.taskStorePath, () => {
            const lockedContent = readStore(this.taskStorePath);
            const lockedStore: OpenClawTaskStore = JSON.parse(lockedContent);
            const lockedUpdates = lockedStore.statusUpdates || {};

            for (const [taskId, update] of Object.entries(lockedUpdates)) {
              this.repository.updateTaskStatus(taskId, update.status);
              logger.info(`[AgentScheduler] 修复遗留更新: ${taskId} -> ${update.status}`);
            }

            // 写回时清空 statusUpdates（已全部同步）
            lockedStore.statusUpdates = {};
            writeStore(this.taskStorePath, JSON.stringify({
              tasks: lockedStore.tasks || {},
              counter: lockedStore.counter ?? 0,
              statusUpdates: {}
            }, null, 2));
          });
        }
      } catch {
        // 文件不存在则忽略
      }

      logger.debug(`[AgentScheduler] 同步完成，${byAgent.size} 个 agent 有待处理任务`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[AgentScheduler] sync failed', { error: msg });
    }
  }
}
