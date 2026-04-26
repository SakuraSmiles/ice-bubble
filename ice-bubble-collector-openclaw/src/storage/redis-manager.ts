/**
 * Redis 管理器
 *
 * @deprecated Redis 功能暂未启用，当前为占位实现。
 *             如需使用 Redis 缓存/PubSub，请实现此模块。
 */

import { Logger } from '../utils/logger.js';

const redisLogger = new Logger('RedisManager');

export class RedisManager {
    async init(): Promise<void> {
        redisLogger.warn('[RedisManager] Redis 功能未启用（请在配置中启用或移除此模块）');
    }

    async close(): Promise<void> {
        redisLogger.debug('[RedisManager] close called');
    }
}
