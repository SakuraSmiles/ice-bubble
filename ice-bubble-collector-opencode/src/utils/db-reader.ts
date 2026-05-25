/**
 * OpenCode SQLite 只读读取工具
 * 
 * 提供对 opencode.db 的只读连接和常用查询方法。
 * WAL 模式 + readonly 连接，不阻塞 OpenCode 主进程写入。
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { Logger } from './logger.js';
import type { SessionWithProject, MessageWithParts } from '../types/opencode.js';

const dbReaderLogger = new Logger('DbReader');

export interface DbReaderConfig {
    /** OpenCode DB 路径 */
    dbPath: string;
    /** busy timeout（ms），默认 5000 */
    busyTimeout?: number;
}

export class DbReader {
    private db: Database.Database | null = null;
    private dbPath: string;

    constructor(config: DbReaderConfig) {
        this.dbPath = config.dbPath;
    }

    /**
     * 打开数据库连接（只读 + WAL）
     * 如果 DB 文件不存在，返回 false 并 log warning
     */
    open(): boolean {
        if (!fs.existsSync(this.dbPath)) {
            dbReaderLogger.warn(`OpenCode 数据库不存在: ${this.dbPath}`);
            dbReaderLogger.warn('采集器将以空数据模式运行，等待数据库出现');
            return false;
        }

        try {
            this.db = new Database(this.dbPath, {
                readonly: true,
                timeout: 5000,
            });

            // 确认 WAL 模式
            const journalMode = this.db.pragma('journal_mode', { simple: true });
            dbReaderLogger.info(`数据库已打开 (只读), journal_mode=${journalMode}`);

            // 设置 busy_timeout
            this.db.pragma('busy_timeout = 5000');

            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            dbReaderLogger.error(`打开数据库失败: ${msg}`, err);
            return false;
        }
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
            dbReaderLogger.info('数据库连接已关闭');
        }
    }

    /**
     * 获取所有 session（含 project 信息）
     */
    getAllSessions(): SessionWithProject[] {
        this.ensureOpen();
        return this.db!.prepare(`
            SELECT s.*, p.name as project_name, p.worktree as project_worktree
            FROM session s
            LEFT JOIN project p ON p.id = s.project_id
            ORDER BY s.time_updated DESC
        `).all() as SessionWithProject[];
    }

    /**
     * 增量获取 session（time_updated > cursor）
     */
    getUpdatedSessions(cursor: number): SessionWithProject[] {
        this.ensureOpen();
        return this.db!.prepare(`
            SELECT s.*, p.name as project_name, p.worktree as project_worktree
            FROM session s
            LEFT JOIN project p ON p.id = s.project_id
            WHERE s.time_updated > ?
            ORDER BY s.time_updated ASC
        `).all(cursor) as SessionWithProject[];
    }

    /**
     * 增量获取 messages（time_updated > cursor）
     * 返回 message + 关联的 parts
     */
    getIncrementalMessages(cursor: number, limit: number = 500): MessageWithParts[] {
        this.ensureOpen();

        // 查增量 messages
        const messages = this.db!.prepare(`
            SELECT id, session_id, time_created, time_updated, data
            FROM message
            WHERE time_updated > ?
            ORDER BY time_updated ASC
            LIMIT ?
        `).all(cursor, limit) as Array<{
            id: string;
            session_id: string;
            time_created: number;
            time_updated: number;
            data: string;
        }>;

        if (messages.length === 0) return [];

        // 批量获取 parts
        const messageIds = messages.map(m => m.id);
        const placeholders = messageIds.map(() => '?').join(',');
        const parts = this.db!.prepare(`
            SELECT id, message_id, session_id, time_created, time_updated, data
            FROM part
            WHERE message_id IN (${placeholders})
            ORDER BY message_id, time_created ASC
        `).all(...messageIds) as Array<{
            id: string;
            message_id: string;
            session_id: string;
            time_created: number;
            time_updated: number;
            data: string;
        }>;

        // 按 message_id 分组 parts
        const partsByMessage = new Map<string, typeof parts>();
        for (const part of parts) {
            const list = partsByMessage.get(part.message_id) || [];
            list.push(part);
            partsByMessage.set(part.message_id, list);
        }

        return messages.map(msg => ({
            message: msg as MessageWithParts['message'],
            parts: (partsByMessage.get(msg.id) || []) as MessageWithParts['parts'],
        }));
    }

    /**
     * 获取某个 session 的所有 messages + parts
     */
    getSessionMessages(sessionId: string): MessageWithParts[] {
        this.ensureOpen();

        const messages = this.db!.prepare(`
            SELECT id, session_id, time_created, time_updated, data
            FROM message
            WHERE session_id = ?
            ORDER BY time_created ASC
        `).all(sessionId) as Array<MessageWithParts['message']>;

        if (messages.length === 0) return [];

        const messageIds = messages.map(m => m.id);
        const placeholders = messageIds.map(() => '?').join(',');
        const parts = this.db!.prepare(`
            SELECT id, message_id, session_id, time_created, time_updated, data
            FROM part
            WHERE message_id IN (${placeholders})
            ORDER BY message_id, time_created ASC
        `).all(...messageIds) as Array<MessageWithParts['parts'][number]>;

        const partsByMessage = new Map<string, typeof parts>();
        for (const part of parts) {
            const list = partsByMessage.get(part.message_id) || [];
            list.push(part);
            partsByMessage.set(part.message_id, list);
        }

        return messages.map(msg => ({
            message: msg,
            parts: partsByMessage.get(msg.id) || [],
        }));
    }

    /**
     * 获取最大 time_updated（用于初始化游标）
     */
    getMaxTimeUpdated(): number {
        this.ensureOpen();
        const row = this.db!.prepare('SELECT MAX(time_updated) as max_time FROM message').get() as {
            max_time: number | null;
        };
        return row?.max_time || 0;
    }

    getMaxSessionUpdated(): number {
        this.ensureOpen();
        const row = this.db!.prepare('SELECT MAX(time_updated) as max_time FROM session').get() as {
            max_time: number | null;
        };
        return row?.max_time || 0;
    }

    /**
     * 获取 distinct agents（从 session 表，兼容旧逻辑）
     */
    getDistinctAgents(): Array<{ agent: string | null; count: number }> {
        this.ensureOpen();
        return this.db!.prepare(`
            SELECT agent, COUNT(*) as count
            FROM session
            GROUP BY agent
            ORDER BY count DESC
        `).all() as Array<{ agent: string | null; count: number }>;
    }

    /**
     * 从 message.data JSON 中提取所有 agent 列表
     */
    getAgentsFromMessages(): Array<{ agent: string; count: number }> {
        this.ensureOpen();
        const rows = this.db!.prepare(`
            SELECT data FROM message
        `).all() as Array<{ data: string }>;

        const agentCounts: Record<string, number> = {};
        for (const row of rows) {
            try {
                const d = JSON.parse(row.data);
                const agent = d.agent;
                if (agent && agent !== 'compaction') {
                    agentCounts[agent] = (agentCounts[agent] || 0) + 1;
                }
            } catch {}
        }

        return Object.entries(agentCounts)
            .map(([agent, count]) => ({ agent, count }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * 获取 session 的主 agent（排除 compaction，消息最多的 agent）
     */
    getPrimaryAgentForSession(sessionId: string): string | null {
        this.ensureOpen();
        const rows = this.db!.prepare(`
            SELECT data FROM message
            WHERE session_id = ?
        `).all(sessionId) as Array<{ data: string }>;

        const agentCounts: Record<string, number> = {};
        for (const row of rows) {
            try {
                const d = JSON.parse(row.data);
                const agent = d.agent;
                if (agent && agent !== 'compaction') {
                    agentCounts[agent] = (agentCounts[agent] || 0) + 1;
                }
            } catch {}
        }

        if (Object.keys(agentCounts).length === 0) return null;
        return Object.entries(agentCounts).sort((a, b) => b[1] - a[1])[0][0];
    }

    /**
     * 获取 session 的主 model（排除 compaction，消息最多的 model）
     */
    getPrimaryModelForSession(sessionId: string): string | null {
        this.ensureOpen();
        const rows = this.db!.prepare(`
            SELECT data FROM message
            WHERE session_id = ?
        `).all(sessionId) as Array<{ data: string }>;

        const modelCounts: Record<string, number> = {};
        for (const row of rows) {
            try {
                const d = JSON.parse(row.data);
                const model = d.modelID;
                if (model) {
                    modelCounts[model] = (modelCounts[model] || 0) + 1;
                }
            } catch {}
        }

        if (Object.keys(modelCounts).length === 0) return null;
        return Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0][0];
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        sessionCount: number;
        messageCount: number;
        partCount: number;
        activeSessionCount: number;
    } {
        this.ensureOpen();
        const sessionCount = (this.db!.prepare('SELECT COUNT(*) as c FROM session').get() as { c: number }).c;
        const messageCount = (this.db!.prepare('SELECT COUNT(*) as c FROM message').get() as { c: number }).c;
        const partCount = (this.db!.prepare('SELECT COUNT(*) as c FROM part').get() as { c: number }).c;
        const activeSessionCount = (this.db!.prepare('SELECT COUNT(*) as c FROM session WHERE time_archived IS NULL').get() as { c: number }).c;

        return { sessionCount, messageCount, partCount, activeSessionCount };
    }

    /**
     * 数据库是否已打开
     */
    get isOpen(): boolean {
        return this.db !== null;
    }

    /**
     * 获取指定 session 的消息统计
     */
    getSessionMessageStats(sessionId: string): { count: number; firstAt: number | null; lastAt: number | null } {
        this.ensureOpen();
        const row = this.db!.prepare(`
            SELECT COUNT(*) as cnt, MIN(time_created) as first_at, MAX(time_created) as last_at
            FROM message
            WHERE session_id = ?
        `).get(sessionId) as any;

        return {
            count: row.cnt || 0,
            firstAt: row.first_at || null,
            lastAt: row.last_at || null,
        };
    }

    /**
     * 获取 DB 路径
     */
    getDbPath(): string {
        return this.dbPath;
    }

    /**
     * 确保数据库已打开
     */
    private ensureOpen(): void {
        if (!this.db) {
            throw new Error('数据库未打开，请先调用 open()');
        }
    }
}
