/**
 * SQLite 测试辅助函数
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 创建内存测试数据库
 */
export function createInMemoryDatabase(): DatabaseType {
  const db = new Database(':memory:');
  // 启用外键约束
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 创建临时文件数据库（带自动清理）
 */
export function createTempDatabase(): { db: DatabaseType; dbPath: string; cleanup: () => void } {
  const tmpDir = path.join(__dirname, '../fixtures');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const dbPath = path.join(tmpDir, `test-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const cleanup = () => {
    try {
      db.close();
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    } catch { /* ignore */ }
  };

  return { db, dbPath, cleanup };
}

/**
 * 执行 SQL 初始化脚本（创建表结构）
 */
export function initializeSchema(db: DatabaseType): void {
  // module_registry
  db.exec(`
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

  // module_runtime_status
  db.exec(`
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

  // module_health
  db.exec(`
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

  // module_config
  db.exec(`
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
  `);

  // module_event
  db.exec(`
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
  `);

  // module_dependency
  db.exec(`
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
  `);

  // module_version
  db.exec(`
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
  `);

  // module_statistics
  db.exec(`
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
  `);

  // schema_version
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // admin_sessions
  db.exec(`
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

  // admin_messages
  db.exec(`
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

  // admin_agents
  db.exec(`
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
      avatar TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_agents_last_active ON admin_agents(last_active_at);
  `);

  // sync_progress
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL UNIQUE,
      last_sync_time TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // agent_activity_daily
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity_daily (
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      PRIMARY KEY (agent_id, date)
    );
  `);

  // token_summary
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_summary (
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
}
