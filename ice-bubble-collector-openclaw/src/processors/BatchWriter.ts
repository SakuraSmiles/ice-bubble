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
import type { SessionMessage, SessionEvent } from '../types';
import { SQLiteManager } from '../storage/sqlite-manager';
import { Logger } from '../utils/logger.js';

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

    /** 失败重试队列大小 */
    failedBuffered: number;

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
const logger = new Logger('BatchWriter');
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

    /** 事件缓冲区（非 message 类型的原始行） */
    private eventBuffer: SessionEvent[] = [];

    /**
     * 失败重试队列
     *
     * 当 flush 写入失败时，失败的消息会移入此队列，而非重新混入 buffer。
     * 下次 flush 时优先消费此队列，保证消息时序且避免并发时重复写入。
     */
    private failedMessages: SessionMessage[] = [];

    /** 最大失败重试队列大小，防止 SQLite 持续失败时内存溢出 */
    private static readonly MAX_RETRY_QUEUE = 1000;

    /** 定时刷新器 */
    private flushTimer: NodeJS.Timeout | null = null;

    /** 统计信息 */
    private stats: BatchWriterStats = {
        buffered: 0,
        failedBuffered: 0,
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
     * 添加非 message 事件到缓冲区
     */
    addEvent(event: SessionEvent): void {
        this.eventBuffer.push(event);

        // 事件缓冲区满，立即刷新
        if (this.eventBuffer.length >= this.config.batchSize) {
            this.flush().catch((error) => {
                this.emit('error', error);
            });
        } else if (this.isRunning) {
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
        if (this.buffer.length === 0 && this.failedMessages.length === 0 && this.eventBuffer.length === 0) {
            return;
        }

        // 优先消费失败重试队列（放在本批次最前面，保证时序）
        const messages = [...this.failedMessages, ...this.buffer];
        const events = [...this.eventBuffer];
        this.failedMessages = [];
        this.buffer = [];
        this.eventBuffer = [];
        this.stats.buffered = 0;

        // 写入事件表
        if (events.length > 0) {
            try {
                await this.sqliteManager.batchInsertEvents(events);
                this.stats.totalBatches++;
            } catch (eventError) {
                // 事件写入失败不影响消息写入
                logger.error('[BatchWriter] Event batch write failed', eventError as Error);
            }
        }

        try {
            // 批量写入
            const result = await this.sqliteManager.batchInsertMessages(messages);

            // 更新统计（使用实际插入数，排除重复）
            this.stats.totalProcessed += result.inserted;
            this.stats.totalBatches++;
            this.stats.lastFlushAt = new Date();

            // 发送事件
            this.emit('flush', { count: result.inserted, duplicates: result.duplicates });
        } catch (error) {
            // 失败消息移入专用队列，不与后续新消息混合，保持顺序
            // 超限则精确丢弃最旧消息
            const totalFailed = messages.length;
            if (this.failedMessages.length + totalFailed > BatchWriter.MAX_RETRY_QUEUE) {
                const overflow = (this.failedMessages.length + totalFailed) - BatchWriter.MAX_RETRY_QUEUE;
                logger.error(`[BatchWriter] Retry queue overflow, dropping ${overflow} oldest failed messages (queue cap: ${BatchWriter.MAX_RETRY_QUEUE})`);
                this.failedMessages.splice(0, overflow);
            }
            this.failedMessages.push(...messages);
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
        return {
            ...this.stats,
            buffered: this.buffer.length,
            failedBuffered: this.failedMessages.length,
        };
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
