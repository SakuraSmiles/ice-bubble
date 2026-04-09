/**
 * SQLiteManager 测试脚本
 * 用于交叉测试和验收测试
 */

import { SQLiteManager, SQLiteError } from '../../src/storage/sqlite-manager.js';
import type { Session, SessionMessage, SQLiteManagerConfig } from '../../src/types/index.js';
import fs from 'fs';
import path from 'path';

// 测试配置 - 测试数据统一放在 tests/output/ 目录
const TEST_OUTPUT_DIR = path.join(__dirname, '..', 'output');
const TEST_DB_PATH = path.join(TEST_OUTPUT_DIR, 'sqlite-test.db');
const config: SQLiteManagerConfig = {
    dbPath: TEST_DB_PATH,
    walMode: true,
    foreignKeys: true,
};

// 测试结果统计
class TestRunner {
    private passed = 0;
    private failed = 0;
    private errors: string[] = [];

    async test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✅ ${name}`);
            this.passed++;
        } catch (error) {
            console.error(`❌ ${name}`);
            console.error(`   Error: ${error}`);
            this.failed++;
            this.errors.push(`${name}: ${error}`);
        }
    }

    assert(condition: boolean, message: string) {
        if (!condition) {
            throw new Error(message);
        }
    }

    report() {
        console.log('\n' + '='.repeat(60));
        console.log('测试结果汇总');
        console.log('='.repeat(60));
        console.log(`总计: ${this.passed + this.failed} 个测试`);
        console.log(`✅ 通过: ${this.passed} 个`);
        console.log(`❌ 失败: ${this.failed} 个`);
        console.log(`通过率: ${((this.passed / (this.passed + this.failed)) * 100).toFixed(1)}%`);

        if (this.errors.length > 0) {
            console.log('\n失败的测试:');
            this.errors.forEach((err, i) => {
                console.log(`${i + 1}. ${err}`);
            });
        }
        console.log('='.repeat(60));
    }
}

// 清理测试数据函数
function cleanupTestData() {
    console.log('\n🧹 清理测试数据...');
    
    // 删除测试输出目录（如果存在）
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
        try {
            // 删除目录及其所有内容
            fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
            console.log(`✅ 已删除测试输出目录: ${TEST_OUTPUT_DIR}`);
        } catch (error) {
            console.error(`❌ 删除测试输出目录失败: ${error}`);
        }
    } else {
        console.log('ℹ️  测试输出目录不存在，无需清理');
    }
}

async function main() {
    const runner = new TestRunner();
    let manager: SQLiteManager | null = null;

    console.log('🧪 SQLiteManager 测试开始\n');
    console.log('测试数据库路径:', TEST_DB_PATH);
    console.log();

    try {
        // 准备测试目录
        if (!fs.existsSync(TEST_OUTPUT_DIR)) {
            fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
            console.log('📁 创建测试输出目录:', TEST_OUTPUT_DIR);
        }

        // ========== TC-001: 数据库初始化 ==========
        await runner.test('TC-001: 数据库初始化', async () => {
            manager = new SQLiteManager();
            await manager.init(config);

            runner.assert(fs.existsSync(TEST_DB_PATH), '数据库文件未创建');
        });

        // ========== TC-002: 插入会话 ==========
        let testSession: Session;
        await runner.test('TC-002: 插入会话', async () => {
            testSession = {
                sessionKey: 'agent:test-agent:discord:account1:direct:peer1',
                agentId: 'test-agent',
                channel: 'discord',
                accountId: 'account1',
                peerId: 'peer1',
                createdAt: new Date(),
                updatedAt: new Date(),
                messageCount: 0,
            };

            await manager!.upsertSession(testSession);

            const retrieved = await manager!.getSession(testSession.sessionKey);
            runner.assert(retrieved !== null, '查询结果为 null');
            runner.assert(retrieved!.sessionKey === testSession.sessionKey, 'sessionKey 不匹配');
        });

        // ========== TC-003: 更新会话 ==========
        await runner.test('TC-003: 更新会话（重复插入）', async () => {
            testSession.messageCount = 5;
            testSession.updatedAt = new Date();
            await manager!.upsertSession(testSession);

            const retrieved = await manager!.getSession(testSession.sessionKey);
            runner.assert(retrieved!.messageCount === 5, 'messageCount 未更新');
        });

        // ========== TC-004: 批量插入消息 ==========
        await runner.test('TC-004: 批量插入消息', async () => {
            const messages: SessionMessage[] = [];
            for (let i = 0; i < 100; i++) {
                messages.push({
                    sessionKey: testSession.sessionKey,
                    messageType: i % 2 === 0 ? 'user' : 'agent',
                    content: `测试消息 ${i}`,
                    timestamp: new Date(Date.now() + i * 1000),
                });
            }

            const startTime = Date.now();
            const count = await manager!.batchInsertMessages(messages);
            const duration = Date.now() - startTime;

            runner.assert(count === 100, `插入数量不正确: ${count}`);
            runner.assert(duration < 100, `性能不达标: ${duration}ms`);

            // 验证 message_count 更新
            const session = await manager!.getSession(testSession.sessionKey);
            runner.assert(session!.messageCount === 105, `messageCount 未更新: ${session!.messageCount}`);
        });

        // ========== TC-005: 查询历史消息 ==========
        await runner.test('TC-005: 查询历史消息', async () => {
            const history = await manager!.getSessionHistory(testSession.sessionKey, { limit: 10 });

            runner.assert(history.length === 10, `返回数量不正确: ${history.length}`);

            // 验证按时间倒序
            for (let i = 0; i < history.length - 1; i++) {
                runner.assert(
                    history[i].timestamp >= history[i + 1].timestamp,
                    '消息未按时间倒序排列'
                );
            }
        });

        // ========== TC-006: 统计信息 ==========
        await runner.test('TC-006: 统计信息', async () => {
            const stats = await manager!.getStats();

            runner.assert(stats.totalSessions > 0, 'totalSessions 为 0');
            runner.assert(stats.totalMessages > 0, 'totalMessages 为 0');
            runner.assert(stats.dbSizeMB >= 0, 'dbSizeMB 为负数');
        });

        // ========== TC-007: 清理旧数据 ==========
        await runner.test('TC-007: 清理旧数据', async () => {
            // 插入旧数据
            const oldSession: Session = {
                sessionKey: 'agent:old-agent:discord:account1:direct:peer2',
                agentId: 'old-agent',
                channel: 'discord',
                createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
                updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
                messageCount: 0,
            };
            await manager!.upsertSession(oldSession);

            const oldMessage: SessionMessage = {
                sessionKey: oldSession.sessionKey,
                messageType: 'user',
                content: '旧消息',
                timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
            };
            await manager!.insertMessage(oldMessage);

            // 清理
            const result = await manager!.cleanOldData(30);
            runner.assert(result.messagesDeleted > 0, '旧消息未被删除');
            runner.assert(result.sessionsDeleted > 0, '旧会话未被删除');

            // 验证删除
            const session = await manager!.getSession(oldSession.sessionKey);
            runner.assert(session === null, '旧会话仍然存在');
        });

        // ========== TC-E01: 未初始化就操作 ==========
        await runner.test('TC-E01: 未初始化就操作', async () => {
            const uninitializedManager = new SQLiteManager();

            try {
                await uninitializedManager.getSession('test');
                throw new Error('应该抛出错误但没有抛出');
            } catch (error) {
                runner.assert(error instanceof SQLiteError, '错误类型不正确');
                runner.assert(
                    (error as SQLiteError).code === 'SQLITE_CONNECTION_CLOSED',
                    '错误码不正确'
                );
            }
        });

        // ========== TC-P01: 批量插入性能 ==========
        await runner.test('TC-P01: 批量插入性能（1000条）', async () => {
            const perfSession: Session = {
                sessionKey: 'agent:perf-agent:discord:account1:direct:peer3',
                agentId: 'perf-agent',
                channel: 'discord',
                createdAt: new Date(),
                updatedAt: new Date(),
                messageCount: 0,
            };
            await manager!.upsertSession(perfSession);

            const messages: SessionMessage[] = [];
            for (let i = 0; i < 1000; i++) {
                messages.push({
                    sessionKey: perfSession.sessionKey,
                    messageType: 'user',
                    content: `性能测试消息 ${i}`,
                    timestamp: new Date(),
                });
            }

            const startTime = Date.now();
            const count = await manager!.batchInsertMessages(messages);
            const duration = Date.now() - startTime;

            runner.assert(count === 1000, '插入数量不正确');
            runner.assert(duration < 200, `性能不达标: ${duration}ms`);
            console.log(`   ⏱️  执行时间: ${duration}ms`);
        });

        // ========== TC-008: 数据库关闭 ==========
        await runner.test('TC-008: 数据库关闭', async () => {
            await manager!.close();

            try {
                await manager!.getSession('test');
                throw new Error('关闭后仍能操作');
            } catch (error) {
                runner.assert(error instanceof SQLiteError, '错误类型不正确');
            }

            manager = null;
        });

        // 输出测试报告
        runner.report();

    } catch (error) {
        console.error('\n❌ 测试执行过程中发生错误:', error);
        runner.report();
    } finally {
        // 确保数据库关闭
        if (manager) {
            try {
                await manager.close();
            } catch (error) {
                // 忽略关闭错误
            }
        }

        // 清理测试数据
        cleanupTestData();

        // 退出码
        process.exit(runner['failed'] > 0 ? 1 : 0);
    }
}

main().catch(error => {
    console.error('测试执行失败:', error);
    process.exit(1);
});
