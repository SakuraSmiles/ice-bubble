/**
 * SQLite 管理器
 *
 * 主存储：持久化存储所有采集的数据
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Session, SessionMessage, SQLiteManagerConfig } from '../types';

/**
 * SQLite 错误类
 */
export class SQLiteError extends Error {
    constructor(
        message: string,
        public code: string,
        public detail?: unknown
    ) {
        super(message);
        this.name = 'SQLiteError';
    }
}

/**
 * SQLite 管理器
 *
 * 职责：
 * - 数据库初始化和生命周期管理
 * - Session 和 Message 的 CRUD 操作
 * - 批量写入优化
 * - 数据清理和维护
 */
export class SQLiteManager {
    private db: DatabaseType | null = null;
    private dbPath: string = '';
    private isInitialized: boolean = false;

    // ========== 生命周期 ==========

    /**
     * 初始化数据库
     * - 创建数据库文件
     * - 创建表结构
     * - 启用 WAL 模式
     * - 创建索引
     */
    async init(config: SQLiteManagerConfig): Promise<void> {
        try {
            this.dbPath = config.dbPath;

            // 创建数据库连接
            this.db = new Database(config.dbPath);

            // 启用 WAL 模式（默认开启）
            if (config.walMode !== false) {
                this.db.pragma('journal_mode = WAL');
            }

            // 启用外键约束（默认开启）
            if (config.foreignKeys !== false) {
                this.db.pragma('foreign_keys = ON');
            }

            // 性能优化配置
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = -64000'); // 64MB
            this.db.pragma('temp_store = MEMORY');
            this.db.pragma('mmap_size = 268435456'); // 256MB

            // 创建表结构
            this.createTables();

            this.isInitialized = true;
            console.log('[SQLiteManager] Initialized successfully');
        } catch (error) {
            throw new SQLiteError(
                'Failed to initialize SQLite database',
                'SQLITE_INIT_FAILED',
                error
            );
        }
    }

    /**
     * 创建数据库表结构
     */
    private createTables(): void {
        if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

        // 1. sessions 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_key TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                channel TEXT NOT NULL,
                account_id TEXT,
                peer_id TEXT,
                guild_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                message_count INTEGER DEFAULT 0,
                last_message_at TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);
        `);

        // 2. session_messages 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                message_type TEXT NOT NULL,
                content TEXT,
                model TEXT,
                tokens_input INTEGER,
                tokens_output INTEGER,
                tools_json TEXT,
                timestamp TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_key ON session_messages(session_key);
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON session_messages(timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_type ON session_messages(message_type);
        `);

        // 3. agents 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                agent_name TEXT,
                config_json TEXT,
                status TEXT,
                last_seen_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
            CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
        `);

        // 4. tools 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tools (
                tool_name TEXT PRIMARY KEY,
                description TEXT,
                call_count INTEGER DEFAULT 0,
                avg_duration_ms INTEGER,
                last_called_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_tools_call_count ON tools(call_count);
        `);

        // 5. collection_logs 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS collection_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collector_type TEXT NOT NULL,
                event_type TEXT,
                session_key TEXT,
                status TEXT NOT NULL,
                error_message TEXT,
                duration_ms INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_logs_collector ON collection_logs(collector_type);
            CREATE INDEX IF NOT EXISTS idx_logs_status ON collection_logs(status);
            CREATE INDEX IF NOT EXISTS idx_logs_created_at ON collection_logs(created_at);
        `);

        // 6. schema_version 表（用于数据迁移）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    /**
     * 关闭数据库连接
     */
    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.isInitialized = false;
            console.log('[SQLiteManager] Closed successfully');
        }
    }

    // ========== Session 操作 ==========

    /**
     * 插入或更新会话（upsert）
     * - 存在则更新 updated_at 和 message_count
     * - 不存在则插入新记录
     */
    async upsertSession(session: Session): Promise<void> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const stmt = this.db.prepare(`
                INSERT INTO sessions (
                    session_key, agent_id, channel, account_id, peer_id, guild_id,
                    created_at, updated_at, message_count, last_message_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_key) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    message_count = excluded.message_count,
                    last_message_at = excluded.last_message_at
            `);

            stmt.run(
                session.sessionKey,
                session.agentId,
                session.channel,
                session.accountId || null,
                session.peerId || null,
                session.guildId || null,
                session.createdAt.toISOString(),
                session.updatedAt.toISOString(),
                session.messageCount,
                session.lastMessageAt?.toISOString() || null
            );
        } catch (error) {
            throw new SQLiteError(
                'Failed to upsert session',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 获取单个会话
     */
    async getSession(sessionKey: string): Promise<Session | null> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const stmt = this.db.prepare(`
                SELECT * FROM sessions WHERE session_key = ?
            `);

            const row = stmt.get(sessionKey) as any;

            if (!row) return null;

            return this.rowToSession(row);
        } catch (error) {
            throw new SQLiteError(
                'Failed to get session',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 获取会话列表（分页）
     */
    async getSessionList(options?: {
        agentId?: string;
        limit?: number;
        offset?: number;
        orderBy?: 'updated_at' | 'created_at';
    }): Promise<Session[]> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const limit = options?.limit || 100;
            const offset = options?.offset || 0;
            const orderBy = options?.orderBy || 'updated_at';

            let sql = `SELECT * FROM sessions`;
            const params: any[] = [];

            if (options?.agentId) {
                sql += ` WHERE agent_id = ?`;
                params.push(options.agentId);
            }

            sql += ` ORDER BY ${orderBy} DESC LIMIT ? OFFSET ?`;
            params.push(limit, offset);

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as any[];

            return rows.map(row => this.rowToSession(row));
        } catch (error) {
            throw new SQLiteError(
                'Failed to get session list',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 数据库行转换为 Session 对象
     */
    private rowToSession(row: any): Session {
        return {
            sessionKey: row.session_key,
            agentId: row.agent_id,
            channel: row.channel,
            accountId: row.account_id || undefined,
            peerId: row.peer_id || undefined,
            guildId: row.guild_id || undefined,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            messageCount: row.message_count,
            lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : undefined,
        };
    }

    // ========== Message 操作 ==========

    /**
     * 插入单条消息
     */
    async insertMessage(message: SessionMessage): Promise<number> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const stmt = this.db.prepare(`
                INSERT INTO session_messages (
                    session_key, message_type, content, model,
                    tokens_input, tokens_output, tools_json, timestamp
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                message.sessionKey,
                message.messageType,
                message.content || null,
                message.model || null,
                message.tokensInput || null,
                message.tokensOutput || null,
                message.toolsJson || null,
                message.timestamp.toISOString()
            );

            return result.lastInsertRowid as number;
        } catch (error) {
            throw new SQLiteError(
                'Failed to insert message',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 批量插入消息（核心性能方法）
     * - 使用事务批量插入
     * - 自动更新 session 的 message_count
     */
    async batchInsertMessages(messages: SessionMessage[]): Promise<number> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        if (messages.length === 0) return 0;

        try {
            // 使用事务批量插入
            const insertMany = this.db.transaction((msgs: SessionMessage[]) => {
                const stmt = this.db!.prepare(`
                    INSERT INTO session_messages (
                        session_key, message_type, content, model,
                        tokens_input, tokens_output, tools_json, timestamp
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                let insertedCount = 0;
                for (const msg of msgs) {
                    stmt.run(
                        msg.sessionKey,
                        msg.messageType,
                        msg.content || null,
                        msg.model || null,
                        msg.tokensInput || null,
                        msg.tokensOutput || null,
                        msg.toolsJson || null,
                        msg.timestamp.toISOString()
                    );
                    insertedCount++;
                }

                return insertedCount;
            });

            const insertedCount = insertMany(messages);

            // 更新 session 的 message_count
            const sessionCounts = new Map<string, number>();
            for (const msg of messages) {
                const count = sessionCounts.get(msg.sessionKey) || 0;
                sessionCounts.set(msg.sessionKey, count + 1);
            }

            const updateSession = this.db.prepare(`
                UPDATE sessions
                SET message_count = message_count + ?,
                    updated_at = ?,
                    last_message_at = ?
                WHERE session_key = ?
            `);

            const now = new Date().toISOString();
            for (const [sessionKey, count] of sessionCounts) {
                updateSession.run(count, now, now, sessionKey);
            }

            return insertedCount;
        } catch (error) {
            throw new SQLiteError(
                'Failed to batch insert messages',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 获取会话历史消息
     */
    async getSessionHistory(
        sessionKey: string,
        options?: {
            limit?: number;
            beforeTimestamp?: Date;
        }
    ): Promise<SessionMessage[]> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const limit = options?.limit || 100;
            const params: any[] = [sessionKey];

            let sql = `
                SELECT * FROM session_messages
                WHERE session_key = ?
            `;

            if (options?.beforeTimestamp) {
                sql += ` AND timestamp < ?`;
                params.push(options.beforeTimestamp.toISOString());
            }

            sql += ` ORDER BY timestamp DESC LIMIT ?`;
            params.push(limit);

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as any[];

            return rows.map(row => this.rowToMessage(row));
        } catch (error) {
            throw new SQLiteError(
                'Failed to get session history',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 数据库行转换为 SessionMessage 对象
     */
    private rowToMessage(row: any): SessionMessage {
        return {
            id: row.id,
            sessionKey: row.session_key,
            messageType: row.message_type,
            content: row.content || undefined,
            model: row.model || undefined,
            tokensInput: row.tokens_input || undefined,
            tokensOutput: row.tokens_output || undefined,
            toolsJson: row.tools_json || undefined,
            timestamp: new Date(row.timestamp),
            createdAt: row.created_at ? new Date(row.created_at) : undefined,
        };
    }

    // ========== 统计和维护 ==========

    /**
     * 获取统计信息
     */
    async getStats(): Promise<{
        totalSessions: number;
        totalMessages: number;
        dbSizeMB: number;
    }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const sessionsStmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
            const messagesStmt = this.db.prepare(`SELECT COUNT(*) as count FROM session_messages`);

            const sessionsResult = sessionsStmt.get() as any;
            const messagesResult = messagesStmt.get() as any;

            // 获取数据库文件大小
            const fs = await import('fs');
            const stats = fs.statSync(this.dbPath);
            const dbSizeMB = stats.size / (1024 * 1024);

            return {
                totalSessions: sessionsResult.count,
                totalMessages: messagesResult.count,
                dbSizeMB: Math.round(dbSizeMB * 100) / 100,
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to get stats',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 清理过期数据
     * - 删除指定天数前的数据
     * - 返回删除的记录数
     */
    async cleanOldData(daysToKeep: number): Promise<{
        sessionsDeleted: number;
        messagesDeleted: number;
    }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            const cutoffISO = cutoffDate.toISOString();

            // 删除旧消息
            const deleteMessages = this.db.prepare(`
                DELETE FROM session_messages WHERE timestamp < ?
            `);
            const messagesResult = deleteMessages.run(cutoffISO);

            // 删除空会话
            const deleteSessions = this.db.prepare(`
                DELETE FROM sessions WHERE message_count = 0 AND updated_at < ?
            `);
            const sessionsResult = deleteSessions.run(cutoffISO);

            // 真空回收空间
            this.db.exec('VACUUM');

            return {
                sessionsDeleted: sessionsResult.changes,
                messagesDeleted: messagesResult.changes,
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to clean old data',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }
}
