/**
 * DataRepository 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDatabase, initializeSchema } from './helpers/sqlite-test-helper.js';
import { DataRepository, type AdminSession, type AdminMessage, type AdminAgent } from '../src/storage/data-repository.js';
import type Database from 'better-sqlite3';

function createRepo(db?: Database.Database) {
  const database = db || createInMemoryDatabase();
  initializeSchema(database);
  return new DataRepository(database, '/tmp/avatars');
}

describe('DataRepository', () => {
  describe('Sessions', () => {
    it('saveSessions 应该批量保存 sessions（upsert）', () => {
      const repo = createRepo();
      const sessions: AdminSession[] = [
        {
          session_key: 'test-session-1',
          source_module: 'collector-test',
          agent_id: 'agent-1',
          channel: 'test-channel',
          message_count: 10,
          first_message_at: '2024-01-01T00:00:00Z',
          last_message_at: '2024-01-01T01:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          source_created_at: '2024-01-01T00:00:00Z',
        },
        {
          session_key: 'test-session-2',
          source_module: 'collector-test',
          agent_id: 'agent-2',
          channel: 'test-channel',
          message_count: 5,
          first_message_at: '2024-01-01T00:00:00Z',
          last_message_at: '2024-01-01T00:30:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          source_created_at: null,
        },
      ];

      repo.saveSessions(sessions);

      const result = repo.getSessions();
      expect(result.total).toBe(2);
      expect(result.sessions.find(s => s.session_key === 'test-session-1')?.message_count).toBe(10);
    });

    it('saveSessions 空数组不应该报错', () => {
      const repo = createRepo();
      expect(() => repo.saveSessions([])).not.toThrow();
    });

    it('saveSessions 应该正确覆盖已存在的 session', () => {
      const repo = createRepo();
      const sessions: AdminSession[] = [
        {
          session_key: 'test-session-1',
          source_module: 'collector-test',
          agent_id: 'agent-1',
          channel: 'channel-a',
          message_count: 10,
          first_message_at: '2024-01-01T00:00:00Z',
          last_message_at: '2024-01-01T01:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          source_created_at: null,
        },
      ];
      repo.saveSessions(sessions);

      // 用相同 key 不同数据再次保存
      const updated: AdminSession[] = [
        {
          session_key: 'test-session-1',
          source_module: 'collector-test',
          agent_id: 'agent-1',
          channel: 'channel-b', // 变更 channel
          message_count: 20,    // 变更 message_count
          first_message_at: '2024-01-01T00:00:00Z',
          last_message_at: '2024-01-01T02:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T02:00:00Z',
          source_created_at: null,
        },
      ];
      repo.saveSessions(updated);

      const result = repo.getSessions();
      expect(result.total).toBe(1);
      expect(result.sessions[0].channel).toBe('channel-b');
      expect(result.sessions[0].message_count).toBe(20);
    });

    it('getSessions 应该支持分页', () => {
      const repo = createRepo();
      // 插入 15 条 sessions
      for (let i = 0; i < 15; i++) {
        repo.saveSessions([{
          session_key: `session-${i}`,
          source_module: 'test',
          agent_id: `agent-${i}`,
          channel: 'ch',
          message_count: i,
          first_message_at: '2024-01-01T00:00:00Z',
          last_message_at: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          source_created_at: null,
        }]);
      }

      const page1 = repo.getSessions({ limit: 10, offset: 0 });
      expect(page1.sessions.length).toBe(10);
      expect(page1.total).toBe(15);

      const page2 = repo.getSessions({ limit: 10, offset: 10 });
      expect(page2.sessions.length).toBe(5);
    });

    it('getSessions 应该支持按 agent_id 过滤', () => {
      const repo = createRepo();
      repo.saveSessions([
        { session_key: 's1', source_module: 'test', agent_id: 'agent-a', channel: 'ch', message_count: 1, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null },
        { session_key: 's2', source_module: 'test', agent_id: 'agent-b', channel: 'ch', message_count: 1, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null },
        { session_key: 's3', source_module: 'test', agent_id: 'agent-a', channel: 'ch', message_count: 1, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null },
      ]);

      const result = repo.getSessions({ agent_id: 'agent-a' });
      expect(result.total).toBe(2);
      expect(result.sessions.every(s => s.agent_id === 'agent-a')).toBe(true);
    });

    it('getSession 应该返回单个 session', () => {
      const repo = createRepo();
      repo.saveSessions([{ session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch', message_count: 1, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null }]);
      const session = repo.getSession('s1');
      expect(session).not.toBeNull();
      expect(session!.session_key).toBe('s1');

      const notFound = repo.getSession('non-existent');
      expect(notFound).toBeNull();
    });
  });

  describe('Messages', () => {
    it('saveMessages 应该批量保存消息', () => {
      const repo = createRepo();
      // 先有 session
      repo.saveSessions([{ session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch', message_count: 0, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null }]);

      const messages: AdminMessage[] = [
        {
          source_id: 1,
          source_module: 'collector-test',
          session_key: 's1',
          message_type: 'user',
          content: 'Hello',
          model: 'gpt-4',
          tokens_input: 10,
          tokens_output: 20,
          cost_total: 0.01,
          cost_input: 0.005,
          cost_output: 0.005,
          timestamp: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          source_created_at: null,
        },
      ];

      const inserted = repo.saveMessages(messages);
      expect(inserted).toBe(1);

      const result = repo.getMessages({ session_key: 's1' });
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content).toBe('Hello');
    });

    it('saveMessages 空数组应该返回 0', () => {
      const repo = createRepo();
      expect(repo.saveMessages([])).toBe(0);
    });

    it('saveMessages 应该幂等（重复插入不增加行数）', () => {
      const repo = createRepo();
      repo.saveSessions([{ session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch', message_count: 0, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null }]);

      const msg: AdminMessage = {
        source_id: 1, source_module: 'test', session_key: 's1',
        message_type: 'user', content: 'Hello', model: 'gpt-4',
        tokens_input: 10, tokens_output: 20, cost_total: 0.01,
        cost_input: 0.005, cost_output: 0.005,
        timestamp: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
      };

      repo.saveMessages([msg]);
      repo.saveMessages([msg]); // 重复

      const result = repo.getMessages({});
      expect(result.messages.length).toBe(1);
    });

    it('getMessages 应该支持分页', () => {
      const repo = createRepo();
      repo.saveSessions([{ session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch', message_count: 0, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null }]);

      for (let i = 0; i < 15; i++) {
        repo.saveMessages([{
          source_id: i, source_module: 'test', session_key: 's1',
          message_type: 'user', content: `msg-${i}`, model: null,
          tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null,
          timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
          created_at: '2024-01-01T00:00:00Z', source_created_at: null,
        }]);
      }

      const page1 = repo.getMessages({ session_key: 's1', limit: 10, offset: 0 });
      expect(page1.messages.length).toBe(10);
      expect(page1.total).toBe(15);
    });
  });

  describe('Agents', () => {
    it('refreshAgents 应该正确更新 agents 表', () => {
      const repo = createRepo();
      const agents = [
        {
          agent_id: 'agent-1',
          agent_name: 'Test Agent 1',
          workspace: '/test',
          source: 'collector-openclaw',
          config_json: '{}',
          status: 'running',
          last_seen_at: '2024-01-01T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      repo.refreshAgents(agents as any, 'collector-openclaw');

      const result = repo.getAgents();
      expect(result.length).toBe(1);
      expect(result[0].agent_id).toBe('agent-1');
      expect(result[0].agent_name).toBe('Test Agent 1');
      expect(result[0].source).toBe('collector-openclaw');
    });

    it('refreshAgents 空数组不应该报错', () => {
      const repo = createRepo();
      expect(() => repo.refreshAgents([], 'test')).not.toThrow();
    });

    it('updateAgentAvatar 应该正确更新头像', () => {
      const repo = createRepo();
      repo.refreshAgents([{
        agent_id: 'agent-1', agent_name: 'Test', workspace: null, source: 'test',
        config_json: '{}', status: 'running',
        last_seen_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }] as any, 'test');

      repo.updateAgentAvatar('agent-1', 'avatar.png');
      const avatar = repo.getAgentAvatar('agent-1');
      expect(avatar).toBe('avatar.png');
    });

    it('getAgentAvatar 不存在的 agent 应该返回 null', () => {
      const repo = createRepo();
      expect(repo.getAgentAvatar('non-existent')).toBeNull();
    });
  });

  describe('SyncProgress', () => {
    it('updateSyncProgress 和 getSyncProgress 应该正常工作', () => {
      const repo = createRepo();

      repo.updateSyncProgress('admin_sessions');
      const progress = repo.getSyncProgress('admin_sessions');
      expect(progress).not.toBeNull();
      expect(progress!.table_name).toBe('admin_sessions');
      expect(progress!.last_sync_time).toBeDefined();
    });

    it('getSyncProgress 不存在的 table 应该返回 null', () => {
      const repo = createRepo();
      expect(repo.getSyncProgress('non_existent_table')).toBeNull();
    });
  });

  describe('Stats', () => {
    it('getStats 应该返回正确统计数据', () => {
      const repo = createRepo();
      repo.saveSessions([{
        session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch',
        message_count: 5, first_message_at: null, last_message_at: null,
        created_at: '', updated_at: '', source_created_at: null,
      }]);
      repo.saveMessages([{
        source_id: 1, source_module: 'test', session_key: 's1',
        message_type: 'user', content: 'hi', model: null,
        tokens_input: null, tokens_output: null, cost_total: null, cost_input: null, cost_output: null,
        timestamp: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', source_created_at: null,
      }]);
      repo.refreshAgents([{
        agent_id: 'agent-1', agent_name: 'Test', workspace: null, source: 'test',
        config_json: '{}', status: 'running',
        last_seen_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }] as any, 'test');

      const stats = repo.getStats();
      expect(stats.sessionCount).toBe(1);
      expect(stats.messageCount).toBe(1);
      expect(stats.agentCount).toBe(1);
    });
  });

  describe('Token Summary', () => {
    it('getTokenSummary 应该返回空数组（无数据时）', () => {
      const repo = createRepo();
      const result = repo.getTokenSummary();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Agent Activity', () => {
    it('updateAgentActivity 应该正确增加计数', () => {
      const repo = createRepo();
      // 使用今天和昨天的日期（避免 getAgentActivity 的 date range 过滤问题）
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      repo.updateAgentActivity('agent-1', todayStr, 5);
      repo.updateAgentActivity('agent-1', todayStr, 3); // 再加 3
      repo.updateAgentActivity('agent-1', yesterdayStr, 2);

      const activity = repo.getAgentActivity('agent-1', 7);
      const todayRecord = activity.find(a => a.date === todayStr);
      expect(todayRecord).toBeDefined();
      expect(todayRecord!.count).toBe(8);
    });

    it('getAgentActivity 不存在的 agent 应该返回空数组', () => {
      const repo = createRepo();
      const activity = repo.getAgentActivity('non-existent-agent', 7);
      expect(activity).toEqual([]);
    });

    it('upsertAgentActivityBatch 应该批量更新活动', () => {
      const repo = createRepo();
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const records = [
        { agentId: 'agent-1', date: today, count: 5 },
        { agentId: 'agent-2', date: yesterday, count: 3 },
      ];
      repo.upsertAgentActivityBatch(records);

      const activity1 = repo.getAgentActivity('agent-1', 1);
      expect(activity1.length).toBeGreaterThan(0);
      const todayRecord = activity1.find(a => a.date === today);
      expect(todayRecord).toBeDefined();
      expect(todayRecord!.count).toBe(5);
    });
  });

  describe('Session-Agent Mapping', () => {
    it('getSessionAgentIds 应该返回正确的映射', () => {
      const repo = createRepo();
      repo.saveSessions([
        { session_key: 's1', source_module: 'test', agent_id: 'a1', channel: 'ch', message_count: 0, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null },
        { session_key: 's2', source_module: 'test', agent_id: 'a2', channel: 'ch', message_count: 0, first_message_at: null, last_message_at: null, created_at: '', updated_at: '', source_created_at: null },
      ]);

      const map = repo.getSessionAgentIds(['s1', 's2', 's3']); // s3 不存在
      expect(map.get('s1')).toBe('a1');
      expect(map.get('s2')).toBe('a2');
      expect(map.has('s3')).toBe(false);
    });

    it('getSessionAgentIds 空数组应该返回空 Map', () => {
      const repo = createRepo();
      const map = repo.getSessionAgentIds([]);
      expect(map.size).toBe(0);
    });
  });

  describe('Grouped Sessions', () => {
    it('getGroupedSessions 应该正确分组', () => {
      const repo = createRepo();
      // 插入多个 session 属于不同 agent
      for (const agentId of ['a1', 'a2']) {
        for (let i = 0; i < 3; i++) {
          repo.saveSessions([{
            session_key: `s-${agentId}-${i}`,
            source_module: 'test',
            agent_id: agentId,
            channel: 'ch',
            message_count: i,
            first_message_at: null,
            last_message_at: `2024-01-01T0${i}:00:00Z`,
            created_at: '',
            updated_at: '',
            source_created_at: null,
          }]);
        }
      }

      const groups = repo.getGroupedSessions(2, 0);
      expect(groups.length).toBe(2); // 2 个 agents
      for (const g of groups) {
        expect(g.sessions.length).toBeLessThanOrEqual(2);
        expect(g.totalCount).toBe(3);
      }
    });
  });
});
