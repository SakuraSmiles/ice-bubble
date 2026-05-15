/**
 * Data API - 数据管理 REST 接口
 *
 * GET /api/sessions
 * GET /api/sessions/:key
 * GET /api/messages
 * GET /api/messages/timeline  ← 群聊风格消息时间线
 * GET /api/agents
 * GET /api/agents/overview   ← Agent 概览（admin 层聚合）
 * GET /api/stats
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/index.js';
import { DataRepository } from '../storage/data-repository.js';
import type { AgentOverviewService } from '../data/agent-overview.js';
import { TaskEnhancementStatus, normalizeAgentStatus, type TaskEnhancement, type AgentStatus } from '../data/agent-overview.js';

import type { Database } from 'better-sqlite3';
import type { GatewayProxy } from '../gateway/index.js';

export interface DataRouterConfig {
  repository: DataRepository;
  /** Admin 数据库实例 */
  db: Database;
  /** Agent 概览聚合服务（可选，不提供则 /agents/overview 返回 503） */
  agentOverviewService?: AgentOverviewService;
  /** Gateway 代理（可选，用于结合实时 session 状态判断 agent 工作状态） */
  gatewayProxy?: GatewayProxy | null;
}

export function createDataRouter(config: DataRouterConfig): Router {
  const { repository, db, agentOverviewService } = config;
  const router = Router();

  /**
   * GET /api/stats
   * 获取数据统计
   */
  router.get('/stats', (_req: Request, res: Response) => {
    const stats = repository.getStats();
    res.json(stats);
  });

  /**
   * GET /api/sessions
   * 获取 sessions 列表
   */
  router.get('/sessions', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const channel = req.query.channel ? String(req.query.channel) : undefined;

    const result = repository.getSessions({ limit, offset, agent_id, channel });

    // Build agent name lookup map
    const agents = repository.getAgents();
    const agentMap = new Map(agents.map(a => [a.agent_id, a]));

    // Enrich sessions with agent_name, avatar and last_message
    const sessionKeys = result.sessions.map(s => s.session_key);
    const lastMessageMap = new Map<string, string>();
    if (sessionKeys.length > 0) {
      // Direct DB access for batch last_message query
      try {
        const db = (repository as any).db;
        if (db) {
          const rows = db.prepare(`
            SELECT m.session_key, substr(m.content, 1, 60) as content
            FROM admin_messages m
            INNER JOIN (
              SELECT session_key, MAX(timestamp) as max_ts
              FROM admin_messages
              WHERE session_key IN (${sessionKeys.map(() => '?').join(',')})
              GROUP BY session_key
            ) latest ON m.session_key = latest.session_key AND m.timestamp = latest.max_ts
          `).all(...sessionKeys) as { session_key: string; content: string }[];
          for (const row of rows) {
            lastMessageMap.set(row.session_key, row.content);
          }
        }
      } catch (e) {
        // Non-critical: last_message enrichment can fail silently
      }
    }

    const sessions = result.sessions.map(s => {
      const agent = agentMap.get(s.agent_id ?? '');
      return {
        ...s,
        agent_name: agent?.agent_name ?? null,
        avatar: agent?.avatar ?? null,
        last_message: lastMessageMap.get(s.session_key) ?? null,
      };
    });

    res.json({
      count: sessions.length,
      total: result.total,
      limit,
      offset,
      sessions,
    });
  });

  /**
   * GET /api/sessions/grouped
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
   * GET /api/sessions/:key
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
   * GET /api/messages
   * 获取 messages 列表（支持 ?archived=true 查询归档数据）
   *
   * Query params:
   *   - session_key: 可选，按 session 筛选
   *   - limit: 每页数量（默认 50，最大 200）
   *   - offset: 分页偏移
   *   - archived: 可选，"true" 时查询归档表
   */
  router.get('/messages', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const offset = parseInt(String(req.query.offset ?? '0'));
    const session_key = req.query.session_key ? String(req.query.session_key) : undefined;
    const archived = req.query.archived === 'true';

    if (archived) {
      const result = repository.getArchivedMessages({ limit, offset, session_key });
      res.json({
        count: result.messages.length,
        total: result.total,
        limit,
        offset,
        messages: result.messages,
        archived: true
      });
      return;
    }

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
   * GET /api/messages/timeline
   * 获取群聊风格的消息时间线
   *
   * Query params:
   *   - limit: 每页数量（默认50，最大200）
   *   - before: cursor 时间戳，返回此时间之前的消息（翻页）
   *   - since: 时间戳，返回此时间之后的消息（增量轮询）
   *   - agent_ids: 逗号分隔的 agent_id 列表
   *   - message_types: 逗号分隔的消息类型（默认 user,agent,tool）
   *   - search: 内容关键词搜索
   *   - exclude_system_noise: 是否过滤系统噪音
   *   - exclude_cron: 是否过滤定时任务
   */
  router.get('/messages/timeline', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
    const before = req.query.before ? String(req.query.before) : undefined;
    const since = req.query.since ? String(req.query.since) : undefined;
    const agentIdsRaw = req.query.agent_ids ? String(req.query.agent_ids) : undefined;
    const agent_ids = agentIdsRaw
      ? agentIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const message_types = req.query.message_types ? String(req.query.message_types) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const session_key = req.query.session_key ? String(req.query.session_key) : undefined;
    const exclude_system_noise = req.query.exclude_system_noise === 'true' || req.query.exclude_system_noise === '1';
    const exclude_cron = req.query.exclude_cron === 'true' || req.query.exclude_cron === '1';

    const result = repository.getMessagesTimeline({
      limit,
      before,
      since,
      agent_ids,
      session_key,
      message_types,
      search,
      exclude_system_noise,
      exclude_cron,
    });
    const systemStatus = repository.getSystemStatus();
    res.json({
      messages: result.messages,
      has_more: result.has_more,
      pagination: result.pagination,
      meta: { ...result.meta, system_status: systemStatus },
    });
  });

  router.post('/messages/deduplicate', (_req: Request, res: Response) => {
    try {
      const deleted = repository.deduplicateAdminMessages();
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/agents
   *
   * 获取 agents 列表（含统一状态计算）
   * 状态由 calculateAgentStatus 统一计算（与 /agents/overview 共用同一函数）
   * 新增 openclaw_status（标准化状态）和 task_enhancement（任务增强）
   *
   * 若 agentOverviewService 不可用，降级为纯 lastActiveAt 判断
   *
   * 状态由 calculateAgentStatus 统一计算（基于 last_active_at 的 2 分钟活跃窗口）
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
        // 同步获取所有 agent 的待办任务数
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
        // 降级：只用 admin_agents 表数据 + lastActiveAt 算 status
        const { calculateAgentStatus } = await import('../data/agent-overview.js');
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
    // 保持原有日期（getTokenSummary 已返回正确的 date 字段）
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
 * @param pendingCount getAgentPendingCount 的返回值
 */
function buildTaskEnhancement(pendingCount: number): TaskEnhancement {
  return {
    status: pendingCount > 0 ? TaskEnhancementStatus.working : TaskEnhancementStatus.idle,
    pending_count: pendingCount,
    source: 'available',
  };
}


