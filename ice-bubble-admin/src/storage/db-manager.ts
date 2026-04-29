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
          latency_ms INTEGER DEFAULT 0,
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
          source_id TEXT NOT NULL DEFAULT '',
          source_module TEXT NOT NULL,
          session_key TEXT NOT NULL,
          message_type TEXT,
          content TEXT,
          model TEXT,
          tokens_input INTEGER,
          tokens_output INTEGER,
          cost_total REAL,
          cost_input REAL,
          cost_output REAL,
          is_system_context INTEGER NOT NULL DEFAULT 0,
          timestamp TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source_created_at TIMESTAMP,
          UNIQUE(session_key, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_admin_messages_session ON admin_messages(session_key);
        CREATE INDEX IF NOT EXISTS idx_admin_messages_timestamp ON admin_messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_admin_messages_type ON admin_messages(message_type);
      `);

      // 11b. 数据管理 - tool_calls 表（存储 tool 类型消息，独立归档策略）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL DEFAULT '',
          source_module TEXT NOT NULL DEFAULT '',
          session_key TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'tool',
          content TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          model TEXT,
          tokens_input INTEGER DEFAULT 0,
          tokens_output INTEGER DEFAULT 0,
          cost_total REAL,
          cost_input REAL,
          cost_output REAL,
          metadata TEXT,
          UNIQUE(source_module, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON admin_tool_calls(session_key);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON admin_tool_calls(created_at);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_type ON admin_tool_calls(message_type);
      `);

      // 12. 数据管理 - agents 表（聚合 agent 统计数据）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_agents (
          agent_id TEXT PRIMARY KEY,
          agent_name TEXT,
          workspace TEXT,
          source TEXT DEFAULT 'openclaw',
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
        // 迁移 v2（保留位置兼容性）
        break;
      case 3:
        // 迁移：给 admin_agents 表添加 model 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_agents)').all() as Array<{ name: string }>;
          const hasModel = colInfo.some(col => col.name === 'model');
          if (!hasModel) {
            this.db.exec(`ALTER TABLE admin_agents ADD COLUMN model TEXT;`);
            logger.info('Migration v3: added model column to admin_agents');
          } else {
            logger.info('Migration v3: model column already exists, skipping');
          }
        }
        break;
      case 4:
        // 迁移：给 admin_agents 表添加 avatar 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_agents)').all() as Array<{ name: string }>;
          const hasAvatar = colInfo.some(col => col.name === 'avatar');
          if (!hasAvatar) {
            this.db.exec(`ALTER TABLE admin_agents ADD COLUMN avatar TEXT;`);
            logger.info('Migration v4: added avatar column to admin_agents');
          } else {
            logger.info('Migration v4: avatar column already exists, skipping');
          }
        }
        break;
      case 5:
        // 迁移：给 admin_agents 表添加 source 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_agents)').all() as Array<{ name: string }>;
          const hasSource = colInfo.some(col => col.name === 'source');
          if (!hasSource) {
            this.db.exec(`ALTER TABLE admin_agents ADD COLUMN source TEXT DEFAULT 'openclaw';`);
            logger.info('Migration v5: added source column to admin_agents');
          } else {
            logger.info('Migration v5: source column already exists, skipping');
          }
        }
        break;
      // 可以添加更多版本的迁移逻辑
      case 6:
        // 迁移：创建 agent_activity_daily 表（活动热力图预聚合表）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_activity_daily (
            agent_id TEXT NOT NULL,
            date TEXT NOT NULL,
            message_count INTEGER DEFAULT 0,
            PRIMARY KEY (agent_id, date)
          );
        `);
        logger.info('Migration v6: created agent_activity_daily table');
        break;
      case 7:
        // 迁移：给 admin_agents 表添加 workspace 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_agents)').all() as Array<{ name: string }>;
          const hasWorkspace = colInfo.some(col => col.name === 'workspace');
          if (!hasWorkspace) {
            this.db.exec(`ALTER TABLE admin_agents ADD COLUMN workspace TEXT;`);
            logger.info('Migration v7: added workspace column to admin_agents');
          } else {
            logger.info('Migration v7: workspace column already exists, skipping');
          }
        }
        break;
      case 8:
        // 迁移：给 admin_messages 表添加 token cost 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_messages)').all() as Array<{ name: string }>;
          if (!colInfo.some(col => col.name === 'cost_total')) {
            this.db.exec(`ALTER TABLE admin_messages ADD COLUMN cost_total REAL;`);
          }
          if (!colInfo.some(col => col.name === 'cost_input')) {
            this.db.exec(`ALTER TABLE admin_messages ADD COLUMN cost_input REAL;`);
          }
          if (!colInfo.some(col => col.name === 'cost_output')) {
            this.db.exec(`ALTER TABLE admin_messages ADD COLUMN cost_output REAL;`);
          }
          logger.info('Migration v8: added cost columns to admin_messages');
        }
        break;
      case 9:
        // 迁移：创建 token_summary 表（token 统计聚合表）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS token_summary (
            agent_id TEXT PRIMARY KEY,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cost REAL DEFAULT 0,
            cost_input REAL DEFAULT 0,
            cost_output REAL DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logger.info('Migration v9: created token_summary table');
        break;
      case 10:
        // 迁移：token_summary 从全局聚合改为每日聚合
        // 1. 创建新表结构
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS token_summary_new (
            agent_id TEXT NOT NULL,
            date TEXT NOT NULL,
            total_tokens_input INTEGER DEFAULT 0,
            total_tokens_output INTEGER DEFAULT 0,
            total_cost REAL DEFAULT 0,
            cost_input REAL DEFAULT 0,
            cost_output REAL DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_id, date)
          );
        `);
        // 2. 从旧表迁移数据：按 agent_id 聚合，所有数据的 date 设为 '1970-01-01'（表示历史无日期数据）
        this.db.exec(`
          INSERT OR IGNORE INTO token_summary_new
            (agent_id, date, total_tokens_input, total_tokens_output, total_cost, cost_input, cost_output, message_count, created_at, updated_at)
          SELECT
            agent_id,
            '1970-01-01' as date,
            total_input_tokens,
            total_output_tokens,
            total_cost,
            cost_input,
            cost_output,
            message_count,
            created_at,
            updated_at
          FROM token_summary;
        `);
        // 3. 删除旧表，重命名新表
        this.db.exec(`
          DROP TABLE token_summary;
          ALTER TABLE token_summary_new RENAME TO token_summary;
        `);
        logger.info('Migration v10: token_summary migrated to daily aggregation schema');
        break;
      case 11:
        // 迁移：给 admin_messages 表添加 is_system_context 字段
        // 安全检查：仅当列不存在时才执行（适用于 admin_messages 在 createTables 中已创建的情况）
        const colInfo = this.db.prepare('PRAGMA table_info(admin_messages)').all() as Array<{ name: string }>;
        const hasSystemContext = colInfo.some(col => col.name === 'is_system_context');
        if (!hasSystemContext) {
          this.db.exec(`
            ALTER TABLE admin_messages ADD COLUMN is_system_context INTEGER NOT NULL DEFAULT 0;
          `);
          logger.info('Migration v11: added is_system_context column to admin_messages');
        } else {
          logger.info('Migration v11: is_system_context column already exists, skipping');
        }
        break;
      case 12:
        // 迁移 v12:
        // 1. 创建 admin_messages_archive 表
        // 2. 修复 admin_messages.source_id 的 UNIQUE 约束问题（NULL 值导致约束失效）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS admin_messages_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER,
            source_module TEXT NOT NULL,
            session_key TEXT NOT NULL,
            message_type TEXT,
            content TEXT,
            model TEXT,
            tokens_input INTEGER,
            tokens_output INTEGER,
            cost_total REAL,
            cost_input REAL,
            cost_output REAL,
            is_system_context INTEGER NOT NULL DEFAULT 0,
            timestamp TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            source_created_at TIMESTAMP,
            archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_key, source_id)
          );
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_archive_session ON admin_messages_archive(session_key);
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_archive_timestamp ON admin_messages_archive(timestamp);
        `);
        logger.info('Migration v12: created admin_messages_archive table');
        break;
      case 13:
        // 迁移 v13: 修复 admin_messages.source_id UNIQUE 约束问题
        // SQLite UNIQUE(session_key, source_id) 中 NULL 值不被约束保护（NULL ≠ NULL），
        // 导致同一 session_key 可插入多条 source_id=NULL 的消息。
        // 修复：将 source_id 改为 NOT NULL DEFAULT ''，使 UNIQUE 约束正常工作。
        {
          // 检查是否需要迁移（仅当存在 NULL source_id 时才需要重建表）
          const nullCount = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM admin_messages WHERE source_id IS NULL'
          ).get() as { cnt: number };

          if (nullCount.cnt > 0) {
            logger.info(`Migration v13: found ${nullCount.cnt} NULL source_id values, rebuilding table...`);
            this.db.exec('BEGIN TRANSACTION');
            try {
              this.db.exec('ALTER TABLE admin_messages RENAME TO admin_messages_old');
              this.db.exec(`
                CREATE TABLE admin_messages (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  source_id TEXT NOT NULL DEFAULT '',
                  source_module TEXT NOT NULL,
                  session_key TEXT NOT NULL,
                  message_type TEXT,
                  content TEXT,
                  model TEXT,
                  tokens_input INTEGER,
                  tokens_output INTEGER,
                  cost_total REAL,
                  cost_input REAL,
                  cost_output REAL,
                  is_system_context INTEGER NOT NULL DEFAULT 0,
                  timestamp TIMESTAMP NOT NULL,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  source_created_at TIMESTAMP,
                  UNIQUE(session_key, source_id)
                )
              `);
              // 迁移数据：NULL source_id -> ''
              this.db.exec(`
                INSERT INTO admin_messages (id, source_id, source_module, session_key, message_type, content, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, is_system_context, timestamp, created_at, source_created_at)
                SELECT
                  id,
                  COALESCE(source_id, '') as source_id,
                  source_module, session_key, message_type, content, model,
                  tokens_input, tokens_output, cost_total, cost_input, cost_output,
                  is_system_context, timestamp, created_at, source_created_at
                FROM admin_messages_old
              `);
              this.db.exec('DROP TABLE admin_messages_old');
              this.db.exec('COMMIT');
              logger.info('Migration v13: admin_messages rebuilt with NOT NULL source_id');
            } catch (innerErr) {
              this.db.exec('ROLLBACK');
              throw innerErr;
            }
          } else {
            // 无 NULL 数据，跳过重建（SQLite 不支持 ALTER TABLE MODIFY COLUMN）
            logger.info('Migration v13: no NULL source_id found, skipping rebuild');
          }
        }
        break;
      case 14:
        // 迁移 v14: 将 admin_messages 中的 tool 类型消息拆分到 admin_tool_calls 表
        {
          // 检查 admin_tool_calls 表是否存在（createTables 已创建，但迁移可能在 init 之后运行）
          const tableInfo = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_tool_calls'").get();
          if (!tableInfo) {
            logger.warn('Migration v14: admin_tool_calls table not found, skipping');
            break;
          }

          const toolCount = this.db.prepare(
            "SELECT COUNT(*) as cnt FROM admin_messages WHERE message_type = 'tool'"
          ).get() as { cnt: number };

          if (toolCount.cnt > 0) {
            logger.info(`Migration v14: migrating ${toolCount.cnt} tool messages to admin_tool_calls`);
            this.db.exec('BEGIN TRANSACTION');
            try {
              // 1. 插入到 admin_tool_calls（忽略已存在的，幂等）
              this.db.prepare(`
                INSERT OR IGNORE INTO admin_tool_calls
                  (source_id, source_module, session_key, message_type, content, created_at,
                   model, tokens_input, tokens_output, cost_total, cost_input, cost_output, metadata)
                SELECT
                  COALESCE(source_id, '') as source_id,
                  source_module,
                  session_key,
                  'tool' as message_type,
                  content,
                  created_at,
                  model,
                  COALESCE(tokens_input, 0) as tokens_input,
                  COALESCE(tokens_output, 0) as tokens_output,
                  cost_total,
                  cost_input,
                  cost_output,
                  NULL as metadata
                FROM admin_messages
                WHERE message_type = 'tool'
              `).run();

              // 2. 从 admin_messages 删除 tool 消息
              this.db.prepare("DELETE FROM admin_messages WHERE message_type = 'tool'").run();

              this.db.exec('COMMIT');
              logger.info(`Migration v14: completed, ${toolCount.cnt} tool messages moved to admin_tool_calls`);
            } catch (innerErr) {
              this.db.exec('ROLLBACK');
              throw innerErr;
            }
          } else {
            logger.info('Migration v14: no tool messages to migrate');
          }
        }
        break;
      case 15:
        // 迁移 v15: 创建 admin_model_events 表（存储从 collector 同步的 session 事件）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS admin_model_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_id TEXT,
            data_json TEXT NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(event_id)
          );
          CREATE INDEX IF NOT EXISTS idx_admin_model_events_session ON admin_model_events(session_key);
          CREATE INDEX IF NOT EXISTS idx_admin_model_events_timestamp ON admin_model_events(timestamp);
          CREATE INDEX IF NOT EXISTS idx_admin_model_events_type ON admin_model_events(event_type);
        `);
        logger.info('Migration v15: admin_model_events table created');
        break;
      case 16:
        // 迁移 v16: 给 admin_tool_calls 表添加 tool_name 和 tool_input 字段
        {
          const colInfo = this.db.prepare('PRAGMA table_info(admin_tool_calls)').all() as Array<{ name: string }>;
          if (!colInfo.some(col => col.name === 'tool_name')) {
            this.db.exec(`ALTER TABLE admin_tool_calls ADD COLUMN tool_name TEXT;`);
            logger.info('Migration v16: added tool_name column to admin_tool_calls');
          } else {
            logger.info('Migration v16: tool_name column already exists, skipping');
          }
          if (!colInfo.some(col => col.name === 'tool_input')) {
            this.db.exec(`ALTER TABLE admin_tool_calls ADD COLUMN tool_input TEXT;`);
            logger.info('Migration v16: added tool_input column to admin_tool_calls');
          } else {
            logger.info('Migration v16: tool_input column already exists, skipping');
          }
        }
        break;
      case 17:
        // 迁移 v17: 创建 admin_tasks 表（任务数据从 admin_tool_calls 的 sessions_spawn 记录推导）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS admin_tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'queued',
            agent_id TEXT,
            requester_session_key TEXT,
            child_session_key TEXT,
            run_id TEXT,
            mode TEXT,
            task_description TEXT,
            result_summary TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMP,
            completed_at TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_admin_tasks_agent ON admin_tasks(agent_id);
          CREATE INDEX IF NOT EXISTS idx_admin_tasks_status ON admin_tasks(status);
          CREATE INDEX IF NOT EXISTS idx_admin_tasks_created ON admin_tasks(created_at);
          CREATE INDEX IF NOT EXISTS idx_admin_tasks_child_session ON admin_tasks(child_session_key);
        `);
        logger.info('Migration v17: admin_tasks table created');
        break;
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