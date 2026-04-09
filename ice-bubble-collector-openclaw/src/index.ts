/**
 * OpenClaw Data Collector
 *
 * 实时采集 OpenClaw 的 Session 数据、Agent 状态和工具调用
 */

import dotenv from 'dotenv';
import { Logger } from './utils/logger.js';

// 加载环境变量
dotenv.config();

const mainLogger = new Logger('Main');

// 导出类型
export * from './types/index.js';

// 导出核心模块 (骨架，待实现)
// export * from './collectors/index.js';
// export * from './processors/index.js';
// export * from './storage/index.js';
// export * from './strategies/index.js';

/**
 * 模块版本信息
 */
export const VERSION = '1.0.0';

/**
 * 启动采集服务
 */
export async function startCollector(): Promise<void> {
    mainLogger.info('OpenClaw Collector starting...');
    mainLogger.info(`Version: ${VERSION}`);
    mainLogger.info('Mode:', process.env.COLLECTION_MODE || 'HYBRID_PRIORITY');

    // TODO: 实现启动逻辑
    // 1. 初始化数据库连接
    // 2. 初始化 Redis 连接
    // 3. 创建采集策略
    // 4. 启动采集器
    // 5. 启动 HTTP API 服务

    mainLogger.info('OpenClaw Collector initialized (skeleton mode)');
}

// 如果直接运行此文件 (ESM 模式)
startCollector().catch((error) => {
    mainLogger.error('Failed to start collector', error);
    process.exit(1);
});
