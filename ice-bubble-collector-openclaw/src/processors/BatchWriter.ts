/**
 * 批量写入器
 *
 * 职责：
 * - 异步批量写入数据库，提升性能
 * - 缓冲消息，达到批量大小或超时时自动刷新
 * - 提供统计信息和错误处理
 *
 * 性能目标：
 * - 批量写入速度 > 10,000 msg/s
 * - 缓冲区大小可配置
 * - 定时刷新间隔可配置
 */

import { EventEmitter } from 'events';
import type { SessionMessage } from '../types';
import { SQLiteManager } from '../storage/sqlite-manager';

/**
 * BatchWriter 配置
 */
export interface BatchWriterConfig {
    /**
     * 批量大小
     * @default 100
     */
    batchSize?: number;

    /**
     * 刷新间隔（毫秒）
     * @default 5000
     */
    flushInterval?: number;
}

/**
 * BatchWriter 统计信息
 */
export interface BatchWriterStats {
    /** 当前缓冲区大小 */
    buffered: number;

    /** 总处理消息数 */
    totalProcessed: number;

    /** 总批量数 */
    totalBatches: number;

    /** 最后刷新时间 */
    lastFlushAt: Date | null;
}

/**
 * 批量写入器事件
 */
export interface BatchWriterEvents {
    /** 刷新完成事件 */
    flush: { count: number };

    /** 错误事件 */
    error: Error;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<BatchWriterConfig> = {
    batchSize: 100,
    flushInterval: 5000,
};

/**
 * 批量写入器
 *
 * 核心功能：
 * - 消息缓冲：将消息添加到缓冲区
 * - 自动刷新：缓冲区满或超时时自动刷新
 * - 手动刷新：支持手动触发刷新
 * - 错误恢复：写入失败时恢复缓冲区
 *
 * @example
 * const batchWriter = new BatchWriter(sqliteManager, {
 *   batchSize: 100,
 *   flushInterval: 5000
 * });
 *
 * batchWriter.on('flush', ({ count }) => {
 *   console.log(`Flushed ${count} messages`);
 * });
 *
 * batchWriter.on('error', (error) => {
 *   console.error('Write error:', error);
 * });
 *
 * batchWriter.start();
 * batchWriter.addMessage(message);
 * await batchWriter.stop();
 */
export class BatchWriter extends EventEmitter {
    /** 消息缓冲区 */
    private buffer: SessionMessage[] = [];

    /** 定时刷新器 */
    private flushTimer: NodeJS.Timeout | null = null;

    /** 统计信息 */
    private stats: BatchWriterStats = {
        buffered: 0,
        totalProcessed: 0,
        totalBatches: 0,
        lastFlushAt: null,
    };

    /** 配置 */
    private config: Required<BatchWriterConfig>;

    /** 运行状态 */
    private isRunning: boolean = false;

    /**
     * 构造函数
     * @param sqliteManager SQLite 管理器
     * @param config 配置选项
     */
    constructor(
        private sqliteManager: SQLiteManager,
        config?: BatchWriterConfig
    ) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========== 核心方法 ==========

    /**
     * 添加消息到缓冲区
     *
     * 工作流程：
     * 1. 将消息添加到缓冲区
     * 2. 如果缓冲区大小 >= batchSize，立即刷新
     * 3. 否则，重置定时器（延迟刷新）
     *
     * @param message 消息对象
     */
    addMessage(message: SessionMessage): void {
        this.buffer.push(message);
        this.stats.buffered = this.buffer.length;

        // 缓冲区满，立即刷新
        if (this.buffer.length >= this.config.batchSize) {
            this.flush().catch((error) => {
                this.emit('error', error);
            });
        } else if (this.isRunning) {
            // 重置定时器
            this.resetFlushTimer();
        }
    }

    /**
     * 批量添加消息
     *
     * 工作流程：
     * 1. 批量添加消息到缓冲区
     * 2. 如果缓冲区大小 >= batchSize，立即刷新
     * 3. 否则，重置定时器
     *
     * @param messages 消息数组
     */
    addMessages(messages: SessionMessage[]): void {
        this.buffer.push(...messages);
        this.stats.buffered = this.buffer.length;

        // 缓冲区满，立即刷新
        if (this.buffer.length >= this.config.batchSize) {
            this.flush().catch((error) => {
                this.emit('error', error);
            });
        } else if (this.isRunning) {
            // 重置定时器
            this.resetFlushTimer();
        }
    }

    /**
     * 手动刷新缓冲区
     *
     * 工作流程：
     * 1. 检查缓冲区是否为空
     * 2. 如果不为空，调用 sqliteManager.batchInsertMessages(buffer)
     * 3. 清空缓冲区
     * 4. 更新统计信息
     * 5. 发送 'flush' 事件
     *
     * 错误处理：
     * - 写入失败时恢复缓冲区
     * - 发送 'error' 事件
     * - 抛出错误
     */
    async flush(): Promise<void> {
        if (this.buffer.length === 0) {
            return;
        }

        // 保存当前缓冲区
        const messages = [...this.buffer];
        this.buffer = [];
        this.stats.buffered = 0;

        try {
            // 批量写入
            await this.sqliteManager.batchInsertMessages(messages);

            // 更新统计
            this.stats.totalProcessed += messages.length;
            this.stats.totalBatches++;
            this.stats.lastFlushAt = new Date();

            // 发送事件
            this.emit('flush', { count: messages.length });
        } catch (error) {
            // 恢复缓冲区
            this.buffer = [...messages, ...this.buffer];
            this.stats.buffered = this.buffer.length;

            // 发送错误事件
            this.emit('error', error);

            throw error;
        }
    }

    // ========== 生命周期方法 ==========

    /**
     * 启动定时刷新
     *
     * 工作流程：
     * 1. 设置运行状态
     * 2. 启动定时刷新器
     */
    start(): void {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;
        this.startFlushTimer();
    }

    /**
     * 停止定时刷新
     *
     * 工作流程：
     * 1. 停止定时刷新器
     * 2. 最后一次刷新缓冲区
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        this.stopFlushTimer();

        // 最后一次刷新
        await this.flush();
    }

    // ========== 统计方法 ==========

    /**
     * 获取统计信息
     */
    getStats(): BatchWriterStats {
        return { ...this.stats };
    }

    // ========== 私有方法 ==========

    /**
     * 启动定时刷新器
     */
    private startFlushTimer(): void {
        this.stopFlushTimer();
        this.flushTimer = setTimeout(() => {
            this.flush().catch((error) => {
                this.emit('error', error);
            });
        }, this.config.flushInterval);
    }

    /**
     * 停止定时刷新器
     */
    private stopFlushTimer(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * 重置定时刷新器
     *
     * 工作原理：
     * - 停止当前定时器
     * - 启动新的定时器
     * - 实现延迟刷新（每次添加消息时重置）
     */
    private resetFlushTimer(): void {
        this.stopFlushTimer();
        this.startFlushTimer();
    }
}
