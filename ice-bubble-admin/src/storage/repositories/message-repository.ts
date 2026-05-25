/**
 * MessageRepository — 管理 admin_messages 和 admin_tool_calls 表的 CRUD 操作
 *
 * 职责：
 * - 批量保存消息（content 消息 → admin_messages，tool 消息 → admin_tool_calls）
 * - 同步更新 token_summary（增量统计）
 * - 消息查询（合并 content + tool，分页）
 * - Agent 最新消息获取
 * - 消息去重
 *
 * 依赖：SessionRepository（getSessionAgentIds）、TokenSummaryRepository（batchUpdateTokenSummary）
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/index.js';
import type { AdminMessage } from '../data-repository.js';
import type { SessionRepository } from './session-repository.js';
import type { TokenSummaryRepository } from './token-summary-repository.js';

export class MessageRepository {
  private db: Database;
  private sessionRepo: SessionRepository;
  private tokenRepo: TokenSummaryRepository;

  constructor(db: Database, sessionRepo: SessionRepository, tokenRepo: TokenSummaryRepository) {
    this.db = db;
    this.sessionRepo = sessionRepo;
    this.tokenRepo = tokenRepo;
  }

  /**
   * 批量保存 messages（upsert with UNIQUE constraint）
   * 同时更新 token_summary 表
   * tool 类型消息写入 admin_tool_calls，user/agent 写入 admin_messages
   */
  saveMessages(messages: AdminMessage[]): number {
    if (messages.length === 0) return 0;

    const contentMessages = messages.filter(m => m.message_type !== 'tool');
    const toolMessages = messages.filter(m => m.message_type === 'tool');

    const now = new Date().toISOString();
    let inserted = 0;

    // ---- content messages (user + agent) ----
    if (contentMessages.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO admin_messages (
          source_id, source_module, session_key, message_type, content,
          model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
          is_system_context, timestamp, created_at, source_created_at, platform
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const newlyInsertedContent: boolean[] = [];

      const insertContent = this.db.transaction((rows: AdminMessage[]) => {
        for (const row of rows) {
          const result = stmt.run(
            row.source_id ?? null,
            row.source_module,
            row.session_key,
            row.message_type ?? null,
            row.content ?? null,
            row.model ?? null,
            row.tokens_input ?? null,
            row.tokens_output ?? null,
            row.cost_total ?? null,
            row.cost_input ?? null,
            row.cost_output ?? null,
            row.is_system_context ?? 0,
            row.timestamp,
            now,
            row.source_created_at ?? null,
            row.platform ?? 'openclaw'
          );
          const isNew = result.changes > 0;
          newlyInsertedContent.push(isNew);
          if (isNew) inserted++;
        }
      });

      insertContent(contentMessages);

      // token 统计（仅对 content 消息）
      const sessionKeys = [...new Set(contentMessages.map(r => r.session_key))];
      const sessionAgentMap = this.sessionRepo.getSessionAgentIds(sessionKeys);
      const tokenUpdates = new Map<string, {
        tokensInput: number;
        tokensOutput: number;
        costTotal: number;
        costInput: number;
        costOutput: number;
      }>();

      for (let i = 0; i < contentMessages.length; i++) {
        if (!newlyInsertedContent[i]) continue;
        const row = contentMessages[i];
        const agentId = sessionAgentMap.get(row.session_key);
        if (!agentId) continue;
        const hasTokenData =
          (row.tokens_input != null && row.tokens_input > 0) ||
          (row.tokens_output != null && row.tokens_output > 0) ||
          (row.cost_total != null && row.cost_total > 0);
        if (!hasTokenData) continue;
        const existing = tokenUpdates.get(agentId) || {
          tokensInput: 0, tokensOutput: 0, costTotal: 0, costInput: 0, costOutput: 0,
        };
        tokenUpdates.set(agentId, {
          tokensInput: existing.tokensInput + (row.tokens_input ?? 0),
          tokensOutput: existing.tokensOutput + (row.tokens_output ?? 0),
          costTotal: existing.costTotal + (row.cost_total ?? 0),
          costInput: existing.costInput + (row.cost_input ?? 0),
          costOutput: existing.costOutput + (row.cost_output ?? 0),
        });
      }

      if (tokenUpdates.size > 0) {
        const updates = Array.from(tokenUpdates.entries()).map(([agentId, data]) => ({ agentId, ...data }));
        try {
          this.tokenRepo.batchUpdateTokenSummary(updates);
        } catch (error) {
          logger.error('[DataRepository] Failed to update token_summary:', { error: String(error) });
        }
      }
    }

    // ---- tool messages -> admin_tool_calls ----
    if (toolMessages.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO admin_tool_calls (
          source_id, source_module, session_key, message_type, content,
          created_at, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, metadata,
          tool_name, tool_input
        ) VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `);

      const insertTool = this.db.transaction((rows: AdminMessage[]) => {
        for (const row of rows) {
          const result = stmt.run(
            row.source_id ?? '',
            row.source_module,
            row.session_key,
            row.content ?? null,
            row.timestamp, // 使用 timestamp 作为 created_at
            row.model ?? null,
            row.tokens_input ?? 0,
            row.tokens_output ?? 0,
            row.cost_total ?? null,
            row.cost_input ?? null,
            row.cost_output ?? null,
            (row as any).tool_name ?? null,
            (row as any).tool_input ?? null
          );
          if (result.changes > 0) inserted++;
        }
      });

      insertTool(toolMessages);
    }

    return inserted;
  }

  /**
   * 获取消息列表（合并 admin_messages + admin_tool_calls）
   * - 每页 LIMIT 条 content (user+agent)
   * - tool 消息按时间窗口附加在 content 之后
   * - total 只统计 content 总数（不含 tool）
   */
  getMessages(params: {
    session_key?: string;
    limit?: number;
    offset?: number;
  } = {}): { messages: AdminMessage[]; total: number } {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.session_key) {
      conditions.push('session_key = ?');
      values.push(params.session_key);
    }

    const sessionFilter = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 1. 从 admin_messages 取 content (user+agent)，按 timestamp DESC
    const contentSQL = `
      SELECT * FROM admin_messages ${sessionFilter}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;
    const contentRows = this.db.prepare(contentSQL).all(...values, limit, offset) as AdminMessage[];

    // 2. 计算时间窗口（用于取 tool 消息）
    if (contentRows.length === 0) {
      const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages ${sessionFilter}`).get(...values) as { total: number };
      return { messages: [], total: countRow.total };
    }
    const oldest = contentRows[contentRows.length - 1].timestamp;
    const newest = contentRows[0].timestamp;

    // 3. 从 admin_tool_calls 取时间窗口内的 tool（session_key 相同，时间在窗口内）
    const toolConditions = sessionFilter ? `${sessionFilter} AND` : 'WHERE';
    const toolSQL = `
      SELECT
        id,
        source_id,
        source_module,
        session_key,
        'tool' as message_type,
        content,
        model,
        tokens_input,
        tokens_output,
        cost_total,
        cost_input,
        cost_output,
        0 as is_system_context,
        created_at as timestamp,
        created_at,
        NULL as source_created_at
      FROM admin_tool_calls
      ${toolConditions} created_at BETWEEN ? AND ?
      ORDER BY created_at DESC
    `;
    const toolRows = this.db.prepare(toolSQL).all(...values, oldest, newest) as AdminMessage[];

    // 4. 合并并按 timestamp DESC 排序
    const merged = [...contentRows, ...toolRows].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 5. total = content 总数（不含 tool）
    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages ${sessionFilter}`).get(...values) as { total: number };

    return { messages: merged, total: countRow.total };
  }

  /**
   * 获取指定 agents 的最新 agent-type 消息内容
   * 用于 Overview 卡片展示每个 agent 的最新输出
   *
   * @param agentIds - 要查询的 agent ID 列表
   * @returns Map（agentId → 最新消息内容，没有则 null）
   */
  getLatestAgentMessages(agentIds: string[]): Map<string, string | null> {
    if (agentIds.length === 0) return new Map();

    // session_key 格式：agent:{agentId}:...，用 LIKE 匹配
    const conditions = agentIds.map(() => `session_key LIKE ?`).join(' OR ');
    const params = agentIds.map((id) => `agent:${id}:%`);

    // 过滤掉无意义的内部信号内容
    const rows = this.db.prepare(`
      SELECT m.content, m.session_key
      FROM admin_messages m
      WHERE (${conditions})
        AND m.message_type = 'agent'
        AND LENGTH(COALESCE(m.content, '')) > 0
        AND m.content NOT IN ('NO_REPLY', 'HEARTBEAT_OK')
        AND m.content NOT LIKE '[non-text content:%'
        AND m.content NOT LIKE '[[reply_to:%'
      ORDER BY m.timestamp DESC
    `).all(...params) as Array<{ content: string | null; session_key: string }>;

    // 按 agent 分组，每组只取第一条（最新）
    const result = new Map<string, string | null>();
    for (const row of rows) {
      // 从 session_key 提取 agent_id：agent:{agentId}:...
      const match = row.session_key.match(/^agent:([^:]+):/);
      if (!match) continue;
      const agentId = match[1];
      if (result.has(agentId)) continue; // 已记录过，跳过
      result.set(agentId, row.content);
    }

    // 没有消息的 agent 补 null
    for (const id of agentIds) {
      if (!result.has(id)) result.set(id, null);
    }
    return result;
  }

  /**
   * 对 admin_messages 执行去重
   * 按 (session_key, message_type, timestamp, content前200字符) 分组，
   * 保留每组中 id 最小的记录，删除其余
   */
  deduplicateAdminMessages(): number {
    const dedup = this.db.transaction(() => {
      this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS _dedup_keep AS
        SELECT MIN(id) as keep_id FROM admin_messages
        GROUP BY session_key, message_type, timestamp, substr(content, 1, 200)`);
      const { total } = this.db.prepare('SELECT COUNT(*) as total FROM admin_messages').get() as { total: number };
      const { keep } = this.db.prepare('SELECT COUNT(*) as keep FROM _dedup_keep').get() as { keep: number };
      this.db.exec('DELETE FROM admin_messages WHERE id NOT IN (SELECT keep_id FROM _dedup_keep)');
      this.db.exec('DROP TABLE IF EXISTS _dedup_keep');
      return total - keep;
    });
    return dedup();
  }
}
