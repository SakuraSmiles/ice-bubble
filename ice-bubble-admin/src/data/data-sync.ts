/**
 * ice-bubble Admin - 数据同步调度器
 *
 * 通过 HTTP API 从 collector 增量同步 sessions、messages 数据
 *
 * 架构：collector SQLite → collector HTTP API → CollectorClient → admin SQLite → admin REST API
 */

import { logger } from '../utils/index.js';
import { CollectorClient, type CollectorMessage } from './collector-client.js';
import { DataRepository } from '../storage/data-repository.js';
import { processSession, processMessage } from './processor.js';


export interface DataSyncConfig {
    /** collector HTTP API 基础地址 */
    collectorBaseUrl: string;
    /** 模块标识（用于 source 字段） */
    moduleKey: string;
    /** 平台标识（用于 platform 字段区分数据来源） */
    platform: string;
    /** 轮询间隔（毫秒） */
    pollInterval: number;
    /** 批量大小 */
    batchSize: number;
}

const DEFAULT_CONFIG: DataSyncConfig = {
    collectorBaseUrl: 'http://localhost:13100',
    moduleKey: 'unknown',
    platform: 'openclaw',
    pollInterval: 10000,
    batchSize: 500,
};

export class DataSync {
    private config: DataSyncConfig;
    private client: CollectorClient;
    private repository: DataRepository;
    private timer: ReturnType<typeof setInterval> | null = null;
    private isRunning: boolean = false;
    /** 同步进度 key 前缀，避免多实例共享同一个 sync_progress 记录 */
    private readonly syncKeyPrefix: string;
    /** 同步互斥锁，防止多次 syncAll 并发执行导致游标竞态 */
    private isSyncing: boolean = false;
    /** 上次游标漂移告警记录，避免日志刷屏 */
    private cursorAnomalies: Map<string, string> = new Map();


    constructor(config: Partial<DataSyncConfig>, repository: DataRepository) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.client = new CollectorClient({ baseUrl: this.config.collectorBaseUrl });
        this.repository = repository;
        this.syncKeyPrefix = `${this.config.moduleKey}:`;
    }

    // ========== 生命周期 ==========

    /**
     * 启动同步调度器
     *
     * 首次同步延迟 1 秒执行，避免阻塞 API 启动。
     * 统计计算异步执行，不阻塞 API 响应。
     */
    start(): void {
        if (this.isRunning) return;

        this.isRunning = true;

        // 延迟 1 秒执行首次同步，避免阻塞启动流程
        setTimeout(() => {
            this.syncAll().catch(err => {
                logger.error('[DataSync] Initial sync failed', { error: err });
            });
        }, 1000);

        // 启动定时调度
        this.timer = setInterval(() => {
            this.syncAll().catch(err => {
                logger.error('[DataSync] Scheduled sync failed', { error: err });
            });
        }, this.config.pollInterval);

        logger.info(`[DataSync:${this.config.moduleKey}] Started (collector: ${this.config.collectorBaseUrl}, platform: ${this.config.platform}, poll: ${this.config.pollInterval}ms)`);
    }

    /**
     * 停止同步调度器
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isRunning = false;
        logger.info(`[DataSync:${this.config.moduleKey}] Stopped`);
    }

    /**
     * 手动触发一次完整同步
     *
     * 使用 isSyncing 互斥锁防止并发同步导致游标竞态。
     * 如果上一次同步仍在进行，本次调用被跳过（不会排队）。
     */
    async syncAll(): Promise<void> {
        // 互斥锁：防止并发 syncAll 导致游标竞态
        if (this.isSyncing) {
            logger.warn(`[DataSync:${this.config.moduleKey}] Sync skipped: previous sync still in progress`);
            return;
        }
        this.isSyncing = true;

        logger.info(`[DataSync:${this.config.moduleKey}] Starting sync...`);
        const start = Date.now();

        try {
            await Promise.all([
                this.syncSessions(),
                this.syncAgents(),
                this.syncMessages(),
                this.syncModelEvents(),
            ]);

            logger.info(`[DataSync:${this.config.moduleKey}] Sync completed in ${Date.now() - start}ms`);
        } catch (error) {
            logger.error(`[DataSync:${this.config.moduleKey}] Sync failed`, { error });
        } finally {
            this.isSyncing = false;
        }
    }

    // ========== 同步方法 ==========

    /**
     * 同步 sessions
     *
     * 从 collector API 获取 sessions 列表，添加溯源字段后存入 admin 数据库
     */
    private async syncSessions(): Promise<void> {
        try {
            this.validateSyncCursor('admin_sessions');
            const lastSync = this.repository.getSyncProgress(`${this.syncKeyPrefix}admin_sessions`);
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            let offset = 0;
            const limit = this.config.batchSize;

            while (true) { // eslint-disable-line no-constant-condition
                const data = await this.client.getSessions({ limit, offset, since });

                if (data.sessions.length === 0) break;

                // 添加溯源字段
                const processed = data.sessions.map(row => processSession(row, this.config.moduleKey, this.config.platform));

                // 批量保存
                this.repository.saveSessions(processed);
                totalSynced += processed.length;

                // 使用实际数据时间戳更新游标
                const maxTs = data.max_time_updated;
                this.repository.updateSyncProgress(
                    `${this.syncKeyPrefix}admin_sessions`,
                    maxTs != null ? String(maxTs) : undefined,
                );

                // 如果返回数量少于请求数量，说明已经获取完毕
                if (data.sessions.length < limit) break;

                offset += limit;
            }

            if (totalSynced > 0) {
                logger.info(`[DataSync:${this.config.moduleKey}] Synced ${totalSynced} sessions`);
            }
        } catch (error) {
            logger.error(`[DataSync:${this.config.moduleKey}] Failed to sync sessions`, { error });
        }
    }

    /**
     * 同步 agents
     *
     * 从 Collector API 获取 openclaw.json 中的 agent 配置，与 sessions 聚合数据合并
     */
    private async syncAgents(): Promise<void> {
        try {
            this.validateSyncCursor('admin_agents');
            const collectorAgents = await this.client.getAgents();
            this.repository.refreshAgents(collectorAgents, this.config.moduleKey, this.config.platform);
            this.repository.updateSyncProgress(`${this.syncKeyPrefix}admin_agents`);
            logger.info(`[DataSync:${this.config.moduleKey}] Agents refreshed (${collectorAgents.length} from collector, source=${this.config.moduleKey})`);
        } catch (error) {
            logger.error(`[DataSync:${this.config.moduleKey}] Failed to sync agents`, { error });
        }
    }

    /**
     * 同步 messages
     *
     * 从 collector API 获取 messages 列表，添加溯源字段后存入 admin 数据库。
     *
     * 游标策略（解决 timestamp 乱序导致的 11% 数据缺口）：
     * - 优先使用 ID 游标（last_sync_id），Collector 返回 max_id 时走 ID 路径
     * - 降级使用时间戳游标（last_sync_time），用于 OpenCode 等不支持 ID 游标的 Collector
     * - 首次同步时循环拉取直到 messages.length < batchSize，防止数据丢失
     */
    private async syncMessages(): Promise<void> {
        try {
            // Fix 1: 游标合理性校验（防御游标漂移）
            this.validateSyncCursor('admin_messages');

            const lastSync = this.repository.getSyncProgress(`${this.syncKeyPrefix}admin_messages`);
            const afterId = lastSync?.last_sync_id ?? undefined;
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            const limit = this.config.batchSize;

            // 全量聚合所有批次的活动计数
            const allActivityMap = new Map<string, number>();
            const allRawMessages: CollectorMessage[] = [];
            // 收集所有批次的 session keys（用于一次性查询 session-agent 映射）
            const allSessionKeys = new Set<string>();

            // 游标循环变量
            let currentAfterId: number | undefined = afterId;
            let hasMore = true;

            while (hasMore) {
                const data = await this.client.getMessages({
                    limit,
                    after_id: currentAfterId,
                    since: currentAfterId ? undefined : since, // ID 模式下不需要 since
                });

                if (data.messages.length === 0) break;

                const processed = data.messages.map(row => processMessage(row, this.config.moduleKey, this.config.platform));
                const newlyInserted = this.repository.saveMessages(processed);
                totalSynced += newlyInserted;

                allRawMessages.push(...data.messages);

                // 收集 session keys 供后续一次性查询
                for (const msg of data.messages) {
                    allSessionKeys.add(msg.session_key);
                }

                // 游标推进逻辑
                if (data.max_id != null) {
                    // ID 游标模式（OpenClaw Collector）：更新 last_sync_id 和 last_sync_time
                    currentAfterId = data.max_id;
                    this.repository.updateSyncProgress(
                        `${this.syncKeyPrefix}admin_messages`,
                        undefined,
                        data.max_id,
                    );
                } else if (data.max_time_updated != null) {
                    // 时间戳游标模式（OpenCode 降级）：仅更新 last_sync_time
                    this.repository.updateSyncProgress(
                        `${this.syncKeyPrefix}admin_messages`,
                        String(data.max_time_updated),
                    );
                }

                // 判断是否还有更多数据
                hasMore = data.messages.length >= limit;
            }

            // 批次循环结束后，一次性查询 session→agent 映射，再聚合活动计数
            if (allSessionKeys.size > 0) {
                const sessionAgentMap = this.repository.getSessionAgentIds(Array.from(allSessionKeys));
                for (const msg of allRawMessages) {
                    const date = msg.timestamp.split('T')[0]; // YYYY-MM-DD
                    const agentId = sessionAgentMap.get(msg.session_key) ?? 'unknown';
                    const key = `${agentId}:${date}`;
                    allActivityMap.set(key, (allActivityMap.get(key) || 0) + 1);
                }
            }

            // 一次性写入聚合结果
            if (allActivityMap.size > 0) {
                const records = Array.from(allActivityMap.entries()).map(([key, count]) => {
                    const [agentId, date] = key.split(':');
                    return { agentId, date, count };
                });
                this.repository.upsertAgentActivityBatch(records);
            }

            if (totalSynced > 0) {
                logger.info(`[DataSync:${this.config.moduleKey}] Synced ${totalSynced} messages, activity records: ${allActivityMap.size}`);
            }

            // 增量统计计算：异步执行，避免阻塞 API（首次同步可能涉及大量 sessions）
            // 使用 setImmediate 分片执行，让事件循环有机会处理 API 请求
            if (allSessionKeys.size > 0) {
                const sessionKeys = Array.from(allSessionKeys);
                const sessionAgentMap = this.repository.getSessionAgentIds(sessionKeys);
                const affectedAgents = new Set<string>();
                for (const agentId of sessionAgentMap.values()) {
                    affectedAgents.add(agentId);
                }
                // 异步执行统计计算，不阻塞当前同步流程
                setImmediate(() => {
                    try {
                        const sessionUpdated = this.repository.computeSessionStatsIncremental(sessionKeys);
                        const agentUpdated = this.repository.computeAgentStatsIncremental(Array.from(affectedAgents));
                        logger.info(`[DataSync] Async stats: ${sessionUpdated} sessions, ${agentUpdated} agents`);
                    } catch (err) {
                        logger.error('[DataSync] Async stats computation failed', { error: err });
                    }
                });
            }

        } catch (error) {
            logger.error(`[DataSync:${this.config.moduleKey}] Failed to sync messages`, { error });
        }
    }

    /**
     * 同步 model events（session_events）
     *
     * 从 collector API 获取 session events（model_change 等），同步到 admin_model_events 表
     */
    private async syncModelEvents(): Promise<void> {
        try {
            // Fix 2: 游标合理性校验
            this.validateSyncCursor('admin_model_events');

            const lastSync = this.repository.getSyncProgress(`${this.syncKeyPrefix}admin_model_events`);
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            let hasMore = true;
            const limit = this.config.batchSize;

            // 收集本批次最大时间戳，用于游标推进
            let maxTimestamp: string | null = null;

            while (hasMore) {
                const data = await this.client.getEvents({ limit, offset: 0, since });

                if (data.events.length === 0) break;

                const processed = data.events.map(evt => ({
                    session_key: evt.session_key,
                    event_type: evt.event_type,
                    event_id: evt.event_id,
                    data_json: evt.data_json,
                    timestamp: evt.timestamp,
                }));

                this.repository.saveModelEvents(processed);
                totalSynced += processed.length;

                // Fix 2: 推进游标 — 使用实际数据中的最大时间戳
                for (const evt of data.events) {
                    if (!maxTimestamp || evt.timestamp > maxTimestamp) {
                        maxTimestamp = evt.timestamp;
                    }
                }
                if (maxTimestamp) {
                    this.repository.updateSyncProgress(
                        `${this.syncKeyPrefix}admin_model_events`,
                        maxTimestamp,
                    );
                }

                // 判断是否还有更多数据
                hasMore = data.events.length >= limit;
            }

            if (totalSynced > 0) {
                logger.info(`[DataSync:${this.config.moduleKey}] Synced ${totalSynced} model events`);
            }
        } catch (error) {
            logger.error(`[DataSync:${this.config.moduleKey}] Failed to sync model events`, { error });
        }
    }

    // ========== 游标校验（Fix 1） ==========

    /**
     * 校验同步游标合理性，检测游标漂移并自动重置
     *
     * 防御场景：
     * 1. Collector 数据被删除后，Admin 游标指向不存在的 ID（空表检测）
     * 2. Admin 同步中断后游标未更新但数据已写入（游标落后检测）
     * 3. 游标时间戳在未来（时钟漂移）
     * 4. 游标长期无更新（停滞检测）
     *
     * 检测逻辑：
     * - 如果 last_sync_id > 表中实际最大 id + 10000 → 重置为 0
     * - 如果 last_sync_time > Date.now() + 1h → 重置为 null
     * - 如果表为空但游标非零 → 重置（数据被删除场景）
     * - 如果游标超过 24h 未更新且表非空 → 标记停滞（不自动重置）
     */
    private validateSyncCursor(tableName: string): void {
        const key = `${this.syncKeyPrefix}${tableName}`;
        const lastSync = this.repository.getSyncProgress(key);
        if (!lastSync) return;

        let needsReset = false;
        let isStale = false;
        const reasons: string[] = [];

        // 1. ID 游标校验：last_sync_id 不应远大于表中实际最大 id
        if (lastSync.last_sync_id > 0) {
            const maxId = this.repository.getMaxId(tableName);
            if (maxId !== null && lastSync.last_sync_id > maxId + 10000) {
                needsReset = true;
                reasons.push(`last_sync_id (${lastSync.last_sync_id}) >> max_id (${maxId})`);
            } else if (maxId === null) {
                // 表为空但游标非零 → 数据被删除或从未成功写入
                needsReset = true;
                reasons.push(`table is empty but last_sync_id=${lastSync.last_sync_id}`);
            }
        }

        // 2. 时间戳游标校验：last_sync_time 不应是未来时间
        if (lastSync.last_sync_time) {
            const syncTime = new Date(lastSync.last_sync_time).getTime();
            if (!isNaN(syncTime) && syncTime > Date.now() + 3600_000) {
                needsReset = true;
                reasons.push(`last_sync_time (${lastSync.last_sync_time}) is >1h in the future`);
            }

            // 3. 游标停滞检测：超过 24h 未更新
            if (lastSync.updated_at) {
                const updatedAt = new Date(lastSync.updated_at).getTime();
                const hoursSinceUpdate = (Date.now() - updatedAt) / 3600_000;
                if (!isNaN(updatedAt) && hoursSinceUpdate > 24) {
                    isStale = true;
                    reasons.push(`cursor not updated for ${hoursSinceUpdate.toFixed(1)}h`);
                }
            }
        }

        // 记录异常状态（供 /api/sync/progress 读取）
        const anomalyReason = reasons.length > 0 ? reasons.join('; ') : null;
        this.cursorAnomalies.set(key, anomalyReason ?? 'ok');

        if (needsReset) {
            logger.warn(
                `[DataSync:${this.config.moduleKey}] Cursor drift detected for ${tableName}: ${reasons.join('; ')}. Resetting cursor.`,
            );
            this.repository.resetSyncProgress(key);
            this.cursorAnomalies.set(key, `reset: ${reasons.join('; ')}`);
        }

        if (isStale && !needsReset) {
            logger.warn(
                `[DataSync:${this.config.moduleKey}] Cursor stale for ${tableName}: ${reasons.join('; ')}. (not auto-resetting)`,
            );
        }
    }

    // ========== 游标异常状态查询（供 API 使用） ==========

    /**
     * 获取当前游标异常状态
     */
    getCursorAnomalies(): Map<string, string | null> {
        return new Map(this.cursorAnomalies);
    }

    /**
     * 获取同步锁状态
     */
    isSyncInProgress(): boolean {
        return this.isSyncing;
    }

    /**
     * 获取模块标识
     */
    getModuleKey(): string {
        return this.config.moduleKey;
    }

    // ========== Collector 连接测试 ==========

    /**
     * 测试与 collector 的连接
     */
    async ping(): Promise<boolean> {
        try {
            await this.client.getStats();
            return true;
        } catch {
            return false;
        }
    }
}
