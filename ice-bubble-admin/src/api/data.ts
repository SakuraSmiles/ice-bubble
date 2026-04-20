/**
 * Data API - 数据管理 REST 接口
 *
 * GET /api/data/sessions
 * GET /api/data/sessions/:key
 * GET /api/data/messages
 * GET /api/data/agents
 * GET /api/data/agents/overview   ← Agent 概览（admin 层聚合）
 * GET /api/data/stats
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/index.js';
import { DataRepository } from '../storage/data-repository.js';
import type { AgentOverviewService } from '../data/agent-overview.js';

export interface DataRouterConfig {
  repository: DataRepository;
  /** Agent 概览聚合服务（可选，不提供则 /agents/overview 返回 503） */
  agentOverviewService?: AgentOverviewService;
}

export function createDataRouter(config: DataRouterConfig): Router {
  const { repository, agentOverviewService } = config;
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
   *
   * 获取 agents 列表（含统一状态计算）
   * 状态由 calculateAgentStatus 统一计算（与 /agents/overview 共用同一函数）
   *
   * 若 agentOverviewService 不可用，降级为纯 lastActiveAt 判断
   */
  router.get('/agents', async (_req: Request, res: Response) => {
    try {
      let agents;
      if (agentOverviewService) {
        // 获取完整 agent 列表，再注入 overview 计算的 status
        const fullAgents = repository.getAgents();
        const overviewMap = new Map(
          (await agentOverviewService.getAgentsOverview()).agents.map(a => [a.agent_id, a])
        );
        agents = fullAgents.map(a => {
          const ov = overviewMap.get(a.agent_id);
          return {
            ...a,
            status: ov ? ov.status : '离线',
            latest_message: ov ? ov.latest_message : null,
          };
        });
      } else {
        // 降级：只用 admin_agents 表数据 + lastActiveAt 算 status
        const { calculateAgentStatus } = await import('../data/agent-overview.js');
        agents = repository.getAgents().map(a => ({
          ...a,
          status: calculateAgentStatus(0, a.last_active_at, true),
        }));
      }
      res.json({ count: agents.length, agents });
    } catch (err: any) {
      logger.error('[DataAPI] /agents error:', err);
      res.status(500).json({ error: '获取 agents 失败', code: 'AGENTS_FETCH_FAILED' });
    }
  });

  /**
   * GET /api/data/agents/:id/avatar
   * 获取指定 agent 的头像
   */
  router.get('/agents/:id/avatar', (req: Request, res: Response) => {
    const avatar = repository.getAgentAvatar(req.params.id);
    res.json({ agent_id: req.params.id, avatar });
  });

  /**
   * PUT /api/data/agents/:id/avatar
   * 更新指定 agent 的头像
   */
  router.put('/agents/:id/avatar', (req: Request, res: Response) => {
    const avatar = req.body.avatar ?? null;
    repository.updateAgentAvatar(req.params.id, avatar);
    res.json({ success: true });
  });

    /**
   * GET /api/data/agents/with-activity
   * 批量获取所有 agent 及其活动热力图数据（一次请求）
   * Query: days - 返回最近 N 天的活动数据，默认 90，上限 365
   */
  router.get('/agents/with-activity', (req: Request, res: Response) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '90')), 1), 365);
    const agentsWithActivity = repository.getAgentsWithActivity(days);

    res.json({
      count: agentsWithActivity.length,
      agents: agentsWithActivity
    });
  });

  /**
   * GET /api/data/agents/token-summary
   * 获取指定日期的 token 统计
   * Query: agentId - 可选，不传则返回所有 agent
   * Query: date - 可选，格式 YYYY-MM-DD，不传则返回所有日期
   */
  router.get('/agents/token-summary', (req: Request, res: Response) => {
    const { agentId, date } = req.query as { agentId?: string; date?: string };
    const summary = repository.getTokenSummary(agentId, date);
    // 保持原有日期（getTokenSummary 已返回正确的 date 字段）
    res.json({ summary });
  });

  /**
   * POST /api/data/agents/token-summary/rebuild
   * 重建 token_summary 表（从 admin_messages 全量聚合）
   */
  router.post('/agents/token-summary/rebuild', (_req: Request, res: Response) => {
    try {
      const result = repository.rebuildTokenSummary();
      res.json({ success: true, ...result });
    } catch (error: any) {
      logger.error('[DataAPI] rebuildTokenSummary error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/data/agents/overview
   *
   * Agent 概览：状态、当前任务、今日消息数
   * 由 AgentOverviewService 在 admin 层聚合 collector 原始数据后返回
   * 注意：此路由必须放在 /agents/:id/* 之前，避免被 :id 参数截获
   */
  router.get('/agents/overview', async (_req: Request, res: Response) => {
    if (!agentOverviewService) {
      res.status(503).json({ error: 'Agent 概览服务未初始化', code: 'SERVICE_NOT_INITIALIZED' });
      return;
    }
    try {
      const result = await agentOverviewService.getAgentsOverview();
      res.json(result);
    } catch (err: any) {
      logger.error('[DataAPI] agents/overview error:', err);
      res.status(500).json({ error: '获取 Agent 概览失败', code: 'AGENTS_OVERVIEW_FAILED' });
    }
  });

  /**
   * GET /api/data/agents/:id/activity
   * 获取指定 agent 的活动热力图数据
   */
  router.get('/agents/:id/activity', (req: Request, res: Response) => {
    const id = req.params.id;
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '90')), 1), 365);
    const activity = repository.getAgentActivity(id, days);
    res.json({ agent_id: id, activity });
  });

  return router;
}
