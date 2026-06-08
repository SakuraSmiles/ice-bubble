/**
 * Unified Sessions API
 *
 * GET /api/sessions/unified
 *
 * Merges Gateway real-time session data with Admin SQLite enrichment
 * (agent_name, avatar, last_message, message_count) via agentId as the join key.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/index.js';
import type { DataRepository } from '../storage/data-repository.js';
import type { SessionCacheManager } from '../services/session-cache.js';

export interface SessionsUnifiedRouterConfig {
  sessionCache: SessionCacheManager;
  repository: DataRepository;
}

export function createSessionsUnifiedRouter(config: SessionsUnifiedRouterConfig): Router {
  const { sessionCache, repository } = config;
  const router = Router();

  router.get('/sessions/unified', async (req: Request, res: Response) => {
    const t0 = Date.now();
    try {
      // Query params
      const filterAgentId = req.query.agentId ? String(req.query.agentId) : undefined;
      const filterSessionKey = req.query.sessionKey ? String(req.query.sessionKey) : undefined;
      const filterStatus = req.query.status ? String(req.query.status) : undefined;
      const excludeSubagents = req.query.excludeSubagents === 'true';
      const limit = Math.min(parseInt(String(req.query.limit ?? '200')), 1000);
      const offset = parseInt(String(req.query.offset ?? '0'));

      // 1. Read from memory cache (refreshed by SessionCacheManager in background)
      let gatewaySessions: Array<Record<string, unknown>> = [];
      let gatewayFailed = false;
      if (sessionCache.isHealthy()) {
        gatewaySessions = sessionCache.getSessions();
      } else {
        gatewayFailed = true;
        logger.warn('[SessionsUnified] Cache not healthy, degrading to Admin-only data');
      }

      // 2. Build agentId maps from Admin SQLite
      const t2 = Date.now();
      const agentsMap = repository.getAgentsMap();
      const t2a = Date.now();
      const lastMsgMap = repository.getSessionLastMessageMap();
      const t2b = Date.now();
      const firstMsgMap = repository.getSessionFirstMessageMap();
      const t2c = Date.now();
      logger.info(`[SessionsUnified][perf] SQLite maps: agents=${t2a-t2}ms, lastMsg=${t2b-t2a}ms, firstMsg=${t2c-t2b}ms`);

      // 3. Pre-build gateway-key → admin-key mapping (pure in-memory, avoids N SQLite queries)
      const t3 = Date.now();
      const allAdminKeys = new Set([...lastMsgMap.keys(), ...firstMsgMap.keys()]);
      const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

      // UUID index: admin keys containing a given UUID
      const uuidToAdmin = new Map<string, string[]>();
      for (const ak of allAdminKeys) {
        const m = ak.match(uuidRe);
        if (m) {
          let arr = uuidToAdmin.get(m[1]);
          if (!arr) { arr = []; uuidToAdmin.set(m[1], arr); }
          arr.push(ak);
        }
      }

      // Agent-id index: admin keys grouped by agentId (excluding trajectory/checkpoint)
      const agentToAdmin = new Map<string, string[]>();
      for (const ak of allAdminKeys) {
        if (ak.endsWith('.trajectory') || ak.endsWith('.checkpoint')) continue;
        const p = ak.split(':');
        const aid = p.length >= 2 ? p[1] : '';
        if (!aid) continue;
        let arr = agentToAdmin.get(aid);
        if (!arr) { arr = []; agentToAdmin.set(aid, arr); }
        arr.push(ak);
      }

      const isValidAdminKey = (k: string) => !k.endsWith('.trajectory') && !k.endsWith('.checkpoint');

      const gwKeyToAdminKeys = new Map<string, string[]>();
      for (const gw of gatewaySessions) {
        const key = String(gw.key ?? '');

        // Direct match
        if (allAdminKeys.has(key)) {
          gwKeyToAdminKeys.set(key, [key]);
          continue;
        }

        // UUID match
        const um = key.match(uuidRe);
        if (um) {
          const candidates = uuidToAdmin.get(um[1]);
          if (candidates) {
            gwKeyToAdminKeys.set(key, candidates.filter(isValidAdminKey));
            continue;
          }
        }

        // Agent fallback (non-subagent only)
        const parts = key.split(':');
        const agentId = parts.length >= 2 ? parts[1] : '';
        if (agentId && !key.includes(':subagent:')) {
          const keys = agentToAdmin.get(agentId);
          if (keys && keys.length > 0) {
            const webchat = keys.find(k => k.includes(':webchat:')) ?? keys[0];
            gwKeyToAdminKeys.set(key, [webchat]);
            continue;
          }
        }

        gwKeyToAdminKeys.set(key, []);
      }

      // 3b. Merge & transform
      const t3b = Date.now();
      logger.info(`[SessionsUnified][perf] Key mapping build: ${t3b-t3}ms`);
      let sessions = gatewaySessions.map((gw) => {
        const key = String(gw.key ?? '');
        // Parse agentId from gateway key format: agent:{agentId}:{slug}
        const parts = key.split(':');
        const agentId = parts.length >= 2 ? parts[1] : '';

        const agentInfo = agentsMap.get(agentId);

        // Resolve Gateway key to SQLite key(s) for message data lookup (pre-built map)
        let lastMsg: { last_message: string | null; message_count: number } | undefined;
        const resolvedKeys = gwKeyToAdminKeys.get(key) ?? [];
        for (const rk of resolvedKeys) {
          if (lastMsgMap.has(rk) && isValidAdminKey(rk)) {
            lastMsg = lastMsgMap.get(rk);
            break;
          }
        }

        // Convert ms timestamps to ISO 8601
        const toISO = (v: unknown): string | null => {
          if (v == null) return null;
          const n = Number(v);
          if (!Number.isFinite(n) || n === 0) return null;
          // If already looks like ISO string, return as-is
          if (typeof v === 'string' && v.includes('T')) return v;
          return new Date(n).toISOString();
        };

        // Resolve first_message
        let firstMsg: { first_message: string | null } | undefined;
        for (const rk of resolvedKeys) {
          if (firstMsgMap.has(rk) && isValidAdminKey(rk)) {
            firstMsg = firstMsgMap.get(rk);
            break;
          }
        }

        return {
          session_key: key,
          agent_id: agentId,
          agent_name: agentInfo?.agent_name ?? null,
          avatar: agentInfo?.avatar ?? null,
          label: gw.label ?? null,
          channel: gw.channel ?? null,
          message_count: lastMsg?.message_count ?? 0,
          first_message: firstMsg?.first_message ?? null,
          last_message: lastMsg?.last_message ?? null,
          last_message_at: toISO(gw.last_message_at) ?? toISO(gw.updated_at),
          first_message_at: toISO(gw.first_message_at) ?? toISO(gw.created_at),
          session_status: gw.session_status ?? gw.status ?? null,
          model: gw.model ?? null,
          model_provider: gw.model_provider ?? null,
          spawned_by: gw.spawned_by ?? null,
          spawn_depth: gw.spawn_depth ?? null,
          input_tokens: gw.input_tokens ?? null,
          output_tokens: gw.output_tokens ?? null,
          total_tokens: gw.total_tokens ?? null,
          runtime_ms: gw.runtime_ms ?? null,
          child_sessions: gw.child_sessions ?? null,
          updated_at: toISO(gw.updated_at),
          created_at: toISO(gw.created_at),
        };
      });

      // 3.5. Add Admin-only sessions
      const t35 = Date.now();
      logger.info(`[SessionsUnified][perf] Gateway merge: ${t35-t3b}ms, sessions=${sessions.length}`);
      const gwKeys = new Set(sessions.map(s => s.session_key));
      const adminKeys = filterAgentId
        ? repository.getAdminSessionsForAgent(filterAgentId)
        : repository.getAllAdminSessions();
      const t35a = Date.now();
      const sessionTsMap = repository.getSessionTimestamps();
      const t35b = Date.now();
      logger.info(`[SessionsUnified][perf] Admin-only: adminKeys=${adminKeys.length}, adminSessions=${t35a-t35}ms, timestamps=${t35b-t35a}ms`);
      for (const ak of adminKeys) {
        if (gwKeys.has(ak)) continue;
        const lm = lastMsgMap.get(ak);
        const ts = sessionTsMap.get(ak);
        const parts = ak.split(':');
        const agentId = parts.length >= 2 ? parts[1] : '';
        const agentInfo = agentsMap.get(agentId);
        sessions.push({
          session_key: ak,
          agent_id: agentId,
          agent_name: agentInfo?.agent_name ?? null,
          avatar: agentInfo?.avatar ?? null,
          label: null,
          channel: null,
          message_count: lm?.message_count ?? 0,
          first_message: firstMsgMap.get(ak)?.first_message ?? null,
          last_message: lm?.last_message ?? null,
          last_message_at: ts?.last_message_at ?? null,
          first_message_at: ts?.created_at ?? null,
          session_status: null,
          model: null,
          model_provider: null,
          spawned_by: null,
          spawn_depth: null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          runtime_ms: null,
          child_sessions: null,
          updated_at: ts?.last_message_at ?? ts?.created_at ?? null,
          created_at: ts?.created_at ?? null,
        });
      }

      // 4. Apply filters
      const t4 = Date.now();
      logger.info(`[SessionsUnified][perf] Admin-only loop: ${t4-t35b}ms, total sessions=${sessions.length}`);
      if (filterSessionKey) {
        // sessionKey filter: match session_key directly or via resolved keys
        // For filterSessionKey, also build mapping (or fall back to in-memory lookup)
        let resolvedFilterKeys: string[] = [];
        if (allAdminKeys.has(filterSessionKey)) {
          resolvedFilterKeys = [filterSessionKey];
        } else {
          // Try UUID match
          const um = filterSessionKey.match(uuidRe);
          if (um) {
            const c = uuidToAdmin.get(um[1]);
            if (c) resolvedFilterKeys = c.filter(isValidAdminKey);
          }
          // Fall back to DB only if in-memory failed (rare path)
          if (resolvedFilterKeys.length === 0) {
            resolvedFilterKeys = repository.resolveSessionKey(filterSessionKey);
          }
        }
        const matchKeys = new Set([filterSessionKey, ...resolvedFilterKeys]);
        sessions = sessions.filter((s) => matchKeys.has(s.session_key));
      }
      if (filterAgentId) {
        sessions = sessions.filter((s) => s.agent_id === filterAgentId);
      }
      if (filterStatus) {
        sessions = sessions.filter((s) => s.session_status === filterStatus);
      }
      // Exclude subagent sessions (session_key contains ':subagent:')
      if (excludeSubagents) {
        sessions = sessions.filter((s) => !s.session_key.includes(':subagent:'));
      }

      // 5. Sort:
      const t5 = Date.now();
      logger.info(`[SessionsUnified][perf] Filters: ${t5-t4}ms, after filter=${sessions.length}`);
      //    Sessions with messages (message_count > 0) rank above empty ones.
      sessions.sort((a, b) => {
        // Primary: last_message_at DESC (nulls last)
        const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        if (ta !== tb) return tb - ta;
        // Secondary: sessions with messages first
        const hasA = (a.message_count ?? 0) > 0 ? 1 : 0;
        const hasB = (b.message_count ?? 0) > 0 ? 1 : 0;
        if (hasA !== hasB) return hasB - hasA;
        // Tertiary: updated_at DESC
        const ua = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const ub = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return ub - ua;
      });

      // 5.5. Pin main session (agent:{agentId}:main) to the top of the sorted list.
      //      This prevents the main session from being pushed out by newer direct sessions.
      const mainKeyPattern = /^agent:[^:]+:main$/;
      const mainIdx = sessions.findIndex((s) => mainKeyPattern.test(s.session_key));
      if (mainIdx > 0) {
        const [mainSession] = sessions.splice(mainIdx, 1);
        sessions.unshift(mainSession);
      }

      const t6 = Date.now();
      logger.info(`[SessionsUnified][perf] Sort: ${t6-t5}ms`);
      const total = sessions.length;

      // 6. Paginate
      sessions = sessions.slice(offset, offset + limit);
      const t7 = Date.now();
      logger.info(`[SessionsUnified][perf] Paginate+serialize: ${t7-t6}ms, returning=${sessions.length}`);

      logger.info(`[SessionsUnified][perf] TOTAL: ${t7-t0}ms`);
      res.json({ sessions, total, ...(gatewayFailed ? { _degraded: true } : {}) });
    } catch (err) {
      logger.error('[SessionsUnified] Error:', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
