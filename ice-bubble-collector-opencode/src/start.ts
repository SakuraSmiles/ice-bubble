/**
 * OpenCode 采集器启动入口
 * 
 * 使用方式：
 * 1. 创建 config/config.json（可选，有默认值）
 * 2. 运行：npm run dev 或 npm start
 * 
 * 环境变量：
 *   OPENCODE_DB_PATH - OpenCode 数据库路径（默认 ~/.local/share/opencode/opencode.db）
 *   COLLECTOR_PORT    - HTTP API 端口（默认 13101）
 *   POLL_INTERVAL_MS  - 轮询间隔毫秒数（默认 30000）
 *   LOG_LEVEL         - 日志级别（默认 info）
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './utils/config-loader.js';
import { SQLiteCollector } from './collectors/sqlite-collector.js';
import { startApiServer } from './api/server.js';
import { Logger } from './utils/logger.js';
import type { ApiServerConfig } from './api/types.js';

const startLogger = new Logger('Start');

const __dirname = dirname(fileURLToPath(import.meta.url));
const _rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
export const VERSION: string = _rootPkg.version;

export const startCollector = start;

async function start() {
    startLogger.info(`🚀 启动 OpenCode 采集器 v${VERSION}...\n`);

    // ==================== 1. 加载配置 ====================
    const config = await loadConfig();

    startLogger.info('📋 配置信息:');
    startLogger.info(`  - OpenCode DB: ${config.opencodeDbPath}`);
    startLogger.info(`  - 轮询间隔: ${config.pollIntervalMs}ms`);
    startLogger.info(`  - 批次大小: ${config.batchSize}`);
    startLogger.info(`  - HTTP 端口: ${config.httpPort}\n`);

    // ==================== 2. 创建并启动采集器 ====================
    const collector = new SQLiteCollector(config);
    await collector.start();

    startLogger.info('✅ OpenCode 采集器启动成功\n');

    // ==================== 3. 启动 HTTP API ====================
    const apiConfig: ApiServerConfig = {
        enabled: true,
        port: config.httpPort,
        host: config.httpHost,
    };

    const { server: httpServer } = await startApiServer(apiConfig, collector);
    startLogger.info('✅ HTTP API 已启动\n');

    startLogger.info('💡 提示: 按 Ctrl+C 停止采集器\n');

    // ==================== 4. 优雅关闭 ====================
    const shutdown = async (signal: string) => {
        startLogger.info(`\n收到 ${signal} 信号，正在关闭...`);
        await collector.stop();
        if (httpServer) {
            await new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
            });
        }
        startLogger.info('✅ 采集器已关闭');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 启动
start().catch((error) => {
    startLogger.error(
        '❌ 启动失败:',
        error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
});
