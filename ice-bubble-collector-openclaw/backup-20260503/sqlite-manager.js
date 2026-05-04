"use strict";
/**
 * SQLite 管理器
 *
 * 主存储：持久化存储所有采集的数据
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQLiteManager = exports.SQLiteError = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const logger_js_1 = require("../utils/logger.js");
const type_mapper_js_1 = require("../utils/type-mapper.js");
const sqliteLogger = new logger_js_1.Logger('SQLiteManager');
/**
 * SQLite 错误类
 */
class SQLiteError extends Error {
    code;
    detail;
    constructor(message, code, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'SQLiteError';
    }
}
exports.SQLiteError = SQLiteError;
/**
 * SQLite 管理器
 *
 * 职责：
 * - 数据库初始化和生命周期管理
 * - Session 和 Message 的 CRUD 操作
 * - 批量写入优化
 * - 数据清理和维护
 */
class SQLiteManager {
    db = null;
    dbPath = '';
    isInitialized = false;
    // ========== 生命周期 ==========
    /**
     * 初始化数据库
     * - 创建数据库文件
     * - 创建表结构
     * - 启用 WAL 模式
     * - 创建索引
     */
    async init(config) {
        try {
            this.dbPath = config.dbPath;
            // 创建数据库连接
            this.db = new better_sqlite3_1.default(config.dbPath);
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
        }
        catch (error) {
            throw new SQLiteError('Failed to initialize SQLite database', 'SQLITE_INIT_FAILED', error);
        }
    }
    /**
     * 创建数据库表结构
     */
    createTables() {
        if (!this.db)
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
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
            const columns = this.db.prepare("PRAGMA table_info(agents)").all();
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
        }
        catch (e) {
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
        // 7. session_events 表（非 message 类型的原始事件）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_id TEXT,
                data_json TEXT NOT NULL,
                timestamp TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(event_id),
                FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
            );
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session_key ON session_events(session_key)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON session_events(event_type)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON session_events(timestamp)`);
        // 8. session_messages_archive 表（30天消息归档）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_messages_archive (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER,
                message_id TEXT,
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
                archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_key, source_id)
            );
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_session ON session_messages_archive(session_key)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_timestamp ON session_messages_archive(timestamp)`);
    }
    /**
     * 运行数据库迁移
     */
    runMigrations() {
        if (!this.db)
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        // Migration 1: 添加 message_id 列到 session_messages 表
        // 用于存储 OpenClaw 原始消息 ID，实现去重
        try {
            const result = this.db.prepare("SELECT name FROM pragma_table_info('session_messages') WHERE name='message_id'").get();
            if (!result) {
                // 检查表中是否有数据，避免不必要的表重建
                const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM session_messages').get();
                const rowCount = countRow.cnt;
                if (rowCount === 0) {
                    // 空表：直接用 ALTER TABLE ADD COLUMN（快速，无需重建）
                    // 注意：UNIQUE 约束在有数据时才有意义，空表直接加列即可
                    this.db.exec('ALTER TABLE session_messages ADD COLUMN message_id TEXT');
                    // 为 message_id 创建唯一索引（等效于 UNIQUE 约束，但不阻塞 ALTER TABLE）
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_message_id ON session_messages(message_id)');
                    this.db.exec('INSERT INTO schema_version (version) VALUES (1)');
                    sqliteLogger.info('Migration 1 completed: message_id 列已添加(ALTER TABLE，空表优化)');
                }
                else {
                    // 有数据的表：使用重建表方式（唯一索引需要重建数据）
                    sqliteLogger.info(`Running migration: 添加 message_id 列到 session_messages 表 (${rowCount} 行数据，需重建表)`);
                    this.db.exec('BEGIN TRANSACTION');
                    try {
                        this.db.exec('ALTER TABLE session_messages RENAME TO session_messages_old');
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
                        this.db.exec(`
                            INSERT INTO session_messages (id, session_key, message_type, content, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, tools_json, timestamp, created_at)
                            SELECT id, session_key, message_type, content, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, tools_json, timestamp, created_at FROM session_messages_old
                        `);
                        this.db.exec('DROP TABLE session_messages_old');
                        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_key ON session_messages(session_key)');
                        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON session_messages(timestamp)');
                        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_type ON session_messages(message_type)');
                        this.db.exec('INSERT INTO schema_version (version) VALUES (1)');
                        this.db.exec('COMMIT');
                        sqliteLogger.info('Migration 1 completed: message_id 列已添加(重建表方式)');
                    }
                    catch (innerError) {
                        this.db.exec('ROLLBACK');
                        throw innerError;
                    }
                }
            }
        }
        catch (error) {
            sqliteLogger.warn('Migration 1 skipped or failed: ' + (error instanceof Error ? error.message : String(error)));
        }
        // Migration 3: sessions 表新增元数据列（label/status/model 等）
        try {
            const sessionsColumns = this.db.prepare("PRAGMA table_info('sessions')").all();
            const sessionColNames = new Set(sessionsColumns.map(col => col.name));
            const metaColumns = [
                { name: 'label', sql: 'label TEXT' },
                { name: 'status', sql: 'status TEXT' },
                { name: 'model', sql: 'model TEXT' },
                { name: 'model_provider', sql: 'model_provider TEXT' },
                { name: 'spawned_by', sql: 'spawned_by TEXT' },
                { name: 'spawn_depth', sql: 'spawn_depth INTEGER DEFAULT 0' },
            ];
            for (const col of metaColumns) {
                if (!sessionColNames.has(col.name)) {
                    this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col.sql}`);
                    sqliteLogger.info(`[Migration 3] Added ${col.name} column to sessions table`);
                }
            }
        }
        catch (error) {
            sqliteLogger.warn('Migration 3 skipped or failed: ' + (error instanceof Error ? error.message : String(error)));
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
        }
        catch (error) {
            sqliteLogger.warn('Migration 2 skipped or failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /**
     * 关闭数据库连接
     */
    async close() {
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
    async upsertSession(session) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            // 使用 TypeMapper 转换
            const dbRow = type_mapper_js_1.SessionMapper.toDb(session);
            // 动态构建 SQL
            const columns = (0, type_mapper_js_1.getDbColumns)('sessions').filter(col => col !== 'id');
            const placeholders = (0, type_mapper_js_1.getPlaceholders)(columns);
            const stmt = this.db.prepare(`
                INSERT INTO sessions (${columns.join(', ')})
                VALUES (${placeholders})
                ON CONFLICT(session_key) DO UPDATE SET
                    updated_at = excluded.updated_at
            `);
            // 按列顺序获取值
            const values = columns.map(col => dbRow[col]);
            stmt.run(...values);
        }
        catch (error) {
            throw new SQLiteError('Failed to upsert session', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取单个会话
     */
    async getSession(sessionKey) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM sessions WHERE session_key = ?
            `);
            const row = stmt.get(sessionKey);
            if (!row)
                return null;
            return this.rowToSession(row);
        }
        catch (error) {
            throw new SQLiteError('Failed to get session', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取会话列表（分页）
     */
    async getSessionList(options) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const limit = options?.limit || 100;
            const offset = options?.offset || 0;
            const orderBy = options?.orderBy || 'updated_at';
            let sql = `SELECT * FROM sessions`;
            const params = [];
            if (options?.agentId) {
                sql += ` WHERE agent_id = ?`;
                params.push(options.agentId);
            }
            sql += ` ORDER BY ${orderBy} DESC LIMIT ? OFFSET ?`;
            params.push(limit, offset);
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params);
            return rows.map(row => this.rowToSession(row));
        }
        catch (error) {
            throw new SQLiteError('Failed to get session list', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 数据库行转换为 Session 对象
     */
    rowToSession(row) {
        return {
            sessionKey: row.session_key,
            agentId: row.agent_id,
            channel: row.channel,
            accountId: row.account_id,
            peerId: row.peer_id,
            guildId: row.guild_id,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            // 聚合字段（从子查询获取）
            message_count: row.message_count ?? 0,
            last_message_at: row.last_message_at,
            // sessions.json 同步字段
            label: row.label,
            status: row.status,
            model: row.model,
            modelProvider: row.model_provider,
            spawnedBy: row.spawned_by,
            spawnDepth: row.spawn_depth,
        };
    }
    /**
     * 更新 session 元数据（从 sessions.json 同步）
     *
     * 使用 COALESCE 避免空值覆盖已有值。
     */
    async updateSessionMetadata(sessionKey, meta) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        const stmt = this.db.prepare(`
            UPDATE sessions SET
                label = COALESCE(?, label),
                status = COALESCE(?, status),
                model = COALESCE(?, model),
                model_provider = COALESCE(?, model_provider),
                spawned_by = COALESCE(?, spawned_by),
                spawn_depth = COALESCE(?, spawn_depth),
                updated_at = CURRENT_TIMESTAMP
            WHERE session_key = ?
        `);
        const result = stmt.run(meta.label ?? null, meta.status ?? null, meta.model ?? null, meta.modelProvider ?? null, meta.spawnedBy ?? null, meta.spawnDepth ?? null, sessionKey);
        return result.changes;
    }
    // ========== Message 操作 ==========
    /**
     * 插入单条消息
     */
    async insertMessage(message) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            // 使用 TypeMapper 转换
            const dbRow = type_mapper_js_1.SessionMessageMapper.toDb(message);
            // 动态构建 SQL
            const columns = (0, type_mapper_js_1.getDbColumns)('session_messages').filter(col => col !== 'id');
            const placeholders = (0, type_mapper_js_1.getPlaceholders)(columns);
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO session_messages (${columns.join(', ')})
                VALUES (${placeholders})
            `);
            // 按列顺序获取值
            const values = columns.map(col => dbRow[col]);
            const result = stmt.run(...values);
            return result.lastInsertRowid;
        }
        catch (error) {
            throw new SQLiteError('Failed to insert message', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 批量插入消息（核心性能方法）
     * - 使用事务批量插入
     * - 返回实际插入数（排除重复）
     *
     * @returns 实际插入的消息数量
     */
    async batchInsertMessages(messages) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        if (messages.length === 0)
            return { inserted: 0, duplicates: 0 };
        try {
            // 使用 IMMEDIATE 事务避免 SQLITE_BUSY
            const insertMany = this.db.transaction((msgs) => {
                // 批量转换为数据库行
                const dbRows = type_mapper_js_1.SessionMessageMapper.batchToDb(msgs);
                // 动态构建 SQL
                const columns = (0, type_mapper_js_1.getDbColumns)('session_messages').filter(col => col !== 'id');
                const placeholders = (0, type_mapper_js_1.getPlaceholders)(columns);
                const stmt = this.db.prepare(`
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
        }
        catch (error) {
            throw new SQLiteError('Failed to batch insert messages', 'SQLITE_QUERY_FAILED', error);
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
    async concurrentBatchInsert(messages, maxRetries = 3, batchSize = 100) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        if (messages.length === 0)
            return 0;
        let totalInserted = 0;
        const batches = this.chunkArray(messages, batchSize);
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            let retryCount = 0;
            let success = false;
            while (!success && retryCount <= maxRetries) {
                try {
                    // 使用 EXCLUSIVE 事务模式，避免并发冲突
                    const insertBatch = this.db.transaction((msgs) => {
                        const dbRows = type_mapper_js_1.SessionMessageMapper.batchToDb(msgs);
                        const columns = (0, type_mapper_js_1.getDbColumns)('session_messages').filter(col => col !== 'id');
                        const placeholders = (0, type_mapper_js_1.getPlaceholders)(columns);
                        const stmt = this.db.prepare(`
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
                }
                catch (error) {
                    retryCount++;
                    const err = error instanceof Error ? error : new Error(String(error));
                    if (err.message === 'SQLITE_BUSY' && retryCount <= maxRetries) {
                        // 数据库忙，等待后重试
                        const delay = Math.min(100 * Math.pow(2, retryCount), 1000); // 指数退避
                        sqliteLogger.warn(`批次 ${i + 1} 数据库忙，等待 ${delay}ms 后重试 (${retryCount}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    else {
                        // 其他错误或重试次数用尽
                        sqliteLogger.error(`批次 ${i + 1} 插入失败`, err);
                        throw new SQLiteError(`Failed to insert batch ${i + 1} after ${retryCount} retries`, 'SQLITE_BATCH_INSERT_FAILED', error);
                    }
                }
            }
            if (!success) {
                throw new SQLiteError(`Failed to insert batch ${i + 1} after ${maxRetries} retries`, 'SQLITE_MAX_RETRIES_EXCEEDED');
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
    async _updateSessionStats(_messages) {
        // 统计功能已移除，由 Admin 的 computeSessionStats() 计算
    }
    /**
     * 将数组分块
     */
    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
    /**
     * 获取会话历史消息
     */
    async getSessionHistory(sessionKey, options) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const limit = options?.limit || 100;
            const params = [sessionKey];
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
            const rows = stmt.all(...params);
            return rows.map(row => this.rowToMessage(row));
        }
        catch (error) {
            throw new SQLiteError('Failed to get session history', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取所有 message_id（用于去重缓存预热）
     *
     * 使用分批游标查询避免大表内存压力
     *
     * @param batchSize 每批数量，默认 10000
     * @returns 所有 message_id 数组
     */
    async getAllMessageIds(batchSize = 10000) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const allIds = [];
            let lastId = null;
            while (true) {
                let sql;
                let rows;
                if (lastId === null) {
                    sql = `SELECT message_id FROM session_messages WHERE message_id IS NOT NULL ORDER BY id LIMIT ?`;
                    const stmt = this.db.prepare(sql);
                    rows = stmt.all(batchSize);
                }
                else {
                    sql = `SELECT message_id FROM session_messages WHERE message_id IS NOT NULL AND id > (SELECT id FROM session_messages WHERE message_id = ?) ORDER BY id LIMIT ?`;
                    const stmt = this.db.prepare(sql);
                    rows = stmt.all(lastId, batchSize);
                }
                if (rows.length === 0)
                    break;
                for (const row of rows) {
                    const id = row.message_id;
                    if (id) {
                        allIds.push(id);
                        lastId = id;
                    }
                }
                if (rows.length < batchSize)
                    break;
            }
            sqliteLogger.debug(`[SQLiteManager] getAllMessageIds 完成: 共 ${allIds.length} 条`);
            return allIds;
        }
        catch (error) {
            throw new SQLiteError('Failed to get all message IDs', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 数据库行转换为 SessionMessage 对象
     */
    rowToMessage(row) {
        return type_mapper_js_1.SessionMessageMapper.fromDb(row);
    }
    // ========== Event 操作 ==========
    /**
     * 批量插入事件（非 message 类型的原始行）
     *
     * @returns 实际插入的事件数量
     */
    async batchInsertEvents(events) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        if (events.length === 0)
            return { inserted: 0, duplicates: 0 };
        try {
            const insertMany = this.db.transaction((evts) => {
                const stmt = this.db.prepare(`
                    INSERT OR IGNORE INTO session_events (session_key, event_type, event_id, data_json, timestamp)
                    VALUES (?, ?, ?, ?, ?)
                `);
                let actualInserts = 0;
                for (const evt of evts) {
                    const result = stmt.run(evt.session_key, evt.event_type, evt.event_id || null, evt.data_json, evt.timestamp);
                    if (result.changes > 0) {
                        actualInserts++;
                    }
                }
                return actualInserts;
            });
            const actualInserts = insertMany.immediate(events);
            return { inserted: actualInserts, duplicates: events.length - actualInserts };
        }
        catch (error) {
            throw new SQLiteError('Failed to batch insert events', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取事件列表（分页）
     */
    async getEvents(options) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const limit = options?.limit ?? 100;
            const offset = options?.offset ?? 0;
            const conditions = [];
            const queryParams = [];
            if (options?.sessionKey) {
                conditions.push(`session_key = ?`);
                queryParams.push(options.sessionKey);
            }
            if (options?.eventType) {
                conditions.push(`event_type = ?`);
                queryParams.push(options.eventType);
            }
            if (options?.since) {
                conditions.push(`timestamp >= ?`);
                queryParams.push(options.since);
            }
            const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
            const countSql = `SELECT COUNT(*) as count FROM session_events${whereClause}`;
            const countStmt = this.db.prepare(countSql);
            const countResult = countStmt.get(...queryParams);
            const dataSql = `SELECT * FROM session_events${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
            const dataParams = [...queryParams, limit, offset];
            const stmt = this.db.prepare(dataSql);
            const rows = stmt.all(...dataParams);
            return {
                count: countResult.count,
                events: rows.map(row => ({
                    id: row.id,
                    session_key: row.session_key,
                    event_type: row.event_type,
                    event_id: row.event_id,
                    data_json: row.data_json,
                    timestamp: row.timestamp,
                    created_at: row.created_at,
                })),
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get events', 'SQLITE_QUERY_FAILED', error);
        }
    }
    // ========== Agent 操作 ==========
    /**
     * Upsert agent
     */
    async upsertAgent(agent) {
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
        }
        catch (error) {
            throw new SQLiteError('Failed to upsert agent', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * Get all agents
     */
    async getAgents() {
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
            const rows = stmt.all();
            return {
                agents: rows.map(row => ({
                    agent_id: row.agent_id,
                    agent_name: row.agent_name,
                    workspace: row.workspace ?? null,
                    source: row.source || 'openclaw',
                    config_json: row.config_json,
                    status: row.status,
                    last_seen_at: row.last_seen_at,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                })),
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get agents', 'SQLITE_QUERY_FAILED', error);
        }
    }
    // ========== 统计和维护 ==========
    /**
     * 获取会话列表（分页）
     */
    async getSessions(params) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const limit = params.limit ?? 100;
            const offset = params.offset ?? 0;
            let countSql = `SELECT COUNT(*) as count FROM sessions`;
            let dataSql = `SELECT s.*,
                  (SELECT COUNT(*) FROM session_messages sm WHERE sm.session_key = s.session_key) as message_count,
                  (SELECT MAX(sm.timestamp) FROM session_messages sm WHERE sm.session_key = s.session_key) as last_message_at
                FROM sessions s`;
            const dataParams = [];
            if (params.since) {
                const sinceClause = ` WHERE s.updated_at >= ?`;
                countSql += sinceClause;
                dataSql += sinceClause;
                dataParams.push(params.since);
            }
            dataSql += ` ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`;
            dataParams.push(limit, offset);
            const countStmt = this.db.prepare(countSql);
            const countParams = params.since ? [params.since] : [];
            const countResult = countStmt.get(...countParams);
            const stmt = this.db.prepare(dataSql);
            const rows = stmt.all(...dataParams);
            return {
                count: countResult.count,
                sessions: rows.map(row => this.rowToSession(row)),
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get sessions', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取消息列表（分页）
     */
    async getMessages(params) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const limit = params.limit ?? 100;
            const offset = params.offset ?? 0;
            const conditions = [];
            const queryParams = [];
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
            const countResult = countStmt.get(...queryParams);
            const dataSql = `SELECT * FROM session_messages${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
            const dataParams = [...queryParams, limit, offset];
            const stmt = this.db.prepare(dataSql);
            const rows = stmt.all(...dataParams);
            return {
                count: countResult.count,
                messages: rows.map(row => this.rowToMessage(row)),
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get messages', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取数据统计
     */
    async getDataStats() {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const sessionStmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
            const messageStmt = this.db.prepare(`SELECT COUNT(*) as count FROM session_messages`);
            const agentStmt = this.db.prepare(`SELECT COUNT(*) as count FROM agents`);
            const lastUpdatedStmt = this.db.prepare(`SELECT MAX(updated_at) as last_updated FROM sessions`);
            const sessionResult = sessionStmt.get();
            const messageResult = messageStmt.get();
            const agentResult = agentStmt.get();
            const lastUpdatedResult = lastUpdatedStmt.get();
            return {
                sessionCount: sessionResult.count,
                messageCount: messageResult.count,
                agentCount: agentResult.count,
                lastUpdated: lastUpdatedResult.last_updated || new Date(0).toISOString(),
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get data stats', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 获取统计信息
     */
    async getStats() {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        try {
            const sessionsStmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
            const messagesStmt = this.db.prepare(`SELECT COUNT(*) as count FROM session_messages`);
            const sessionsResult = sessionsStmt.get();
            const messagesResult = messagesStmt.get();
            // 获取数据库文件大小
            const fs = await import('fs');
            const stats = fs.statSync(this.dbPath);
            const dbSizeMB = stats.size / (1024 * 1024);
            return {
                totalSessions: sessionsResult.count,
                totalMessages: messagesResult.count,
                dbSizeMB: Math.round(dbSizeMB * 100) / 100,
            };
        }
        catch (error) {
            throw new SQLiteError('Failed to get stats', 'SQLITE_QUERY_FAILED', error);
        }
    }
    /**
     * 清理过期数据
     * - 删除指定天数前的数据
     * - 返回删除的记录数
     */
    async cleanOldData(daysToKeep) {
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
        }
        catch (error) {
            throw new SQLiteError('Failed to clean old data', 'SQLITE_QUERY_FAILED', error);
        }
    }
    // ========== Data Archival (30-day retention) ==========
    /**
     * 归档超过指定天数的消息到 archive 表
     * 幂等：只归档尚未归档的数据
     * @param daysToKeep 保留天数，默认 30
     * @returns 归档的消息数量
     */
    archiveOldMessages(daysToKeep = 30) {
        if (!this.db || !this.isInitialized) {
            throw new SQLiteError('Database not initialized', 'SQLITE_CONNECTION_CLOSED');
        }
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        const cutoffISO = cutoffDate.toISOString();
        sqliteLogger.info(`[SQLiteManager] Archiving messages older than ${cutoffISO}`);
        const archive = this.db.transaction(() => {
            // 1. 查找需要归档的消息（不在 archive 中）
            const toArchive = this.db.prepare(`
                SELECT * FROM session_messages
                WHERE timestamp < ?
                  AND id NOT IN (SELECT source_id FROM session_messages_archive WHERE source_id IS NOT NULL)
            `).all(cutoffISO);
            if (toArchive.length === 0) {
                sqliteLogger.info('[SQLiteManager] No messages to archive');
                return 0;
            }
            sqliteLogger.info(`[SQLiteManager] Found ${toArchive.length} messages to archive`);
            // 2. 插入到 archive 表
            const insertArchive = this.db.prepare(`
                INSERT OR IGNORE INTO session_messages_archive (
                  source_id, message_id, session_key, message_type, content,
                  model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
                  tools_json, timestamp, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const msg of toArchive) {
                insertArchive.run(msg.id, msg.message_id, msg.session_key, msg.message_type, msg.content, msg.model, msg.tokens_input, msg.tokens_output, msg.cost_total, msg.cost_input, msg.cost_output, msg.tools_json, msg.timestamp, msg.created_at);
            }
            // 3. 从主表删除已归档的消息
            const sourceIds = toArchive.map(m => m.id).filter(id => id !== undefined);
            if (sourceIds.length > 0) {
                const placeholders = sourceIds.map(() => '?').join(',');
                const deleted = this.db.prepare(`DELETE FROM session_messages WHERE id IN (${placeholders})`).run(...sourceIds);
                sqliteLogger.info(`[SQLiteManager] Deleted ${deleted.changes} messages from main table`);
            }
            return toArchive.length;
        });
        const count = archive();
        if (count > 0) {
            this.db.exec('VACUUM');
        }
        sqliteLogger.info(`[SQLiteManager] Archived ${count} messages`);
        return count;
    }
    /**
     * 执行数据库 VACUUM
     */
    vacuumIfNeeded() {
        if (!this.db)
            return;
        try {
            this.db.exec('VACUUM');
            sqliteLogger.info('[SQLiteManager] VACUUM completed after archival');
        }
        catch (error) {
            sqliteLogger.warn('[SQLiteManager] VACUUM failed:', { error: String(error) });
        }
    }
    /**
     * 启动每日归档定时器（每天凌晨 3 点）
     * @param daysToKeep 保留天数，默认 30
     * @param onComplete 归档完成回调
     */
    startArchiveScheduler(daysToKeep = 30, onComplete) {
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const runArchive = () => {
            try {
                const count = this.archiveOldMessages(daysToKeep);
                onComplete?.(count);
            }
            catch (error) {
                sqliteLogger.error('[SQLiteManager] Scheduled archive failed:', { error: String(error) });
            }
        };
        // 计算到次日凌晨 3 点的毫秒数
        const now = new Date();
        const next3AM = new Date(now);
        next3AM.setHours(3, 0, 0, 0);
        if (next3AM <= now)
            next3AM.setDate(next3AM.getDate() + 1);
        const initialDelay = next3AM.getTime() - now.getTime();
        sqliteLogger.info(`[SQLiteManager] Archive scheduler will first run at ${next3AM.toISOString()} (in ${Math.round(initialDelay / 1000 / 60)}min), then every 24h`);
        // 初始延迟后执行一次，之后每 24 小时执行
        setTimeout(() => {
            runArchive();
            setInterval(runArchive, MS_PER_DAY);
        }, initialDelay);
    }
}
exports.SQLiteManager = SQLiteManager;
//# sourceMappingURL=sqlite-manager.js.map