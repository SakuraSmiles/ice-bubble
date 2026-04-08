/**
 * BatchWriter 单元测试
 *
 * 测试内容：
 * 1. 添加消息到缓冲区正确
 * 2. 缓冲区满时自动刷新
 * 3. 定时刷新功能正确
 * 4. 手动刷新功能正确
 * 5. 启动和停止功能正确
 * 6. 统计信息正确
 * 7. 错误处理正确（缓冲区恢复）
 * 8. 事件发送正确（flush、error）
 * 9. 边界情况：空缓冲区刷新
 * 10. 边界情况：批量添加消息
 * 11. 性能测试: 10,000 条消息写入时间 < 1s
 * 12. 性能测试: 批量大小对性能的影响
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchWriter, BatchWriterConfig, BatchWriterStats } from '../../../src/processors/BatchWriter';
import { SQLiteManager } from '../../../src/storage/sqlite-manager';
import type { SessionMessage } from '../../../src/types';

/**
 * Mock SQLiteManager
 */
class MockSQLiteManager {
    public messages: SessionMessage[] = [];

    async insertMessage(message: SessionMessage): Promise<number> {
        this.messages.push(message);
        return this.messages.length;
    }

    async batchInsertMessages(messages: SessionMessage[]): Promise<number> {
        this.messages.push(...messages);
        return messages.length;
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

describe('BatchWriter', () => {
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

    // ==================== 1. 添加消息到缓冲区正确 ====================

    describe('addMessage', () => {
        it('应该添加消息到缓冲区', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize: 10 });

            const message = createTestMessage();
            batchWriter.addMessage(message);

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(1);
        });

        it('应该更新缓冲区统计', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize: 10 });

            const messages = [
                createTestMessage({ content: 'msg1' }),
                createTestMessage({ content: 'msg2' }),
                createTestMessage({ content: 'msg3' }),
            ];

            messages.forEach((msg) => batchWriter.addMessage(msg));

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(3);
        });
    });

    // ==================== 2. 缓冲区满时自动刷新 ====================

    describe('缓冲区满时自动刷新', () => {
        it('缓冲区达到 batchSize 时应该自动刷新', async () => {
            const batchSize = 5;
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize, flushInterval: 10000 });

            batchWriter.start();

            // 监听 flush 事件
            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            // 添加消息到 batchSize
            for (let i = 0; i < batchSize; i++) {
                batchWriter.addMessage(createTestMessage({ content: `msg${i}` }));
            }

            // 等待刷新完成
            await delay(100);

            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: batchSize });
            expect(mockSQLiteManager.messages.length).toBe(batchSize);
        });

        it('超过 batchSize 时应该分批刷新', async () => {
            const batchSize = 5;
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize, flushInterval: 10000 });

            batchWriter.start();

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            // 添加超过 batchSize 的消息
            for (let i = 0; i < 7; i++) {
                batchWriter.addMessage(createTestMessage({ content: `msg${i}` }));
            }

            await delay(100);

            // 第一次刷新 5 条，剩余 2 条
            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: batchSize });

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(2);
        });
    });

    // ==================== 3. 定时刷新功能正确 ====================

    describe('定时刷新', () => {
        it('应该在 flushInterval 后自动刷新', async () => {
            const flushInterval = 100;
            batchWriter = new BatchWriter(mockSQLiteManager as any, {
                batchSize: 100,
                flushInterval,
            });

            batchWriter.start();

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            // 添加消息（不超过 batchSize）
            batchWriter.addMessage(createTestMessage());

            // 等待刷新
            await delay(flushInterval + 50);

            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: 1 });
        });

        it('添加消息时应该重置定时器', async () => {
            const flushInterval = 200;
            batchWriter = new BatchWriter(mockSQLiteManager as any, {
                batchSize: 100,
                flushInterval,
            });

            batchWriter.start();

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            // 添加第一条消息
            batchWriter.addMessage(createTestMessage());

            // 等待一半时间
            await delay(100);

            // 添加第二条消息（重置定时器）
            batchWriter.addMessage(createTestMessage());

            // 再等待一半时间（总共 200ms）
            await delay(100);

            // 此时应该还没有刷新
            expect(flushSpy).not.toHaveBeenCalled();

            // 再等待 100ms（总共 300ms，定时器重置后 200ms）
            await delay(150);

            // 现在应该刷新了
            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: 2 });
        });
    });

    // ==================== 4. 手动刷新功能正确 ====================

    describe('flush', () => {
        it('手动刷新应该清空缓冲区', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize: 100 });

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            await batchWriter.flush();

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(0);
            expect(mockSQLiteManager.messages.length).toBe(2);
        });

        it('空缓冲区刷新不应该抛错', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            await expect(batchWriter.flush()).resolves.not.toThrow();

            const stats = batchWriter.getStats();
            expect(stats.totalBatches).toBe(0);
        });

        it('刷新时应该发送 flush 事件', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            await batchWriter.flush();

            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: 3 });
        });
    });

    // ==================== 5. 启动和停止功能正确 ====================

    describe('start 和 stop', () => {
        it('start 应该启动定时刷新', async () => {
            const flushInterval = 100;
            batchWriter = new BatchWriter(mockSQLiteManager as any, { flushInterval });

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            batchWriter.addMessage(createTestMessage());

            // 启动前等待，不应该刷新
            await delay(flushInterval + 50);
            expect(flushSpy).not.toHaveBeenCalled();

            // 启动
            batchWriter.start();
            batchWriter.addMessage(createTestMessage());

            // 等待刷新
            await delay(flushInterval + 50);
            expect(flushSpy).toHaveBeenCalled();
        });

        it('stop 应该停止定时刷新并刷新剩余消息', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, {
                batchSize: 100,
                flushInterval: 10000,
            });

            batchWriter.start();

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            // 停止
            await batchWriter.stop();

            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: 2 });
        });

        it('重复 start 不应该创建多个定时器', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            batchWriter.start();
            batchWriter.start();
            batchWriter.start();

            // 不应该抛错
            expect(() => batchWriter.stop()).not.toThrow();
        });

        it('重复 stop 不应该抛错', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);
            batchWriter.start();

            await batchWriter.stop();
            await batchWriter.stop();

            // 不应该抛错
        });
    });

    // ==================== 6. 统计信息正确 ====================

    describe('getStats', () => {
        it('初始统计应该正确', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            const stats = batchWriter.getStats();

            expect(stats.buffered).toBe(0);
            expect(stats.totalProcessed).toBe(0);
            expect(stats.totalBatches).toBe(0);
            expect(stats.lastFlushAt).toBeNull();
        });

        it('添加消息后统计应该更新', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            const stats = batchWriter.getStats();

            expect(stats.buffered).toBe(2);
            expect(stats.totalProcessed).toBe(0);
        });

        it('刷新后统计应该更新', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            await batchWriter.flush();

            const stats = batchWriter.getStats();

            expect(stats.buffered).toBe(0);
            expect(stats.totalProcessed).toBe(3);
            expect(stats.totalBatches).toBe(1);
            expect(stats.lastFlushAt).toBeInstanceOf(Date);
        });

        it('多次刷新后统计应该累加', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            batchWriter.addMessage(createTestMessage());
            await batchWriter.flush();

            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());
            await batchWriter.flush();

            const stats = batchWriter.getStats();

            expect(stats.totalProcessed).toBe(3);
            expect(stats.totalBatches).toBe(2);
        });
    });

    // ==================== 7. 错误处理正确（缓冲区恢复） ====================

    describe('错误处理', () => {
        it('写入失败时应该恢复缓冲区', async () => {
            // 创建会失败的 Mock
            const failManager = {
                batchInsertMessages: vi.fn().mockRejectedValue(new Error('DB Error')),
            };

            batchWriter = new BatchWriter(failManager as any);

            const errorSpy = vi.fn();
            batchWriter.on('error', errorSpy);

            batchWriter.addMessage(createTestMessage());

            // 刷新应该抛错
            await expect(batchWriter.flush()).rejects.toThrow('DB Error');

            // 缓冲区应该恢复
            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(1);
            expect(errorSpy).toHaveBeenCalled();
        });

        it('写入失败时应该发送 error 事件', async () => {
            const error = new Error('Database connection failed');
            const failManager = {
                batchInsertMessages: vi.fn().mockRejectedValue(error),
            };

            batchWriter = new BatchWriter(failManager as any);

            const errorSpy = vi.fn();
            batchWriter.on('error', errorSpy);

            batchWriter.addMessage(createTestMessage());
            await batchWriter.flush().catch(() => {});

            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(error);
        });

        it('自动刷新失败时应该发送 error 事件', async () => {
            const error = new Error('Auto flush failed');
            const failManager = {
                batchInsertMessages: vi.fn().mockRejectedValue(error),
            };

            batchWriter = new BatchWriter(failManager as any, { batchSize: 2 });
            batchWriter.start();

            const errorSpy = vi.fn();
            batchWriter.on('error', errorSpy);

            // 添加消息触发自动刷新
            batchWriter.addMessage(createTestMessage());
            batchWriter.addMessage(createTestMessage());

            await delay(100);

            expect(errorSpy).toHaveBeenCalled();
        });
    });

    // ==================== 8. 事件发送正确 ====================

    describe('事件', () => {
        it('应该发送 flush 事件', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            batchWriter.addMessage(createTestMessage());
            await batchWriter.flush();

            expect(flushSpy).toHaveBeenCalledWith({ count: 1 });
        });

        it('应该发送 error 事件', async () => {
            const failManager = {
                batchInsertMessages: vi.fn().mockRejectedValue(new Error('Test error')),
            };

            batchWriter = new BatchWriter(failManager as any);

            const errorSpy = vi.fn();
            batchWriter.on('error', errorSpy);

            batchWriter.addMessage(createTestMessage());
            await batchWriter.flush().catch(() => {});

            expect(errorSpy).toHaveBeenCalled();
        });
    });

    // ==================== 9. 边界情况：空缓冲区刷新 ====================

    describe('边界情况', () => {
        it('空缓冲区刷新不应该执行任何操作', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any);

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            await batchWriter.flush();

            expect(flushSpy).not.toHaveBeenCalled();
            expect(mockSQLiteManager.messages.length).toBe(0);
        });
    });

    // ==================== 10. 边界情况：批量添加消息 ====================

    describe('addMessages', () => {
        it('应该批量添加消息', () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize: 10 });

            const messages = [
                createTestMessage({ content: 'msg1' }),
                createTestMessage({ content: 'msg2' }),
                createTestMessage({ content: 'msg3' }),
            ];

            batchWriter.addMessages(messages);

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(3);
        });

        it('批量添加超过 batchSize 时应该自动刷新', async () => {
            const batchSize = 5;
            batchWriter = new BatchWriter(mockSQLiteManager as any, { batchSize, flushInterval: 10000 });

            batchWriter.start();

            const flushSpy = vi.fn();
            batchWriter.on('flush', flushSpy);

            const messages = Array.from({ length: 7 }, (_, i) =>
                createTestMessage({ content: `msg${i}` })
            );

            batchWriter.addMessages(messages);

            await delay(100);

            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledWith({ count: batchSize });

            const stats = batchWriter.getStats();
            expect(stats.buffered).toBe(2);
        });
    });

    // ==================== 11. 性能测试: 10,000 条消息写入时间 < 1s ====================

    describe('性能测试', () => {
        it('10,000 条消息写入时间应该 < 1s', async () => {
            batchWriter = new BatchWriter(mockSQLiteManager as any, {
                batchSize: 100,
                flushInterval: 10000,
            });

            batchWriter.start();

            // 创建 10,000 条消息
            const messages = Array.from({ length: 10000 }, (_, i) =>
                createTestMessage({
                    content: `Message ${i}`,
                    timestamp: new Date(Date.now() + i),
                })
            );

            const startTime = Date.now();

            // 批量添加
            batchWriter.addMessages(messages);

            // 等待所有刷新完成
            await new Promise<void>((resolve) => {
                let processedCount = 0;
                batchWriter.on('flush', ({ count }) => {
                    processedCount += count;
                    if (processedCount >= 10000) {
                        resolve();
                    }
                });
            });

            const endTime = Date.now();
            const duration = endTime - startTime;

            console.log(`Performance: 10,000 messages written in ${duration}ms`);
            console.log(`Throughput: ${Math.round(10000 / (duration / 1000))} msg/s`);

            expect(duration).toBeLessThan(1000);
            expect(mockSQLiteManager.messages.length).toBe(10000);
        }, 10000); // 设置测试超时时间为 10s

        // ==================== 12. 性能测试: 批量大小对性能的影响 ====================

        it('批量大小对性能的影响', async () => {
            const testBatchSizes = [10, 50, 100, 500];
            const results: { batchSize: number; duration: number; throughput: number }[] = [];

            for (const batchSize of testBatchSizes) {
                mockSQLiteManager.clear();

                batchWriter = new BatchWriter(mockSQLiteManager as any, {
                    batchSize,
                    flushInterval: 10000,
                });

                batchWriter.start();

                const messages = Array.from({ length: 5000 }, (_, i) =>
                    createTestMessage({
                        content: `Message ${i}`,
                        timestamp: new Date(Date.now() + i),
                    })
                );

                const startTime = Date.now();

                batchWriter.addMessages(messages);

                await new Promise<void>((resolve) => {
                    let processedCount = 0;
                    batchWriter.on('flush', ({ count }) => {
                        processedCount += count;
                        if (processedCount >= 5000) {
                            resolve();
                        }
                    });
                });

                const endTime = Date.now();
                const duration = endTime - startTime;
                const throughput = Math.round(5000 / (duration / 1000));

                results.push({ batchSize, duration, throughput });

                await batchWriter.stop();
            }

            console.log('\n=== Batch Size Performance Comparison ===');
            console.table(results);

            // 较大的批量大小应该有更好的吞吐量
            expect(results[results.length - 1].throughput).toBeGreaterThan(results[0].throughput);
        }, 30000); // 设置测试超时时间为 30s
    });
});
