/**
 * SQLite 采集器
 * 
 * 从 OpenCode SQLite 数据库定时轮询采集数据。
 * 基于 time_updated 增量同步，30s 轮询间隔。
 * DB 不存在时优雅处理（log warning，不崩溃）。
 */

import { Logger } from '../utils/logger.js';
import { DbReader } from '../utils/db-reader.js';
import type { OpenCodeCollectorConfig } from '../utils/config-loader.js';

const collectorLogger = new Logger('SQLiteCollector');

export interface CollectorStats {
    sessionCount: number;
    messageCount: number;
    partCount: number;
    activeSessionCount: number;
    lastPollAt: string | null;
    lastSyncCursor: number;
    totalPolled: number;
    totalMessagesCollected: number;
}

export class SQLiteCollector {
    private config: OpenCodeCollectorConfig;
    private dbReader: DbReader;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private lastSyncCursor: number = 0;
    private totalPolled: number = 0;
    private totalMessagesCollected: number = 0;
    private lastPollAt: string | null = null;
    private running: boolean = false;

    constructor(config: OpenCodeCollectorConfig) {
        this.config = config;
        this.dbReader = new DbReader({
            dbPath: config.opencodeDbPath,
            busyTimeout: 5000,
        });
    }

    /**
     * 启动采集器
     */
    async start(): Promise<void> {
        collectorLogger.info('启动 SQLite 采集器...');
        collectorLogger.info(`  OpenCode DB: ${this.config.opencodeDbPath}`);
        collectorLogger.info(`  轮询间隔: ${this.config.pollIntervalMs}ms`);
        collectorLogger.info(`  批次大小: ${this.config.batchSize}`);

        // 尝试打开数据库
        this.openConnection();

        // 首次轮询
        await this.poll();

        // 启动定时轮询
        this.running = true;
        this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
        collectorLogger.info('SQLite 采集器已启动');
    }

    /**
     * 停止采集器
     */
    async stop(): Promise<void> {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.dbReader.close();
        collectorLogger.info('SQLite 采集器已停止');
    }

    /**
     * 执行一次轮询
     */
    private async poll(): Promise<void> {
        try {
            // 如果 DB 未打开，尝试重新打开
            if (!this.dbReader.isOpen) {
                this.openConnection();
                if (!this.dbReader.isOpen) {
                    // DB 仍然不存在，跳过本次轮询
                    return;
                }
            }

            // 增量查询
            const messages = this.dbReader.getIncrementalMessages(
                this.lastSyncCursor,
                this.config.batchSize,
            );

            this.totalPolled++;
            this.lastPollAt = new Date().toISOString();

            if (messages.length > 0) {
                this.totalMessagesCollected += messages.length;

                // 更新游标为本次查询中最大的 time_updated
                const maxTimeUpdated = Math.max(
                    ...messages.map(m => m.message.time_updated),
                );
                this.lastSyncCursor = maxTimeUpdated;

                collectorLogger.info(
                    `轮询 #${this.totalPolled}: 采集 ${messages.length} 条消息 (cursor: ${this.lastSyncCursor})`,
                );
            } else {
                collectorLogger.debug(
                    `轮询 #${this.totalPolled}: 无新数据 (cursor: ${this.lastSyncCursor})`,
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            collectorLogger.error(`轮询异常: ${msg}`, err);
            // 轮询异常不中断，下一轮继续
        }
    }

    /**
     * 打开数据库连接（带重试）
     */
    private openConnection(): void {
        const success = this.dbReader.open();
        if (success) {
            // 初始化游标：使用当前最大 time_updated
            this.lastSyncCursor = this.dbReader.getMaxTimeUpdated();
            const stats = this.dbReader.getStats();
            collectorLogger.info(
                `已连接: ${stats.sessionCount} sessions, ${stats.messageCount} messages, ${stats.partCount} parts`,
            );
        }
    }

    /**
     * 获取采集器状态
     */
    getStats(): CollectorStats {
        let stats: CollectorStats = {
            sessionCount: 0,
            messageCount: 0,
            partCount: 0,
            activeSessionCount: 0,
            lastPollAt: this.lastPollAt,
            lastSyncCursor: this.lastSyncCursor,
            totalPolled: this.totalPolled,
            totalMessagesCollected: this.totalMessagesCollected,
        };

        if (this.dbReader.isOpen) {
            const dbStats = this.dbReader.getStats();
            stats = { ...stats, ...dbStats };
        }

        return stats;
    }

    /**
     * 获取所有 session
     */
    getSessions() {
        if (!this.dbReader.isOpen) return [];
        return this.dbReader.getAllSessions();
    }

    /**
     * 获取某个 session 的消息
     */
    getSessionMessages(sessionId: string) {
        if (!this.dbReader.isOpen) return [];
        return this.dbReader.getSessionMessages(sessionId);
    }

    /**
     * 获取增量消息（供 API 使用）
     */
    getMessages(since: number) {
        if (!this.dbReader.isOpen) return [];
        return this.dbReader.getIncrementalMessages(since, this.config.batchSize);
    }

    /**
     * 获取 message 表中最大的 time_updated（毫秒时间戳）
     */
    getMaxTimeUpdated(): number {
        if (!this.dbReader.isOpen) return 0;
        return this.dbReader.getMaxTimeUpdated();
    }

    /**
     * 获取 session 表中最大的 updated_at（毫秒时间戳）
     */
    getMaxSessionUpdated(): number {
        if (!this.dbReader.isOpen) return 0;
        return this.dbReader.getMaxSessionUpdated();
    }

    /**
     * 获取 distinct agents
     */
    getAgents() {
        if (!this.dbReader.isOpen) return [];
        return this.dbReader.getDistinctAgents();
    }

    /**
     * 采集器是否正在运行
     */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * 获取 DbReader 实例（供内部模块使用）
     */
    getDbReader(): DbReader {
        return this.dbReader;
    }
}
