/**
 * Data API - 数据管理 REST 接口
 *
 * GET /api/data/sessions
 * GET /api/data/sessions/:key
 * GET /api/data/messages
 * GET /api/data/agents
 * GET /api/data/stats
 */

import { Router, Request, Response } from 'express';
import { DataRepository } from '../storage/data-repository.js';

export function createDataRouter(repository: DataRepository): Router {
  const router = Router();

  /**
   * GET /api/data/stats
   * 获取数据统计
   */
  router.get('/stats', (_req: Request, res: Response) => {
    const stats = repository.getStats();
    res.json(stats);
  });

  /**
   * GET /api/data/sessions
   * 获取 sessions 列表
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const channel = req.query.channel ? String(req.query.channel) : undefined;

    const result = repository.getSessions({ limit, offset, agent_id, channel });
    res.json({
      count: result.sessions.length,
      total: result.total,
      limit,
      offset,
      sessions: result.sessions
    });
  });

  /**
   * GET /api/data/sessions/grouped
   * 获取按 agent 分组的 sessions（用于 Desktop 下拉列表）
   * Query: limitPerAgent - 每个 agent 最多返回的 session 数量，默认 5
   */
  router.get('/sessions/grouped', (req: Request, res: Response) => {
    const limitPerAgent = Math.min(parseInt(String(req.query.limitPerAgent ?? '5')), 20);
    const groups = repository.getGroupedSessions(limitPerAgent);
    res.json({
      count: groups.reduce((sum, g) => sum + g.sessions.length, 0),
      total: groups.reduce((sum, g) => sum + g.totalCount, 0),
      limitPerAgent,
      groups,
    });
  });

  /**
   * GET /api/data/sessions/:key
   * 获取单个 session
   */
  router.get('/sessions/:key', (req: Request, res: Response) => {
    const session = repository.getSession(req.params.key);
    if (!session) {
      res.status(404).json({ error: 'Session not found', key: req.params.key });
      return;
    }
    res.json(session);
  });

  /**
   * GET /api/data/messages
   * 获取 messages 列表
   */
  router.get('/messages', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));
    const session_key = req.query.session_key ? String(req.query.session_key) : undefined;

    const result = repository.getMessages({ limit, offset, session_key });
    res.json({
      count: result.messages.length,
      total: result.total,
      limit,
      offset,
      messages: result.messages
    });
  });

  /**
   * GET /api/data/agents
   * 获取 agents 列表
   */
  router.get('/agents', (_req: Request, res: Response) => {
    const agents = repository.getAgents();
    res.json({
      count: agents.length,
      agents
    });
  });

  return router;
}
