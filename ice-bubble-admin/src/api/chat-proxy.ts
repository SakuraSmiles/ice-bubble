/**
 * HTTP REST 代理 — 通过 GatewayProxy 将请求转发到 Gateway，
 * 作为 WebSocket 的备用通道。
 */

import { Router } from "express";
import type { GatewayProxy } from "../gateway/gateway-proxy.js";

// ─── Chat Proxy Router ───────────────────────────────────────────────────────

export function createChatProxyRouter(proxy: GatewayProxy): Router {
  const router = Router();

  // GET /history?sessionKey=xxx&limit=50&before=ISO_timestamp
  router.get("/history", async (req, res) => {
    try {
      const sessionKey = req.query.sessionKey as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const before = req.query.before as string | undefined;

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
      res.status(502).json({ error: "Gateway request failed", detail: msg });
    }
  });

  // POST /abort  body: { sessionKey }
  router.post("/abort", async (req, res) => {
    try {
      const { sessionKey } = req.body;
      if (!sessionKey) {
        res.status(400).json({ error: "sessionKey is required" });
        return;
      }
      const result = await proxy.request("chat.abort", { sessionKey });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Gateway request failed", detail: msg });
    }
  });

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
      res.status(502).json({ error: "Gateway request failed", detail: msg });
    }
  });

  return router;
}
