/**
 * Sync API — 同步管理 REST 接口
 *
 * POST /api/sync/reset?module=openclaw       — 重置指定模块的同步游标
 * GET  /api/sync/progress                      — 查看当前同步进度
 */

import { Router } from 'express';
import { logger } from '../../utils/index.js';
import type { DataRouterConfig } from '../data.js';

export interface SyncRouterConfig extends DataRouterConfig {
  dataSyncs?: import('../../data/data-sync.js').DataSync[];
}

export function createSyncRouter(config: SyncRouterConfig): Router {
  const router = Router();
  const { repository, dataSyncs } = config;

  /**
   * POST /api/sync/reset?module=openclaw
   *
   * 手动重置指定模块的同步游标，用于紧急修复场景。
   * 重置后下次同步将从全量拉取开始。
   *
   * Query params:
   *   module (required): 模块标识，如 'openclaw', 'collector-openclaw', 'collector-opencode'
   *   tables (optional): 逗号分隔的表名，如 'admin_messages,admin_model_events'。
   *                       不传则重置该模块的所有同步游标。
   */
  router.post('/sync/reset', (req, res) => {
    const { module: moduleKey, tables } = req.query;

    if (!moduleKey || typeof moduleKey !== 'string') {
      res.status(400).json({ error: 'Missing required query param: module (e.g. ?module=openclaw)' });
      return;
    }

    try {
      // 构建 sync_progress key 前缀：支持 "openclaw" 和 "collector-openclaw" 两种格式
      const prefix = moduleKey.startsWith('collector-')
        ? `${moduleKey}:`
        : `collector-${moduleKey}:`;

      let resetCount: number;

      if (tables && typeof tables === 'string') {
        // 指定表：逐个重置
        const tableList = tables.split(',').map(t => t.trim());
        resetCount = 0;
        for (const table of tableList) {
          const key = `${prefix}${table}`;
          repository.resetSyncProgress(key);
          resetCount++;
        }
      } else {
        // 按前缀批量重置
        resetCount = repository.resetSyncProgressByPrefix(prefix);
      }

      logger.warn(`[SyncAPI] Manual sync cursor reset: module=${moduleKey}, prefix=${prefix}, tables=${tables ?? '*'}, resetCount=${resetCount}`);

      res.json({
        ok: true,
        module: moduleKey,
        prefix,
        resetCount,
        message: `Reset ${resetCount} sync cursor(s) for ${moduleKey}. Next sync cycle will perform a full re-sync.`,
      });
    } catch (error) {
      logger.error('[SyncAPI] Failed to reset sync cursor', { error, moduleKey });
      res.status(500).json({ error: 'Failed to reset sync cursor', detail: String(error) });
    }
  });

  /**
   * GET /api/sync/progress
   *
   * 查看当前所有同步进度
   */
  router.get('/sync/progress', (_req, res) => {
    try {
      const db = repository.getDb();
      const rows = db.prepare('SELECT * FROM sync_progress ORDER BY table_name').all() as Array<{
        table_name: string;
        last_sync_time: string | null;
        last_sync_id: number;
        updated_at: string;
      }>;

      // 构建增强进度数据，包含异常状态指示
      const now = Date.now();
      const enriched = rows.map(row => {
        const anomalies: string[] = [];

        // 游标停滞检测：超过 24h 未更新
        if (row.updated_at) {
          const updatedAt = new Date(row.updated_at).getTime();
          const hoursSinceUpdate = (now - updatedAt) / 3600_000;
          if (!isNaN(updatedAt) && hoursSinceUpdate > 24) {
            anomalies.push(`stale: cursor not updated for ${hoursSinceUpdate.toFixed(1)}h`);
          }
        }

        // 时间戳未来检测
        if (row.last_sync_time) {
          const syncTime = new Date(row.last_sync_time).getTime();
          if (!isNaN(syncTime) && syncTime > now + 3600_000) {
            anomalies.push(`drift: last_sync_time is >1h in the future`);
          }
        }

        return {
          ...row,
          status: anomalies.length > 0 ? 'anomaly' : 'ok',
          anomalies: anomalies.length > 0 ? anomalies : undefined,
        };
      });

      // 同步锁状态
      const syncLockInfos: Array<{ moduleKey: string; isSyncing: boolean }> = [];
      const allCursorAnomalies: Record<string, string | null> = {};

      for (const ds of dataSyncs ?? []) {
        syncLockInfos.push({ moduleKey: ds.getModuleKey(), isSyncing: ds.isSyncInProgress() });
        const anomalies = ds.getCursorAnomalies();
        for (const [key, value] of anomalies) {
          allCursorAnomalies[key] = value;
        }
      }

      res.json({
        progress: enriched,
        syncLocks: syncLockInfos.length > 0 ? syncLockInfos : undefined,
        cursorAnomalies: Object.keys(allCursorAnomalies).length > 0 ? allCursorAnomalies : undefined,
      });
    } catch (error) {
      logger.error('[SyncAPI] Failed to get sync progress', { error });
      res.status(500).json({ error: 'Failed to get sync progress' });
    }
  });

  /**
   * POST /api/sync/cleanup
   *
   * 清理 N 天前的旧数据（messages、sessions、tool_calls、model_events），
   * 归档到 archive 表后删除，并重置同步游标。
   *
   * Body (JSON):
   *   daysOld (optional, default=3): 保留最近 N 天的数据
   *   resetCursors (optional, default=true): 是否重置同步游标
   *   vacuum (optional, default=false): 是否执行 VACUUM
   */
  router.post('/sync/cleanup', (req, res) => {
    try {
      const daysOld = req.body?.daysOld ?? 3;
      const resetCursors = req.body?.resetCursors !== false;
      const doVacuum = req.body?.vacuum === true;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysOld);
      const cutoffStr = cutoff.toISOString();

      logger.warn(`[SyncAPI] Starting data cleanup: daysOld=${daysOld}, cutoff=${cutoffStr}, resetCursors=${resetCursors}`);

      const db = repository.getDb();
      const results: Record<string, number> = {};

      // 1. 归档 3 天前的 messages → admin_messages_archive
      const archiveResult = db.prepare(`
        INSERT OR IGNORE INTO admin_messages_archive
          (source_id, source_module, session_key, message_type, content, model,
           tokens_input, tokens_output, cost_total, cost_input, cost_output,
           is_system_context, timestamp, created_at, source_created_at, archived_at)
        SELECT
          source_id, source_module, session_key, message_type, content, model,
          tokens_input, tokens_output, cost_total, cost_input, cost_output,
          is_system_context, timestamp, created_at, source_created_at, datetime('now')
        FROM admin_messages
        WHERE timestamp < ?
      `).run(cutoffStr);
      results.archivedMessages = archiveResult.changes;

      // 2. 删除已归档的 messages
      const delMsgResult = db.prepare(`
        DELETE FROM admin_messages WHERE timestamp < ?
      `).run(cutoffStr);
      results.deletedMessages = delMsgResult.changes;

      // 3. 删除 3 天前的 tool_calls
      const delToolResult = db.prepare(`
        DELETE FROM admin_tool_calls WHERE created_at < ?
      `).run(cutoffStr);
      results.deletedToolCalls = delToolResult.changes;

      // 4. 删除 3 天前的 model_events
      const delEventsResult = db.prepare(`
        DELETE FROM admin_model_events WHERE timestamp < ?
      `).run(cutoffStr);
      results.deletedModelEvents = delEventsResult.changes;

      // 5. 重建 session message counts
      db.exec(`
        UPDATE admin_sessions SET message_count = (
          SELECT COUNT(*) FROM admin_messages WHERE admin_messages.session_key = admin_sessions.session_key
        )
      `);

      // 6. 删除没有消息的 session（orphan sessions）
      const delSessionsResult = db.prepare(`
        DELETE FROM admin_sessions
        WHERE session_key NOT IN (SELECT DISTINCT session_key FROM admin_messages)
      `).run();
      results.deletedSessions = delSessionsResult.changes;

      // 7. 重置同步游标
      if (resetCursors) {
        const resetCount = repository.resetSyncProgressByPrefix('');
        results.cursorsReset = resetCount;
      }

      // 8. 可选 VACUUM
      if (doVacuum) {
        logger.info('[SyncAPI] Running VACUUM...');
        db.exec('VACUUM');
      }

      logger.warn(`[SyncAPI] Data cleanup completed`, results);
      res.json({ ok: true, cutoff: cutoffStr, results });
    } catch (error) {
      logger.error('[SyncAPI] Data cleanup failed', { error });
      res.status(500).json({ error: 'Failed to cleanup data', detail: String(error) });
    }
  });

  return router;
}
