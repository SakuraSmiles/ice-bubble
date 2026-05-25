/**
 * TokenSummaryRepository — 管理 token_summary 表的查询与更新
 *
 * 职责：
 * - Token 消耗统计查询（按 agent/date 聚合）
 * - 增量更新 token_summary（每日一条记录）
 * - 全量重建 token_summary（从 admin_messages 重新聚合）
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/index.js';

export class TokenSummaryRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Token 统计聚合接口（从每日数据聚合）
   * @param agentId 可选，按 agent_id 筛选
   * @param date 可选，按日期筛选（格式 'YYYY-MM-DD'），不传则返回所有日期的汇总
   */
  getTokenSummary(agentId?: string, date?: string): Array<{
    agent_id: string;
    date: string;
    total_tokens_input: number;
    total_tokens_output: number;
    total_cost: number;
    cost_input: number;
    cost_output: number;
    message_count: number;
    updated_at: string;
  }> {
    // 有具体日期：返回该日期的数据（按 agent 分组）
    if (date) {
      const rows = this.db.prepare(`
        SELECT
          agent_id,
          date,
          SUM(total_tokens_input) as total_tokens_input,
          SUM(total_tokens_output) as total_tokens_output,
          SUM(total_cost) as total_cost,
          SUM(cost_input) as cost_input,
          SUM(cost_output) as cost_output,
          SUM(message_count) as message_count,
          MIN(created_at) as created_at,
          MAX(updated_at) as updated_at
        FROM token_summary
        WHERE date = ?
        GROUP BY agent_id, date
        ORDER BY MAX(updated_at) DESC
      `).all(date) as Array<{
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
        updated_at: string;
      }>;
      return rows;
    }

    // 无具体日期：返回每个 agent 的所有日期汇总（date='all'）
    if (agentId) {
      const row = this.db.prepare(`
        SELECT
          agent_id,
          'all' as date,
          SUM(total_tokens_input) as total_tokens_input,
          SUM(total_tokens_output) as total_tokens_output,
          SUM(total_cost) as total_cost,
          SUM(cost_input) as cost_input,
          SUM(cost_output) as cost_output,
          SUM(message_count) as message_count,
          MIN(created_at) as created_at,
          MAX(updated_at) as updated_at
        FROM token_summary
        WHERE agent_id = ?
        GROUP BY agent_id
      `).get(agentId) as {
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
        updated_at: string;
      } | undefined;
      return row ? [row] : [];
    }

    // 无 agentId 无 date：返回所有 agent 的所有日期汇总（每个 agent 一行，date='all'）
    return this.db.prepare(`
      SELECT
        agent_id,
        'all' as date,
        SUM(total_tokens_input) as total_tokens_input,
        SUM(total_tokens_output) as total_tokens_output,
        SUM(total_cost) as total_cost,
        SUM(cost_input) as cost_input,
        SUM(cost_output) as cost_output,
        SUM(message_count) as message_count,
        MIN(created_at) as created_at,
        MAX(updated_at) as updated_at
      FROM token_summary
      GROUP BY agent_id
      ORDER BY MAX(updated_at) DESC
    `).all() as Array<{
      agent_id: string;
      date: string;
      total_tokens_input: number;
      total_tokens_output: number;
      total_cost: number;
      cost_input: number;
      cost_output: number;
      message_count: number;
      updated_at: string;
    }>;
  }

  /**
   * 批量更新 token_summary（在事务内执行，每日一条记录）
   *
   * 原为 DataRepository 的 private 方法，现公开以供 MessageRepository 调用。
   */
  batchUpdateTokenSummary(
    updates: Array<{
      agentId: string;
      tokensInput: number;
      tokensOutput: number;
      costTotal: number;
      costInput: number;
      costOutput: number;
    }>
  ): void {
    if (updates.length === 0) return;

    // 使用本地时区（北京时间 UTC+8）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    const nowISO = now.toISOString();

    const upsertSQL = `
      INSERT INTO token_summary
        (agent_id, date, total_tokens_input, total_tokens_output, total_cost, cost_input, cost_output, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        total_tokens_input = total_tokens_input + excluded.total_tokens_input,
        total_tokens_output = total_tokens_output + excluded.total_tokens_output,
        total_cost = total_cost + excluded.total_cost,
        cost_input = cost_input + excluded.cost_input,
        cost_output = cost_output + excluded.cost_output,
        message_count = message_count + 1,
        updated_at = excluded.updated_at
    `;
    const stmt = this.db.prepare(upsertSQL);

    for (const update of updates) {
      stmt.run(
        update.agentId,
        today,
        update.tokensInput,
        update.tokensOutput,
        update.costTotal,
        update.costInput,
        update.costOutput,
        nowISO,
        nowISO
      );
    }
    logger.info(`[DataRepository] Batch updated token_summary for ${updates.length} agents on ${today}`);
  }

  /**
   * 全量重建 token_summary（从 admin_messages 按天聚合）
   * @returns 受影响的 agent 数量
   */
  rebuildTokenSummary(): { affected_agents: number; duration_ms: number } {
    logger.info('[DataRepository] Starting token_summary rebuild...');
    const start = Date.now();

    const rebuild = this.db.transaction(() => {
      // 1. 清空 token_summary 表
      this.db.prepare('DELETE FROM token_summary').run();

      // 2. 按 agent_id 和 date 聚合 admin_messages 的 token 数据（使用北京时间 UTC+8）
      const rows = this.db.prepare(`
        SELECT
          s.agent_id,
          DATE(datetime(m.created_at, '+8 hours')) as date,
          COALESCE(SUM(CAST(m.tokens_input AS INTEGER)), 0) as total_tokens_input,
          COALESCE(SUM(CAST(m.tokens_output AS INTEGER)), 0) as total_tokens_output,
          COALESCE(SUM(CAST(m.cost_total AS REAL)), 0) as total_cost,
          COALESCE(SUM(CAST(m.cost_input AS REAL)), 0) as cost_input,
          COALESCE(SUM(CAST(m.cost_output AS REAL)), 0) as cost_output,
          COUNT(*) as message_count
        FROM admin_messages m
        INNER JOIN admin_sessions s ON m.session_key = s.session_key
        WHERE s.agent_id IS NOT NULL
          AND s.session_key NOT LIKE '%checkpoint%'
          AND (
            m.tokens_input IS NOT NULL OR
            m.tokens_output IS NOT NULL OR
            m.cost_total IS NOT NULL
          )
        GROUP BY s.agent_id, DATE(datetime(m.created_at, '+8 hours'))
      `).all() as Array<{
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
      }>;

      // 3. 重新插入（按 date 分组，每日一条）
      const insertSQL = `
        INSERT INTO token_summary
          (agent_id, date, total_tokens_input, total_tokens_output, total_cost, cost_input, cost_output, message_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const stmt = this.db.prepare(insertSQL);
      const now = new Date().toISOString();
      for (const row of rows) {
        stmt.run(
          row.agent_id,
          row.date,
          row.total_tokens_input,
          row.total_tokens_output,
          row.total_cost,
          row.cost_input,
          row.cost_output,
          row.message_count,
          now,
          now
        );
      }

      // 返回去重后的 agent 数量
      const agentIds = new Set(rows.map(r => r.agent_id));
      return agentIds.size;
    });

    const affected_agents = rebuild();
    const duration_ms = Date.now() - start;
    logger.info(`[DataRepository] Token summary rebuilt: ${affected_agents} agents in ${duration_ms}ms`);

    return { affected_agents, duration_ms };
  }
}
