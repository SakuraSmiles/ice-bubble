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

// ==================== 预设配置 ====================

/**
 * 本地文件系统监听配置
 */
const LOCAL_WATCH_OPTIONS: chokidar.WatchOptions = {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 100
  },
  usePolling: false,
  atomic: true
};

/**
 * 网络共享文件系统监听配置
 */
const NETWORK_WATCH_OPTIONS: chokidar.WatchOptions = {
  persistent: true,
  ignoreInitial: false,
  usePolling: true,
  interval: 1000,
  binaryInterval: 1000,
  awaitWriteFinish: {
    stabilityThreshold: 3000,
    pollInterval: 500
  }
};

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

  // ==================== 任务1: 文件大小限制和保护 ====================
  
  /**
   * 最大文件大小（字节）
   * 超过此大小的文件将被跳过并记录警告
   * @default 104857600 (100MB)
   */
  maxFileSize?: number;

  /**
   * 最大单行长度（字节）
   * 超过此长度的行将被跳过并记录警告
   * @default 1048576 (1MB)
   */
  maxLineLength?: number;

  // ==================== 任务2: 文件监听配置参数化 ====================
  
  /**
   * 文件监听选项（chokidar 配置）
   * 支持预设配置或自定义配置
   */
  watchOptions?: chokidar.WatchOptions;

  /**
   * 监听环境预设
   * - 'local': 本地文件系统（默认）
   * - 'network': 网络共享/NFS
   * - 'custom': 使用 watchOptions 自定义
   * @default 'local'
   */
  watchPreset?: 'local' | 'network' | 'custom';

  // ==================== 任务3: 异常恢复机制 ====================
  
  /**
   * 最大重试次数
   * 文件读取失败时的最大重试次数
   * @default 3
   */
  maxRetries?: number;

  /**
   * 重试延迟（毫秒）
   * 使用指数退避策略：delay * 2^retryCount
   * @default 1000
   */
  retryDelay?: number;

  // ==================== 性能优化：批量事件发送 ====================
  
  /**
   * 批量发送消息的条数阈值
   * 达到此数量立即发送
   * @default 100
   */
  eventBatchSize?: number;

  /**
   * 批量发送消息的时间间隔（毫秒）
   * 定时刷新缓冲区
   * @default 100
   */
  eventFlushInterval?: number;

  /**
   * 文件读取流的缓冲区大小（字节）
   * 优化文件 I/O 性能
   * @default 65536 (64KB)
   */
  highWaterMark?: number;
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
  skippedFiles: number;  // 任务1: 因大小限制跳过的文件
  totalEvents: number;
  successEvents: number;
  failedEvents: number;
  retriedEvents: number;  // 任务3: 重试次数
}

/**
 * 错误信息（任务3: 用于重试机制）
 */
interface FileError {
  filePath: string;
  error: Error;
  retryCount: number;
  lastRetryAt: number;
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
  private fileErrors: Map<string, FileError> = new Map();  // 任务3: 错误跟踪
  
  // 性能优化：批量事件发送
  private messageBuffer: UnifiedMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  
  private stats: CollectorStats = {
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    totalEvents: 0,
    successEvents: 0,
    failedEvents: 0,
    retriedEvents: 0
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
      enableIncremental: config.enableIncremental ?? true,
      // 任务1: 文件大小限制
      maxFileSize: config.maxFileSize ?? 100 * 1024 * 1024, // 100MB
      maxLineLength: config.maxLineLength ?? 1024 * 1024,   // 1MB
      // 任务2: 文件监听配置
      watchOptions: config.watchOptions ?? {},
      watchPreset: config.watchPreset ?? 'local',
      // 任务3: 异常恢复
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      // 性能优化：批量事件发送
      eventBatchSize: config.eventBatchSize ?? 100,
      eventFlushInterval: config.eventFlushInterval ?? 100,
      highWaterMark: config.highWaterMark ?? 64 * 1024  // 64KB
    };

    logger.info('FileCollector 初始化', {
      数据目录: this.config.openclawDataDir,
      文件监听: this.config.enableWatch,
      扫描间隔: this.config.scanInterval,
      批量大小: this.config.batchSize,
      增量读取: this.config.enableIncremental,
      最大文件大小: `${this.config.maxFileSize / 1024 / 1024}MB`,
      最大行长度: `${this.config.maxLineLength / 1024}KB`,
      监听预设: this.config.watchPreset,
      最大重试次数: this.config.maxRetries,
      事件批量大小: this.config.eventBatchSize,
      事件刷新间隔: `${this.config.eventFlushInterval}ms`,
      流缓冲区: `${this.config.highWaterMark / 1024}KB`
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

    // 启动定时刷新器
    this.startFlushTimer();

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

    // 刷新剩余消息
    await this.flushMessages();

    // 停止定时刷新器
    this.stopFlushTimer();

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

  // ==================== 性能优化：批量事件发送 ====================

  /**
   * 启动定时刷新器
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.flushMessages().catch(error => {
        logger.error('定时刷新消息失败', error as Error);
      });
    }, this.config.eventFlushInterval);

    logger.debug(`启动定时刷新器，间隔: ${this.config.eventFlushInterval}ms`);
  }

  /**
   * 停止定时刷新器
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      logger.debug('定时刷新器已停止');
    }
  }

  /**
   * 添加消息到缓冲区
   * 
   * @param message - 统一消息
   */
  private addMessageToBuffer(message: UnifiedMessage): void {
    this.messageBuffer.push(message);

    // 达到批量大小，立即刷新
    if (this.messageBuffer.length >= this.config.eventBatchSize) {
      this.flushMessages().catch(error => {
        logger.error('批量刷新消息失败', error as Error);
      });
    }
  }

  /**
   * 刷新消息缓冲区（批量发送）
   */
  private async flushMessages(): Promise<void> {
    if (this.messageBuffer.length === 0) {
      return;
    }

    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    logger.debug(`批量发送 ${messages.length} 条消息`);

    // 发送批量消息事件
    this.emit('messages', messages);

    // 兼容性：同时发送单个消息事件
    for (const message of messages) {
      this.emit('message', message);
    }
  }

  // ==================== 任务1: 文件大小验证 ====================

  /**
   * 验证文件大小是否合法
   * 
   * @param filePath - 文件路径
   * @returns true: 合法, false: 文件过大
   */
  private validateFile(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;

      if (fileSize > this.config.maxFileSize) {
        logger.warn(
          `文件大小超出限制，跳过处理: ${filePath}`,
          {
            文件大小: `${(fileSize / 1024 / 1024).toFixed(2)}MB`,
            限制大小: `${(this.config.maxFileSize / 1024 / 1024).toFixed(2)}MB`
          }
        );
        this.stats.skippedFiles++;
        return false;
      }

      return true;
    } catch (error) {
      logger.error(`文件状态读取失败: ${filePath}`, error as Error);
      return false;
    }
  }

  /**
   * 验证单行长度是否合法
   * 
   * @param line - 单行内容
   * @param lineNumber - 行号
   * @param filePath - 文件路径（用于日志）
   * @returns true: 合法, false: 行过长
   */
  private validateLine(line: string, lineNumber: number, filePath: string): boolean {
    const lineLength = Buffer.byteLength(line, 'utf-8');

    if (lineLength > this.config.maxLineLength) {
      logger.warn(
        `行长度超出限制，跳过此行`,
        {
          文件: filePath,
          行号: lineNumber,
          行长度: `${(lineLength / 1024).toFixed(2)}KB`,
          限制长度: `${(this.config.maxLineLength / 1024).toFixed(2)}KB`
        }
      );
      return false;
    }

    return true;
  }

  // ==================== 任务3: 异常恢复机制 ====================

  /**
   * 处理文件错误（带重试机制）
   * 
   * @param filePath - 文件路径
   * @param error - 错误对象
   * @param operation - 操作函数
   */
  private async handleFileError(
    filePath: string,
    error: Error,
    operation: () => Promise<void>
  ): Promise<void> {
    const existingError = this.fileErrors.get(filePath);
    const retryCount = existingError ? existingError.retryCount + 1 : 1;

    logger.warn(
      `文件处理失败，准备重试`,
      {
        文件: filePath,
        重试次数: `${retryCount}/${this.config.maxRetries}`,
        错误: error.message
      }
    );

    // 记录错误信息
    this.fileErrors.set(filePath, {
      filePath,
      error,
      retryCount,
      lastRetryAt: Date.now()
    });

    // 检查是否达到最大重试次数
    if (retryCount >= this.config.maxRetries) {
      logger.error(
        `文件处理失败，已达到最大重试次数`,
        {
          文件: filePath,
          重试次数: retryCount,
          错误: error.message
        }
      );
      
      // 发送错误事件
      this.emit('error', new Error(
        `文件处理失败（已重试 ${retryCount} 次）: ${filePath} - ${error.message}`
      ));
      
      // 移除错误记录
      this.fileErrors.delete(filePath);
      return;
    }

    // 指数退避延迟
    const delay = this.config.retryDelay * Math.pow(2, retryCount - 1);
    await this.sleep(delay);

    // 重试操作
    try {
      this.stats.retriedEvents++;
      await operation();
      
      // 重试成功，清除错误记录
      this.fileErrors.delete(filePath);
      logger.info(`文件处理重试成功: ${filePath}`, { 重试次数: retryCount });
    } catch (retryError) {
      // 递归重试
      await this.handleFileError(filePath, retryError as Error, operation);
    }
  }

  /**
   * 延迟方法
   * 
   * @param ms - 毫秒数
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        // 任务1: 文件大小验证
        if (!this.validateFile(filePath)) {
          continue;
        }

        await this.processFile(filePath, true);
        this.stats.processedFiles++;
      } catch (error) {
        logger.error(`文件处理失败: ${filePath}`, error as Error);
        
        // 任务3: 异常恢复机制
        await this.handleFileError(filePath, error as Error, async () => {
          await this.processFile(filePath, true);
          this.stats.processedFiles++;
        });
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

    // 任务2: 根据预设选择配置
    let watchOptions: chokidar.WatchOptions;
    
    switch (this.config.watchPreset) {
      case 'local':
        watchOptions = { ...LOCAL_WATCH_OPTIONS, ...this.config.watchOptions };
        break;
      case 'network':
        watchOptions = { ...NETWORK_WATCH_OPTIONS, ...this.config.watchOptions };
        break;
      case 'custom':
        watchOptions = this.config.watchOptions;
        break;
      default:
        watchOptions = LOCAL_WATCH_OPTIONS;
    }

    // 覆盖必要配置
    watchOptions.ignoreInitial = true; // 忽略初始扫描（已在 scanAllFiles 中处理）

    logger.debug('文件监听配置', {
      预设: this.config.watchPreset,
      usePolling: watchOptions.usePolling,
      awaitWriteFinish: watchOptions.awaitWriteFinish
    });

    this.watcher = chokidar.watch(watchPattern, watchOptions);

    // 文件新增
    this.watcher.on('add', async (filePath) => {
      logger.info(`新文件: ${filePath}`);
      try {
        // 任务1: 文件大小验证
        if (!this.validateFile(filePath)) {
          return;
        }

        await this.processFile(filePath, false);
        this.stats.totalFiles++;
        this.stats.processedFiles++;
      } catch (error) {
        logger.error(`处理新文件失败: ${filePath}`, error as Error);
        
        // 任务3: 异常恢复机制
        await this.handleFileError(filePath, error as Error, async () => {
          await this.processFile(filePath, false);
          this.stats.totalFiles++;
          this.stats.processedFiles++;
        });
      }
    });

    // 文件修改
    this.watcher.on('change', async (filePath) => {
      logger.debug(`文件修改: ${filePath}`);
      try {
        // 任务1: 文件大小验证
        if (!this.validateFile(filePath)) {
          return;
        }

        await this.processFile(filePath, false);
      } catch (error) {
        logger.error(`处理文件修改失败: ${filePath}`, error as Error);
        
        // 任务3: 异常恢复机制
        await this.handleFileError(filePath, error as Error, async () => {
          await this.processFile(filePath, false);
        });
      }
    });

    // 文件删除
    this.watcher.on('unlink', (filePath) => {
      logger.info(`文件删除: ${filePath}`);
      this.fileProgress.delete(filePath);
      this.fileErrors.delete(filePath);  // 任务3: 清理错误记录
      this.stats.totalFiles--;
    });

    // 错误处理
    this.watcher.on('error', (error) => {
      logger.error('文件监听器错误', error);
      this.emit('error', error);
    });

    logger.info('文件监听器已启动', { 预设: this.config.watchPreset });
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
      const result = await readJsonlFileIncremental(filePath, startLine, {
        highWaterMark: this.config.highWaterMark
      });
      events = result.events;
      endLine = result.endLine;
    } else {
      // 全量读取（不推荐）
      const result = await readJsonlFileIncremental(filePath, 0, {
        highWaterMark: this.config.highWaterMark
      });
      events = result.events;
      endLine = result.endLine;
    }

    logger.debug(`读取到 ${events.length} 个事件，起始行: ${startLine}，结束行: ${endLine}`);

    // 任务1: 行长度验证（过滤超长行）
    const validEvents: OpenClawEvent[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventStr = JSON.stringify(event);
      const lineNumber = startLine + i + 1;

      if (this.validateLine(eventStr, lineNumber, filePath)) {
        validEvents.push(event);
      }
    }

    // 更新进度
    const fileStat = fs.statSync(filePath);
    this.fileProgress.set(filePath, {
      filePath,
      lastLine: endLine,
      lastModified: fileStat.mtimeMs
    });

    // 批量处理事件
    if (validEvents.length > 0) {
      await this.processEvents(validEvents, sessionKey);
    }

    // 发送状态事件
    this.emit('status', {
      total: this.stats.totalEvents,
      processed: this.stats.successEvents,
      failed: this.stats.failedEvents,
      skipped: this.stats.skippedFiles,
      retried: this.stats.retriedEvents
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
            // 性能优化：添加到缓冲区而不是立即发送
            this.addMessageToBuffer(message);
            this.stats.successEvents++;
            logger.debug(`缓存消息: ${message.id}`);
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
      skippedFiles: 0,
      totalEvents: 0,
      successEvents: 0,
      failedEvents: 0,
      retriedEvents: 0
    };
    this.fileProgress.clear();
    this.fileErrors.clear();
    logger.info('统计信息已重置');
  }
}
