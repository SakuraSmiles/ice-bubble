/**
 * Tests for src/middleware/proxy.ts
 * 代理转发逻辑：请求路径转发、错误处理
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindModuleByPath, mockSocketWrite, mockSocketDestroy } = vi.hoisted(() => {
  const socketWrite = vi.fn();
  const socketDestroy = vi.fn();
  return { mockFindModuleByPath: vi.fn(), mockSocketWrite: socketWrite, mockSocketDestroy: socketDestroy };
});

vi.mock('net', () => ({ default: { connect: vi.fn() } }));
vi.mock('../config.server.js', () => ({ findModuleByPath: mockFindModuleByPath }));

import { createProxyMiddleware } from './proxy';
import type { Request, Response } from 'express';
import net from 'net';

// Shared socket reference for triggering events
let capturedSocket: {
  _fire: (event: string, arg?: any) => void;
} | null = null;

function makeMockSocket() {
  const handlers: Record<string, Function[]> = {};
  const sock = {
    setTimeout: vi.fn(),
    write: mockSocketWrite,
    destroy: mockSocketDestroy,
    setKeepAlive: vi.fn(),
    on(event: string, handler: Function) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return this;
    }
  };
  const fire = (event: string, arg?: any) => {
    (handlers[event] || []).forEach((h: Function) => h(arg));
  };
  // Capture reference so we can fire events from tests
  capturedSocket = { _fire: fire };
  return sock;
}

function withSocketEvents(events: Array<{ type: 'data' | 'end' | 'error' | 'timeout'; payload?: any; delay?: number }>) {
  const mockConnect = (net as any).connect as ReturnType<typeof vi.fn>;
  mockConnect.mockImplementation(function(_opts: any, cb: () => void) {
    setTimeout(cb, 0);
    const sock = makeMockSocket();
    events.forEach(({ type, payload, delay = 10 }) => {
      setTimeout(() => capturedSocket!._fire(type, type === 'error' ? new Error(payload || 'error') : payload), delay);
    });
    return sock;
  });
}

function makeMockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    method: 'GET',
    originalUrl: '/api/agents',
    url: '/api/agents',
    headers: { host: 'localhost:14000' },
    body: undefined,
    ...overrides
  } as unknown as Partial<Request>;
}

function makeMockRes(): Partial<Response> & { _status: number; _headers: Record<string, string>; _ended: boolean; _data: any } {
  const res: any = {
    _status: 200,
    _headers: {},
    _ended: false,
    _data: null,
    status(code: number) { this._status = code; return this; },
    setHeader(key: string, val: string) { this._headers[key] = val; return this; },
    json(data: any) { this._data = data; this._ended = true; return this; },
    end(data?: any) { this._ended = true; this._data = data; return this; }
  };
  return res;
}

function buildHttpResponse(statusCode: number, contentType: string, body: string): Buffer {
  const headerStr = `HTTP/1.1 ${statusCode} OK\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.concat([Buffer.from(headerStr), Buffer.from(body)]);
}

describe('createProxyMiddleware - 模块未找到', () => {
  beforeEach(() => {
    mockFindModuleByPath.mockReturnValue(null);
    mockSocketWrite.mockReset();
    mockSocketDestroy.mockReset();
    capturedSocket = null;
    vi.mocked((net as any).connect, true).mockReset();
  });

  it('模块未配置时返回 404', async () => {
    const middleware = createProxyMiddleware();
    const req = makeMockReq();
    const res = makeMockRes();
    await middleware(req as Request, res as unknown as Response);
    expect(res._status).toBe(404);
    expect(res._data).toEqual({ error: 'Module not configured' });
  });
});

describe('createProxyMiddleware - 模块已禁用', () => {
  beforeEach(() => {
    mockFindModuleByPath.mockReturnValue({ key: 'desktop', name: 'Desktop', url: 'http://localhost:14000', enabled: false });
    mockSocketWrite.mockReset();
    mockSocketDestroy.mockReset();
    capturedSocket = null;
    vi.mocked((net as any).connect, true).mockReset();
  });

  it('模块被禁用时返回 503', async () => {
    const middleware = createProxyMiddleware();
    const req = makeMockReq();
    const res = makeMockRes();
    await middleware(req as Request, res as unknown as Response);
    expect(res._status).toBe(503);
    expect(res._data).toEqual({ error: 'Module desktop is disabled' });
  });
});

describe('createProxyMiddleware - 正常转发', () => {
  beforeEach(() => {
    mockFindModuleByPath.mockReturnValue({ key: 'desktop', name: 'Desktop', url: 'http://localhost:14000', enabled: true });
    mockSocketWrite.mockReset();
    mockSocketDestroy.mockReset();
    capturedSocket = null;
    vi.mocked((net as any).connect, true).mockReset();
  });

  it('请求正确转发并返回 JSON 响应', async () => {
    const httpResp = buildHttpResponse(200, 'application/json', '{"agents":[]}');
    withSocketEvents([
      { type: 'data', payload: httpResp, delay: 15 },
      { type: 'end', delay: 20 }
    ]);

    const middleware = createProxyMiddleware();
    const req = makeMockReq({ originalUrl: '/api/agents', url: '/api/agents' });
    const res = makeMockRes();

    const promise = middleware(req as Request, res as unknown as Response);
    await new Promise(r => setTimeout(r, 200));
    await promise;

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('POST 请求带 body 时发送请求体', async () => {
    const httpResp = buildHttpResponse(201, 'application/json', '{"id":"1"}');
    withSocketEvents([
      { type: 'data', payload: httpResp, delay: 15 },
      { type: 'end', delay: 20 }
    ]);

    const middleware = createProxyMiddleware();
    const req = makeMockReq({
      method: 'POST',
      originalUrl: '/api/sessions',
      url: '/api/sessions',
      body: { agentId: 'test' }
    });
    const res = makeMockRes();

    const promise = middleware(req as Request, res as unknown as Response);
    await new Promise(r => setTimeout(r, 200));
    await promise;

    expect(mockSocketWrite).toHaveBeenCalled();
  });
});

describe('createProxyMiddleware - 错误处理', () => {
  beforeEach(() => {
    mockFindModuleByPath.mockReturnValue({ key: 'desktop', name: 'Desktop', url: 'http://localhost:14000', enabled: true });
    mockSocketWrite.mockReset();
    mockSocketDestroy.mockReset();
    capturedSocket = null;
    vi.mocked((net as any).connect, true).mockReset();
  });

  it('Socket 错误时返回 502', async () => {
    withSocketEvents([
      { type: 'error', payload: 'Connection refused', delay: 15 }
    ]);

    const middleware = createProxyMiddleware();
    const req = makeMockReq({ originalUrl: '/api/agents', url: '/api/agents' });
    const res = makeMockRes();

    const promise = middleware(req as Request, res as unknown as Response);
    await new Promise(r => setTimeout(r, 200));
    await promise;

    expect(res._status).toBe(502);
    expect(res._data).toEqual({ error: 'Failed to reach desktop' });
  });

  it('Socket 超时时返回 502 并销毁 socket', async () => {
    withSocketEvents([
      { type: 'timeout', delay: 15 }
    ]);

    const middleware = createProxyMiddleware();
    const req = makeMockReq({ originalUrl: '/api/agents', url: '/api/agents' });
    const res = makeMockRes();

    const promise = middleware(req as Request, res as unknown as Response);
    await new Promise(r => setTimeout(r, 200));
    await promise;

    expect(res._status).toBe(502);
    expect(mockSocketDestroy).toHaveBeenCalled();
  });
});

describe('findModuleByPath 集成调用验证', () => {
  beforeEach(() => {
    mockFindModuleByPath.mockReturnValue({ key: 'admin', name: 'Admin', url: 'http://localhost:13000', enabled: true });
    mockSocketWrite.mockReset();
    mockSocketDestroy.mockReset();
    capturedSocket = null;
    vi.mocked((net as any).connect, true).mockReset();
  });

  it('中间件调用 findModuleByPath 使用正确路径', async () => {
    const httpResp = buildHttpResponse(200, 'application/json', '{}');
    withSocketEvents([
      { type: 'data', payload: httpResp, delay: 15 },
      { type: 'end', delay: 20 }
    ]);

    const middleware = createProxyMiddleware();
    const req = makeMockReq({ originalUrl: '/api/stats', url: '/api/stats' });
    const res = makeMockRes();

    const promise = middleware(req as Request, res as unknown as Response);
    await new Promise(r => setTimeout(r, 200));
    await promise;

    expect(mockFindModuleByPath).toHaveBeenCalledWith('/api/stats');
  });
});
