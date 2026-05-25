/**
 * Message 域路由
 *
 * GET  /api/messages
 * GET  /api/messages/timeline
 * POST /api/messages/deduplicate
 */

import { Router, Request, Response } from 'express';
import type { DataRouterConfig } from '../data.js';

/**
 * 创建 Message 域子路由
 */
export function createMessagesRouter(config: DataRouterConfig): Router {
  const { repository } = config;
  const router = Router();

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

  /**
   * POST /api/messages/deduplicate
   * 消息去重
   */
  router.post('/messages/deduplicate', (_req: Request, res: Response) => {
    try {
      const deleted = repository.deduplicateAdminMessages();
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
