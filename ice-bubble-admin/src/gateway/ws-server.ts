/**
 * WebSocket 服务器 — 在 Admin HTTP 服务器上挂载 /ws 端点，
 * 将 Desktop 客户端连接桥接到 Gateway。
 */

import type { WebSocket as WsSocket, Server as WsServer } from "ws";
import { WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { GatewayProxy } from "./gateway-proxy.js";
import { validateToken } from "../utils/auth-middleware.js";
import { logger } from "../utils/index.js";
import type { AttachmentStorage } from "../server/chat/attachment-storage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClientRequest {
  type: "req";
  id: number | string;
  method: string;
  params?: unknown;
}

interface ClientInfo {
  platform: string;
  appVersion?: string;
  sessionId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const PENDING_QUEUE_MAX = 100;
const PENDING_QUEUE_MAX_AGE_MS = 60_000; // 1 minute
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
  private clientInfoMap = new WeakMap<WsSocket, ClientInfo>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupFns: Array<() => void> = [];
  private pendingQueue: Array<{
    ws: WsSocket;
    req: ClientRequest;
    enqueuedAt: number;
  }> = [];
  private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private httpServer: HttpServer | null = null;

  constructor(proxy: GatewayProxy, authToken: string, attachmentStorage?: AttachmentStorage) {
    this.proxy = proxy;
    this.authToken = authToken;
    this.attachmentStorage = attachmentStorage;
  }

  /** 挂载 WebSocket 服务器到 HTTP server，路径 /ws */
  start(server: HttpServer): void {
    this.httpServer = server;
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually so we can filter by path and authenticate
    this.upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (url.pathname !== "/ws") {
        // Non-/ws upgrade requests are intentionally ignored
        return;
      }

      // Authenticate: extract Bearer token from Authorization header or query param
      const providedToken = extractTokenFromRequest(req);
      const tokenPreview = providedToken
        ? `${providedToken.substring(0, 4)}...${providedToken.substring(providedToken.length - 4)}`
        : "none";
      if (!validateToken(providedToken, this.authToken)) {
        logger.info(`[WsServer] Rejected unauthenticated WebSocket connection (token=${tokenPreview})`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    };
    server.on("upgrade", this.upgradeHandler);

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
    // Subscribe to Gateway connection status events and notify Desktop clients
    const unsubConnected = this.proxy.on("connected", () => {
      logger.info("[WsServer] Gateway connected — notifying Desktop clients");
      this.broadcastFromGateway("gateway.status", { connected: true });
      // Flush pending message queue
      this.flushPendingQueue();
    });
    this.cleanupFns.push(unsubConnected);

    const unsubDisconnected = this.proxy.on("disconnected", () => {
      logger.info("[WsServer] Gateway disconnected — notifying Desktop clients");
      this.broadcastFromGateway("gateway.status", { connected: false });
    });
    this.cleanupFns.push(unsubDisconnected);

    const unsubReconnecting = this.proxy.on("reconnecting", (info: unknown) => {
      this.broadcastFromGateway("gateway.status", { connected: false, reconnecting: true });
      this.broadcastFromGateway("gateway.reconnecting", info);
    });
    this.cleanupFns.push(unsubReconnecting);

    const unsubReconnectFailed = this.proxy.on("reconnect_failed", (_info: unknown) => {
      logger.error("[WsServer] Gateway reconnect failed permanently — notifying clients");
      this.broadcastFromGateway("gateway.status", { connected: false, permanent: true });
    });
    this.cleanupFns.push(unsubReconnectFailed);

    logger.info("[WsServer] Subscribed to Gateway events for broadcast", { broadcastEvents });
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), HEARTBEAT_INTERVAL_MS);

    logger.info("[WsServer] WebSocket server mounted on /ws");
  }

  stop(): void {
    // Close all client connections
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();

    // Notify pending queue items that server is shutting down
    for (const item of this.pendingQueue) {
      try { item.ws.send(clientReply(item.req.id, false, undefined, "Server shutting down")); } catch { /* ignore */ }
    }
    this.pendingQueue = [];

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

    // P1-2: 移除 upgrade handler，防止多次 start/stop 累积
    if (this.upgradeHandler && this.httpServer) {
      this.httpServer.off("upgrade", this.upgradeHandler);
      this.upgradeHandler = null;
    }
    this.httpServer = null;

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  // ── Client lifecycle ────────────────────────────────────────────────────

  private onClientConnect(ws: WsSocket): void {
    this.clients.add(ws);
    logger.info(`[WsServer] Client connected (${this.clients.size} total)`);

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
    const client = ws as WsSocket & { isAlive?: boolean };
    client.isAlive = true;
    // clientInfo will be set by client.identify and stored in clientInfoMap

    ws.on("message", (raw: Buffer | string) => {
      try {
        this.onClientMessage(ws, raw.toString());
      } catch {
        // Malformed message — ignore
      }
    });

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("close", () => this.onClientDisconnect(ws));

    ws.on("error", (err: Error) => {
      logger.error("[WsServer] Client error:", { message: err.message });
      this.onClientDisconnect(ws);
    });
  }

  private onClientDisconnect(ws: WsSocket): void {
    this.clients.delete(ws);
    // P1-1: 清理 pendingQueue 中该 ws 的条目，避免对已断开 socket 发送
    this.pendingQueue = this.pendingQueue.filter(item => item.ws !== ws);
    logger.info(`[WsServer] Client disconnected (${this.clients.size} remaining)`);
  }

  // ── Message handling ───────────────────────────────────────────────────

  private onClientMessage(ws: WsSocket, data: string): void {
    const preview = data.substring(0, 200);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      logger.warn("[WsServer] Received non-JSON message", { preview });
      return;
    }

    const req = parsed as Record<string, unknown>;
    const method = typeof req.method === "string" ? req.method : "?";
    const id = req.id;

    if (!isClientRequest(parsed)) {
      logger.warn("[WsServer] Invalid request format", { method, id, preview });
      ws.send(clientReply(-1, false, undefined, "Invalid request format"));
      return;
    }

    // Handle heartbeat ping locally — do not forward to Gateway
    if (method === "_ping") {
      try {
        ws.send(clientReply(id as number | string, true, {
          pong: true,
          ts: Date.now(),
          gatewayStatus: this.proxy.isConnected ? "connected" : "disconnected",
        }));
      } catch { /* socket closed */ }
      return;
    }

    // Handle client identification — store clientInfo via WeakMap
    if (method === "client.identify") {
      const params = (req as Record<string, unknown>).params as Record<string, unknown> | undefined;
      if (params?.clientInfo && typeof params.clientInfo === "object") {
        const info = params.clientInfo as ClientInfo;
        const platform = typeof info.platform === "string" && info.platform.length <= 64 ? info.platform : "unknown";
        const appVersion = typeof info.appVersion === "string" && info.appVersion.length <= 32 ? info.appVersion : undefined;
        const sessionId = typeof info.sessionId === "string" && info.sessionId.length <= 128 ? info.sessionId : undefined;

        // Only store and confirm if platform is valid (not default)
        if (platform !== "unknown") {
          this.clientInfoMap.set(ws, { platform, appVersion, sessionId });
          logger.info(`[WsServer] Client identified: ${platform} v${appVersion ?? "?"} (${this.clients.size} total)`);
          try {
            ws.send(JSON.stringify({ type: "event", event: "client.identified", payload: { platform } }));
          } catch { /* socket closed */ }
        } else {
          logger.warn("[WsServer] Client identify rejected: invalid platform");
        }
      } else {
        logger.warn("[WsServer] Client identify rejected: missing or invalid clientInfo");
      }
      return;
    }

    this.forwardToGateway(ws, parsed);
  }

  // ── Gateway forwarding ─────────────────────────────────────────────────

  private forwardToGateway(ws: WsSocket, req: ClientRequest): void {
    if (!this.proxy.isConnected) {
      // Queue message instead of rejecting, so it can be sent when Gateway reconnects
      const now = Date.now();

      // Expire old entries
      this.pendingQueue = this.pendingQueue.filter(item => {
        if (now - item.enqueuedAt > PENDING_QUEUE_MAX_AGE_MS) {
          try { item.ws.send(clientReply(item.req.id, false, undefined, "Gateway reconnecting — message expired")); } catch { /* ignore */ }
          return false;
        }
        return true;
      });

      // If queue full, drop oldest
      if (this.pendingQueue.length >= PENDING_QUEUE_MAX) {
        const dropped = this.pendingQueue.shift();
        if (dropped) {
          try { dropped.ws.send(clientReply(dropped.req.id, false, undefined, "Gateway reconnecting — queue full, message dropped")); } catch { /* ignore */ }
        }
      }

      this.pendingQueue.push({ ws, req, enqueuedAt: now });
      logger.info("[WsServer] Gateway not connected — queued request", { method: req.method, id: req.id, queueSize: this.pendingQueue.length });
      return;
    }

    try {
      // Intercept chat.send / sessions.send to save attachments and tag source
      if ((req.method === 'chat.send' || req.method === 'sessions.send') &&
          req.params && typeof req.params === 'object') {
        const p = req.params as Record<string, unknown>;
        const atts = p.attachments;
        const sessionKey = (p.sessionKey || p.key) as string | undefined;
        const message = (p.message || p.text) as string | undefined;
        if (sessionKey && Array.isArray(atts) && atts.length > 0 && this.attachmentStorage) {
          void this.attachmentStorage.saveAttachments(sessionKey, atts as any[], message);
        }
      }

      logger.info(`[WsServer] Forward to Gateway: ${req.method}#${req.id}`);
      void this.proxy.request(req.method, req.params).then(
        (result) => {
          logger.info(`[WsServer] Gateway res: ${req.method}#${req.id} ok`);
          try { ws.send(clientReply(req.id, true, result)); } catch { /* socket closed */ }
        },
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[WsServer] Gateway err: ${req.method}#${req.id} ${msg}`);
          try { ws.send(clientReply(req.id, false, undefined, msg)); } catch { /* socket closed */ }
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[WsServer] Forward failed (sync)", { method: req.method, id: req.id, error: msg });
    }
  }

  private broadcastFromGateway(event: string, payload: unknown): void {
    if (this.clients.size === 0) { logger.debug(`[WsServer] Skip broadcast (no clients): ${event}`); return; }

    logger.debug(`[WsServer] Broadcasting to ${this.clients.size} clients: ${event}`);
    const message = JSON.stringify({ type: "event", event, payload });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }

  /** Flush the pending message queue after Gateway reconnects */
  private flushPendingQueue(): void {
    if (this.pendingQueue.length === 0) return;
    logger.info("[WsServer] Flushing pending queue", { size: this.pendingQueue.length });
    const queue = this.pendingQueue.splice(0); // take all
    for (const item of queue) {
      // Check ws is still alive
      if (item.ws.readyState !== item.ws.OPEN) continue;
      this.forwardToGateway(item.ws, item.req);
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
