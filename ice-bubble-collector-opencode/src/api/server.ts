/**
 * API Server — Express HTTP 服务
 *
 * 与 collector-openclaw 的 server 对齐，端口 13101，CORS 允许 Admin 访问。
 *
 * @module api/server
 */

import http from 'node:http';
import express from 'express';
import { Logger } from '../utils/logger.js';
import { createMetaRouter, markStartTime } from './routes/meta.js';
import { createDataRouter } from './routes/data.js';
import type { ApiServerConfig } from './types.js';
import type { SQLiteCollector } from '../collectors/sqlite-collector.js';

const serverLogger = new Logger('ApiServer');

export async function createApiServer(
    _config: ApiServerConfig,
    collector: SQLiteCollector,
): Promise<express.Application> {
    markStartTime();

    const app = express();

    // JSON 解析
    app.use(express.json({ limit: '1mb' }));

    // CORS — 允许 Admin (localhost:13000) 和 dev 端口
    app.use((req, res, next) => {
        const isDev = process.env.NODE_ENV !== 'production';
        const allowedOrigins = isDev
            ? ['http://localhost:13000', 'http://localhost:1420', 'http://localhost:14000']
            : ['http://localhost:13000'];

        const origin = req.header('origin');
        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        }
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });

    // 认证中间件（可选，通过 ICE_AUTH_TOKEN 环境变量启用）
    const authToken = process.env.ICE_AUTH_TOKEN || '';
    if (authToken) {
        app.use((req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== authToken) {
                res.status(401).json({ error: '认证令牌无效', code: 'INVALID_TOKEN' } as const);
                return;
            }
            next();
        });
        serverLogger.info('认证中间件已启用');
    }

    // 路由
    app.use('/api/meta', createMetaRouter(collector));
    app.use('/api/data', createDataRouter(collector));

    // 404
    app.use((_req, res) => {
        res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' } as const);
    });

    // 全局错误
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        serverLogger.error('未捕获的请求错误', err);
        res.status(500).json({ error: err.message || '内部服务器错误', code: 'INTERNAL_ERROR' } as const);
    });

    return app;
}

export async function startApiServer(
    config: ApiServerConfig,
    collector: SQLiteCollector,
): Promise<{ app: express.Application; server: http.Server }> {
    if (!config.enabled) {
        serverLogger.info('HTTP API 已禁用');
        const app = await createApiServer(config, collector);
        return { app, server: null as unknown as ReturnType<express.Application['listen']> };
    }

    const app = await createApiServer(config, collector);

    const httpServer = await new Promise<http.Server>((resolve, reject) => {
        const srv = http.createServer(app);
        srv.listen({ port: config.port, host: config.host, reuseAddr: true }, () => {
            serverLogger.info(`HTTP API 已启动`, {
                地址: `http://${config.host}:${config.port}`,
            });
            resolve(srv);
        });
        srv.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                serverLogger.error(`端口 ${config.port} 已被占用`);
            }
            reject(err);
        });
    });

    return { app, server: httpServer };
}
