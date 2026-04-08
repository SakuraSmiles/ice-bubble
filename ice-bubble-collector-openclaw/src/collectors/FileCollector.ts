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
import { UnifiedMessage, Collector, SessionMessage } from '../types/index.js';
import { OpenClawEvent } from '../types/openclaw.js';
import { Logger } from '../utils/logger.js';
import { DataValidator } from '../processors/DataValidator.js';
import { Deduplicator } from '../processors/deduplicator.js';
import { BatchWriter } from '../processors/BatchWriter.js';
import { SQLiteManager } from '../storage/sqlite-manager.js';

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

  // ==================== 处理层配置 ====================

  /**
   * 数据库文件路径
   * SQLite 数据库存储位置
   */
  dbPath: string;

  /**
   * 去重缓存大小
   * @default 10000
   */
  deduplicationCacheSize?: number;

  /**
   * 批量写入大小
   * @default 100
   */
  writerBatchSize?: number;

  /**
   * 批量写入刷新间隔（毫秒）
   * @default 5000
   */
  writerFlushInterval?: number;
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
  
  // 处理层组件
  private sqliteManager: SQLiteManager;
  private validator: DataValidator;
  private deduplicator: Deduplicator;
  private batchWriter: BatchWriter;
  
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
      // 处理层配置
      dbPath: config.dbPath,
      deduplicationCacheSize: config.deduplicationCacheSize ?? 10000,
      writerBatchSize: config.writerBatchSize ?? 100,
      writerFlushInterval: config.writerFlushInterval ?? 5000
    };

    // 初始化存储层
    this.sqliteManager = new SQLiteManager();
    
    // 初始化处理层组件
    this.validator = new DataValidator();
    this.deduplicator = new Deduplicator({ cacheSize: this.config.deduplicationCacheSize });
    this.batchWriter = new BatchWriter(this.sqliteManager, {
      batchSize: this.config.writerBatchSize,
      flushInterval: this.config.writerFlushInterval
    });

    // 监听 BatchWriter 事件
    this.batchWriter.on('flush', ({ count }) => {
      this.emit('batch:flush', { count });
      logger.debug(`批量写入完成: ${count} 条消息`);
    });

    this.batchWriter.on('error', (error) => {
      logger.error('BatchWriter 错误', error);
      this.emit('error', error);
    });

    logger.info('FileCollector 初始化', {
      数据目录: this.config.openclawDataDir,
      数据库路径: this.config.dbPath,
      文件监听: this.config.enableWatch,
      扫描间隔: this.config.scanInterval,
      批量大小: this.config.batchSize,
      增量读取: this.config.enableIncremental,
      最大文件大小: `${this.config.maxFileSize / 1024 / 1024}MB`,
      最大行长度: `${this.config.maxLineLength / 1024}KB`,
      监听预设: this.config.watchPreset,
      最大重试次数: this.config.maxRetries,
      去重缓存大小: this.config.deduplicationCacheSize,
      写入批量大小: this.config.writerBatchSize,
      写入刷新间隔: `${this.config.writerFlushInterval}ms`
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

    // 初始化数据库
    await this.sqliteManager.init({
      dbPath: this.config.dbPath,
      walMode: true,
      foreignKeys: true
    });

    // 启动 BatchWriter
    this.batchWriter.start();

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

    // 停止 BatchWriter（会自动刷新剩余消息）
    await this.batchWriter.stop();

    // 关闭数据库连接
    await this.sqliteManager.close();

    logger.info('FileCollector 已停止', this.stats);
  }

  /**
   * 获取采集器名称
   */
  getName(): string {
    return 'FileCollector';
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
   * 确保 session 存在于数据库中
   *
   * @param sessionKey - Session Key
   */
  private async ensureSession(sessionKey: string): Promise<void> {
    // 解析 sessionKey: agent:{agentId}:{channel}:{accountId}:{type}:{peerId}
    const parts = sessionKey.split(':');
    if (parts.length !== 6 || parts[0] !== 'agent') {
      logger.warn(`无效的 SessionKey 格式: ${sessionKey}`);
      return;
    }

    const [, agentId, channel, accountId, sessionType, peerId] = parts;

    // 检查 session 是否已存在
    const existingSession = await this.sqliteManager.getSession(sessionKey);
    if (existingSession) {
      return;
    }

    // 创建新的 session
    const session = {
      sessionKey,
      agentId,
      channel,
      accountId: accountId || undefined,
      peerId: peerId || undefined,
      guildId: sessionType === 'guild' ? peerId : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      messageCount: 0
    };

    await this.sqliteManager.upsertSession(session);
    logger.debug(`创建 Session: ${sessionKey}`);
  }

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

    // 确保 session 存在
    await this.ensureSession(sessionKey);

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

          // 步骤1: 转换为 UnifiedMessage
          const message = convertOpenClawEvent(event, sessionKey);

          if (!message) {
            logger.debug(`事件转换返回 null，跳过: ${event.id}`);
            continue;
          }

          // 步骤2: 数据验证 (DataValidator)
          const validation = this.validator.validate(message);
          if (!validation.valid) {
            this.stats.failedEvents++;
            this.emit('invalid', { message, errors: validation.errors });
            logger.warn(`消息验证失败: ${message.id}`, { errors: validation.errors });
            continue;
          }

          // 步骤3: 去重检查 (Deduplicator)
          if (this.deduplicator.isDuplicate(message.id)) {
            this.emit('duplicate', { messageId: message.id });
            logger.debug(`重复消息，跳过: ${message.id}`);
            continue;
          }
          this.deduplicator.markAsProcessed(message.id);

          // 步骤4: 转换为 SessionMessage 格式
          const sessionMessage: SessionMessage = {
            sessionKey: message.sessionKey,
            messageType: message.messageType,
            content: message.content,
            model: message.model,
            tokensInput: message.tokens?.input,
            tokensOutput: message.tokens?.output,
            toolsJson: message.tools ? JSON.stringify(message.tools) : undefined,
            timestamp: message.timestamp
          };

          // 步骤5: 批量写入 (BatchWriter)
          this.batchWriter.addMessage(sessionMessage);
          this.stats.successEvents++;

          // 发送单条消息事件（保持兼容性）
          this.emit('message', message);

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
