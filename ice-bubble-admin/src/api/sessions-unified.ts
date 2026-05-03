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
import type { GatewayProxy } from '../gateway/index.js';

export interface SessionsUnifiedRouterConfig {
  proxy: GatewayProxy;
  repository: DataRepository;
}

export function createSessionsUnifiedRouter(config: SessionsUnifiedRouterConfig): Router {
  const { proxy, repository } = config;
  const router = Router();

  router.get('/sessions/unified', async (req: Request, res: Response) => {
    try {
      // Query params
      const filterAgentId = req.query.agentId ? String(req.query.agentId) : undefined;
      const filterStatus = req.query.status ? String(req.query.status) : undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? '200')), 1000);
      const offset = parseInt(String(req.query.offset ?? '0'));

      // 1. Fetch from Gateway
      let gatewaySessions: Array<Record<string, unknown>>;
      try {
        const result = await proxy.request<{ sessions: Array<Record<string, unknown>> }>('sessions.list');
        gatewaySessions = result?.sessions ?? [];
      } catch (gwErr) {
        logger.warn('[SessionsUnified] Gateway request failed, returning 502', {
          error: gwErr instanceof Error ? gwErr.message : String(gwErr),
        });
        res.status(502).json({
          error: 'Gateway unavailable',
          detail: gwErr instanceof Error ? gwErr.message : String(gwErr),
        });
        return;
      }

      // 2. Build agentId maps from Admin SQLite
      const agentsMap = repository.getAgentsMap();
      const lastMsgMap = repository.getSessionLastMessageMap();

      // 3. Merge & transform
      let sessions = gatewaySessions.map((gw) => {
        const key = String(gw.key ?? '');
        // Parse agentId from gateway key format: agent:{agentId}:{slug}
        const parts = key.split(':');
        const agentId = parts.length >= 2 ? parts[1] : '';

        const agentInfo = agentsMap.get(agentId);

        // Resolve Gateway key to SQLite key(s) for message data lookup
        let lastMsg: { last_message: string | null; message_count: number } | undefined;
        const resolvedKeys = repository.resolveSessionKey(key);
        for (const rk of resolvedKeys) {
          if (lastMsgMap.has(rk) && !rk.includes('.trajectory') && !rk.includes('.checkpoint')) {
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

        return {
          session_key: key,
          agent_id: agentId,
          agent_name: agentInfo?.agent_name ?? null,
          avatar: agentInfo?.avatar ?? null,
          label: gw.label ?? null,
          channel: gw.channel ?? null,
          message_count: lastMsg?.message_count ?? gw.message_count ?? 0,
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

      // 4. Apply filters
      if (filterAgentId) {
        sessions = sessions.filter((s) => s.agent_id === filterAgentId);
      }
      if (filterStatus) {
        sessions = sessions.filter((s) => s.session_status === filterStatus);
      }

      // 5. Sort by updated_at DESC
      sessions.sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });

      const total = sessions.length;

      // 6. Paginate
      sessions = sessions.slice(offset, offset + limit);

      res.json({ sessions, total });
    } catch (err) {
      logger.error('[SessionsUnified] Error:', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
