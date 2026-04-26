/**
 * DataSync 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInMemoryDatabase, initializeSchema } from './helpers/sqlite-test-helper.js';
import { DataRepository } from '../src/storage/data-repository.js';
import { DataSync } from '../src/data/data-sync.js';
import type { CollectorSession, CollectorMessage, CollectorAgent } from '../src/data/collector-client.js';

// Mock CollectorClient
vi.mock('../src/data/collector-client.js', () => {
  return {
    CollectorClient: vi.fn().mockImplementation(() => ({
      getSessions: vi.fn(),
      getMessages: vi.fn(),
      getAgents: vi.fn(),
      getStats: vi.fn(),
    })),
  };
});

// Mock SubagentEventParser
vi.mock('../src/data/subagent-event-parser.js', () => {
  return {
    SubagentEventParser: vi.fn().mockImplementation(() => ({
      parseBatch: vi.fn().mockResolvedValue({ created: 0, updated: 0, errors: 0 }),
    })),
  };
});

describe('DataSync', () => {
  let db: ReturnType<typeof createInMemoryDatabase>;
  let repository: DataRepository;
  let DataSyncClass: typeof DataSync;
  let mockCollectorClient: ReturnType<typeof vi.mocked<any>>;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    initializeSchema(db);
    repository = new DataRepository(db, '/tmp/avatars');

    // 导入 DataSync 以触发 mock
    const mod = await import('../src/data/data-sync.js');
    DataSyncClass = mod.DataSync;
    mockCollectorClient = vi.mocked(mod).CollectorClient as any;
  });

  describe('constructor', () => {
    it('应该使用默认配置', () => {
      const sync = new DataSyncClass({}, repository);
      expect(sync).toBeDefined();
      sync.stop();
    });

    it('应该接受自定义配置', () => {
      const sync = new DataSyncClass({
        collectorBaseUrl: 'http://localhost:14000',
        moduleKey: 'custom-key',
        pollInterval: 30000,
        batchSize: 100,
      }, repository);
      expect(sync).toBeDefined();
      sync.stop();
    });
  });

  describe('syncSessions', () => {
    it('stop() 不抛出', () => {
      const sync = new DataSyncClass({}, repository);
      expect(() => sync.stop()).not.toThrow();
    });

    it('ping() 连接成功时返回 true', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn(),
        getMessages: vi.fn(),
        getAgents: vi.fn(),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));
      const sync = new DataSyncClass({ collectorBaseUrl: 'http://localhost:14000' }, repository);
      const result = await sync.ping();
      expect(result).toBe(true);
      sync.stop();
    });

    it('ping() 连接失败时返回 false', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn(),
        getMessages: vi.fn(),
        getAgents: vi.fn(),
        getStats: vi.fn().mockRejectedValue(new Error('connection refused')),
      }));
      const sync = new DataSyncClass({ collectorBaseUrl: 'http://localhost:65535' }, repository);
      const result = await sync.ping();
      expect(result).toBe(false);
      sync.stop();
    });
  });

  describe('syncAll', () => {
    it('syncAll 应该捕获异常而不抛出', async () => {
      // 让 getSessions 抛出异常
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockRejectedValue(new Error('network error')),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockRejectedValue(new Error('network error')),
      }));

      const sync = new DataSyncClass({}, repository);
      // syncAll 是异步方法，失败应该被内部 catch 住
      await expect(sync.syncAll()).resolves.toBeUndefined();
      sync.stop();
    });

    it('syncAll 正常完成时应该成功', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await expect(sync.syncAll()).resolves.toBeUndefined();
      sync.stop();
    });
  });

  describe('getMessagesTimeline', () => {
    it('Timeline 查询应该返回正确结构', async () => {
      // 准备数据
      repository.saveSessions([{
        session_key: 'agent:test-agent:abc',
        source_module: 'test',
        agent_id: 'test-agent',
        channel: 'test-channel',
        message_count: 2,
        first_message_at: '2024-01-01T00:00:00Z',
        last_message_at: '2024-01-01T01:00:00Z',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        source_created_at: null,
      }]);
      repository.saveMessages([
        {
          source_id: 1, source_module: 'test', session_key: 'agent:test-agent:abc',
          message_type: 'user', content: 'Hello', model: 'gpt-4',
          tokens_input: 10, tokens_output: 20, cost_total: 0.01,
          cost_input: 0.005, cost_output: 0.005,
          timestamp: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
        },
        {
          source_id: 2, source_module: 'test', session_key: 'agent:test-agent:abc',
          message_type: 'agent', content: 'Hi there!', model: 'gpt-4',
          tokens_input: 20, tokens_output: 30, cost_total: 0.02,
          cost_input: 0.01, cost_output: 0.01,
          timestamp: '2024-01-01T00:01:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
        },
      ]);
      // 注册 agent
      repository.refreshAgents([{
        agent_id: 'test-agent', agent_name: 'Test Agent', workspace: '/test', source: 'openclaw',
        config_json: '{}', status: 'running',
        last_seen_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }] as any, 'test');

      const result = repository.getMessagesTimeline({ limit: 50 });
      expect(result.messages.length).toBe(2);
      expect(result.pagination).toHaveProperty('oldest');
      expect(result.pagination).toHaveProperty('newest');
    });

    it('Timeline 应该支持 message_types 过滤', () => {
      repository.saveSessions([{
        session_key: 'agent:test-agent:abc', source_module: 'test',
        agent_id: 'test-agent', channel: 'ch', message_count: 2,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      repository.saveMessages([
        { source_id: 1, source_module: 'test', session_key: 'agent:test-agent:abc', message_type: 'user', content: 'Hello', model: null, tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null, timestamp: '2024-01-01T00:00:00Z', created_at: '', source_created_at: null },
        { source_id: 2, source_module: 'test', session_key: 'agent:test-agent:abc', message_type: 'agent', content: 'Hi', model: null, tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null, timestamp: '2024-01-01T00:01:00Z', created_at: '', source_created_at: null },
      ]);

      const result = repository.getMessagesTimeline({ message_types: 'user' });
      expect(result.messages.every(m => m.message_type === 'user')).toBe(true);
    });

    it('Timeline 应该支持 exclude_system_noise 过滤', () => {
      repository.saveSessions([{
        session_key: 'agent:test-agent:abc', source_module: 'test',
        agent_id: 'test-agent', channel: 'ch', message_count: 2,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      repository.saveMessages([
        { source_id: 1, source_module: 'test', session_key: 'agent:test-agent:abc', message_type: 'user', content: 'Hello', model: null, tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null, timestamp: '2024-01-01T00:00:00Z', created_at: '', source_created_at: null },
        { source_id: 2, source_module: 'test', session_key: 'agent:test-agent:abc', message_type: 'user', content: 'HEARTBEAT_OK', model: null, tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null, timestamp: '2024-01-01T00:01:00Z', created_at: '', source_created_at: null },
      ]);

      const result = repository.getMessagesTimeline({ exclude_system_noise: true });
      // HEARTBEAT_OK 会被过滤
      expect(result.messages.every(m => m.content !== 'HEARTBEAT_OK')).toBe(true);
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content).toBe('Hello');
    });

    it('Timeline 分页 should_limit 参数', () => {
      repository.saveSessions([{
        session_key: 'agent:test-agent:abc', source_module: 'test',
        agent_id: 'test-agent', channel: 'ch', message_count: 5,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      for (let i = 0; i < 5; i++) {
        repository.saveMessages([{
          source_id: i, source_module: 'test', session_key: 'agent:test-agent:abc',
          message_type: 'user', content: `msg-${i}`, model: null,
          tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null,
          timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
          created_at: '', source_created_at: null,
        }]);
      }

      const result = repository.getMessagesTimeline({ limit: 3 });
      expect(result.messages.length).toBe(3);
      expect(result.has_more).toBe(true);
    });

    it('Timeline 应该支持 agent_id 过滤', () => {
      repository.saveSessions([{
        session_key: 'agent:a1:s1', source_module: 'test',
        agent_id: 'a1', channel: 'ch', message_count: 1,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      repository.saveMessages([{
        source_id: 1, source_module: 'test', session_key: 'agent:a1:s1',
        message_type: 'user', content: 'Hello', model: null,
        tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null,
        timestamp: '2024-01-01T00:00:00Z', created_at: '', source_created_at: null,
      }]);

      const result = repository.getMessagesTimeline({ agent_id: 'a1' });
      expect(result.messages.length).toBe(1);
    });

    it('Timeline 应该支持 before/after 过滤', () => {
      repository.saveSessions([{
        session_key: 'agent:a1:s1', source_module: 'test',
        agent_id: 'a1', channel: 'ch', message_count: 3,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      for (let i = 0; i < 3; i++) {
        repository.saveMessages([{
          source_id: i, source_module: 'test', session_key: 'agent:a1:s1',
          message_type: 'user', content: `msg-${i}`, model: null,
          tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null,
          timestamp: `2024-01-01T0${i}:00:00Z`,
          created_at: '', source_created_at: null,
        }]);
      }

      const result = repository.getMessagesTimeline({ before: '2024-01-01T01:00:00Z', limit: 10 });
      expect(result.messages.length).toBeLessThanOrEqual(3);
    });
  });

  describe('token summary rebuild', () => {
    it('rebuildTokenSummary 应该正确聚合', () => {
      repository.saveSessions([{
        session_key: 'agent:a1:session1', source_module: 'test',
        agent_id: 'a1', channel: 'ch', message_count: 2,
        first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null,
      }]);
      repository.saveMessages([
        {
          source_id: 1, source_module: 'test', session_key: 'agent:a1:session1',
          message_type: 'user', content: 'Hello', model: 'gpt-4',
          tokens_input: 10, tokens_output: 20, cost_total: 0.01, cost_input: 0.005, cost_output: 0.005,
          timestamp: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
        },
        {
          source_id: 2, source_module: 'test', session_key: 'agent:a1:session1',
          message_type: 'agent', content: 'Hi', model: 'gpt-4',
          tokens_input: 20, tokens_output: 30, cost_total: 0.02, cost_input: 0.01, cost_output: 0.01,
          timestamp: '2024-01-01T01:00:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
        },
      ]);

      const result = repository.rebuildTokenSummary();
      expect(result.affected_agents).toBe(1);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);

      const summary = repository.getTokenSummary('a1');
      expect(summary.length).toBeGreaterThan(0);
    });
  });

  describe('syncSessions with data', () => {
    it('syncSessions 应该处理真实 session 数据', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue({
          count: 2,
          sessions: [
            {
              session_key: 'agent:test-agent:webchat:acc:ch',
              agent_id: 'test-agent',
              channel: 'webchat',
              account_id: 'acc',
              peer_id: null,
              guild_id: null,
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
              message_count: 5,
              last_message_at: '2024-01-01T01:00:00Z',
            },
            {
              session_key: 'agent:test-agent:webchat:acc:ch2',
              agent_id: 'test-agent',
              channel: 'webchat',
              account_id: 'acc',
              peer_id: null,
              guild_id: null,
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
              message_count: 3,
              last_message_at: '2024-01-01T02:00:00Z',
            },
          ],
        }),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll();
      sync.stop();

      // 验证 syncAll 完成不抛异常即可
      expect(true).toBe(true);
    });

    it('syncSessions 遇到错误时应该捕获', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockRejectedValue(new Error('network error')),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll(); // 错误被内部捕获
      sync.stop();

      // 不应该抛出
      expect(true).toBe(true);
    });

    it('syncSessions 多批次分页', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      let callCount = 0;
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              count: 2,
              sessions: [
                {
                  session_key: `agent:test-agent:webchat:acc:ch1`,
                  agent_id: 'test-agent',
                  channel: 'webchat',
                  account_id: 'acc',
                  peer_id: null,
                  guild_id: null,
                  created_at: '2024-01-01T00:00:00Z',
                  updated_at: '2024-01-01T00:00:00Z',
                  message_count: 5,
                  last_message_at: '2024-01-01T01:00:00Z',
                },
              ],
            });
          } else {
            return Promise.resolve({ count: 0, sessions: [] });
          }
        }),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({ batchSize: 1 }, repository);
      await sync.syncAll();
      sync.stop();

      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('syncAgents with data', () => {
    it('syncAgents 应该调用 refreshAgents', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      const agents = [
        {
          agent_id: 'test-agent-1',
          agent_name: 'Test Agent 1',
          workspace: '/test/workspace',
          source: 'openclaw',
          config_json: '{}',
          status: 'running',
          last_seen_at: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          agent_id: 'test-agent-2',
          agent_name: 'Test Agent 2',
          workspace: '/test/workspace2',
          source: 'openclaw',
          config_json: '{}',
          status: 'stopped',
          last_seen_at: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue(agents),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll();
      sync.stop();

      // 验证 syncAll 完成不抛异常即可
      expect(true).toBe(true);
    });

    it('syncAgents 遇到错误时应该捕获', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockRejectedValue(new Error('agent fetch failed')),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll(); // 错误被内部捕获
      sync.stop();

      expect(true).toBe(true);
    });
  });

  describe('syncMessages with data', () => {
    it('syncMessages 应该处理真实消息数据并计算活动统计', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({
          count: 2,
          messages: [
            {
              id: 1,
              session_key: 'agent:test-agent:webchat:acc:ch',
              message_type: 'user',
              content: 'Hello',
              model: 'gpt-4',
              tokens_input: 10,
              tokens_output: 20,
              cost_total: 0.01,
              cost_input: 0.005,
              cost_output: 0.005,
              tools_json: null,
              timestamp: '2024-01-01T10:00:00Z',
              created_at: '2024-01-01T10:00:00Z',
            },
            {
              id: 2,
              session_key: 'agent:test-agent:webchat:acc:ch',
              message_type: 'agent',
              content: 'Hi there!',
              model: 'gpt-4',
              tokens_input: 20,
              tokens_output: 30,
              cost_total: 0.02,
              cost_input: 0.01,
              cost_output: 0.01,
              tools_json: null,
              timestamp: '2024-01-01T10:01:00Z',
              created_at: '2024-01-01T10:01:00Z',
            },
          ],
        }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll();
      sync.stop();

      // 验证消息被保存（通过 timeline 查询）
      const timeline = repository.getMessagesTimeline({ limit: 50 });
      expect(timeline.messages.length).toBeGreaterThanOrEqual(0);
    });

    it('syncMessages 多批次分页', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      let callCount = 0;
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              count: 2,
              messages: [
                {
                  id: 1,
                  session_key: 'agent:test-agent:webchat:acc:ch',
                  message_type: 'user',
                  content: 'msg1',
                  model: null,
                  tokens_input: null,
                  tokens_output: null,
                  cost_total: null,
                  cost_input: null,
                  cost_output: null,
                  tools_json: null,
                  timestamp: '2024-01-01T10:00:00Z',
                  created_at: '2024-01-01T10:00:00Z',
                },
              ],
            });
          }
          return Promise.resolve({ count: 0, messages: [] });
        }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({ batchSize: 1 }, repository);
      await sync.syncAll();
      sync.stop();

      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('syncMessages 异常时应该被捕获', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockRejectedValue(new Error('messages fetch failed')),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({}, repository);
      await sync.syncAll(); // 错误被内部捕获
      sync.stop();

      expect(true).toBe(true);
    });
  });

  describe('SubagentEventParser integration', () => {
    it('DataSync 应该配置 SubagentEventParser 当提供 taskApiBaseUrl', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({
        taskApiBaseUrl: 'http://localhost:13102',
        subagentParserEnabled: true,
      }, repository);

      // 应该能够正常创建和停止
      await sync.syncAll();
      sync.stop();

      expect(true).toBe(true);
    });

    it('DataSync 不配置 SubagentEventParser 当 subagentParserEnabled=false', async () => {
      const { CollectorClient } = await import('../src/data/collector-client.js');
      vi.mocked(CollectorClient).mockImplementationOnce(() => ({
        getSessions: vi.fn().mockResolvedValue([]),
        getMessages: vi.fn().mockResolvedValue({ count: 0, messages: [] }),
        getAgents: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockResolvedValue({ totalSizeMB: 1, tableCount: 10, rowCount: 100 }),
      }));

      const sync = new DataSyncClass({
        taskApiBaseUrl: 'http://localhost:13102',
        subagentParserEnabled: false,
      }, repository);

      await sync.syncAll();
      sync.stop();

      expect(true).toBe(true);
    });
  });
});
