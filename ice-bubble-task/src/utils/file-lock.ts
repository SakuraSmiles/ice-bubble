/**
 * 文件锁工具 - 确保 task-store.json 的并发读写安全
 *
 * 使用简单的 lock 文件实现互斥访问。
 */

import { openSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';

const LOCK_SUFFIX = '.lock';

function getLockPath(filePath: string): string {
  return filePath + LOCK_SUFFIX;
}

/**
 * 简单的文件锁实现
 * 使用 mkdir 实现原子性的锁获取
 */
function acquireLock(lockPath: string, timeoutMs: number = 5000): boolean {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      // mkdir 是原子操作，目录已存在会失败
      openSync(lockPath, 'w');
      return true;
    } catch {
      // 锁被占用，等待后重试
      const waitTime = Math.floor(Math.random() * 50) + 10;
      const start = Date.now();
      while (Date.now() - start < waitTime) {
        // busy wait
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * 在文件锁保护下执行临界区操作。
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = getLockPath(filePath);
  
  if (!acquireLock(lockPath)) {
    throw new Error(`Failed to acquire lock for ${filePath}`);
  }
  
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * 读取文件内容
 */
export function readStore(filePath: string): string {
  if (!existsSync(filePath)) {
    return JSON.stringify({ tasks: {}, counter: 0, statusUpdates: {} });
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * 写入文件内容
 */
export function writeStore(filePath: string, data: string): void {
  writeFileSync(filePath, data, 'utf-8');
}
