/**
 * Agent 域路由
 *
 * GET  /api/agents
 * GET  /api/agents/:id/avatar
 * PUT  /api/agents/:id/avatar
 * GET  /api/agents/with-activity
 * GET  /api/agents/token-summary
 * POST /api/agents/token-summary/rebuild
 * POST /api/agents/activity/rebuild
 * GET  /api/agents/overview
 * GET  /api/agents/:id/activity
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/index.js';
import type { DataRouterConfig } from '../data.js';
import { TaskEnhancementStatus, normalizeAgentStatus, type TaskEnhancement, type AgentStatus } from '../../data/agent-overview.js';
import type { Database } from 'better-sqlite3';

// ============================================================================
// Task 模块相关辅助函数
// ============================================================================

/**
 * 获取指定 agent 的待办任务数
 * admin_tasks 表已删除（v19），subagent 任务改用 /api/subagent-tasks 查询
 * 此处保留接口兼容性，始终返回 0
 */
function getAgentPendingCount(_db: Database, _agentId: string): number {
  return 0;
}

/**
 * 构建 TaskEnhancement 对象
 */
function buildTaskEnhancement(pendingCount: number): TaskEnhancement {
  return {
    status: pendingCount > 0 ? TaskEnhancementStatus.working : TaskEnhancementStatus.idle,
    pending_count: pendingCount,
    source: 'available',
  };
}

/**
 * 创建 Agent 域子路由
 */
export function createAgentsRouter(config: DataRouterConfig): Router {
  const { repository, db, agentOverviewService } = config;
  const router = Router();

  /**
   * GET /api/agents
   *
   * 获取 agents 列表（含统一状态计算）
   * 状态由 calculateAgentStatus 统一计算（与 /agents/overview 共用同一函数）
   */
  router.get('/agents', async (_req: Request, res: Response) => {
    try {
      let agents;
      if (agentOverviewService) {
        const fullAgents = repository.getAgents();
        const overviewMap = new Map(
          (await agentOverviewService.getAgentsOverview()).agents.map(a => [a.agent_id, a])
        );
        const pendingCounts = new Map(fullAgents.map(a =>
          [a.agent_id, getAgentPendingCount(db, a.agent_id)] as [string, number]
        ));

        agents = fullAgents.map(a => {
          const ov = overviewMap.get(a.agent_id);
          const calculatedStatus: AgentStatus = ov ? ov.status : '离线';
          const pendingCount = pendingCounts.get(a.agent_id) ?? 0;
          return {
            ...a,
            status: calculatedStatus,
            openclaw_status: normalizeAgentStatus(calculatedStatus),
            latest_message: ov ? ov.latest_message : null,
            task_enhancement: buildTaskEnhancement(pendingCount),
          };
        });
      } else {
        const { calculateAgentStatus } = await import('../../data/agent-overview.js');
        const fullAgents = repository.getAgents();
        const pendingCounts = new Map(fullAgents.map(a =>
          [a.agent_id, getAgentPendingCount(db, a.agent_id)] as [string, number]
        ));

        agents = fullAgents.map(a => {
          const calculatedStatus = calculateAgentStatus(0, a.last_active_at, true);
          const pendingCount = pendingCounts.get(a.agent_id) ?? 0;
          return {
            ...a,
            status: calculatedStatus,
            openclaw_status: normalizeAgentStatus(calculatedStatus),
            task_enhancement: buildTaskEnhancement(pendingCount),
          };
        });
      }
      res.json({ count: agents.length, agents });
    } catch (err: any) {
      logger.error('[DataAPI] /agents error:', err);
      res.status(500).json({ error: '获取 agents 失败', code: 'AGENTS_FETCH_FAILED' });
    }
  });

  /**
   * GET /api/agents/:id/avatar
   * 获取指定 agent 的头像
   */
  router.get('/agents/:id/avatar', (req: Request, res: Response) => {
    const avatar = repository.getAgentAvatar(req.params.id);
    res.json({ agent_id: req.params.id, avatar });
  });

  /**
   * PUT /api/agents/:id/avatar
   * 更新指定 agent 的头像
   */
  router.put('/agents/:id/avatar', (req: Request, res: Response) => {
    const avatar = req.body.avatar ?? null;
    repository.updateAgentAvatar(req.params.id, avatar);
    res.json({ success: true });
  });

  /**
   * GET /api/agents/with-activity
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
   * GET /api/agents/token-summary
   * 获取指定日期的 token 统计
   * Query: agentId - 可选，不传则返回所有 agent
   * Query: date - 可选，格式 YYYY-MM-DD，不传则返回所有日期
   */
  router.get('/agents/token-summary', (req: Request, res: Response) => {
    const { agentId, date } = req.query as { agentId?: string; date?: string };
    const summary = repository.getTokenSummary(agentId, date);
    res.json({ summary });
  });

  /**
   * POST /api/agents/token-summary/rebuild
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
   * POST /api/agents/activity/rebuild
   * 重建 agent_activity_daily 表（从 admin_messages 全量聚合）
   */
  router.post('/agents/activity/rebuild', (_req: Request, res: Response) => {
    try {
      const result = repository.rebuildAgentActivity();
      if (result.error) {
        res.status(500).json({ success: false, error: result.error });
      } else {
        res.json({ success: true, count: result.count });
      }
    } catch (error: any) {
      logger.error('[DataAPI] rebuildAgentActivity error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/agents/overview
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
   * GET /api/agents/:id/activity
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
