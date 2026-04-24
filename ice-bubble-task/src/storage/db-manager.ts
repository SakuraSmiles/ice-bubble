/**
 * 数据库管理器
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { Logger } from '../utils/logger.js';

const logger = new Logger('DBManager');

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

export interface DatabaseConfig {
  dbPath: string;
  walMode?: boolean;
  foreignKeys?: boolean;
  performance?: {
    cacheSize?: number;
    mmapSize?: number;
    pageSize?: number;
    busyTimeout?: number;
    journalSizeLimit?: number;
  };
}

export class DBManager {
  private db: DatabaseType | null = null;
  private isInitialized: boolean = false;

  async init(config: DatabaseConfig): Promise<void> {
    try {
      this.db = new Database(config.dbPath);

      if (config.walMode !== false) {
        this.db.pragma('journal_mode = WAL');
      }

      if (config.foreignKeys !== false) {
        this.db.pragma('foreign_keys = ON');
      }

      this.applyPerformanceConfig(config.performance);
      await this.createTables();

      this.isInitialized = true;
      logger.info('Database initialized', { dbPath: config.dbPath });
    } catch (error) {
      throw new SQLiteError('Failed to initialize SQLite', 'SQLITE_INIT_FAILED', error);
    }
  }

  private applyPerformanceConfig(performance?: DatabaseConfig['performance']): void {
    if (!this.db) return;
    const cfg = {
      cacheSize: -64000,
      mmapSize: 268435456,
      pageSize: 4096,
      busyTimeout: 5000,
      journalSizeLimit: 67108864,
      ...performance
    };

    this.db.pragma(`cache_size = ${cfg.cacheSize}`);
    this.db.pragma(`mmap_size = ${cfg.mmapSize}`);
    this.db.pragma(`page_size = ${cfg.pageSize}`);
    this.db.pragma(`busy_timeout = ${cfg.busyTimeout}`);
    this.db.pragma(`journal_size_limit = ${cfg.journalSizeLimit}`);
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('auto_vacuum = INCREMENTAL');
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

    // tasks 表：不做外键约束，agent_id 只是字符串引用
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_id TEXT,
        children_ids TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        loop_target TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminated_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    `);

    // schema_version 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info('Database tables created');
  }

  getConnection(): DatabaseType {
    if (!this.db || !this.isInitialized) {
      throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
    }
    return this.db;
  }

  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  async migrate(version: number): Promise<void> {
    if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
    const current = this.getCurrentSchemaVersion();
    if (current >= version) return;
    for (let v = current + 1; v <= version; v++) {
      await this.executeVersionMigration(v);
    }
    this.updateSchemaVersion(version);
    logger.info('Database migration completed', { from: current, to: version });
  }

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

  private updateSchemaVersion(version: number): void {
    if (!this.db) return;
    this.db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)`).run(version);
  }

  private async executeVersionMigration(_version: number): Promise<void> {
    // 预留扩展，当前版本无需迁移
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      logger.info('Database connection closed');
    }
  }
}
