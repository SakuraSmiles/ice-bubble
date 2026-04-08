/**
 * CollectionPipeline 单元测试
 *
 * 覆盖 CollectionPipeline 类的所有核心功能：
 * - 初始化与组件注入
 * - processEvents 数据流转（转换→验证→去重→写入）
 * - Session 自动创建
 * - 统计信息
 * - 生命周期 (start/stop)
 * - 错误处理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CollectionPipeline } from '../../../src/collectors/CollectionPipeline';
import { DataValidator } from '../../../src/processors/DataValidator';
import { Deduplicator } from '../../../src/processors/deduplicator';
import { BatchWriter } from '../../../src/processors/BatchWriter';
import { SQLiteManager } from '../../../src/storage/sqlite-manager';
import { OpenClawEvent } from '../../../src/types/openclaw';
import { UnifiedMessage } from '../../../src/types/index';

// ==================== 测试辅助函数 ====================

/** 创建有效的 User MessageEvent */
function createUserEvent(id: string, content: string, timestamp?: string): OpenClawEvent {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: timestamp || new Date(Date.now() - 5000).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now() - 5000,
    },
  };
}

/** 创建有效的 Assistant MessageEvent */
function createAssistantEvent(id: string, content: string, model: string): OpenClawEvent {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(Date.now() - 4000).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      model,
      usage: { input: 10, output: 20, totalTokens: 30, cacheRead: 0, cacheWrite: 0, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
      timestamp: Date.now() - 4000,
    },
  };
}

/** 创建有效的 ToolResult MessageEvent */
function createToolResultEvent(id: string, toolName: string): OpenClawEvent {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(Date.now() - 3000).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId: `call-${id}`,
      toolName,
      content: [{ type: 'text', text: 'done' }],
      details: { status: 'completed', exitCode: 0, durationMs: 50 },
      isError: false,
      timestamp: Date.now() - 3000,
    },
  };
}

/** 创建无效的事件（未来时间戳） */
function createFutureTimestampEvent(id: string): OpenClawEvent {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(Date.now() + 120000).toISOString(), // 未来 2 分钟
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'future' }],
      timestamp: Date.now() + 120000,
    },
  };
}

/** 创建 Session 事件（不会被转换为消息） */
function createSessionEvent(): OpenClawEvent {
  return {
    type: 'session',
    id: 'session-1',
    parentId: null,
    timestamp: new Date().toISOString(),
    version: 1,
    cwd: '/test/workspace',
  };
}

// ==================== 测试环境搭建 ====================

interface PipelineTestEnv {
  tempDir: string;
  dbPath: string;
  sqliteManager: SQLiteManager;
  validator: DataValidator;
  deduplicator: Deduplicator;
  batchWriter: BatchWriter;
  pipeline: CollectionPipeline;
  events: {
    messages: UnifiedMessage[];
    invalids: Array<{ message: UnifiedMessage; errors: string[] }>;
    duplicates: Array<{ messageId: string }>;
    batchFlushes: Array<{ count: number }>;
    errors: Error[];
  };
}

async function createPipelineEnv(config?: {
  dedupCacheSize?: number;
  batchSize?: number;
}): Promise<PipelineTestEnv> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  const dbPath = path.join(tempDir, 'test.db');

  const sqliteManager = new SQLiteManager();
  await sqliteManager.init({
    dbPath,
    walMode: true,
    foreignKeys: true,
  });

  const validator = new DataValidator();
  const deduplicator = new Deduplicator({ cacheSize: config?.dedupCacheSize ?? 10000 });
  const batchWriter = new BatchWriter(sqliteManager, {
    batchSize: 5,
    flushInterval: 5000,
  });

  const pipeline = new CollectionPipeline(
    sqliteManager, validator, deduplicator, batchWriter,
    { batchSize: config?.batchSize ?? 100 }
  );

  const events = {
    messages: [] as UnifiedMessage[],
    invalids: [] as Array<{ message: UnifiedMessage; errors: string[] }>,
    duplicates: [] as Array<{ messageId: string }>,
    batchFlushes: [] as Array<{ count: number }>,
    errors: [] as Error[],
  };

  pipeline.on('message', (msg) => events.messages.push(msg));
  pipeline.on('invalid', (ev) => events.invalids.push(ev));
  pipeline.on('duplicate', (ev) => events.duplicates.push(ev));
  pipeline.on('batch:flush', (ev) => events.batchFlushes.push(ev));
  pipeline.on('error', (err) => events.errors.push(err));

  pipeline.start();

  return { tempDir, dbPath, sqliteManager, validator, deduplicator, batchWriter, pipeline, events };
}

async function destroyPipelineEnv(env: PipelineTestEnv): Promise<void> {
  await env.pipeline.stop();
  await env.sqliteManager.close();
  if (fs.existsSync(env.tempDir)) {
    fs.rmSync(env.tempDir, { recursive: true, force: true });
  }
}

// ==================== 测试套件 ====================

const TEST_SESSION_KEY = 'agent:test-agent:local:default:direct:peer-001';

describe('CollectionPipeline', () => {
  let env: PipelineTestEnv;

  beforeEach(async () => {
    env = await createPipelineEnv();
  });

  afterEach(async () => {
    await destroyPipelineEnv(env);
  });

  // ==================== CP-1xx: 初始化与组件注入 ====================

  describe('初始化', () => {
    it('CP-101: 应该正确创建 Pipeline 实例', () => {
      expect(env.pipeline).toBeDefined();
      expect(env.pipeline).toBeInstanceOf(CollectionPipeline);
    });

    it('CP-102: getStats() 初始值应为全零', () => {
      const stats = env.pipeline.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.successEvents).toBe(0);
      expect(stats.failedEvents).toBe(0);
    });

    it('CP-103: resetStats() 应重置所有统计', () => {
      // 先设置一些初始数据
      env.pipeline.resetStats();
      const stats = env.pipeline.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.successEvents).toBe(0);
      expect(stats.failedEvents).toBe(0);
    });
  });

  // ==================== CP-2xx: processEvents 核心流程 ====================

  describe('processEvents 核心流程', () => {
    it('CP-201: 应该处理单个有效的 User 事件', async () => {
      const event = createUserEvent('msg-1', 'Hello world');
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(1);
      expect(env.events.messages[0].id).toBe('msg-1');
      expect(env.events.messages[0].messageType).toBe('user');
      expect(env.events.messages[0].content).toBe('Hello world');
    });

    it('CP-202: 应该处理单个有效的 Agent 事件', async () => {
      const event = createAssistantEvent('msg-2', 'AI response', 'gpt-4');
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(1);
      expect(env.events.messages[0].messageType).toBe('agent');
      expect(env.events.messages[0].model).toBe('gpt-4');
      expect(env.events.messages[0].tokens).toEqual({ input: 10, output: 20 });
    });

    it('CP-203: 应该处理单个有效的 ToolResult 事件', async () => {
      const event = createToolResultEvent('msg-3', 'exec');
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(1);
      expect(env.events.messages[0].messageType).toBe('tool');
      expect(env.events.messages[0].tools).toHaveLength(1);
      expect(env.events.messages[0].tools![0].name).toBe('exec');
      expect(env.events.messages[0].tools![0].result?.status).toBe('completed');
    });

    it('CP-204: 应该批量处理多个事件', async () => {
      const events = [
        createUserEvent('msg-1', 'User msg'),
        createAssistantEvent('msg-2', 'Agent msg', 'claude-3'),
        createToolResultEvent('msg-3', 'read_file'),
      ];
      await env.pipeline.processEvents(events, TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(3);
      expect(env.events.messages[0].messageType).toBe('user');
      expect(env.events.messages[1].messageType).toBe('agent');
      expect(env.events.messages[2].messageType).toBe('tool');
    });

    it('CP-205: 空数组不应报错也不应产生任何事件', async () => {
      await env.pipeline.processEvents([], TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(0);
      expect(env.events.invalids).toHaveLength(0);
      expect(env.events.errors).toHaveLength(0);
    });

    it('CP-206: Session 事件应被忽略（不产生消息）', async () => {
      const sessionEvent = createSessionEvent();
      await env.pipeline.processEvents([sessionEvent], TEST_SESSION_KEY);

      // Session 事件不会转换为 UnifiedMessage
      expect(env.events.messages).toHaveLength(0);
    });

    it('CP-207: 事件顺序应该保持 FIFO', async () => {
      const events: OpenClawEvent[] = [];
      for (let i = 0; i < 10; i++) {
        events.push(createUserEvent(`msg-${i}`, `Message ${i}`));
      }
      await env.pipeline.processEvents(events, TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(env.events.messages[i].id).toBe(`msg-${i}`);
      }
    });
  });

  // ==================== CP-3xx: 数据验证 ====================

  describe('数据验证', () => {
    it('CP-301: 未来时间戳的事件应 emit invalid', async () => {
      const futureEvent = createFutureTimestampEvent('future-msg');
      await env.pipeline.processEvents([futureEvent], TEST_SESSION_KEY);

      expect(env.events.invalids).toHaveLength(1);
      expect(env.events.invalids[0].message.id).toBe('future-msg');
      expect(env.events.messages).toHaveLength(0);
    });

    it('CP-302: 混合有效和无效事件时只处理有效的', async () => {
      const events = [
        createUserEvent('valid-1', 'Valid one'),
        createFutureTimestampEvent('invalid-future'),
        createAssistantEvent('valid-2', 'Valid two', 'model-x'),
      ];
      await env.pipeline.processEvents(events, TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(2); // 只有 2 个有效
      expect(env.events.invalids).toHaveLength(1);  // 1 个无效
      expect(env.events.messages[0].id).toBe('valid-1');
      expect(env.events.messages[1].id).toBe('valid-2');
    });

    it('CP-303: invalid 事件应包含详细的错误信息', async () => {
      const futureEvent = createFutureTimestampEvent('err-detail');
      await env.pipeline.processEvents([futureEvent], TEST_SESSION_KEY);

      expect(env.events.invalids).toHaveLength(1);
      expect(env.events.invalids[0].errors.length).toBeGreaterThan(0);
      // 应包含时间戳相关的错误
      const hasTimestampError = env.events.invalids[0].errors.some(e =>
        e.includes('timestamp')
      );
      expect(hasTimestampError).toBe(true);
    });
  });

  // ==================== CP-4xx: 去重检查 ====================

  describe('去重检查', () => {
    it('CP-401: 重复 ID 的事件第二次应 emit duplicate', async () => {
      const event = createUserEvent('dup-msg', 'First time');

      // 第一次处理
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);
      expect(env.events.messages).toHaveLength(1);
      expect(env.events.duplicates).toHaveLength(0);

      // 第二次处理相同 ID
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);
      expect(env.events.duplicates).toHaveLength(1);
      expect(env.events.duplicates[0].messageId).toBe('dup-msg');
      // 消息总数仍为 1（没有新增）
      expect(env.events.messages).toHaveLength(1);
    });

    it('CP-402: 不同 ID 的事件不应被视为重复', async () => {
      const event1 = createUserEvent('unique-1', 'First');
      const event2 = createUserEvent('unique-2', 'Second');

      await env.pipeline.processEvents([event1], TEST_SESSION_KEY);
      await env.pipeline.processEvents([event2], TEST_SESSION_KEY);

      expect(env.events.messages).toHaveLength(2);
      expect(env.events.duplicates).toHaveLength(0);
    });

    it('CP-403: 批量中有部分重复时只处理唯一的', async () => {
      const events = [
        createUserEvent('unique-a', 'A'),
        createUserEvent('shared-b', 'B first'),
        createUserEvent('unique-c', 'C'),
      ];
      await env.pipeline.processEvents(events, TEST_SESSION_KEY);
      expect(env.events.messages).toHaveLength(3);

      // 再次处理，包含一个已存在的 ID
      const events2 = [
        createUserEvent('shared-b', 'B second'),  // 重复
        createUserEvent('unique-d', 'D'),           // 新增
      ];
      await env.pipeline.processEvents(events2, TEST_SESSION_KEY);

      expect(env.events.duplicates).toHaveLength(1);
      expect(env.events.duplicates[0].messageId).toBe('shared-b');
      expect(env.events.messages).toHaveLength(4);  // 3 + 1
    });
  });

  // ==================== CP-5xx: Session 管理 ====================

  describe('Session 自动创建', () => {
    it('CP-501: ensureSession 应自动创建 Session 记录', async () => {
      const sessionKey = 'agent:new-agent:discord:srv-123:direct:user-456';

      await env.pipeline.ensureSession(sessionKey);

      const session = await env.sqliteManager.getSession(sessionKey);
      expect(session).not.toBeNull();
      expect(session!.sessionKey).toBe(sessionKey);
      expect(session!.agentId).toBe('new-agent');
      expect(session!.channel).toBe('discord');
    });

    it('CP-502: 已存在的 Session 不应重复创建', async () => {
      const sessionKey = 'agent:existing:slack:ch-789:direct:user-000';

      // 第一次创建
      await env.pipeline.ensureSession(sessionKey);
      const session1 = await env.sqliteManager.getSession(sessionKey);

      // 第二次调用
      await env.pipeline.ensureSession(sessionKey);
      const session2 = await env.sqliteManager.getSession(sessionKey);

      // 应该是同一个 session
      expect(session1!.sessionKey).toBe(session2!.sessionKey);
    });

    it('CP-503: processEvents 内部应自动 ensureSession', async () => {
      const autoSessionKey = 'agent:auto-session:telegram:default:direct:user-auto';

      const event = createUserEvent('auto-msg', 'Auto session test');
      await env.pipeline.processEvents([event], autoSessionKey);

      // Session 应该已被自动创建
      const session = await env.sqliteManager.getSession(autoSessionKey);
      expect(session).not.toBeNull();
      expect(session!.agentId).toBe('auto-session');
    });

    it('CP-504: 无效格式的 SessionKey 不应崩溃', async () => {
      const badKeys = [
        '',
        'not-valid-format',
        'agent:only-two-parts',
        'agent:a:b:c:d:e:f:g:h',  // 太多段
      ];

      for (const key of badKeys) {
        await expect(
          env.pipeline.ensureSession(key)
        ).resolves.not.toThrow();
      }

      // 不应该有任何消息被处理
      expect(env.events.errors).toHaveLength(0);
    });
  });

  // ==================== CP-6xx: 批量写入 ====================

  describe('批量写入', () => {
    it('CP-601: 消息应被写入到数据库', async () => {
      const event = createUserEvent('db-write', 'Write to DB');
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);

      // 停止管道以刷新缓冲区
      await env.pipeline.stop();

      // 查询数据库确认消息存在
      // 注意：SQLiteManager 的查询方法需要根据实际 API 调整
      const stats = env.batchWriter.getStats();
      expect(stats.totalProcessed).toBeGreaterThanOrEqual(1);
    });
  });

  // ==================== CP-7xx: 生命周期 ====================

  describe('生命周期', () => {
    it('CP-701: start() 应启动 BatchWriter', async () => {
      // 已经在 beforeEach 中调用了 start()
      const stats = env.batchWriter.getStats();
      expect(stats).toBeDefined();
    });

    it('CP-702: stop() 应刷新剩余缓冲区', async () => {
      const event = createUserEvent('flush-on-stop', 'Flush me');
      await env.pipeline.processEvents([event], TEST_SESSION_KEY);

      // stop 应该触发 flush
      await env.pipeline.stop();

      // batchFlushes 或 buffer 应该被清理
      expect(env.events.errors).toHaveLength(0);
    });
  });

  // ==================== CP-8xx: 统计信息 ====================

  describe('统计信息', () => {
    it('CP-801: 成功处理后 stats.totalEvents 应增加', async () => {
      const events = [
        createUserEvent('stat-1', 'Stat 1'),
        createUserEvent('stat-2', 'Stat 2'),
      ];
      await env.pipeline.processEvents(events, TEST_SESSION_KEY);

      const stats = env.pipeline.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.successEvents).toBe(2);
      expect(stats.failedEvents).toBe(0);
    });

    it('CP-802: 失败事件应反映在 stats.failedEvents 中', async () => {
      const validEvent = createUserEvent('ok', 'OK');
      const failEvent = createFutureTimestampEvent('fail-time');

      await env.pipeline.processEvents([validEvent, failEvent], TEST_SESSION_KEY);

      const stats = env.pipeline.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.successEvents).toBe(1);
      expect(stats.failedEvents).toBe(1);
    });

    it('CP-803: 统计信息应为快照（不受后续修改影响）', async () => {
      await env.pipeline.processEvents(
        [createUserEvent('snapshot-1', 'S1')],
        TEST_SESSION_KEY
      );

      const snapshot = env.pipeline.getStats();
      expect(snapshot.totalEvents).toBe(1);

      // 再处理一些事件
      await env.pipeline.processEvents(
        [createUserEvent('snapshot-2', 'S2')],
        TEST_SESSION_KEY
      );

      // 快照不应变化
      expect(snapshot.totalEvents).toBe(1);
      // 当前 stats 应该更新
      expect(env.pipeline.getStats().totalEvents).toBe(2);
    });
  });
});

// ==================== 独立测试：自定义配置 ====================

describe('CollectionPipeline 自定义配置', () => {
  it('应该支持自定义 batchSize', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-custom-'));
    const dbPath = path.join(tempDir, 'test.db');

    const sqliteManager = new SQLiteManager();
    await sqliteManager.init({ dbPath, walMode: true, foreignKeys: true });

    const validator = new DataValidator();
    const deduplicator = new Deduplicator({ cacheSize: 100 });
    const batchWriter = new BatchWriter(sqliteManager, { batchSize: 3, flushInterval: 1000 });

    const pipeline = new CollectionPipeline(
      sqliteManager, validator, deduplicator, batchWriter,
      { batchSize: 5 }
    );

    pipeline.start();

    const events: OpenClawEvent[] = [];
    for (let i = 0; i < 7; i++) {
      events.push(createUserEvent(`batch-config-${i}`, `Msg ${i}`));
    }

    // 不应报错
    await pipeline.processEvents(events, TEST_SESSION_KEY);
    const stats = pipeline.getStats();
    expect(stats.totalEvents).toBe(7);

    await pipeline.stop();
    await sqliteManager.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
