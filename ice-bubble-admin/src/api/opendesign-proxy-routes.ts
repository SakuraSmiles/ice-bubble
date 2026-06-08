/**
 * OpenDesign 代理路由
 *
 * 所有路由挂载在 /api/opendesign 下，透明转发到 OpenDesign daemon。
 */

import { Router, Request, Response } from 'express';
import { OpenDesignProxy, ProxyError } from '../proxy/opendesign-proxy.js';
import { createLogger } from '@ice-bubble/logger';

const logger = createLogger('OpenDesignRoutes');

/**
 * 创建 OpenDesign 代理路由
 */
export interface OpenDesignRouterOptions {
  /** 默认 agent ID，当客户端请求未提供 agentId 时自动注入 */
  defaultAgentId?: string;
}

export function createOpenDesignRouter(
  proxy: OpenDesignProxy,
  opts: OpenDesignRouterOptions = {}
): Router {
  const { defaultAgentId } = opts;
  const router = Router();

  // ── SSE 流式路由 ────────────────────────────────────────────────────────

  /**
   * POST /api/opendesign/chat
   * 创建聊天，SSE 流式返回
   */
  router.post('/chat', async (req: Request, res: Response) => {
    try {
      if (!req.body?.message) {
        res.status(400).json({ error: 'Missing required field: message' });
        return;
      }
      // 注入默认 agentId（若客户端未提供且配置了默认值）
      const body = { ...req.body };
      if (!body.agentId && defaultAgentId) {
        body.agentId = defaultAgentId;
        logger.info(`chat: injecting default agentId=${defaultAgentId}`);
      }
      await proxy.proxySSE('/api/chat', 'POST', res, {
        body,
      });
    } catch (err) {
      handleError(res, err, 'chat');
    }
  });

  /**
   * POST /api/opendesign/runs
   * 创建设计运行，SSE 流式返回
   */
  router.post('/runs', async (req: Request, res: Response) => {
    try {
      if (!req.body?.message || !req.body?.projectId) {
        res.status(400).json({ error: 'Missing required fields: projectId, message' });
        return;
      }
      // 注入默认 agentId（若客户端未提供且配置了默认值）
      const body = { ...req.body };
      if (!body.agentId && defaultAgentId) {
        body.agentId = defaultAgentId;
        logger.info(`runs: injecting default agentId=${defaultAgentId}`);
      }
      await proxy.proxySSE('/api/runs', 'POST', res, {
        body,
      });
    } catch (err) {
      handleError(res, err, 'runs');
    }
  });

  /**
   * GET /api/opendesign/runs/:id/events
   * SSE 流式获取运行事件
   */
  router.get('/runs/:id/events', async (req: Request, res: Response) => {
    try {
      await proxy.proxySSE(
        `/api/runs/${encodeURIComponent(req.params.id)}/events`,
        'GET',
        res
      );
    } catch (err) {
      handleError(res, err, 'runs/events');
    }
  });

  // ── 普通 REST 路由 ─────────────────────────────────────────────────────

  /**
   * POST /api/opendesign/runs/:id/cancel
   */
  router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
    try {
      const result = await proxy.proxyRequest({
        path: `/api/runs/${encodeURIComponent(req.params.id)}/cancel`,
        method: 'POST',
        body: req.body,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'runs/cancel');
    }
  });

  /**
   * GET /api/opendesign/runs/:id/genui
   */
  router.get('/runs/:id/genui', async (req: Request, res: Response) => {
    try {
      const result = await proxy.proxyRequest({
        path: `/api/runs/${encodeURIComponent(req.params.id)}/genui`,
        method: 'GET',
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'runs/genui');
    }
  });

  /**
   * POST /api/opendesign/runs/:id/genui/:surfaceId/respond
   */
  router.post(
    '/runs/:id/genui/:surfaceId/respond',
    async (req: Request, res: Response) => {
      try {
        const result = await proxy.proxyRequest({
          path: `/api/runs/${encodeURIComponent(req.params.id)}/genui/${encodeURIComponent(req.params.surfaceId)}/respond`,
          method: 'POST',
          body: req.body,
        });
        res.json(result);
      } catch (err) {
        handleError(res, err, 'runs/genui/respond');
      }
    }
  );

  /**
   * GET /api/opendesign/projects
   */
  router.get('/projects', async (_req: Request, res: Response) => {
    try {
      const result = await proxy.proxyRequest({
        path: '/api/projects',
        method: 'GET',
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'projects');
    }
  });

  /**
   * POST /api/opendesign/projects
   */
  router.post('/projects', async (req: Request, res: Response) => {
    try {
      if (!req.body?.name) {
        res.status(400).json({ error: 'Missing required field: name' });
        return;
      }
      const result = await proxy.proxyRequest({
        path: '/api/projects',
        method: 'POST',
        body: req.body,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'projects/create');
    }
  });

  /**
   * GET /api/opendesign/projects/:id/files
   */
  router.get('/projects/:id/files', async (req: Request, res: Response) => {
    try {
      const result = await proxy.proxyRequest({
        path: `/api/projects/${encodeURIComponent(req.params.id)}/files`,
        method: 'GET',
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'projects/files');
    }
  });

  /**
   * POST /api/opendesign/projects/:id/files
   */
  router.post('/projects/:id/files', async (req: Request, res: Response) => {
    try {
      const result = await proxy.proxyRequest({
        path: `/api/projects/${encodeURIComponent(req.params.id)}/files`,
        method: 'POST',
        body: req.body,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'projects/files/write');
    }
  });

  // ── 健康检查 ────────────────────────────────────────────────────────────

  /**
   * GET /api/opendesign/health
   */
  router.get('/health', async (_req: Request, res: Response) => {
    const result = await proxy.healthCheck();
    res.json({
      ...result,
      baseUrl: proxy.getBaseUrl(),
    });
  });

  // ── 错误处理辅助 ────────────────────────────────────────────────────────

  function handleError(res: Response, err: unknown, context: string): void {
    const message = err instanceof Error ? err.message : String(err);

    // ProxyError: 透传上游 OD daemon 的状态码和响应体
    if (err instanceof ProxyError) {
      logger.warn(`${context} upstream error`, { statusCode: err.statusCode, body: err.upstreamBody.slice(0, 500) });
      try {
        res.status(err.statusCode)
          .set('Content-Type', 'application/json')
          .send(err.upstreamBody);
        return;
      } catch {
        // upstreamBody 不是合法 JSON，回退到 generic message
        res.status(err.statusCode).json({ error: `OD daemon error: ${err.statusText}`, detail: message });
        return;
      }
    }

    logger.error(`${context} failed`, { error: message });

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      res.status(503).json({
        error: 'OpenDesign daemon is not reachable',
        detail: message,
      });
    } else if (message.includes('timed out') || message.includes('AbortError')) {
      res.status(504).json({
        error: 'Request to OpenDesign daemon timed out',
        detail: message,
      });
    } else {
      res.status(502).json({
        error: `OpenDesign proxy error (${context})`,
        detail: message,
      });
    }
  }

  return router;
}
