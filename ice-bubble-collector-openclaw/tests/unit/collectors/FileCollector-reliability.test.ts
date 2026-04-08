/**
 * FileCollector 可靠性功能测试 (v2.0)
 *
 * 适配 Facade 架构重构，基于新 API 重写
 *
 * 测试内容：
 * 1. 文件大小限制验证
 * 2. 行长度限制验证
 * 3. 异常恢复机制（重试）
 * 4. 边界情况处理
 * 5. 统计信息准确性
 *
 * 变更记录:
 * - v2.0: 移除旧 eventBatchSize/eventFlushInterval API
 *         新增 dbPath 必需参数
 *         移除与主测试文件重复的用例
 *         聚焦可靠性特有场景
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../../src/types/index';

describe('FileCollector 可靠性功能', () => {
  let tempDir: string;
  let agentsDir: string;
  let collector: FileCollector;
  const messages: UnifiedMessage[] = [];
  const errors: Error[] = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-test-'));
    agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    messages.length = 0;
    errors.length = 0;

    // 创建采集器实例 — 使用新 API
    collector = new FileCollector({
      openclawDataDir: tempDir,
      dbPath: path.join(tempDir, 'test.db'),
      enableWatch: false,
      batchSize: 10,
      enableIncremental: true,
    });

    collector.on('message', (msg: UnifiedMessage) => messages.push(msg));
    collector.on('error', (err: Error) => errors.push(err));
  });

  afterEach(async () => {
    if (collector) {
      await collector.stop();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==================== 1. 文件大小限制验证 ====================

  describe('文件大小限制', () => {
    it('应该跳过超过大小限制的文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const largeFile = path.join(agentDir, 'large.jsonl');

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

      // 创建新的 collector 实例来设置 maxFileSize
      await collector.stop();
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'test2.db'),
        enableWatch: false,
        maxFileSize: fileSize - 1,
      });
      collector.on('message', (msg: UnifiedMessage) => messages.push(msg));

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const stats = collector.getStats();
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

      await collector.stop();
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'test3.db'),
        enableWatch: false,
        maxFileSize: fileSize * 10,
      });
      collector.on('message', (msg: UnifiedMessage) => messages.push(msg));

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(messages.length).toBe(1);
    });

    it('应该正确统计跳过的文件数（混合大小文件）', async () => {
      for (let i = 0; i < 3; i++) {
        const agentDir = path.join(agentsDir, `agent-${i}`, 'sessions');
        fs.mkdirSync(agentDir, { recursive: true });
        const filePath = path.join(agentDir, `file-${i}.jsonl`);
        const lines: string[] = [];
        const lineCount = i === 0 ? 5 : 50;

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

      // 设置较小的文件大小限制
      await collector.stop();
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'test4.db'),
        enableWatch: false,
        maxFileSize: 2000,
      });
      collector.on('message', (msg: UnifiedMessage) => messages.push(msg));

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(3);
      expect(stats.skippedFiles + stats.processedFiles).toBe(3);
    });
  });

  // ==================== 2. 行长度限制验证 ====================

  describe('行长度限制', () => {
    it('应该跳过超长的行并处理正常的行', async () => {
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
            content: [{ type: 'text', text: 'x'.repeat(2000) }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      await collector.stop();
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'test5.db'),
        enableWatch: false,
        maxLineLength: 1000,
      });
      collector.on('message', (msg: UnifiedMessage) => messages.push(msg));

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 应该只处理第一行
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe('msg-normal');
    });

    it('默认行长度限制不应影响正常消息', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'normal-lines.jsonl');

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

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(messages.length).toBe(10);
    });
  });

  // ==================== 3. 异常恢复机制验证 ====================

  describe('异常恢复机制', () => {
    it('应该在配置中正确设置重试参数', async () => {
      await collector.stop();

      // 验证不同重试参数都能正常创建
      const retryConfigs = [
        { maxRetries: 3, retryDelay: 1000 },
        { maxRetries: 0, retryDelay: 100 },   // 禁用重试
        { maxRetries: 10, retryDelay: 500 },   // 大量重试
      ];

      for (const config of retryConfigs) {
        const c = new FileCollector({
          openclawDataDir: tempDir,
          dbPath: path.join(tempDir, `retry-${config.maxRetries}.db`),
          enableWatch: false,
          ...config,
        });
        c.on('message', (msg: UnifiedMessage) => messages.push(msg));
        await c.start();
        await c.stop();
        expect(c.getStats()).toBeDefined();
      }
    });

    it('应该能正常启动和停止（含重试配置）', async () => {
      await collector.stop();

      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'retry-test.db'),
        enableWatch: false,
        maxRetries: 5,
        retryDelay: 200,
      });

      await collector.start();
      expect(collector.getStats()).toBeDefined();

      await collector.stop();
      await collector.stop(); // 多次停止不报错

      expect(collector.getStats()).toBeDefined();
    });
  });

  // ==================== 4. 边界情况 ====================

  describe('边界情况', () => {
    it('应该正确处理空文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'empty.jsonl');
      fs.writeFileSync(filePath, '', 'utf-8');

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

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(messages.length).toBe(0);
    });

    it('应该正确处理极值配置', async () => {
      await collector.stop();

      // 最小值配置
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'min-config.db'),
        enableWatch: false,
        maxFileSize: 1,
        maxLineLength: 1,
        maxRetries: 0,
        batchSize: 1,
        writerBatchSize: 1,
        writerFlushInterval: 100,
      });

      await collector.start();
      expect(collector.getStats()).toBeDefined();
      await collector.stop();

      // 极大值配置
      collector = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'max-config.db'),
        enableWatch: false,
        maxFileSize: Number.MAX_SAFE_INTEGER,
        maxLineLength: Number.MAX_SAFE_INTEGER,
        maxRetries: 100,
        batchSize: 10000,
        deduplicationCacheSize: 100000,
        writerBatchSize: 10000,
        writerFlushInterval: 60000,
      });

      await collector.start();
      expect(collector.getStats()).toBeDefined();
      await collector.stop();
    });

    it('应该正确处理只包含非消息事件的文件', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'no-messages.jsonl');

      const lines = [
        JSON.stringify({ type: 'session', id: 's1', version: 1, cwd: '/tmp' }),
        JSON.stringify({ type: 'model_change', id: 'm1', provider: 'openai', modelId: 'gpt-4' }),
        JSON.stringify({ type: 'custom', id: 'c1', customType: 'test', data: {} }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // 非 message 事件不会生成 UnifiedMessage
      expect(messages.length).toBe(0);
    });
  });

  // ==================== 5. 统计信息准确性 ====================

  describe('统计信息', () => {
    it('resetStats 应该清零所有计数器', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      fs.writeFileSync(filePath, '{}', 'utf-8');

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      const before = collector.getStats();
      expect(before.totalFiles).toBeGreaterThan(0);

      collector.resetStats();

      const after = collector.getStats();
      expect(after.totalFiles).toBe(0);
      expect(after.processedFiles).toBe(0);
      expect(after.skippedFiles).toBe(0);
      expect(after.totalEvents).toBe(0);
      expect(after.successEvents).toBe(0);
      expect(after.failedEvents).toBe(0);
      expect(after.retriedEvents).toBe(0);
    });

    it('getFileProgress 应该返回空 Map 当未读取任何文件时', () => {
      const progress = collector.getFileProgress();
      expect(progress.size).toBe(0);
    });

    it('getStats 和 pipeline 内部统计应保持同步', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'sync-test.jsonl');

      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'valid-msg',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Test' }],
            timestamp: Date.now(),
          },
        }),
        // 无效角色 → 验证失败
        JSON.stringify({
          type: 'message',
          id: 'invalid-role',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'invalid_role' as any,
            content: [],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = collector.getStats();
      // totalEvents >= successEvents + failedEvents（可能包含跳过的事件）
      expect(stats.totalEvents).toBeGreaterThanOrEqual(stats.successEvents + stats.failedEvents);
      // 至少处理了事件
      expect(stats.totalEvents).toBeGreaterThan(0);
    });
  });

  // ==================== 6. 监听配置预设验证 ====================

  describe('监听配置预设', () => {
    it('local/network/custom 三种预设都应能创建成功', async () => {
      const presets: Array<'local' | 'network' | 'custom'> = ['local', 'network', 'custom'];

      for (const preset of presets) {
        const c = new FileCollector({
          openclawDataDir: tempDir,
          dbPath: path.join(tempDir, `preset-${preset}.db`),
          enableWatch: true,
          watchPreset: preset,
          watchOptions: preset === 'custom' ? { usePolling: true } : undefined,
        });

        // 启动后立即停止（不需要真正监听）
        await c.start();
        expect(c.getName()).toBe('FileCollector');
        await c.stop();
      }
    });
  });
});
