/**
 * ice-bubble Admin - 模块存储仓库（简化版）
 *
 * 提供模块数据的核心 CRUD 操作
 */

import type { Database } from 'better-sqlite3';
import { Logger } from '../utils/logger.js';
import { SQLiteError } from './db-manager.js';
import type {
  ModuleRegistry,
  ModuleRuntimeStatus,
  ModuleHealth,
  ModuleQueryParams,
  ModuleListResponse,
  ModuleDetailResponse,
  ModuleHealthSummary,
  ModuleStatus,
  HealthStatus
} from '../types/module.js';

const logger = new Logger('ModuleRepository');

/**
 * SQLite 查询结果行类型
 */
type SqlRow = Record<string, unknown>;

/**
 * 模块存储仓库（核心功能）
 */
export class ModuleRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ========== 模块注册表操作 ==========

  /**
   * 创建或更新模块注册信息
   */
  async upsertModule(module: ModuleRegistry): Promise<ModuleRegistry> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO module_registry (
          module_key, module_name, module_type, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module_key) DO UPDATE SET
          module_name = excluded.module_name,
          module_type = excluded.module_type,
          status = excluded.status,
          version = excluded.version,
          updated_at = excluded.updated_at
        RETURNING *
      `);

      const now = new Date().toISOString();
      const row = stmt.get(
        module.moduleKey,
        module.moduleName,
        module.moduleType,
        module.status,
        module.version || null,
        module.createdAt?.toISOString() || now,
        now
      ) as SqlRow;

      return this.rowToModuleRegistry(row);
    } catch (error) {
      throw new SQLiteError(
        'Failed to upsert module',
        'SQLITE_UPSERT_MODULE_FAILED',
        error
      );
    }
  }

  /**
   * 获取模块列表
   */
  async getModules(params: ModuleQueryParams = {}): Promise<ModuleListResponse> {
    try {
      const page = params.page || 1;
      const limit = params.limit || 20;
      const offset = (page - 1) * limit;

      // 构建查询条件
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params.moduleType) {
        conditions.push('module_type = ?');
        values.push(params.moduleType);
      }

      if (params.status) {
        conditions.push('status = ?');
        values.push(params.status);
      }

      if (params.search) {
        conditions.push('(module_key LIKE ? OR module_name LIKE ?)');
        values.push(`%${params.search}%`, `%${params.search}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // 获取总数
      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as total FROM module_registry ${whereClause}
      `);
      const countResult = countStmt.get(...values) as { total: number };
      const total = countResult.total;

      // 构建排序
      const sortBy = params.sortBy || 'updated_at';
      const sortOrder = params.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // 获取分页数据
      const queryStmt = this.db.prepare(`
        SELECT * FROM module_registry
        ${whereClause}
        ORDER BY ${sortBy} ${sortOrder}
        LIMIT ? OFFSET ?
      `);

      const rows = queryStmt.all(...values, limit, offset) as SqlRow[];
      const modules = rows.map(row => this.rowToModuleRegistry(row));

      return {
        modules,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      throw new SQLiteError(
        'Failed to get modules',
        'SQLITE_GET_MODULES_FAILED',
        error
      );
    }
  }

  /**
   * 获取单个模块详情
   */
  async getModule(moduleKey: string): Promise<ModuleDetailResponse | null> {
    try {
      // 获取模块基本信息
      const moduleStmt = this.db.prepare(`
        SELECT * FROM module_registry WHERE module_key = ?
      `);
      const moduleRow = moduleStmt.get(moduleKey) as SqlRow | undefined;

      if (!moduleRow) {
        return null;
      }

      const module = this.rowToModuleRegistry(moduleRow);

      // 获取运行时状态
      const statusStmt = this.db.prepare(`
        SELECT * FROM module_runtime_status WHERE module_key = ?
      `);
      const statusRow = statusStmt.get(moduleKey) as SqlRow | undefined;
      const runtimeStatus = statusRow ? this.rowToModuleRuntimeStatus(statusRow) : undefined;

      // 获取最新健康状态
      const healthStmt = this.db.prepare(`
        SELECT * FROM module_health 
        WHERE module_key = ? 
        ORDER BY check_time DESC 
        LIMIT 1
      `);
      const healthRow = healthStmt.get(moduleKey) as SqlRow | undefined;
      const health = healthRow ? this.rowToModuleHealth(healthRow) : undefined;

      return {
        module,
        runtimeStatus,
        health
      };
    } catch (error) {
      throw new SQLiteError(
        'Failed to get module details',
        'SQLITE_GET_MODULE_DETAILS_FAILED',
        error
      );
    }
  }

  /**
   * 更新模块状态
   */
  async updateModuleStatus(moduleKey: string, status: ModuleStatus): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE module_registry 
        SET status = ?, updated_at = ?
        WHERE module_key = ?
      `);

      const now = new Date().toISOString();
      const result = stmt.run(status, now, moduleKey);

      if (result.changes === 0) {
        throw new SQLiteError(`Module not found: ${moduleKey}`, 'MODULE_NOT_FOUND');
      }

      logger.info('Module status updated', { moduleKey, status });
    } catch (error) {
      if (error instanceof SQLiteError) throw error;
      throw new SQLiteError(
        'Failed to update module status',
        'SQLITE_UPDATE_MODULE_STATUS_FAILED',
        error
      );
    }
  }

  /**
   * 删除模块
   */
  async deleteModule(moduleKey: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM module_registry WHERE module_key = ?
      `);

      const result = stmt.run(moduleKey);
      return result.changes > 0;
    } catch (error) {
      throw new SQLiteError(
        'Failed to delete module',
        'SQLITE_DELETE_MODULE_FAILED',
        error
      );
    }
  }

  // ========== 模块运行时状态操作 ==========

  /**
   * 更新模块运行时状态
   */
  async upsertModuleRuntimeStatus(status: ModuleRuntimeStatus): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO module_runtime_status (
          module_key, is_running, start_time, uptime_seconds, 
          last_heartbeat, messages_collected, errors_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module_key) DO UPDATE SET
          is_running = excluded.is_running,
          start_time = excluded.start_time,
          uptime_seconds = excluded.uptime_seconds,
          last_heartbeat = excluded.last_heartbeat,
          messages_collected = excluded.messages_collected,
          errors_count = excluded.errors_count,
          updated_at = excluded.updated_at
      `);

      const now = new Date().toISOString();
      stmt.run(
        status.moduleKey,
        status.isRunning ? 1 : 0,
        status.startTime?.toISOString() || null,
        status.uptimeSeconds,
        status.lastHeartbeat?.toISOString() || null,
        status.messagesCollected,
        status.errorsCount,
        status.createdAt?.toISOString() || now,
        now
      );
    } catch (error) {
      throw new SQLiteError(
        'Failed to upsert module runtime status',
        'SQLITE_UPSERT_RUNTIME_STATUS_FAILED',
        error
      );
    }
  }

  /**
   * 获取模块运行时状态
   */
  async getModuleRuntimeStatus(moduleKey: string): Promise<ModuleRuntimeStatus | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM module_runtime_status WHERE module_key = ?
      `);

      const row = stmt.get(moduleKey) as SqlRow | undefined;
      return row ? this.rowToModuleRuntimeStatus(row) : null;
    } catch (error) {
      throw new SQLiteError(
        'Failed to get module runtime status',
        'SQLITE_GET_RUNTIME_STATUS_FAILED',
        error
      );
    }
  }

  /**
   * 更新模块心跳
   */
  async updateModuleHeartbeat(moduleKey: string): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE module_runtime_status 
        SET last_heartbeat = ?, updated_at = ?
        WHERE module_key = ?
      `);

      const now = new Date().toISOString();
      stmt.run(now, now, moduleKey);
    } catch (error) {
      throw new SQLiteError(
        'Failed to update module heartbeat',
        'SQLITE_UPDATE_HEARTBEAT_FAILED',
        error
      );
    }
  }

  // ========== 模块健康状态操作 ==========

  /**
   * 记录模块健康状态
   */
  async recordModuleHealth(health: ModuleHealth): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO module_health (
          module_key, health_status, check_time, details_json, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      const detailsJson = health.details ? JSON.stringify(health.details) : null;
      
      stmt.run(
        health.moduleKey,
        health.healthStatus,
        health.checkTime.toISOString(),
        detailsJson,
        health.message || null,
        health.checkTime.toISOString()
      );
    } catch (error) {
      throw new SQLiteError(
        'Failed to record module health',
        'SQLITE_RECORD_HEALTH_FAILED',
        error
      );
    }
  }

  /**
   * 获取系统健康汇总
   */
  async getHealthSummary(): Promise<ModuleHealthSummary> {
    try {
      // 获取所有模块的最新健康状态
      const stmt = this.db.prepare(`
        WITH latest_health AS (
          SELECT 
            module_key,
            health_status,
            ROW_NUMBER() OVER (PARTITION BY module_key ORDER BY check_time DESC) as rn
          FROM module_health
        )
        SELECT health_status, COUNT(*) as count
        FROM latest_health
        WHERE rn = 1
        GROUP BY health_status
      `);

      const rows = stmt.all() as Array<{ health_status: string; count: number }>;

      // 统计各状态数量
      const summary: ModuleHealthSummary = {
        totalModules: 0,
        healthy: 0,
        warning: 0,
        error: 0,
        unknown: 0,
        lastUpdated: new Date()
      };

      for (const row of rows) {
        const count = row.count;
        summary.totalModules += count;

        switch (row.health_status) {
          case 'healthy':
            summary.healthy = count;
            break;
          case 'warning':
            summary.warning = count;
            break;
          case 'error':
            summary.error = count;
            break;
          default:
            summary.unknown = count;
        }
      }

      return summary;
    } catch (error) {
      throw new SQLiteError(
        'Failed to get health summary',
        'SQLITE_GET_HEALTH_SUMMARY_FAILED',
        error
      );
    }
  }

  // ========== 数据转换方法 ==========

  /**
   * 数据库行转换为 ModuleRegistry
   */
  private rowToModuleRegistry(row: SqlRow): ModuleRegistry {
    return {
      id: row.id as number,
      moduleKey: row.module_key as string,
      moduleName: row.module_name as string,
      moduleType: row.module_type as string,
      status: row.status as ModuleStatus,
      version: row.version as string | undefined,
      createdAt: new Date(row.created_at as string | number | Date),
      updatedAt: new Date(row.updated_at as string | number | Date),
    };
  }

  /**
   * 数据库行转换为 ModuleRuntimeStatus
   */
  private rowToModuleRuntimeStatus(row: SqlRow): ModuleRuntimeStatus {
    return {
      id: row.id as number,
      moduleKey: row.module_key as string,
      isRunning: Boolean(row.is_running),
      startTime: row.start_time ? new Date(row.start_time as string | number | Date) : undefined,
      uptimeSeconds: row.uptime_seconds as number,
      lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat as string | number | Date) : undefined,
      messagesCollected: row.messages_collected as number,
      errorsCount: row.errors_count as number,
      createdAt: new Date(row.created_at as string | number | Date),
      updatedAt: new Date(row.updated_at as string | number | Date),
    };
  }

  /**
   * 数据库行转换为 ModuleHealth
   */
  private rowToModuleHealth(row: SqlRow): ModuleHealth {
    return {
      id: row.id as number,
      moduleKey: row.module_key as string,
      healthStatus: row.health_status as HealthStatus,
      checkTime: new Date(row.check_time as string | number | Date),
      details: row.details_json ? JSON.parse(row.details_json as string) : undefined,
      message: row.message as string | undefined,
    };
  }

  // ========== 模块状态持久化（供 ModuleScheduler 使用） ==========

  /**
   * 保存模块状态（来自 collector 的实时状态）
   * 插入或更新 module_runtime_status 表
   */
  async saveModuleStatus(moduleKey: string, status: {
    status: 'running' | 'stopped' | 'error';
    version?: string;
    runtime?: {
      startTime: string;
      uptimeSeconds: number;
      messagesCollected?: number;
      errorsCount?: number;
    };
    health?: {
      status: 'healthy' | 'warning' | 'error';
      message?: string;
    };
  }): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO module_runtime_status (
          module_key, is_running, start_time, uptime_seconds,
          last_heartbeat, messages_collected, errors_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module_key) DO UPDATE SET
          is_running = excluded.is_running,
          start_time = excluded.start_time,
          uptime_seconds = excluded.uptime_seconds,
          last_heartbeat = excluded.last_heartbeat,
          messages_collected = excluded.messages_collected,
          errors_count = excluded.errors_count,
          updated_at = excluded.updated_at
      `);

      const now = new Date().toISOString();
      stmt.run(
        moduleKey,
        status.status === 'running' ? 1 : 0,
        status.runtime?.startTime || null,
        status.runtime?.uptimeSeconds || 0,
        now,
        status.runtime?.messagesCollected || 0,
        status.runtime?.errorsCount || 0,
        now
      );

      // 同时更新 module_registry 中的 version 和 status
      const regStmt = this.db.prepare(`
        UPDATE module_registry
        SET status = ?, version = ?, updated_at = ?
        WHERE module_key = ?
      `);
      regStmt.run(status.status, status.version || null, now, moduleKey);

      logger.info('Module status saved', { moduleKey, status: status.status });
    } catch (error) {
      throw new SQLiteError(
        'Failed to save module status',
        'SQLITE_SAVE_MODULE_STATUS_FAILED',
        error
      );
    }
  }

  /**
   * 从数据库获取模块状态（供 API 使用）
   */
  async getModuleStatus(moduleKey: string): Promise<{
    status: 'running' | 'stopped' | 'error';
    version?: string;
    runtime?: {
      startTime: string;
      uptimeSeconds: number;
      messagesCollected?: number;
      errorsCount?: number;
    };
    lastFetchedAt: string;
  } | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT r.status, r.version,
               s.is_running, s.start_time, s.uptime_seconds,
               s.messages_collected, s.errors_count, s.updated_at as last_fetched
        FROM module_registry r
        LEFT JOIN module_runtime_status s ON r.module_key = s.module_key
        WHERE r.module_key = ?
      `);

      const row = stmt.get(moduleKey) as Record<string, unknown> | undefined;
      if (!row) return null;

      return {
        status: row.status as 'running' | 'stopped' | 'error',
        version: row.version as string | undefined,
        runtime: row.is_running !== undefined ? {
          startTime: row.start_time as string || '',
          uptimeSeconds: row.uptime_seconds as number || 0,
          messagesCollected: row.messages_collected as number || 0,
          errorsCount: row.errors_count as number || 0,
        } : undefined,
        lastFetchedAt: row.last_fetched as string,
      };
    } catch (error) {
      throw new SQLiteError(
        'Failed to get module status from database',
        'SQLITE_GET_MODULE_STATUS_FAILED',
        error
      );
    }
  }

  /**
   * 获取数据库统计
   */
  async getDatabaseStats(): Promise<{
    moduleCount: number;
    statusCount: number;
    healthCount: number;
  }> {
    try {
      const queries = [
        'SELECT COUNT(*) as count FROM module_registry',
        'SELECT COUNT(*) as count FROM module_runtime_status',
        'SELECT COUNT(*) as count FROM module_health'
      ];

      const results = await Promise.all(
        queries.map(query => {
          const stmt = this.db.prepare(query);
          return stmt.get() as { count: number };
        })
      );

      return {
        moduleCount: results[0].count,
        statusCount: results[1].count,
        healthCount: results[2].count
      };
    } catch (error) {
      throw new SQLiteError(
        'Failed to get database stats',
        'SQLITE_GET_DATABASE_STATS_FAILED',
        error
      );
    }
  }

  /**
   * 注册模块（插入或替换）
   * 用于启动时预注册模块，避免外键约束失败
   */
  async registerModule(module: {
    moduleKey: string;
    moduleName: string;
    moduleType: string;
    status: string;
    version?: string;
  }): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO module_registry
      (module_key, module_name, module_type, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    this.db.prepare(sql).run(
      module.moduleKey,
      module.moduleName,
      module.moduleType,
      module.status,
      module.version || 'unknown'
    );
  }
}