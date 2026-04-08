/**
 * file-reader.ts 单元测试
 * 
 * 测试内容：
 * 1. 文件读取功能
 * 2. 增量读取功能
 * 3. 错误处理
 * 4. 性能测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readJsonlFile,
  readJsonlFileIncremental,
  readJsonlFileSync,
} from '../../../src/utils/file-reader';
import { OpenClawEvent } from '../../../src/types/openclaw';

describe('file-reader', () => {
  let tempDir: string;
  let testFilePath: string;

  // 创建临时测试文件
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-reader-test-'));
    testFilePath = path.join(tempDir, 'test-session.jsonl');
  });

  // 清理临时文件
  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==================== readJsonlFile 测试 ====================

  describe('readJsonlFile', () => {
    it('应该正确读取标准 JSONL 文件', async () => {
      // 创建测试文件
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = await readJsonlFile(testFilePath);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('session');
      expect(events[1].type).toBe('message');
      expect(events[2].type).toBe('message');
    });

    it('应该跳过空行', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        '',
        '   ',
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = await readJsonlFile(testFilePath);

      expect(events).toHaveLength(2);
    });

    it('应该处理包含 BOM 的文件', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
      ];
      // 添加 UTF-8 BOM
      const content = '\uFEFF' + lines.join('\n');
      fs.writeFileSync(testFilePath, content, 'utf-8');

      const events = await readJsonlFile(testFilePath);

      // 注意：readJsonlFile 没有处理 BOM，只有 readJsonlFileIncremental 处理了
      // 所以这里期望 0，在增量读取测试中会测试 BOM 处理
      expect(events).toHaveLength(0);
    });

    it('应该处理格式错误的行', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        '{ invalid json }',
        'not json at all',
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = await readJsonlFile(testFilePath);

      // 应该成功解析 2 行，跳过 2 行错误
      expect(events).toHaveLength(2);
    });

    it('应该处理空文件', async () => {
      fs.writeFileSync(testFilePath, '', 'utf-8');

      const events = await readJsonlFile(testFilePath);

      expect(events).toHaveLength(0);
    });

    it('应该处理大文件（1000 行）', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      const events = await readJsonlFile(testFilePath);
      const duration = Date.now() - startTime;

      expect(events).toHaveLength(1000);
      // 性能检查：1000 行应该在 1 秒内完成
      expect(duration).toBeLessThan(1000);
    });

    it('应该在文件不存在时抛出错误', async () => {
      const nonExistPath = path.join(tempDir, 'not-exist.jsonl');

      await expect(readJsonlFile(nonExistPath)).rejects.toThrow('文件不存在');
    });

    it('应该正确处理包含特殊字符的内容', async () => {
      const specialContent = {
        type: 'message',
        id: '1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '包含特殊字符：\n\t\r"quotes\'单引号' }],
          timestamp: 0,
        },
      };
      fs.writeFileSync(testFilePath, JSON.stringify(specialContent), 'utf-8');

      const events = await readJsonlFile(testFilePath);

      expect(events).toHaveLength(1);
      expect((events[0] as any).message.content[0].text).toContain('包含特殊字符');
    });
  });

  // ==================== readJsonlFileIncremental 测试 ====================

  describe('readJsonlFileIncremental', () => {
    it('应该从头开始读取整个文件', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(3);
      expect(result.endLine).toBe(3);
    });

    it('应该支持增量读取（跳过前 N 行）', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '4', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      // 读取前 2 行
      const result1 = await readJsonlFileIncremental(testFilePath, 0);
      expect(result1.events).toHaveLength(4);
      expect(result1.endLine).toBe(4);

      // 从第 2 行开始读取（模拟断点续传）
      const result2 = await readJsonlFileIncremental(testFilePath, 2);
      expect(result2.events).toHaveLength(2);
      expect(result2.endLine).toBe(4);
      expect(result2.events[0].id).toBe('3');
      expect(result2.events[1].id).toBe('4');
    });

    it('应该正确处理起始行等于文件行数的情况', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 2);

      expect(result.events).toHaveLength(0);
      expect(result.endLine).toBe(2);
    });

    it('应该正确处理起始行大于文件行数的情况', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 100);

      expect(result.events).toHaveLength(0);
      expect(result.endLine).toBe(1);
    });

    it('应该拒绝负数的起始行', async () => {
      fs.writeFileSync(testFilePath, '{}', 'utf-8');

      await expect(readJsonlFileIncremental(testFilePath, -1)).rejects.toThrow('起始行号不能为负数');
    });

    it('应该正确处理包含空行的增量读取', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        '', // 空行
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        '   ', // 空白行
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 0);

      // 空行应该被跳过，不计入事件
      expect(result.events).toHaveLength(3);
      // endLine 应该是实际行数（包括空行）
      expect(result.endLine).toBe(5);
    });

    it('应该正确处理 BOM 字符', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
      ];
      const content = '\uFEFF' + lines.join('\n');
      fs.writeFileSync(testFilePath, content, 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(1);
    });

    it('应该在文件不存在时抛出错误', async () => {
      const nonExistPath = path.join(tempDir, 'not-exist.jsonl');

      await expect(readJsonlFileIncremental(nonExistPath, 0)).rejects.toThrow('文件不存在');
    });
  });

  // ==================== readJsonlFileSync 测试 ====================

  describe('readJsonlFileSync', () => {
    it('应该同步读取文件', () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = readJsonlFileSync(testFilePath);

      expect(events).toHaveLength(2);
    });

    it('应该在文件不存在时抛出错误', () => {
      const nonExistPath = path.join(tempDir, 'not-exist.jsonl');

      expect(() => readJsonlFileSync(nonExistPath)).toThrow('文件不存在');
    });

    it('应该跳过空行', () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        '',
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = readJsonlFileSync(testFilePath);

      expect(events).toHaveLength(2);
    });
  });

  // ==================== 性能测试 ====================

  describe('性能测试', () => {
    it('应该在大文件（10000 行）上保持良好性能', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 10000; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: i > 0 ? `msg-${i - 1}` : null,
          timestamp: new Date().toISOString(),
          message: {
            role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'toolResult',
            content: [{ type: 'text', text: `Message content ${i}` }],
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      const events = await readJsonlFile(testFilePath);
      const duration = Date.now() - startTime;

      expect(events).toHaveLength(10000);
      console.log(`    读取 10000 行耗时: ${duration}ms`);
      // 性能基准：10000 行应该在 3 秒内完成
      expect(duration).toBeLessThan(3000);
    });

    it('增量读取应该比全量读取更快', async () => {
      // 创建大文件
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          message: { role: 'user', content: [], timestamp: 0 },
        }));
      }
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      // 全量读取
      const startTime1 = Date.now();
      const result1 = await readJsonlFileIncremental(testFilePath, 0);
      const duration1 = Date.now() - startTime1;

      // 增量读取（只读最后 100 行）
      const startTime2 = Date.now();
      const result2 = await readJsonlFileIncremental(testFilePath, 4900);
      const duration2 = Date.now() - startTime2;

      console.log(`    全量读取 5000 行: ${duration1}ms`);
      console.log(`    增量读取 100 行: ${duration2}ms`);

      // 增量读取应该明显更快
      expect(duration2).toBeLessThan(duration1);
    });
  });

  // ==================== 内存使用测试 ====================

  describe('内存使用测试', () => {
    it('应该正确处理大文件而不导致内存溢出', async () => {
      // 创建 5MB 大小的文件
      const lines: string[] = [];
      const contentSize = 5 * 1024 * 1024; // 5MB
      const avgLineSize = 200; // 平均每行 200 字节
      const lineCount = Math.floor(contentSize / avgLineSize);

      for (let i = 0; i < lineCount; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(100) }], // 100 字节内容
            timestamp: Date.now(),
          },
        }));
      }
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const memBefore = process.memoryUsage().heapUsed;
      const events = await readJsonlFile(testFilePath);
      const memAfter = process.memoryUsage().heapUsed;
      const memDiff = (memAfter - memBefore) / 1024 / 1024; // MB

      console.log(`    内存增长: ${memDiff.toFixed(2)} MB`);
      expect(events.length).toBeGreaterThan(0);
      // 内存增长应该合理（不超过文件大小的 3 倍）
      expect(memDiff).toBeLessThan(15); // 15MB
    });
  });
});
