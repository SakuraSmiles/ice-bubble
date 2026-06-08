/**
 * SessionCacheManager
 *
 * In-memory cache for Gateway sessions.list responses.
 *
 * - Initial fetch on start()
 * - Refreshes every 30s using "schedule-next-after-complete" pattern (no setInterval overlap)
 * - Stores raw Gateway response; merge/filter/paginate happens at request time
 * - Degrades to empty array when Gateway is unavailable
 */

import { logger } from '../utils/index.js';
import type { GatewayProxy } from '../gateway/index.js';

const REFRESH_INTERVAL_MS = 30_000;

export interface SessionCacheManager {
  /** Initialize the cache: perform first fetch and start refresh loop. */
  start(): void;
  /** Stop the refresh loop. */
  stop(): void;
  /**
   * Read the cached sessions array (raw Gateway format).
   * Returns empty array if cache not yet populated or Gateway unavailable.
   */
  getSessions(): Array<Record<string, unknown>>;
  /** Whether the last refresh succeeded. */
  isHealthy(): boolean;
}

export function createSessionCacheManager(proxy: GatewayProxy): SessionCacheManager {
  let sessions: Array<Record<string, unknown>> = [];
  let healthy = false;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    if (stopped) return;
    try {
      const result = await proxy.request<{ sessions: Array<Record<string, unknown>> }>('sessions.list');
      sessions = result?.sessions ?? [];
      healthy = true;
      logger.debug(`[SessionCache] Refreshed: ${sessions.length} sessions`);
    } catch (err) {
      healthy = false;
      logger.warn('[SessionCache] Gateway fetch failed, keeping stale cache', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Schedule next refresh only after this one completes (no overlap)
    if (!stopped) {
      refreshTimer = setTimeout(refresh, REFRESH_INTERVAL_MS);
    }
  }

  return {
    start() {
      stopped = false;
      // Initial fetch
      refresh();
    },

    stop() {
      stopped = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },

    getSessions() {
      return sessions;
    },

    isHealthy() {
      return healthy;
    },
  };
}
