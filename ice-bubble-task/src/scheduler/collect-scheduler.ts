/**
 * 定时采集调度器
 *
 * 使用 setTimeout 递归调度，确保每次采集完成后再调度下一次，
 * 避免 setInterval 导致的重叠执行问题。
 */

import type { CollectorInterface } from '../collectors/collector-interface.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('CollectScheduler');

export class CollectScheduler {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;
  private collecting: boolean = false;

  constructor(
    private collectors: CollectorInterface[],
    private intervalMs: number
  ) {}

  /**
   * 启动定时采集
   */
  start(): void {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    this.running = true;

    // 立即执行一次
    this.scheduleCollect();

    logger.info(`Scheduler started, interval=${this.intervalMs}ms, collectors=${this.collectors.length}`);
  }

  /**
   * 停止定时采集
   */
  stop(): void {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    logger.info('Scheduler stopped');
  }

  /**
   * 调度下一次采集。
   * 采集完成后再延迟 intervalMs 调度下一次，防止重叠。
   */
  private scheduleCollect(): void {
    if (!this.running) return;

    this.timeoutId = setTimeout(() => {
      this.runCollect()
        .catch(err => logger.error('Scheduled collect failed', { error: err }))
        .finally(() => {
          // 采集完成后调度下一次
          this.scheduleCollect();
        });
    }, this.intervalMs);
  }

  /**
   * 立即执行一次采集（手动触发）。
   * 如果上次采集仍在进行中，跳过本次执行。
   */
  async runCollect(): Promise<void> {
    if (this.collecting) {
      logger.debug('Previous collect still in progress, skip');
      return;
    }

    this.collecting = true;
    logger.debug('Starting collect cycle...');

    try {
      for (const collector of this.collectors) {
        try {
          const available = await collector.isAvailable();
          if (!available) {
            logger.debug(`Collector ${collector.name} not available, skip`);
            continue;
          }

          const result = await collector.collect();
          if (result.errors.length > 0) {
            logger.warn(`Collector ${collector.name} completed with errors`, { errors: result.errors });
          } else {
            logger.info(`Collector ${collector.name} done: collected=${result.collected}, updated=${result.updated}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Collector ${collector.name} threw`, { error: msg });
        }
      }
    } finally {
      this.collecting = false;
    }

    logger.debug('Collect cycle finished');
  }

  isRunning(): boolean {
    return this.running;
  }

  isCollecting(): boolean {
    return this.collecting;
  }
}
