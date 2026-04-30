import type { GatewayConnection } from "./connection.js";

const REQUEST_TIMEOUT = 30_000;

/** Gateway request frame: { type: "req", id: string, method: string, params?: any } */
interface GatewayRequest {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Gateway response frame: { type: "res", id: string, ok: boolean, payload?: any, error?: any } */
interface GatewayResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: number; message?: string; details?: unknown };
}

/** Gateway event frame: { type: "event", event: string, payload?: any } */
interface GatewayEvent {
  type: "event";
  event: string;
  payload?: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayRpc {
  private conn: GatewayConnection;
  private nextId = 0;
  private pending = new Map<string, PendingRequest>();
  private subscriptions = new Map<string, Set<(result: unknown) => void>>();
  private subMethodToId = new Map<string, string>();

  constructor(conn: GatewayConnection) {
    this.conn = conn;

    this.conn.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));

        // Response frame: { type: "res", id, ok, ... }
        if (msg.type === "res" && msg.id != null) {
          this.handleResponse(msg as GatewayResponse);
          return;
        }

        // Event frame: { type: "event", event, payload }
        if (msg.type === "event" || msg.event) {
          this.handleNotification(msg as GatewayEvent);
          return;
        }
      } catch {
        // Non-JSON or malformed, ignore
      }
    });

    this.conn.on("disconnect", () => {
      this.rejectAllPending(new Error("Gateway disconnected"));
    });

    this.conn.on("error", (err) => {
      this.rejectAllPending(err);
    });
  }

  private nextReqId(): string {
    return String(++this.nextId);
  }

  /** Send a Gateway request and wait for the matching response. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.conn.isConnected) {
      return Promise.reject(new Error("Gateway not connected"));
    }

    const id = this.nextReqId();
    const req: GatewayRequest = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request '${method}' timed out (${REQUEST_TIMEOUT}ms)`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      this.conn.send(JSON.stringify(req));
    });
  }

  /**
   * Subscribe to a server-pushed event stream.
   * Returns an unsubscribe function.
   */
  subscribe(
    method: string,
    params: Record<string, unknown>,
    handler: (result: unknown) => void,
  ): () => void {
    const subId = `${method}:${JSON.stringify(params)}`;

    if (!this.subscriptions.has(subId)) {
      this.subscriptions.set(subId, new Set());
      this.subMethodToId.set(method, subId);
    }
    this.subscriptions.get(subId)!.add(handler);

    // Send the subscription request
    this.request(method, params).catch(() => {
      // Subscription request failed — handler won't receive events
    });

    return () => {
      const handlers = this.subscriptions.get(subId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(subId);
          this.subMethodToId.delete(method);
        }
      }
    };
  }

  /** Send a chat.abort request. */
  abort(sessionId: string): Promise<unknown> {
    return this.request("chat.abort", { sessionId });
  }

  private handleResponse(msg: GatewayResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if (msg.ok) {
      entry.resolve(msg.payload);
    } else {
      const errMsg = msg.error?.message ?? "unknown gateway error";
      entry.reject(new Error(`RPC error: ${errMsg}`));
    }
  }

  private handleNotification(msg: GatewayEvent): void {
    // Route to any active subscription handler whose method matches
    const methodKey = msg.event;
    for (const [subId, handlers] of this.subscriptions) {
      if (subId.startsWith(methodKey)) {
        for (const h of handlers) {
          try {
            h(msg.payload);
          } catch {
            // Handler error, ignore
          }
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
