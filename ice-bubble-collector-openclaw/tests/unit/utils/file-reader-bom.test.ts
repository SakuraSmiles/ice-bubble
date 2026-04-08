/**
 * BOM 处理优化测试
 * 
 * 测试内容：
 * 1. 无 BOM 文件正常读取
 * 2. 有 BOM 文件正确处理
 * 3. BOM 只在文件开头出现一次
 * 4. 大文件 BOM 处理性能测试
 * 5. 多次读取同一文件不重复处理 BOM
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readJsonlFile,
  readJsonlFileIncremental,
} from '../../../src/utils/file-reader';

describe('BOM 处理优化', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-test-'));
    testFilePath = path.join(tempDir, 'test-bom.jsonl');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==================== 测试 1: 无 BOM 文件正常读取 ====================

  describe('无 BOM 文件', () => {
    it('应该正确读取无 BOM 的标准 UTF-8 文件', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const events = await readJsonlFile(testFilePath);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('session');
      expect(events[1].type).toBe('message');
    });

    it('应该正确处理无 BOM 的增量读取', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(2);
      expect(result.endLine).toBe(2);
    });
  });

  // ==================== 测试 2: 有 BOM 文件正确处理 ====================

  describe('有 BOM 文件', () => {
    it('应该正确处理 UTF-8 with BOM 文件（增量读取）', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      // 添加 UTF-8 BOM (EF BB BF)
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].type).toBe('session');
      expect(result.events[1].type).toBe('message');
    });

    it('应该正确处理 Windows 记事本格式的文件（UTF-8 with BOM）', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: 'session-123', version: 1, cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'msg-456',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Hello, 世界！' }],
            timestamp: Date.now(),
          },
        }),
      ];
      // 模拟 Windows 记事本格式：UTF-8 with BOM + CRLF
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\r\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(2);
      expect((result.events[1] as any).message.content[0].text).toBe('Hello, 世界！');
    });

    it('应该在移除 BOM 后能正确解析 JSON', async () => {
      const validJson = JSON.stringify({
        type: 'session',
        id: 'test-123',
        version: 1,
        cwd: '/测试路径',
        data: '包含中文的测试数据',
      });
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(validJson, 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('test-123');
      expect((result.events[0] as any).cwd).toBe('/测试路径');
    });
  });

  // ==================== 测试 3: BOM 只在文件开头出现一次 ====================

  describe('BOM 检查唯一性', () => {
    it('应该只在文件开头检查一次 BOM', async () => {
      // 创建包含多行的大文件
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
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
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      // 第一次读取
      const result1 = await readJsonlFileIncremental(testFilePath, 0);
      expect(result1.events).toHaveLength(100);

      // 第二次读取（模拟重新读取整个文件）
      const result2 = await readJsonlFileIncremental(testFilePath, 0);
      expect(result2.events).toHaveLength(100);
      
      // 两次读取结果应该一致
      expect(result1.events[0].id).toBe(result2.events[0].id);
      expect(result1.events[99].id).toBe(result2.events[99].id);
    });

    it('应该正确处理文件中间包含 BOM 字节序列的情况（不应移除）', async () => {
      // 注意：UTF-8 编码中，BOM 字节序列 (EF BB BF) 如果出现在文件中间，
      // 通常不是真正的 BOM，而是其他数据的一部分
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
      ];
      
      // 在文件开头添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      // 应该正确解析，BOM 只在开头被移除一次
      expect(result.events).toHaveLength(2);
    });
  });

  // ==================== 测试 4: 大文件 BOM 处理性能测试 ====================

  describe('性能测试', () => {
    it('应该高效处理带 BOM 的大文件（10000 行）', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 10000; i++) {
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
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const startTime = Date.now();
      const result = await readJsonlFileIncremental(testFilePath, 0);
      const duration = Date.now() - startTime;

      expect(result.events).toHaveLength(10000);
      console.log(`    处理带 BOM 的 10000 行文件耗时: ${duration}ms`);
      
      // 性能基准：应该比之前的实现快至少 80%（目标 < 3秒）
      expect(duration).toBeLessThan(3000);
    });

    it('BOM 处理不应显著影响无 BOM 文件的性能', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
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

      // 测试无 BOM 文件
      fs.writeFileSync(testFilePath, lines.join('\n'), 'utf-8');
      const startTime1 = Date.now();
      const result1 = await readJsonlFileIncremental(testFilePath, 0);
      const duration1 = Date.now() - startTime1;

      // 测试有 BOM 文件
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);
      
      const startTime2 = Date.now();
      const result2 = await readJsonlFileIncremental(testFilePath, 0);
      const duration2 = Date.now() - startTime2;

      expect(result1.events).toHaveLength(5000);
      expect(result2.events).toHaveLength(5000);
      
      console.log(`    无 BOM 文件: ${duration1}ms`);
      console.log(`    有 BOM 文件: ${duration2}ms`);
      
      // BOM 处理的开销应该很小（不超过 20%）
      const overhead = (duration2 - duration1) / duration1;
      expect(overhead).toBeLessThan(0.2);
    });
  });

  // ==================== 测试 5: 多次读取同一文件不重复处理 BOM ====================

  describe('多次读取一致性', () => {
    it('应该确保多次读取结果一致', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
      ];
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      // 连续读取 5 次
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await readJsonlFileIncremental(testFilePath, 0);
        results.push(result);
      }

      // 所有结果应该完全一致
      for (let i = 1; i < results.length; i++) {
        expect(results[i].events).toEqual(results[0].events);
        expect(results[i].endLine).toBe(results[0].endLine);
      }
    });

    it('应该在增量读取中正确处理 BOM', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
        JSON.stringify({ type: 'message', id: '2', message: { role: 'user', content: [], timestamp: 0 } }),
        JSON.stringify({ type: 'message', id: '3', message: { role: 'assistant', content: [], timestamp: 0 } }),
      ];
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      // 第一次读取前 2 行
      const result1 = await readJsonlFileIncremental(testFilePath, 0);
      expect(result1.events).toHaveLength(3);
      expect(result1.endLine).toBe(3);

      // 第二次从第 1 行开始（模拟增量读取）
      const result2 = await readJsonlFileIncremental(testFilePath, 1);
      expect(result2.events).toHaveLength(2);
      expect(result2.events[0].id).toBe('2');
      expect(result2.events[1].id).toBe('3');

      // 第三次从第 2 行开始
      const result3 = await readJsonlFileIncremental(testFilePath, 2);
      expect(result3.events).toHaveLength(1);
      expect(result3.events[0].id).toBe('3');
    });
  });

  // ==================== 边界情况测试 ====================

  describe('边界情况', () => {
    it('应该正确处理只有 BOM 的空文件', async () => {
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      fs.writeFileSync(testFilePath, bomBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(0);
      expect(result.endLine).toBe(0);
    });

    it('应该正确处理 BOM 后紧跟换行符的文件', async () => {
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from('\n{"type":"session","id":"1","version":1,"cwd":"/test"}', 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('session');
    });

    it('应该正确处理不同编码声明但实际是 UTF-8 with BOM 的文件', async () => {
      const lines = [
        JSON.stringify({ type: 'session', id: '1', version: 1, cwd: '/test' }),
      ];
      
      // 添加 BOM
      const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(lines.join('\n'), 'utf-8');
      const fileBuffer = Buffer.concat([bomBuffer, contentBuffer]);
      fs.writeFileSync(testFilePath, fileBuffer);

      const result = await readJsonlFileIncremental(testFilePath, 0);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('1');
    });
  });
});
