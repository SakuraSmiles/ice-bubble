/**
 * OpenClaw 采集器启动文件
 * 
 * 使用方式：
 * 1. 创建 config.json 配置文件
 * 2. 修改关键配置（dataDir、dbPath、watchPath）
 * 3. 运行：npm run dev 或 npm start
 */

import 'dotenv/config';
import { loadConfig } from './utils/config-loader.js';
import { FileCollector } from './collectors/FileCollector.js';
import { Logger } from './utils/logger.js';

const startLogger = new Logger('Start');

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
  startLogger.info('💡 提示: 按 Ctrl+C 停止采集器\n');

  // ==================== 5. 优雅关闭 ====================
  
  const shutdown = async (signal: string) => {
    startLogger.info(`\n收到 ${signal} 信号，正在关闭...`);
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
