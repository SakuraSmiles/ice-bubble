import type { GatewayConnection } from "./connection.js";

const REQUEST_TIMEOUT = 30_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayRpc {
  private conn: GatewayConnection;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private subscriptions = new Map<string, Set<(result: unknown) => void>>();
  private subMethodToId = new Map<string, string>(); // method -> internal sub id

  constructor(conn: GatewayConnection) {
    this.conn = conn;

    this.conn.on("message", (data) => {
      try {
        const msg: JsonRpcResponse = JSON.parse(String(data));
        if (msg.id != null) {
          this.handleResponse(msg);
        } else {
          // Unsolicited server push — check subscriptions
          this.handleNotification(msg);
        }
      } catch {
        // Non-JSON or malformed, ignore
      }
    });

    this.conn.on("disconnect", () => {
      this.rejectAllPending(new Error("Gateway disconnected"));
    });

    this.conn.on("error", (err) => {
      // Connection-level errors are handled by GatewayConnection reconnect logic
      // We just reject pending requests as a safety net
      this.rejectAllPending(err);
    });
  }

  /** Send a JSON-RPC request and wait for the matching response. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.conn.isConnected) {
      return Promise.reject(new Error("Gateway not connected"));
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

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

    // Send the subscription request (fire-and-forget via request)
    this.request(method, params).catch(() => {
      // Subscription request failed — handler won't receive events
    });

    // Return unsubscribe function
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

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if ("error" in msg) {
      const { code, message } = msg.error;
      entry.reject(new Error(`RPC error ${code}: ${message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleNotification(msg: unknown): void {
    // Best-effort: try to route to any active subscription handler
    for (const handlers of this.subscriptions.values()) {
      for (const h of handlers) {
        try {
          h(msg);
        } catch {
          // Handler error, ignore
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
