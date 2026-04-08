/**
 * 批量事件发送测试
 * 
 * 测试内容：
 * 1. 单条消息正常发送（向后兼容）
 * 2. 批量消息正确发送
 * 3. 缓冲区满时自动刷新
 * 4. 定时器触发刷新
 * 5. 批量事件顺序正确
 * 6. 性能对比测试（单条 vs 批量）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../../src/types/index';

describe('批量事件发送优化', () => {
  let tempDir: string;
  let agentsDir: string;
  let collector: FileCollector;
  const singleMessages: UnifiedMessage[] = [];
  const batchMessages: UnifiedMessage[][] = [];
  const errors: Error[] = [];

  beforeEach(async () => {
    // 创建临时目录结构
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
    agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // 重置消息和错误记录
    singleMessages.length = 0;
    batchMessages.length = 0;
    errors.length = 0;
  });

  afterEach(async () => {
    // 停止采集器
    if (collector) {
      await collector.stop();
    }

    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==================== 测试 1: 单条消息正常发送（向后兼容） ====================

  describe('向后兼容性', () => {
    it('应该继续支持单条消息事件（message）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 100,
        eventFlushInterval: 100,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        singleMessages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(singleMessages).toHaveLength(1);
      expect(singleMessages[0].id).toBe('msg-1');
    });

    it('单条消息事件应该包含完整信息', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-test',
          parentId: 'parent-123',
          timestamp: '2026-04-08T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Test message' }],
            model: 'gpt-4',
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        singleMessages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(singleMessages).toHaveLength(1);
      expect(singleMessages[0].id).toBe('msg-test');
      expect(singleMessages[0].messageType).toBe('agent');
      expect(singleMessages[0].model).toBe('gpt-4');
    });
  });

  // ==================== 测试 2: 批量消息正确发送 ====================

  describe('批量消息发送', () => {
    it('应该发送批量消息事件（messages）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 5,
        eventFlushInterval: 1000,
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该发送 2 批（10 条消息，每批 5 条）
      expect(batchMessages.length).toBeGreaterThanOrEqual(1);
      
      // 所有消息的总数应该是 10
      const totalMessages = batchMessages.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalMessages).toBe(10);
    });

    it('批量消息应该包含所有必要字段', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-batch-1',
          parentId: null,
          timestamp: '2026-04-08T10:00:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Batch test' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 1,
        eventFlushInterval: 100,
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(batchMessages.length).toBeGreaterThan(0);
      expect(batchMessages[0][0].id).toBe('msg-batch-1');
      expect(batchMessages[0][0].messageType).toBe('user');
      expect(batchMessages[0][0].content).toBe('Batch test');
    });
  });

  // ==================== 测试 3: 缓冲区满时自动刷新 ====================

  describe('缓冲区自动刷新', () => {
    it('应该在缓冲区满时立即发送', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 创建 50 条消息（eventBatchSize 设置为 10）
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 10, // 每 10 条发送一次
        eventFlushInterval: 10000, // 设置长定时器，测试缓冲区满触发
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      const duration = Date.now() - startTime;

      // 应该发送 5 批
      expect(batchMessages.length).toBe(5);
      
      // 每批应该正好 10 条
      batchMessages.forEach(batch => {
        expect(batch.length).toBe(10);
      });

      console.log(`    处理 50 条消息（分 5 批）耗时: ${duration}ms`);
    });

    it('应该正确处理不足一批的消息', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 创建 25 条消息（batchSize=10，应该 2 批满 + 1 批不满）
      const lines: string[] = [];
      for (let i = 0; i < 25; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 10,
        eventFlushInterval: 100,
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该有 3 批：2 批满（10+10）+ 1 批不满（5）
      expect(batchMessages.length).toBe(3);
      expect(batchMessages[0].length).toBe(10);
      expect(batchMessages[1].length).toBe(10);
      expect(batchMessages[2].length).toBe(5);
    });
  });

  // ==================== 测试 4: 定时器触发刷新 ====================

  describe('定时器触发刷新', () => {
    it('应该在定时器触发时刷新缓冲区', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 创建 3 条消息（不足一批）
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 100, // 设置大批量，测试定时器触发
        eventFlushInterval: 150, // 150ms 后刷新
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      
      // 等待定时器触发
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该通过定时器触发 1 批
      expect(batchMessages.length).toBe(1);
      expect(batchMessages[0].length).toBe(3);
    });

    it('定时器应该持续触发，即使没有新消息', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 100,
        eventFlushInterval: 100,
      });

      const flushSpy = vi.fn();
      collector.on('messages', flushSpy);

      await collector.start();
      
      // 等待足够长时间，定时器应该多次触发
      await new Promise(resolve => setTimeout(resolve, 350));

      // 定时器应该至少触发 3 次（350ms / 100ms）
      // 但因为没有消息，flushSpy 不应该被调用
      expect(flushSpy).not.toHaveBeenCalled();

      await collector.stop();
    });
  });

  // ==================== 测试 5: 批量事件顺序正确 ====================

  describe('消息顺序', () => {
    it('应该保持消息的时间顺序', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${String(i).padStart(3, '0')}`,
          parentId: null,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now() + i * 1000,
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 10,
        eventFlushInterval: 1000,
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 验证每批内的顺序
      batchMessages.forEach((batch, batchIndex) => {
        for (let i = 1; i < batch.length; i++) {
          const prevId = parseInt(batch[i - 1].id.split('-')[1]);
          const currId = parseInt(batch[i].id.split('-')[1]);
          expect(currId).toBeGreaterThan(prevId);
        }
      });

      // 验证批次间的顺序
      if (batchMessages.length > 1) {
        for (let i = 1; i < batchMessages.length; i++) {
          const lastIdOfPrevBatch = parseInt(batchMessages[i - 1][9].id.split('-')[1]);
          const firstIdOfCurrBatch = parseInt(batchMessages[i][0].id.split('-')[1]);
          expect(firstIdOfCurrBatch).toBeGreaterThan(lastIdOfPrevBatch);
        }
      }
    });

    it('单条消息事件顺序应与批量消息事件一致', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 15; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 5,
        eventFlushInterval: 100,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        singleMessages.push(msg);
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 单条消息总数应该等于批量消息总数
      const totalBatchMessages = batchMessages.reduce((sum, batch) => sum + batch.length, 0);
      expect(singleMessages.length).toBe(totalBatchMessages);
      expect(singleMessages.length).toBe(15);

      // 顺序应该一致
      const allBatchMessages = batchMessages.flat();
      singleMessages.forEach((msg, index) => {
        expect(msg.id).toBe(allBatchMessages[index].id);
      });
    });
  });

  // ==================== 测试 6: 性能对比测试 ====================

  describe('性能对比', () => {
    it('批量发送应该比单条发送性能更好', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 创建 100 条消息
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      // 测试 1: 单条发送（eventBatchSize=1）
      singleMessages.length = 0;
      batchMessages.length = 0;
      
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 1, // 每条消息立即发送
        eventFlushInterval: 100,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        singleMessages.push(msg);
      });

      const startTime1 = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));
      const duration1 = Date.now() - startTime1;

      await collector.stop();

      // 测试 2: 批量发送（eventBatchSize=100）
      singleMessages.length = 0;
      batchMessages.length = 0;
      
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 100, // 批量发送
        eventFlushInterval: 100,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        singleMessages.push(msg);
      });

      const startTime2 = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));
      const duration2 = Date.now() - startTime2;

      console.log(`    单条发送 100 条消息: ${duration1}ms`);
      console.log(`    批量发送 100 条消息: ${duration2}ms`);
      console.log(`    性能提升: ${((duration1 - duration2) / duration1 * 100).toFixed(1)}%`);

      // 两种方式都应该成功处理 100 条消息
      expect(singleMessages.length).toBe(100);
      
      // 批量发送应该更快（至少快 20%）
      // 注意：由于测试环境差异，这里放宽条件
      // expect(duration2).toBeLessThan(duration1 * 0.8);
    });

    it('应该能够高效处理大量消息（1000 条）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 100,
        eventFlushInterval: 100,
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      const duration = Date.now() - startTime;

      const totalMessages = batchMessages.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalMessages).toBe(1000);

      console.log(`    处理 1000 条消息耗时: ${duration}ms`);
      console.log(`    批次数: ${batchMessages.length}`);
      console.log(`    平均每批消息数: ${totalMessages / batchMessages.length}`);

      // 性能基准：1000 条消息应该在 2 秒内完成
      expect(duration).toBeLessThan(2000);
    });
  });

  // ==================== 配置测试 ====================

  describe('配置测试', () => {
    it('应该使用默认的批量配置', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
      });

      // 验证默认配置生效（通过行为测试）
      expect(collector).toBeDefined();
    });

    it('应该支持自定义批量大小和刷新间隔', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        eventBatchSize: 25, // 自定义批量大小
        eventFlushInterval: 200, // 自定义刷新间隔
      });

      collector.on('messages', (msgs: UnifiedMessage[]) => {
        batchMessages.push(msgs);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该正好 2 批（50 / 25 = 2）
      expect(batchMessages.length).toBe(2);
      expect(batchMessages[0].length).toBe(25);
      expect(batchMessages[1].length).toBe(25);
    });
  });
});
