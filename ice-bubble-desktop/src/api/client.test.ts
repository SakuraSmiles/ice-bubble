/**
 * Tests for src/api/client.ts
 * API 调用层：成功/失败/超时路径，核心 API 方法
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock factory can reference these
const { mockRecord, mockFetch } = vi.hoisted(() => {
  return {
    mockRecord: vi.fn(),
    mockFetch: vi.fn()
  };
});

// Hoisted mock must come before any imports that use them
vi.mock('../utils/monitor', () => ({
  apiMonitor: { record: mockRecord }
}));

vi.mock('../config', () => ({
  API_BASE: '/api',
  getAdminAuthToken: () => '',
}));

vi.stubGlobal('fetch', mockFetch);

import { api } from './client';

describe('API Client - fetchJson 底层能力', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('fetch 调用成功时返回解析后的 JSON', async () => {
    const fakeData = { sessionCount: 42, messageCount: 100, moduleCount: 3, collectorStatus: 'running' as const };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(fakeData)
    });

    const result = await (api as any).getStats();
    expect(result).toEqual(fakeData);
    expect(mockFetch).toHaveBeenCalledWith('/api/stats', expect.not.objectContaining({ credentials: 'include' }));
    expect(mockRecord).toHaveBeenCalledWith('/stats', 'GET', expect.any(Number), true);
  });

  it('fetch 失败（HTTP 非 200）时抛出异常并记录', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect((api as any).getStats()).rejects.toThrow('API error: 500');
    expect(mockRecord).toHaveBeenCalledWith('/stats', 'GET', expect.any(Number), false, 'HTTP 500');
  });

  it('fetch 网络错误时抛出异常并记录', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    await expect((api as any).getStats()).rejects.toThrow('Network failure');
    expect(mockRecord).toHaveBeenCalledWith('/stats', 'GET', expect.any(Number), false, 'Network failure');
  });
});

describe('API.getStats', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('返回 StatsDTO 结构', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 5, messageCount: 99, moduleCount: 2, collectorStatus: 'running' })
    });

    const result = await api.getStats();
    expect(result.sessionCount).toBe(5);
    expect(result.collectorStatus).toBe('running');
  });
});

describe('API.getSessions', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('无参数时发送无 query 的请求', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sessions: [] }) });

    await api.getSessions();
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions', expect.any(Object));
  });

  it('带 limit/offset 参数时正确拼接 query string', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ sessions: [] }) });

    await api.getSessions({ limit: 20, offset: 10 });
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions?limit=20&offset=10', expect.any(Object));
  });

  it('返回 SessionsResponseDTO 结构', async () => {
    const fakeSessions = [
      { session_key: 's1', agent_id: 'a1', channel: 'telegram', message_count: 5, first_message_at: null, last_message_at: null, created_at: '2024-01-01' }
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessions: fakeSessions })
    });

    const result = await api.getSessions();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].session_key).toBe('s1');
  });
});

describe('API.getAgents', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('返回 AgentsResponseDTO 结构', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ agents: [], count: 0 })
    });

    const result = await api.getAgents();
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('count');
  });

  it('404 时抛出带状态的错误', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(api.getAgents()).rejects.toThrow('API error: 404');
  });
});

describe('API.getModules', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('成功返回模块列表', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        modules: [{ moduleKey: 'admin', name: 'Admin', baseUrl: 'http://localhost:13000', enabled: true, pollInterval: 30000 }]
      })
    });

    const result = await api.getModules();
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].moduleKey).toBe('admin');
  });
});

describe('API.testModuleConnection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecord.mockReset();
  });

  it('POST 请求到正确路径并返回结果', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, moduleKey: 'task' })
    });

    const result = await api.testModuleConnection('http://localhost:14000');
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/modules/test-connection',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('连接失败时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });

    await expect(api.testModuleConnection('http://invalid:9999')).rejects.toThrow('API error: 502');
  });
});
