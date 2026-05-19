/**
 * WebSocket 服务器 — 在 Admin HTTP 服务器上挂载 /ws 端点，
 * 将 Desktop 客户端连接桥接到 Gateway。
 */

import type { WebSocket as WsSocket, Server as WsServer } from "ws";
import { WebSocketServer } from "ws";
import type { Server as HttpServer } from "http";
import type { IncomingMessage } from "http";
import type { GatewayProxy } from "./gateway-proxy.js";
import { validateToken } from "../utils/auth-middleware.js";
import type { AttachmentStorage } from "../server/chat/attachment-storage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClientRequest {
  type: "req";
  id: number | string;
  method: string;
  params?: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
// ─── Helpers ─────────────────────────────────────────────────────────────────

function isClientRequest(data: unknown): data is ClientRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).type === "req" &&
    typeof (data as ClientRequest).method === "string"
  );
}

function clientReply(id: number | string, ok: boolean, payload?: unknown, error?: string): string {
  const msg: Record<string, unknown> = { type: "res", id, ok };
  if (ok) {
    msg.payload = payload;
  } else {
    msg.error = error ?? "Unknown error";
  }
  return JSON.stringify(msg);
}

/**
 * Extract Bearer token from WebSocket upgrade request.
 * Supports two mechanisms:
 * 1. Authorization header: `Bearer <token>`
 * 2. Query parameter: `?token=<token>` (for browsers where custom WS headers are limited)
 */
function extractTokenFromRequest(req: IncomingMessage): string | null {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Fallback: query parameter (for Desktop gateway-client.ts which can't set WS headers)
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const tokenParam = url.searchParams.get("token");
    if (tokenParam) return tokenParam;
  } catch {
    // Ignore URL parse errors
  }

  return null;
}

// ─── GatewayWsServer ────────────────────────────────────────────────────────

export class GatewayWsServer {
  private proxy: GatewayProxy;
  private authToken: string;
  private attachmentStorage?: AttachmentStorage;
  private wss: WsServer | null = null;
  private clients = new Set<WsSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupFns: Array<() => void> = [];

  constructor(proxy: GatewayProxy, authToken: string, attachmentStorage?: AttachmentStorage) {
    this.proxy = proxy;
    this.authToken = authToken;
    this.attachmentStorage = attachmentStorage;
  }

  /** 挂载 WebSocket 服务器到 HTTP server，路径 /ws */
  start(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually so we can filter by path and authenticate
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (url.pathname !== "/ws") {
        // Non-/ws upgrade requests are intentionally ignored
        return;
      }

      // Authenticate: extract Bearer token from Authorization header or query param
      const providedToken = extractTokenFromRequest(req);
      if (!validateToken(providedToken, this.authToken)) {
        console.log("[WsServer] Rejected unauthenticated WebSocket connection");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws: WsSocket) => this.onClientConnect(ws));

    // Subscribe to broadcast-worthy events from Gateway
    const broadcastEvents = [
      "chat",
      "agent",
      "session.message",
      "sessions.changed",
      "presence",
      "shutdown",
    ];

    for (const event of broadcastEvents) {
      const unsub = this.proxy.on(event, (payload: unknown) => {
        this.broadcastFromGateway(event, payload);
      });
      this.cleanupFns.push(unsub);
    }

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), HEARTBEAT_INTERVAL_MS);

    console.log("[WsServer] WebSocket server mounted on /ws");
  }

  stop(): void {
    // Close all client connections
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();

    // Clean up subscriptions
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  // ── Client lifecycle ────────────────────────────────────────────────────

  private onClientConnect(ws: WsSocket): void {
    this.clients.add(ws);
    console.log(`[WsServer] Client connected (${this.clients.size} total)`);

    // 立即发送 connect.hello，让 Desktop 的 gatewayClient 认为连接成功
    try {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.hello",
        payload: {
          type: "hello-ok",
          protocol: 3,
          server: { version: "ice-bubble-admin/1.0" },
          sessionKey: null,
        },
      }));
    } catch { /* ignore */ }

    // Mark client as alive (for heartbeat)
    (ws as WsSocket & { isAlive?: boolean }).isAlive = true;

    ws.on("message", (raw: Buffer | string) => {
      try {
        this.onClientMessage(ws, raw.toString());
      } catch {
        // Malformed message — ignore
      }
    });

    ws.on("pong", () => {
      (ws as WsSocket & { isAlive?: boolean }).isAlive = true;
    });

    ws.on("close", () => this.onClientDisconnect(ws));

    ws.on("error", (err: Error) => {
      console.error("[WsServer] Client error:", err.message);
      this.onClientDisconnect(ws);
    });
  }

  private onClientDisconnect(ws: WsSocket): void {
    this.clients.delete(ws);
    console.log(`[WsServer] Client disconnected (${this.clients.size} remaining)`);
  }

  // ── Message handling ───────────────────────────────────────────────────

  private onClientMessage(ws: WsSocket, data: string): void {
    console.log("[WsServer] Received:", data.substring(0, 200));
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!isClientRequest(parsed)) {
      ws.send(clientReply(-1, false, undefined, "Invalid request format"));
      return;
    }

    this.forwardToGateway(ws, parsed);
  }

  // ── Gateway forwarding ─────────────────────────────────────────────────

  private forwardToGateway(ws: WsSocket, req: ClientRequest): void {
    if (!this.proxy.isConnected) {
      try { ws.send(clientReply(req.id, false, undefined, "Gateway not connected")); } catch { /* socket closed */ }
      return;
    }

    try {
      // Intercept chat.send / sessions.send to save attachments
      if (this.attachmentStorage &&
          (req.method === 'chat.send' || req.method === 'sessions.send') &&
          req.params && typeof req.params === 'object') {
        const p = req.params as Record<string, unknown>;
        const atts = p.attachments;
        const sessionKey = (p.sessionKey || p.key) as string | undefined;
        const message = (p.message || p.text) as string | undefined;
        if (sessionKey && Array.isArray(atts) && atts.length > 0) {
          void this.attachmentStorage.saveAttachments(sessionKey, atts as any[], message);
        }
      }

      void this.proxy.request(req.method, req.params).then(
        (result) => { try { ws.send(clientReply(req.id, true, result)); } catch { /* socket closed */ } },
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          try { ws.send(clientReply(req.id, false, undefined, msg)); } catch { /* socket closed */ }
        },
      );
    } catch {
      /* proxy.request threw synchronously — ignore */
    }
  }

  private broadcastFromGateway(event: string, payload: unknown): void {
    if (this.clients.size === 0) return;

    const message = JSON.stringify({ type: "event", event, payload });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  private sendHeartbeats(): void {
    for (const ws of this.clients) {
      const client = ws as WsSocket & { isAlive?: boolean };
      if (!client.isAlive) {
        // No pong received — terminate
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      client.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* already closing */
      }
    }
  }
}
