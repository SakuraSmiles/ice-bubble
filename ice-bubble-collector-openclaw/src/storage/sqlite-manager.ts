/**
 * SQLite 管理器
 *
 * 主存储：持久化存储所有采集的数据
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Session, SessionMessage, SQLiteManagerConfig } from '../types';
import { Logger } from '../utils/logger.js';
import { SessionMessageMapper, SessionMapper, getDbColumns, getPlaceholders } from '../utils/type-mapper.js';

const sqliteLogger = new Logger('SQLiteManager');

/**
 * SQLite 查询结果行类型
 * better-sqlite3 的 get/all 返回 Record<string, unknown> 类型
 */
type SqlRow = Record<string, unknown>;

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
            
            // 并发优化配置
            this.db.pragma('busy_timeout = 5000'); // 5秒超时
            this.db.pragma('journal_size_limit = 67108864'); // 64MB WAL 日志限制
            
            // 针对批量写入优化
            this.db.pragma('page_size = 4096');
            this.db.pragma('auto_vacuum = INCREMENTAL');

            // 创建表结构
            this.createTables();

            // 运行数据库迁移
            this.runMigrations();

            this.isInitialized = true;
            sqliteLogger.info('Initialized successfully');
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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);
        `);

        // 2. session_messages 表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE,
                session_key TEXT NOT NULL,
                message_type TEXT NOT NULL,
                content TEXT,
                model TEXT,
                tokens_input INTEGER,
                tokens_output INTEGER,
                cost_total REAL,
                cost_input REAL,
                cost_output REAL,
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
                workspace TEXT,
                config_json TEXT,
                status TEXT,
                last_seen_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
            CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
        `);

        // 迁移：检查并添加 workspace 列
        try {
            const columns = this.db.prepare("PRAGMA table_info(agents)").all() as any[];
            const hasWorkspace = columns.some(col => col.name === 'workspace');
            if (!hasWorkspace) {
                this.db.exec('ALTER TABLE agents ADD COLUMN workspace TEXT');
                sqliteLogger.info('[Migration] Added workspace column to agents table');
            }

            // 迁移：检查并添加 source 列
            const hasSource = columns.some(col => col.name === 'source');
            if (!hasSource) {
                this.db.exec('ALTER TABLE agents ADD COLUMN source TEXT DEFAULT "openclaw"');
                sqliteLogger.info('[Migration] Added source column to agents table');
            }
        } catch (e) {
            // 忽略错误（表可能不存在或列已存在）
        }

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
     * 运行数据库迁移
     */
    private runMigrations(): void {
        if (!this.db) throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');

        // Migration 1: 添加 message_id 列到 session_messages 表
        // 用于存储 OpenClaw 原始消息 ID，实现去重
        // 注意: SQLite 不允许直接添加 UNIQUE 列,需要重建表
        try {
            const result = this.db.prepare("SELECT name FROM pragma_table_info('session_messages') WHERE name='message_id'").get();
            if (!result) {
                sqliteLogger.info('Running migration: 添加 message_id 列到 session_messages 表');

                // 由于 SQLite 限制,需要重建表
                this.db.exec('BEGIN TRANSACTION');
                try {
                    // 重命名旧表
                    this.db.exec('ALTER TABLE session_messages RENAME TO session_messages_old');

                    // 创建新表
                    this.db.exec(`
                        CREATE TABLE session_messages (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            message_id TEXT UNIQUE,
                            session_key TEXT NOT NULL,
                            message_type TEXT NOT NULL,
                            content TEXT,
                            model TEXT,
                            tokens_input INTEGER,
                            tokens_output INTEGER,
                            cost_total REAL,
                            cost_input REAL,
                            cost_output REAL,
                            tools_json TEXT,
                            timestamp TIMESTAMP NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
                        )
                    `);

                    // 复制数据
                    this.db.exec(`
                        INSERT INTO session_messages (id, session_key, message_type, content, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, tools_json, timestamp, created_at)
                        SELECT id, session_key, message_type, content, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, tools_json, timestamp, created_at FROM session_messages_old
                    `);

                    // 删除旧表
                    this.db.exec('DROP TABLE session_messages_old');

                    // 重建索引
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_key ON session_messages(session_key)');
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON session_messages(timestamp)');
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_type ON session_messages(message_type)');

                    // 记录迁移版本
                    this.db.exec('INSERT INTO schema_version (version) VALUES (1)');

                    this.db.exec('COMMIT');
                    sqliteLogger.info('Migration 1 completed: message_id 列已添加(重建表方式)');
                } catch (innerError) {
                    this.db.exec('ROLLBACK');
                    throw innerError;
                }
            }
        } catch (error) {
            sqliteLogger.warn('Migration 1 skipped or failed: ' + (error instanceof Error ? error.message : String(error)));
        }

        // Migration 2: 添加 cost 列（如果不存在）
        try {
            const hasCostTotal = this.db.prepare("SELECT name FROM pragma_table_info('session_messages') WHERE name='cost_total'").get();
            if (!hasCostTotal) {
                sqliteLogger.info('Running migration 2: 添加 cost 列到 session_messages 表');
                this.db.exec('ALTER TABLE session_messages ADD COLUMN cost_total REAL');
                this.db.exec('ALTER TABLE session_messages ADD COLUMN cost_input REAL');
                this.db.exec('ALTER TABLE session_messages ADD COLUMN cost_output REAL');
                sqliteLogger.info('Migration 2 completed: cost 列已添加');
            }
        } catch (error) {
            sqliteLogger.warn('Migration 2 skipped or failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /**
     * 关闭数据库连接
     */
    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.isInitialized = false;
            sqliteLogger.info('Closed successfully');
        }
    }

    // ========== Session 操作 ==========

    /**
     * 插入或更新会话（upsert）
     * - 存在则更新 updated_at
     * - 不存在则插入新记录
     */
    async upsertSession(session: Session): Promise<void> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            // 使用 TypeMapper 转换
            const dbRow = SessionMapper.toDb(session);
            
            // 动态构建 SQL
            const columns = getDbColumns('sessions').filter(col => col !== 'id');
            const placeholders = getPlaceholders(columns);
            
            const stmt = this.db.prepare(`
                INSERT INTO sessions (${columns.join(', ')})
                VALUES (${placeholders})
                ON CONFLICT(session_key) DO UPDATE SET
                    updated_at = excluded.updated_at
            `);

            // 按列顺序获取值
            const values = columns.map(col => dbRow[col]);
            stmt.run(...values);
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

            const row = stmt.get(sessionKey) as SqlRow | undefined;

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
            const params: unknown[] = [];

            if (options?.agentId) {
                sql += ` WHERE agent_id = ?`;
                params.push(options.agentId);
            }

            sql += ` ORDER BY ${orderBy} DESC LIMIT ? OFFSET ?`;
            params.push(limit, offset);

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as SqlRow[];

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
    private rowToSession(row: SqlRow): Session {
        return {
            sessionKey: row.session_key as string,
            agentId: row.agent_id as string,
            channel: row.channel as string,
            accountId: row.account_id as string | undefined,
            peerId: row.peer_id as string | undefined,
            guildId: row.guild_id as string | undefined,
            createdAt: new Date(row.created_at as string | number | Date),
            updatedAt: new Date(row.updated_at as string | number | Date),
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
            // 使用 TypeMapper 转换
            const dbRow = SessionMessageMapper.toDb(message);
            
            // 动态构建 SQL
            const columns = getDbColumns('session_messages').filter(col => col !== 'id');
            const placeholders = getPlaceholders(columns);
            
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO session_messages (${columns.join(', ')})
                VALUES (${placeholders})
            `);

            // 按列顺序获取值
            const values = columns.map(col => dbRow[col]);
            const result = stmt.run(...values);

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
     * - 返回实际插入数（排除重复）
     *
     * @returns 实际插入的消息数量
     */
    async batchInsertMessages(messages: SessionMessage[]): Promise<{ inserted: number; duplicates: number }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        if (messages.length === 0) return { inserted: 0, duplicates: 0 };

        try {
            // 使用 IMMEDIATE 事务避免 SQLITE_BUSY
            const insertMany = this.db.transaction((msgs: SessionMessage[]) => {
                // 批量转换为数据库行
                const dbRows = SessionMessageMapper.batchToDb(msgs);
                
                // 动态构建 SQL
                const columns = getDbColumns('session_messages').filter(col => col !== 'id');
                const placeholders = getPlaceholders(columns);
                
                const stmt = this.db!.prepare(`
                    INSERT OR IGNORE INTO session_messages (${columns.join(', ')})
                    VALUES (${placeholders})
                `);

                let actualInserts = 0;
                for (const row of dbRows) {
                    const values = columns.map(col => row[col]);
                    const result = stmt.run(...values);
                    // result.changes > 0 表示实际插入了新行，0 表示被 IGNORE（重复）
                    if (result.changes > 0) {
                        actualInserts++;
                    }
                }

                return actualInserts;
            });

            // 使用 IMMEDIATE 事务模式，避免并发冲突
            const actualInserts = insertMany.immediate(messages);
            const duplicates = messages.length - actualInserts;

            return { inserted: actualInserts, duplicates };
        } catch (error) {
            throw new SQLiteError(
                'Failed to batch insert messages',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 并发安全批量插入（带重试机制）
     * 
     * 针对高并发场景优化：
     * 1. 使用 EXCLUSIVE 事务模式
     * 2. 添加重试机制处理 SQLITE_BUSY
     * 3. 分批处理避免长事务
     * 
     * @param messages 消息列表
     * @param maxRetries 最大重试次数
     * @param batchSize 分批大小
     */
    async concurrentBatchInsert(
        messages: SessionMessage[],
        maxRetries: number = 3,
        batchSize: number = 100
    ): Promise<number> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        if (messages.length === 0) return 0;

        let totalInserted = 0;
        const batches = this.chunkArray(messages, batchSize);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            let retryCount = 0;
            let success = false;

            while (!success && retryCount <= maxRetries) {
                try {
                    // 使用 EXCLUSIVE 事务模式，避免并发冲突
                    const insertBatch = this.db.transaction((msgs: SessionMessage[]) => {
                        const dbRows = SessionMessageMapper.batchToDb(msgs);
                        const columns = getDbColumns('session_messages').filter(col => col !== 'id');
                        const placeholders = getPlaceholders(columns);
                        
                        const stmt = this.db!.prepare(`
                            INSERT OR IGNORE INTO session_messages (${columns.join(', ')})
                            VALUES (${placeholders})
                        `);

                        let actualInserts = 0;
                        for (const row of dbRows) {
                            const values = columns.map(col => row[col]);
                            const result = stmt.run(...values);
                            if (result.changes > 0) {
                                actualInserts++;
                            }
                        }
                        return actualInserts;
                    });

                    // 使用 EXCLUSIVE 模式
                    const inserted = insertBatch.exclusive(batch);
                    totalInserted += inserted;
                    success = true;

                    sqliteLogger.debug(`批次 ${i + 1}/${batches.length} 插入成功: ${inserted} 条消息`);

                } catch (error: any) {
                    retryCount++;
                    
                    if (error.code === 'SQLITE_BUSY' && retryCount <= maxRetries) {
                        // 数据库忙，等待后重试
                        const delay = Math.min(100 * Math.pow(2, retryCount), 1000); // 指数退避
                        sqliteLogger.warn(`批次 ${i + 1} 数据库忙，等待 ${delay}ms 后重试 (${retryCount}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        // 其他错误或重试次数用尽
                        sqliteLogger.error(`批次 ${i + 1} 插入失败`, error);
                        throw new SQLiteError(
                            `Failed to insert batch ${i + 1} after ${retryCount} retries`,
                            'SQLITE_BATCH_INSERT_FAILED',
                            error
                        );
                    }
                }
            }

            if (!success) {
                throw new SQLiteError(
                    `Failed to insert batch ${i + 1} after ${maxRetries} retries`,
                    'SQLITE_MAX_RETRIES_EXCEEDED'
                );
            }
        }

        return totalInserted;
    }

    /**
     * 更新 Session 统计信息（已废弃，统计由 Admin 计算）
     */
    /**
     * 更新 Session 统计信息（已废弃，统计由 Admin 计算）
     * @deprecated 由 Admin 的 computeSessionStats() 计算
     */
    // @ts-ignore -- 已废弃，保留方法签名由 Admin 计算
    private async _updateSessionStats(_messages: SessionMessage[]): Promise<void> {
        // 统计功能已移除，由 Admin 的 computeSessionStats() 计算
    }

    /**
     * 将数组分块
     */
    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
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
            const params: unknown[] = [sessionKey];

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
            const rows = stmt.all(...params) as SqlRow[];

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
    private rowToMessage(row: SqlRow): SessionMessage {
        return SessionMessageMapper.fromDb(row);
    }

    // ========== Agent 操作 ==========

    /**
     * Upsert agent
     */
    async upsertAgent(agent: {
        agent_id: string;
        agent_name: string;
        workspace?: string | null;
        source?: string | null;
        config_json: string;
        status: string;
        last_seen_at: string;
    }): Promise<void> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const stmt = this.db.prepare(`
                INSERT INTO agents (agent_id, agent_name, workspace, source, config_json, status, last_seen_at, updated_at)
                VALUES (@agent_id, @agent_name, @workspace, @source, @config_json, @status, @last_seen_at, CURRENT_TIMESTAMP)
                ON CONFLICT(agent_id) DO UPDATE SET
                    agent_name = excluded.agent_name,
                    workspace = excluded.workspace,
                    source = excluded.source,
                    config_json = excluded.config_json,
                    status = excluded.status,
                    last_seen_at = excluded.last_seen_at,
                    updated_at = CURRENT_TIMESTAMP
            `);
            stmt.run({
                agent_id: agent.agent_id,
                agent_name: agent.agent_name,
                workspace: agent.workspace ?? null,
                source: agent.source,
                config_json: agent.config_json,
                status: agent.status,
                last_seen_at: agent.last_seen_at
            });
        } catch (error) {
            throw new SQLiteError(
                'Failed to upsert agent',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * Get all agents
     */
    async getAgents(): Promise<{
        agents: Array<{
            agent_id: string;
            agent_name: string;
            workspace: string | null;
            source: string;
            config_json: string;
            status: string;
            last_seen_at: string;
            created_at: string;
            updated_at: string;
        }>;
    }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const stmt = this.db.prepare(`
                SELECT agent_id, agent_name, workspace, source, config_json, status, last_seen_at, created_at, updated_at
                FROM agents
                WHERE status = 'configured'
                ORDER BY last_seen_at DESC
            `);
            const rows = stmt.all() as SqlRow[];
            return {
                agents: rows.map(row => ({
                    agent_id: row.agent_id as string,
                    agent_name: row.agent_name as string,
                    workspace: (row.workspace as string | null) ?? null,
                    source: (row.source as string) || 'openclaw',
                    config_json: row.config_json as string,
                    status: row.status as string,
                    last_seen_at: row.last_seen_at as string,
                    created_at: row.created_at as string,
                    updated_at: row.updated_at as string,
                })),
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to get agents',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    // ========== 统计和维护 ==========

    /**
     * 获取会话列表（分页）
     */
    async getSessions(params: {
        limit?: number;
        offset?: number;
        since?: string;
    }): Promise<{ count: number; sessions: Session[] }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const limit = params.limit ?? 100;
            const offset = params.offset ?? 0;

            let countSql = `SELECT COUNT(*) as count FROM sessions`;
            let dataSql = `SELECT * FROM sessions`;
            const dataParams: unknown[] = [];

            if (params.since) {
                const sinceClause = ` WHERE updated_at >= ?`;
                countSql += sinceClause;
                dataSql += sinceClause;
                dataParams.push(params.since);
            }

            dataSql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
            dataParams.push(limit, offset);

            const countStmt = this.db.prepare(countSql);
            const countParams = params.since ? [params.since] : [];
            const countResult = countStmt.get(...countParams) as SqlRow;

            const stmt = this.db.prepare(dataSql);
            const rows = stmt.all(...dataParams) as SqlRow[];

            return {
                count: countResult.count as number,
                sessions: rows.map(row => this.rowToSession(row)),
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to get sessions',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 获取消息列表（分页）
     */
    async getMessages(params: {
        sessionKey?: string;
        limit?: number;
        offset?: number;
        since?: string;
    }): Promise<{ count: number; messages: SessionMessage[] }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const limit = params.limit ?? 100;
            const offset = params.offset ?? 0;

            const conditions: string[] = [];
            const queryParams: unknown[] = [];

            if (params.sessionKey) {
                conditions.push(`session_key = ?`);
                queryParams.push(params.sessionKey);
            }
            if (params.since) {
                conditions.push(`timestamp >= ?`);
                queryParams.push(params.since);
            }

            const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

            const countSql = `SELECT COUNT(*) as count FROM session_messages${whereClause}`;
            const countStmt = this.db.prepare(countSql);
            const countResult = countStmt.get(...queryParams) as SqlRow;

            const dataSql = `SELECT * FROM session_messages${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
            const dataParams = [...queryParams, limit, offset];
            const stmt = this.db.prepare(dataSql);
            const rows = stmt.all(...dataParams) as SqlRow[];

            return {
                count: countResult.count as number,
                messages: rows.map(row => this.rowToMessage(row)),
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to get messages',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

    /**
     * 获取数据统计
     */
    async getDataStats(): Promise<{
        sessionCount: number;
        messageCount: number;
        agentCount: number;
        lastUpdated: string;
    }> {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }

        try {
            const sessionStmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
            const messageStmt = this.db.prepare(`SELECT COUNT(*) as count FROM session_messages`);
            const agentStmt = this.db.prepare(`SELECT COUNT(*) as count FROM agents`);
            const lastUpdatedStmt = this.db.prepare(`SELECT MAX(updated_at) as last_updated FROM sessions`);

            const sessionResult = sessionStmt.get() as SqlRow;
            const messageResult = messageStmt.get() as SqlRow;
            const agentResult = agentStmt.get() as SqlRow;
            const lastUpdatedResult = lastUpdatedStmt.get() as SqlRow;

            return {
                sessionCount: sessionResult.count as number,
                messageCount: messageResult.count as number,
                agentCount: agentResult.count as number,
                lastUpdated: (lastUpdatedResult.last_updated as string) || new Date(0).toISOString(),
            };
        } catch (error) {
            throw new SQLiteError(
                'Failed to get data stats',
                'SQLITE_QUERY_FAILED',
                error
            );
        }
    }

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

            const sessionsResult = sessionsStmt.get() as SqlRow;
            const messagesResult = messagesStmt.get() as SqlRow;

            // 获取数据库文件大小
            const fs = await import('fs');
            const stats = fs.statSync(this.dbPath);
            const dbSizeMB = stats.size / (1024 * 1024);

            return {
                totalSessions: sessionsResult.count as number,
                totalMessages: messagesResult.count as number,
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

            // 删除空会话（无对应消息的 session）
            const deleteSessions = this.db.prepare(`
                DELETE FROM sessions 
                WHERE updated_at < ?
                AND NOT EXISTS (
                    SELECT 1 FROM session_messages WHERE session_messages.session_key = sessions.session_key
                )
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
