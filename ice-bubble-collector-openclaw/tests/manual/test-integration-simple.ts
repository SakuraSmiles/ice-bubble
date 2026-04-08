/**
 * 简单集成测试 - 验证基本功能
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import type { UnifiedMessage } from '../../src/types';

async function main() {
    console.log('🧪 简单集成测试\n');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-test-'));
    const agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const dbPath = path.join(tempDir, 'test.db');
    const messages: UnifiedMessage[] = [];
    const invalidMessages: Array<{ message: UnifiedMessage; errors: string[] }> = [];
    const duplicates: string[] = [];
    const batchFlushes: number[] = [];

    try {
        // 创建采集器
        const collector = new FileCollector({
            openclawDataDir: tempDir,
            dbPath: dbPath,
            enableWatch: false,
            batchSize: 10,
        });

        // 监听事件
        collector.on('message', (msg: UnifiedMessage) => {
            messages.push(msg);
            console.log(`📨 收到消息: ${msg.id} (${msg.messageType})`);
        });

        collector.on('invalid', (event: { message: UnifiedMessage; errors: string[] }) => {
            invalidMessages.push(event);
            console.log(`❌ 验证失败: ${event.message.id}`);
            console.log(`   错误: ${event.errors.join(', ')}`);
        });

        collector.on('duplicate', (event: { messageId: string }) => {
            duplicates.push(event.messageId);
            console.log(`🔁 重复消息: ${event.messageId}`);
        });

        collector.on('batch:flush', (event: { count: number }) => {
            batchFlushes.push(event.count);
            console.log(`💾 批量写入: ${event.count} 条消息`);
        });

        // 创建测试文件
        const agentDir = path.join(agentsDir, 'test-agent', 'sessions');
        fs.mkdirSync(agentDir, { recursive: true });
        const filePath = path.join(agentDir, 'test-session.jsonl');

        const now = Date.now();
        const lines = [
            // User 消息
            JSON.stringify({
                type: 'message',
                id: 'msg-1',
                parentId: null,
                timestamp: new Date(now - 2000).toISOString(),
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'Hello' }],
                    timestamp: now - 2000,
                },
            }),
            // Agent 消息
            JSON.stringify({
                type: 'message',
                id: 'msg-2',
                parentId: 'msg-1',
                timestamp: new Date(now - 1000).toISOString(),
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Hi there!' }],
                    model: 'test-model',
                    timestamp: now - 1000,
                },
            }),
            // ToolResult 消息
            JSON.stringify({
                type: 'message',
                id: 'msg-3',
                parentId: 'msg-2',
                timestamp: new Date(now).toISOString(),
                message: {
                    role: 'toolResult',
                    toolCallId: 'call-1',
                    toolName: 'exec',
                    content: [{ type: 'text', text: 'result' }],
                    timestamp: now,
                },
            }),
        ];

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

        console.log('📂 测试文件已创建\n');

        // 启动采集器
        console.log('🚀 启动采集器...\n');
        await collector.start();

        // 等待处理
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 停止采集器
        console.log('\n🛑 停止采集器...\n');
        await collector.stop();

        // 验证结果
        console.log('📊 测试结果:\n');
        console.log(`  有效消息: ${messages.length}`);
        console.log(`  验证失败: ${invalidMessages.length}`);
        console.log(`  重复消息: ${duplicates.length}`);
        console.log(`  批量写入: ${batchFlushes.length} 次\n`);

        if (invalidMessages.length > 0) {
            console.log('❌ 验证失败详情:\n');
            invalidMessages.forEach((inv, i) => {
                console.log(`  ${i + 1}. 消息ID: ${inv.message.id}`);
                console.log(`     类型: ${inv.message.messageType}`);
                console.log(`     错误: ${inv.errors.join(', ')}\n`);
            });
        }

        if (messages.length === 3) {
            console.log('✅ 测试通过!所有消息处理正常。\n');
        } else {
            console.log(`⚠️  测试失败!预期 3 条消息,实际 ${messages.length} 条。\n`);
        }

    } finally {
        // 清理
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
}

main().catch(console.error);
