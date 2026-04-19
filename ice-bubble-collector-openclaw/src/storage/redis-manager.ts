/**
 * Redis 管理器
 *
 * 辅助存储：状态缓存、去重、Pub/Sub
 */

import { Logger } from '../utils/logger.js';

const redisLogger = new Logger('RedisManager');

export class RedisManager {
    /**
     * @Deprecated 当前为空实现，Redis 功能暂未启用
     */
    async init(): Promise<void> {
        // TODO: 实现 Redis 连接
        redisLogger.debug('[RedisManager] init called (not implemented)');
    }

    async close(): Promise<void> {
        // TODO: 实现 Redis 断开
        redisLogger.info('Closing...');
    }
}
