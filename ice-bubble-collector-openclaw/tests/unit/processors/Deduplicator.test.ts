/**
 * 去重器（Deduplicator）单元测试
 */

import { Deduplicator } from '../../../src/processors/Deduplicator';
import { UnifiedMessage } from '../../../src/types';

describe('Deduplicator', () => {
    let deduplicator: Deduplicator;

    // 辅助函数：创建测试消息
    function createMessage(id: string, timestamp: Date = new Date()): UnifiedMessage {
        return {
            id,
            sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
            messageType: 'user',
            timestamp,
            source: 'websocket',
            content: `Test message ${id}`,
        };
    }

    beforeEach(() => {
        deduplicator = new Deduplicator({ cacheSize: 100 });
    });

    // ==================== 基础功能测试 ====================

    describe('基础功能', () => {
        test('✅ 不重复的消息正确通过', () => {
            const msg1 = createMessage('msg-1');
            const msg2 = createMessage('msg-2');
            const msg3 = createMessage('msg-3');

            expect(deduplicator.isDuplicate('msg-1')).toBe(false);
            expect(deduplicator.isDuplicate('msg-2')).toBe(false);
            expect(deduplicator.isDuplicate('msg-3')).toBe(false);
        });

        test('✅ 重复的消息被正确识别', () => {
            const msgId = 'msg-duplicate';

            // 第一次检查：不重复
            expect(deduplicator.isDuplicate(msgId)).toBe(false);

            // 标记为已处理
            deduplicator.markAsProcessed(msgId);

            // 第二次检查：重复
            expect(deduplicator.isDuplicate(msgId)).toBe(true);
        });

        test('✅ markAsProcessed 正确标记消息', () => {
            deduplicator.markAsProcessed('msg-1');
            expect(deduplicator.isDuplicate('msg-1')).toBe(true);

            deduplicator.markAsProcessed('msg-2');
            expect(deduplicator.isDuplicate('msg-2')).toBe(true);
        });

        test('✅ clear() 方法正确清空缓存', () => {
            deduplicator.markAsProcessed('msg-1');
            deduplicator.markAsProcessed('msg-2');
            deduplicator.markAsProcessed('msg-3');

            expect(deduplicator.size()).toBe(3);

            deduplicator.clear();

            expect(deduplicator.size()).toBe(0);
            expect(deduplicator.isDuplicate('msg-1')).toBe(false);
            expect(deduplicator.isDuplicate('msg-2')).toBe(false);
        });

        test('✅ size() 方法返回正确的缓存大小', () => {
            expect(deduplicator.size()).toBe(0);

            deduplicator.markAsProcessed('msg-1');
            expect(deduplicator.size()).toBe(1);

            deduplicator.markAsProcessed('msg-2');
            expect(deduplicator.size()).toBe(2);

            // 重复标记不应该增加缓存大小
            deduplicator.markAsProcessed('msg-1');
            expect(deduplicator.size()).toBe(2);
        });
    });

    // ==================== 批量过滤测试 ====================

    describe('批量过滤', () => {
        test('✅ filterDuplicates 正确过滤重复消息', () => {
            const messages = [
                createMessage('msg-1'),
                createMessage('msg-2'),
                createMessage('msg-1'), // 重复
                createMessage('msg-3'),
                createMessage('msg-2'), // 重复
            ];

            const unique = deduplicator.filterDuplicates(messages);

            expect(unique).toHaveLength(3);
            expect(unique.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
        });

        test('✅ filterWithStats 返回正确的统计信息', () => {
            const messages = [
                createMessage('msg-1'),
                createMessage('msg-2'),
                createMessage('msg-1'), // 重复
                createMessage('msg-3'),
                createMessage('msg-2'), // 重复
                createMessage('msg-1'), // 重复
            ];

            const { unique, stats } = deduplicator.filterWithStats(messages);

            expect(unique).toHaveLength(3);
            expect(stats.total).toBe(6);
            expect(stats.duplicates).toBe(3);
            expect(stats.unique).toBe(3);
            expect(stats.hitRate).toBe(0.5); // 3/6
        });

        test('✅ 空消息列表正确处理', () => {
            const unique = deduplicator.filterDuplicates([]);
            expect(unique).toHaveLength(0);

            const { unique: uniqueWithStats, stats } = deduplicator.filterWithStats([]);
            expect(uniqueWithStats).toHaveLength(0);
            expect(stats.total).toBe(0);
            expect(stats.duplicates).toBe(0);
            expect(stats.unique).toBe(0);
            expect(stats.hitRate).toBe(0);
        });

        test('✅ 所有消息都重复的情况', () => {
            const messages = [
                createMessage('msg-1'),
                createMessage('msg-1'),
                createMessage('msg-1'),
            ];

            const unique = deduplicator.filterDuplicates(messages);

            expect(unique).toHaveLength(1);
            expect(unique[0].id).toBe('msg-1');
        });
    });

    // ==================== LRU 缓存淘汰测试 ====================

    describe('LRU 缓存淘汰', () => {
        test('✅ 缓存满时自动淘汰最久未使用的条目', () => {
            const smallCache = new Deduplicator({ cacheSize: 3 });

            // 添加 3 条消息
            smallCache.markAsProcessed('msg-1');
            smallCache.markAsProcessed('msg-2');
            smallCache.markAsProcessed('msg-3');

            expect(smallCache.size()).toBe(3);
            expect(smallCache.isDuplicate('msg-1')).toBe(true);
            expect(smallCache.isDuplicate('msg-2')).toBe(true);
            expect(smallCache.isDuplicate('msg-3')).toBe(true);

            // 添加第 4 条消息，应该淘汰 msg-1
            smallCache.markAsProcessed('msg-4');

            expect(smallCache.size()).toBe(3);
            expect(smallCache.isDuplicate('msg-1')).toBe(false); // 被淘汰
            expect(smallCache.isDuplicate('msg-2')).toBe(true);
            expect(smallCache.isDuplicate('msg-3')).toBe(true);
            expect(smallCache.isDuplicate('msg-4')).toBe(true);
        });

        test('✅ LRU 缓存淘汰顺序正确', () => {
            const smallCache = new Deduplicator({ cacheSize: 3 });

            // 添加 3 条消息
            smallCache.markAsProcessed('msg-1');
            smallCache.markAsProcessed('msg-2');
            smallCache.markAsProcessed('msg-3');

            // 访问 msg-1，使其成为最近使用
            smallCache.isDuplicate('msg-1');

            // 添加第 4 条消息，应该淘汰 msg-2（最久未使用）
            smallCache.markAsProcessed('msg-4');

            expect(smallCache.isDuplicate('msg-1')).toBe(true); // 最近访问过
            expect(smallCache.isDuplicate('msg-2')).toBe(false); // 被淘汰
            expect(smallCache.isDuplicate('msg-3')).toBe(true);
            expect(smallCache.isDuplicate('msg-4')).toBe(true);
        });

        test('✅ 缓存大小为 0 时正常工作', () => {
            const zeroCache = new Deduplicator({ cacheSize: 0 });

            const msg = createMessage('msg-1');
            const unique = zeroCache.filterDuplicates([msg]);

            // 缓存大小为 0，无法存储，每次都返回 false
            expect(unique).toHaveLength(1);
            expect(zeroCache.size()).toBe(0);
        });

        test('✅ 连续淘汰多个条目', () => {
            const smallCache = new Deduplicator({ cacheSize: 2 });

            smallCache.markAsProcessed('msg-1');
            smallCache.markAsProcessed('msg-2');
            smallCache.markAsProcessed('msg-3');
            smallCache.markAsProcessed('msg-4');

            expect(smallCache.size()).toBe(2);
            expect(smallCache.isDuplicate('msg-1')).toBe(false);
            expect(smallCache.isDuplicate('msg-2')).toBe(false);
            expect(smallCache.isDuplicate('msg-3')).toBe(true);
            expect(smallCache.isDuplicate('msg-4')).toBe(true);
        });
    });

    // ==================== 性能测试 ====================

    describe('性能测试', () => {
        test('✅ 10,000 条消息去重时间 < 50ms', () => {
            const messages: UnifiedMessage[] = [];
            for (let i = 0; i < 10000; i++) {
                messages.push(createMessage(`msg-${i}`));
            }

            const start = performance.now();
            const unique = deduplicator.filterDuplicates(messages);
            const duration = performance.now() - start;

            expect(unique).toHaveLength(10000);
            expect(duration).toBeLessThan(50);
            console.log(`  10,000 条消息去重耗时: ${duration.toFixed(2)}ms`);
        });

        test('✅ 批量去重性能测试（含重复）', () => {
            // 使用独立实例，避免 beforeEach 的影响
            const perfDedup = new Deduplicator({ cacheSize: 10000 });
            
            // 先添加前 5000 条消息到缓存
            const firstBatch: UnifiedMessage[] = [];
            for (let i = 0; i < 5000; i++) {
                firstBatch.push(createMessage(`msg-${i}`));
            }
            perfDedup.filterDuplicates(firstBatch);

            // 再处理 10000 条消息（前 5000 条重复，后 5000 条新消息）
            const messages: UnifiedMessage[] = [];
            for (let i = 0; i < 5000; i++) {
                messages.push(createMessage(`msg-${i}`)); // 重复
            }
            for (let i = 5000; i < 10000; i++) {
                messages.push(createMessage(`msg-${i}`)); // 新消息
            }

            const start = performance.now();
            const { unique, stats } = perfDedup.filterWithStats(messages);
            const duration = performance.now() - start;

            expect(unique).toHaveLength(5000);
            expect(stats.hitRate).toBeCloseTo(0.5, 2);
            expect(duration).toBeLessThan(50);
            console.log(`  10,000 条消息（50% 重复）去重耗时: ${duration.toFixed(2)}ms`);
        });

        test('✅ 缓存查找 O(1) 时间复杂度验证', () => {
            const largeCache = new Deduplicator({ cacheSize: 10000 });

            // 填充缓存
            for (let i = 0; i < 10000; i++) {
                largeCache.markAsProcessed(`msg-${i}`);
            }

            // 测试查找性能（应该在 O(1) 时间内完成）
            const iterations = 10000;
            const start = performance.now();

            for (let i = 0; i < iterations; i++) {
                largeCache.isDuplicate(`msg-${i % 10000}`);
            }

            const duration = performance.now() - start;
            const avgTime = duration / iterations;

            console.log(`  10,000 次查找总耗时: ${duration.toFixed(2)}ms`);
            console.log(`  平均每次查找: ${avgTime.toFixed(4)}ms`);

            // 平均查找时间应该非常小（O(1) 特征）
            expect(avgTime).toBeLessThan(0.01); // < 0.01ms per lookup
        });

        test('✅ 去重速度达到 200,000 msg/s 目标', () => {
            const messages: UnifiedMessage[] = [];
            for (let i = 0; i < 100000; i++) {
                messages.push(createMessage(`msg-${i}`));
            }

            const start = performance.now();
            const unique = deduplicator.filterDuplicates(messages);
            const duration = performance.now() - start;

            const msgsPerSecond = (unique.length / duration) * 1000;

            expect(unique).toHaveLength(100000);
            console.log(`  去重速度: ${msgsPerSecond.toFixed(0)} msg/s`);
            console.log(`  100,000 条消息耗时: ${duration.toFixed(2)}ms`);

            // 验证达到 200,000 msg/s 目标
            expect(msgsPerSecond).toBeGreaterThan(200000);
        });
    });

    // ==================== 边界情况测试 ====================

    describe('边界情况', () => {
        test('✅ 处理特殊字符的消息 ID', () => {
            const specialIds = [
                'msg:with:colons',
                'msg-with-dashes',
                'msg_with_underscores',
                'msg.with.dots',
                'msg/with/slashes',
                'msg 中文测试',
                'msg🔥emoji',
            ];

            for (const id of specialIds) {
                expect(deduplicator.isDuplicate(id)).toBe(false);
                deduplicator.markAsProcessed(id);
                expect(deduplicator.isDuplicate(id)).toBe(true);
            }
        });

        test('✅ 处理空字符串消息 ID', () => {
            expect(deduplicator.isDuplicate('')).toBe(false);
            deduplicator.markAsProcessed('');
            expect(deduplicator.isDuplicate('')).toBe(true);
        });

        test('✅ 处理超长消息 ID', () => {
            const longId = 'msg-' + 'x'.repeat(1000);

            expect(deduplicator.isDuplicate(longId)).toBe(false);
            deduplicator.markAsProcessed(longId);
            expect(deduplicator.isDuplicate(longId)).toBe(true);
        });

        test('✅ 默认配置正常工作', () => {
            const defaultDedup = new Deduplicator();

            expect(defaultDedup.size()).toBe(0);

            defaultDedup.markAsProcessed('msg-1');
            expect(defaultDedup.size()).toBe(1);
            expect(defaultDedup.isDuplicate('msg-1')).toBe(true);
        });
    });

    // ==================== 并发安全测试 ====================

    describe('并发安全', () => {
        test('✅ 多次标记同一条消息不会出错', () => {
            for (let i = 0; i < 100; i++) {
                deduplicator.markAsProcessed('msg-1');
            }

            expect(deduplicator.size()).toBe(1);
            expect(deduplicator.isDuplicate('msg-1')).toBe(true);
        });

        test('✅ 批量处理时的线程安全性', () => {
            const largeCache = new Deduplicator({ cacheSize: 10000 });
            
            const messages1 = Array.from({ length: 1000 }, (_, i) =>
                createMessage(`batch1-msg-${i}`)
            );
            const messages2 = Array.from({ length: 1000 }, (_, i) =>
                createMessage(`batch2-msg-${i}`)
            );

            // 模拟并发处理
            const unique1 = largeCache.filterDuplicates(messages1);
            const unique2 = largeCache.filterDuplicates(messages2);

            expect(unique1).toHaveLength(1000);
            expect(unique2).toHaveLength(1000);
            expect(largeCache.size()).toBe(2000);
        });
    });
});
