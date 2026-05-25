/**
 * Meta 路由 - 模块状态接口
 *
 * GET /api/meta/status → 服务状态
 * GET /api/meta/config → 模块配置
 *
 * 与 collector-openclaw 的 meta 路由对齐。
 *
 * @module api/routes/meta
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../utils/logger.js';
import { getConfig } from '../../utils/config-loader.js';
import type { SQLiteCollector } from '../../collectors/sqlite-collector.js';
import type { ModuleStatusResponse, ModuleRuntimeInfo, ModuleHealthInfo } from '../types.js';

const metaLogger = new Logger('MetaRoute');

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODULE_KEY = 'collector-opencode';
const MODULE_TYPE = 'collector';

let startTimeISO: string = '';

export function markStartTime(): void {
    startTimeISO = new Date().toISOString();
}

function getModuleVersion(): string {
    try {
        const packageJson = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf-8'));
        return packageJson.version || 'unknown';
    } catch {
        return 'unknown';
    }
}

function buildRuntimeInfo(stats: {
    messageCount: number;
    totalMessagesCollected: number;
    totalPolled: number;
}): ModuleRuntimeInfo {
    const start = startTimeISO ? new Date(startTimeISO).getTime() : Date.now();
    const uptimeSeconds = Math.floor((Date.now() - start) / 1000);

    return {
        startTime: startTimeISO,
        uptimeSeconds,
        messagesCollected: stats.totalMessagesCollected ?? 0,
        errorsCount: 0,
    };
}

function buildHealthInfo(): ModuleHealthInfo {
    return { status: 'healthy', message: '正常' };
}

export function createMetaRouter(collector: SQLiteCollector): Router {
    const router = Router();

    router.get('/status', (_req: Request, res: Response) => {
        try {
            const stats = collector.getStats();

            const body: ModuleStatusResponse = {
                moduleKey: MODULE_KEY,
                moduleType: MODULE_TYPE,
                version: getModuleVersion(),
                status: collector.isRunning() ? 'running' : 'stopped',
                runtime: buildRuntimeInfo(stats),
                health: buildHealthInfo(),
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

    router.get('/config', (_req: Request, res: Response) => {
        try {
            const config = getConfig();
            res.json({
                port: config.httpPort,
                host: config.httpHost,
                opencodeDbPath: config.opencodeDbPath,
                pollIntervalMs: config.pollIntervalMs,
                batchSize: config.batchSize,
                logLevel: config.logLevel,
            });
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
