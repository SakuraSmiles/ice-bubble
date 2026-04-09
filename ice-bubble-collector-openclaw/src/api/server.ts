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
