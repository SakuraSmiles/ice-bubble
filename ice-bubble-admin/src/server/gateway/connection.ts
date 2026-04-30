import WebSocket from "ws";
import { EventEmitter } from "events";

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30_000;
const HEARTBEAT_INTERVAL = 30_000;

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private intentionalClose = false;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  /** Send raw data through the WebSocket. Throws if not connected. */
  send(data: string | Buffer | ArrayBufferLike): void {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Gateway not connected");
    }
    this.ws.send(data);
  }

  /** Establish connection. Resolves when first handshake completes; auto-reconnects on failure. */
  connect(): Promise<void> {
    this.disposed = false;
    this.intentionalClose = false;
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

      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });

      ws.on("open", () => {
        this.state = "connected";
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        resolve();
      });

      ws.on("message", (data) => {
        this.emit("message", data);
      });

      ws.on("close", () => {
        const wasConnected = this.state === "connected";
        this.state = "disconnected";
        this.stopHeartbeat();

        if (wasConnected) {
          this.emit("disconnect");
        }

        if (!this.intentionalClose && !this.disposed) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        // "open" won't fire after an error, resolve the promise won't block forever
        // because we schedule reconnect in the "close" handler.
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });

      this.ws = ws;
    });
  }

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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.state === "connected") {
        // Send a lightweight ping; ws will use the protocol-level ping frame
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }
}
