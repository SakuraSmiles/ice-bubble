/**
 * Session 域路由 — 聚合注册
 *
 * GET  /api/stats
 * GET  /api/sessions
 * GET  /api/sessions/timeline
 * GET  /api/sessions/flows
 * GET  /api/sessions/grouped
 * GET  /api/sessions/pending-summary
 * PUT  /api/sessions/summary
 * GET  /api/sessions/:key
 */

import { Router } from 'express';
import type { DataRouterConfig } from '../../data.js';

export interface SessionsRouterConfig extends DataRouterConfig {
  startTime: number;
}

import { createStatsRouter } from './stats.js';
import { createListRouter } from './list.js';
import { createTimelineRouter } from './timeline.js';
import { createFlowsRouter } from './flows.js';
import { createSummaryRouter } from './summary.js';
import { createDetailRouter } from './detail.js';
import { createChainRouter } from './chain.js';

export function createSessionsRouter(config: SessionsRouterConfig): Router {
  const router = Router();

  router.use(createStatsRouter(config));
  router.use(createListRouter(config));
  router.use(createTimelineRouter(config));
  router.use(createFlowsRouter(config));
  router.use(createSummaryRouter(config));
  router.use(createChainRouter(config));
  router.use(createDetailRouter(config));

  return router;
}
