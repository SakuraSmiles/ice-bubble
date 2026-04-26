/**
 * CollectorClient 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CollectorClient } from '../src/data/collector-client.js';

describe('CollectorClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSessions', () => {
    it('应该正确构造请求 URL（无参数）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, sessions: [] }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await client.getSessions();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:13000/api/data/sessions',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('应该正确构造请求 URL（带分页参数）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, sessions: [] }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await client.getSessions({ limit: 50, offset: 100 });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:13000/api/data/sessions?limit=50&offset=100',
        expect.any(Object)
      );
    });

    it('应该正确构造请求 URL（带 since 参数）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, sessions: [] }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await client.getSessions({ since: '2024-01-01T00:00:00Z' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:13000/api/data/sessions?since=2024-01-01T00%3A00%3A00Z',
        expect.any(Object)
      );
    });

    it('应该在 HTTP 错误时抛出异常', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await expect(client.getSessions()).rejects.toThrow('Failed to get sessions: 404 Not Found');
    });

    it('应该正确解析返回数据', async () => {
      const mockSessions = [{
        session_key: 'agent:test:s1',
        agent_id: 'test-agent',
        channel: 'channel-1',
        account_id: null,
        peer_id: null,
        guild_id: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        message_count: 10,
        last_message_at: '2024-01-01T12:00:00Z',
      }];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 1, sessions: mockSessions }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      const result = await client.getSessions();

      expect(result.count).toBe(1);
      expect(result.sessions[0].session_key).toBe('agent:test:s1');
    });

    it('应该去除 baseUrl 末尾斜杠', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, sessions: [] }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000/' });
      await client.getSessions();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:13000/api/data/sessions',
        expect.any(Object)
      );
    });
  });

  describe('getMessages', () => {
    it('应该正确构造请求 URL（带 session_key）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, messages: [] }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await client.getMessages({ session_key: 'agent:test:s1' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:13000/api/data/messages?session_key=agent%3Atest%3As1',
        expect.any(Object)
      );
    });

    it('应该在 HTTP 错误时抛出异常', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await expect(client.getMessages({})).rejects.toThrow('Failed to get messages: 500 Internal Server Error');
    });
  });

  describe('getAgents', () => {
    it('应该正确调用 API', async () => {
      const mockAgents = [{
        agent_id: 'agent-1',
        agent_name: 'Agent 1',
        config_json: '{}',
        status: 'running',
        last_seen_at: '2024-01-01T00:00:00Z',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 1, agents: mockAgents }),
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      const result = await client.getAgents();

      expect(result).toHaveLength(1);
      expect(result[0].agent_id).toBe('agent-1');
    });

    it('应该在 HTTP 错误时抛出异常', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await expect(client.getAgents()).rejects.toThrow('Failed to get agents: 403 Forbidden');
    });
  });

  describe('getStats', () => {
    it('应该正确调用 API 并返回统计', async () => {
      const mockStats = {
        sessionCount: 100,
        messageCount: 5000,
        agentCount: 5,
        lastUpdated: '2024-01-01T12:00:00Z',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      const result = await client.getStats();

      expect(result.sessionCount).toBe(100);
      expect(result.messageCount).toBe(5000);
      expect(result.agentCount).toBe(5);
    });

    it('应该在 HTTP 错误时抛出异常', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response);

      const client = new CollectorClient({ baseUrl: 'http://localhost:13000' });
      await expect(client.getStats()).rejects.toThrow('Failed to get stats: 503 Service Unavailable');
    });
  });
});
