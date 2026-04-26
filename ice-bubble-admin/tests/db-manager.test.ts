/**
 * DBManager 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DBManager, SQLiteError } from '../src/storage/db-manager.js';
import * as path from 'path';
import * as fs from 'fs';

function makeTestDbPath(suffix: string) {
  return path.join(__dirname, `../fixtures/test-db-${suffix}.db`);
}

function cleanupDb(dbPath: string) {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  } catch { /* ignore */ }
}

describe('DBManager', () => {
  let dbManager: DBManager;
  let testDbPath: string;

  beforeEach(() => {
    // Use unique path per test to avoid parallel execution conflicts
    testDbPath = makeTestDbPath(Date.now().toString() + Math.random().toString(36).slice(2));
    dbManager = new DBManager();
  });

  afterEach(async () => {
    if (dbManager.isReady()) {
      await dbManager.close();
    }
    cleanupDb(testDbPath);
  });

  describe('init()', () => {
    it('应该成功初始化数据库', async () => {
      await dbManager.init({ dbPath: testDbPath });
      expect(dbManager.isReady()).toBe(true);
      const conn = dbManager.getConnection();
      expect(conn).toBeDefined();
    });

    it('初始化后可以获取数据库连接', async () => {
      await dbManager.init({ dbPath: testDbPath });
      const conn = dbManager.getConnection();
      const tables = conn.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('module_registry');
      expect(tableNames).toContain('admin_sessions');
      expect(tableNames).toContain('admin_messages');
      expect(tableNames).toContain('admin_agents');
    });

    it('应该拒绝在未初始化时获取连接', () => {
      expect(() => dbManager.getConnection()).toThrow(SQLiteError);
      expect(() => dbManager.getConnection()).toThrow('not initialized');
    });

    it('应该正确设置 WAL 模式', async () => {
      await dbManager.init({ dbPath: testDbPath, walMode: true });
      const conn = dbManager.getConnection();
      const walMode = conn.pragma('journal_mode') as { journal_mode: string }[];
      expect(walMode[0].journal_mode).toBe('wal');
    });

    it('应该正确关闭 WAL 模式', async () => {
      await dbManager.init({ dbPath: testDbPath, walMode: false });
      const conn = dbManager.getConnection();
      const mode = conn.pragma('journal_mode') as { journal_mode: string }[];
      expect(mode[0].journal_mode).toBe('delete');
    });

    it('应该正确设置 foreign_keys', async () => {
      await dbManager.init({ dbPath: testDbPath, foreignKeys: true });
      const conn = dbManager.getConnection();
      const fk = conn.pragma('foreign_keys') as { foreign_keys: number }[];
      expect(fk[0].foreign_keys).toBe(1);
    });

    it('应该应用性能优化配置', async () => {
      await dbManager.init({
        dbPath: testDbPath,
        performance: {
          cacheSize: -32000,
          busyTimeout: 3000,
        },
      });
      const conn = dbManager.getConnection();
      const cache = conn.pragma('cache_size') as { cache_size: number }[];
      expect(cache[0].cache_size).toBe(-32000);
    });

    it('初始化失败时抛出 SQLiteError', async () => {
      await expect(
        dbManager.init({ dbPath: '/invalid/path/that/does/not/exist/admin.db' })
      ).rejects.toThrow(SQLiteError);
    });
  });

  describe('migrate()', () => {
    it('迁移到版本 0 应该直接返回', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.migrate(0);
      expect(dbManager.isReady()).toBe(true);
    });

    it('迁移到当前版本应该跳过', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.migrate(1);
      await dbManager.migrate(1);
      const conn = dbManager.getConnection();
      const version = conn.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(version.v).toBe(1);
    });

    it('应该执行版本迁移', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.migrate(3);
      const conn = dbManager.getConnection();
      const version = conn.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(version.v).toBe(3);
    });

    it('未初始化时迁移应该抛出错误', async () => {
      await expect(dbManager.migrate(1)).rejects.toThrow(SQLiteError);
    });

    it('迁移版本 8 应该成功完成', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.migrate(8);
      const conn = dbManager.getConnection();
      const version = conn.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(version.v).toBe(8);
      const cols = conn.prepare('PRAGMA table_info(admin_messages)').all() as { name: string }[];
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('cost_total');
      expect(colNames).toContain('cost_input');
      expect(colNames).toContain('cost_output');
    });

    it('迁移版本 11 应该幂等', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.migrate(11);
      await dbManager.migrate(11);
      const conn = dbManager.getConnection();
      const version = conn.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(version.v).toBe(11);
      const cols = conn.prepare('PRAGMA table_info(admin_messages)').all() as { name: string }[];
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('is_system_context');
    });
  });

  describe('backup()', () => {
    it('应该成功备份数据库', async () => {
      await dbManager.init({ dbPath: testDbPath });
      const backupPath = testDbPath + '.backup';
      try {
        await dbManager.backup(backupPath);
        expect(fs.existsSync(backupPath)).toBe(true);
      } finally {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      }
    });

    it('未初始化时备份应该抛出错误', async () => {
      await expect(dbManager.backup('/tmp/backup.db')).rejects.toThrow(SQLiteError);
    });
  });

  describe('optimize()', () => {
    it('应该成功执行优化', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await expect(dbManager.optimize()).resolves.toBeUndefined();
    });

    it('未初始化时优化应该抛出错误', async () => {
      await expect(dbManager.optimize()).rejects.toThrow(SQLiteError);
    });
  });

  describe('close()', () => {
    it('关闭后 isReady 应该返回 false', async () => {
      await dbManager.init({ dbPath: testDbPath });
      expect(dbManager.isReady()).toBe(true);
      await dbManager.close();
      expect(dbManager.isReady()).toBe(false);
    });

    it('可以多次关闭而不报错', async () => {
      await dbManager.init({ dbPath: testDbPath });
      await dbManager.close();
      await expect(dbManager.close()).resolves.toBeUndefined();
    });
  });

  describe('getStats()', () => {
    it('应该返回数据库统计信息', async () => {
      await dbManager.init({ dbPath: testDbPath });
      const stats = await dbManager.getStats();
      expect(stats).toHaveProperty('totalSizeMB');
      expect(stats).toHaveProperty('tableCount');
      expect(stats).toHaveProperty('rowCount');
      expect(stats.tableCount).toBeGreaterThan(0);
    });

    it('未初始化时获取统计应该抛出错误', async () => {
      await expect(dbManager.getStats()).rejects.toThrow(SQLiteError);
    });
  });

  describe('SQLiteError', () => {
    it('应该正确设置错误属性', () => {
      const error = new SQLiteError('test message', 'TEST_CODE', { detail: true });
      expect(error.message).toBe('test message');
      expect(error.code).toBe('TEST_CODE');
      expect(error.detail).toEqual({ detail: true });
      expect(error.name).toBe('SQLiteError');
    });
  });
});
