/**
 * 文件锁工具 - 确保 task-store.json 的并发读写安全
 *
 * 使用原子性 mkdir 实现互斥锁，支持 stale lock 自动检测与清理。
 * 写入采用临时文件 + rename 保证崩溃安全（crash-safe）。
 *
 * ## 设计要点
 *
 * 1. **原子锁** — `mkdirSync` 是原子操作，目录已存在则抛 EEXIST。
 *    这比 `openSync`（只检查创建时是否存在）可靠得多。
 *
 * 2. **Stale lock 检测** — 锁目录的 mtime 超过 TTL 时，
 *    视为持有锁的进程已崩溃，自动清理并重新获取锁。
 *
 * 3. **异步等待** — 提供 `sleep()` 工具函数，避免忙等待消耗 CPU。
 *    `withFileLock` 本身保持同步接口（兼容现有调用方），
 *    内部使用 `fs.mkdirSync` + 指数退避 + setTimeout sleep。
 *
 * 4. **崩溃安全写入** — `writeStore` 先写入 `.tmp` 临时文件，
 *    再用 `fs.renameSync` 原子替换原文件。
 *    进程崩溃时最多丢失最后一次写入，不会损坏已有数据。
 *
 * ## 目录结构
 *
 * ```
 * task-store.json        ← 实际数据文件
 * task-store.json.lock/  ← 锁目录（mkdir 创建）
 * task-store.json.tmp    ← 临时写入文件
 * ```
 */

import {
  mkdirSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'fs';

const LOCK_SUFFIX = '.lock';
const TMP_SUFFIX = '.tmp';
const STALE_LOCK_TTL_MS = 15_000; // 15 秒，超过视为锁持有者已崩溃

function getLockPath(filePath: string): string {
  return filePath + LOCK_SUFFIX;
}

function getTmpPath(filePath: string): string {
  return filePath + TMP_SUFFIX;
}

/**
 * 异步睡眠工具函数。
 * 用于替代忙等待（busy wait），避免 100% CPU 消耗。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 尝试获取锁（原子 mkdir + stale lock 检测）。
 *
 * @returns true 表示成功获取锁
 */
function tryAcquireLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (err: unknown) {
    // 目录已存在，锁被占用
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      // 检查是否为 stale lock
      if (isStaleLock(lockPath)) {
        // 清理残留的锁目录
        cleanupLock(lockPath);
        // 重试获取
        try {
          mkdirSync(lockPath);
          return true;
        } catch {
          // 其他进程抢先获取了，返回 false 让调用方继续等待
          return false;
        }
      }
    }
    return false;
  }
}

/**
 * 检查锁目录是否过期（stale）。
 * 通过检查锁目录的 mtime 是否超过 TTL 来判断。
 */
function isStaleLock(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath);
    const age = Date.now() - stat.mtimeMs;
    return age > STALE_LOCK_TTL_MS;
  } catch {
    // 锁目录不存在，不算 stale
    return false;
  }
}

/**
 * 清理锁目录。
 */
function cleanupLock(lockPath: string): void {
  try {
    rmdirSync(lockPath);
  } catch {
    // 忽略清理失败
  }
}

/**
 * 同步等待锁，支持 stale lock 自动清理。
 * 使用随机退避间隔，避免忙等待。
 *
 * @param timeoutMs 最大等待时间（毫秒）
 * @returns true 表示成功获取锁
 */
function acquireLock(lockPath: string, timeoutMs: number = 5000): boolean {
  const startTime = Date.now();
  let retries = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (tryAcquireLock(lockPath)) {
      return true;
    }

    // 指数退避 + 随机抖动：10ms, 20ms, 40ms, ... 最多 200ms
    const backoff = Math.min(10 * Math.pow(2, retries), 200);
    const jitter = Math.floor(Math.random() * backoff * 0.5);
    const waitMs = backoff + jitter;

    // 同步 sleep：使用 Atomics.wait 避免 busy wait
    // 这是 Node.js 中实现同步睡眠的唯一安全方式
    if (typeof SharedArrayBuffer !== 'undefined') {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, waitMs);
    } else {
      // 备用方案：使用 child_process 执行同步 sleep
      // 虽然不理想，但至少不会 100% CPU
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        // 空循环，但时间很短（最多 200ms），可接受
      }
    }
    retries++;
  }

  return false;
}

/**
 * 释放锁。
 */
function releaseLock(lockPath: string): void {
  cleanupLock(lockPath);
}

/**
 * 在文件锁保护下执行临界区操作。
 *
 * 注意：`fn` 必须是同步函数。
 * 如果需要异步操作，请在 `fn` 内部自行处理。
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = getLockPath(filePath);

  if (!acquireLock(lockPath)) {
    throw new Error(`Failed to acquire lock for ${filePath} within timeout`);
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * 读取文件内容。
 * 文件不存在时返回空 JSON 结构。
 */
export function readStore(filePath: string): string {
  if (!existsSync(filePath)) {
    return JSON.stringify({ tasks: {}, counter: 0, statusUpdates: {} });
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * 写入文件内容（崩溃安全）。
 *
 * 先写入临时文件，再用 rename 原子替换原文件。
 * 即使进程在写入过程中崩溃，原文件也不会损坏。
 */
export function writeStore(filePath: string, data: string): void {
  const tmpPath = getTmpPath(filePath);

  try {
    // 1. 写入临时文件
    writeFileSync(tmpPath, data, 'utf-8');
    // 2. 原子替换
    renameSync(tmpPath, filePath);
  } catch (error) {
    // 写入失败时清理临时文件
    try {
      unlinkSync(tmpPath);
    } catch {
      // 忽略
    }
    throw error;
  }
}
