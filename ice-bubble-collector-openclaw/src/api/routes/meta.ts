/**
 * Meta 路由 - 模块状态接口
 *
 * 实现冰泡管理员接入规范:
 * GET /api/meta/status → ModuleStatusResponse
 * GET /api/meta/config → 当前运行配置
 *
 * 此接口是 admin 与 collector 之间的唯一契约。
 *
 * @module api/routes/meta
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { Logger } from '../../utils/logger.js';
import { getConfig } from '../../utils/config-loader.js';
import type { FileCollector } from '../../collectors/FileCollector.js';
import type {
    ModuleStatusResponse,
    ModuleRuntimeInfo,
    ModuleHealthInfo,
} from '../types.js';

const metaLogger = new Logger('MetaRoute');

/** 模块固定标识 */
const MODULE_KEY = 'collector-openclaw';
const MODULE_TYPE = 'collector';

/** 记录启动时间，用于计算 uptime */
let startTimeISO: string = '';

/**
 * 记录采集器启动时刻
 */
export function markStartTime(): void {
    startTimeISO = new Date().toISOString();
}

/**
 * 动态读取 package.json 中的版本号
 */
function getModuleVersion(): string {
    try {
        const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
        return packageJson.version || '1.0.0';
    } catch {
        return 'unknown';
    }
}

/**
 * 从 CollectorStats 构造运行时数据
 */
function buildRuntimeInfo(collectorStats: unknown): ModuleRuntimeInfo {
    const stats = collectorStats as {
        totalEvents: number;
        failedEvents: number;
        successEvents: number;
        totalFiles: number;
        processedFiles: number;
    };

    const start = startTimeISO ? new Date(startTimeISO).getTime() : Date.now();
    const uptimeSeconds = Math.floor((Date.now() - start) / 1000);

    return {
        startTime: startTimeISO,
        uptimeSeconds,
        messagesCollected: stats?.successEvents ?? 0,
        errorsCount: stats?.failedEvents ?? 0,
    };
}

/**
 * 根据当前错误比例判断健康状态
 */
function buildHealthInfo(collectorStats: unknown): ModuleHealthInfo {
    const stats = collectorStats as {
        totalEvents: number;
        failedEvents: number;
    } | undefined;

    if (!stats || stats.totalEvents === 0) {
        return { status: 'healthy', message: '正常' };
    }

    const errorRate = stats.failedEvents / stats.totalEvents;

    if (errorRate > 0.1) {
        return { status: 'error', message: `错误率偏高: ${(errorRate * 100).toFixed(1)}%` };
    }
    if (errorRate > 0.01) {
        return { status: 'warning', message: `存在少量错误: ${(errorRate * 100).toFixed(2)}%` };
    }
    return { status: 'healthy', message: '正常' };
}

/**
 * 创建 meta 路由
 *
 * @param collector - FileCollector 实例（用于读取运行时统计）
 */
export function createMetaRouter(collector: FileCollector): Router {
    const router = Router();

    /**
     * GET /api/meta/status
     *
     * 返回模块完整状态，符合 admin 接入规范。
     */
    router.get('/status', (_req: Request, res: Response) => {
        try {
            const stats = collector.getStats();

            const body: ModuleStatusResponse = {
                moduleKey: MODULE_KEY,
                moduleType: MODULE_TYPE,
                version: getModuleVersion(),
                status: 'running',
                runtime: buildRuntimeInfo(stats),
                health: buildHealthInfo(stats),
            };

            res.json(body);
            metaLogger.debug('返回模块状态', { status: body.status });
        } catch (error) {
            metaLogger.error('获取模块状态失败', error as Error);
            res.status(500).json({
                error: '获取模块状态失败',
                code: 'STATUS_FETCH_FAILED',
            } as const);
        }
    });

    /**
     * GET /api/meta/config
     *
     * 返回模块当前运行时配置（从内存中获取）
     */
    router.get('/config', (_req: Request, res: Response) => {
        try {
            const config = getConfig();

            // 返回关键配置（可以按需调整）
            const body = {
                watchPath: config.collection.file.watchPath,
                scanInterval: config.collection.file.scanInterval,
                batchSize: config.processing.batchWriter.batchSize,
                flushInterval: config.processing.batchWriter.flushInterval,
                dbPath: config.storage.sqlite.dbPath,
                enabledDedup: config.processing.deduplicator.enabled,
                enabledValidation: config.processing.validator.enabled,
                incrementalEnabled: config.collection.file.incremental.enabled,
                incrementalStatePath: config.collection.file.incremental.statePath,
                collectionMode: config.collection.mode,
                watchEnabled: config.collection.file.enableWatch,
            };

            res.json(body);
            metaLogger.debug('返回模块配置', { watchPath: body.watchPath });
        } catch (error) {
            metaLogger.error('获取模块配置失败', error as Error);
            res.status(500).json({
                error: '获取模块配置失败',
                code: 'CONFIG_FETCH_FAILED',
            } as const);
        }
    });

    return router;
}
