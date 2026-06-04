import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from '../utils/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GatewayProxyOptions {
  gatewayUrl?: string;
  authToken?: string;
  instanceId?: string;
  clientVersion?: string;
}

interface OutgoingRequest {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

interface IncomingResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string };
}

interface IncomingEvent {
  type: "event";
  event: string;
  payload: unknown;
  seq?: number;
}

type IncomingMessage = IncomingResponse | IncomingEvent | { type: string };

type Listener = (payload: unknown) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789/ws";
const OPENCLAW_CONFIG_PATH = join(
  process.env.HOME || "/root",
  ".openclaw",
  "openclaw.json"
);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 50;

/** Minimum protocol version this Admin client supports (backward compat) */
const ADMIN_MIN_PROTOCOL = 3;
/** Maximum protocol version this Admin client is willing to accept */
const ADMIN_MAX_PROTOCOL = 99;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readTokenFromConfig(): string {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    throw new Error(
      `OpenClaw config not found at ${OPENCLAW_CONFIG_PATH}; set GATEWAY_AUTH_TOKEN instead.`
    );
  }
  try {
    const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const token = raw?.gateway?.auth?.token ?? raw?.controlUi?.auth?.token ?? raw?.auth?.token;
    if (!token) throw new Error("token field missing");
    return token as string;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse ${OPENCLAW_CONFIG_PATH}: ${e.message}`);
    }
    throw e;
  }
}

function resolveAuthToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GATEWAY_AUTH_TOKEN) return process.env.GATEWAY_AUTH_TOKEN;
  return readTokenFromConfig();
}

// ─── GatewayProxy ───────────────────────────────────────────────────────────

export class GatewayProxy {
  private gatewayUrl: string;
  private authToken: string;
  private clientVersion: string;
  private instanceId: string;

  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private listeners = new Map<string, Set<Listener>>();

  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private negotiatedProtocol: number | null = null;
  private recentDisconnects: number[] = [];
  constructor(opts: GatewayProxyOptions = {}) {
    this.gatewayUrl = opts.gatewayUrl || process.env.GATEWAY_URL || DEFAULT_GATEWAY_URL;
    this.authToken = resolveAuthToken(opts.authToken);
    this.clientVersion = opts.clientVersion || "1.0.0";
    this.instanceId = opts.instanceId || crypto.randomUUID();
  }

  /** Whether the WebSocket is open and authenticated. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** The protocol version negotiated with the Gateway, or null if not yet connected */
  get protocolVersion(): number | null {
    return this.negotiatedProtocol;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.closed = false;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("GatewayProxy is closed"));
        return;
      }

      const socket = new WebSocket(this.gatewayUrl, {
        headers: { Origin: "http://localhost:13000" },
      });
      let settled = false;

      socket.on("open", () => {
        // Authentication will happen after connect.challenge event
      });

      socket.on("message", (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString()) as IncomingMessage;
          this.onMessage(data);
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on("close", () => {
        // Only clear state if this socket is still the active one
        if (this.ws !== socket) return;
        this.ws = null;
        if (!settled && !this.closed) {
          settled = true;
          reject(new Error("Connection closed before authentication"));
        }
        // Only schedule reconnect if we're not intentionally closed
        if (!this.closed) {
          this.onConnectionLost();
        }
      });

      socket.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.ws = socket;

      // Resolve once authentication completes
      this.on("_authenticated", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      // Handle auth failure
      this.on("_auth_failed", (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Disconnected"));
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    this.reconnectAttempts = 0;
  }

  // ── Core Methods ─────────────────────────────────────────────────────────

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const id = String(++this.reqId);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method}#${id} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const msg: OutgoingRequest = { type: "req", id, method, params };
      this.ws!.send(JSON.stringify(msg));
    });
  }

  on(event: string, callback: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, payload: unknown): void {
    const cbs = this.listeners.get(event);
    if (cbs) {
      for (const cb of cbs) {
        try {
          cb(payload);
        } catch {
          // Listener errors should not break the proxy
        }
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private onMessage(data: IncomingMessage): void {
    if (data.type === "res") {
      this.handleResponse(data as IncomingResponse);
    } else if (data.type === "event") {
      this.handleEvent(data as IncomingEvent);
    }
  }

  private handleResponse(msg: IncomingResponse): void {
    const entry = this.pending.get(String(msg.id));
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(String(msg.id));

    if (msg.ok) {
      // 提取协商后的协议版本（仅 HelloOk 响应包含 protocol 字段）
      if (msg.payload && typeof msg.payload === 'object' && 'protocol' in msg.payload) {
        const payload = msg.payload as { protocol?: number };
        if (typeof payload.protocol === 'number') {
          this.negotiatedProtocol = payload.protocol;
          logger.info(`[GatewayProxy] Negotiated protocol version: v${payload.protocol}`);
        }
      }
      entry.resolve(msg.payload);
    } else {
      const errMsg = msg.error?.message || `Request #${msg.id} failed`;
      entry.reject(new Error(errMsg));
    }
  }

  private handleEvent(msg: IncomingEvent): void {
    switch (msg.event) {
      case "connect.challenge":
        this.handleChallenge(msg.payload as { nonce: string; ts: number });
        return;
      case "shutdown":
        this.emit("shutdown", msg.payload);
        this.disconnect();
        return;
    }

    // Forward all other events to listeners
    const listenerCount = this.listeners.get(msg.event)?.size ?? 0;
    logger.debug(`[GatewayProxy] Event from Gateway: ${msg.event} (listeners: ${listenerCount})`);
    this.emit(msg.event, msg.payload);
  }

  private async handleChallenge(_payload: { nonce: string; ts: number }): Promise<void> {

    try {
      const result = await this.sendConnect();
      this.reconnectAttempts = 0;
      this.emit("_authenticated", null);
      this.emit("connected", result);
    } catch (err) {
      this.emit("_auth_failed", err);
      this.emit("error", err);
    }
  }

  private sendConnect(): Promise<unknown> {
    // Reset reqId on connect to avoid id conflicts
    this.reqId = 0;
    const connectId = String(++this.reqId);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(connectId);
        reject(new Error("Authentication request timed out"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(connectId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const msg = {
        type: "req" as const,
        id: connectId,
        method: "connect",
        params: {
          minProtocol: ADMIN_MIN_PROTOCOL,
          maxProtocol: ADMIN_MAX_PROTOCOL,
          client: {
            id: "openclaw-control-ui",
            version: this.clientVersion,
            mode: "webchat",
            platform: "server",
            instanceId: this.instanceId,
          },
          role: "operator",
          scopes: [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
          ],
          caps: ["tool-events"],
          auth: { token: this.authToken },
        },
      };

      this.ws!.send(JSON.stringify(msg));
    });
  }

  private onConnectionLost(): void {
    this.emit("disconnected", null);

    if (this.closed) return;

    // P1-5: 记录断连时间，用于 flapping 检测
    const now = Date.now();
    this.recentDisconnects.push(now);
    this.recentDisconnects = this.recentDisconnects.filter(t => now - t < 5000);

    // Reject pending requests
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection lost"));
    }
    this.pending.clear();

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;

    // Max attempts check
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(`[GatewayProxy] Reconnect exhausted after ${this.reconnectAttempts} attempts`);
      this.emit("reconnect_failed", {
        attempts: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
      });
      return;
    }

    this.reconnectAttempts++;
    let delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );

    // P1-5: flapping 检测 — 5s 内断连 ≥3 次，加大退避
    const flapping = this.recentDisconnects.length >= 3;
    if (flapping) {
      delay = Math.min(delay * 3, MAX_RECONNECT_DELAY_MS);
      logger.warn(`[GatewayProxy] Flapping detected (${this.recentDisconnects.length} disconnects in 5s), increased delay to ${delay}ms`);
    }

    this.emit("reconnecting", { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // doConnect handles its own rejection; retry will be scheduled by onConnectionLost
      });
    }, delay);
  }
}
