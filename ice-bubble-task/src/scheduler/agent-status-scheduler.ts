/**
 * Agent 状态轮询调度器
 *
 * 定时查询 pending 任务，按 agent_id 分组。
 * 各 agent 可通过 API 更新任务状态，状态变更写入 task-store.json，
 * 由 OpenClawCollector 同步到 SQLite。
 *
 * T9 fix: 检查 task-store.json 时，先获取锁再读取，避免 TOCTOU 竞态。
 */

import { logger } from '../utils/logger.js';
import { withFileLock, readStore, writeStore } from '../utils/file-lock.js';
import { TaskRepository } from '../storage/task-repository.js';
import type { OpenClawTaskStore } from '../types/task.js';

export class AgentStatusScheduler {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;
  private syncing: boolean = false;

  constructor(
    private repository: TaskRepository,
    private taskStorePath: string,
    /** T10 fix: 从 config 读取轮询间隔 */
    collectIntervalMs: number = 30000
  ) {
    this.intervalMs = collectIntervalMs;
  }

  /**
   * 轮询间隔（毫秒）
   */
  private intervalMs: number;

  start() {
    if (this.running) return;
    this.running = true;
    logger.info(`[AgentScheduler] 启动，间隔 ${this.intervalMs}ms`);
    // 立即执行一次
    this.scheduleSync();
  }

  stop() {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
      logger.info('[AgentScheduler] 已停止');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 调度下一次同步。
   * 同步完成后再延迟 intervalMs 调度下一次，防止重叠。
   */
  private scheduleSync(): void {
    if (!this.running) return;

    this.timeoutId = setTimeout(() => {
      this.sync()
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[AgentScheduler] sync error in scheduler', { error: msg });
        })
        .finally(() => {
          this.scheduleSync();
        });
    }, this.intervalMs);
  }

  async sync() {
    if (this.syncing) {
      logger.debug('[AgentScheduler] Previous sync still in progress, skip');
      return;
    }

    this.syncing = true;

    try {
      // 1. 查询所有 pending 任务
      const pendingTasks = this.repository.findTasks({ status: 'pending', limit: 1000 });

      if (pendingTasks.tasks.length > 0) {
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
            tasks: taskIds.slice(0, 5)
          });
        }
      }

      // 4. 检查 task-store.json 中是否有遗留的 statusUpdates
      // T9 fix: 先获取锁再读取，避免 TOCTOU 竞态
      // （之前先 readFileSync 再 withFileLock，两次读之间数据可能变化）
      try {
        withFileLock(this.taskStorePath, () => {
          // 在锁保护下读取 — 这才是可信的数据
          const content = readStore(this.taskStorePath);
          const store: OpenClawTaskStore = JSON.parse(content);
          const updates = store.statusUpdates || {};

          if (Object.keys(updates).length > 0) {
            logger.info(`[AgentScheduler] 发现 ${Object.keys(updates).length} 个待同步的状态变更，开始修复...`);

            for (const [taskId, update] of Object.entries(updates)) {
              this.repository.updateTaskStatus(taskId, update.status);
              logger.info(`[AgentScheduler] 修复遗留更新: ${taskId} -> ${update.status}`);
            }

            // 写回时清空 statusUpdates（已全部同步）
            // 保留 tasks 和 counter
            writeStore(this.taskStorePath, JSON.stringify({
              tasks: store.tasks || {},
              counter: store.counter ?? 0,
              statusUpdates: {}
            }, null, 2));
          }
        });
      } catch {
        // 文件不存在则忽略
      }

      logger.debug(`[AgentScheduler] 同步完成`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[AgentScheduler] sync failed', { error: msg });
    } finally {
      this.syncing = false;
    }
  }
}
