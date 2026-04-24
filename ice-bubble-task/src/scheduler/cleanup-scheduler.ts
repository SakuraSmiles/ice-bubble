/**
 * 任务 TTL 清理调度器
 *
 * 定期扫描超过 TTL 的 pending 任务，将其状态更新为 completed。
 */

import type { TaskRepository } from '../storage/task-repository.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('CleanupScheduler');

export class CleanupScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor(
    private repository: TaskRepository,
    private ttlDays: number,
    private intervalMs: number
  ) {}

  /**
   * 启动定时清理
   */
  start(): void {
    if (this.running) {
      logger.warn('CleanupScheduler already running');
      return;
    }

    this.running = true;

    // 立即执行一次
    this.runCleanup().catch(err => logger.error('Initial cleanup failed', { error: err }));

    this.intervalId = setInterval(() => {
      this.runCleanup().catch(err => logger.error('Scheduled cleanup failed', { error: err }));
    }, this.intervalMs);

    logger.info(`CleanupScheduler started, ttl=${this.ttlDays} days, interval=${this.intervalMs}ms`);
  }

  /**
   * 停止定时清理
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    logger.info('CleanupScheduler stopped');
  }

  /**
   * 执行一次清理
   */
  async runCleanup(): Promise<void> {
    const expiredTasks = this.repository.getTasksOlderThan(this.ttlDays);
    if (expiredTasks.length === 0) {
      logger.debug('No expired pending tasks');
      return;
    }

    let cleaned = 0;
    for (const task of expiredTasks) {
      if (task.status === 'pending') {
        const ok = this.repository.updateTaskStatus(task.id, 'completed');
        if (ok) cleaned++;
      }
    }

    logger.info(`CleanupScheduler: marked ${cleaned}/${expiredTasks.length} pending tasks as completed`);
  }

  isRunning(): boolean {
    return this.running;
  }
}
