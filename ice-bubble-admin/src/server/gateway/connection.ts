import WebSocket from "ws";
import { EventEmitter } from "events";

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30_000;
const CONNECT_CHALLENGE_TIMEOUT_MS = 10_000;
const TICK_TIMEOUT_MULTIPLIER = 3; // close if no tick within tickIntervalMs * this

type ConnectionState = "disconnected" | "connecting" | "connected";

interface GatewayConnectionEvents {
  reconnect: [];
  disconnect: [];
  message: [data: WebSocket.Data];
  error: [error: Error];
}

export class GatewayConnection extends EventEmitter<GatewayConnectionEvents> {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private url: string;
  private token: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private intentionalClose = false;
  // Gateway connect handshake state
  private connectNonce: string | null = null;
  private connectRequestId: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;
  // Tick watchdog
  private tickIntervalMs = 30_000;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private msgSeq = 0;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  /** Send raw data through the WebSocket (no wrapping). Throws if not connected. */
  sendRaw(data: string): void {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Gateway not connected");
    }
    this.ws.send(data);
  }

  /** Send data through the WebSocket. Throws if not connected. */
  send(data: string | Buffer | ArrayBufferLike): void {
    this.sendRaw(typeof data === "string" ? data : data.toString());
  }

  /** Establish connection. Resolves when connect handshake completes; auto-reconnects on failure. */
  connect(): Promise<void> {
    this.disposed = false;
    this.intentionalClose = false;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectRequestId = null;
    return this.tryConnect();
  }

  /** Gracefully close and stop reconnecting. */
  disconnect(): void {
    this.intentionalClose = true;
    this.disposed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = "disconnected";
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve) => {
      this.state = "connecting";
      this.pendingResolve = resolve;

      // No auth header — Gateway uses JSON-RPC connect for auth
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on("open", () => {
        // Don't resolve yet — wait for connect handshake to complete.
        // The Gateway will send a "connect.challenge" event with a nonce.
        this.armConnectChallengeTimeout();
      });

      ws.on("message", (raw) => {
        this.handleMessage(raw, ws);
      });

      ws.on("close", () => {
        const wasConnected = this.state === "connected";
        this.state = "disconnected";
        this.stopTickWatch();
        this.clearConnectChallengeTimeout();
        this.connectNonce = null;
        this.connectSent = false;
        this.connectRequestId = null;

        // Resolve pending connect promise (in case we closed before handshake)
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
        }

        if (wasConnected) {
          this.emit("disconnect");
        }

        if (!this.intentionalClose && !this.disposed) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // ── Message handling (Gateway protocol) ──────────────────────────

  private handleMessage(raw: WebSocket.Data, ws: WebSocket): void {
    const str = typeof raw === "string" ? raw : raw.toString();
    let parsed: any;
    try {
      parsed = JSON.parse(str);
    } catch {
      return; // ignore unparseable frames
    }

    // Handle Gateway event frames: { event: "connect.challenge", payload: { nonce } }
    if (parsed.event) {
      this.lastTick = Date.now();

      if (parsed.event === "connect.challenge") {
        const nonce: string | null =
          parsed.payload && typeof parsed.payload.nonce === "string"
            ? parsed.payload.nonce
            : null;
        if (!nonce || nonce.trim().length === 0) {
          this.emit("error", new Error("gateway connect challenge missing nonce"));
          ws.close(1008, "connect challenge missing nonce");
          return;
        }
        this.connectNonce = nonce.trim();
        this.sendConnect();
        return;
      }

      if (parsed.event === "tick") {
        this.lastTick = Date.now();
        return;
      }

      // Forward other events as raw messages for consumers
      this.emit("message", raw);
      return;
    }

    // Handle Gateway response frames: { type: "res", id, ok, payload }
    if (parsed.type === "res" && parsed.id != null && parsed.ok !== undefined) {
      this.lastTick = Date.now();

      // hello-ok: only treat as connect response if id matches the connect request
      if (this.connectRequestId != null && parsed.id === this.connectRequestId) {
        if (parsed.ok && parsed.payload) {
          // resolve the connect promise
          this.state = "connected";
          this.reconnectAttempt = 0;
          this.tickIntervalMs =
            typeof parsed.payload.policy?.tickIntervalMs === "number"
              ? parsed.payload.policy.tickIntervalMs
              : 30_000;
          this.lastTick = Date.now();
          this.startTickWatch();
          this.connectRequestId = null;

          if (this.pendingResolve) {
            this.pendingResolve();
            this.pendingResolve = null;
          }
          return;
        }

        // connect request error response
        if (!parsed.ok && parsed.error) {
          const errMsg = parsed.error?.message ?? "unknown gateway error";
          this.emit("error", new Error(`gateway connect error: ${errMsg}`));
          ws.close(1008, "gateway connect error");
          return;
        }
      }

      // Forward all other response frames as raw messages for rpc.ts to handle
      this.emit("message", raw);
      return;
    }

    // Fallback: forward unrecognized frames as raw messages
    this.emit("message", raw);
  }

  // ── Connect handshake ────────────────────────────────────────────

  private nextId(): string {
    return String(++this.msgSeq);
  }

  private sendConnect(): void {
    if (this.connectSent) return;
    const nonce = this.connectNonce;
    if (!nonce) {
      this.emit("error", new Error("gateway connect challenge missing nonce"));
      this.ws?.close(1008, "connect challenge missing nonce");
      return;
    }
    this.connectSent = true;
    this.clearConnectChallengeTimeout();
    this.connectRequestId = this.nextId();

    const frame = {
      type: "req",
      id: this.connectRequestId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        auth: { token: this.token },
        client: {
          id: "gateway-client",
          displayName: "Ice Bubble Admin",
          version: "1.0.0",
          platform: "node",
          mode: "backend",
        },
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
      },
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  // ── Connect challenge timeout ─────────────────────────────────────

  private armConnectChallengeTimeout(): void {
    this.clearConnectChallengeTimeout();
    this.connectTimer = setTimeout(() => {
      if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.emit("error", new Error("gateway connect challenge timeout"));
      this.ws.close(1008, "connect challenge timeout");
    }, CONNECT_CHALLENGE_TIMEOUT_MS);
  }

  private clearConnectChallengeTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  // ── Tick watchdog ─────────────────────────────────────────────────

  private startTickWatch(): void {
    this.stopTickWatch();
    // Check every tickIntervalMs that we haven't missed too many ticks
    const interval = Math.max(this.tickIntervalMs, 10_000);
    this.tickTimer = setInterval(() => {
      if (this.state !== "connected" || !this.ws) return;
      if (Date.now() - this.lastTick > this.tickIntervalMs * TICK_TIMEOUT_MULTIPLIER) {
        this.emit("error", new Error("gateway tick timeout"));
        this.ws.close(4000, "tick timeout");
      }
    }, interval);
  }

  private stopTickWatch(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.cleanup();
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.emit("reconnect");
      this.tryConnect();
    }, delay);
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopTickWatch();
    this.clearConnectChallengeTimeout();
    this.connectNonce = null;
    this.connectSent = false;
    this.connectRequestId = null;
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }
}
