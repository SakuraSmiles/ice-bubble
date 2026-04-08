/**
 * 快速测试 - 验证 FileCollector 集成修复
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../src/types/index';

async function quickTest() {
  console.log('🚀 开始快速测试...\n');

  // 创建临时目录
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-test-'));
  const agentsDir = path.join(tempDir, 'agents');
  const agentDir = path.join(agentsDir, 'test-agent', 'sessions');
  fs.mkdirSync(agentDir, { recursive: true });

  const filePath = path.join(agentDir, 'test-session.jsonl');
  const now = Date.now();

  // 创建测试数据（使用过去的时间戳）
  const lines = [
    // Session 事件
    JSON.stringify({
      type: 'session',
      id: 'session-1',
      parentId: null,
      timestamp: new Date(now - 3000).toISOString(),
      version: 1,
      cwd: '/test',
    }),
    // User 消息
    JSON.stringify({
      type: 'message',
      id: 'msg-1',
      parentId: null,
      timestamp: new Date(now - 2000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: '帮我分析错误' }],
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
        content: [
          { type: 'thinking', thinking: '思考中...', thinkingSignature: 'sig-1' },
          { type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'ls' } },
          { type: 'text', text: '我来帮你分析' },
        ],
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        usage: {
          input: 100,
          output: 200,
          totalTokens: 300,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
        stopReason: 'toolUse',
        timestamp: now - 1000,
      },
    }),
    // ToolResult 消息
    JSON.stringify({
      type: 'message',
      id: 'msg-3',
      parentId: 'msg-2',
      timestamp: new Date(now - 500).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
        details: {
          status: 'completed',
          exitCode: 0,
          durationMs: 150,
        },
        timestamp: now - 500,
      },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  console.log('✅ 测试文件已创建:', filePath);

  // 创建数据库路径
  const dbPath = path.join(tempDir, 'test.db');

  // 创建采集器
  const messages: UnifiedMessage[] = [];
  const invalidMessages: any[] = [];
  const duplicates: string[] = [];
  const batchFlushes: number[] = [];

  const collector = new FileCollector({
    openclawDataDir: tempDir,
    dbPath,
    enableWatch: false,
    enableIncremental: false,
  });

  collector.on('message', (msg: UnifiedMessage) => {
    messages.push(msg);
    console.log(`📨 收到消息: ${msg.id} (${msg.messageType})`);
  });

  collector.on('invalid', (event) => {
    invalidMessages.push(event);
    console.log(`⚠️  验证失败: ${event.message.id}`, event.errors);
  });

  collector.on('duplicate', (event) => {
    duplicates.push(event.messageId);
    console.log(`🔄 检测到重复: ${event.messageId}`);
  });

  collector.on('batch:flush', (event) => {
    batchFlushes.push(event.count);
    console.log(`💾 批量写入: ${event.count} 条消息`);
  });

  try {
    // 启动采集器
    console.log('\n🔄 启动 FileCollector...\n');
    await collector.start();

    // 等待处理完成
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 停止采集器
    await collector.stop();

    // 输出结果
    console.log('\n📊 测试结果:');
    console.log('─'.repeat(50));
    console.log(`✅ 有效消息: ${messages.length} 条`);
    console.log(`❌ 无效消息: ${invalidMessages.length} 条`);
    console.log(`🔄 重复消息: ${duplicates.length} 条`);
    console.log(`💾 批量写入: ${batchFlushes.length} 次`);
    console.log('─'.repeat(50));

    // 验证结果
    if (messages.length === 3 && invalidMessages.length === 0) {
      console.log('\n🎉 测试通过！所有消息都成功验证并写入数据库！');
      console.log('\n消息详情:');
      messages.forEach((msg, i) => {
        console.log(`  ${i + 1}. ${msg.id} (${msg.messageType}) - ${msg.content?.substring(0, 30)}...`);
      });
    } else {
      console.log('\n❌ 测试失败！');
      if (invalidMessages.length > 0) {
        console.log('\n无效消息详情:');
        invalidMessages.forEach((invalid, i) => {
          console.log(`  ${i + 1}. ${invalid.message.id}:`);
          invalid.errors.forEach((err: string) => console.log(`     - ${err}`));
        });
      }
    }

  } finally {
    // 清理
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.log('\n🧹 清理完成');
  }
}

// 运行测试
quickTest().catch(console.error);
