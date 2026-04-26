/**
 * TaskClient 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskClient } from '../src/data/task-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('TaskClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('isAvailable', () => {
    it('可用时返回 true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.isAvailable();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:13102/api/tasks?limit=1',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('HTTP 错误时返回 false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.isAvailable();

      expect(result).toBe(false);
    });

    it('网络异常时返回 false', async () => {
      mockFetch.mockRejectedValueOnce(new Error('connection refused'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.isAvailable();

      expect(result).toBe(false);
    });

    it('60 秒内不重复探测', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      await client.isAvailable();
      await client.isAvailable();
      await client.isAvailable();

      // 只应该调用一次 fetch（60 秒缓存）
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('去除 baseUrl 末尾斜杠', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102/' });
      await client.isAvailable();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:13102/api/tasks?limit=1',
        expect.any(Object)
      );
    });
  });

  describe('createTask', () => {
    it('Task API 不可用时返回 null', async () => {
      mockFetch.mockRejectedValueOnce(new Error('unavailable'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      // 先触发一次可用性检查（会缓存为 false）
      await client.isAvailable();

      const result = await client.createTask({
        title: 'Test Task',
        agent_id: 'test-agent',
      });

      expect(result).toBeNull();
    });

    it('createTask 成功时返回 id', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ id: 'task-abc123' }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.createTask({
        title: 'Test Task',
        agent_id: 'test-agent',
      });

      expect(result).toEqual({ id: 'task-abc123' });
    });

    it('createTask HTTP 错误时返回 null', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.createTask({
        title: 'Test Task',
        agent_id: 'test-agent',
      });

      expect(result).toBeNull();
    });

    it('createTask 超时返回 null', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockRejectedValueOnce(new Error('AbortError'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.createTask({
        title: 'Test Task',
        agent_id: 'test-agent',
      });

      expect(result).toBeNull();
    });

    it('createTask 异常时降级 available=false', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockRejectedValueOnce(new Error('network error')); // createTask

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      await client.createTask({
        title: 'Test Task',
        agent_id: 'test-agent',
      });

      // 下次调用应该重新探测（lastCheck 被重置为 0）
      mockFetch.mockResolvedValueOnce({ ok: true });
      await client.isAvailable();
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('updateTaskStatus', () => {
    it('updateTaskStatus 成功时返回 true', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.updateTaskStatus('task-123', 'completed');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:13102/api/tasks/task-123/status',
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('updateTaskStatus HTTP 错误时返回 false', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.updateTaskStatus('task-123', 'completed');

      expect(result).toBe(false);
    });

    it('updateTaskStatus 超时时返回 false', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockRejectedValueOnce(new Error('AbortError'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.updateTaskStatus('task-123', 'failed');

      expect(result).toBe(false);
    });

    it('updateTaskStatus API 不可用时返回 false', async () => {
      mockFetch.mockRejectedValueOnce(new Error('unavailable'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      await client.isAvailable();

      const result = await client.updateTaskStatus('task-123', 'completed');

      expect(result).toBe(false);
    });

    it('updateTaskStatus URL 编码特殊字符 taskId', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      await client.updateTaskStatus('task/id/with/slashes', 'completed');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:13102/api/tasks/task%2Fid%2Fwith%2Fslashes/status',
        expect.any(Object)
      );
    });
  });

  describe('createTaskWithSessionId', () => {
    it('应该在 description 中嵌入 sid 标记', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ id: 'task-xyz' }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.createTaskWithSessionId(
        { title: 'Test', agent_id: 'agent-1', description: 'Some description' },
        'session-abc'
      );

      expect(result).toEqual({ id: 'task-xyz' });

      // 验证 POST body 包含 ||sid:session-abc|| 标记
      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      expect(body.description).toContain('||sid:session-abc||');
    });

    it('无 description 时只发送 sid 标记', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ id: 'task-xyz' }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.createTaskWithSessionId(
        { title: 'Test', agent_id: 'agent-1' },
        'session-abc'
      );

      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      expect(body.description).toBe('||sid:session-abc||');
    });

    it('已有 sid 标记时不重复添加', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ id: 'task-xyz' }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      await client.createTaskWithSessionId(
        { title: 'Test', agent_id: 'agent-1', description: '||sid:session-abc||' },
        'session-abc'
      );

      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      expect(body.description).toBe('||sid:session-abc||');
    });
  });

  describe('lookupTaskBySessionId', () => {
    it('找到任务时返回 task id', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // isAvailable
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [{ id: 'found-task', description: 'Some text ||sid:my-session|| more' }],
              total: 1,
            }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.lookupTaskBySessionId('agent-1', 'my-session');

      expect(result).toBe('found-task');
    });

    it('未找到任务时返回 null', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tasks: [], total: 0 }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.lookupTaskBySessionId('agent-1', 'unknown-session');

      expect(result).toBeNull();
    });

    it('分页遍历查找任务', async () => {
      // 第一页没找到，第二页找到
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tasks: [], total: 150 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [{ id: 'task-in-page2', description: '||sid:target-session||' }],
              total: 150,
            }),
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.lookupTaskBySessionId('agent-1', 'target-session');

      expect(result).toBe('task-in-page2');
      // 验证分页 offset
      expect(mockFetch.mock.calls[2][0]).toContain('offset=100');
    });

    it('lookupTaskBySessionId HTTP 错误时返回 null', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.lookupTaskBySessionId('agent-1', 'my-session');

      expect(result).toBeNull();
    });

    it('lookupTaskBySessionId 异常时降级', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('network error'));

      const client = new TaskClient({ baseUrl: 'http://localhost:13102' });
      const result = await client.lookupTaskBySessionId('agent-1', 'my-session');

      expect(result).toBeNull();
    });
  });
});
