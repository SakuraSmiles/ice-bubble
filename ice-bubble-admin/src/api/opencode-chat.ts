/**
 * OpenCode Chat API Router
 *
 * 提供通过 OpenCode HTTP API 进行 AI 对话的 REST 端点。
 * 当前版本使用非流式模式（一次返回完整结果），后续可升级为 SSE 流式。
 */

import { Router } from 'express';
import { OpenCodeHttpClient } from '../server/chat/opencode-client.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('OpenCodeChat');

// ─── Types ──────────────────────────────────────────────────────────────────

interface SendRequest {
  agent?: string;
  message: string;
  sessionId?: string;
}

interface SendResponse {
  success: boolean;
  sessionId: string;
  messageId?: string;
  content: string;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  model?: string;
  agent?: string;
  error?: string;
}

interface AbortResponse {
  success: boolean;
  message: string;
}

interface HealthResponse {
  status: 'connected' | 'disconnected';
  opencodeUrl: string;
  message: string;
}

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * 创建 OpenCode 聊天路由
 */
export function createOpenCodeChatRouter(client: OpenCodeHttpClient): Router {
  const router = Router();

  /**
   * POST /api/opencode/chat/send
   * 发送消息到 OpenCode
   */
  router.post('/chat/send', async (req, res) => {
    try {
      const { agent, message, sessionId } = (req.body || {}) as SendRequest;

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: message',
        } as SendResponse);
        return;
      }

      // 检查 OpenCode 是否可达
      const healthy = await client.healthCheck();
      if (!healthy) {
        res.status(503).json({
          success: false,
          error: 'OpenCode is not reachable. Is `opencode serve` running?',
        } as SendResponse);
        return;
      }

      if (sessionId) {
        // 已有 session — 继续对话
        const result = await client.sendMessage(sessionId, message);

        const textContent = (result.response.parts || [])
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text!)
          .join('\n');

        const response: SendResponse = {
          success: true,
          sessionId: result.sessionId,
          content: textContent,
          tokens: result.response.info?.tokens,
          model: result.response.info?.modelID,
          agent: result.response.info?.agent,
        };

        res.json(response);
      } else {
        // 新 session — 创建并发送
        const result = await client.createSession(message, agent);

        const textContent = (result.response.parts || [])
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text!)
          .join('\n');

        const response: SendResponse = {
          success: true,
          sessionId: result.sessionId,
          content: textContent,
          tokens: result.response.info?.tokens,
          model: result.response.info?.modelID,
          agent: result.response.info?.agent || agent,
        };

        res.json(response);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`OpenCode chat/send failed`, { error: message });

      res.status(502).json({
        success: false,
        error: `OpenCode request failed: ${message}`,
      } as SendResponse);
    }
  });

  /**
   * POST /api/opencode/chat/abort
   * 占位端点 — 当前非流式模式不需要，预留接口
   */
  router.post('/chat/abort', (_req, res) => {
    const response: AbortResponse = {
      success: true,
      message: 'Abort is not needed in non-streaming mode. Reserved for future SSE streaming support.',
    };
    res.json(response);
  });

  /**
   * GET /api/opencode/chat/health
   * 返回 OpenCode 连接状态
   */
  router.get('/chat/health', async (_req, res) => {
    try {
      const healthy = await client.healthCheck();
      const response: HealthResponse = {
        status: healthy ? 'connected' : 'disconnected',
        opencodeUrl: client.getBaseUrl(),
        message: healthy
          ? 'OpenCode is running and reachable'
          : 'OpenCode is not reachable',
      };
      res.json(response);
    } catch {
      const response: HealthResponse = {
        status: 'disconnected',
        opencodeUrl: client.getBaseUrl(),
        message: 'Health check failed',
      };
      res.json(response);
    }
  });

  return router;
}
