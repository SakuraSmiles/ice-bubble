/**
 * HTTP REST 代理 — 通过 GatewayProxy 将请求转发到 Gateway，
 * 作为 WebSocket 的备用通道。
 */

import { Router } from "express";
import { logger } from "../utils/index.js";
import type { GatewayProxy } from "../gateway/gateway-proxy.js";
import type { DataRepository } from "../storage/data-repository.js";

// ─── Chat Proxy Router ───────────────────────────────────────────────────────

export function createChatProxyRouter(proxy: GatewayProxy, repository?: DataRepository): Router {
  const router = Router();

  // GET /history?sessionKey=xxx&limit=50&before=ISO_timestamp
  router.get("/history", async (req, res) => {
    const sessionKey = req.query.sessionKey as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const before = req.query.before as string | undefined;
    try {

      if (!sessionKey) {
        res.status(400).json({ error: "sessionKey is required" });
        return;
      }

      const params: Record<string, unknown> = { sessionKey, limit };
      if (before) params.before = before;

      const result = await proxy.request("chat.history", params);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // P1: 降级到 Admin SQLite 历史数据
      logger.warn('[ChatProxy] Gateway chat.history failed, falling back to Admin SQLite', { error: msg });
      if (repository) {
        try {
          const result = repository.getMessages({
            session_key: sessionKey,
            limit,
          });
          res.json({
            messages: result.messages.map((m: any) => ({
              ...m,
              id: m.id,
              source: 'sqlite',
            })),
            history: [],
          });
        } catch (fallbackErr) {
          logger.error('[ChatProxy] Admin SQLite fallback also failed', { error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) });
          res.json({ messages: [], history: [] });
        }
      } else {
        res.json({ messages: [], history: [] });
      }
    }
  });

  // NOTE: POST /abort is handled by ChatController in index.ts (before this router is mounted).
  // Do NOT register /abort here — it would be shadowed.

  return router;
}

// ─── Session Proxy Router ────────────────────────────────────────────────────

export function createSessionProxyRouter(proxy: GatewayProxy): Router {
  const router = Router();

  // GET /sessions
  router.get("/sessions", async (_req, res) => {
    try {
      const result = await proxy.request("sessions.list");
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // P1: 返回空结果而不是 502
      logger.warn('[SessionProxy] Gateway sessions.list failed, returning empty result', { error: msg });
      res.json({ sessions: [] });
    }
  });

  return router;
}
