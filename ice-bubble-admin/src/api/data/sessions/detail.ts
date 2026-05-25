/**
 * Detail 端点 — GET /sessions/:key
 */

import { Router, Request, Response } from 'express';
import type { SessionsRouterConfig } from './index.js';

export function createDetailRouter(config: SessionsRouterConfig): Router {
  const { repository } = config;
  const router = Router();

  router.get('/sessions/:key', (req: Request, res: Response) => {
    const session = repository.getSession(req.params.key);
    if (!session) {
      res.status(404).json({ error: 'Session not found', key: req.params.key });
      return;
    }
    res.json(session);
  });

  return router;
}
