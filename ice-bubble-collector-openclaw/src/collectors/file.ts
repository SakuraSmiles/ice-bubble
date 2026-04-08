/**
 * 文件采集器
 *
 * 监听 .jsonl 文件变更，增量读取数据
 */

import { BaseCollector } from './base.js';

export class FileCollector extends BaseCollector {
    getName(): string {
        return 'FileCollector';
    }

    async start(): Promise<void> {
        // TODO: 实现文件监听
        console.log('[FileCollector] Starting...');
    }

    async stop(): Promise<void> {
        // TODO: 实现停止监听
        console.log('[FileCollector] Stopping...');
    }
}
