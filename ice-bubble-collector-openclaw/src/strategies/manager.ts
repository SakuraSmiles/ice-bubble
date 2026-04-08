/**
 * 策略管理器
 *
 * 管理采集策略的创建和切换
 */

import type { CollectionStrategy } from './base.js';
import { CollectionMode } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('StrategyManager');

export class StrategyManager {
    private strategy: CollectionStrategy | null = null;

    async setMode(mode: CollectionMode): Promise<void> {
        // TODO: 实现策略切换
        logger.info(`Setting mode to: ${mode}`);
    }

    async start(): Promise<void> {
        // TODO: 实现启动策略
        if (this.strategy) {
            await this.strategy.start();
        }
    }

    async stop(): Promise<void> {
        // TODO: 实现停止策略
        if (this.strategy) {
            await this.strategy.stop();
        }
    }
}
