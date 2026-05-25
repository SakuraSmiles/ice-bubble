/**
 * OpenCode HTTP Client
 *
 * 通过 OpenCode serve HTTP API (opencode serve --port 4097) 与 OpenCode 通信。
 * 当前版本使用非流式模式（一次返回完整结果），后续可升级为 SSE 流式。
 */

import { Logger } from '../../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenCodeSession {
  id: string;
  title: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export interface OpenCodePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpenCodeResponse {
  info?: {
    agent?: string;
    modelID?: string;
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
    };
    mode?: string;
  };
  parts?: OpenCodePart[];
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class OpenCodeHttpClient {
  private baseUrl: string;
  private logger: Logger;
  private timeoutMs: number;

  constructor(config?: { baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = (config?.baseUrl || 'http://localhost:4097').replace(/\/+$/, '');
    this.timeoutMs = config?.timeoutMs || 120_000; // 2 分钟默认超时
    this.logger = new Logger('OpenCodeClient');
  }

  /** 获取当前 baseUrl */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * 健康检查 — 尝试请求 session 列表来判断 OpenCode 是否可达
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/session`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 创建 session 并发送首条消息
   * POST /session
   */
  async createSession(message: string, agent?: string): Promise<{
    sessionId: string;
    session: OpenCodeSession;
    response: OpenCodeResponse;
  }> {
    const startTime = Date.now();
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: message }],
    };
    if (agent) {
      body.agent = agent;
    }

    this.logger.info(`Creating session with agent=${agent || 'default'}`);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenCode createSession failed: HTTP ${res.status} ${errText}`);
    }

    const response = (await res.json()) as OpenCodeResponse & { id?: string; title?: string };
    const sessionId = response.id || '';

    // OpenCode's POST /session only creates the session, doesn't process the message.
    // Send the actual message via POST /session/{id}/message
    const msgResult = await this.sendMessage(sessionId, message);

    const elapsed = Date.now() - startTime;
    this.logger.info(`Session created: ${sessionId}`, {
      sessionId,
      agent: agent || 'default',
      model: msgResult.response.info?.modelID,
      tokens: msgResult.response.info?.tokens,
      elapsedMs: elapsed,
    });

    return {
      sessionId,
      session: { id: sessionId, title: response.title || '' },
      response: msgResult.response,
    };
  }

  /**
   * 向已有 session 发送消息
   * POST /session/{id}/message
   */
  async sendMessage(
    sessionId: string,
    message: string,
  ): Promise<{
    sessionId: string;
    response: OpenCodeResponse;
    messageId?: string;
  }> {
    const startTime = Date.now();
    const body = {
      parts: [{ type: 'text', text: message }],
    };

    this.logger.info(`Sending message to session ${sessionId}`);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `OpenCode sendMessage failed: HTTP ${res.status} ${errText}`,
      );
    }

    const response = (await res.json()) as OpenCodeResponse;
    const elapsed = Date.now() - startTime;

    this.logger.info(`Message response received for session ${sessionId}`, {
      sessionId,
      model: response.info?.modelID,
      tokens: response.info?.tokens,
      elapsedMs: elapsed,
    });

    return {
      sessionId,
      response,
    };
  }

  /**
   * 列出所有 session
   * GET /session
   */
  async getSessions(): Promise<OpenCodeSession[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenCode getSessions failed: HTTP ${res.status} ${errText}`);
    }

    return (await res.json()) as OpenCodeSession[];
  }

  /**
   * 带超时的 fetch 封装
   * AbortSignal.timeout 是标准 API，但部分旧 Node 版本不支持；
   * 这里接收外部 signal 作为超时和取消的统一入口。
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    // AbortSignal.timeout 已在 init.signal 中传入
    return fetch(url, init);
  }
}
