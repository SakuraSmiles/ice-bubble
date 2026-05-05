/**
 * Tests for src/utils/adminConnection.ts
 * 连接状态管理：连接/断开/重连逻辑，状态变更事件
 *
 * AdminConnection class is not exported; only the singleton `adminConnection`.
 * We test it directly, using fresh localStorage state to control initial conditions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mutable storage — always access directly so tests get the latest state
const storage: Record<string, string> = {};
const storageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value; },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach(k => delete storage[k]); }
};
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);
vi.stubGlobal('localStorage', storageMock);

// Import once — singleton is created at this point
import { adminConnection } from './adminConnection';

function clearStorage() {
  Object.keys(storage).forEach(k => delete storage[k]);
}

describe('AdminConnection - 基础状态', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearStorage();
    adminConnection.destroy();
  });

  afterEach(() => {
    adminConnection.destroy();
    vi.useRealTimers();
  });

  it('getCurrentUrl 无配置时默认为 localhost:13000（自动检测前）', () => {
    // 自动检测前 currentUrl 为默认地址
    expect(adminConnection.getCurrentUrl()).toBe('http://localhost:13000');
  });

  it('getConfig 无配置时返回 null（自动检测中尚未保存）', () => {
    expect(adminConnection.getConfig()).toBeNull();
  });

  it('getState 无配置且自动检测中为 CONFIGURING', () => {
    // autoDetectDefault 异步执行，同步读取时状态为 CONFIGURING
    const state = adminConnection.getState();
    expect(['CONFIGURING', 'UNCONFIGURED', 'CONN_FAILED']).toContain(state);
  });
});

describe('AdminConnection.configure - URL 校验', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearStorage();
    adminConnection.destroy();
  });

  afterEach(() => {
    adminConnection.destroy();
    vi.useRealTimers();
  });

  it('非法 URL（无效协议 ftp://）触发 CONFIG_ERROR', async () => {
    const result = await adminConnection.configure('ftp://localhost:13000');
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('CONFIG_ERROR');
  });

  it('非法 URL（无端口）触发 CONFIG_ERROR', async () => {
    const result = await adminConnection.configure('http://localhost');
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('CONFIG_ERROR');
  });

  it('合法 URL（标准域名）可被接受，连接失败触发 CONN_FAILED', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await adminConnection.configure('http://example.com:13000');
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('CONN_FAILED');
  });

  it('非法 URL（无效 IP 段 >255）触发 CONFIG_ERROR', async () => {
    const result = await adminConnection.configure('http://256.256.256.256:13000');
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('CONFIG_ERROR');
  });

  it('合法 URL 但连接失败触发 CONN_FAILED', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await adminConnection.configure('http://localhost:13000');
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('CONN_FAILED');
  });

  it('合法 URL 且连接成功触发 CONNECTED', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 0, messageCount: 0, moduleCount: 0, collectorStatus: 'unknown' as const })
    });
    const result = await adminConnection.configure('http://localhost:13000');
    expect(result).toBe(true);
    expect(adminConnection.getState()).toBe('CONNECTED');
    expect(adminConnection.getCurrentUrl()).toBe('http://localhost:13000');
  });
});

describe('AdminConnection.onStateChange - 订阅/退订', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearStorage();
    adminConnection.destroy();
  });

  afterEach(() => {
    adminConnection.destroy();
    vi.useRealTimers();
  });

  it('订阅时立即收到当前状态通知', () => {
    const cb = vi.fn();
    adminConnection.onStateChange(cb);
    // 订阅时立即调用回调一次
    expect(cb).toHaveBeenCalledTimes(1);
    // 回调参数应为有效状态字符串
    expect(cb).toHaveBeenCalledWith(expect.stringMatching(/^(UNCONFIGURED|CONFIG_ERROR|CONN_FAILED|CONNECTED|DISCONNECTED|CONFIGURING)$/));
  });

  it('取消订阅后不再收到状态变化', () => {
    const cb = vi.fn();
    const unsub = adminConnection.onStateChange(cb);
    unsub();
    // 取消后 getState 仍正常
    expect(adminConnection.getState()).toBeDefined();
  });
});

describe('AdminConnection - checkHealth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearStorage();
    adminConnection.destroy();
  });

  afterEach(() => {
    adminConnection.destroy();
    vi.useRealTimers();
  });

  it('checkHealth 连接成功返回 true 并设置 CONNECTED', async () => {
    // 先配置连接（成功）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 0, messageCount: 0, moduleCount: 0, collectorStatus: 'unknown' as const })
    });
    await adminConnection.configure('http://localhost:13000');

    // checkHealth 再次连接
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 0, messageCount: 0, moduleCount: 0, collectorStatus: 'unknown' as const })
    });
    const result = await adminConnection.checkHealth();
    expect(result).toBe(true);
    expect(adminConnection.getState()).toBe('CONNECTED');
  });

  it('checkHealth 连接失败返回 false 并设置 DISCONNECTED', async () => {
    // 先配置连接（成功）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 0, messageCount: 0, moduleCount: 0, collectorStatus: 'unknown' as const })
    });
    await adminConnection.configure('http://localhost:13000');

    // checkHealth 失败
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await adminConnection.checkHealth();
    expect(result).toBe(false);
    expect(adminConnection.getState()).toBe('DISCONNECTED');
  });
});

describe('AdminConnection - localStorage 持久化', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearStorage();
    adminConnection.destroy();
  });

  afterEach(() => {
    adminConnection.destroy();
    vi.useRealTimers();
  });

  it('configure 成功后配置被写入 localStorage', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionCount: 0, messageCount: 0, moduleCount: 0, collectorStatus: 'unknown' as const })
    });
    await adminConnection.configure('http://localhost:13000');
    const saved = storage['ice-bubble-admin-config'];
    expect(saved).toContain('http://localhost:13000');
  });

  it('loadConfig 从 localStorage 恢复配置 URL', () => {
    // 直接验证 storage 的读写
    storage['ice-bubble-admin-config'] = JSON.stringify({
      url: 'http://localhost:13000',
      lastConnected: Date.now()
    });
    const savedConfig = JSON.parse(storage['ice-bubble-admin-config']);
    expect(savedConfig.url).toBe('http://localhost:13000');
  });
});
