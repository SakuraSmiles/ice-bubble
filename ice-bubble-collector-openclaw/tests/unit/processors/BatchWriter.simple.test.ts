/**
 * BatchWriter 单元测试（简化版）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchWriter } from '../../../src/processors/BatchWriter';
import type { SessionMessage } from '../../../src/types';

/**
 * Mock SQLiteManager
 */
class MockSQLiteManager {
    public messages: SessionMessage[] = [];

    async batchInsertMessages(messages: SessionMessage[]): Promise<{ inserted: number; duplicates: number }> {
        this.messages.push(...messages);
        return { inserted: messages.length, duplicates: 0 };
    }

    clear(): void {
        this.messages = [];
    }
}

/**
 * 创建测试消息
 */
function createTestMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
    return {
        sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
        messageType: 'user',
        timestamp: new Date(),
        ...overrides,
    };
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BatchWriter 简化测试', () => {
    let mockSQLiteManager: MockSQLiteManager;
    let batchWriter: BatchWriter;

    beforeEach(() => {
        mockSQLiteManager = new MockSQLiteManager();
    });

    afterEach(() => {
        if (batchWriter) {
            batchWriter.stop();
        }
    });

    it('测试 1: 添加消息到缓冲区', () => {
        batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize: 10 });

        const message = createTestMessage();
        batchWriter.addMessage(message);

        const stats = batchWriter.getStats();
        expect(stats.buffered).toBe(1);
        console.log('✓ 测试 1 通过: 添加消息到缓冲区');
    });

    it('测试 2: 手动刷新', async () => {
        batchWriter = new BatchWriter(mockSQLiteManager as any);

        batchWriter.addMessage(createTestMessage());
        batchWriter.addMessage(createTestMessage());

        await batchWriter.flush();

        const stats = batchWriter.getStats();
        expect(stats.buffered).toBe(0);
        expect(stats.totalProcessed).toBe(2);
        expect(stats.totalBatches).toBe(1);
        expect(mockSQLiteManager.messages.length).toBe(2);
        console.log('✓ 测试 2 通过: 手动刷新');
    });

    it('测试 3: 缓冲区满时自动刷新', async () => {
        const batchSize = 5;
        batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize, flushInterval: 10000 });

        batchWriter.start();

        const flushSpy = vi.fn();
        batchWriter.on('flush', flushSpy);

        for (let i = 0; i < batchSize; i++) {
            batchWriter.addMessage(createTestMessage({ content: `msg${i}` }));
        }

        await delay(100);

        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(flushSpy).toHaveBeenCalledWith({ count: batchSize, duplicates: 0 });
        console.log('✓ 测试 3 通过: 缓冲区满时自动刷新');
    });

    it('测试 4: 定时刷新', async () => {
        const flushInterval = 100;
        batchWriter = new BatchWriter(mockSQLiteManager as any, {
            batchSize: 100,
            flushInterval,
        });

        batchWriter.start();

        const flushSpy = vi.fn();
        batchWriter.on('flush', flushSpy);

        batchWriter.addMessage(createTestMessage());

        await delay(flushInterval + 50);

        expect(flushSpy).toHaveBeenCalledTimes(1);
        console.log('✓ 测试 4 通过: 定时刷新');
    });

    it('测试 5: 启动和停止', async () => {
        batchWriter = new BatchWriter(mockSQLiteManager as any, {
            batchSize: 100,
            flushInterval: 10000,
        });

        batchWriter.start();

        const flushSpy = vi.fn();
        batchWriter.on('flush', flushSpy);

        batchWriter.addMessage(createTestMessage());
        batchWriter.addMessage(createTestMessage());

        await batchWriter.stop();

        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(flushSpy).toHaveBeenCalledWith({ count: 2, duplicates: 0 });
        console.log('✓ 测试 5 通过: 启动和停止');
    });

    it('测试 6: 统计信息', async () => {
        batchWriter = new BatchWriter(mockSQLiteManager as any);

        const initialStats = batchWriter.getStats();
        expect(initialStats.buffered).toBe(0);
        expect(initialStats.totalProcessed).toBe(0);
        expect(initialStats.totalBatches).toBe(0);

        batchWriter.addMessage(createTestMessage());
        await batchWriter.flush();

        const afterStats = batchWriter.getStats();
        expect(afterStats.totalProcessed).toBe(1);
        expect(afterStats.totalBatches).toBe(1);
        expect(afterStats.lastFlushAt).toBeInstanceOf(Date);
        console.log('✓ 测试 6 通过: 统计信息');
    });

    it('测试 7: 错误处理', async () => {
        const failManager = {
            batchInsertMessages: vi.fn().mockRejectedValue(new Error('DB Error')),
        };

        batchWriter = new BatchWriter(failManager as any);

        const errorSpy = vi.fn();
        batchWriter.on('error', errorSpy);

        batchWriter.addMessage(createTestMessage());

        await expect(batchWriter.flush()).rejects.toThrow('DB Error');

        const stats = batchWriter.getStats();
        expect(stats.buffered).toBe(0);
        expect(stats.failedBuffered).toBe(1);
        expect(errorSpy).toHaveBeenCalled();
        console.log('✓ 测试 7 通过: 错误处理');
    });

    it('测试 8: 性能测试 (1,000 条消息)', async () => {
        batchWriter = new BatchWriter(mockSQLiteManager as any, {
            batchSize: 100,
            flushInterval: 10000,
        });

        batchWriter.start();

        const messages = Array.from({ length: 1000 }, (_, i) =>
            createTestMessage({
                content: `Message ${i}`,
                timestamp: new Date(Date.now() + i),
            })
        );

        const startTime = Date.now();
        batchWriter.addMessages(messages);

        await new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
                const stats = batchWriter.getStats();
                if (stats.totalProcessed >= 1000) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });

        const endTime = Date.now();
        const duration = endTime - startTime;
        const throughput = Math.round(1000 / (duration / 1000));

        console.log(`  ✓ 写入时间: ${duration}ms`);
        console.log(`  ✓ 吞吐量: ${throughput} msg/s`);

        expect(duration).toBeLessThan(1000);
        expect(mockSQLiteManager.messages.length).toBe(1000);
        console.log('✓ 测试 8 通过: 性能测试');
    }, 10000);
});
