import type { GatewayRpc } from "../gateway/rpc.js";

/**
 * In-memory cache for session_key ↔ session_id mappings.
 * Calls sessions.create on cache miss.
 */
export class SessionCache {
  private cache = new Map<string, string>();

  constructor(private rpc: GatewayRpc) {}

  /** Get cached session_id, or undefined if not cached. */
  get(sessionKey: string): string | undefined {
    return this.cache.get(sessionKey);
  }

  /** Store a mapping. */
  set(sessionKey: string, sessionId: string): void {
    this.cache.set(sessionKey, sessionId);
  }

  /** Remove a cached mapping. */
  clear(sessionKey: string): void {
    this.cache.delete(sessionKey);
  }

  /**
   * Get cached session_id, or create one via Gateway if missing.
   * Returns the session_id string.
   */
  async getOrCreate(
    sessionKey: string,
    channel: string,
    agent?: string,
  ): Promise<string> {
    const cached = this.cache.get(sessionKey);
    if (cached) return cached;

    const params: Record<string, unknown> = { channel };
    if (agent) params.agent = agent;

    const result = (await this.rpc.request("sessions.create", params)) as {
      id: string;
    };

    this.cache.set(sessionKey, result.id);
    return result.id;
  }
}
