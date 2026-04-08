/**
 * FileCollector - 文件采集器
 * 
 * 功能：
 * - 扫描 OpenClaw Session 文件
 * - 监听文件变化（新增、修改）
 * - 增量读取避免重复处理
 * - 数据转换和事件发送
 * 
 * 依赖：
 * - chokidar: 文件监听
 * - readJsonlFileIncremental: 增量读取
 * - convertOpenClawEvent: 数据转换
 * - buildSessionKeyFromPath: SessionKey 构造
 */

import { EventEmitter } from 'events';
import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { BaseCollector } from './base.js';
import { readJsonlFileIncremental } from '../utils/file-reader.js';
import { buildSessionKeyFromPath } from '../utils/session-key-builder.js';
import { convertOpenClawEvent } from '../converters/openclaw-to-unified.js';
import { UnifiedMessage, Collector } from '../types/index.js';
import { OpenClawEvent } from '../types/openclaw.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('FileCollector');

// ==================== 配置接口 ====================

/**
 * FileCollector 配置
 */
export interface FileCollectorConfig {
  /**
   * OpenClaw 数据根目录
   * @example '~/.openclaw' 或 'C:/Users/dabai/.openclaw'
   */
  openclawDataDir: string;

  /**
   * 是否启用文件监听
   * @default true
   */
  enableWatch?: boolean;

  /**
   * 扫描间隔（毫秒），仅当 enableWatch=false 时生效
   * @default 5000
   */
  scanInterval?: number;

  /**
   * 批量处理大小
   * @default 100
   */
  batchSize?: number;

  /**
   * 是否启用增量读取
   * @default true
   */
  enableIncremental?: boolean;
}

/**
 * 文件读取进度
 */
interface FileProgress {
  filePath: string;
  lastLine: number;
  lastModified: number;
}

/**
 * 统计信息
 */
interface CollectorStats {
  totalFiles: number;
  processedFiles: number;
  totalEvents: number;
  successEvents: number;
  failedEvents: number;
}

// ==================== FileCollector 类 ====================

/**
 * 文件采集器
 * 
 * @example
 * const collector = new FileCollector({
 *   openclawDataDir: 'C:/Users/dabai/.openclaw',
 *   enableWatch: true,
 *   batchSize: 100
 * });
 * 
 * collector.on('message', (message: UnifiedMessage) => {
 *   console.log('收到消息:', message.id);
 * });
 * 
 * collector.on('error', (error: Error) => {
 *   console.error('错误:', error);
 * });
 * 
 * collector.on('status', (stats) => {
 *   console.log('统计:', stats);
 * });
 * 
 * await collector.start();
 */
export class FileCollector extends BaseCollector implements Collector {
  private config: Required<FileCollectorConfig>;
  private watcher: chokidar.FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private fileProgress: Map<string, FileProgress> = new Map();
  private stats: CollectorStats = {
    totalFiles: 0,
    processedFiles: 0,
    totalEvents: 0,
    successEvents: 0,
    failedEvents: 0
  };
  private isRunning = false;

  /**
   * 构造函数
   */
  constructor(config: FileCollectorConfig) {
    super();
    
    // 合并默认配置
    this.config = {
      openclawDataDir: config.openclawDataDir,
      enableWatch: config.enableWatch ?? true,
      scanInterval: config.scanInterval ?? 5000,
      batchSize: config.batchSize ?? 100,
      enableIncremental: config.enableIncremental ?? true
    };

    logger.info('FileCollector 初始化', {
      数据目录: this.config.openclawDataDir,
      文件监听: this.config.enableWatch,
      扫描间隔: this.config.scanInterval,
      批量大小: this.config.batchSize,
      增量读取: this.config.enableIncremental
    });
  }

  // ==================== 生命周期方法 ====================

  /**
   * 启动采集器
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('FileCollector 已经在运行中');
      return;
    }

    logger.info('启动 FileCollector...');
    this.isRunning = true;

    // 检查数据目录是否存在
    if (!fs.existsSync(this.config.openclawDataDir)) {
      throw new Error(`OpenClaw 数据目录不存在: ${this.config.openclawDataDir}`);
    }

    // 初始扫描所有文件
    await this.scanAllFiles();

    // 启动文件监听或定时扫描
    if (this.config.enableWatch) {
      await this.startWatcher();
    } else {
      this.startPeriodicScan();
    }

    logger.info('FileCollector 启动完成', this.stats);
  }

  /**
   * 停止采集器
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('FileCollector 未运行');
      return;
    }

    logger.info('停止 FileCollector...');
    this.isRunning = false;

    // 停止文件监听
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.debug('文件监听器已关闭');
    }

    // 停止定时扫描
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      logger.debug('定时扫描已停止');
    }

    logger.info('FileCollector 已停止', this.stats);
  }

  /**
   * 获取采集器名称
   */
  getName(): string {
    return 'FileCollector';
  }

  // ==================== 文件扫描 ====================

  /**
   * 扫描所有 Session 文件
   * 
   * 扫描路径: ~/.openclaw/agents/*/sessions/*.jsonl
   */
  private async scanAllFiles(): Promise<void> {
    logger.debug('开始扫描所有 Session 文件...');

    const sessionsPattern = path.join(
      this.config.openclawDataDir,
      'agents',
      '*',
      'sessions',
      '*.jsonl'
    );

    logger.debug(`扫描模式: ${sessionsPattern}`);

    // 使用 glob 模式查找文件
    const files = await this.findJsonlFiles(sessionsPattern);

    logger.info(`发现 ${files.length} 个 Session 文件`);

    // 统计
    this.stats.totalFiles = files.length;

    // 处理每个文件
    for (const filePath of files) {
      try {
        await this.processFile(filePath, true);
        this.stats.processedFiles++;
      } catch (error) {
        logger.error(`文件处理失败: ${filePath}`, error as Error);
        this.emit('error', error);
      }
    }
  }

  /**
   * 查找所有 .jsonl 文件
   */
  private async findJsonlFiles(pattern: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const files: string[] = [];
      
      // 使用 chokidar 进行 glob 匹配（仅扫描，不监听）
      const tempWatcher = chokidar.watch(pattern, {
        persistent: false,
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100
        }
      });

      tempWatcher.on('add', (filePath) => {
        files.push(filePath);
      });

      tempWatcher.on('ready', () => {
        tempWatcher.close();
        resolve(files);
      });

      tempWatcher.on('error', (error) => {
        tempWatcher.close();
        reject(error);
      });
    });
  }

  // ==================== 文件监听 ====================

  /**
   * 启动文件监听器
   */
  private async startWatcher(): Promise<void> {
    const watchPattern = path.join(
      this.config.openclawDataDir,
      'agents',
      '*',
      'sessions',
      '*.jsonl'
    );

    logger.debug(`启动文件监听: ${watchPattern}`);

    this.watcher = chokidar.watch(watchPattern, {
      persistent: true,
      ignoreInitial: true, // 忽略初始扫描（已在 scanAllFiles 中处理）
      awaitWriteFinish: {
        stabilityThreshold: 1000, // 等待文件写入完成
        pollInterval: 200
      }
    });

    // 文件新增
    this.watcher.on('add', async (filePath) => {
      logger.info(`新文件: ${filePath}`);
      try {
        await this.processFile(filePath, false);
        this.stats.totalFiles++;
        this.stats.processedFiles++;
      } catch (error) {
        logger.error(`处理新文件失败: ${filePath}`, error as Error);
        this.emit('error', error);
      }
    });

    // 文件修改
    this.watcher.on('change', async (filePath) => {
      logger.debug(`文件修改: ${filePath}`);
      try {
        await this.processFile(filePath, false);
      } catch (error) {
        logger.error(`处理文件修改失败: ${filePath}`, error as Error);
        this.emit('error', error);
      }
    });

    // 文件删除
    this.watcher.on('unlink', (filePath) => {
      logger.info(`文件删除: ${filePath}`);
      this.fileProgress.delete(filePath);
      this.stats.totalFiles--;
    });

    // 错误处理
    this.watcher.on('error', (error) => {
      logger.error('文件监听器错误', error);
      this.emit('error', error);
    });

    logger.info('文件监听器已启动');
  }

  /**
   * 启动定时扫描
   */
  private startPeriodicScan(): void {
    logger.info(`启动定时扫描，间隔: ${this.config.scanInterval}ms`);

    this.scanTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        logger.debug('执行定时扫描...');
        await this.scanAllFiles();
      } catch (error) {
        logger.error('定时扫描失败', error as Error);
        this.emit('error', error);
      }
    }, this.config.scanInterval);
  }

  // ==================== 文件处理 ====================

  /**
   * 处理单个文件
   * 
   * @param filePath - 文件路径
   * @param isInitialScan - 是否为初始扫描
   */
  private async processFile(filePath: string, isInitialScan: boolean): Promise<void> {
    logger.debug(`处理文件: ${filePath}`);

    // 构造 SessionKey
    const sessionKey = buildSessionKeyFromPath(filePath);
    logger.debug(`SessionKey: ${sessionKey}`);

    // 获取文件进度
    const progress = this.fileProgress.get(filePath);
    const startLine = progress ? progress.lastLine : 0;

    // 增量读取文件
    let events: OpenClawEvent[] = [];
    let endLine = 0;

    if (this.config.enableIncremental) {
      const result = await readJsonlFileIncremental(filePath, startLine);
      events = result.events;
      endLine = result.endLine;
    } else {
      // 全量读取（不推荐）
      const result = await readJsonlFileIncremental(filePath, 0);
      events = result.events;
      endLine = result.endLine;
    }

    logger.debug(`读取到 ${events.length} 个事件，起始行: ${startLine}，结束行: ${endLine}`);

    // 更新进度
    const fileStat = fs.statSync(filePath);
    this.fileProgress.set(filePath, {
      filePath,
      lastLine: endLine,
      lastModified: fileStat.mtimeMs
    });

    // 批量处理事件
    if (events.length > 0) {
      await this.processEvents(events, sessionKey);
    }

    // 发送状态事件
    this.emit('status', {
      total: this.stats.totalEvents,
      processed: this.stats.successEvents,
      failed: this.stats.failedEvents
    });
  }

  /**
   * 批量处理事件
   * 
   * @param events - OpenClaw 事件数组
   * @param sessionKey - Session Key
   */
  private async processEvents(events: OpenClawEvent[], sessionKey: string): Promise<void> {
    logger.debug(`批量处理 ${events.length} 个事件`);

    // 分批处理
    const batches = this.chunkArray(events, this.config.batchSize);

    for (const batch of batches) {
      for (const event of batch) {
        try {
          this.stats.totalEvents++;

          // 转换为 UnifiedMessage
          const message = convertOpenClawEvent(event, sessionKey);

          if (message) {
            // 发送消息事件
            this.emit('message', message);
            this.stats.successEvents++;
            logger.debug(`发送消息: ${message.id}`);
          }
        } catch (error) {
          this.stats.failedEvents++;
          logger.error(`事件处理失败: ${event.id}`, error as Error);
          this.emit('error', error);
        }
      }
    }

    logger.debug(
      `批量处理完成: 成功 ${this.stats.successEvents}，失败 ${this.stats.failedEvents}`
    );
  }

  // ==================== 辅助方法 ====================

  /**
   * 数组分块
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * 获取统计信息
   */
  getStats(): CollectorStats {
    return { ...this.stats };
  }

  /**
   * 获取文件进度
   */
  getFileProgress(): Map<string, FileProgress> {
    return new Map(this.fileProgress);
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalFiles: 0,
      processedFiles: 0,
      totalEvents: 0,
      successEvents: 0,
      failedEvents: 0
    };
    this.fileProgress.clear();
    logger.info('统计信息已重置');
  }
}
