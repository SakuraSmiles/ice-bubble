import type { ServerResponse } from "node:http";


/**
 * Manages SSE connections grouped by session key.
 * Since Gateway does not push chat events to proxy clients,
 * new messages are detected via polling in ChatController and
 * broadcast here.
 */
export class SSEManager {
  private clients = new Map<string, Set<ServerResponse>>();

  addClient(sessionKey: string, res: ServerResponse): void {
    if (!this.clients.has(sessionKey)) {
      this.clients.set(sessionKey, new Set());
    }
    this.clients.get(sessionKey)!.add(res);
  }

  removeClient(sessionKey: string, res: ServerResponse): void {
    const set = this.clients.get(sessionKey);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        this.clients.delete(sessionKey);
      }
    }
  }

  broadcast(sessionKey: string, event: string, data: unknown): void {
    const set = this.clients.get(sessionKey);
    if (!set) return;
    const payload = JSON.stringify({ event, data });
    for (const res of set) {
      try {
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
      } catch {
        // Client disconnected
      }
    }
  }

  broadcastAll(event: string, data: unknown): void {
    const payload = JSON.stringify({ event, data });
    for (const set of this.clients.values()) {
      for (const res of set) {
        try {
          res.write(`event: ${event}\ndata: ${payload}\n\n`);
        } catch {
          // Client disconnected
        }
      }
    }
  }
}
