/**
 * FileCollector - 文件采集器 (Facade 模式)
 *
 * 职责：
 * - 编排文件扫描、监听、处理流程
 * - 对外提供统一的采集器接口
 *
 * 已拆分出的内部服务：
 * - FileWatcher: chokidar 生命周期管理
 * - CollectionPipeline: 数据处理管道（转换→验证→去重→写入）
 *
 * @module FileCollector
 */

import * as path from 'path';
import * as fs from 'fs';
import { BaseCollector } from './base.js';
import { FileWatcher } from './FileWatcher.js';
import { CollectionPipeline } from './CollectionPipeline.js';
import { readJsonlFileIncremental } from '../utils/file-reader.js';
import { buildSessionKeyFromPath, extractAgentId } from '../utils/session-key-builder.js';
import { Collector } from '../types/index.js';
import { OpenClawEvent } from '../types/openclaw.js';
import { Logger } from '../utils/logger.js';
import { DataValidator } from '../processors/DataValidator.js';
import { Deduplicator } from '../processors/deduplicator.js';
import { BatchWriter } from '../processors/BatchWriter.js';
import { SQLiteManager } from '../storage/sqlite-manager.js';
import { SessionCache } from '../utils/session-cache.js';

const logger = new Logger('FileCollector');

// ==================== 配置接口 ====================

/**
 * FileCollector 配置
 */
export interface FileCollectorConfig {
  /** OpenClaw 数据根目录 */
  openclawDataDir: string;

  /** 是否启用文件监听 @default true */
  enableWatch?: boolean;

  /** 扫描间隔（毫秒），仅当 enableWatch=false 时生效 @default 5000 */
  scanInterval?: number;

  /** 批量处理大小 @default 100 */
  batchSize?: number;

  /** 是否启用增量读取 @default true */
  enableIncremental?: boolean;

  // ==================== 文件大小限制 ====================

  /** 最大文件大小（字节）@default 104857600 (100MB) */
  maxFileSize?: number;

  /** 最大单行长度（字节）@default 1048576 (1MB) */
  maxLineLength?: number;

  // ==================== 文件监听配置 ====================

  /** 监听环境预设 @default 'local' */
  watchPreset?: 'local' | 'network' | 'custom';

  // ==================== 异常恢复机制 ====================

  /** 最大重试次数 @default 3 */
  maxRetries?: number;

  /** 重试延迟（毫秒），指数退避: delay * 2^retryCount @default 1000 */
  retryDelay?: number;

  // ==================== 处理层配置 ====================

  /** 数据库文件路径 */
  dbPath: string;

  /** 去重缓存大小 @default 10000 */
  deduplicationCacheSize?: number;

  /** 写入批量大小 @default 100 */
  writerBatchSize?: number;

  /** 写入刷新间隔（毫秒）@default 5000 */
  writerFlushInterval?: number;
}

// ==================== 内部数据结构 ====================

/** 文件读取进度 */
interface FileProgress {
  filePath: string;
  lastLine: number;
  lastModified: number;
}

/** 统计信息 */
export interface CollectorStats {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  totalEvents: number;
  successEvents: number;
  failedEvents: number;
  retriedEvents: number;
}

/** 错误追踪（用于重试机制） */
interface FileError {
  filePath: string;
  error: Error;
  retryCount: number;
  lastRetryAt: number;
}

// ==================== FileCollector 类 (Facade) ====================

/**
 * 文件采集器 - 门面模式
 *
 * 内部组合 FileWatcher + CollectionPipeline，对外保持 Collector 接口不变。
 *
 * @example
 * const collector = new FileCollector({
 *   openclawDataDir: '~/.openclaw',
 *   dbPath: './data/collector.db',
 * });
 *
 * collector.on('message', (msg) => console.log(msg));
 * await collector.start();
 */
export class FileCollector extends BaseCollector implements Collector {
  private config: Required<FileCollectorConfig>;
  private fileWatcher!: FileWatcher;
  private pipeline!: CollectionPipeline;
  private sessionCache: SessionCache | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private fileProgress: Map<string, FileProgress> = new Map();
  private fileErrors: Map<string, FileError> = new Map();
  /** 从 openclaw.json 配置的 agent_id 集合，用于过滤幽灵 agent */
  private configuredAgentIds: Set<string> = new Set();
  /** syncAgentsFromConfig 失败时的降级内存列表 */
  private fallbackAgentIds: string[] = [];
  private stats: CollectorStats = {
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    totalEvents: 0,
    successEvents: 0,
    failedEvents: 0,
    retriedEvents: 0,
  };
  private isRunning = false;
  private sqliteManager!: SQLiteManager;
  private deduplicator!: Deduplicator;

  constructor(config: FileCollectorConfig) {
    super();

    // 构造函数只保存配置，不创建任何子组件，也不绑定任何事件。
    // 所有副作用（对象创建、事件监听、I/O 初始化）统一在 start() 中完成。
    this.config = {
      openclawDataDir: config.openclawDataDir,
      enableWatch: config.enableWatch ?? true,
      scanInterval: config.scanInterval ?? 5000,
      batchSize: config.batchSize ?? 100,
      enableIncremental: config.enableIncremental ?? true,
      maxFileSize: config.maxFileSize ?? 100 * 1024 * 1024,
      maxLineLength: config.maxLineLength ?? 1024 * 1024,
      watchPreset: config.watchPreset ?? 'local',
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      dbPath: config.dbPath,
      deduplicationCacheSize: config.deduplicationCacheSize ?? 10000,
      writerBatchSize: config.writerBatchSize ?? 100,
      writerFlushInterval: config.writerFlushInterval ?? 5000,
    };

    logger.info('FileCollector 配置已保存（组件将在 start() 中初始化）', {
      数据目录: this.config.openclawDataDir,
      数据库路径: this.config.dbPath,
    });
  }

  // ==================== 私有：组件初始化（在 start() 中调用） ====================

  /**
   * 初始化所有内部组件并绑定事件。
   * 与构造函数分离，确保副作用仅在明确调用 start() 时发生。
   */
  private initComponents(): void {
    // 初始化存储层
    this.sqliteManager = new SQLiteManager();

    // 初始化处理管道组件
    const validator = new DataValidator();
    this.deduplicator = new Deduplicator({ cacheSize: this.config.deduplicationCacheSize });
    const batchWriter = new BatchWriter(this.sqliteManager, {
      batchSize: this.config.writerBatchSize,
      flushInterval: this.config.writerFlushInterval,
    });

    // 初始化数据管道（传入配置的 agent ID 集合）
    this.pipeline = new CollectionPipeline(
      this.sqliteManager, validator, this.deduplicator, batchWriter,
      { batchSize: this.config.batchSize, configuredAgentIds: this.configuredAgentIds }
    );

    // 转发 Pipeline 事件到外部
    this.pipeline.on('message', (msg) => this.emit('message', msg));
    this.pipeline.on('invalid', (ev) => this.emit('invalid', ev));
    this.pipeline.on('duplicate', (ev) => this.emit('duplicate', ev));
    this.pipeline.on('batch:flush', (ev) => this.emit('batch:flush', ev));
    this.pipeline.on('error', (err) => this.emit('error', err));

    // 初始化文件监听器
    this.fileWatcher = new FileWatcher();
    this.fileWatcher.on('error', (err) => this.emit('error', err));

    logger.info('FileCollector 组件初始化完成 (Facade模式)', {
      数据目录: this.config.openclawDataDir,
      数据库路径: this.config.dbPath,
      文件监听: this.config.enableWatch,
      增量读取: this.config.enableIncremental,
    });
  }

  // ==================== 生命周期方法 ====================

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('FileCollector 已经在运行中');
      return;
    }

    logger.info('启动 FileCollector...');
    this.isRunning = true;

    // 延迟初始化：组件创建和事件绑定在此统一进行
    this.initComponents();

    if (!fs.existsSync(this.config.openclawDataDir)) {
      throw new Error(`OpenClaw 数据目录不存在: ${this.config.openclawDataDir}`);
    }

    // 初始化数据库
    await this.sqliteManager.init({
      dbPath: this.config.dbPath,
      walMode: true,
      foreignKeys: true,
    });

    // 同步 agents 配置到 SQLite 并缓存配置的 agent_id 列表（在管道启动前完成，确保过滤生效）
    await this.syncAgentsFromConfig();

    // 预热去重缓存：从数据库加载已存在的 message_id，避免重启后重复消息走完整 pipeline
    await this.preloadDeduplicator();

    // 启动数据处理管道（传入配置的 agent ID 集合）
    this.pipeline.start();

    // 初始化 Session 缓存
    this.sessionCache = new SessionCache(this.sqliteManager, {
      maxSize: 10000,
      ttl: 5 * 60 * 1000, // 5分钟
      enabled: true
    });

    // 初始扫描所有文件
    await this.scanAllFiles();

    // 同步 sessions.json 元数据到 sessions 表
    await this.syncSessionMetadata();

    // 启动文件监听或定时扫描
    if (this.config.enableWatch) {
      await this.startWatcher();
    } else {
      this.startPeriodicScan();
    }

    logger.info('FileCollector 启动完成', { ...this.stats });
  }

  async waitForWatcherReady(timeoutMs: number = 10000): Promise<void> {
    await this.fileWatcher.waitForReady(timeoutMs);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('FileCollector 未运行');
      return;
    }

    logger.info('停止 FileCollector...');
    this.isRunning = false;

    // 停止文件监听
    await this.fileWatcher.stop();

    // 停止定时扫描
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      logger.debug('定时扫描已停止');
    }

    // 停止管道
    await this.pipeline.stop();

    // 停止 Session 缓存
    if (this.sessionCache) {
      this.sessionCache.stop();
      this.sessionCache = null;
    }

    // 关闭数据库
    await this.sqliteManager.close();

    logger.info('FileCollector 已停止', { ...this.stats });
  }

  getName(): string {
    return 'FileCollector';
  }

  /**
   * 启动每日归档调度器（每天凌晨 3 点，保留 30 天数据）
   */
  startArchiveScheduler(daysToKeep: number = 30): void {
    this.sqliteManager.startArchiveScheduler(daysToKeep, (count) => {
      logger.info(`[FileCollector] 归档任务完成，共归档 ${count} 条消息`);
    });
    logger.info('[FileCollector] 数据归档调度器已启动');
  }

  // ==================== 文件验证 ====================

  /**
   * 获取文件 stats，失败时返回 null。
   * 统一在此处做一次 stat 系统调用，供后续验证和进度记录复用。
   */
  private getFileStats(filePath: string): fs.Stats | null {
    try {
      return fs.statSync(filePath);
    } catch (error) {
      logger.error(`文件状态读取失败: ${filePath}`, error as Error);
      return null;
    }
  }

  /**
   * 验证文件是否符合处理条件。
   * 接受已预取的 fs.Stats，避免重复系统调用。
   *
   * @param filePath - 文件路径（仅用于日志）
   * @param stats    - 已获取的 fs.Stats 对象
   * @returns true 表示可以处理，false 表示需要跳过
   */
  private validateFile(filePath: string, stats: fs.Stats): boolean {
    if (stats.size > this.config.maxFileSize) {
      logger.warn(`文件大小超出限制，跳过: ${filePath}`, {
        文件大小: `${(stats.size / 1024 / 1024).toFixed(2)}MB`,
        限制: `${(this.config.maxFileSize / 1024 / 1024).toFixed(2)}MB`,
      });
      this.stats.skippedFiles++;
      return false;
    }
    return true;
  }

  private validateLine(line: string, lineNumber: number, filePath: string): boolean {
    const lineLength = Buffer.byteLength(line, 'utf-8');
    if (lineLength > this.config.maxLineLength) {
      logger.warn(`行长度超出限制，跳过`, {
        文件: filePath,
        行号: lineNumber,
        行长度: `${(lineLength / 1024).toFixed(2)}KB`,
      });
      return false;
    }
    return true;
  }

  // ==================== 异常恢复机制 ====================

  private async handleFileError(
    filePath: string,
    error: Error,
    operation: () => Promise<void>
  ): Promise<void> {
    // ENOENT（文件不存在）类错误不重试，立即失败
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error(`[FileCollector] File not found, no retry: ${filePath}`);
      return;
    }

    const existingError = this.fileErrors.get(filePath);
    const retryCount = existingError ? existingError.retryCount + 1 : 1;

    logger.warn(`文件处理失败，准备重试`, {
      文件: filePath,
      重试次数: `${retryCount}/${this.config.maxRetries}`,
      错误: error.message,
    });

    this.fileErrors.set(filePath, {
      filePath,
      error,
      retryCount,
      lastRetryAt: Date.now(),
    });

    if (retryCount >= this.config.maxRetries) {
      logger.error(`文件处理失败，已达最大重试次数`, { 文件: filePath, 重试次数: retryCount });
      this.emit('error', new Error(`文件处理失败（已重试 ${retryCount} 次）: ${filePath}`));
      this.fileErrors.delete(filePath);
      return;
    }

    const delay = this.config.retryDelay * Math.pow(2, retryCount - 1);
    await sleep(delay);

    try {
      this.stats.retriedEvents++;
      await operation();
      this.fileErrors.delete(filePath);
      logger.info(`文件处理重试成功: ${filePath}`, { 重试次数: retryCount });
    } catch (retryError) {
      await this.handleFileError(filePath, retryError as Error, operation);
    }
  }

  // ==================== 文件扫描与监听 ====================

  private async scanAllFiles(): Promise<void> {
    logger.debug('开始扫描所有 Session 文件...');

    const sessionsPattern = path.join(
      this.config.openclawDataDir, 'agents', '*', 'sessions', '*.jsonl'
    );

    const files = await findJsonlFiles(sessionsPattern);
    logger.info(`发现 ${files.length} 个 Session 文件`);

    this.stats.totalFiles = files.length;

    for (const filePath of files) {
      try {
        const fileStats = this.getFileStats(filePath);
        if (!fileStats || !this.validateFile(filePath, fileStats)) continue;
        await this.processFile(filePath, true, fileStats);
        this.stats.processedFiles++;
      } catch (error) {
        logger.error(`文件处理失败: ${filePath}`, error as Error);
        await this.handleFileError(filePath, error as Error, async () => {
          // 重试时重新获取 stats（文件状态可能已变化）
          const retryStats = this.getFileStats(filePath);
          if (retryStats) {
            await this.processFile(filePath, true, retryStats);
            this.stats.processedFiles++;
          }
        });
      }
    }
  }

  private async startWatcher(): Promise<void> {
    const watchPattern = path.join(
      this.config.openclawDataDir, 'agents', '*', 'sessions', '*.jsonl'
    );

    await this.fileWatcher.start(watchPattern, {
      watchPreset: this.config.watchPreset,
      ignoreInitial: true,
    }, {
      onAdd: async (filePath) => {
        try {
          const fileStats = this.getFileStats(filePath);
          if (!fileStats || !this.validateFile(filePath, fileStats)) return;
          await this.processFile(filePath, false, fileStats);
          this.stats.totalFiles++;
          this.stats.processedFiles++;
        } catch (error) {
          logger.error(`处理新文件失败: ${filePath}`, error as Error);
          await this.handleFileError(filePath, error as Error, async () => {
            const retryStats = this.getFileStats(filePath);
            if (retryStats) {
              await this.processFile(filePath, false, retryStats);
              this.stats.totalFiles++;
              this.stats.processedFiles++;
            }
          });
        }
      },
      onChange: async (filePath) => {
        try {
          const fileStats = this.getFileStats(filePath);
          if (!fileStats || !this.validateFile(filePath, fileStats)) return;
          await this.processFile(filePath, false, fileStats);
        } catch (error) {
          logger.error(`处理文件修改失败: ${filePath}`, error as Error);
          await this.handleFileError(filePath, error as Error, async () => {
            const retryStats = this.getFileStats(filePath);
            if (retryStats) await this.processFile(filePath, false, retryStats);
          });
        }
      },
      onUnlink: (filePath) => {
        logger.info(`文件删除: ${filePath}`);
        this.fileProgress.delete(filePath);
        this.fileErrors.delete(filePath);
        this.stats.totalFiles--;
      },
      onError: (error) => {
        logger.error('文件监听器错误', error);
        this.emit('error', error);
      },
      onReady: () => {
        logger.info('✅ 文件监听器就绪');
        this.emit('watcher:ready');
      },
    });
  }

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

  // ==================== 核心文件处理 ====================

  /**
   * 处理单个文件：增量读取 → 验证 → 管道处理 → 更新进度
   *
   * @param fileStats - 调用方预先获取的 fs.Stats，直接复用，避免重复系统调用
   */
  private async processFile(filePath: string, _isInitialScan: boolean, fileStats: fs.Stats): Promise<void> {
    logger.debug(`处理文件: ${filePath}`);

    const sessionKey = buildSessionKeyFromPath(filePath);

    // 检查 agent 是否在 openclaw.json 配置中，跳过幽灵 agent 的文件
    const agentId = extractAgentId(sessionKey);
    if (!this.isAgentConfigured(agentId)) {
      logger.debug(`Agent [${agentId}] 不在 openclaw.json 配置中，跳过文件: ${filePath}`);
      this.stats.skippedFiles++;
      return;
    }

    const progress = this.fileProgress.get(filePath);
    const startLine = progress ? progress.lastLine : 0;

    // 增量读取文件
    let events: OpenClawEvent[] = [];
    let endLine = 0;

    if (this.config.enableIncremental) {
      const result = await readJsonlFileIncremental(filePath, startLine, { highWaterMark: 64 * 1024 });
      events = result.events;
      endLine = result.endLine;
    } else {
      const result = await readJsonlFileIncremental(filePath, 0, { highWaterMark: 64 * 1024 });
      events = result.events;
      endLine = result.endLine;
    }

    logger.debug(`读取到 ${events.length} 个事件，起始行: ${startLine}，结束行: ${endLine}`);

    // 确保 session 存在（使用缓存避免重复查询）
    if (this.sessionCache) {
      const exists = await this.sessionCache.ensureSession(sessionKey);
      if (!exists) {
        // 如果缓存中不存在，通过 pipeline 创建
        await this.pipeline.ensureSession(sessionKey);
        // 更新缓存
        // 注意：这里假设 ensureSession 会创建 Session
        // 实际应该根据 ensureSession 的返回值更新缓存
      }
    } else {
      // 缓存未启用，直接调用
      await this.pipeline.ensureSession(sessionKey);
    }

    // 行长度验证过滤
    const validEvents: OpenClawEvent[] = [];
    for (let i = 0; i < events.length; i++) {
      const eventStr = JSON.stringify(events[i]);
      if (this.validateLine(eventStr, startLine + i + 1, filePath)) {
        validEvents.push(events[i]);
      }
    }

    // 更新进度（复用调用方传入的 fileStats，无需再次 stat）
    this.fileProgress.set(filePath, {
      filePath,
      lastLine: endLine,
      lastModified: fileStats.mtimeMs,
    });

    // 通过管道批量处理
    if (validEvents.length > 0) {
      await this.pipeline.processEvents(validEvents, sessionKey);
    }

    // 同步统计
    const pipelineStats = this.pipeline.getStats();
    this.stats.totalEvents = pipelineStats.totalEvents;
    this.stats.successEvents = pipelineStats.successEvents;
    this.stats.failedEvents = pipelineStats.failedEvents;

    // 发送状态事件
    this.emit('status', {
      total: this.stats.totalEvents,
      processed: this.stats.successEvents,
      failed: this.stats.failedEvents,
      skipped: this.stats.skippedFiles,
      retried: this.stats.retriedEvents,
    });
  }

  /**
   * 同步 sessions.json 元数据到 sessions 表
   *
   * 遍历所有 agents/*\/sessions/sessions.json，通过 UUID 桥接，
   * 将 label/status/model/spawnedBy/spawnDepth 写入 sessions 表。
   */
  private async syncSessionMetadata(): Promise<void> {
    const pattern = path.join(this.config.openclawDataDir, 'agents', '*', 'sessions', 'sessions.json');
    const files = await findJsonlFiles(pattern);

    let updated = 0;
    for (const filePath of files) {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // 从路径提取 agentId: .../agents/{agentId}/sessions/sessions.json
        const match = filePath.match(/agents\/([^/]+)\/sessions\/sessions\.json$/);
        if (!match) continue;
        const agentId = match[1];

        for (const entry of Object.values(data) as Array<Record<string, unknown>>) {
          const sessionId = entry.sessionId as string | undefined;
          if (!sessionId) continue;

          // 通过 UUID 构造 Collector 的 session_key
          const sessionKey = `agent:${agentId}:local:default:direct:${sessionId}`;

          const changes = await this.sqliteManager.updateSessionMetadata(sessionKey, {
            label: (entry.label as string) || null,
            status: (entry.status as string) || null,
            model: (entry.model as string) || null,
            modelProvider: (entry.modelProvider as string) || null,
            spawnedBy: (entry.spawnedBy as string) || null,
            spawnDepth: (entry.spawnDepth as number) ?? null,
          });
          if (changes > 0) updated++;
        }
      } catch (error) {
        // sessions.json 可能不存在或解析失败，跳过
        logger.debug(`sessions.json 读取失败，跳过: ${filePath}`, error as Error);
      }
    }

    if (updated > 0) {
      logger.info(`[FileCollector] sessions.json 元数据同步完成: ${updated} 条 session 已更新`);
    }
  }

  // ==================== 辅助方法 ====================

  getStats(): CollectorStats {
    const pipelineStats = this.pipeline.getStats();
    return {
      ...this.stats,
      totalEvents: pipelineStats.totalEvents,
      successEvents: pipelineStats.successEvents,
      failedEvents: pipelineStats.failedEvents,
    };
  }

  async getSessions(params: { limit?: number; offset?: number; since?: string }) {
    return this.sqliteManager.getSessions(params);
  }

  async getMessages(params: { sessionKey?: string; limit?: number; offset?: number; since?: string }) {
    return this.sqliteManager.getMessages(params);
  }

  async getDataStats() {
    return this.sqliteManager.getDataStats();
  }

  async getEvents(params?: { sessionKey?: string; eventType?: string; since?: string; limit?: number; offset?: number }) {
    return this.sqliteManager.getEvents(params);
  }

  /**
   * 检查 agent_id 是否在 openclaw.json 配置中
   */
  isAgentConfigured(agentId: string): boolean {
    return this.configuredAgentIds.has(agentId);
  }

  /**
   * Sync agents from openclaw.json config into SQLite
   * 并缓存配置的 agent_id 列表到 configuredAgentIds Set
   */
  async syncAgentsFromConfig(): Promise<void> {
    const configPath = path.join(this.config.openclawDataDir, 'openclaw.json');

    try {
      if (!fs.existsSync(configPath)) {
        logger.warn(`openclaw.json not found at ${configPath}`);
        return;
      }

      let config: { agents?: { list?: Array<{ id: string; name?: string; workspace?: string }> } };
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[FileCollector] Failed to parse ${configPath}: ${msg}`);
        return;
      }
      const agentsList = config.agents?.list ?? [];

      logger.info(`Syncing ${agentsList.length} agents from openclaw.json`);

      // 清空并重建配置的 agent_id 集合
      this.configuredAgentIds.clear();

      for (const agent of agentsList) {
        this.configuredAgentIds.add(agent.id);

        await this.sqliteManager.upsertAgent({
          agent_id: agent.id,
          agent_name: agent.name || agent.id,
          workspace: agent.workspace || null,
          config_json: JSON.stringify(agent),
          status: 'configured',
          last_seen_at: new Date().toISOString(),
        });
      }

      // 保存降级用的内存列表
      this.fallbackAgentIds = agentsList.map(a => a.id);

      logger.info(`Synced ${agentsList.length} agents, configuredAgentIds: ${this.configuredAgentIds.size} agents`);
    } catch (error) {
      logger.error('Failed to sync agents from config, using fallback memory list', error as Error);
      // 降级：使用内存中的 agent 列表（如果之前有同步过）
      this.configuredAgentIds = new Set(this.fallbackAgentIds);
      logger.warn(`Fallback to ${this.fallbackAgentIds.length} agents from memory`);
    }
  }

  /**
   * 预热去重缓存：从数据库加载已存在的 message_id
   *
   * 避免 Collector 重启后，LRU Cache 清空，导致数据库中已存在的 message_id
   * 重复走 转换→验证→去重 检查，浪费 CPU
   *
   * 只加载到缓存容量上限（config.deduplicationCacheSize），超出部分由 LRU 自然淘汰
   */
  private async preloadDeduplicator(): Promise<void> {
    try {
      const messageIds = await this.sqliteManager.getAllMessageIds();
      if (messageIds.length === 0) {
        logger.debug('[FileCollector] 去重缓存预热: 数据库中无 message_id，跳过');
        return;
      }
      this.deduplicator.preloadFromDatabase(messageIds);
      logger.info(`[FileCollector] 去重缓存预热完成: ${messageIds.length} 条 message_id 已加载`);
    } catch (error) {
      logger.error('[FileCollector] 去重缓存预热失败，将从空缓存开始', error);
    }
  }

  /**
   * Get all agents from SQLite
   */
  async getAgents(): Promise<{
    agents: Array<{
      agent_id: string;
      agent_name: string;
      workspace: string | null;
      config_json: string;
      status: string;
      last_seen_at: string;
      created_at: string;
      updated_at: string;
    }>;
  }> {
    return this.sqliteManager.getAgents();
  }

  getFileProgress(): Map<string, FileProgress> {
    return new Map(this.fileProgress);
  }

  resetStats(): void {
    this.stats = {
      totalFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      totalEvents: 0,
      successEvents: 0,
      failedEvents: 0,
      retriedEvents: 0,
    };
    this.fileProgress.clear();
    this.fileErrors.clear();
    this.pipeline.resetStats();
    logger.info('统计信息已重置');
  }
}

// ==================== 独立工具函数 ====================

/**
 * 查找 .jsonl 文件（使用 chokidar 做 glob 匹配）
 */
async function findJsonlFiles(pattern: string): Promise<string[]> {
  const { default: chokidar } = await import('chokidar');

  return new Promise((resolve, reject) => {
    const files: string[] = [];
    const tempWatcher = chokidar.watch(pattern, {
      persistent: false,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    tempWatcher.on('add', (filePath: string) => files.push(filePath));
    tempWatcher.on('ready', () => { tempWatcher.close(); resolve(files); });
    tempWatcher.on('error', (error: Error) => { tempWatcher.close(); reject(error); });
  });
}

/**
 * 延迟工具函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
