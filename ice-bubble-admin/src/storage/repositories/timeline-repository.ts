/**
 * TimelineRepository — 群聊风格消息时间线查询
 *
 * 职责：
 * - 合并 user/agent/tool 所有消息，按时间 DESC 排序
 * - 关联 agent 信息（name/avatar）
 * - 支持多维度过滤（agent_ids, message_types, search, system_noise, cron）
 * - 支持 cursor 分页（before）和增量轮询（since）
 *
 * 依赖：SessionRepository（resolveSessionKey）
 */

import type { Database } from 'better-sqlite3';
import { analyzeMessageMeta } from '../../utils/message-meta.js';
import type { TimelineMessage } from '../data-repository.js';
import type { SessionRepository } from './session-repository.js';

export class TimelineRepository {
  private db: Database;
  private sessionRepo: SessionRepository;

  constructor(db: Database, sessionRepo: SessionRepository) {
    this.db = db;
    this.sessionRepo = sessionRepo;
  }

  /**
   * 获取消息时间线（群聊风格）
   * - 合并 user/agent/tool 所有消息，按时间 DESC 排序
   * - 关联 agent 信息（name/avatar）
   * - 支持多维度过滤和数据治理
   * - 支持 cursor 分页（before）和增量轮询（since）
   *
   * @param params.limit 每页数量（默认50，最大200）
   * @param params.before cursor 时间戳，返回此时间之前的消息
   * @param params.since 时间戳，返回此时间之后的消息（增量轮询）
   * @param params.agent_ids 只查指定 agent 的消息
   * @param params.message_types 消息类型过滤（逗号分隔，默认 user,agent,tool）
   * @param params.search 内容关键词搜索
   * @param params.exclude_system_noise 过滤系统噪音
   * @param params.exclude_cron 过滤定时任务
   */
  getMessagesTimeline(params: {
    limit?: number;
    before?: string;
    since?: string;
    agent_ids?: string[];
    session_key?: string;
    message_types?: string;
    search?: string;
    exclude_system_noise?: boolean;
    exclude_cron?: boolean;
    /** 多个 session key，用于跨 session 查询。优先于 session_key */
    session_keys?: string[];
  } = {}): {
    messages: TimelineMessage[];
    has_more: boolean;
    pagination: { oldest: string | null; newest: string | null; total_in_range: number };
    meta: { agents_in_range: string[]; filter_applied: Record<string, unknown> };
  } {
    const limit = Math.min(params.limit ?? 50, 200);
    const messages: TimelineMessage[] = [];

    // Build conditions
    const contentConditions: string[] = ["m.message_type IN ('user', 'agent')"];
    const values: unknown[] = [];

    if (params.message_types) {
      const types = params.message_types.split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0 && types.length < 3) {
        contentConditions[0] = `m.message_type IN (${types.map(() => '?').join(', ')})`;
        values.push(...types);
      }
    }

    // 预解析 session_key / session_keys（Gateway 格式 → SQLite 格式），供 content 和 tool 查询共享
    let resolvedSessionKeys: string[] | undefined;

    if (params.session_keys && params.session_keys.length > 0) {
      const resolved: string[] = [];
      for (const sk of params.session_keys) {
        resolved.push(...this.sessionRepo.resolveSessionKey(sk));
      }
      resolvedSessionKeys = [...new Set(resolved)].filter(k => !k.endsWith('.trajectory'));
    } else if (params.session_key) {
      resolvedSessionKeys = this.sessionRepo.resolveSessionKey(params.session_key);
    }

    if (resolvedSessionKeys) {
      if (resolvedSessionKeys.length === 1) {
        contentConditions.push('m.session_key = ?');
        values.push(resolvedSessionKeys[0]);
      } else {
        const nonTrajectory = resolvedSessionKeys.filter(k => !k.endsWith('.trajectory'));
        const keys = nonTrajectory.length > 0 ? nonTrajectory : resolvedSessionKeys;
        contentConditions.push(`m.session_key IN (${keys.map(() => '?').join(', ')})`);
        values.push(...keys);
      }
    } else if (params.session_key) {
      // 未匹配到，用原始 key 尝试直接查询（返回空结果）
      contentConditions.push('m.session_key = ?');
      values.push(params.session_key);
    }

    if (params.before) {
      contentConditions.push('m.timestamp < ?');
      values.push(params.before);
    }

    if (params.since) {
      contentConditions.push('m.timestamp >= ?');
      values.push(params.since);
    }

    if (params.agent_ids && params.agent_ids.length > 0) {
      const agentPlaceholders = params.agent_ids.map(() => '?').join(', ');
      contentConditions.push(`s.agent_id IN (${agentPlaceholders})`);
      values.push(...params.agent_ids);
    }

    if (params.search) {
      contentConditions.push('m.content LIKE ?');
      // 转义 LIKE 通配符 % 和 _，避免搜索词被误解释为通配符
      const escaped = params.search.replace(/[%_]/g, (c) => c === '%' ? '\\%' : '\\_');
      values.push(`%${escaped}%`);
    }

    const contentWhereClause = `WHERE ${contentConditions.join(' AND ')}`;

    // Step 1: Query admin_messages for user+agent (limit+1 to detect has_more)
    const contentRows = this.db.prepare(`
      SELECT
        m.id,
        m.session_key,
        m.message_type,
        m.content,
        m.timestamp,
        m.model,
        COALESCE(s.agent_id, CASE WHEN m.session_key LIKE 'ses_%' THEN NULL ELSE SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1, INSTR(SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1), ':') - 1) END) as agent_id,
        COALESCE(a.agent_name, a2.agent_name) as agent_name,
        COALESCE(a.avatar, a2.avatar) as avatar
      FROM admin_messages m
      LEFT JOIN admin_sessions s ON m.session_key = s.session_key
      LEFT JOIN admin_agents a ON s.agent_id = a.agent_id
      LEFT JOIN admin_agents a2 ON a2.agent_id = COALESCE(s.agent_id, CASE WHEN m.session_key LIKE 'ses_%' THEN NULL ELSE SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1, INSTR(SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1), ':') - 1) END)
      ${contentWhereClause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...values, limit + 1) as Array<{
      id: number;
      session_key: string;
      message_type: string;
      content: string | null;
      timestamp: string;
      model: string | null;
      agent_id: string | null;
      agent_name: string | null;
      avatar: string | null;
    }>;

    const contentHasMore = contentRows.length > limit;
    if (contentHasMore) contentRows.pop();

    // Step 2: Determine time window from content rows
    let windowOldest: string | null = null;
    let windowNewest: string | null = null;
    if (contentRows.length > 0) {
      windowOldest = contentRows[contentRows.length - 1].timestamp;
      windowNewest = contentRows[0].timestamp;
    }

    // Step 3: Build tool-only conditions (message_type filter doesn't apply to tool table)
    const toolConditions: string[] = [];
    const toolValues: unknown[] = [];

    if (resolvedSessionKeys) {
      if (resolvedSessionKeys.length === 1) {
        toolConditions.push('t.session_key = ?');
        toolValues.push(resolvedSessionKeys[0]);
      } else {
        const nonTrajectory = resolvedSessionKeys.filter(k => !k.endsWith('.trajectory'));
        const keys = nonTrajectory.length > 0 ? nonTrajectory : resolvedSessionKeys;
        toolConditions.push(`t.session_key IN (${keys.map(() => '?').join(', ')})`);
        toolValues.push(...keys);
      }
    } else if (params.session_key) {
      toolConditions.push('t.session_key = ?');
      toolValues.push(params.session_key);
    }
    if (params.before) {
      toolConditions.push('t.created_at < ?');
      toolValues.push(params.before);
    }
    if (params.since) {
      toolConditions.push('t.created_at > ?');
      toolValues.push(params.since);
    }
    if (params.agent_ids && params.agent_ids.length > 0) {
      const agentPlaceholders = params.agent_ids.map(() => '?').join(', ');
      toolConditions.push(`s.agent_id IN (${agentPlaceholders})`);
      toolValues.push(...params.agent_ids);
    }
    if (params.search) {
      toolConditions.push('t.content LIKE ?');
      const escaped = params.search.replace(/[%_]/g, (c) => c === '%' ? '\\%' : '\\_');
      toolValues.push(`%${escaped}%`);
    }
    if (windowOldest && windowNewest) {
      toolConditions.push('t.created_at BETWEEN ? AND ?');
      toolValues.push(windowOldest, windowNewest);
    }

    const toolWhereClause = toolConditions.length > 0 ? `WHERE ${toolConditions.join(' AND ')}` : '';

    // Step 4: Query admin_tool_calls within time window
    let toolRows: Array<{
      id: number;
      session_key: string;
      message_type: string;
      content: string | null;
      timestamp: string;
      model: string | null;
      agent_id: string | null;
      agent_name: string | null;
      avatar: string | null;
    }> = [];

    if (toolWhereClause) {
      const toolSQL = `
        SELECT
          t.id,
          t.session_key,
          'tool' as message_type,
          t.content,
          t.created_at as timestamp,
          t.model,
          COALESCE(s.agent_id, CASE WHEN t.session_key LIKE 'ses_%' THEN NULL ELSE SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1, INSTR(SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1), ':') - 1) END) as agent_id,
          COALESCE(a.agent_name, a2.agent_name) as agent_name,
          COALESCE(a.avatar, a2.avatar) as avatar
        FROM admin_tool_calls t
        LEFT JOIN admin_sessions s ON t.session_key = s.session_key
        LEFT JOIN admin_agents a ON s.agent_id = a.agent_id
        LEFT JOIN admin_agents a2 ON a2.agent_id = COALESCE(s.agent_id, CASE WHEN t.session_key LIKE 'ses_%' THEN NULL ELSE SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1, INSTR(SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1), ':') - 1) END)
        ${toolWhereClause}
        ORDER BY t.created_at DESC
      `;
      toolRows = this.db.prepare(toolSQL).all(...toolValues) as typeof toolRows;
    }

    // Step 5: Merge content + tool rows and sort by timestamp DESC
    const mergedRows = [...contentRows, ...toolRows].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Step 6: has_more based on CONTENT rows only (not tool)
    const has_more = contentHasMore;

    // 统计范围内的 agent
    const agentSet = new Set<string>();
    // 总行数（content only，不含 tool）
    let totalInRange = 0;
    try {
      const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM admin_messages m LEFT JOIN admin_sessions s ON m.session_key = s.session_key ${contentWhereClause}`).get(...values) as { cnt: number };
      totalInRange = countRow.cnt;
    } catch { /* ignore */ }

    const seenContent = new Set<string>();

    for (const row of mergedRows) {
      // Apply message_types filter dynamically
      if (params.message_types) {
        const types = params.message_types.split(',').map(s => s.trim()).filter(Boolean);
        if (types.length > 0 && !types.includes(row.message_type)) continue;
      }
      // Determine agent_id
      let agentId = row.agent_id;
      if (!agentId && row.message_type === 'user') {
        const match = row.session_key.match(/^agent:([^:]+):/);
        agentId = match ? match[1] : null;
      }

      const agentName = row.agent_name || agentId || '未知';
      if (agentId) agentSet.add(agentId);

      // 分析消息元信息
      const meta = analyzeMessageMeta({
        message_type: row.message_type,
        content: row.content,
        agent_name: agentName,
      });

      // 应用噪音/定时任务过滤
      if (params.exclude_system_noise && meta.is_system_noise) continue;
      if (params.exclude_cron && meta.is_cron) continue;

      // 过滤空内容的 user 消息
      if (row.message_type === 'user' && !(row.content || '').trim()) {
        continue;
      }

      let content = row.content;
      if (row.message_type === 'tool') {
        const trimmed = (content || '').trim();
        if (!trimmed || trimmed === '{}' || trimmed === '[]' || trimmed === 'ok' || trimmed === 'null') {
          continue;
        }
        if (content && content.length > 200) {
          content = content.substring(0, 200);
        }
      }

      // Set 去重：同 session + 同 message_type + 同时间戳 + 同内容(前200字符) 只保留首次出现
      const contentHash = (row.content || '').substring(0, 200).replace(/\s+/g, ' ').trim();
      const dedupKey = `${row.session_key}|${row.message_type}|${row.timestamp}|${contentHash}`;
      if (seenContent.has(dedupKey)) continue;
      seenContent.add(dedupKey);

      messages.push({
        id: row.id,
        session_key: row.session_key,
        agent_id: agentId,
        agent_name: agentName,
        avatar: row.avatar,
        message_type: row.message_type as 'user' | 'agent' | 'tool',
        content,
        clean_content: meta.clean_content || null,
        content_summary: meta.content_summary || null,
        is_cron: meta.is_cron,
        is_system_noise: meta.is_system_noise,
        source_channel: meta.source_channel,
        model: row.model ?? null,
        timestamp: row.timestamp,
      });
    }

    const oldest = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
    const newest = messages.length > 0 ? messages[0].timestamp : null;

    const filterApplied: Record<string, unknown> = {};
    if (params.message_types) filterApplied.message_types = params.message_types;
    if (params.since) filterApplied.since = params.since;
    if (params.before) filterApplied.before = params.before;
    if (params.agent_ids) filterApplied.agent_ids = params.agent_ids;
    if (params.search) filterApplied.search = params.search;
    if (params.exclude_system_noise) filterApplied.exclude_system_noise = true;
    if (params.exclude_cron) filterApplied.exclude_cron = true;

    return {
      messages,
      has_more,
      pagination: {
        oldest,
        newest,
        total_in_range: totalInRange,
      },
      meta: {
        agents_in_range: Array.from(agentSet).sort(),
        filter_applied: filterApplied,
      },
    };
  }
}
