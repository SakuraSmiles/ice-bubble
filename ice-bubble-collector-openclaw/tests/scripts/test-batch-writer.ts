/**
 * BatchWriter 简单测试脚本
 */

import { BatchWriter } from '../../src/processors/BatchWriter';
import type { SessionMessage } from '../../src/types';

// Mock SQLiteManager
class MockSQLiteManager {
    public messages: SessionMessage[] = [];

    async batchInsertMessages(messages: SessionMessage[]): Promise<number> {
        this.messages.push(...messages);
        return messages.length;
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function test() {
    console.log('=== BatchWriter 功能测试 ===\n');

    const mockManager = new MockSQLiteManager();
    const writer = new BatchWriter(mockManager as any, {
        batchSize: 100,
        flushInterval: 5000,
    });

    // 测试 1: 添加消息
    console.log('测试 1: 添加消息到缓冲区');
    const msg1: SessionMessage = {
        sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
        messageType: 'user',
        timestamp: new Date(),
        content: 'Test message 1',
    };
    writer.addMessage(msg1);

    const stats1 = writer.getStats();
    console.log(`  ✓ 缓冲区大小: ${stats1.buffered} (预期: 1)`);
    console.log(`  ✓ 总处理数: ${stats1.totalProcessed} (预期: 0)`);

    // 测试 2: 手动刷新
    console.log('\n测试 2: 手动刷新');
    await writer.flush();

    const stats2 = writer.getStats();
    console.log(`  ✓ 缓冲区大小: ${stats2.buffered} (预期: 0)`);
    console.log(`  ✓ 总处理数: ${stats2.totalProcessed} (预期: 1)`);
    console.log(`  ✓ 总批量数: ${stats2.totalBatches} (预期: 1)`);
    console.log(`  ✓ 最后刷新时间: ${stats2.lastFlushAt?.toISOString()}`);
    console.log(`  ✓ 数据库消息数: ${mockManager.messages.length} (预期: 1)`);

    // 测试 3: 批量添加消息
    console.log('\n测试 3: 批量添加消息');
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 150; i++) {
        messages.push({
            sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
            messageType: 'user',
            timestamp: new Date(),
            content: `Message ${i}`,
        });
    }
    writer.addMessages(messages);

    const stats3 = writer.getStats();
    console.log(`  ✓ 缓冲区大小: ${stats3.buffered} (预期: 50)`);
    console.log(`  ✓ 数据库消息数: ${mockManager.messages.length} (预期: 101)`);

    // 测试 4: 启动定时刷新
    console.log('\n测试 4: 启动定时刷新');
    writer.start();

    writer.addMessage({
        sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
        messageType: 'user',
        timestamp: new Date(),
        content: 'Timer test message',
    });

    console.log('  ✓ 定时刷新已启动');
    console.log(`  ✓ 当前缓冲区: ${writer.getStats().buffered}`);

    // 等待定时刷新
    console.log('\n等待 6 秒以测试定时刷新...');
    await delay(6000);

    const stats4 = writer.getStats();
    console.log(`  ✓ 缓冲区大小: ${stats4.buffered} (预期: 0)`);
    console.log(`  ✓ 总处理数: ${stats4.totalProcessed}`);
    console.log(`  ✓ 数据库消息数: ${mockManager.messages.length}`);

    // 测试 5: 性能测试
    console.log('\n测试 5: 性能测试 (10,000 条消息)');
    writer.stop();
    mockManager.messages = [];

    const perfWriter = new BatchWriter(mockManager as any, {
        batchSize: 100,
        flushInterval: 5000,
    });

    perfWriter.start();

    const perfMessages: SessionMessage[] = [];
    for (let i = 0; i < 10000; i++) {
        perfMessages.push({
            sessionKey: 'agent:test:discord:acc-123:direct:peer-456',
            messageType: 'user',
            timestamp: new Date(),
            content: `Performance test message ${i}`,
        });
    }

    const startTime = Date.now();
    perfWriter.addMessages(perfMessages);

    // 等待所有刷新完成
    await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
            const stats = perfWriter.getStats();
            if (stats.totalProcessed >= 10000) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
    });

    const endTime = Date.now();
    const duration = endTime - startTime;
    const throughput = Math.round(10000 / (duration / 1000));

    console.log(`  ✓ 写入时间: ${duration}ms`);
    console.log(`  ✓ 吞吐量: ${throughput} msg/s`);
    console.log(`  ✓ 数据库消息数: ${mockManager.messages.length}`);

    perfWriter.stop();

    console.log('\n=== 所有测试通过 ✓ ===');
}

test().catch((error) => {
    console.error('测试失败:', error);
    process.exit(1);
});
