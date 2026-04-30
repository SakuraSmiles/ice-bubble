import type { ServerResponse } from "node:http";
import type { GatewayRpc } from "../gateway/rpc.js";

/**
 * Manages Server-Sent Events connections grouped by session key,
 * and subscribes to Gateway message pushes (once per session).
 */
export class SSEManager {
  /** sessionKey → set of SSE responses */
  private clients = new Map<string, Set<ServerResponse>>();
  /** Gateway subscription state: sessionKey → unsubscribe function */
  private gatewaySubs = new Map<string, () => void>();

  constructor(private rpc: GatewayRpc) {}

  /** Register a new SSE client for the given session. Sets up headers and gateway subscription. */
  addClient(sessionKey: string, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");

    if (!this.clients.has(sessionKey)) {
      this.clients.set(sessionKey, new Set());
      this.subscribeGateway(sessionKey);
    }
    this.clients.get(sessionKey)!.add(res);

    // Clean up on client disconnect
    res.on("close", () => this.removeClient(sessionKey, res));
  }

  /** Remove an SSE client. Unsubscribes from gateway if no clients remain. */
  removeClient(sessionKey: string, res: ServerResponse): void {
    const set = this.clients.get(sessionKey);
    if (!set) return;

    set.delete(res);
    if (set.size === 0) {
      this.clients.delete(sessionKey);
      this.unsubscribeGateway(sessionKey);
    }
  }

  /** Broadcast an event to all SSE clients subscribed to a session. */
  broadcast(sessionKey: string, event: string, data: unknown): void {
    const set = this.clients.get(sessionKey);
    if (!set) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // Client may have disconnected; removeClient will handle via 'close' event
      }
    }
  }

  /** Broadcast an event to ALL connected SSE clients regardless of session. */
  broadcastAll(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const set of this.clients.values()) {
      for (const res of set) {
        try {
          res.write(payload);
        } catch {
          // Ignore stale connections
        }
      }
    }
  }

  /** Subscribe to gateway message pushes for a session (once per sessionKey). */
  private subscribeGateway(sessionKey: string): void {
    if (this.gatewaySubs.has(sessionKey)) return;

    const unsub = this.rpc.subscribe(
      "sessions.messages.subscribe",
      { sessionKey } as Record<string, unknown>,
      (result: unknown) => {
        // Gateway pushes messages; forward to SSE clients
        const msg = result as { type?: string; [key: string]: unknown };
        this.broadcast(sessionKey, msg.type ?? "message", msg);
      },
    );

    this.gatewaySubs.set(sessionKey, unsub);
  }

  /** Unsubscribe from gateway when no clients remain. */
  private unsubscribeGateway(sessionKey: string): void {
    const unsub = this.gatewaySubs.get(sessionKey);
    if (unsub) {
      unsub();
      this.gatewaySubs.delete(sessionKey);
    }
  }
}
