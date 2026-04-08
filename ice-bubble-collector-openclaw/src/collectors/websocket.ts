/**
 * WebSocket 采集器
 *
 * 订阅 OpenClaw Gateway 的实时事件
 */

import { BaseCollector } from './base.js';

export class WebSocketCollector extends BaseCollector {
    getName(): string {
        return 'WebSocketCollector';
    }

    async start(): Promise<void> {
        // TODO: 实现 WebSocket 连接和订阅
        console.log('[WebSocketCollector] Starting...');
    }

    async stop(): Promise<void> {
        // TODO: 实现断开连接
        console.log('[WebSocketCollector] Stopping...');
    }
}
