/**
 * ice-bubble Admin - 数据库管理器
 *
 * 负责 SQLite 数据库的初始化和生命周期管理
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { Logger } from '../utils/logger.js';

const logger = new Logger('DBManager');

/**
 * SQLite 错误类
 */
export class SQLiteError extends Error {
  constructor(
    message: string,
    public code: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = 'SQLiteError';
  }
}

/**
 * 数据库配置
 */
export interface DatabaseConfig {
  /**
   * 数据库文件路径
   * @example '../data/admin.db'
   */
  dbPath: string;

  /**
   * 是否启用 WAL 模式
   * @default true
   */
  walMode?: boolean;

  /**
   * 是否启用外键约束
   * @default true
   */
  foreignKeys?: boolean;

  /**
   * 性能优化配置
   */
  performance?: {
    /**
     * 缓存大小 (KB)
     * @default -64000 (64MB)
     */
    cacheSize?: number;

    /**
     * 内存映射大小 (bytes)
     * @default 268435456 (256MB)
     */
    mmapSize?: number;

    /**
     * 页面大小 (bytes)
     * @default 4096
     */
    pageSize?: number;

    /**
     * 繁忙超时 (ms)
     * @default 5000
     */
    busyTimeout?: number;

    /**
     * WAL 日志大小限制 (bytes)
     * @default 67108864 (64MB)
     */
    journalSizeLimit?: number;
  };
}

/**
 * 数据库管理器
 *
 * 职责：
 * - 数据库初始化和生命周期管理
 * - 表结构创建和维护
 * - 连接池管理
 * - 性能优化配置
 */
export class DBManager {
  private db: DatabaseType | null = null;
  private dbPath: string = '';
  private isInitialized: boolean = false;

  // ========== 生命周期 ==========

  /**
   * 初始化数据库
   * - 创建数据库文件
   * - 创建表结构
   * - 启用性能优化配置
   */
  async init(config: DatabaseConfig): Promise<void> {
    try {
      this.dbPath = config.dbPath;

      // 创建数据库连接
      this.db = new Database(config.dbPath);

      // 启用 WAL 模式（默认开启）
      if (config.walMode !== false) {
        this.db.pragma('journal_mode = WAL');
      }

      // 启用外键约束（默认开启）
      if (config.foreignKeys !== false) {
        this.db.pragma('foreign_keys = ON');
      }

      // 应用性能优化配置
      this.applyPerformanceConfig(config.performance);

      // 创建表结构
      await this.createTables();

      this.isInitialized = true;
      logger.info('Database initialized successfully', { dbPath: config.dbPath });
    } catch (error) {
      throw new SQLiteError(
        'Failed to initialize SQLite database',
        'SQLITE_INIT_FAILED',
        error
      );
    }
  }

  /**
   * 应用性能优化配置
   */
  private applyPerformanceConfig(performance?: DatabaseConfig['performance']): void {
    if (!this.db) return;

    // 默认配置
    const config = {
      cacheSize: -64000,        // 64MB
      mmapSize: 268435456,      // 256MB
      pageSize: 4096,
      busyTimeout: 5000,        // 5秒
      journalSizeLimit: 67108864, // 64MB
      ...performance
    };

    // 应用配置
    this.db.pragma(`cache_size = ${config.cacheSize}`);
    this.db.pragma(`mmap_size = ${config.mmapSize}`);
    this.db.pragma(`page_size = ${config.pageSize}`);
    this.db.pragma(`busy_timeout = ${config.busyTimeout}`);
    this.db.pragma(`journal_size_limit = ${config.journalSizeLimit}`);

    // 其他优化配置
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('auto_vacuum = INCREMENTAL');
  }

  /**
   * 创建数据库表结构
   */
  private async createTables(): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    try {
      // 1. 模块注册表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_registry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL UNIQUE,
          module_name TEXT NOT NULL,
          module_type TEXT NOT NULL,
          status TEXT NOT NULL,
          version TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_module_registry_type ON module_registry(module_type);
        CREATE INDEX IF NOT EXISTS idx_module_registry_status ON module_registry(status);
        CREATE INDEX IF NOT EXISTS idx_module_registry_updated ON module_registry(updated_at);
      `);

      // 2. 模块运行时状态表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_runtime_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL UNIQUE,
          is_running BOOLEAN NOT NULL DEFAULT 0,
          start_time TIMESTAMP,
          uptime_seconds INTEGER DEFAULT 0,
          last_heartbeat TIMESTAMP,
          messages_collected INTEGER DEFAULT 0,
          errors_count INTEGER DEFAULT 0,
          last_poll_time TEXT,
          last_error TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_status_running ON module_runtime_status(is_running);
        CREATE INDEX IF NOT EXISTS idx_module_status_heartbeat ON module_runtime_status(last_heartbeat);
        CREATE INDEX IF NOT EXISTS idx_module_status_updated ON module_runtime_status(updated_at);
      `);

      // 3. 模块健康状态表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_health (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL,
          health_status TEXT NOT NULL,
          check_time TIMESTAMP NOT NULL,
          details_json TEXT,
          message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_health_status ON module_health(health_status);
        CREATE INDEX IF NOT EXISTS idx_module_health_check_time ON module_health(check_time);
        CREATE INDEX IF NOT EXISTS idx_module_health_module ON module_health(module_key, check_time);
      `);

      // 4. 模块配置表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL,
          config_key TEXT NOT NULL,
          config_value TEXT NOT NULL,
          config_type TEXT NOT NULL,
          description TEXT,
          is_required BOOLEAN DEFAULT 0,
          is_secret BOOLEAN DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(module_key, config_key),
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_config_module ON module_config(module_key);
        CREATE INDEX IF NOT EXISTS idx_module_config_key ON module_config(config_key);
      `);

      // 5. 模块事件表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_event (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_level TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT,
          timestamp TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_event_module ON module_event(module_key);
        CREATE INDEX IF NOT EXISTS idx_module_event_type ON module_event(event_type);
        CREATE INDEX IF NOT EXISTS idx_module_event_level ON module_event(event_level);
        CREATE INDEX IF NOT EXISTS idx_module_event_timestamp ON module_event(timestamp);
      `);

      // 6. 模块依赖表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_dependency (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_module_key TEXT NOT NULL,
          target_module_key TEXT NOT NULL,
          dependency_type TEXT NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (source_module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE,
          FOREIGN KEY (target_module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE,
          UNIQUE(source_module_key, target_module_key)
        );

        CREATE INDEX IF NOT EXISTS idx_module_dependency_source ON module_dependency(source_module_key);
        CREATE INDEX IF NOT EXISTS idx_module_dependency_target ON module_dependency(target_module_key);
      `);

      // 7. 模块版本表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_version (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL,
          version TEXT NOT NULL,
          changelog TEXT,
          release_date TIMESTAMP NOT NULL,
          is_current BOOLEAN DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(module_key, version),
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_version_module ON module_version(module_key);
        CREATE INDEX IF NOT EXISTS idx_module_version_current ON module_version(is_current);
        CREATE INDEX IF NOT EXISTS idx_module_version_date ON module_version(release_date);
      `);

      // 8. 模块统计表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS module_statistics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          module_key TEXT NOT NULL,
          period TEXT NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          uptime_percentage REAL DEFAULT 0,
          total_requests INTEGER DEFAULT 0,
          total_errors INTEGER DEFAULT 0,
          avg_response_time REAL DEFAULT 0,
          peak_concurrency INTEGER DEFAULT 0,
          data_volume REAL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(module_key, period, timestamp),
          FOREIGN KEY (module_key) REFERENCES module_registry(module_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_module_stats_module ON module_statistics(module_key);
        CREATE INDEX IF NOT EXISTS idx_module_stats_period ON module_statistics(period);
        CREATE INDEX IF NOT EXISTS idx_module_stats_timestamp ON module_statistics(timestamp);
      `);

      // 9. 数据库版本表（用于数据迁移）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 10. 数据管理 - sessions 表（存储从 collector 同步的会话数据）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          session_key TEXT PRIMARY KEY,
          source_module TEXT NOT NULL,
          agent_id TEXT,
          channel TEXT,
          message_count INTEGER DEFAULT 0,
          first_message_at TIMESTAMP,
          last_message_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source_created_at TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_admin_sessions_agent ON admin_sessions(agent_id);
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_channel ON admin_sessions(channel);
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_updated ON admin_sessions(updated_at);
      `);

      // 11. 数据管理 - messages 表（存储从 collector 同步的消息数据）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER,
          source_module TEXT NOT NULL,
          session_key TEXT NOT NULL,
          message_type TEXT,
          content TEXT,
          model TEXT,
          tokens_input INTEGER,
          tokens_output INTEGER,
          timestamp TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source_created_at TIMESTAMP,
          UNIQUE(session_key, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_admin_messages_session ON admin_messages(session_key);
        CREATE INDEX IF NOT EXISTS idx_admin_messages_timestamp ON admin_messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_admin_messages_type ON admin_messages(message_type);
      `);

      // 12. 数据管理 - agents 表（聚合 agent 统计数据）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_agents (
          agent_id TEXT PRIMARY KEY,
          agent_name TEXT,
          session_count INTEGER DEFAULT 0,
          message_count INTEGER DEFAULT 0,
          first_active_at TIMESTAMP,
          last_active_at TIMESTAMP,
          model TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_admin_agents_last_active ON admin_agents(last_active_at);
      `);

      // 13. 数据管理 - sync_progress 表（记录同步进度）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_progress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL UNIQUE,
          last_sync_time TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      logger.info('Database tables created successfully');
    } catch (error) {
      throw new SQLiteError(
        'Failed to create database tables',
        'SQLITE_CREATE_TABLES_FAILED',
        error
      );
    }
  }

  /**
   * 获取数据库连接
   */
  getConnection(): DatabaseType {
    if (!this.db || !this.isInitialized) {
      throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
    }
    return this.db;
  }

  /**
   * 检查数据库是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * 执行数据库迁移
   */
  async migrate(version: number): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    try {
      // 检查当前版本
      const currentVersion = this.getCurrentSchemaVersion();

      if (currentVersion >= version) {
        logger.info('Database already at required version', { currentVersion, targetVersion: version });
        return;
      }

      // 执行迁移
      await this.executeMigration(currentVersion, version);

      // 更新版本
      this.updateSchemaVersion(version);

      logger.info('Database migration completed', { from: currentVersion, to: version });
    } catch (error) {
      throw new SQLiteError(
        'Failed to migrate database',
        'SQLITE_MIGRATION_FAILED',
        error
      );
    }
  }

  /**
   * 获取当前数据库版本
   */
  private getCurrentSchemaVersion(): number {
    if (!this.db) return 0;

    try {
      const stmt = this.db.prepare('SELECT MAX(version) as version FROM schema_version');
      const result = stmt.get() as { version: number | null };
      return result.version || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 更新数据库版本
   */
  private updateSchemaVersion(version: number): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO schema_version (version, applied_at)
      VALUES (?, CURRENT_TIMESTAMP)
    `);
    stmt.run(version);
  }

  /**
   * 执行迁移脚本
   */
  private async executeMigration(fromVersion: number, toVersion: number): Promise<void> {
    if (!this.db) return;

    // 这里可以添加具体的迁移逻辑
    // 例如：根据版本号执行不同的 SQL 脚本
    for (let v = fromVersion + 1; v <= toVersion; v++) {
      logger.info(`Executing migration to version ${v}`);
      // 执行版本特定的迁移
      await this.executeVersionMigration(v);
    }
  }

  /**
   * 执行特定版本的迁移
   */
  private async executeVersionMigration(version: number): Promise<void> {
    if (!this.db) return;

    // 这里可以根据版本号执行不同的迁移逻辑
    switch (version) {
      case 1:
        // 初始版本，表已创建
        break;
      case 2:
        // 迁移：给 admin_agents 表添加 model 字段
        this.db.exec(`
          ALTER TABLE admin_agents ADD COLUMN model TEXT;
        `);
        logger.info('Migration v2: added model column to admin_agents');
        break;
      // 可以添加更多版本的迁移逻辑
      default:
        logger.warn(`No migration defined for version ${version}`);
    }
  }

  /**
   * 备份数据库
   */
  async backup(backupPath: string): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    try {
      // 简单备份：复制数据库文件
      const fs = await import('fs');
      const { copyFileSync } = fs;
      
      copyFileSync(this.dbPath, backupPath);
      
      logger.info('Database backup completed', { backupPath });
    } catch (error) {
      throw new SQLiteError(
        'Failed to backup database',
        'SQLITE_BACKUP_FAILED',
        error
      );
    }
  }

  /**
   * 优化数据库性能
   */
  async optimize(): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    try {
      // 分析表以优化查询计划
      this.db.exec('ANALYZE');

      // 重新构建索引
      this.db.exec('REINDEX');

      // 清理碎片
      this.db.exec('VACUUM');

      logger.info('Database optimization completed');
    } catch (error) {
      throw new SQLiteError(
        'Failed to optimize database',
        'SQLITE_OPTIMIZE_FAILED',
        error
      );
    }
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      logger.info('Database connection closed');
    }
  }

  /**
   * 获取数据库统计信息
   */
  async getStats(): Promise<{
    totalSizeMB: number;
    tableCount: number;
    rowCount: number;
    lastBackup?: Date;
  }> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    try {
      // 获取数据库文件大小
      const fs = await import('fs');
      const stats = fs.statSync(this.dbPath);
      const totalSizeMB = stats.size / (1024 * 1024);

      // 获取表数量
      const tableStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM sqlite_master 
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `);
      const tableResult = tableStmt.get() as { count: number };

      // 获取总行数
      const rowStmt = this.db.prepare(`
        SELECT SUM(cnt) as total FROM (
          SELECT COUNT(*) as cnt FROM module_registry
          UNION ALL
          SELECT COUNT(*) as cnt FROM module_runtime_status
          UNION ALL
          SELECT COUNT(*) as cnt FROM module_health
          UNION ALL
          SELECT COUNT(*) as cnt FROM module_config
          UNION ALL
          SELECT COUNT(*) as cnt FROM module_event
        )
      `);
      const rowResult = rowStmt.get() as { total: number };

      return {
        totalSizeMB: Math.round(totalSizeMB * 100) / 100,
        tableCount: tableResult.count,
        rowCount: rowResult.total || 0,
      };
    } catch (error) {
      throw new SQLiteError(
        'Failed to get database stats',
        'SQLITE_STATS_FAILED',
        error
      );
    }
  }
}