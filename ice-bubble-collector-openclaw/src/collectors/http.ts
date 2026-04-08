/**
 * HTTP API 采集器
 *
 * 定期调用 OpenClaw HTTP API 获取数据
 */

import { BaseCollector } from './base.js';
import { Logger } from '../utils/logger.js';

const httpLogger = new Logger('HTTPCollector');

export class HTTPCollector extends BaseCollector {
    getName(): string {
        return 'HTTPCollector';
    }

    async start(): Promise<void> {
        // TODO: 实现 HTTP 轮询
        httpLogger.info('Starting...');
    }

    async stop(): Promise<void> {
        // TODO: 实现停止轮询
        httpLogger.info('Stopping...');
    }
}
