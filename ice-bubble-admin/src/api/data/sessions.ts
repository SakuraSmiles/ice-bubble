/**
 * Session 域路由
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

import { Router, Request, Response } from 'express';
import type { DataRouterConfig } from '../data.js';

/** Extended config with startTime injected by the data.ts facade */
export interface SessionsRouterConfig extends DataRouterConfig {
  startTime: number;
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

// ============================================================================
// Session 域子路由
// ============================================================================

/**
 * 创建 Session 域子路由
 * 包含 /stats 和 /sessions/* 所有端点
 */
export function createSessionsRouter(config: SessionsRouterConfig): Router {
  const { repository, startTime } = config;
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
      sessions.sort((a, b) => (a.last_message_at || '').localeCompare(b.last_message_at || ''));

      let currentFlow = createFlowFromSession(sessions[0]);

      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        const prevEnd = new Date(prev.last_message_at || prev.first_message_at || 0).getTime();
        const currStart = new Date(curr.first_message_at || curr.last_message_at || 0).getTime();
        const gap = currStart - prevEnd;

        if (gap < gapMs) {
          const prevStart = new Date(prev.first_message_at || prev.last_message_at || 0).getTime();
          const currEnd = new Date(curr.last_message_at || curr.first_message_at || 0).getTime();
          currentFlow.end_at = curr.last_message_at || currentFlow.end_at;
          currentFlow.start_at = (new Date(prevStart).getTime() < new Date(currentFlow.start_at).getTime())
            ? prev.first_message_at || currentFlow.start_at
            : currentFlow.start_at;
          currentFlow.duration_minutes = Math.round((currEnd - prevStart) / 60000);
          currentFlow.message_count += curr.message_count;
          currentFlow.sessions_count += 1;
          if (curr.summary && !currentFlow.summary) {
            currentFlow.summary = curr.summary;
          } else if (curr.summary && currentFlow.summary) {
            if (curr.summary.length > currentFlow.summary.length) {
              currentFlow.summary = curr.summary;
            }
          }
        } else {
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
        return {
          session_key: s.session_key,
          spawn_depth: s.spawn_depth ?? 0,
          agent_id: s.agent_id,
          summary_type: 'single',
          new_messages: rawMsgs,
        };
      }

      const newSegments = segmentMessages(rawMsgs);
      const mergedSegments = mergeWithExisting(newSegments, s.summary);

      for (const seg of mergedSegments) {
        if (seg.needs_regenerate) {
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

  return router;
}
