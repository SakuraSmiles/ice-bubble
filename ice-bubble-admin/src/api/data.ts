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

/** Admin 服务启动时间（模块加载时刻） */
const startTime = Date.now();

export interface DataRouterConfig {
  repository: DataRepository;
  /** Admin 数据库实例 */
  db: Database;
  /** Agent 概览聚合服务（可选，不提供则 /agents/overview 返回 503） */
  agentOverviewService?: AgentOverviewService;
  /** Gateway 代理（可选，用于结合实时 session 状态判断 agent 工作状态） */
  gatewayProxy?: GatewayProxy | null;
}

// ============================================================================
// 分段摘要算法
// ============================================================================

/**
 * 将 ISO UTC 时间戳转为北京时间 HH:MM
 */
function toBeijingTime(isoTimestamp: string): string {
  const dt = new Date(isoTimestamp);
  const beijing = new Date(dt.getTime() + 8 * 60 * 60 * 1000);
  return `${String(beijing.getHours()).padStart(2, '0')}:${String(beijing.getMinutes()).padStart(2, '0')}`;
}

interface RawMessage {
  id: number;
  type: string;
  content: string | null;
  timestamp: string;
  beijing_time?: string;
}

interface Segment {
  index: number;
  from: string;
  to: string;
  messages?: RawMessage[];
  needs_regenerate?: boolean;
  text?: string;
  existing_text?: string;
}

/**
 * 分段规则常量
 */
const SEG_RULES = {
  idleThresholdMs: 2 * 60 * 60 * 1000,      // 2 小时空闲
  minSegmentDurationMs: 15 * 60 * 1000,      // 最小段 15 分钟
  maxMessagesPerSegment: 80,
  maxSegmentDurationMs: 4 * 60 * 60 * 1000, // 最大段 4 小时
} as const;

/**
 * 分段算法：将消息数组按规则切分为段
 * 边界优先在 user 消息处切割
 */
function segmentMessages(messages: RawMessage[]): Segment[] {
  if (messages.length === 0) return [];

  const segments: Segment[] = [];
  let current: RawMessage[] = [];
  let segStartTs: number | null = null;
  let lastUserTs: number | null = null;

  function pushSegment() {
    if (current.length === 0) return;
    const from = toBeijingTime(current[0].timestamp);
    const to = toBeijingTime(current[current.length - 1].timestamp);
    segments.push({
      index: segments.length,
      from,
      to,
      messages: [...current],
    });
    current = [];
    segStartTs = null;
    lastUserTs = null;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTs = new Date(msg.timestamp).getTime();

    if (msg.type !== 'user') {
      current.push(msg);
      continue;
    }

    // 非首条 user 消息 → 判断是否分段
    if (segStartTs !== null) {
      const timeSinceSegStart = msgTs - segStartTs!;
      const timeSinceLastUser = msgTs - lastUserTs!;
      let shouldSplit = false;

      // 规则 1: 空闲 > 2h + 规则 2: 最小段时长 >= 15min
      if (timeSinceLastUser > SEG_RULES.idleThresholdMs && timeSinceSegStart >= SEG_RULES.minSegmentDurationMs) {
        shouldSplit = true;
      }
      // 规则 3: 容量超限
      if (current.length >= SEG_RULES.maxMessagesPerSegment) {
        shouldSplit = true;
      }
      // 规则 4: 时长超限
      if (timeSinceSegStart >= SEG_RULES.maxSegmentDurationMs) {
        shouldSplit = true;
      }

      if (shouldSplit) {
        pushSegment();
      }
    }

    current.push(msg);
    if (segStartTs === null) segStartTs = msgTs;
    lastUserTs = msgTs;
  }

  if (current.length > 0) pushSegment();
  return segments;
}

/**
 * 增量合并：将新分段与已有 summary 段落合并
 */
function mergeWithExisting(newSegments: Segment[], existingSummary: string | null): Segment[] {
  if (!existingSummary || newSegments.length === 0) return newSegments;

  let existingSegments: Segment[] = [];
  try {
    const parsed = JSON.parse(existingSummary);
    if (parsed.segments) {
      existingSegments = parsed.segments;
    }
  } catch {
    // 解析失败，视为无已有段落
  }

  if (existingSegments.length === 0) return newSegments;

  // 检查新第一段与已有最后一段的间隔
  const lastExisting = existingSegments[existingSegments.length - 1];
  const lastEndTime = parseHHMM(lastExisting.to);
  const firstNewStart = parseHHMM(newSegments[0].from);

  // 计算分钟差（处理跨天情况：如果间隔 > 12h 视为跨天）
  let gapMinutes = firstNewStart - lastEndTime;
  if (gapMinutes < 0) gapMinutes += 24 * 60; // 跨天

  if (gapMinutes < SEG_RULES.idleThresholdMs / (60 * 1000)) {
    // 合并到最后一段
    const mergedLast: Segment & { messages?: RawMessage[] } = {
      index: 0,
      from: lastExisting.from,
      to: newSegments[0].to,
      messages: undefined,
      needs_regenerate: true,
      text: lastExisting.text,
      existing_text: lastExisting.text,
    };

    const result = existingSegments.slice(0, -1).map(s => ({ ...s }));
    mergedLast.index = result.length;
    result.push(mergedLast);

    // 剩余新段追加
    for (let i = 1; i < newSegments.length; i++) {
      const seg = { ...newSegments[i], index: result.length };
      result.push(seg);
    }
    return result;
  } else {
    // 不连续，全部追加
    const result = existingSegments.map(s => ({ ...s }));
    for (const seg of newSegments) {
      seg.index = result.length;
      result.push(seg);
    }
    return result;
  }
}

/**
 * 解析 HH:MM 字符串为当天分钟数
 */
function parseHHMM(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ============================================================================
// 智能截断函数
// ============================================================================

/**
 * 去掉消息时间戳前缀 [Mon 2026-05-18 08:21 GMT+8]
 */
function stripTimestampPrefix(msg: string | null): string {
  if (!msg) return '';
  return msg.replace(/^\[[^\]]+\]\s*/, '');
}

/**
 * 从文本中提取第一个 ## 或 ### 标题（用于 subagent 任务标题）
 */
function extractTaskTitle(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/^##\s+(.+)$/m) || text.match(/^###\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * 智能截断文本，优先在段落/行/句子边界截断，避免截断 markdown 语法中间
 */
function smartTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text ?? '';

  const searchLen = maxLen + 50; // 多看 50 字符找边界
  const window = text.slice(0, Math.min(text.length, searchLen));

  // 1. 段落边界
  const paraIdx = window.lastIndexOf('\n\n', maxLen);
  if (paraIdx > maxLen * 0.4) {
    const trimmed = window.slice(0, paraIdx).replace(/\n+$/, '');
    if (trimmed.length > 0) return trimmed + '…';
  }

  // 2. 行边界
  const lineIdx = window.lastIndexOf('\n', maxLen);
  if (lineIdx > maxLen * 0.4) {
    return window.slice(0, lineIdx).replace(/\n+$/, '') + '…';
  }

  // 3. 句子边界
  const sentenceMatch = window.slice(0, maxLen + 50).match(/[。！？.!?]/g);
  if (sentenceMatch) {
    // 从 maxLen 附近往前找最近的句子结尾
    const re = /[。！？.!?]/g;
    let m: RegExpExecArray | null;
    let lastPos = -1;
    while ((m = re.exec(window)) !== null) {
      if (m.index <= maxLen) lastPos = m.index;
      else break;
    }
    if (lastPos > maxLen * 0.4) {
      return window.slice(0, lastPos + 1) + '…';
    }
  }

  // 4. 检查 markdown 语法完整性：避免在 ** 或 ` 中间截断
  let cutAt = maxLen;
  // 检查未闭合的 **
  const boldCount = (window.slice(0, cutAt).match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    // 往前找最近的 ** 开头，在其之前截断
    const lastBold = window.slice(0, cutAt).lastIndexOf('**');
    if (lastBold > 0 && lastBold > maxLen * 0.4) {
      cutAt = lastBold;
    }
  }
  // 检查未闭合的 `
  const backtickCount = (window.slice(0, cutAt).match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    const lastTick = window.slice(0, cutAt).lastIndexOf('`');
    if (lastTick > 0 && lastTick > maxLen * 0.4) {
      cutAt = lastTick;
    }
  }

  return window.slice(0, cutAt) + '…';
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
    const uptime = Math.round((Date.now() - startTime) / (1000 * 60 * 60) * 100) / 100;
    res.json({ ...stats, uptime });
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
    const platform = req.query.platform ? String(req.query.platform) : undefined;

    const result = repository.getSessions({ limit, offset, agent_id, channel, platform });

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
   * GET /api/sessions/timeline
   * 纯 SQLite 查询，返回按日期分组的树状会话时间线（不走 Gateway）
   * 主会话平铺 + subagent 嵌套在父会话下
   */
  router.get('/sessions/timeline', (req: Request, res: Response) => {
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : undefined;
    const days = Math.min(parseInt(String(req.query.days ?? '7')), 90) || 7;

    const db = (repository as any).db;
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    // ====== 通用过滤条件 ======
    const baseWhere = `
      s.session_key NOT LIKE '%.trajectory'
      AND s.session_key NOT LIKE '%.checkpoint'
      AND s.session_key NOT LIKE 'agent:daily-reporter:%'
      AND s.message_count > 1
      AND NOT (s.message_count <= 3
        AND s.last_message_at IS NOT NULL AND s.first_message_at IS NOT NULL
        AND (julianday(s.last_message_at) - julianday(s.first_message_at)) * 86400 < 120)
    `;
    // dreaming 会话排除（通过 content 关键词）
    const dreamingExclude = `
      AND s.session_key NOT IN (
        SELECT DISTINCT session_key FROM admin_messages
        WHERE message_type = 'user'
          AND (content LIKE '%dream diary%' OR content LIKE '%dreaming%')
      )
      -- 排除所有 user 消息只有系统注入或为空的会话（纯自动任务）
      AND NOT (
        NOT EXISTS (
          SELECT 1 FROM admin_messages m2
          WHERE m2.session_key = s.session_key
            AND m2.message_type = 'user'
            AND m2.content IS NOT NULL AND m2.content != ''
            AND m2.content NOT LIKE 'Sender (untrusted metadata)%'
            AND m2.content NOT LIKE 'System (untrusted):%'
            AND m2.content NOT LIKE 'System:%'
        )
      )
    `;

    // ====== 查所有会话（平铺，不分主/子）======
    const values: unknown[] = [];
    let filter = baseWhere + dreamingExclude + `
      AND s.last_message_at >= datetime('now', '-${days} days')
    `;
    if (agent_id) {
      filter += ` AND s.agent_id = ?`;
      values.push(agent_id);
    }

    const rows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        a.agent_name,
        a.avatar,
        s.message_count,
        s.first_message_at,
        s.last_message_at,
        s.session_status,
        COALESCE(s.spawn_depth, 0) as spawn_depth,
        COALESCE(sums.input_tokens, 0) as input_tokens,
        COALESCE(sums.output_tokens, 0) as output_tokens,
        s.summary,
        (SELECT m.content FROM admin_messages m
          WHERE m.session_key = s.session_key AND m.message_type = 'user'
            AND m.content IS NOT NULL AND m.content != ''
            AND m.content NOT LIKE 'Sender (untrusted metadata)%'
            AND m.content NOT LIKE 'System (untrusted):%'
            AND m.content NOT LIKE 'System:%'
            AND instr(m.content, '[Subagent Context]') = 0
          ORDER BY m.timestamp ASC LIMIT 1
        ) as first_message,
        (SELECT m.content FROM admin_messages m
          WHERE m.session_key = s.session_key AND m.message_type = 'agent'
          ORDER BY m.timestamp DESC LIMIT 1
        ) as last_message
      FROM admin_sessions s
      LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
      LEFT JOIN (
        SELECT session_key, SUM(tokens_input) as input_tokens, SUM(tokens_output) as output_tokens
        FROM admin_messages GROUP BY session_key
      ) sums ON sums.session_key = s.session_key
      WHERE ${filter}
      GROUP BY s.session_key
      ORDER BY s.last_message_at DESC NULLS LAST
    `).all(...values) as any[];

    // 应用智能截断
    // 对于 subagent：如果 first_message 为空（系统注入被过滤），取第二条 user 消息
    const subagentKeys = rows
      .filter(r => r.spawn_depth > 0 && !r.first_message)
      .map(r => r.session_key);
    const subagentFirstMsgMap = new Map<string, string>();
    if (subagentKeys.length > 0) {
      const subRows = db.prepare(`
        SELECT session_key, content FROM (
          SELECT session_key, content,
            ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY timestamp ASC) as rn
          FROM admin_messages
          WHERE session_key IN (${subagentKeys.map(() => '?').join(',')})
            AND message_type = 'user'
            AND content IS NOT NULL AND content != ''
            AND content NOT LIKE 'Sender (untrusted metadata)%'
            AND content NOT LIKE 'System (untrusted):%'
            AND content NOT LIKE 'System:%'
            AND instr(content, '[Subagent Context]') = 0
        ) WHERE rn = 2
      `).all(...subagentKeys) as { session_key: string; content: string }[];
      for (const row of subRows) {
        subagentFirstMsgMap.set(row.session_key, row.content);
      }
    }

    const timeline = rows.map(r => ({
      ...r,
      task_title: r.spawn_depth > 0 && !r.first_message
        ? extractTaskTitle(r.last_message)
        : null,
      first_message: smartTruncate(
        stripTimestampPrefix(r.first_message || subagentFirstMsgMap.get(r.session_key)),
        400
      ),
      last_message: smartTruncate(stripTimestampPrefix(r.last_message), 300),
    }));

    res.json({ timeline, total: timeline.length });
  });

  /**
   * GET /api/sessions/flows
   * 智能会话流：按时间段合并相邻会话，gap < 20min 视为同一工作流
   *
   * Response: { flows: FlowGroup[] }
   * FlowGroup: { label, sortKey, flows[] }
   * SessionFlow: { id, agent_id, agent_name, avatar, start_at, end_at,
   *                 duration_minutes, message_count, spawn_depth,
   *                 sessions_count, summary, gap_minutes }
   */
  router.get('/sessions/flows', (req: Request, res: Response) => {
    const days = Math.min(parseInt(String(req.query.days ?? '7')), 90) || 7;
    const gapMs = 20 * 60 * 1000; // 20分钟 gap 阈值

    const db = (repository as any).db;
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    // 基础过滤（与 timeline 一致）
    const baseWhere = `
      s.session_key NOT LIKE '%.trajectory'
      AND s.session_key NOT LIKE '%.checkpoint'
      AND s.session_key NOT LIKE 'agent:daily-reporter:%'
      AND s.message_count > 1
      AND NOT (s.message_count <= 3
        AND s.last_message_at IS NOT NULL AND s.first_message_at IS NOT NULL
        AND (julianday(s.last_message_at) - julianday(s.first_message_at)) * 86400 < 120)
    `;
    const dreamingExclude = `
      AND s.session_key NOT IN (
        SELECT DISTINCT session_key FROM admin_messages
        WHERE message_type = 'user'
          AND (content LIKE '%dream diary%' OR content LIKE '%dreaming%')
      )
      AND NOT (
        NOT EXISTS (
          SELECT 1 FROM admin_messages m2
          WHERE m2.session_key = s.session_key
            AND m2.message_type = 'user'
            AND m2.content IS NOT NULL AND m2.content != ''
            AND m2.content NOT LIKE 'Sender (untrusted metadata)%'
            AND m2.content NOT LIKE 'System (untrusted):%'
            AND m2.content NOT LIKE 'System:%'
        )
      )
    `;

    const rows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        a.agent_name,
        a.avatar,
        s.message_count,
        s.first_message_at,
        s.last_message_at,
        s.session_status,
        COALESCE(s.spawn_depth, 0) as spawn_depth,
        s.summary
      FROM admin_sessions s
      LEFT JOIN admin_agents a ON a.agent_id = s.agent_id
      WHERE ${baseWhere}${dreamingExclude}
        AND s.last_message_at >= datetime('now', '-${days} days')
      ORDER BY s.last_message_at ASC
    `).all() as any[];

    if (rows.length === 0) {
      res.json({ flows: [], total: 0 });
      return;
    }

    // ===== 按 (agent_id, spawn_depth) 分组 =====
    const agentGroups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.agent_id}__${row.spawn_depth}`;
      if (!agentGroups.has(key)) agentGroups.set(key, []);
      agentGroups.get(key)!.push(row);
    }

    // ===== 构建 SessionFlow =====
    const allFlows: Array<{
      id: string;
      agent_id: string;
      agent_name: string | null;
      avatar: string | null;
      start_at: string;
      end_at: string;
      duration_minutes: number;
      message_count: number;
      spawn_depth: number;
      sessions_count: number;
      summary: string | null;
      gap_minutes: number;
    }> = [];

    for (const sessions of agentGroups.values()) {
      // 按时间排序
      sessions.sort((a, b) => (a.last_message_at || '').localeCompare(b.last_message_at || ''));

      let currentFlow = createFlowFromSession(sessions[0]);

      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        const prevEnd = new Date(prev.last_message_at || prev.first_message_at || 0).getTime();
        const currStart = new Date(curr.first_message_at || curr.last_message_at || 0).getTime();
        const gap = currStart - prevEnd;

        if (gap < gapMs) {
          // gap < 20min：合并到当前 flow
          const prevStart = new Date(prev.first_message_at || prev.last_message_at || 0).getTime();
          const currEnd = new Date(curr.last_message_at || curr.first_message_at || 0).getTime();
          currentFlow.end_at = curr.last_message_at || currentFlow.end_at;
          currentFlow.start_at = (new Date(prevStart).getTime() < new Date(currentFlow.start_at).getTime())
            ? prev.first_message_at || currentFlow.start_at
            : currentFlow.start_at;
          currentFlow.duration_minutes = Math.round((currEnd - prevStart) / 60000);
          currentFlow.message_count += curr.message_count;
          currentFlow.sessions_count += 1;
          // 合并摘要
          if (curr.summary && !currentFlow.summary) {
            currentFlow.summary = curr.summary;
          } else if (curr.summary && currentFlow.summary) {
            // 保留更完整的摘要（更长的）
            if (curr.summary.length > currentFlow.summary.length) {
              currentFlow.summary = curr.summary;
            }
          }
        } else {
          // gap >= 20min：新 flow
          allFlows.push(currentFlow);
          currentFlow = { ...createFlowFromSession(curr), gap_minutes: Math.round(gap / 60000) };
        }
      }
      allFlows.push(currentFlow);
    }

    // ===== 按日期分组 =====
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const flowGroups = new Map<string, typeof allFlows>();
    for (const flow of allFlows) {
      const d = new Date(flow.end_at);
      const dateStr = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
      if (!flowGroups.has(dateStr)) flowGroups.set(dateStr, []);
      flowGroups.get(dateStr)!.push(flow);
    }

    const flows = Array.from(flowGroups.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateStr, items]) => {
        const [y, m, day] = dateStr.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        const today2 = new Date(); today2.setHours(0, 0, 0, 0);
        const yesterday2 = new Date(today2); yesterday2.setDate(yesterday2.getDate() - 1);
        let label: string;
        if (d.getTime() === today2.getTime()) label = '今天';
        else if (d.getTime() === yesterday2.getTime()) label = '昨天';
        else label = `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
        // 按结束时间倒序
        items.sort((a, b) => b.end_at.localeCompare(a.end_at));
        return { label, sortKey: dateStr, flows: items };
      });

    res.json({ flows, total: allFlows.length });
  });

  function createFlowFromSession(s: any) {
    const start = new Date(s.first_message_at || s.last_message_at || 0).getTime();
    const end = new Date(s.last_message_at || s.first_message_at || 0).getTime();
    return {
      id: s.session_key,
      agent_id: s.agent_id,
      agent_name: s.agent_name,
      avatar: s.avatar,
      start_at: s.first_message_at,
      end_at: s.last_message_at,
      duration_minutes: Math.round((end - start) / 60000),
      message_count: s.message_count,
      spawn_depth: s.spawn_depth,
      sessions_count: 1,
      summary: s.summary,
      gap_minutes: 0,
    };
  }

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
   * GET /api/sessions/pending-summary
   * 返回需要 AI 总结的 session 列表
   */
  router.get('/sessions/pending-summary', (_req: Request, res: Response) => {
    const db = (repository as any).db;
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    // 找有待总结消息的 session（最近 7 天活跃，最多 20 个）
    const sessions = db.prepare(`
      SELECT session_key, spawn_depth, agent_id, last_summarized_msg_id, summary
      FROM admin_sessions
      WHERE session_key NOT LIKE '%.trajectory'
        AND session_key NOT LIKE '%.checkpoint'
        AND session_key NOT LIKE 'agent:daily-reporter:%'
        AND message_count > 1
        AND last_message_at >= datetime('now', '-7 days')
        AND (summary IS NULL OR last_message_at > summary_updated_at)
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 20
    `).all() as Array<{
      session_key: string;
      spawn_depth: number | null;
      agent_id: string | null;
      last_summarized_msg_id: number | null;
      summary: string | null;
    }>;

    const result = sessions.map(s => {
      const afterId = s.last_summarized_msg_id ?? 0;
      const isMain = (s.spawn_depth ?? 0) === 0;

      // 系统注入过滤 + 增量 + 最多 100 条
      const messages = db.prepare(`
        SELECT id, message_type, content, timestamp
        FROM admin_messages
        WHERE session_key = ?
          AND id > ?
          AND message_type IN ('user', 'agent')
          AND content NOT LIKE 'Sender%'
          AND content NOT LIKE 'System%'
          AND instr(content, '[Subagent') = 0
        ORDER BY timestamp ASC
        LIMIT 100
      `).all(s.session_key, afterId) as Array<{
        id: number;
        message_type: string;
        content: string | null;
        timestamp: string;
      }>;

      // 添加 beijing_time
      const rawMsgs: RawMessage[] = messages.map(m => ({
        id: m.id,
        type: m.message_type,
        content: m.content,
        timestamp: m.timestamp,
        beijing_time: toBeijingTime(m.timestamp),
      }));

      if (rawMsgs.length === 0) {
        return {
          session_key: s.session_key,
          spawn_depth: s.spawn_depth ?? 0,
          agent_id: s.agent_id,
          new_messages: [],
        };
      }

      if (!isMain) {
        // subagent: 保持不变，返回 new_messages
        return {
          session_key: s.session_key,
          spawn_depth: s.spawn_depth ?? 0,
          agent_id: s.agent_id,
          summary_type: 'single',
          new_messages: rawMsgs,
        };
      }

      // main 会话：分段 + 增量合并
      const newSegments = segmentMessages(rawMsgs);
      const mergedSegments = mergeWithExisting(newSegments, s.summary);

      // 对 needs_regenerate 的段，从 DB 取该段全部历史消息
      for (const seg of mergedSegments) {
        if (seg.needs_regenerate) {
          // 需要重新生成的段：取该时间段内全部消息
          // 取该段全部历史消息用于重新生成摘要
          const fullMsgs = db.prepare(`
            SELECT id, message_type, content, timestamp
            FROM admin_messages
            WHERE session_key = ?
              AND message_type IN ('user', 'agent')
              AND content NOT LIKE 'Sender%'
              AND content NOT LIKE 'System%'
              AND instr(content, '[Subagent') = 0
              AND timestamp <= ?
            ORDER BY timestamp ASC
          `).all(s.session_key, messages[messages.length - 1].timestamp) as Array<{
            id: number;
            message_type: string;
            content: string | null;
            timestamp: string;
          }>;
          seg.messages = fullMsgs.map(m => ({
            id: m.id,
            type: m.message_type,
            content: m.content,
            timestamp: m.timestamp,
            beijing_time: toBeijingTime(m.timestamp),
          }));
        }
        // 非 needs_regenerate 的段：只保留增量新消息
      }

      return {
        session_key: s.session_key,
        spawn_depth: 0,
        agent_id: s.agent_id,
        summary_type: 'segmented',
        last_summarized_msg_id: s.last_summarized_msg_id ?? 0,
        segments: mergedSegments.map(seg => ({
          index: seg.index,
          from: seg.from,
          to: seg.to,
          needs_regenerate: seg.needs_regenerate ?? false,
          existing_text: seg.existing_text,
          messages: seg.messages?.map(m => ({
            id: m.id,
            type: m.type,
            content: m.content,
            beijing_time: m.beijing_time,
          })),
        })),
      };
    });

    res.json({ sessions: result });
  });

  /**
   * PUT /api/sessions/summary
   * 批量更新 session 摘要
   */
  router.put('/sessions/summary', (req: Request, res: Response) => {
    const db = (repository as any).db;
    if (!db) { res.status(503).json({ error: 'DB not ready' }); return; }

    const { updates } = req.body as {
      updates: Array<{
        session_key: string;
        summary_type?: 'single' | 'segmented';
        summary?: string;
        segments?: Array<{ index: number; text: string }>;
        last_summarized_msg_id: number;
      }>;
    };

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'updates array is required' });
      return;
    }

    const now = new Date().toISOString();
    let updated = 0;

    const upsert = db.transaction(() => {
      for (const item of updates) {
        const session = db.prepare(
          'SELECT summary, spawn_depth FROM admin_sessions WHERE session_key = ?'
        ).get(item.session_key) as { summary: string | null; spawn_depth: number | null } | undefined;

        if (!session) continue;

        let finalSummary: string;

        if (item.summary_type === 'segmented') {
          // main 会话：按段索引更新
          let existingSegments: Array<{ index: number; from: string; to: string; text?: string; needs_regenerate?: boolean }> = [];
          if (session.summary) {
            try {
              const parsed = JSON.parse(session.summary);
              if (parsed.segments) existingSegments = parsed.segments;
            } catch { /* ignore */ }
          }

          for (const newSeg of item.segments ?? []) {
            const idx = newSeg.index;
            const found = existingSegments.find(es => es.index === idx);
            if (found) {
              found.text = newSeg.text;
              delete found.needs_regenerate;
            } else {
              existingSegments.push({ index: idx, from: '', to: '', text: newSeg.text });
            }
          }
          finalSummary = JSON.stringify({ segments: existingSegments });
        } else {
          // single (subagent): 直接覆盖
          finalSummary = item.summary ?? '';
        }

        db.prepare(`
          UPDATE admin_sessions
          SET summary = ?, summary_updated_at = ?, last_summarized_msg_id = ?
          WHERE session_key = ?
        `).run(finalSummary, now, item.last_summarized_msg_id, item.session_key);
        updated++;
      }
    });

    upsert();
    res.json({ updated });
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


