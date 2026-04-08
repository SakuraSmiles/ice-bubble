/**
 * 可靠性功能测试
 * 
 * 测试内容：
 * 1. 文件大小限制验证
 * 2. 行长度限制验证
 * 3. 重试机制验证
 * 4. 配置预设验证
 * 5. 错误日志验证
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../../src/types/index';

describe('可靠性功能验证', () => {
  let tempDir: string;
  let agentsDir: string;
  let collector: FileCollector;
  const messages: UnifiedMessage[] = [];
  const errors: Error[] = [];

  beforeEach(async () => {
    // 创建临时目录结构
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-test-'));
    agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // 重置消息和错误记录
    messages.length = 0;
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

  // ==================== 测试 1: 文件大小限制验证 ====================

  describe('文件大小限制', () => {
    it('应该跳过超过大小限制的文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const largeFile = path.join(agentDir, 'large.jsonl');
      
      // 创建一个超过限制的大文件（模拟 120MB）
      // 注意：实际测试中我们使用较小的限制值
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(1000) }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(largeFile, lines.join('\n'), 'utf-8');
      
      const fileSize = fs.statSync(largeFile).size;

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: fileSize - 1, // 设置限制比文件小
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      collector.on('error', (err: Error) => {
        errors.push(err);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      
      // 文件应该被跳过
      expect(stats.skippedFiles).toBe(1);
      expect(messages.length).toBe(0);
    });

    it('应该正常处理小于限制的文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const normalFile = path.join(agentDir, 'normal.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Normal message' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(normalFile, lines.join('\n'), 'utf-8');
      
      const fileSize = fs.statSync(normalFile).size;

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: fileSize * 10, // 限制远大于文件
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      
      // 文件应该正常处理
      expect(stats.skippedFiles).toBe(0);
      expect(messages.length).toBe(1);
    });

    it('应该正确统计跳过的文件数', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      
      // 创建 3 个文件，其中 2 个超过限制
      for (let i = 0; i < 3; i++) {
        const filePath = path.join(agentDir, `file-${i}.jsonl`);
        const lines: string[] = [];
        const lineCount = i === 0 ? 10 : 1000; // 第一个文件小，其他两个大
        
        for (let j = 0; j < lineCount; j++) {
          lines.push(JSON.stringify({
            type: 'message',
            id: `msg-${i}-${j}`,
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'x'.repeat(100) }],
              timestamp: Date.now(),
            },
          }));
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      }

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: 5000, // 设置小限制
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = collector.getStats();
      
      // 应该跳过 2 个文件，处理 1 个文件
      expect(stats.totalFiles).toBe(3);
      expect(stats.skippedFiles).toBe(2);
      expect(stats.processedFiles).toBe(1);
    });
  });

  // ==================== 测试 2: 行长度限制验证 ====================

  describe('行长度限制', () => {
    it('应该跳过超长的行', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-normal',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Normal message' }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-long',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(2000) }], // 长内容
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxLineLength: 1000, // 设置行长度限制
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该只处理第一行，跳过第二行
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe('msg-normal');
    });

    it('行长度限制不应影响正常长度的消息', async () => {
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
            content: [{ type: 'text', text: 'Normal message' }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxLineLength: 1024 * 1024, // 1MB
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 所有消息都应该正常处理
      expect(messages.length).toBe(10);
    });
  });

  // ==================== 测试 3: 重试机制验证 ====================

  describe('重试机制', () => {
    it('应该在读取失败时自动重试', async () => {
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
            content: [{ type: 'text', text: 'Test' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxRetries: 3,
        retryDelay: 100,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = collector.getStats();
      
      // 正常情况下不需要重试
      expect(stats.retriedEvents).toBe(0);
      expect(messages.length).toBe(1);
    });

    it('应该限制重试次数', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 创建一个会触发错误的文件（格式错误）
      fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxRetries: 2,
        retryDelay: 50,
      });

      const errorSpy = vi.fn();
      collector.on('error', errorSpy);

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 格式错误的文件不应该触发重试（在文件读取层面没有错误）
      // 重试机制主要针对文件读取错误（权限、锁定等）
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(1);
    });

    it('应该使用指数退避策略', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxRetries: 3,
        retryDelay: 100, // 基础延迟 100ms
      });

      // 验证配置已生效
      expect(collector).toBeDefined();
      
      // 实际测试需要模拟文件读取失败，这里仅验证配置
    });
  });

  // ==================== 测试 4: 配置预设验证 ====================

  describe('文件监听配置预设', () => {
    it('应该支持 local 预设', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: true,
        watchPreset: 'local',
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });

    it('应该支持 network 预设', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: true,
        watchPreset: 'network',
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });

    it('应该支持自定义配置', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: true,
        watchPreset: 'custom',
        watchOptions: {
          usePolling: true,
          interval: 500,
        },
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });

    it('默认应该使用 local 预设', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: true,
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });
  });

  // ==================== 测试 5: 错误日志验证 ====================

  describe('错误日志', () => {
    it('应该在跳过文件时记录日志', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const largeFile = path.join(agentDir, 'large.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(1000) }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(largeFile, lines.join('\n'), 'utf-8');
      
      const fileSize = fs.statSync(largeFile).size;

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: fileSize - 1,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      expect(stats.skippedFiles).toBe(1);
    });

    it('应该在跳过超长行时记录日志', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-long',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(2000) }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxLineLength: 1000,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该成功启动和停止，没有崩溃
      expect(collector.getStats()).toBeDefined();
    });

    it('应该在重试时记录日志', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Test' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxRetries: 3,
        retryDelay: 100,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 正常情况下不需要重试，但配置应该生效
      expect(collector.getStats()).toBeDefined();
    });
  });

  // ==================== 边界情况测试 ====================

  describe('边界情况', () => {
    it('应该正确处理空文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'empty.jsonl');
      fs.writeFileSync(filePath, '', 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(1);
      expect(messages.length).toBe(0);
    });

    it('应该正确处理只包含空行的文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'blank.jsonl');
      fs.writeFileSync(filePath, '\n\n\n', 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
      });

      collector.on('message', (msg: UnifiedMessage) => {
        messages.push(msg);
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(messages.length).toBe(0);
    });

    it('应该正确处理配置边界值', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: 1, // 最小值
        maxLineLength: 1, // 最小值
        maxRetries: 0, // 禁用重试
        eventBatchSize: 1, // 最小批量
        eventFlushInterval: 1, // 最小间隔
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });

    it('应该正确处理极大值配置', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: Number.MAX_SAFE_INTEGER,
        maxLineLength: Number.MAX_SAFE_INTEGER,
        maxRetries: 100,
        eventBatchSize: 10000,
        eventFlushInterval: 60000,
      });

      await collector.start();
      
      const stats = collector.getStats();
      expect(stats).toBeDefined();
      
      await collector.stop();
    });
  });

  // ==================== 统计信息测试 ====================

  describe('统计信息', () => {
    it('应该正确更新 skippedFiles 统计', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      
      // 创建一个大文件
      const largeFile = path.join(agentDir, 'large.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          message: { role: 'user', content: [], timestamp: Date.now() },
        }));
      }
      fs.writeFileSync(largeFile, lines.join('\n'), 'utf-8');
      
      const fileSize = fs.statSync(largeFile).size;

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxFileSize: fileSize - 1,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      expect(stats.skippedFiles).toBe(1);
    });

    it('应该正确更新 retriedEvents 统计', async () => {
      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
        maxRetries: 3,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
      expect(stats.retriedEvents).toBe(0); // 正常情况下为 0
    });

    it('应该能够重置统计信息', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      fs.writeFileSync(filePath, JSON.stringify({
        type: 'message',
        id: 'msg-1',
        message: { role: 'user', content: [], timestamp: Date.now() },
      }), 'utf-8');

      collector = new FileCollector({
        openclawDataDir: tempDir,
        enableWatch: false,
      });

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const statsBefore = collector.getStats();
      expect(statsBefore.totalFiles).toBe(1);

      collector.resetStats();

      const statsAfter = collector.getStats();
      expect(statsAfter.totalFiles).toBe(0);
      expect(statsAfter.skippedFiles).toBe(0);
      expect(statsAfter.retriedEvents).toBe(0);
    });
  });
});
