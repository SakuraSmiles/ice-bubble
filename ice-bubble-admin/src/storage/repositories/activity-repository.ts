/**
 * ActivityRepository — 管理 agent_activity_daily 表（Agent 热力图数据）
 *
 * 职责：
 * - 增量更新单日活动计数
 * - 批量 upsert 活动记录
 * - 全量重建活动表
 * - 查询指定 agent 的活动数据
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/index.js';

export class ActivityRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 更新单日 agent 活动计数（增量）
   */
  updateAgentActivity(agentId: string, date: string, delta: number = 1): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        message_count = message_count + excluded.message_count
    `);
    stmt.run(agentId, date, delta);
  }

  /**
   * 批量更新 agent 活动计数（用于批量同步）
   * @param records - 活动记录数组 [{agentId, date, count}]
   * 策略：使用增量更新：每次同步只处理新消息，所以用 message_count + excluded.message_count
   * 避免同名日期在多次同步中互相覆盖
   */
  upsertAgentActivityBatch(records: { agentId: string; date: string; count: number }[]): void {
    if (records.length === 0) return;

    // 使用增量更新：每次同步只处理新消息，所以用 message_count + excluded.message_count
    // 避免同名日期在多次同步中互相覆盖
    const upsertStmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        message_count = message_count + excluded.message_count
    `);

    const upsertMany = this.db.transaction((rows: typeof records) => {
      for (const row of rows) {
        upsertStmt.run(row.agentId, row.date, row.count);
      }
    });

    upsertMany(records);
    logger.info(`[DataRepository] Upserted ${records.length} activity records`);
  }

  /**
   * 从 admin_messages 全量重建 agent_activity_daily 表
   * 先清空表，再从所有消息按 (agent_id, date) 重新聚合
   * @returns 重建的记录数和错误信息
   */
  rebuildAgentActivity(): { count: number; error?: string } {
    try {
      const rebuildMany = this.db.transaction(() => {
        // 清空现有数据
        this.db.exec('DELETE FROM agent_activity_daily');

        // 从 admin_messages 聚合，需要通过 session_key 关联 admin_sessions 获取 agent_id
        const insertStmt = this.db.prepare(`
          INSERT INTO agent_activity_daily (agent_id, date, message_count)
          VALUES (?, ?, ?)
        `);

        const rows = this.db.prepare(`
          SELECT
            COALESCE(s.agent_id, 'unknown') as agent_id,
            substr(m.timestamp, 1, 10) as date,
            COUNT(*) as message_count
          FROM admin_messages m
          LEFT JOIN admin_sessions s ON m.session_key = s.session_key
          GROUP BY agent_id, date
          ORDER BY date ASC
        `).all() as { agent_id: string; date: string; message_count: number }[];

        let count = 0;
        for (const row of rows) {
          insertStmt.run(row.agent_id, row.date, row.message_count);
          count++;
        }
        return count;
      });

      const count = rebuildMany();
      logger.info(`[DataRepository] Rebuilt agent_activity_daily: ${count} records`);
      return { count };
    } catch (error: any) {
      logger.error('[DataRepository] rebuildAgentActivity failed:', error);
      return { count: 0, error: error.message };
    }
  }

  /**
   * 获取指定 agent 的活动数据（最近 N 天）
   * @param agentId - agent ID
   * @param days - 查询天数（默认 90 天）
   * @returns 每日活动计数数组 [{date, count}]
   */
  getAgentActivity(agentId: string, days: number = 90): { date: string; count: number }[] {
    const rows = this.db.prepare(`
      SELECT date, message_count as count
      FROM agent_activity_daily
      WHERE agent_id = ?
        AND date >= date('now', ?)
      ORDER BY date ASC
    `).all(agentId, `-${days} days`) as { date: string; count: number }[];

    return rows;
  }
}
