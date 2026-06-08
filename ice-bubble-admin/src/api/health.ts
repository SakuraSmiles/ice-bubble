/**
 * ice-bubble Admin - 健康检查路由
 *
 * 提供两层健康检查：
 *   GET /health          — 快速健康检查（<50ms），仅返回进程状态
 *   GET /health/detail   — 深度健康检查，含 DB/Collector 探测
 *
 * 深度检查结果会缓存在内存中，定期异步刷新，不会阻塞快速检查。
 */

import { Router } from 'express';
import type { Database as DatabaseType } from 'better-sqlite3';

interface CollectorConfig {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

interface AppConfig {
  modules?: CollectorConfig[];
  dataSync?: { collectorBaseUrl?: string };
  dataSyncOpencode?: { collectorBaseUrl?: string };
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  memory: {
    rss: string;
    heapUsed: string;
    heapTotal: string;
  };
  dependencies?: Record<string, { status: string; [key: string]: unknown }>;
  checkDurationMs?: number;
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/**
 * 检查 collector 可达性，2 秒超时（从 3 秒降低）
 */
async function checkCollectorReachable(baseUrl: string): Promise<{ status: string; lastSync?: string; latencyMs?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/meta/status`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { status: 'unreachable' };

    const body = await res.json() as Record<string, unknown>;
    return {
      status: 'ok',
      lastSync: body.lastSync as string | undefined,
      latencyMs: Date.now() - start,
    };
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - start };
  }
}

/**
 * 执行深度健康检查（DB + Collector 探测），结果缓存在闭包中
 */
function runDeepCheck(db: DatabaseType, collectors: CollectorConfig[]): {
  dependencies: HealthResponse['dependencies'];
  status: 'ok' | 'degraded' | 'error';
} {
  const deps: HealthResponse['dependencies'] = {};
  let hasDegraded = false;
  let hasError = false;

  // 数据库检查
  try {
    db.pragma('page_count');
    db.pragma('page_size');
    const pageCount = (db.pragma('page_count') as unknown[])[0] as number;
    const pageSize = (db.pragma('page_size') as unknown[])[0] as number;
    const dbSizeBytes = pageCount * pageSize;
    deps.database = {
      status: 'ok',
      dbSize: formatMB(dbSizeBytes),
    };
  } catch (err) {
    deps.database = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    hasError = true;
  }

  // Collector checks — 同步收集结果（深度检查允许慢）
  // 实际的 collector fetch 在下面异步触发时执行
  for (const collector of collectors) {
    // placeholder，实际值在异步刷新时填充
    const key = `collector_${collector.moduleKey}`;
    deps[key] = { status: 'pending' };
  }

  const overallStatus = hasError ? 'error' : hasDegraded ? 'degraded' : 'ok';
  return { dependencies: deps, status: overallStatus };
}

export function createHealthRouter(db: DatabaseType, configData: AppConfig): Router {
  const router = Router();

  // 缓存的深度检查结果
  let cachedDeps: HealthResponse['dependencies'] | null = null;
  let cachedStatus: 'ok' | 'degraded' | 'error' = 'ok';
// deep check timestamp (available for future use)
  let deepCheckInProgress = false;
  const DEEP_CHECK_INTERVAL = 30000; // 30 秒刷新一次深度检查

  // 启动时立即执行一次深度检查
  const collectors = configData.modules?.filter(m => m.enabled && m.baseUrl) ?? [];

  /**
   * 异步执行深度健康检查（DB + Collector 探测），更新缓存
   */
  async function refreshDeepCheck(): Promise<void> {
    if (deepCheckInProgress) return;
    deepCheckInProgress = true;

    try {
      const { dependencies, status: dbStatus } = runDeepCheck(db, collectors);
      cachedDeps = dependencies;
      cachedStatus = dbStatus;
      // lastDeepCheckAt = Date.now();

      // 异步检查 collector 连通性
      const results = await Promise.all(
        collectors.map(async (c) => {
          const result = await checkCollectorReachable(c.baseUrl);
          return { key: `collector_${c.moduleKey}`, result };
        })
      );

      let hasDegraded = false;
      for (const { key, result } of results) {
        cachedDeps![key] = result;
        if (result.status === 'unreachable') hasDegraded = true;
      }

      cachedStatus = dbStatus === 'error' ? 'error' : hasDegraded ? 'degraded' : 'ok';
    } catch {
      // 深度检查失败不影响快速检查
    } finally {
      deepCheckInProgress = false;
    }
  }

  // 立即触发首次深度检查（异步，不阻塞）
  refreshDeepCheck().catch(() => {});

  // 定期刷新深度检查
  setInterval(() => {
    refreshDeepCheck().catch(() => {});
  }, DEEP_CHECK_INTERVAL);

  /**
   * GET /health — 快速健康检查（<50ms）
   * 仅返回进程状态，不执行任何 IO 操作
   */
  router.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    const response: HealthResponse = {
      status: cachedStatus || 'ok',
      uptime: Math.round(process.uptime()),
      memory: {
        rss: formatMB(mem.rss),
        heapUsed: formatMB(mem.heapUsed),
        heapTotal: formatMB(mem.heapTotal),
      },
    };

    // 如果有缓存的深度检查结果，附加上去
    if (cachedDeps) {
      response.dependencies = cachedDeps;
    }

    res.json(response);
  });

  /**
   * GET /health/detail — 深度健康检查（实时执行，可能需要 2-3 秒）
   * 立即触发一次深度检查并等待结果
   */
  router.get('/health/detail', async (_req, res) => {
    const start = Date.now();

    // 强制刷新深度检查
    await refreshDeepCheck();

    const mem = process.memoryUsage();
    const response: HealthResponse = {
      status: cachedStatus,
      uptime: Math.round(process.uptime()),
      memory: {
        rss: formatMB(mem.rss),
        heapUsed: formatMB(mem.heapUsed),
        heapTotal: formatMB(mem.heapTotal),
      },
      dependencies: cachedDeps ?? {},
      checkDurationMs: Date.now() - start,
    };

    res.json(response);
  });

  return router;
}
