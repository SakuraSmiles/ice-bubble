/**
 * StatsRepository — 管理统计数据、同步进度、模型事件、数据归档
 *
 * 职责：
 * - 系统统计面板数据（getStats, getSystemStatus）
 * - 同步进度管理（getSyncProgress, updateSyncProgress）
 * - 模型事件存储（saveModelEvents）
 * - 数据归档与清理（archiveOldMessages, archiveOldToolCalls, vacuumIfNeeded, getArchivedMessages）
 * - 归档调度器（startArchiveScheduler）
 * - Session 消息计数重建（rebuildSessionMessageCounts）
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../utils/index.js';
import type { AdminMessage, SyncProgress } from '../data-repository.js';

// Allowed table names for parameterized queries (to prevent SQL injection)
// const ALLOWED_SYNC_TABLES = new Set(['admin_messages', 'admin_model_events', 'admin_tool_calls', 'admin_sessions', 'admin_agents']);
// NOTE: used in getMaxId() via inline allowlist

export class StatsRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ========== 系统统计面板 ==========

  /**
   * 获取数据统计
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    todayMessageCount: number;
    lastSyncTime: string | null;
  } {
    const sessionRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_sessions').get() as { count: number };
    const messageRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_messages').get() as { count: number };
    const agentRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_agents').get() as { count: number };
    const todayRow = this.db.prepare("SELECT COUNT(*) as count FROM admin_messages WHERE date(timestamp) = date('now')").get() as { count: number };
    const syncRow = this.db.prepare("SELECT MAX(last_sync_time) as time FROM sync_progress").get() as { time: string | null };

    return {
      sessionCount: sessionRow.count,
      messageCount: messageRow.count,
      agentCount: agentRow.count,
      todayMessageCount: todayRow.count,
      lastSyncTime: syncRow.time
    };
  }

  /**
   * 获取系统状态统计（用于 timeline meta）
   * 3 条轻量查询：今日噪音过滤数、最近内存整理时间、最近上下文刷新时间
   *
   * 注意：is_system_noise 是 analyzeMessageMeta() 的运行时计算结果，非存储字段。
   * 此处用内容模式匹配近似复刻其判断逻辑（message_type='user' 的噪音消息）。
   */
  getSystemStatus(): { todayFiltered: number; lastCompaction: string | null; lastMemoryFlush: string | null; todayRetryCount: number; todayModelChangeCount: number } {
    const db = this.db;
    const today = new Date().toISOString().slice(0, 10);

    // 近似 is_system_noise 的 SQL 判断：message_type='user' 且匹配各类噪音内容模式
    const filtered = db.prepare(`
      SELECT COUNT(*) as c FROM admin_messages
      WHERE message_type = 'user'
        AND date(timestamp) = date(?)
        AND (
          content = 'HEARTBEAT_OK' OR content = 'NO_REPLY'
          OR content GLOB '[cron:*'
          OR (content GLOB 'System*' AND length(content) > 10 AND content NOT GLOB '*ocrates*')
          OR content GLOB 'Read HEARTBEAT.md*'
          OR content GLOB 'Exec completed*' OR content GLOB 'Exec failed*'
          OR content GLOB '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>*'
          OR content GLOB 'Pre-compaction memory flush*'
          OR content GLOB 'An async command completion event was triggered*'
          OR (content GLOB '[*' AND length(content) < 200 AND (
            content GLOB '*added * files?*' OR content GLOB '*modules transformed*' OR content GLOB '*built in*'
            OR content GLOB 'feat(*' OR content GLOB 'fix(*' OR content GLOB 'style(*'
            OR content GLOB 'refactor(*' OR content GLOB 'chore(*' OR content GLOB 'docs(*' OR content GLOB 'test(*'
          ))
        )
    `).get(today) as { c: number };

    const compaction = db.prepare(
      `SELECT MAX(timestamp) as t FROM admin_messages WHERE content LIKE ?`
    ).get('Pre-compaction memory flush%') as { t: string | null };

    let lastMemoryFlush: string | null = null;
    try {
      const memoryPath = path.join(os.homedir(), '.openclaw/workspace/MEMORY.md');
      const stat = fs.statSync(memoryPath);
      lastMemoryFlush = stat.mtime.toISOString();
    } catch (_e) { void _e; }

    // 今日 Retry 消息数
    const retryCount = db.prepare(`
      SELECT COUNT(*) as c FROM admin_messages
      WHERE date(timestamp) = date(?)
        AND content LIKE '[Retry%'
        AND message_type = 'user'
    `).get(today) as { c: number };

    // 今日 model_change 事件数
    const modelChangeCount = db.prepare(`
      SELECT COUNT(*) as c FROM admin_model_events
      WHERE date(timestamp) = date(?)
        AND event_type = 'model_change'
    `).get(today) as { c: number };

    return {
      todayFiltered: filtered.c || 0,
      lastCompaction: compaction.t || null,
      lastMemoryFlush,
      todayRetryCount: retryCount.c || 0,
      todayModelChangeCount: modelChangeCount.c || 0,
    };
  }

  // ========== 同步进度 ==========

  /**
   * 获取指定表中最大的 id（用于游标漂移校验）
   */
  getMaxId(tableName: string): number | null {
    const idColumn = 'id';
    // 仅对已知包含 id 列的表执行查询
    const allowedTables = ['admin_messages', 'admin_model_events', 'admin_tool_calls'];
    if (!allowedTables.includes(tableName)) return null;
    try {
      const row = this.db.prepare(`SELECT MAX(${idColumn}) as max_id FROM ${tableName}`).get() as { max_id: number | null } | undefined;
      return row?.max_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 重置同步游标（将 last_sync_time 置 null、last_sync_id 置 0）
   * 用于游标漂移自动修复或手动重置 API
   */
  resetSyncProgress(tableName: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_progress (table_name, last_sync_time, last_sync_id, updated_at)
      VALUES (?, NULL, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(table_name) DO UPDATE SET
        last_sync_time = NULL,
        last_sync_id = 0,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(tableName);
    logger.info(`[StatsRepository] Sync cursor reset for ${tableName}`);
  }

  /**
   * 按前缀批量重置同步游标
   */
  resetSyncProgressByPrefix(prefix: string): number {
    const rows = this.db.prepare('SELECT table_name FROM sync_progress WHERE table_name LIKE ?').all(`${prefix}%`) as Array<{ table_name: string }>;
    for (const row of rows) {
      this.resetSyncProgress(row.table_name);
    }
    return rows.length;
  }

  /**
   * 获取同步进度
   */
  getSyncProgress(tableName: string): SyncProgress | null {
    const row = this.db.prepare('SELECT * FROM sync_progress WHERE table_name = ?').get(tableName) as SyncProgress | undefined;
    return row ?? null;
  }

  /**
   * 更新同步进度
   * @param tableName 同步表名
   * @param lastDataTimestamp 实际数据时间戳（毫秒数或 ISO 字符串）。
   *   传入时语义为「数据中最大的时间点」，而非同步执行时间。
   *   不传时回退到 CURRENT_TIMESTAMP（兼容旧逻辑）。
   * @param lastSyncId ID 游标（优先于时间戳游标），用于消除 timestamp 乱序导致的 11% 数据缺口
   */
  updateSyncProgress(tableName: string, lastDataTimestamp?: string | number, lastSyncId?: number): void {
    // 统一转为 ISO 字符串存储（parseSince 能处理毫秒数和 ISO 两种格式）
    const tsValue = lastDataTimestamp != null
      ? (typeof lastDataTimestamp === 'number'
          ? new Date(lastDataTimestamp < 1e12 ? lastDataTimestamp * 1000 : lastDataTimestamp).toISOString()
          : lastDataTimestamp)
      : null;

    // COALESCE(excluded.last_sync_time, CURRENT_TIMESTAMP)：当 tsValue 为 null 时（ID 游标模式），
    // 将 last_sync_time 更新为当前时间，而非保留旧值（避免降级回时间戳模式时使用过期时间戳）。
    const stmt = this.db.prepare(`
      INSERT INTO sync_progress (table_name, last_sync_time, last_sync_id, updated_at)
      VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, 0), CURRENT_TIMESTAMP)
      ON CONFLICT(table_name) DO UPDATE SET
        last_sync_time = COALESCE(excluded.last_sync_time, CURRENT_TIMESTAMP),
        last_sync_id = COALESCE(excluded.last_sync_id, sync_progress.last_sync_id, 0),
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(tableName, tsValue, lastSyncId ?? 0);
  }

  // ========== 模型事件 ==========

  /**
   * 批量保存 model events（INSERT OR IGNORE 基于 event_id 去重）
   */
  saveModelEvents(events: Array<{
    session_key: string;
    event_type: string;
    event_id: string | null;
    data_json: string;
    timestamp: string;
  }>): number {
    if (events.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO admin_model_events (
        session_key, event_type, event_id, data_json, timestamp
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((rows: typeof events) => {
      for (const row of rows) {
        stmt.run(row.session_key, row.event_type, row.event_id, row.data_json, row.timestamp);
      }
    });

    insertMany(events);
    // 无法精确获知 INSERT OR IGNORE 跳过了多少，返回总数
    return events.length;
  }

  // ========== 数据归档 ==========

  /**
   * 归档超过指定天数的 tool_call 消息（7天独立保留策略）
   * 幂等：只归档尚未归档的数据
   * @param daysToKeep 保留天数，默认 7
   * @returns 归档的消息数量
   */
  archiveOldToolCalls(daysToKeep: number = 7): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffISO = cutoffDate.toISOString();

    logger.info(`[DataRepository] Archiving tool_calls older than ${cutoffISO}`);

    let archivedCount = 0;
    this.db.transaction(() => {
      const deleted = this.db.prepare(
        `DELETE FROM admin_tool_calls WHERE created_at < ?`
      ).run(cutoffISO);
      archivedCount = deleted.changes;
    })();

    logger.info(`[DataRepository] Archived ${archivedCount} tool_calls`);
    return archivedCount;
  }

  /**
   * 归档超过指定天数的消息到 archive 表
   * 幂等：只归档尚未归档的数据
   * @param daysToKeep 保留天数，默认 30
   * @returns 归档的消息数量
   */
  archiveOldMessages(daysToKeep: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffISO = cutoffDate.toISOString();

    logger.info(`[DataRepository] Archiving messages older than ${cutoffISO}`);

    const archive = this.db.transaction(() => {
      // 1. 查找需要归档的消息（仅主表数据，不在 archive 中）
      const toArchive = this.db.prepare(`
        SELECT * FROM admin_messages
        WHERE timestamp < ?
          AND id NOT IN (SELECT source_id FROM admin_messages_archive WHERE source_id IS NOT NULL)
      `).all(cutoffISO) as AdminMessage[];

      if (toArchive.length === 0) {
        logger.info('[DataRepository] No messages to archive');
        return 0;
      }

      logger.info(`[DataRepository] Found ${toArchive.length} messages to archive`);

      // 2. 插入到 archive 表
      const insertArchive = this.db.prepare(`
        INSERT OR IGNORE INTO admin_messages_archive (
          source_id, source_module, session_key, message_type, content,
          model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
          is_system_context, timestamp, created_at, source_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const msg of toArchive) {
        insertArchive.run(
          msg.source_id ?? null,
          msg.source_module,
          msg.session_key,
          msg.message_type ?? null,
          msg.content ?? null,
          msg.model ?? null,
          msg.tokens_input ?? null,
          msg.tokens_output ?? null,
          msg.cost_total ?? null,
          msg.cost_input ?? null,
          msg.cost_output ?? null,
          msg.is_system_context ?? 0,
          msg.timestamp,
          msg.created_at,
          msg.source_created_at ?? null
        );
      }

      // 3. 从主表删除已归档的消息
      const sourceIds = toArchive.map(m => m.id).filter(id => id !== undefined);
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',');
        const deleted = this.db.prepare(
          `DELETE FROM admin_messages WHERE id IN (${placeholders})`
        ).run(...sourceIds);
        logger.info(`[DataRepository] Deleted ${deleted.changes} messages from main table`);
      }

      // 4. 可选 VACUUM（由调用方控制频率）
      return toArchive.length;
    });

    const count = archive();
    logger.info(`[DataRepository] Archived ${count} messages`);
    return count;
  }

  /**
   * 执行数据库 VACUUM（清理归档后的碎片空间）
   * 建议在归档后调用，但不要太频繁
   */
  vacuumIfNeeded(): void {
    try {
      this.db.exec('VACUUM');
      logger.info('[DataRepository] VACUUM completed after archival');
    } catch (error) {
      logger.warn('[DataRepository] VACUUM failed:', { error: String(error) });
    }
  }

  /**
   * 获取已归档消息（支持与主表统一查询接口）
   */
  getArchivedMessages(params: {
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages_archive ${whereClause}`).get(...values) as { total: number };

    const rows = this.db.prepare(`
      SELECT * FROM admin_messages_archive ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as AdminMessage[];

    return { messages: rows, total: countRow.total };
  }

  /**
   * 启动每日归档定时器（每天凌晨 3 点）
   * admin_messages: 30天保留；admin_tool_calls: 7天保留（独立调度）
   * @param daysToKeep admin_messages 保留天数，默认 30
   * @param onComplete 归档完成回调
   * @returns interval timer id
   */
  startArchiveScheduler(daysToKeep: number = 30, onComplete?: (count: number) => void): NodeJS.Timeout {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const runArchive = () => {
      try {
        // 归档 admin_messages（30天）
        const count = this.archiveOldMessages(daysToKeep);
        if (count > 0) this.vacuumIfNeeded();
        onComplete?.(count);

        // 归档 admin_tool_calls（7天，独立策略）
        try {
          const toolCount = this.archiveOldToolCalls(7);
          if (toolCount > 0) {
            logger.info(`[DataRepository] Tool calls archive: ${toolCount} cleaned up`);
          }
        } catch (toolErr) {
          logger.error('[DataRepository] Scheduled tool_calls archive failed:', { error: String(toolErr) });
        }
      } catch (error) {
        logger.error('[DataRepository] Scheduled archive failed:', { error: String(error) });
      }
    };

    // 计算到次日凌晨 3 点的毫秒数
    const now = new Date();
    const next3AM = new Date(now);
    next3AM.setHours(3, 0, 0, 0);
    if (next3AM <= now) next3AM.setDate(next3AM.getDate() + 1);
    const initialDelay = next3AM.getTime() - now.getTime();

    logger.info(`[DataRepository] Archive scheduler will first run at ${next3AM.toISOString()} (in ${Math.round(initialDelay / 1000 / 60)}min), then every 24h`);

    // 先执行一次（延迟后），之后每 24 小时执行
    setTimeout(() => {
      runArchive();
      setInterval(runArchive, MS_PER_DAY);
    }, initialDelay);

    // 返回值仅用于兼容，实际清理由进程退出时自然结束
    return setTimeout(() => {}, 0);
  }

  // ========== 数据重建 ==========

  /**
   * 重建会话消息计数
   * 
   * 问题：由于 collector 的 batchInsertMessages 使用 INSERT OR IGNORE，
   * 重复消息被忽略但 message_count 仍按 batch 总量累加，导致统计数据虚高。
   * 
   * 本方法按 admin_messages 实际行数重算所有 session 的 message_count，
   * 并重建 admin_agents 汇总统计。
   * 
   * @returns 重算影响的 session 数量
   */
  rebuildSessionMessageCounts(): number {
    logger.info('[DataRepository] Starting session message count rebuild...');

    // Step 1: 按实际消息数重算所有 session 的 message_count
    const updateSessionCounts = this.db.prepare(`
      UPDATE admin_sessions s
      SET 
        message_count = (
          SELECT COUNT(*) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        ),
        first_message_at = (
          SELECT MIN(m.timestamp) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        ),
        last_message_at = (
          SELECT MAX(m.timestamp) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        )
      WHERE EXISTS (
        SELECT 1 FROM admin_messages m 
        WHERE m.session_key = s.session_key
      )
    `);

    const sessionResult = updateSessionCounts.run();
    logger.info(`[DataRepository] Recomputed message_count for ${sessionResult.changes} sessions`);

    // Step 2: 重算所有 agent 的汇总统计
    const updateAgentStats = this.db.prepare(`
      UPDATE admin_agents aa
      SET 
        message_count = (
          SELECT COALESCE(SUM(message_count), 0) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
        ),
        session_count = (
          SELECT COUNT(DISTINCT session_key) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
        ),
        first_active_at = (
          SELECT MIN(first_message_at) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
            AND first_message_at IS NOT NULL
        ),
        last_active_at = (
          SELECT MAX(last_message_at) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
            AND last_message_at IS NOT NULL
        ),
        updated_at = CURRENT_TIMESTAMP
    `);

    const agentResult = updateAgentStats.run();
    logger.info(`[DataRepository] Recomputed agent stats for ${agentResult.changes} agents`);

    return sessionResult.changes;
  }
}
