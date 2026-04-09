/**
 * FileWatcher - 文件监听器
 *
 * 职责：
 * - 封装 chokidar 文件监听生命周期
 * - 支持本地/网络/自定义三种预设配置
 * - 提供文件事件回调接口
 *
 * @module FileWatcher
 */

import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';

const logger = new Logger('FileWatcher');

// ==================== 预设配置 ====================

/** 本地文件系统监听配置 */
const LOCAL_WATCH_OPTIONS: chokidar.WatchOptions = {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 100,
  },
  usePolling: false,
  atomic: true,
};

/** 网络共享文件系统监听配置 */
const NETWORK_WATCH_OPTIONS: chokidar.WatchOptions = {
  persistent: true,
  ignoreInitial: false,
  usePolling: true,
  interval: 1000,
  binaryInterval: 1000,
  awaitWriteFinish: {
    stabilityThreshold: 3000,
    pollInterval: 500,
  },
};

// ==================== 配置接口 ====================

export interface FileWatcherConfig {
  /** 监听环境预设 */
  watchPreset?: 'local' | 'network' | 'custom';
  /** 自定义 chokidar 配置（watchPreset=custom 时使用） */
  watchOptions?: chokidar.WatchOptions;
  /** 是否忽略初始扫描 */
  ignoreInitial?: boolean;
}

// ==================== 回调接口 ====================

export interface FileWatcherCallbacks {
  /** 新增文件回调 */
  onAdd?: (filePath: string) => void;
  /** 文件修改回调 */
  onChange?: (filePath: string) => void;
  /** 文件删除回调 */
  onUnlink?: (filePath: string) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
  /** 监听器就绪回调 */
  onReady?: () => void;
}

// ==================== FileWatcher 类 ====================

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;

  /**
   * 启动文件监听器
   *
   * @param pattern - 监听的 glob 模式
   * @param config - 监听配置
   * @param callbacks - 事件回调
   */
  async start(
    pattern: string,
    config: FileWatcherConfig,
    callbacks: FileWatcherCallbacks
  ): Promise<void> {
    if (this.watcher) {
      logger.warn('FileWatcher 已经在运行中');
      return;
    }

    // 根据预设选择配置
    let watchOptions: chokidar.WatchOptions;

    switch (config.watchPreset ?? 'local') {
      case 'local':
        watchOptions = { ...LOCAL_WATCH_OPTIONS, ...config.watchOptions };
        break;
      case 'network':
        watchOptions = { ...NETWORK_WATCH_OPTIONS, ...config.watchOptions };
        break;
      case 'custom':
        watchOptions = config.watchOptions ?? {};
        break;
      default:
        watchOptions = LOCAL_WATCH_OPTIONS;
    }

    // 覆盖必要配置
    watchOptions.ignoreInitial = config.ignoreInitial ?? true;

    logger.debug('启动文件监听', {
      模式: pattern,
      预设: config.watchPreset,
      usePolling: watchOptions.usePolling,
      ignoreInitial: watchOptions.ignoreInitial,
    });

    this.watcher = chokidar.watch(pattern, watchOptions);

    // 绑定事件回调
    this.watcher.on('add', (filePath) => {
      logger.info(`新文件: ${filePath}`);
      callbacks.onAdd?.(filePath);
    });

    this.watcher.on('change', (filePath) => {
      logger.debug(`文件修改: ${filePath}`);
      callbacks.onChange?.(filePath);
    });

    this.watcher.on('unlink', (filePath) => {
      logger.info(`文件删除: ${filePath}`);
      callbacks.onUnlink?.(filePath);
    });

    this.watcher.on('error', (error) => {
      logger.error('文件监听器错误', error);
      callbacks.onError?.(error);
      this.emit('error', error);
    });

    this.watcher.on('ready', () => {
      logger.info('✅ 文件监听器已就绪，开始实时监控文件变化');
      callbacks.onReady?.();
      this.emit('ready');
    });

    logger.info(`⏳ 文件监听器正在初始化...`, { 预设: config.watchPreset });
  }

  /**
   * 等待监听器就绪
   *
   * @param timeoutMs - 超时时间（毫秒），默认 10 秒
   */
  async waitForReady(timeoutMs: number = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`文件监听器就绪超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * 停止文件监听器
   */
  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.watcher = null;
    logger.debug('文件监听器已关闭');
  }

  /**
   * 获取运行状态
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }
}
