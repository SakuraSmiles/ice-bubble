/**
 * WebSocket 采集器
 *
 * 订阅 OpenClaw Gateway 的实时事件
 */

import { BaseCollector } from './base.js';
import { Logger } from '../utils/logger.js';

const wsLogger = new Logger('WebSocketCollector');

export class WebSocketCollector extends BaseCollector {
    getName(): string {
        return 'WebSocketCollector';
    }

    async start(): Promise<void> {
        // TODO: 实现 WebSocket 连接和订阅
        wsLogger.info('Starting...');
    }

    async stop(): Promise<void> {
        // TODO: 实现断开连接
        wsLogger.info('Stopping...');
    }
}
