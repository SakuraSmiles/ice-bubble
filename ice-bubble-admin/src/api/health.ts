/**
 * ice-bubble Admin - 健康检查路由
 *
 * 提供详细的系统状态信息，包括数据库、collector 可达性、内存使用等
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
  dependencies: Record<string, { status: string; [key: string]: unknown }>;
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/**
 * 检查 collector 可达性，3 秒超时
 */
async function checkCollectorReachable(baseUrl: string): Promise<{ status: string; lastSync?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/meta/status`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { status: 'unreachable' };

    const body = await res.json() as Record<string, unknown>;
    return {
      status: 'ok',
      lastSync: body.lastSync as string | undefined,
    };
  } catch {
    return { status: 'unreachable' };
  }
}

export function createHealthRouter(db: DatabaseType, configData: AppConfig): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
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

    // Collector 可达性检查
    const collectors = configData.modules?.filter(m => m.enabled && m.baseUrl) ?? [];

    for (const collector of collectors) {
      const result = await checkCollectorReachable(collector.baseUrl);
      const key = `collector_${collector.moduleKey}`;
      deps[key] = result;
      if (result.status === 'unreachable') hasDegraded = true;
    }

    const overallStatus = hasError ? 'error' : hasDegraded ? 'degraded' : 'ok';

    const mem = process.memoryUsage();
    const response: HealthResponse = {
      status: overallStatus,
      uptime: Math.round(process.uptime()),
      memory: {
        rss: formatMB(mem.rss),
        heapUsed: formatMB(mem.heapUsed),
        heapTotal: formatMB(mem.heapTotal),
      },
      dependencies: deps,
    };

    res.json(response);
  });

  return router;
}
