/**
 * OpenClaw 采集器启动文件
 * 
 * 使用方式：
 * 1. 创建 config.json 配置文件
 * 2. 修改关键配置（dataDir、dbPath、watchPath）
 * 3. 运行：npm run dev 或 npm start
 */

import 'dotenv/config';
import http from 'node:http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './utils/config-loader.js';
import { FileCollector } from './collectors/FileCollector.js';
import { Logger } from './utils/logger.js';

const startLogger = new Logger('Start');

const __dirname = dirname(fileURLToPath(import.meta.url));
const _rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
export const VERSION: string = _rootPkg.version;

export const startCollector = start;

async function start() {
  startLogger.info('🚀 启动 OpenClaw 采集器...\n');

  // ==================== 1. 加载配置 ====================
  
  const config = await loadConfig();
  
  startLogger.info('📋 配置信息:');
  startLogger.info(`  - OpenClaw 数据目录: ${config.openclaw.dataDir}`);
  startLogger.info(`  - 数据库路径: ${config.storage.sqlite.dbPath}`);
  startLogger.info(`  - 文件监听路径: ${config.collection.file.watchPath}`);
  startLogger.info(`  - 采集模式: ${config.collection.mode}`);
  startLogger.info(`  - 文件监听预设: ${config.collection.file.watchPreset}`);
  startLogger.info(`  - 文件监听选项: ${JSON.stringify(config.collection.file.watchOptions)}\n`);

  // ==================== 2. 创建采集器 ====================
  
  const collector = new FileCollector({
    openclawDataDir: config.openclaw.dataDir,
    dbPath: config.storage.sqlite.dbPath,
    enableWatch: config.collection.file.enableWatch,
    batchSize: config.processing.batchWriter.batchSize,
    maxFileSize: config.collection.file.maxFileSize,
    maxLineLength: config.collection.file.maxLineLength,
    watchPreset: config.collection.file.watchPreset,
    deduplicationCacheSize: config.processing.deduplicator.cacheSize,
    writerBatchSize: config.processing.batchWriter.batchSize,
    writerFlushInterval: config.processing.batchWriter.flushInterval,
  });

  // ==================== 3. 监听事件 ====================
  
  // 消息事件
  collector.on('message', (msg) => {
    startLogger.info(`📨 [${msg.messageType}] ${msg.id}`);
  });

  // 验证失败事件
  collector.on('invalid', (event) => {
    startLogger.warn(`⚠️  验证失败: ${event.message.id}`);
    startLogger.warn(`   错误: ${event.errors.join(', ')}`);
  });

  // 重复消息事件
  collector.on('duplicate', (event) => {
    startLogger.info(`🔁 重复消息: ${event.messageId}`);
  });

  // 批量写入事件
  collector.on('batch:flush', (event) => {
    startLogger.info(`💾 批量写入: ${event.count} 条消息`);
  });

  // 错误事件
  collector.on('error', (error) => {
    startLogger.error('❌ 采集器错误:', error instanceof Error ? error : new Error(String(error)));
  });

  // ==================== 4. 启动采集器 ====================
  
  await collector.start();
  startLogger.info('✅ 采集器启动成功\n');

  // ==================== 5. 启动 HTTP API ====================

  let httpServer: http.Server | null = null;
  if (config.api.enabled) {
    const { startApiServer } = await import('./api/server.js');
    const { server } = await startApiServer(config.api, collector);
    httpServer = server;
    startLogger.info('✅ HTTP API 已启动\n');
  }

  // 启动每日归档调度器（凌晨 3 点执行，保留 30 天数据）
  collector.startArchiveScheduler(30);
  startLogger.info('✅ 数据归档调度器已启动\n');

  startLogger.info('💡 提示: 按 Ctrl+C 停止采集器\n');

  // ==================== 6. 优雅关闭 ====================
  
  const shutdown = async (signal: string) => {
    startLogger.info(`\n收到 ${signal} 信号，正在关闭...`);
    if (httpServer) {
      if (typeof (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
        (httpServer as unknown as { closeAllConnections: () => void }).closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          startLogger.warn('HTTP Server 关闭超时 (5s)，强制退出');
          resolve();
        }, 5000);
        httpServer!.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await collector.stop();
    startLogger.info('✅ 采集器已关闭');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 启动
start().catch((error) => {
  startLogger.error('❌ 启动失败:', error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
