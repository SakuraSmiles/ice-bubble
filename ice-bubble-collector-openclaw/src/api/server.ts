/**
 * API Server — Express HTTP 服务
 *
 * 职责：
 * - 仅服务于 BIZ LAYER (admin)，不直接面向 topdesk
 * - 暴露 /api/meta/status 接口，满足 admin 接入规范
 * - 轻量设计：无认证、无复杂中间件、无 WebSocket
 *
 * 设计原则：
 * DATA LAYER 的 Collector 通过此服务将运行状态标准化暴露给上层。
 * 未来如需扩展数据查询接口（sessions/agents 等），在此处新增路由即可。
 *
 * @module api/server
 */

import express from 'express';
import type { FileCollector } from '../collectors/FileCollector.js';
import { Logger } from '../utils/logger.js';
import { createMetaRouter, markStartTime } from './routes/meta.js';
import { createDataRouter } from './routes/data.js';
import type { ApiServerConfig } from './types.js';

// ==================== 简单中间件实现 ====================

/**
 * 简单内存限流器（滑动窗口）
 */
function createSimpleRateLimiter(windowMs: number, maxRequests: number) {
    const windowMap = new Map<string, { count: number; resetAt: number }>();

    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();

        let entry = windowMap.get(ip);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            windowMap.set(ip, entry);
        }

        entry.count++;

        if (entry.count > maxRequests) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            res.status(429).json({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMIT_EXCEEDED' } as const);
            return;
        }

        next();
    };
}

/**
 * 简单 Bearer Token 认证中间件
 */
function createAuthMiddleware(token: string) {
    return (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const authHeader = _req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: '未提供认证令牌', code: 'UNAUTHORIZED' } as const);
            return;
        }
        const providedToken = authHeader.slice(7);
        if (providedToken !== token) {
            res.status(401).json({ error: '认证令牌无效', code: 'INVALID_TOKEN' } as const);
            return;
        }
        next();
    };
}

const serverLogger = new Logger('ApiServer');

/**
 * 创建并启动 Express HTTP Server
 *
 * @param config - API 服务配置
 * @param collector - FileCollector 实例（路由需要读取其统计信息）
 * @returns Express app 实例（可用于测试或进一步扩展）
 */
export async function createApiServer(
    _config: ApiServerConfig,
    collector: FileCollector,
): Promise<express.Application> {
    // 记录启动时刻（供 /api/meta/status 计算 uptime）
    markStartTime();

    const app = express();

    // ---- 基础中间件 ----

    // JSON 解析
    app.use(express.json({ limit: '1mb' }));

    // 请求日志（精简版）
    app.use((_req, _res, next) => {
        next();
    });

    // CORS — 默认允许所有来源（仅内网使用）
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });

    // 限流中间件（已配置但未启用）
    if (_config.rateLimit?.enabled) {
        const limiter = createSimpleRateLimiter(
            _config.rateLimit.windowMs,
            _config.rateLimit.maxRequests,
        );
        app.use(limiter);
        serverLogger.info('限流中间件已启用', {
            windowMs: _config.rateLimit.windowMs,
            maxRequests: _config.rateLimit.maxRequests,
        });
    }

    // 认证中间件（已配置但未启用）
    if (_config.auth?.enabled && _config.auth.token) {
        const authMw = createAuthMiddleware(_config.auth.token);
        app.use(authMw);
        serverLogger.info('认证中间件已启用');
    }

    // ---- 路由注册 ----

    // /api/meta/* — 模块元数据 & 状态（admin 接入规范）
    app.use('/api/meta', createMetaRouter(collector));

    // /api/data/* — collector 数据查询接口（供 admin 使用）
    app.use('/api/data', createDataRouter(collector));

    // ---- 404 处理 ----

    app.use((_req, res) => {
        res.status(404).json({
            error: '接口不存在',
            code: 'NOT_FOUND',
        } as const);
    });

    // ---- 全局错误处理 ----

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        serverLogger.error('未捕获的请求错误', err);
        res.status(500).json({
            error: err.message || '内部服务器错误',
            code: 'INTERNAL_ERROR',
        } as const);
    });

    return app;
}

/**
 * 启动 HTTP 服务监听
 *
 * @param config - API 服务配置
 * @param collector - FileCollector 实例
 * @returns Promise<void>
 */
export async function startApiServer(
    config: ApiServerConfig,
    collector: FileCollector,
): Promise<express.Application> {
    if (!config.enabled) {
        serverLogger.info('HTTP API 已禁用 (config.api.enabled=false)');
        // 返回一个空 app 但不监听端口
        return await createApiServer(config, collector);
    }

    const app = await createApiServer(config, collector);

    await new Promise<void>((resolve, reject) => {
        const server = app.listen(config.port, config.host, () => {
            serverLogger.info(`HTTP API 已启动`, {
                地址: `http://${config.host}:${config.port}`,
                接口: '/api/meta/status',
            });
            resolve();
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                serverLogger.error(`端口 ${config.port} 已被占用`);
            }
            reject(err);
        });

        // 将 server 引用挂到 app 上，方便后续关闭
        (app as any)._httpServer = server;
    });

    return app;
}
