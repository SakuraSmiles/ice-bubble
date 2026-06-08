/**
 * Data API - 数据管理 REST 接口
 *
 * GET /api/stats
 * GET /api/sessions
 * GET /api/sessions/:key
 * GET /api/messages
 * GET /api/messages/timeline  ← 群聊风格消息时间线
 * GET /api/agents
 * GET /api/agents/overview   ← Agent 概览（admin 层聚合）
 */

import { Router } from 'express';
import { DataRepository } from '../storage/data-repository.js';
import type { AgentOverviewService } from '../data/agent-overview.js';
import type { Database } from 'better-sqlite3';
import type { GatewayProxy } from '../gateway/index.js';
import { createSessionsRouter } from './data/sessions/index.js';
import { createMessagesRouter } from './data/messages.js';
import { createAgentsRouter } from './data/agents.js';
import { createSyncRouter } from './data/sync.js';

/** Admin 服务启动时间（模块加载时刻） */
const startTime = Date.now();

export interface DataRouterConfig {
  repository: DataRepository;
  /** Admin 数据库实例 */
  db: Database;
  /** Agent 概览聚合服务（可选，不提供则 /agents/overview 返回 503） */
  agentOverviewService?: AgentOverviewService;
  /** Gateway 代理（可选） */
  gatewayProxy?: GatewayProxy | null;
  /** 数据同步实例数组（可选，用于 /api/sync/progress 返回游标异常状态） */
  dataSyncs?: import('../data/data-sync.js').DataSync[];
}

/**
 * Data API 聚合门面
 * 将所有数据域路由模块化拆分至 api/data/ 子路由
 */
export function createDataRouter(config: DataRouterConfig): Router {
  const router = Router();

  // Session 域：/stats, /sessions/*
  router.use(createSessionsRouter({ ...config, startTime }));

  // Message 域：/messages/*
  router.use(createMessagesRouter(config));

  // Agent 域：/agents/*
  router.use(createAgentsRouter(config));

  // Sync 域：/sync/*
  router.use(createSyncRouter({ ...config, dataSyncs: config.dataSyncs }));

  return router;
}

// Re-export for use by sub-routers
export { createSessionsRouter } from './data/sessions/index.js';
export { createMessagesRouter } from './data/messages.js';
export { createAgentsRouter } from './data/agents.js';
