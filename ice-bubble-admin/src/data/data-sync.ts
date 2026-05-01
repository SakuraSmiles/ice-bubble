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
    /** 轮询间隔（毫秒） */
    pollInterval: number;
    /** 批量大小 */
    batchSize: number;

}

const DEFAULT_CONFIG: DataSyncConfig = {
    collectorBaseUrl: 'http://localhost:13100',
    moduleKey: 'unknown',
    pollInterval: 60000,
    batchSize: 500,

};

export class DataSync {
    private config: DataSyncConfig;
    private client: CollectorClient;
    private repository: DataRepository;
    private timer: ReturnType<typeof setInterval> | null = null;
    private isRunning: boolean = false;


    constructor(config: Partial<DataSyncConfig>, repository: DataRepository) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.client = new CollectorClient({ baseUrl: this.config.collectorBaseUrl });
        this.repository = repository;


    }

    // ========== 生命周期 ==========

    /**
     * 启动同步调度器
     */
    start(): void {
        if (this.isRunning) return;

        this.isRunning = true;

        // 立即执行一次同步
        this.syncAll().catch(err => {
            logger.error('[DataSync] Initial sync failed', { error: err });
        });

        // 启动定时调度
        this.timer = setInterval(() => {
            this.syncAll().catch(err => {
                logger.error('[DataSync] Scheduled sync failed', { error: err });
            });
        }, this.config.pollInterval);

        logger.info(`[DataSync] Started (collector: ${this.config.collectorBaseUrl}, poll: ${this.config.pollInterval}ms)`);
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
        logger.info('[DataSync] Stopped');
    }

    /**
     * 手动触发一次完整同步
     */
    async syncAll(): Promise<void> {
        logger.info('[DataSync] Starting sync...');
        const start = Date.now();

        try {
            await Promise.all([
                this.syncSessions(this.config.moduleKey),
                this.syncAgents(this.config.moduleKey),
                this.syncMessages(this.config.moduleKey),
                this.syncModelEvents(),
            ]);

            logger.info(`[DataSync] Sync completed in ${Date.now() - start}ms`);
        } catch (error) {
            logger.error('[DataSync] Sync failed', { error });
        }
    }

    // ========== 同步方法 ==========

    /**
     * 同步 sessions
     *
     * 从 collector API 获取 sessions 列表，添加溯源字段后存入 admin 数据库
     */
    private async syncSessions(sourceModule: string): Promise<void> {
        try {
            // 获取上次同步时间，用于增量查询
            const lastSync = this.repository.getSyncProgress('admin_sessions');
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            let offset = 0;
            const limit = this.config.batchSize;

            while (true) {
                const data = await this.client.getSessions({ limit, offset, since });

                if (data.sessions.length === 0) break;

                // 添加溯源字段
                const processed = data.sessions.map(row => processSession(row, sourceModule));

                // 批量保存
                this.repository.saveSessions(processed);
                totalSynced += processed.length;

                // 更新同步进度
                this.repository.updateSyncProgress('admin_sessions');

                // 如果返回数量少于请求数量，说明已经获取完毕
                if (data.sessions.length < limit) break;

                offset += limit;
            }

            if (totalSynced > 0) {
                logger.info(`[DataSync] Synced ${totalSynced} sessions`);
            }
        } catch (error) {
            logger.error('[DataSync] Failed to sync sessions', { error });
        }
    }

    /**
     * 同步 agents
     *
     * 从 Collector API 获取 openclaw.json 中的 agent 配置，与 sessions 聚合数据合并
     */
    private async syncAgents(sourceModule: string): Promise<void> {
        try {
            const collectorAgents = await this.client.getAgents();
            this.repository.refreshAgents(collectorAgents, sourceModule);
            this.repository.updateSyncProgress('admin_agents');
            logger.info(`[DataSync] Agents refreshed (${collectorAgents.length} from collector, source=${sourceModule})`);
        } catch (error) {
            logger.error('[DataSync] Failed to sync agents', { error });
        }
    }

    /**
     * 同步 messages
     *
     * 从 collector API 获取 messages 列表，添加溯源字段后存入 admin 数据库
     */
    private async syncMessages(sourceModule: string): Promise<void> {
        try {
            const lastSync = this.repository.getSyncProgress('admin_messages');
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            let offset = 0;
            const limit = this.config.batchSize;

            // 全量聚合所有批次的活动计数
            const allActivityMap = new Map<string, number>();
            const allRawMessages: CollectorMessage[] = [];
            // 收集所有批次的 session keys（用于一次性查询 session-agent 映射）
            const allSessionKeys = new Set<string>();

            while (true) {
                const data = await this.client.getMessages({ limit, offset, since });

                if (data.messages.length === 0) break;

                const processed = data.messages.map(row => processMessage(row, sourceModule));
                this.repository.saveMessages(processed);
                totalSynced += processed.length;

                this.repository.updateSyncProgress('admin_messages');

                allRawMessages.push(...data.messages);

                // 收集 session keys 供后续一次性查询
                for (const msg of data.messages) {
                    allSessionKeys.add(msg.session_key);
                }

                if (data.messages.length < limit) break;
                offset += limit;
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
                logger.info(`[DataSync] Synced ${totalSynced} messages, activity records: ${allActivityMap.size}`);
            }

            // 增量统计计算：仅对本次同步涉及的 sessions / agents 更新
            // 避免每次全表扫描（computeSessionStats / computeAgentStats 已废弃全量模式）
            if (allSessionKeys.size > 0) {
                const sessionUpdated = this.repository.computeSessionStatsIncremental(Array.from(allSessionKeys));
                const affectedAgents = new Set<string>();
                const sessionAgentMap = this.repository.getSessionAgentIds(Array.from(allSessionKeys));
                for (const agentId of sessionAgentMap.values()) {
                    affectedAgents.add(agentId);
                }
                const agentUpdated = this.repository.computeAgentStatsIncremental(Array.from(affectedAgents));
                logger.info(`[DataSync] Incremental stats: ${sessionUpdated} sessions, ${agentUpdated} agents`);
            }


        } catch (error) {
            logger.error('[DataSync] Failed to sync messages', { error });
        }
    }

    /**
     * 同步 model events（session_events）
     *
     * 从 collector API 获取 session events（model_change 等），同步到 admin_model_events 表
     */
    private async syncModelEvents(): Promise<void> {
        try {
            const lastSync = this.repository.getSyncProgress('admin_model_events');
            const since = lastSync?.last_sync_time ?? undefined;

            let totalSynced = 0;
            let offset = 0;
            const limit = this.config.batchSize;

            while (true) {
                const data = await this.client.getEvents({ limit, offset, since });

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

                this.repository.updateSyncProgress('admin_model_events');

                if (data.events.length < limit) break;
                offset += limit;
            }

            if (totalSynced > 0) {
                logger.info(`[DataSync] Synced ${totalSynced} model events`);
            }
        } catch (error) {
            logger.error('[DataSync] Failed to sync model events', { error });
        }
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
