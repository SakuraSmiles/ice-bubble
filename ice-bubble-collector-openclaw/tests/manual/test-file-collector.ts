/**
 * FileCollector 手动测试脚本
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import type { UnifiedMessage } from '../../src/types';

async function main() {
    console.log('🧪 FileCollector 手动测试\n');

    // 创建临时目录
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-collector-test-'));
    const agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // 创建临时数据库
    const dbPath = path.join(tempDir, 'test.db');

    console.log(`📁 临时目录: ${tempDir}`);
    console.log(`🗄️  数据库路径: ${dbPath}\n`);

    // 创建测试文件
    const agentDir = path.join(agentsDir, 'test-agent', 'sessions');
    fs.mkdirSync(agentDir, { recursive: true });
    const filePath = path.join(agentDir, 'test-session.jsonl');

    const messages: UnifiedMessage[] = [];
    const errors: Error[] = [];
    const invalidMessages: any[] = [];
    const duplicateMessages: string[] = [];
    const batchFlushes: number[] = [];

    try {
        // 创建测试数据
        const now = Date.now();
        const lines = [
            JSON.stringify({
                type: 'message',
                id: 'msg-1',
                parentId: null,
                timestamp: new Date(now - 2000).toISOString(), // 2秒前
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'Hello World' }],
                    timestamp: now - 2000,
                },
            }),
            JSON.stringify({
                type: 'message',
                id: 'msg-2',
                parentId: null,
                timestamp: new Date(now - 1000).toISOString(), // 1秒前
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Hi there!' }],
                    model: 'test-model',
                    timestamp: now - 1000,
                },
            }),
            JSON.stringify({
                type: 'message',
                id: 'msg-1', // 重复消息
                parentId: null,
                timestamp: new Date(now - 500).toISOString(), // 0.5秒前
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'Duplicate' }],
                    timestamp: now - 500,
                },
            }),
        ];

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        console.log(`✅ 创建测试文件: ${filePath}\n`);

        // 创建采集器
        const collector = new FileCollector({
            openclawDataDir: tempDir,
            dbPath: dbPath,
            enableWatch: false,
            batchSize: 10,
            enableIncremental: true,
        });

        // 监听事件
        collector.on('message', (msg: UnifiedMessage) => {
            messages.push(msg);
            console.log(`📨 收到消息: ${msg.id} (${msg.messageType})`);
        });

        collector.on('error', (err: Error) => {
            errors.push(err);
            console.error(`❌ 错误:`, err.message);
            console.error(`堆栈:`, err.stack);
        });

        collector.on('invalid', (data: any) => {
            invalidMessages.push(data);
            console.warn(`⚠️  无效消息: ${data.message.id}`, data.errors);
        });

        collector.on('duplicate', (data: { messageId: string }) => {
            duplicateMessages.push(data.messageId);
            console.log(`🔄 重复消息: ${data.messageId}`);
        });

        collector.on('batch:flush', (data: { count: number }) => {
            batchFlushes.push(data.count);
            console.log(`💾 批量写入完成: ${data.count} 条消息`);
        });

        console.log('🚀 启动采集器...\n');
        await collector.start();

        // 等待处理完成
        await new Promise(resolve => setTimeout(resolve, 1000));

        console.log('\n🛑 停止采集器...\n');
        await collector.stop();

        // 等待数据库完全关闭
        await new Promise(resolve => setTimeout(resolve, 500));

        // 输出统计信息
        console.log('='.repeat(60));
        console.log('📊 测试结果');
        console.log('='.repeat(60));
        console.log(`总消息数: ${messages.length}`);
        console.log(`错误数: ${errors.length}`);
        console.log(`无效消息数: ${invalidMessages.length}`);
        console.log(`重复消息数: ${duplicateMessages.length}`);
        console.log(`批量写入次数: ${batchFlushes.length}`);
        console.log(`批量写入总数: ${batchFlushes.reduce((a, b) => a + b, 0)}`);
        console.log('='.repeat(60));

        // 输出统计信息
        const stats = collector.getStats();
        console.log('\n📈 采集器统计:');
        console.log(JSON.stringify(stats, null, 2));

        // 验证结果
        console.log('\n✅ 验证结果:');
        console.log(`  - 成功处理消息: ${messages.length === 2 ? '✓' : '✗'}`);
        console.log(`  - 检测到重复: ${duplicateMessages.length === 1 ? '✓' : '✗'}`);
        console.log(`  - 批量写入正确: ${batchFlushes.reduce((a, b) => a + b, 0) === 2 ? '✓' : '✗'}`);

    } finally {
        // 清理临时目录
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log(`\n🧹 已清理临时目录: ${tempDir}`);
        }
    }
}

main().catch(error => {
    console.error('❌ 测试失败:', error);
    process.exit(1);
});
