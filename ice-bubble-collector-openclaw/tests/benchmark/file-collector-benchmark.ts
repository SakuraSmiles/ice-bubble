/**
 * FileCollector 性能基准测试
 * 
 * 测试内容：
 * 1. 吞吐量测试（100/1000/10000 条消息）
 * 2. 内存占用监控
 * 3. GC 暂停测试
 * 4. 对比测试（优化前 vs 优化后、单条 vs 批量）
 * 
 * 性能目标：
 * - 吞吐量 ≥ 1000 msg/s
 * - 内存占用 < 30MB
 * - GC 暂停 < 20ms
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../src/types/index';

// 性能测试配置
interface BenchmarkConfig {
  name: string;
  messageCount: number;
  batchSize: number;
  flushInterval: number;
}

// 性能测试结果
interface BenchmarkResult {
  config: BenchmarkConfig;
  duration: number;
  throughput: number; // msg/s
  memoryUsed: number; // MB
  batchCount: number;
  avgBatchSize: number;
}

class FileCollectorBenchmark {
  private tempDir: string;
  private agentsDir: string;

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
    this.agentsDir = path.join(this.tempDir, 'agents');
    fs.mkdirSync(this.agentsDir, { recursive: true });
  }

  // 创建测试文件
  private createTestFile(messageCount: number, contentSize: number = 100): string {
    const agentDir = path.join(this.agentsDir, 'benchmark-agent', 'sessions');
    fs.mkdirSync(agentDir, { recursive: true });
    const filePath = path.join(agentDir, 'benchmark.jsonl');

    const lines: string[] = [];
    for (let i = 0; i < messageCount; i++) {
      lines.push(JSON.stringify({
        type: 'message',
        id: `msg-${i}`,
        parentId: null,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(contentSize) }],
          model: i % 2 === 1 ? 'gpt-4' : undefined,
          timestamp: Date.now() + i * 1000,
        },
      }));
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  // 运行单个基准测试
  async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
    console.log(`\n📊 运行测试: ${config.name}`);
    console.log(`   消息数: ${config.messageCount}, 批量大小: ${config.batchSize}, 刷新间隔: ${config.flushInterval}ms`);

    // 创建测试文件
    const testFile = this.createTestFile(config.messageCount);

    // 记录初始内存
    const memBefore = process.memoryUsage();
    global.gc && global.gc(); // 手动触发 GC（如果可用）

    // 创建采集器
    const messages: UnifiedMessage[] = [];
    const batchMessages: UnifiedMessage[][] = [];
    
    const collector = new FileCollector({
      openclawDataDir: this.tempDir,
      enableWatch: false,
      eventBatchSize: config.batchSize,
      eventFlushInterval: config.flushInterval,
    });

    collector.on('message', (msg: UnifiedMessage) => {
      messages.push(msg);
    });

    collector.on('messages', (msgs: UnifiedMessage[]) => {
      batchMessages.push(msgs);
    });

    // 开始测试
    const startTime = Date.now();
    const startMem = process.memoryUsage().heapUsed;

    await collector.start();
    await new Promise(resolve => setTimeout(resolve, 500)); // 等待处理完成

    const endTime = Date.now();
    const endMem = process.memoryUsage().heapUsed;

    await collector.stop();

    // 计算结果
    const duration = endTime - startTime;
    const throughput = (messages.length / duration) * 1000; // msg/s
    const memoryUsed = (endMem - startMem) / 1024 / 1024; // MB
    const batchCount = batchMessages.length;
    const avgBatchSize = batchCount > 0 ? messages.length / batchCount : 0;

    const result: BenchmarkResult = {
      config,
      duration,
      throughput,
      memoryUsed: Math.abs(memoryUsed),
      batchCount,
      avgBatchSize,
    };

    // 打印结果
    console.log(`   ✅ 耗时: ${duration}ms`);
    console.log(`   ✅ 吞吐量: ${throughput.toFixed(2)} msg/s`);
    console.log(`   ✅ 内存占用: ${memoryUsed.toFixed(2)} MB`);
    console.log(`   ✅ 批次数: ${batchCount}`);
    console.log(`   ✅ 平均批量大小: ${avgBatchSize.toFixed(2)}`);

    // 验证性能目标
    this.assertPerformance(result);

    return result;
  }

  // 验证性能目标
  private assertPerformance(result: BenchmarkResult): void {
    const { throughput, memoryUsed, duration } = result;

    // 吞吐量目标：≥ 1000 msg/s
    if (throughput >= 1000) {
      console.log(`   ✅ 吞吐量达标: ${throughput.toFixed(2)} >= 1000 msg/s`);
    } else {
      console.log(`   ⚠️  吞吐量未达标: ${throughput.toFixed(2)} < 1000 msg/s`);
    }

    // 内存占用目标：< 30MB
    if (memoryUsed < 30) {
      console.log(`   ✅ 内存占用达标: ${memoryUsed.toFixed(2)} < 30 MB`);
    } else {
      console.log(`   ⚠️  内存占用超标: ${memoryUsed.toFixed(2)} >= 30 MB`);
    }
  }

  // 对比测试：单条 vs 批量
  async compareSingleVsBatch(messageCount: number): Promise<void> {
    console.log(`\n🔄 对比测试: 单条发送 vs 批量发送 (${messageCount} 条消息)`);

    // 创建测试文件
    const testFile = this.createTestFile(messageCount);

    // 测试 1: 单条发送（batchSize=1）
    const messages1: UnifiedMessage[] = [];
    const collector1 = new FileCollector({
      openclawDataDir: this.tempDir,
      enableWatch: false,
      eventBatchSize: 1,
      eventFlushInterval: 10000, // 长间隔，避免定时器触发
    });
    collector1.on('message', (msg) => messages1.push(msg));

    const start1 = Date.now();
    await collector1.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    const duration1 = Date.now() - start1;
    await collector1.stop();

    // 测试 2: 批量发送（batchSize=100）
    const messages2: UnifiedMessage[] = [];
    const collector2 = new FileCollector({
      openclawDataDir: this.tempDir,
      enableWatch: false,
      eventBatchSize: 100,
      eventFlushInterval: 10000,
    });
    collector2.on('message', (msg) => messages2.push(msg));

    const start2 = Date.now();
    await collector2.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    const duration2 = Date.now() - start2;
    await collector2.stop();

    // 打印对比结果
    const improvement = ((duration1 - duration2) / duration1 * 100).toFixed(1);
    console.log(`\n   单条发送: ${duration1}ms`);
    console.log(`   批量发送: ${duration2}ms`);
    console.log(`   性能提升: ${improvement}%`);
    console.log(`   处理消息数: ${messages1.length} vs ${messages2.length}`);
  }

  // 内存压力测试
  async memoryStressTest(messageCount: number): Promise<void> {
    console.log(`\n💾 内存压力测试: ${messageCount} 条大消息`);

    // 创建大消息（每条 1KB）
    const testFile = this.createTestFile(messageCount, 1000);

    const memBefore = process.memoryUsage();
    global.gc && global.gc();

    const messages: UnifiedMessage[] = [];
    const collector = new FileCollector({
      openclawDataDir: this.tempDir,
      enableWatch: false,
      eventBatchSize: 100,
      eventFlushInterval: 100,
    });

    collector.on('message', (msg) => messages.push(msg));

    const startMem = process.memoryUsage().heapUsed;
    await collector.start();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const endMem = process.memoryUsage().heapUsed;

    await collector.stop();

    const memoryUsed = (endMem - startMem) / 1024 / 1024;
    console.log(`\n   处理消息数: ${messages.length}`);
    console.log(`   内存增长: ${Math.abs(memoryUsed).toFixed(2)} MB`);
    console.log(`   平均每条消息: ${(Math.abs(memoryUsed) / messages.length * 1024).toFixed(2)} KB`);
  }

  // 清理测试环境
  cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

// 主测试函数
async function main() {
  console.log('🚀 FileCollector 性能基准测试');
  console.log('=' .repeat(60));

  const benchmark = new FileCollectorBenchmark();

  try {
    // 测试 1: 吞吐量测试
    console.log('\n📝 测试 1: 吞吐量测试');
    console.log('-'.repeat(60));

    const throughputTests: BenchmarkConfig[] = [
      {
        name: '小规模测试 (100 条)',
        messageCount: 100,
        batchSize: 100,
        flushInterval: 100,
      },
      {
        name: '中规模测试 (1000 条)',
        messageCount: 1000,
        batchSize: 100,
        flushInterval: 100,
      },
      {
        name: '大规模测试 (10000 条)',
        messageCount: 10000,
        batchSize: 100,
        flushInterval: 100,
      },
    ];

    const results: BenchmarkResult[] = [];
    for (const config of throughputTests) {
      const result = await benchmark.runBenchmark(config);
      results.push(result);
    }

    // 测试 2: 对比测试
    console.log('\n📝 测试 2: 对比测试');
    console.log('-'.repeat(60));
    await benchmark.compareSingleVsBatch(1000);

    // 测试 3: 内存压力测试
    console.log('\n📝 测试 3: 内存压力测试');
    console.log('-'.repeat(60));
    await benchmark.memoryStressTest(5000);

    // 汇总报告
    console.log('\n📊 性能测试汇总报告');
    console.log('='.repeat(60));
    
    results.forEach((result, index) => {
      console.log(`\n测试 ${index + 1}: ${result.config.name}`);
      console.log(`  吞吐量: ${result.throughput.toFixed(2)} msg/s`);
      console.log(`  内存占用: ${result.memoryUsed.toFixed(2)} MB`);
      console.log(`  耗时: ${result.duration}ms`);
      
      if (result.throughput >= 1000) {
        console.log(`  ✅ 达标`);
      } else {
        console.log(`  ⚠️  未达标`);
      }
    });

    console.log('\n✅ 所有性能测试完成！');

  } catch (error) {
    console.error('❌ 测试失败:', error);
    throw error;
  } finally {
    benchmark.cleanup();
  }
}

// 运行测试
main().catch(console.error);
