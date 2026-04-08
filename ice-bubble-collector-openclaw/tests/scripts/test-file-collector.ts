/**
 * FileCollector 测试脚本
 * 
 * 测试内容：
 * 1. 初始扫描所有 Session 文件
 * 2. 文件监听功能
 * 3. 增量读取验证
 * 4. 数据转换验证
 * 5. 统计信息验证
 */

import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../src/types/index';

// 配置
const OPENCLAW_DATA_DIR = path.join(os.homedir(), '.openclaw');

// 统计
let messageCount = 0;
let userCount = 0;
let agentCount = 0;
let toolCount = 0;
const messages: UnifiedMessage[] = [];

async function testFileCollector() {
  console.log('========================================');
  console.log('FileCollector 测试脚本');
  console.log('========================================\n');

  // 1. 创建采集器
  console.log('1. 创建 FileCollector...');
  const collector = new FileCollector({
    openclawDataDir: OPENCLAW_DATA_DIR,
    enableWatch: true, // 启用文件监听
    batchSize: 50,
    enableIncremental: true
  });

  console.log(`   数据目录: ${OPENCLAW_DATA_DIR}\n`);

  // 2. 监听事件
  console.log('2. 注册事件监听器...\n');

  // 消息事件
  collector.on('message', (message: UnifiedMessage) => {
    messageCount++;
    
    // 统计消息类型
    switch (message.messageType) {
      case 'user':
        userCount++;
        break;
      case 'agent':
        agentCount++;
        break;
      case 'tool':
        toolCount++;
        break;
    }

    // 保存前 10 条消息用于验证
    if (messages.length < 10) {
      messages.push(message);
    }

    // 每 100 条消息输出一次进度
    if (messageCount % 100 === 0) {
      console.log(`   已处理 ${messageCount} 条消息 (User: ${userCount}, Agent: ${agentCount}, Tool: ${toolCount})`);
    }
  });

  // 错误事件
  collector.on('error', (error: Error) => {
    console.error('   ❌ 错误:', error.message);
  });

  // 状态事件
  collector.on('status', (stats) => {
    console.log(`   📊 状态: 总计 ${stats.total}, 成功 ${stats.processed}, 失败 ${stats.failed}`);
  });

  // 3. 启动采集器
  console.log('3. 启动 FileCollector...');
  try {
    await collector.start();
    console.log('   ✅ 启动成功\n');
  } catch (error) {
    console.error('   ❌ 启动失败:', error);
    process.exit(1);
  }

  // 4. 等待初始扫描完成
  console.log('4. 等待初始扫描完成（5秒）...\n');
  await sleep(5000);

  // 5. 输出统计信息
  console.log('5. 统计信息:');
  const stats = collector.getStats();
  console.log(`   - 总文件数: ${stats.totalFiles}`);
  console.log(`   - 已处理文件数: ${stats.processedFiles}`);
  console.log(`   - 总事件数: ${stats.totalEvents}`);
  console.log(`   - 成功事件数: ${stats.successEvents}`);
  console.log(`   - 失败事件数: ${stats.failedEvents}\n`);

  // 6. 验证消息格式
  console.log('6. 验证前 10 条消息格式:');
  messages.forEach((msg, index) => {
    console.log(`   消息 ${index + 1}:`);
    console.log(`     - ID: ${msg.id}`);
    console.log(`     - SessionKey: ${msg.sessionKey}`);
    console.log(`     - 类型: ${msg.messageType}`);
    console.log(`     - 时间: ${msg.timestamp}`);
    console.log(`     - 来源: ${msg.source}`);
    if (msg.content) {
      console.log(`     - 内容: ${msg.content.substring(0, 50)}...`);
    }
    if (msg.model) {
      console.log(`     - 模型: ${msg.model}`);
    }
    if (msg.tools && msg.tools.length > 0) {
      console.log(`     - 工具: ${msg.tools.map(t => t.name).join(', ')}`);
    }
  });
  console.log('');

  // 7. 消息类型统计
  console.log('7. 消息类型统计:');
  console.log(`   - User 消息: ${userCount}`);
  console.log(`   - Agent 消息: ${agentCount}`);
  console.log(`   - Tool 消息: ${toolCount}`);
  console.log(`   - 总计: ${messageCount}\n`);

  // 8. 文件监听测试
  console.log('8. 文件监听测试:');
  console.log('   采集器将继续运行 30 秒，监听文件变化...');
  console.log('   你可以尝试修改或新增 Session 文件来触发事件\n');

  // 等待 30 秒
  await sleep(30000);

  // 9. 停止采集器
  console.log('9. 停止 FileCollector...');
  await collector.stop();
  console.log('   ✅ 已停止\n');

  // 10. 最终统计
  console.log('10. 最终统计信息:');
  const finalStats = collector.getStats();
  console.log(`   - 总文件数: ${finalStats.totalFiles}`);
  console.log(`   - 已处理文件数: ${finalStats.processedFiles}`);
  console.log(`   - 总事件数: ${finalStats.totalEvents}`);
  console.log(`   - 成功事件数: ${finalStats.successEvents}`);
  console.log(`   - 失败事件数: ${finalStats.failedEvents}\n`);

  console.log('========================================');
  console.log('测试完成！');
  console.log('========================================');

  process.exit(0);
}

// 辅助函数
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 运行测试
testFileCollector().catch((error) => {
  console.error('测试失败:', error);
  process.exit(1);
});
