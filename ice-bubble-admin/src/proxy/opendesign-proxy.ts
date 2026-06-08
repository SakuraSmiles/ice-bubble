/**
 * OpenDesignProxy - OpenDesign Daemon 代理核心
 *
 * 将 Desktop 请求透明转发到 OpenDesign daemon (端口 7456)，
 * 支持 HTTP REST + SSE 双向透传。
 */

import { createLogger } from '@ice-bubble/logger';
import type { Response } from 'express';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenDesignProxyOptions {
  /** OpenDesign daemon 基础地址，默认 http://127.0.0.1:7456 */
  baseUrl?: string;
  /** 认证令牌（可选，透传或注入到请求头） */
  authToken?: string;
  /** HTTP 请求超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** SSE 连接超时（毫秒），默认 120s（2分钟无事件则断开） */
  sseTimeoutMs?: number;
}

export interface ProxyRequestOptions {
  /** OD daemon 目标路径，如 /api/chat */
  path: string;
  /** HTTP 方法 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 请求体（JSON 对象） */
  body?: unknown;
  /** 额外的请求头 */
  headers?: Record<string, string>;
  /** 超时覆盖（毫秒） */
  timeoutMs?: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number | null;
  error?: string;
  version?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://127.0.0.1:7456';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SSE_TIMEOUT_MS = 120_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// ─── ProxyError ──────────────────────────────────────────────────────────

/**
 * 携带上游 OD daemon 的 HTTP 状态码和响应体，
 * 供路由层精确透传错误给客户端（而非一律 502）。
 */
export class ProxyError extends Error {
  readonly statusCode: number;
  readonly statusText: string;
  readonly upstreamBody: string;

  constructor(statusCode: number, statusText: string, upstreamBody: string) {
    super(`OD daemon returned ${statusCode}: ${upstreamBody.slice(0, 200)}`);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.upstreamBody = upstreamBody;
  }
}

// ─── Logger ────────────────────────────────────────────────────────────────

const logger = createLogger('OpenDesignProxy');

// ─── Class ─────────────────────────────────────────────────────────────────

export class OpenDesignProxy {
  private baseUrl: string;
  private authToken: string | null;
  private timeoutMs: number;
  private sseTimeoutMs: number;

  // 健康状态追踪
  private _healthy: boolean = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  // 活跃的 SSE 连接追踪
  private activeSSEConnections: Set<AbortController> = new Set();

  constructor(opts: OpenDesignProxyOptions = {}) {
    this.baseUrl = (opts.baseUrl || process.env.OD_BASE_URL || DEFAULT_BASE_URL)
      .replace(/\/+$/, '');
    this.authToken = opts.authToken || process.env.OD_AUTH_TOKEN || null;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.sseTimeoutMs = opts.sseTimeoutMs || DEFAULT_SSE_TIMEOUT_MS;
  }

  // ── Properties ──────────────────────────────────────────────────────────

  get isHealthy(): boolean {
    return this._healthy;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── Health Check ────────────────────────────────────────────────────────

  /**
   * 主动健康检查
   * GET /api/health → 期望 200 + JSON
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(`${this.baseUrl}/api/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - startTime;
      this._healthy = res.ok;

      let version: string | undefined;
      if (res.ok) {
        try {
          const body = await res.json() as { version?: string };
          version = body.version;
        } catch { /* ignore parse error */ }
      }

      logger.info(`Health check: ${res.ok ? 'OK' : 'FAIL'} (${latencyMs}ms)`);
      return { healthy: res.ok, latencyMs, version };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this._healthy = false;
      logger.warn(`Health check failed: ${error}`);
      return { healthy: false, latencyMs: null, error };
    }
  }

  /**
   * 启动定时健康检查
   */
  startHealthMonitoring(): void {
    this.healthCheck();

    this.healthCheckTimer = setInterval(() => {
      this.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    logger.info('Health monitoring started');
  }

  /**
   * 停止定时健康检查
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── HTTP Proxy ─────────────────────────────────────────────────────────

  /**
   * 代理普通 HTTP 请求（非 SSE）
   *
   * 当 OD daemon 返回非 2xx 时，抛出 ProxyError 以携带
   * 上游状态码和错误体，让路由层可以精确透传。
   */
  async proxyRequest<T = unknown>(opts: ProxyRequestOptions): Promise<T> {
    const { path, method = 'GET', body, headers = {}, timeoutMs } = opts;

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);

    const requestInit: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };

    if (this.authToken) {
      (requestInit.headers as Record<string, string>)['Authorization'] =
        `Bearer ${this.authToken}`;
    }

    if (body !== undefined && method !== 'GET') {
      requestInit.body = JSON.stringify(body);
    }

    try {
      logger.info(`→ ${method} ${url}`);

      const res = await fetch(url, requestInit);
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const error = new ProxyError(res.status, res.statusText, errText);
        throw error;
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return (await res.json()) as T;
      }

      return (await res.text()) as unknown as T;
    } catch (err) {
      clearTimeout(timer);
      // ProxyError 已经携带了上游状态码，不要覆盖 _healthy
      if (!(err instanceof ProxyError)) {
        this._healthy = false;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Proxy request failed: ${method} ${path}`, { error: message });
      throw err;
    }
  }

  // ── SSE Proxy ───────────────────────────────────────────────────────────

  /**
   * 代理 SSE 流式请求
   */
  async proxySSE(
    path: string,
    method: 'GET' | 'POST',
    res: Response,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      onClose?: () => void;
    } = {}
  ): Promise<void> {
    const { body, headers = {}, onClose } = opts;

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();

    this.activeSSEConnections.add(controller);

    // SSE 空闲超时
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.warn(`SSE idle timeout: ${path}`);
        controller.abort();
      }, this.sseTimeoutMs);
    };

    const requestInit: RequestInit = {
      method,
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };

    if (this.authToken) {
      (requestInit.headers as Record<string, string>)['Authorization'] =
        `Bearer ${this.authToken}`;
    }

    if (body !== undefined && method === 'POST') {
      requestInit.body = JSON.stringify(body);
    }

    try {
      logger.info(`→ SSE ${method} ${url}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });

      const upstreamRes = await fetch(url, requestInit);

      if (!upstreamRes.ok || !upstreamRes.body) {
        const errText = await upstreamRes.text().catch(() => 'OD daemon unreachable');
        this.sendSSEError(res, `OD daemon returned ${upstreamRes.status}`, errText);
        return;
      }

      resetIdleTimer();

      res.on('close', () => {
        logger.info(`SSE client disconnected: ${path}`);
        controller.abort();
        if (onClose) onClose();
      });

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            res.write(line + '\n');
            if (line.trim()) resetIdleTimer();
          }
        }

        if (buffer) {
          res.write(buffer + '\n');
        }

        res.write('event: end\ndata: {}\n\n');
        res.end();
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          logger.info(`SSE aborted: ${path}`);
        } else {
          logger.error(`SSE read error: ${path}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          this.sendSSEError(res, 'Stream read error',
            err instanceof Error ? err.message : String(err));
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.info(`SSE connection aborted: ${path}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`SSE proxy failed: ${path}`, { error: message });
        this._healthy = false;

        if (!res.headersSent) {
          this.sendSSEError(res, 'SSE proxy failed', message);
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      this.activeSSEConnections.delete(controller);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private sendSSEError(res: Response, error: string, detail?: string): void {
    if (res.headersSent) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error, detail })}\n\n`);
        res.end();
      } catch { /* ignore */ }
    } else {
      res.status(502).json({ error, detail });
    }
  }

  destroy(): void {
    this.stopHealthMonitoring();
    for (const controller of this.activeSSEConnections) {
      controller.abort();
    }
    this.activeSSEConnections.clear();
    logger.info('Destroyed');
  }
}
