/**
 * 定时采集调度器
 *
 * 每隔指定间隔自动调用所有已启用的采集器。
 */

import type { CollectorInterface } from '../collectors/collector-interface.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('CollectScheduler');

export class CollectScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

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
    this.runCollect().catch(err => logger.error('Initial collect failed', { error: err }));

    // 启动定时
    this.intervalId = setInterval(() => {
      this.runCollect().catch(err => logger.error('Scheduled collect failed', { error: err }));
    }, this.intervalMs);

    logger.info(`Scheduler started, interval=${this.intervalMs}ms, collectors=${this.collectors.length}`);
  }

  /**
   * 停止定时采集
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    logger.info('Scheduler stopped');
  }

  /**
   * 立即执行一次采集（手动触发）
   */
  async runCollect(): Promise<void> {
    logger.debug('Starting collect cycle...');

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

    logger.debug('Collect cycle finished');
  }

  isRunning(): boolean {
    return this.running;
  }
}
