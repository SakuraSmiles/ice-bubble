/**
 * SQLite 测试辅助函数
 */

import { SQLiteManager } from '../../src/storage/SQLiteManager.js';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 创建测试数据库
 */
export function createTestDatabase(dbPath?: string): SQLiteManager {
  const finalPath = dbPath || path.join(__dirname, '../fixtures/test.db');
  
  // 确保目录存在
  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new SQLiteManager({
    dbPath: finalPath,
    walMode: false, // 测试环境关闭 WAL 模式
  });
}

/**
 * 清理测试数据库
 */
export function cleanupTestDatabase(dbPath?: string): void {
  const finalPath = dbPath || path.join(__dirname, '../fixtures/test.db');
  
  // 删除数据库文件
  if (fs.existsSync(finalPath)) {
    fs.unlinkSync(finalPath);
  }

  // 删除 WAL 和 SHM 文件
  const walPath = `${finalPath}-wal`;
  const shmPath = `${finalPath}-shm`;
  
  if (fs.existsSync(walPath)) {
    fs.unlinkSync(walPath);
  }
  if (fs.existsSync(shmPath)) {
    fs.unlinkSync(shmPath);
  }
}
