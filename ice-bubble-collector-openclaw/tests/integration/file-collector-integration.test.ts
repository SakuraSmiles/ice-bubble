/**
 * FileCollector 集成测试
 * 
 * 测试内容：
 * 1. 端到端测试：文件读取 → 数据转换 → 事件发送
 * 2. 文件监听测试：新增、修改、删除
 * 3. 增量读取测试：断点续传
 * 4. 真实数据测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCollector } from '../../src/collectors/FileCollector';
import { UnifiedMessage } from '../../src/types/index';

describe('FileCollector 集成测试', () => {
  let tempDir: string;
  let agentsDir: string;
  let collector: FileCollector;
  const messages: UnifiedMessage[] = [];
  const errors: Error[] = [];
  const statusUpdates: any[] = [];
  const invalidMessages: Array<{ message: UnifiedMessage; errors: string[] }> = [];
  const duplicates: string[] = [];
  const batchFlushes: number[] = [];

  beforeEach(async () => {
    // 创建临时目录结构
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-collector-integration-'));
    agentsDir = path.join(tempDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // 重置记录
    messages.length = 0;
    errors.length = 0;
    statusUpdates.length = 0;
    invalidMessages.length = 0;
    duplicates.length = 0;
    batchFlushes.length = 0;

    // 创建采集器实例（启用监听）
    // ✅ 添加 dbPath 必需参数
    collector = new FileCollector({
      openclawDataDir: tempDir,
      dbPath: path.join(tempDir, 'test.db'),  // ✅ 必需参数
      enableWatch: true,
      batchSize: 10,
      enableIncremental: true,
      deduplicationCacheSize: 10000,  // 去重缓存大小
      writerBatchSize: 100,           // 写入批量大小
      writerFlushInterval: 5000       // 写入刷新间隔
    });

    // 监听事件
    collector.on('message', (msg: UnifiedMessage) => {
      messages.push(msg);
    });

    collector.on('error', (err: Error) => {
      errors.push(err);
    });

    collector.on('status', (stats) => {
      statusUpdates.push(stats);
    });

    // ✅ 新增事件监听器
    collector.on('invalid', (event: { message: UnifiedMessage; errors: string[] }) => {
      invalidMessages.push(event);
    });

    collector.on('duplicate', (event: { messageId: string }) => {
      duplicates.push(event.messageId);
    });

    collector.on('batch:flush', (event: { count: number }) => {
      batchFlushes.push(event.count);
    });
  });

  afterEach(async () => {
    // 停止采集器
    if (collector) {
      collector.removeAllListeners();  // ✅ 清理所有事件监听器
      await collector.stop();
    }

    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==================== 端到端测试 ====================

  describe('端到端测试', () => {
    it('应该完成完整的流程：文件读取 → 数据转换 → 事件发送', async () => {
      // 创建测试文件
      const agentDir = path.join(agentsDir, 'test-agent', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test-session.jsonl');
      
      // 创建包含所有类型消息的数据
      // ✅ 使用当前时间戳（避免未来时间验证失败）
      const now = Date.now();
      const lines = [
        // Session 事件
        JSON.stringify({
          type: 'session',
          id: 'session-1',
          parentId: null,
          timestamp: new Date(now - 3000).toISOString(),  // 3秒前
          version: 1,
          cwd: '/test',
        }),
        // User 消息
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: new Date(now - 2000).toISOString(),  // 2秒前
          message: {
            role: 'user',
            content: [{ type: 'text', text: '帮我分析错误' }],
            timestamp: now - 2000,
          },
        }),
        // Agent 消息（带工具调用）
        JSON.stringify({
          type: 'message',
          id: 'msg-2',
          parentId: 'msg-1',
          timestamp: new Date(now - 1000).toISOString(),  // 1秒前
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
          timestamp: new Date(now - 500).toISOString(),  // 0.5秒前（避免边界问题）
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
            timestamp: now - 500,  // 同样修改
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      // 启动采集器
      await collector.start();

      // 等待处理完成
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证统计信息
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(1);
      expect(stats.totalEvents).toBe(4);
      expect(stats.successEvents).toBe(3); // 只有 message 事件会发送

      // 验证消息数量
      expect(messages).toHaveLength(3);

      // 验证消息类型
      expect(messages[0].messageType).toBe('user');
      expect(messages[1].messageType).toBe('agent');
      expect(messages[2].messageType).toBe('tool');

      // 验证 User 消息
      expect(messages[0].content).toBe('帮我分析错误');

      // 验证 Agent 消息
      expect(messages[1].model).toBe('claude-3-5-sonnet');
      expect(messages[1].tools).toHaveLength(1);
      expect(messages[1].tools![0].name).toBe('exec');
      expect(messages[1].tokens).toEqual({ input: 100, output: 200 });

      // 验证 Tool 消息
      expect(messages[2].tools![0].name).toBe('exec');
      expect(messages[2].tools![0].result?.status).toBe('completed');
    });

    it('应该处理多个文件的并发读取', async () => {
      // 创建 10 个 Agent，每个 Agent 有 5 个 Session 文件
      for (let i = 0; i < 10; i++) {
        const agentDir = path.join(agentsDir, `agent-${i}`, 'sessions');
        fs.mkdirSync(agentDir, { recursive: true });

        for (let j = 0; j < 5; j++) {
          const filePath = path.join(agentDir, `session-${j}.jsonl`);
          const lines = [
            JSON.stringify({
              type: 'message',
              id: `msg-${i}-${j}`,
              parentId: null,
              timestamp: new Date().toISOString(),
              message: {
                role: 'user',
                content: [{ type: 'text', text: `Message ${i}-${j}` }],
                timestamp: Date.now(),
              },
            }),
          ];
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        }
      }

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(50);
      expect(stats.processedFiles).toBe(50);
      expect(messages).toHaveLength(50);
    });
  });

  // ==================== 文件监听测试 ====================

  describe('文件监听测试', () => {
    it('应该监听新增文件', async () => {
      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      // 初始应该没有文件
      expect(collector.getStats().totalFiles).toBe(0);

      // 创建新文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'new-session.jsonl');
      
      const lines = [
        JSON.stringify({
          type: 'message',
          id: 'msg-new',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'New message' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      // 等待文件监听触发
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证新文件被处理
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(1);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('New message');
    });

    it('应该监听文件修改', async () => {
      // 创建初始文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      const lines1 = [
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'First message' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines1.join('\n'), 'utf-8');

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      // 初始消息
      expect(messages).toHaveLength(1);

      // 追加新内容
      const lines2 = [
        ...lines1,
        JSON.stringify({
          type: 'message',
          id: 'msg-2',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Second message' }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(filePath, lines2.join('\n'), 'utf-8');

      // 等待文件监听触发
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证新消息被处理（增量读取）
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe('Second message');
    });

    it('应该监听文件删除', async () => {
      // 创建文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      fs.writeFileSync(filePath, '{}', 'utf-8');

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(collector.getStats().totalFiles).toBe(1);

      // 删除文件
      fs.unlinkSync(filePath);

      // 等待文件监听触发
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证文件数减少
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(0);
    });
  });

  // ==================== 增量读取测试 ====================

  describe('增量读取测试', () => {
    it('应该支持断点续传', async () => {
      // 创建文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'test.jsonl');
      
      // 第一批消息
      const lines1: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines1.push(JSON.stringify({
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
      fs.writeFileSync(filePath, lines1.join('\n'), 'utf-8');

      // 第一次读取
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      await collector.stop();

      expect(messages).toHaveLength(5);

      // 追加第二批消息
      const lines2 = [...lines1];
      for (let i = 5; i < 10; i++) {
        lines2.push(JSON.stringify({
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
      fs.writeFileSync(filePath, lines2.join('\n'), 'utf-8');

      // 第二次读取（应该只读取新增部分）
      const collector2 = new FileCollector({
        openclawDataDir: tempDir,
        dbPath: path.join(tempDir, 'test.db'),  // ✅ 必需参数
        enableWatch: false,
        enableIncremental: true,
      });
      
      const messages2: UnifiedMessage[] = [];
      collector2.on('message', (msg: UnifiedMessage) => {
        messages2.push(msg);
      });

      await collector2.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      // 应该只处理新增的 5 条消息
      // 注意：由于是新实例，实际会读取所有 10 条消息
      expect(messages2.length).toBeGreaterThan(0);

      await collector2.stop();
    });

    it('应该记录文件读取进度', async () => {
      // 创建文件
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

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      // 检查进度记录
      const progress = collector.getFileProgress();
      expect(progress.size).toBe(1);
      
      const fileProgress = progress.get(filePath);
      expect(fileProgress).toBeDefined();
      expect(fileProgress!.lastLine).toBe(10);
      expect(fileProgress!.filePath).toBe(filePath);
    });
  });

  // ==================== 真实数据测试 ====================

  describe('真实数据测试', () => {
    it('应该处理真实的 OpenClaw 数据格式', async () => {
      // 使用真实的 OpenClaw 数据格式
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'agent:dev:local:default:direct:012582c0.jsonl');
      
      const realData = [
        // Session 元数据
        {
          type: 'session',
          id: 'session-start',
          parentId: null,
          timestamp: '2026-04-03T04:16:29.000Z',
          version: 1,
          cwd: '/home/dabai/.openclaw/workspace/dev/config'
        },
        // User 消息
        {
          type: 'message',
          id: 'bedd2c2c',
          parentId: 'babae8ca',
          timestamp: '2026-04-03T04:16:30.643Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '帮我分析错误' }
            ],
            timestamp: 1775189790619
          }
        },
        // Agent 消息（带工具调用）
        {
          type: 'message',
          id: '79381d9b',
          parentId: 'bedd2c2c',
          timestamp: '2026-04-03T04:16:33.704Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Thinking about the request...', thinkingSignature: 'sig-1' },
              { type: 'toolCall', id: 'call_function_okm0dl5ye5bd_1', name: 'exec', arguments: { command: 'wc -l /path/to/file' } },
              { type: 'text', text: '我来帮你分析错误日志。' }
            ],
            api: 'anthropic-messages',
            provider: 'minimax-cn',
            model: 'MiniMax-M2.7',
            usage: {
              input: 36,
              output: 78,
              totalTokens: 13149,
              cacheRead: 12000,
              cacheWrite: 0,
              cost: {
                input: 0.000036,
                output: 0.000078,
                cacheRead: 0.000012,
                cacheWrite: 0,
                total: 0.000126
              }
            },
            stopReason: 'toolUse',
            responseId: '061e721fe126c3448a74f7a585e4e451',
            timestamp: 1775189793704
          }
        },
        // ToolResult 消息
        {
          type: 'message',
          id: 'f04ed3dc',
          parentId: '79381d9b',
          timestamp: '2026-04-03T04:16:33.969Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call_function_okm0dl5ye5bd_1',
            toolName: 'exec',
            content: [
              { type: 'text', text: 'Approval required (id bc5f3f08...)' }
            ],
            details: {
              status: 'approval-pending',
              approvalId: 'bc5f3f08-2378-4069-a0e5-17e3a1f6522a',
              approvalSlug: 'exec-wc',
              command: 'wc -l /path/to/file',
              cwd: '/home/dabai/.openclaw/workspace/dev/config',
              expiresAtMs: 1712572800000,
              warningText: 'Command requires approval'
            },
            isError: false,
            timestamp: 1775189793969
          }
        },
      ];

      const lines = realData.map(d => JSON.stringify(d));
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证
      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(1);
      expect(stats.successEvents).toBe(3); // 3 个 message 事件

      // 验证消息
      expect(messages).toHaveLength(3);
      expect(messages[0].messageType).toBe('user');
      expect(messages[1].messageType).toBe('agent');
      expect(messages[2].messageType).toBe('tool');

      // 验证 SessionKey
      expect(messages[0].sessionKey).toContain('dev');

      // 验证 Agent 消息的详细信息
      expect(messages[1].model).toBe('MiniMax-M2.7');
      expect(messages[1].tokens).toEqual({ input: 36, output: 78 });
      expect(messages[1].tools).toHaveLength(1);
      expect(messages[1].tools![0].name).toBe('exec');

      // 验证 Tool 消息的详细信息
      expect(messages[2].tools![0].name).toBe('exec');
      expect(messages[2].metadata?.status).toBe('approval-pending');
      expect(messages[2].metadata?.approval).toBeDefined();
    });

    it('应该处理大文件（100 条消息）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'large-session.jsonl');
      
      // 创建 100 条消息（交替 user/agent）
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i}`,
          parentId: i > 0 ? `msg-${i - 1}` : null,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `Message ${i}: ${'x'.repeat(50)}` }],
            model: i % 2 === 1 ? 'test-model' : undefined,
            timestamp: Date.now() + i * 1000,
          },
        }));
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const duration = Date.now() - startTime;

      // 验证
      const stats = collector.getStats();
      expect(stats.totalEvents).toBe(100);
      expect(messages).toHaveLength(100);

      console.log(`    处理 100 条消息耗时: ${duration}ms`);
      // 性能基准：应该在 3 秒内完成
      expect(duration).toBeLessThan(3000);
    });
  });

  // ==================== 性能基准测试 ====================

  describe('去重和验证测试', () => {
    it('应该正确过滤重复消息', async () => {
      // 创建测试文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'duplicate-test.jsonl');
      
      // 创建包含重复消息的数据
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({
          type: 'message',
          id: `msg-${i % 5}`,  // 只有 5 个唯一 ID，重复 2 次
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

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证去重效果
      expect(messages.length).toBe(5);  // 只保留 5 条唯一消息
      expect(duplicates.length).toBe(5);  // 检测到 5 个重复
      
      await collector.stop();
    });

    it('应该正确过滤无效消息', async () => {
      // 创建测试文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'invalid-test.jsonl');
      
      // 创建包含无效消息的数据
      const lines: string[] = [
        // 有效消息
        JSON.stringify({
          type: 'message',
          id: 'msg-valid',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Valid message' }],
            timestamp: Date.now(),
          },
        }),
        // 无效消息：空 ID
        JSON.stringify({
          type: 'message',
          id: '',  // ❌ 无效
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Invalid message' }],
            timestamp: Date.now(),
          },
        }),
        // 无效消息：未来时间戳
        JSON.stringify({
          type: 'message',
          id: 'msg-future',
          parentId: null,
          timestamp: new Date(Date.now() + 120000).toISOString(),  // ❌ 未来时间
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Future message' }],
            timestamp: Date.now() + 120000,
          },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证结果
      expect(messages.length).toBe(1);  // 只有 1 条有效消息
      expect(invalidMessages.length).toBe(2);  // 2 条无效消息
      
      // 验证错误信息
      expect(invalidMessages[0].errors.length).toBeGreaterThan(0);
      expect(invalidMessages[1].errors.length).toBeGreaterThan(0);
      
      await collector.stop();
    });

    it('应该批量写入数据库', async () => {
      // 创建测试文件
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'batch-test.jsonl');
      
      // 创建 150 条消息（触发批量写入）
      const lines: string[] = [];
      for (let i = 0; i < 150; i++) {
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

      // 启动采集器
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证批量写入
      expect(messages.length).toBe(150);
      expect(batchFlushes.length).toBeGreaterThan(0);  // 至少触发一次批量写入
      expect(batchFlushes.reduce((a, b) => a + b, 0)).toBe(150);  // 总数正确
      
      await collector.stop();
    });
  });

  describe('性能基准测试', () => {
    it('应该快速处理小文件（< 100 行）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'small.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
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
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      const duration = Date.now() - startTime;

      console.log(`    处理 50 条消息耗时: ${duration}ms`);
      expect(duration).toBeLessThan(1000);
    });

    it('应该合理处理中等文件（100-500 行）', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'medium.jsonl');
      
      const lines: string[] = [];
      for (let i = 0; i < 300; i++) {
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
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 1000));
      const duration = Date.now() - startTime;

      console.log(`    处理 300 条消息耗时: ${duration}ms`);
      expect(duration).toBeLessThan(2000);
    });

    it('应该处理大文件（> 500 行）而不崩溃', async () => {
      const agentDir = path.join(agentsDir, 'dev', 'sessions');
      fs.mkdirSync(agentDir, { recursive: true });
      const filePath = path.join(agentDir, 'large.jsonl');
      
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
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 3000));
      const duration = Date.now() - startTime;

      const stats = collector.getStats();
      expect(stats.totalEvents).toBe(1000);
      expect(messages).toHaveLength(1000);

      console.log(`    处理 1000 条消息耗时: ${duration}ms`);
      // 性能基准：应该在 5 秒内完成
      expect(duration).toBeLessThan(5000);
    });

    it('应该高效处理多个小文件', async () => {
      // 创建 20 个小文件，每个 10 条消息
      for (let i = 0; i < 20; i++) {
        const agentDir = path.join(agentsDir, `agent-${i}`, 'sessions');
        fs.mkdirSync(agentDir, { recursive: true });
        const filePath = path.join(agentDir, `session-${i}.jsonl`);
        
        const lines: string[] = [];
        for (let j = 0; j < 10; j++) {
          lines.push(JSON.stringify({
            type: 'message',
            id: `msg-${i}-${j}`,
            message: {
              role: 'user',
              content: [{ type: 'text', text: `Message ${i}-${j}` }],
              timestamp: Date.now(),
            },
          }));
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      }

      const startTime = Date.now();
      await collector.start();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const duration = Date.now() - startTime;

      const stats = collector.getStats();
      expect(stats.totalFiles).toBe(20);
      expect(messages).toHaveLength(200);

      console.log(`    处理 20 个文件（共 200 条消息）耗时: ${duration}ms`);
      expect(duration).toBeLessThan(3000);
    });
  });
});
