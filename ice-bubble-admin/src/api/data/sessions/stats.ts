/**
 * Stats 端点 — GET /api/stats
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';

export function createStatsRouter(config: SessionsRouterConfig): Router {
  const { repository, startTime } = config;
  const router = Router();

  router.get('/stats', (_req: Request, res: Response) => {
    const stats = repository.getStats();
    const uptime = Math.round((Date.now() - startTime) / (1000 * 60 * 60) * 100) / 100;
    res.json({ ...stats, uptime });
  });

  return router;
}
