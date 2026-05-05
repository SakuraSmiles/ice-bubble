/**
 * ice-bubble Admin - 数据管理仓库
 *
 * 负责 admin_sessions, admin_messages, admin_agents, sync_progress 表的 CRUD 操作
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/index.js';
import type { CollectorAgent } from '../data/collector-client.js';
import { analyzeMessageMeta } from '../utils/message-meta.js';

// ========== 类型定义 ==========

export interface AdminSession {
  session_key: string;
  source_module: string;
  agent_id: string | null;
  channel: string | null;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  source_created_at: string | null;
  label: string | null;
  session_status: string | null;
  model: string | null;
  model_provider: string | null;
  spawned_by: string | null;
  spawn_depth: number | null;
}

export interface AdminMessage {
  id?: number;
  source_id: number | null;
  source_module: string;
  session_key: string;
  message_type: string | null;
  content: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_total: number | null;
  cost_input: number | null;
  cost_output: number | null;
  is_system_context?: number;
  timestamp: string;
  created_at: string;
  source_created_at: string | null;
}

/**
 * admin_tool_calls 表 row 类型
 * 与 AdminMessage 共享大部分字段，但使用 created_at 而非 timestamp
 * 合并查询时会 AS created_at AS timestamp 以统一字段名
 */
export interface AdminToolCall {
  id?: number;
  source_id: string;
  source_module: string;
  session_key: string;
  message_type: 'tool';
  content: string | null;
  created_at: string;
  timestamp?: string; // AS created_at AS timestamp，合并时使用
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_total: number | null;
  cost_input: number | null;
  cost_output: number | null;
  metadata: string | null;
  tool_name: string | null;
  tool_input: string | null;
}

export interface AdminAgent {
  agent_id: string;
  agent_name: string | null;
  workspace: string | null;
  session_count: number;
  message_count: number;
  first_active_at: string | null;
  last_active_at: string | null;
  model: string | null;
  avatar: string | null;
  source: string; // 采集器/平台来源，如 'openclaw'
  updated_at: string;
}

export interface SyncProgress {
  id?: number;
  table_name: string;
  last_sync_time: string | null;
  updated_at: string;
}

// ========== Timeline 类型 ==========

export interface TimelineMessage {
  id: number;
  session_key: string;
  agent_id: string | null;
  agent_name: string;
  avatar: string | null;
  message_type: 'user' | 'agent' | 'tool';
  content: string | null;
  /** 清洗后的用户内容（去掉 metadata/json 前缀等） */
  clean_content: string | null;
  /** 用于列表预览的简短摘要 */
  content_summary: string | null;
  /** 是否是定时任务 */
  is_cron: boolean;
  /** 是否是系统噪音（执行通知/heartbeat等） */
  is_system_noise: boolean;
  /** 消息来源渠道（从 Sender metadata 解析，如 openclaw-control-ui） */
  source_channel: string | null;
  /** 消息使用的模型 */
  model: string | null;
  timestamp: string;
}

// ========== 数据仓库 ==========

export class DataRepository {
  private db: Database;
  private avatarsDir: string;

  constructor(db: Database, avatarsDir: string) {
    this.db = db;
    this.avatarsDir = avatarsDir;
  }

  /** 获取底层 Database 连接（仅供需要直接 SQL 访问的组件使用） */
  getDb(): Database {
    return this.db;
  }

  // ========== Avatar Files ==========


  /**
   * 获取头像文件
   * @param filename 头像文件名
   * @returns 文件数据 { buffer, contentType } 或 null
   */
  getAvatar(filename: string): { buffer: Buffer; contentType: string } | null {
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return null; // 防止路径遍历攻击
    }
    
    const filePath = path.join(this.avatarsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const ext = path.extname(filename).toLowerCase().slice(1);
    const contentType = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
    }[ext] || 'application/octet-stream';
    
    try {
      const buffer = fs.readFileSync(filePath);
      return { buffer, contentType };
    } catch {
      return null;
    }
  }

  // ========== Sessions ==========

  /**
   * 批量保存 sessions（upsert）
   */
  saveSessions(sessions: AdminSession[]): void {
    if (sessions.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO admin_sessions (
        session_key, source_module, agent_id, channel, message_count,
        first_message_at, last_message_at, created_at, updated_at, source_created_at,
        label, session_status, model, model_provider, spawned_by, spawn_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        source_module = excluded.source_module,
        agent_id = excluded.agent_id,
        channel = excluded.channel,
        message_count = excluded.message_count,
        first_message_at = excluded.first_message_at,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at,
        label = excluded.label,
        session_status = excluded.session_status,
        model = excluded.model,
        model_provider = excluded.model_provider,
        spawned_by = excluded.spawned_by,
        spawn_depth = excluded.spawn_depth
    `);

    const now = new Date().toISOString();
    const insertMany = this.db.transaction((rows: AdminSession[]) => {
      for (const row of rows) {
        stmt.run(
          row.session_key,
          row.source_module,
          row.agent_id ?? null,
          row.channel ?? null,
          row.message_count ?? 0,
          row.first_message_at ?? null,
          row.last_message_at ?? null,
          now,
          now,
          row.source_created_at ?? null,
          row.label ?? null,
          row.session_status ?? null,
          row.model ?? null,
          row.model_provider ?? null,
          row.spawned_by ?? null,
          row.spawn_depth ?? 0
        );
      }
    });

    insertMany(sessions);
  }

  /**
   * 获取 session 列表
   */
  getSessions(params: {
    limit?: number;
    offset?: number;
    agent_id?: string;
    channel?: string;
  } = {}): { sessions: AdminSession[]; total: number } {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.agent_id) {
      conditions.push('agent_id = ?');
      values.push(params.agent_id);
    }
    if (params.channel) {
      conditions.push('channel = ?');
      values.push(params.channel);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_sessions ${whereClause}`).get(...values) as { total: number };

    const rows = this.db.prepare(`
      SELECT * FROM admin_sessions ${whereClause}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as AdminSession[];

    return { sessions: rows, total: countRow.total };
  }

  /**
   * 获取单个 session
   */
  getSession(sessionKey: string): AdminSession | null {
    const row = this.db.prepare('SELECT * FROM admin_sessions WHERE session_key = ?').get(sessionKey) as AdminSession | undefined;
    return row ?? null;
  }

  /**
   * 解析 Gateway 格式的 session key，返回匹配的 SQLite session key
   *
   * Gateway key 格式: agent:{agentId}:{slug} (如 agent:dev:subagent:UUID, agent:main:main)
   * SQLite key 格式: agent:{agentId}:{channel}:{workspace}:{chatType}:{UUID}
   *
   * 匹配策略:
   * 1. 直接匹配
   * 2. UUID 提取 + LIKE 模糊匹配
   * 3. agent_id 提取 + 按 agent_id 查找最新 session（用于 agent:main:main 等非 UUID 格式）
   *
   * @param sessionKey - Gateway 格式的 session key
   * @returns 匹配的 SQLite session key 数组（可能为空）
   */
  resolveSessionKey(sessionKey: string): string[] {
    // 1. 先尝试直接匹配
    const direct = this.db.prepare('SELECT session_key FROM admin_sessions WHERE session_key = ?').get(sessionKey);
    if (direct) return [sessionKey];

    // 解析 agentId: agent:{agentId}:{slug}
    const parts = sessionKey.split(':');
    const agentId = parts.length >= 2 ? parts[1] : '';

    // 2. 提取 UUID 并模糊匹配
    const uuidMatch = sessionKey.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (uuidMatch) {
      const uuid = uuidMatch[1];
      const rows = this.db.prepare(
        "SELECT session_key FROM admin_sessions WHERE session_key LIKE ? AND session_key NOT LIKE '%.trajectory'"
      ).all(`%${uuid}%`) as { session_key: string }[];
      if (rows.length > 0) return rows.map(r => r.session_key);
    }

    // 3. 非 UUID 格式（如 agent:main:main）: 按 agent_id 查找消息最多的那个 session
    //    注意：subagent 会话不回退查找，因为 Collector 不存储 subagent 消息
    if (agentId && !sessionKey.includes(':subagent:')) {
      const rows = this.db.prepare(
        `SELECT session_key FROM admin_sessions
         WHERE agent_id = ? AND session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint'
         ORDER BY message_count DESC NULLS LAST, last_message_at DESC NULLS LAST
         LIMIT 1`
      ).all(agentId) as { session_key: string }[];
      if (rows.length > 0) return rows.map(r => r.session_key);
    }

    return [];
  }

  // ========== Token Summary ==========

  /**
   * Get all Admin session_keys (excluding trajectory/checkpoint),
   * ordered by last_message_at DESC.
   */
  getAllAdminSessions(): string[] {
    return (this.db.prepare(
      `SELECT session_key FROM admin_sessions
       WHERE session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint%'
       ORDER BY last_message_at DESC NULLS LAST`
    ).all() as { session_key: string }[]).map(r => r.session_key);
  }

  /**
   * Get session timestamps (created_at, last_message_at) by session_key.
   */
  getSessionTimestamps(): Map<string, { created_at: string | null; last_message_at: string | null }> {
    const rows = this.db.prepare(
      `SELECT session_key, created_at, last_message_at FROM admin_sessions`
    ).all() as { session_key: string; created_at: string | null; last_message_at: string | null }[];
    const map = new Map<string, { created_at: string | null; last_message_at: string | null }>();
    for (const r of rows) {
      map.set(r.session_key, { created_at: r.created_at, last_message_at: r.last_message_at });
    }
    return map;
  }

  /**
   * Get all Admin session_keys for a given agent_id (excluding trajectory/checkpoint),
   * ordered by last_message_at DESC.
   */
  getAdminSessionsForAgent(agentId: string): string[] {
    return (this.db.prepare(
      `SELECT session_key FROM admin_sessions
       WHERE agent_id = ? AND session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint%'
       ORDER BY last_message_at DESC NULLS LAST`
    ).all(agentId) as { session_key: string }[]).map(r => r.session_key);
  }

  /**
   * Token 统计聚合接口（从每日数据聚合）
   * @param agentId 可选，按 agent_id 筛选
   * @param date 可选，按日期筛选（格式 'YYYY-MM-DD'），不传则返回所有日期的汇总
   */
  getTokenSummary(agentId?: string, date?: string): Array<{
    agent_id: string;
    date: string;
    total_tokens_input: number;
    total_tokens_output: number;
    total_cost: number;
    cost_input: number;
    cost_output: number;
    message_count: number;
    updated_at: string;
  }> {
    // 有具体日期：返回该日期的数据（按 agent 分组）
    if (date) {
      const rows = this.db.prepare(`
        SELECT
          agent_id,
          date,
          SUM(total_tokens_input) as total_tokens_input,
          SUM(total_tokens_output) as total_tokens_output,
          SUM(total_cost) as total_cost,
          SUM(cost_input) as cost_input,
          SUM(cost_output) as cost_output,
          SUM(message_count) as message_count,
          MIN(created_at) as created_at,
          MAX(updated_at) as updated_at
        FROM token_summary
        WHERE date = ?
        GROUP BY agent_id, date
        ORDER BY MAX(updated_at) DESC
      `).all(date) as Array<{
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
        updated_at: string;
      }>;
      return rows;
    }

    // 无具体日期：返回每个 agent 的所有日期汇总（date='all'）
    if (agentId) {
      const row = this.db.prepare(`
        SELECT
          agent_id,
          'all' as date,
          SUM(total_tokens_input) as total_tokens_input,
          SUM(total_tokens_output) as total_tokens_output,
          SUM(total_cost) as total_cost,
          SUM(cost_input) as cost_input,
          SUM(cost_output) as cost_output,
          SUM(message_count) as message_count,
          MIN(created_at) as created_at,
          MAX(updated_at) as updated_at
        FROM token_summary
        WHERE agent_id = ?
        GROUP BY agent_id
      `).get(agentId) as {
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
        updated_at: string;
      } | undefined;
      return row ? [row] : [];
    }

    // 无 agentId 无 date：返回所有 agent 的所有日期汇总（每个 agent 一行，date='all'）
    return this.db.prepare(`
      SELECT
        agent_id,
        'all' as date,
        SUM(total_tokens_input) as total_tokens_input,
        SUM(total_tokens_output) as total_tokens_output,
        SUM(total_cost) as total_cost,
        SUM(cost_input) as cost_input,
        SUM(cost_output) as cost_output,
        SUM(message_count) as message_count,
        MIN(created_at) as created_at,
        MAX(updated_at) as updated_at
      FROM token_summary
      GROUP BY agent_id
      ORDER BY MAX(updated_at) DESC
    `).all() as Array<{
      agent_id: string;
      date: string;
      total_tokens_input: number;
      total_tokens_output: number;
      total_cost: number;
      cost_input: number;
      cost_output: number;
      message_count: number;
      updated_at: string;
    }>;
  }

  /**
   * 批量更新 token_summary（在事务内执行，每日一条记录）
   */
  private batchUpdateTokenSummary(
    updates: Array<{
      agentId: string;
      tokensInput: number;
      tokensOutput: number;
      costTotal: number;
      costInput: number;
      costOutput: number;
    }>
  ): void {
    if (updates.length === 0) return;

    // 使用本地时区（北京时间 UTC+8）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    const nowISO = now.toISOString();

    const upsertSQL = `
      INSERT INTO token_summary
        (agent_id, date, total_tokens_input, total_tokens_output, total_cost, cost_input, cost_output, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        total_tokens_input = total_tokens_input + excluded.total_tokens_input,
        total_tokens_output = total_tokens_output + excluded.total_tokens_output,
        total_cost = total_cost + excluded.total_cost,
        cost_input = cost_input + excluded.cost_input,
        cost_output = cost_output + excluded.cost_output,
        message_count = message_count + 1,
        updated_at = excluded.updated_at
    `;
    const stmt = this.db.prepare(upsertSQL);

    for (const update of updates) {
      stmt.run(
        update.agentId,
        today,
        update.tokensInput,
        update.tokensOutput,
        update.costTotal,
        update.costInput,
        update.costOutput,
        nowISO,
        nowISO
      );
    }
    logger.info(`[DataRepository] Batch updated token_summary for ${updates.length} agents on ${today}`);
  }

  /**
   * 全量重建 token_summary（从 admin_messages 按天聚合）
   * @returns 受影响的 agent 数量
   */
  rebuildTokenSummary(): { affected_agents: number; duration_ms: number } {
    logger.info('[DataRepository] Starting token_summary rebuild...');
    const start = Date.now();

    const rebuild = this.db.transaction(() => {
      // 1. 清空 token_summary 表
      this.db.prepare('DELETE FROM token_summary').run();

      // 2. 按 agent_id 和 date 聚合 admin_messages 的 token 数据（使用北京时间 UTC+8）
      const rows = this.db.prepare(`
        SELECT
          s.agent_id,
          DATE(datetime(m.created_at, '+8 hours')) as date,
          COALESCE(SUM(CAST(m.tokens_input AS INTEGER)), 0) as total_tokens_input,
          COALESCE(SUM(CAST(m.tokens_output AS INTEGER)), 0) as total_tokens_output,
          COALESCE(SUM(CAST(m.cost_total AS REAL)), 0) as total_cost,
          COALESCE(SUM(CAST(m.cost_input AS REAL)), 0) as cost_input,
          COALESCE(SUM(CAST(m.cost_output AS REAL)), 0) as cost_output,
          COUNT(*) as message_count
        FROM admin_messages m
        INNER JOIN admin_sessions s ON m.session_key = s.session_key
        WHERE s.agent_id IS NOT NULL
          AND s.session_key NOT LIKE '%checkpoint%'
          AND (
            m.tokens_input IS NOT NULL OR
            m.tokens_output IS NOT NULL OR
            m.cost_total IS NOT NULL
          )
        GROUP BY s.agent_id, DATE(datetime(m.created_at, '+8 hours'))
      `).all() as Array<{
        agent_id: string;
        date: string;
        total_tokens_input: number;
        total_tokens_output: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
      }>;

      // 3. 重新插入（按 date 分组，每日一条）
      const insertSQL = `
        INSERT INTO token_summary
          (agent_id, date, total_tokens_input, total_tokens_output, total_cost, cost_input, cost_output, message_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const stmt = this.db.prepare(insertSQL);
      const now = new Date().toISOString();
      for (const row of rows) {
        stmt.run(
          row.agent_id,
          row.date,
          row.total_tokens_input,
          row.total_tokens_output,
          row.total_cost,
          row.cost_input,
          row.cost_output,
          row.message_count,
          now,
          now
        );
      }

      // 返回去重后的 agent 数量
      const agentIds = new Set(rows.map(r => r.agent_id));
      return agentIds.size;
    });

    const affected_agents = rebuild();
    const duration_ms = Date.now() - start;
    logger.info(`[DataRepository] Token summary rebuilt: ${affected_agents} agents in ${duration_ms}ms`);

    return { affected_agents, duration_ms };
  }

  // ========== Messages ==========

  /**
   * 批量保存 messages（upsert with UNIQUE constraint）
   * 同时更新 token_summary 表
   * tool 类型消息写入 admin_tool_calls，user/agent 写入 admin_messages
   */
  saveMessages(messages: AdminMessage[]): number {
    if (messages.length === 0) return 0;

    const contentMessages = messages.filter(m => m.message_type !== 'tool');
    const toolMessages = messages.filter(m => m.message_type === 'tool');

    const now = new Date().toISOString();
    let inserted = 0;

    // ---- content messages (user + agent) ----
    if (contentMessages.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO admin_messages (
          source_id, source_module, session_key, message_type, content,
          model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
          is_system_context, timestamp, created_at, source_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const newlyInsertedContent: boolean[] = [];

      const insertContent = this.db.transaction((rows: AdminMessage[]) => {
        for (const row of rows) {
          const result = stmt.run(
            row.source_id ?? null,
            row.source_module,
            row.session_key,
            row.message_type ?? null,
            row.content ?? null,
            row.model ?? null,
            row.tokens_input ?? null,
            row.tokens_output ?? null,
            row.cost_total ?? null,
            row.cost_input ?? null,
            row.cost_output ?? null,
            row.is_system_context ?? 0,
            row.timestamp,
            now,
            row.source_created_at ?? null
          );
          const isNew = result.changes > 0;
          newlyInsertedContent.push(isNew);
          if (isNew) inserted++;
        }
      });

      insertContent(contentMessages);

      // token 统计（仅对 content 消息）
      const sessionKeys = [...new Set(contentMessages.map(r => r.session_key))];
      const sessionAgentMap = this.getSessionAgentIds(sessionKeys);
      const tokenUpdates = new Map<string, {
        tokensInput: number;
        tokensOutput: number;
        costTotal: number;
        costInput: number;
        costOutput: number;
      }>();

      for (let i = 0; i < contentMessages.length; i++) {
        if (!newlyInsertedContent[i]) continue;
        const row = contentMessages[i];
        const agentId = sessionAgentMap.get(row.session_key);
        if (!agentId) continue;
        const hasTokenData =
          (row.tokens_input != null && row.tokens_input > 0) ||
          (row.tokens_output != null && row.tokens_output > 0) ||
          (row.cost_total != null && row.cost_total > 0);
        if (!hasTokenData) continue;
        const existing = tokenUpdates.get(agentId) || {
          tokensInput: 0, tokensOutput: 0, costTotal: 0, costInput: 0, costOutput: 0,
        };
        tokenUpdates.set(agentId, {
          tokensInput: existing.tokensInput + (row.tokens_input ?? 0),
          tokensOutput: existing.tokensOutput + (row.tokens_output ?? 0),
          costTotal: existing.costTotal + (row.cost_total ?? 0),
          costInput: existing.costInput + (row.cost_input ?? 0),
          costOutput: existing.costOutput + (row.cost_output ?? 0),
        });
      }

      if (tokenUpdates.size > 0) {
        const updates = Array.from(tokenUpdates.entries()).map(([agentId, data]) => ({ agentId, ...data }));
        try {
          this.batchUpdateTokenSummary(updates);
        } catch (error) {
          logger.error('[DataRepository] Failed to update token_summary:', { error: String(error) });
        }
      }
    }

    // ---- tool messages -> admin_tool_calls ----
    if (toolMessages.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO admin_tool_calls (
          source_id, source_module, session_key, message_type, content,
          created_at, model, tokens_input, tokens_output, cost_total, cost_input, cost_output, metadata,
          tool_name, tool_input
        ) VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `);

      const insertTool = this.db.transaction((rows: AdminMessage[]) => {
        for (const row of rows) {
          const result = stmt.run(
            row.source_id ?? '',
            row.source_module,
            row.session_key,
            row.content ?? null,
            row.timestamp, // 使用 timestamp 作为 created_at
            row.model ?? null,
            row.tokens_input ?? 0,
            row.tokens_output ?? 0,
            row.cost_total ?? null,
            row.cost_input ?? null,
            row.cost_output ?? null,
            (row as any).tool_name ?? null,
            (row as any).tool_input ?? null
          );
          if (result.changes > 0) inserted++;
        }
      });

      insertTool(toolMessages);
    }

    return inserted;
  }

  /**
   * 获取消息列表（合并 admin_messages + admin_tool_calls）
   * - 每页 LIMIT 条 content (user+agent)
   * - tool 消息按时间窗口附加在 content 之后
   * - total 只统计 content 总数（不含 tool）
   */
  getMessages(params: {
    session_key?: string;
    limit?: number;
    offset?: number;
  } = {}): { messages: AdminMessage[]; total: number } {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.session_key) {
      conditions.push('session_key = ?');
      values.push(params.session_key);
    }

    const sessionFilter = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 1. 从 admin_messages 取 content (user+agent)，按 timestamp DESC
    const contentSQL = `
      SELECT * FROM admin_messages ${sessionFilter}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;
    const contentRows = this.db.prepare(contentSQL).all(...values, limit, offset) as AdminMessage[];

    // 2. 计算时间窗口（用于取 tool 消息）
    if (contentRows.length === 0) {
      const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages ${sessionFilter}`).get(...values) as { total: number };
      return { messages: [], total: countRow.total };
    }
    const oldest = contentRows[contentRows.length - 1].timestamp;
    const newest = contentRows[0].timestamp;

    // 3. 从 admin_tool_calls 取时间窗口内的 tool（session_key 相同，时间在窗口内）
    const toolConditions = sessionFilter ? `${sessionFilter} AND` : 'WHERE';
    const toolSQL = `
      SELECT
        id,
        source_id,
        source_module,
        session_key,
        'tool' as message_type,
        content,
        model,
        tokens_input,
        tokens_output,
        cost_total,
        cost_input,
        cost_output,
        0 as is_system_context,
        created_at as timestamp,
        created_at,
        NULL as source_created_at
      FROM admin_tool_calls
      ${toolConditions} created_at BETWEEN ? AND ?
      ORDER BY created_at DESC
    `;
    const toolRows = this.db.prepare(toolSQL).all(...values, oldest, newest) as AdminMessage[];

    // 4. 合并并按 timestamp DESC 排序
    const merged = [...contentRows, ...toolRows].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 5. total = content 总数（不含 tool）
    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages ${sessionFilter}`).get(...values) as { total: number };

    return { messages: merged, total: countRow.total };
  }

  /**
   * 获取消息时间线（群聊风格）
   * - 合并 user/agent/tool 所有消息，按时间 DESC 排序
   * - 关联 agent 信息（name/avatar）
   * - 支持多维度过滤和数据治理
   * - 支持 cursor 分页（before）和增量轮询（since）
   *
   * @param params.limit 每页数量（默认50，最大200）
   * @param params.before cursor 时间戳，返回此时间之前的消息
   * @param params.since 时间戳，返回此时间之后的消息（增量轮询）
   * @param params.agent_ids 只查指定 agent 的消息
   * @param params.message_types 消息类型过滤（逗号分隔，默认 user,agent,tool）
   * @param params.search 内容关键词搜索
   * @param params.exclude_system_noise 过滤系统噪音
   * @param params.exclude_cron 过滤定时任务
   */
  getMessagesTimeline(params: {
    limit?: number;
    before?: string;
    since?: string;
    agent_ids?: string[];
    session_key?: string;
    message_types?: string;
    search?: string;
    exclude_system_noise?: boolean;
    exclude_cron?: boolean;
  } = {}): {
    messages: TimelineMessage[];
    has_more: boolean;
    pagination: { oldest: string | null; newest: string | null; total_in_range: number };
    meta: { agents_in_range: string[]; filter_applied: Record<string, unknown> };
  } {
    const limit = Math.min(params.limit ?? 50, 200);
    const messages: TimelineMessage[] = [];

    // Build conditions
    const contentConditions: string[] = ["m.message_type IN ('user', 'agent')"];
    const values: unknown[] = [];

    if (params.message_types) {
      const types = params.message_types.split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0 && types.length < 3) {
        contentConditions[0] = `m.message_type IN (${types.map(() => '?').join(', ')})`;
        values.push(...types);
      }
    }

    // 预解析 session_key（Gateway 格式 → SQLite 格式），供 content 和 tool 查询共享
    let resolvedSessionKeys: string[] | undefined;
    if (params.session_key) {
      resolvedSessionKeys = this.resolveSessionKey(params.session_key);
    }

    if (params.session_key && resolvedSessionKeys) {
      if (resolvedSessionKeys.length === 1) {
        contentConditions.push('m.session_key = ?');
        values.push(resolvedSessionKeys[0]);
      } else {
        const nonTrajectory = resolvedSessionKeys.filter(k => !k.endsWith('.trajectory'));
        const keys = nonTrajectory.length > 0 ? nonTrajectory : resolvedSessionKeys;
        contentConditions.push(`m.session_key IN (${keys.map(() => '?').join(', ')})`);
        values.push(...keys);
      }
    } else if (params.session_key) {
      // 未匹配到，用原始 key 尝试直接查询（返回空结果）
      contentConditions.push('m.session_key = ?');
      values.push(params.session_key);
    }

    if (params.before) {
      contentConditions.push('m.timestamp < ?');
      values.push(params.before);
    }

    if (params.since) {
      contentConditions.push('m.timestamp >= ?');
      values.push(params.since);
    }

    if (params.agent_ids && params.agent_ids.length > 0) {
      const agentPlaceholders = params.agent_ids.map(() => '?').join(', ');
      contentConditions.push(`s.agent_id IN (${agentPlaceholders})`);
      values.push(...params.agent_ids);
    }

    if (params.search) {
      contentConditions.push('m.content LIKE ?');
      // 转义 LIKE 通配符 % 和 _，避免搜索词被误解释为通配符
      const escaped = params.search.replace(/[%_]/g, (c) => c === '%' ? '\\%' : '\\_');
      values.push(`%${escaped}%`);
    }

    const contentWhereClause = `WHERE ${contentConditions.join(' AND ')}`;

    // Step 1: Query admin_messages for user+agent (limit+1 to detect has_more)
    const contentRows = this.db.prepare(`
      SELECT
        m.id,
        m.session_key,
        m.message_type,
        m.content,
        m.timestamp,
        m.model,
        COALESCE(s.agent_id, SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1, INSTR(SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1), ':') - 1)) as agent_id,
        COALESCE(a.agent_name, a2.agent_name) as agent_name,
        COALESCE(a.avatar, a2.avatar) as avatar
      FROM admin_messages m
      LEFT JOIN admin_sessions s ON m.session_key = s.session_key
      LEFT JOIN admin_agents a ON s.agent_id = a.agent_id
      LEFT JOIN admin_agents a2 ON a2.agent_id = COALESCE(s.agent_id, SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1, INSTR(SUBSTR(m.session_key, INSTR(m.session_key, ':') + 1), ':') - 1))
      ${contentWhereClause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...values, limit + 1) as Array<{
      id: number;
      session_key: string;
      message_type: string;
      content: string | null;
      timestamp: string;
      model: string | null;
      agent_id: string | null;
      agent_name: string | null;
      avatar: string | null;
    }>;

    const contentHasMore = contentRows.length > limit;
    if (contentHasMore) contentRows.pop();

    // Step 2: Determine time window from content rows
    let windowOldest: string | null = null;
    let windowNewest: string | null = null;
    if (contentRows.length > 0) {
      windowOldest = contentRows[contentRows.length - 1].timestamp;
      windowNewest = contentRows[0].timestamp;
    }

    // Step 3: Build tool-only conditions (message_type filter doesn't apply to tool table)
    const toolConditions: string[] = [];
    const toolValues: unknown[] = [];

    if (params.session_key && resolvedSessionKeys) {
      if (resolvedSessionKeys.length === 1) {
        toolConditions.push('t.session_key = ?');
        toolValues.push(resolvedSessionKeys[0]);
      } else {
        const nonTrajectory = resolvedSessionKeys.filter(k => !k.endsWith('.trajectory'));
        const keys = nonTrajectory.length > 0 ? nonTrajectory : resolvedSessionKeys;
        toolConditions.push(`t.session_key IN (${keys.map(() => '?').join(', ')})`);
        toolValues.push(...keys);
      }
    } else if (params.session_key) {
      toolConditions.push('t.session_key = ?');
      toolValues.push(params.session_key);
    }
    if (params.before) {
      toolConditions.push('t.created_at < ?');
      toolValues.push(params.before);
    }
    if (params.since) {
      toolConditions.push('t.created_at > ?');
      toolValues.push(params.since);
    }
    if (params.agent_ids && params.agent_ids.length > 0) {
      const agentPlaceholders = params.agent_ids.map(() => '?').join(', ');
      toolConditions.push(`s.agent_id IN (${agentPlaceholders})`);
      toolValues.push(...params.agent_ids);
    }
    if (params.search) {
      toolConditions.push('t.content LIKE ?');
      const escaped = params.search.replace(/[%_]/g, (c) => c === '%' ? '\\%' : '\\_');
      toolValues.push(`%${escaped}%`);
    }
    if (windowOldest && windowNewest) {
      toolConditions.push('t.created_at BETWEEN ? AND ?');
      toolValues.push(windowOldest, windowNewest);
    }

    const toolWhereClause = toolConditions.length > 0 ? `WHERE ${toolConditions.join(' AND ')}` : '';

    // Step 4: Query admin_tool_calls within time window
    let toolRows: Array<{
      id: number;
      session_key: string;
      message_type: string;
      content: string | null;
      timestamp: string;
      model: string | null;
      agent_id: string | null;
      agent_name: string | null;
      avatar: string | null;
    }> = [];

    if (toolWhereClause) {
      const toolSQL = `
        SELECT
          t.id,
          t.session_key,
          'tool' as message_type,
          t.content,
          t.created_at as timestamp,
          t.model,
          COALESCE(s.agent_id, SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1, INSTR(SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1), ':') - 1)) as agent_id,
          COALESCE(a.agent_name, a2.agent_name) as agent_name,
          COALESCE(a.avatar, a2.avatar) as avatar
        FROM admin_tool_calls t
        LEFT JOIN admin_sessions s ON t.session_key = s.session_key
        LEFT JOIN admin_agents a ON s.agent_id = a.agent_id
        LEFT JOIN admin_agents a2 ON a2.agent_id = COALESCE(s.agent_id, SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1, INSTR(SUBSTR(t.session_key, INSTR(t.session_key, ':') + 1), ':') - 1))
        ${toolWhereClause}
        ORDER BY t.created_at DESC
      `;
      toolRows = this.db.prepare(toolSQL).all(...toolValues) as typeof toolRows;
    }

    // Step 5: Merge content + tool rows and sort by timestamp DESC
    const mergedRows = [...contentRows, ...toolRows].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Step 6: has_more based on CONTENT rows only (not tool)
    const has_more = contentHasMore;

    // 统计范围内的 agent
    const agentSet = new Set<string>();
    // 总行数（content only，不含 tool）
    let totalInRange = 0;
    try {
      const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM admin_messages m LEFT JOIN admin_sessions s ON m.session_key = s.session_key ${contentWhereClause}`).get(...values) as { cnt: number };
      totalInRange = countRow.cnt;
    } catch { /* ignore */ }

    const seenContent = new Set<string>();

    for (const row of mergedRows) {
      // Apply message_types filter dynamically
      if (params.message_types) {
        const types = params.message_types.split(',').map(s => s.trim()).filter(Boolean);
        if (types.length > 0 && !types.includes(row.message_type)) continue;
      }
      // Determine agent_id
      let agentId = row.agent_id;
      if (!agentId && row.message_type === 'user') {
        const match = row.session_key.match(/^agent:([^:]+):/);
        agentId = match ? match[1] : null;
      }

      const agentName = row.agent_name || agentId || '未知';
      if (agentId) agentSet.add(agentId);

      // 分析消息元信息
      const meta = analyzeMessageMeta({
        message_type: row.message_type,
        content: row.content,
        agent_name: agentName,
      });

      // 应用噪音/定时任务过滤
      if (params.exclude_system_noise && meta.is_system_noise) continue;
      if (params.exclude_cron && meta.is_cron) continue;

      // 过滤空内容的 user 消息
      if (row.message_type === 'user' && !(row.content || '').trim()) {
        continue;
      }

      let content = row.content;
      if (row.message_type === 'tool') {
        const trimmed = (content || '').trim();
        if (!trimmed || trimmed === '{}' || trimmed === '[]' || trimmed === 'ok' || trimmed === 'null') {
          continue;
        }
        if (content && content.length > 200) {
          content = content.substring(0, 200);
        }
      }

      // Set 去重：同 session + 同 message_type + 同时间戳 + 同内容(前200字符) 只保留首次出现
      const contentHash = (row.content || '').substring(0, 200).replace(/\s+/g, ' ').trim();
      const dedupKey = `${row.session_key}|${row.message_type}|${row.timestamp}|${contentHash}`;
      if (seenContent.has(dedupKey)) continue;
      seenContent.add(dedupKey);

      messages.push({
        id: row.id,
        session_key: row.session_key,
        agent_id: agentId,
        agent_name: agentName,
        avatar: row.avatar,
        message_type: row.message_type as 'user' | 'agent' | 'tool',
        content,
        clean_content: meta.clean_content || null,
        content_summary: meta.content_summary || null,
        is_cron: meta.is_cron,
        is_system_noise: meta.is_system_noise,
        source_channel: meta.source_channel,
        model: row.model ?? null,
        timestamp: row.timestamp,
      });
    }

    const oldest = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
    const newest = messages.length > 0 ? messages[0].timestamp : null;

    const filterApplied: Record<string, unknown> = {};
    if (params.message_types) filterApplied.message_types = params.message_types;
    if (params.since) filterApplied.since = params.since;
    if (params.before) filterApplied.before = params.before;
    if (params.agent_ids) filterApplied.agent_ids = params.agent_ids;
    if (params.search) filterApplied.search = params.search;
    if (params.exclude_system_noise) filterApplied.exclude_system_noise = true;
    if (params.exclude_cron) filterApplied.exclude_cron = true;

    return {
      messages,
      has_more,
      pagination: {
        oldest,
        newest,
        total_in_range: totalInRange,
      },
      meta: {
        agents_in_range: Array.from(agentSet).sort(),
        filter_applied: filterApplied,
      },
    };
  }

  /**
   * 获取指定 agents 的最新 agent-type 消息内容
   * 用于 Overview 卡片展示每个 agent 的最新输出
   *
   * @param agentIds - 要查询的 agent ID 列表
   * @returns Map（agentId → 最新消息内容，没有则 null）
   */
  getLatestAgentMessages(agentIds: string[]): Map<string, string | null> {
    if (agentIds.length === 0) return new Map();

    // session_key 格式：agent:{agentId}:...，用 LIKE 匹配
    const conditions = agentIds.map(() => `session_key LIKE ?`).join(' OR ');
    const params = agentIds.map((id) => `agent:${id}:%`);

    // 过滤掉无意义的内部信号内容
    const rows = this.db.prepare(`
      SELECT m.content, m.session_key
      FROM admin_messages m
      WHERE (${conditions})
        AND m.message_type = 'agent'
        AND LENGTH(COALESCE(m.content, '')) > 0
        AND m.content NOT IN ('NO_REPLY', 'HEARTBEAT_OK')
        AND m.content NOT LIKE '[non-text content:%'
        AND m.content NOT LIKE '[[reply_to:%'
      ORDER BY m.timestamp DESC
    `).all(...params) as Array<{ content: string | null; session_key: string }>;

    // 按 agent 分组，每组只取第一条（最新）
    const result = new Map<string, string | null>();
    for (const row of rows) {
      // 从 session_key 提取 agent_id：agent:{agentId}:...
      const match = row.session_key.match(/^agent:([^:]+):/);
      if (!match) continue;
      const agentId = match[1];
      if (result.has(agentId)) continue; // 已记录过，跳过
      result.set(agentId, row.content);
    }

    // 没有消息的 agent 补 null
    for (const id of agentIds) {
      if (!result.has(id)) result.set(id, null);
    }
    return result;
  }

  // ========== Agents ==========

  /**
   * 更新 agents 表（仅同步 openclaw.json 中定义的 agent）
   * - 只同步 collectorAgents 中存在的 agent（来自 openclaw.json）
   * - 幽灵 agent（仅出现在消息中但不在配置中）会被忽略
   * - sessions 聚合数据仅用于补充配置的 agent 的统计信息
   * - source 字段由 Admin 根据 module_key 统一设置
   *
   * @param collectorAgents - 从 Collector API 获取的 agent 配置列表（来自 openclaw.json）
   * @param sourceModule - 模块标识，用于设置 source 字段（如 collector 注册时的 module_key）
   */
  refreshAgents(collectorAgents: CollectorAgent[], sourceModule: string = 'unknown'): void {
    if (collectorAgents.length === 0) {
      logger.info('[DataRepository] No collector agents to refresh');
      return;
    }

    // 1. 构建 collector agent 映射 (agent_id -> CollectorAgent)
    const collectorAgentMap = new Map<string, CollectorAgent>();
    for (const agent of collectorAgents) {
      collectorAgentMap.set(agent.agent_id, agent);
    }

    // 2. 获取每个 agent 的 model（从最新一条 agent 消息）
    const agentModels = this.loadAgentModelsFromMessages();

    // 3. 从 sessions 聚合数据（仅针对配置的 agent）
    const configuredAgentIds = collectorAgents.map(a => a.agent_id);
    const placeholders = configuredAgentIds.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT
        agent_id,
        COUNT(DISTINCT session_key) as session_count,
        SUM(message_count) as message_count,
        MIN(first_message_at) as first_active_at,
        MAX(last_message_at) as last_active_at
      FROM admin_sessions
      WHERE agent_id IN (${placeholders})
        AND session_key NOT LIKE '%checkpoint%'
      GROUP BY agent_id
    `).all(...configuredAgentIds) as Array<{
      agent_id: string;
      session_count: number;
      message_count: number;
      first_active_at: string | null;
      last_active_at: string | null;
    }>;

    // 构建 session 统计映射
    const sessionStatsMap = new Map<string, {
      session_count: number;
      message_count: number;
      first_active_at: string | null;
      last_active_at: string | null;
    }>();
    for (const row of rows) {
      sessionStatsMap.set(row.agent_id, row);
    }

    // 4. Upsert 每个配置的 agent
    // 注意：avatar 由用户通过 PUT /api/agents/:id/avatar 手动设置，
    // 同步时不应覆盖。ON CONFLICT UPDATE 时显式保留已有 avatar，
    // INSERT 时 avatar 默认为 NULL（SQLite TEXT 列默认值）。
    const upsert = this.db.prepare(`
      INSERT INTO admin_agents (agent_id, agent_name, workspace, session_count, message_count, first_active_at, last_active_at, model, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id) DO UPDATE SET
        agent_name = excluded.agent_name,
        workspace = excluded.workspace,
        session_count = excluded.session_count,
        message_count = excluded.message_count,
        first_active_at = excluded.first_active_at,
        last_active_at = excluded.last_active_at,
        model = excluded.model,
        source = excluded.source,
        updated_at = excluded.updated_at,
        avatar = admin_agents.avatar
    `);

    try {
      const upsertAll = this.db.transaction(() => {
        for (const agent of collectorAgents) {
          const stats = sessionStatsMap.get(agent.agent_id);
          const model = agentModels.get(agent.agent_id) ?? null;

          upsert.run(
            agent.agent_id,
            agent.agent_name || agent.agent_id,
            agent.workspace ?? null,
            stats?.session_count ?? 0,
            stats?.message_count ?? 0,
            stats?.first_active_at ?? null,
            stats?.last_active_at ?? null,
            model,
            sourceModule
          );
        }
      });

      upsertAll();
      logger.info(`[DataRepository] Refreshed ${collectorAgents.length} configured agents`);
    } catch (error) {
      logger.error('[DataRepository] refreshAgents failed:', { error: String(error) });
      throw new Error(`Failed to refresh agents: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 从 admin_messages 聚合每个 agent 的最新 model
   */
  private loadAgentModelsFromMessages(): Map<string, string> {
    const map = new Map<string, string>();

    try {
      // 通过 session_key 关联 admin_sessions 获取 agent_id
      // 然后取每个 agent 最新一条 agent 消息的 model
      const rows = this.db.prepare(`
        SELECT s.agent_id, m.model
        FROM admin_messages m
        INNER JOIN admin_sessions s ON m.session_key = s.session_key
        INNER JOIN (
          SELECT s.agent_id, MAX(m.timestamp) as max_ts
          FROM admin_messages m
          INNER JOIN admin_sessions s ON m.session_key = s.session_key
          WHERE m.message_type = 'agent'
            AND m.model IS NOT NULL AND m.model != ''
            AND s.agent_id IS NOT NULL
            AND s.session_key NOT LIKE '%checkpoint%'
          GROUP BY s.agent_id
        ) latest ON s.agent_id = latest.agent_id AND m.timestamp = latest.max_ts
        WHERE s.agent_id IS NOT NULL
          AND s.session_key NOT LIKE '%checkpoint%'
      `).all() as Array<{ agent_id: string; model: string }>;

      for (const row of rows) {
        map.set(row.agent_id, row.model);
      }

      logger.info(`[DataRepository] Loaded ${map.size} agent models from messages`);
    } catch (error) {
      logger.warn('[DataRepository] Failed to load agent models from messages:', { error: String(error) });
    }

    return map;
  }

  /**
   * 获取所有 agent 的 name/avatar 映射
   */
  getAgentsMap(): Map<string, { agent_name: string | null; avatar: string | null }> {
    const rows = this.db.prepare('SELECT agent_id, agent_name, avatar FROM admin_agents').all() as Array<{
      agent_id: string;
      agent_name: string | null;
      avatar: string | null;
    }>;
    const map = new Map<string, { agent_name: string | null; avatar: string | null }>();
    for (const row of rows) {
      map.set(row.agent_id, { agent_name: row.agent_name, avatar: row.avatar });
    }
    return map;
  }

  /**
   * 获取每个 session 的最后一条消息和消息总数
   * 按 session_key 索引，确保不同会话各自独立统计
   */
  getSessionLastMessageMap(): Map<string, { last_message: string | null; message_count: number }> {
    const rows = this.db.prepare(`
      SELECT
        s.session_key,
        substr(m.content, 1, 80) as last_message,
        s.message_count
      FROM admin_sessions s
      INNER JOIN admin_messages m ON m.session_key = s.session_key
        AND m.timestamp = s.last_message_at
      WHERE s.session_key IS NOT NULL
      GROUP BY s.session_key
    `).all() as Array<{
      session_key: string;
      last_message: string | null;
      message_count: number;
    }>;
    const map = new Map<string, { last_message: string | null; message_count: number }>();
    for (const row of rows) {
      map.set(row.session_key, {
        last_message: row.last_message,
        message_count: row.message_count,
      });
    }
    return map;
  }

  /**
   * 获取每个 session 的第一条用户消息内容
   * 按 session_key 索引
   */
  getSessionFirstMessageMap(): Map<string, { first_message: string | null }> {
    const rows = this.db.prepare(`
      SELECT
        s.session_key,
        (
          SELECT substr(fm.content, 1, 120)
          FROM admin_messages fm
          WHERE fm.session_key = s.session_key
            AND fm.message_type = 'user'
          ORDER BY fm.timestamp ASC
          LIMIT 1
        ) as first_message
      FROM admin_sessions s
      WHERE s.session_key IS NOT NULL
      GROUP BY s.session_key
    `).all() as Array<{
      session_key: string;
      first_message: string | null;
    }>;
    const map = new Map<string, { first_message: string | null }>();
    for (const row of rows) {
      map.set(row.session_key, { first_message: row.first_message });
    }
    return map;
  }

  /** @deprecated Use getSessionLastMessageMap instead */
  getAgentLastMessageMap(): Map<string, { last_message: string | null; message_count: number }> {
    const map = this.getSessionLastMessageMap();
    // 兼容旧接口：返回按 agent_id 索引的 map（取该 agent 最后一个 session）
    const result = new Map<string, { last_message: string | null; message_count: number }>();
    for (const [sessionKey, data] of map) {
      const parts = sessionKey.split(':');
      const agentId = parts.length >= 2 ? parts[1] : '';
      if (agentId && !result.has(agentId)) {
        result.set(agentId, data);
      }
    }
    return result;
  }

  /**
   * 获取 agents 列表
   */
  getAgents(): AdminAgent[] {
    return this.db.prepare(
      "SELECT * FROM admin_agents ORDER BY last_active_at DESC"
    ).all() as AdminAgent[];
  }

  /**
   * 获取指定 agent 的头像
   */
  getAgentAvatar(agentId: string): string | null {
    const row = this.db.prepare(
      'SELECT avatar FROM admin_agents WHERE agent_id = ?'
    ).get(agentId) as { avatar: string | null } | undefined;
    return row?.avatar ?? null;
  }

  /**
   * 更新指定 agent 的头像
   */
  updateAgentAvatar(agentId: string, avatar: string | null): void {
    this.db.prepare(
      'UPDATE admin_agents SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?'
    ).run(avatar, agentId);
  }

  /**
   * 获取子 agent 任务列表（spawn_depth > 0 的 session）
   */
  getSubagentTasks(params: {
    limit?: number;
    offset?: number;
    agent_id?: string;
    status?: string;
  } = {}): { tasks: Array<Pick<AdminSession, 'session_key' | 'label' | 'agent_id' | 'session_status' | 'spawned_by' | 'spawn_depth' | 'created_at' | 'last_message_at' | 'first_message_at' | 'message_count'>>; total: number } {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions: string[] = ['spawn_depth IS NOT NULL AND spawn_depth > 0'];
    const values: unknown[] = [];

    if (params.agent_id) {
      conditions.push('agent_id = ?');
      values.push(params.agent_id);
    }
    if (params.status) {
      conditions.push('session_status = ?');
      values.push(params.status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_sessions ${whereClause}`).get(...values) as { total: number };

    const rows = this.db.prepare(`
      SELECT session_key, label, agent_id, session_status, spawned_by, spawn_depth,
             created_at, last_message_at, first_message_at, message_count
      FROM admin_sessions ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Array<Pick<AdminSession, 'session_key' | 'label' | 'agent_id' | 'session_status' | 'spawned_by' | 'spawn_depth' | 'created_at' | 'last_message_at' | 'first_message_at' | 'message_count'>>;

    return { tasks: rows, total: countRow.total };
  }

  /**
   * 获取按 agent 分组的 sessions（用于 Desktop 下拉列表）
   * @param limitPerAgent 每个 agent 最多返回的 session 数量
   */
  getGroupedSessions(limitPerAgent: number = 5, offset: number = 0): { agentId: string; totalCount: number; sessions: AdminSession[] }[] {
    // 使用 window function 实现分组后分页：每个 agent 内按 last_message_at DESC 编号，然后取前 limitPerAgent 条
    const allSessions = this.db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY agent_id
          ORDER BY last_message_at DESC
        ) AS rn,
        COUNT(*) OVER (PARTITION BY agent_id) AS total_in_group
        FROM admin_sessions
      ) ranked
      WHERE rn <= ? AND agent_id IS NOT NULL
      ORDER BY last_message_at DESC
      LIMIT ? OFFSET ?
    `).all(limitPerAgent, limitPerAgent, offset) as Array<AdminSession & { rn: number; total_in_group: number }>;

    // 按 agent_id 分组（agent_id 已在 SQL 中排除 null）
    const groups: Record<string, { totalCount: number; sessions: AdminSession[] }> = {};
    const agentIdMap = new Map<object, string>(); // 修复: 不依赖 Object.keys 遍历顺序
    for (const row of allSessions) {
      const agentId = row.agent_id as string; // 已保证非 null
      if (!groups[agentId]) {
        groups[agentId] = { totalCount: row.total_in_group, sessions: [] };
      }
      groups[agentId].sessions.push(row);
      agentIdMap.set(groups[agentId], agentId);
    }

    return Object.values(groups).map(g => ({
      agentId: agentIdMap.get(g) ?? '',
      totalCount: g.totalCount,
      sessions: g.sessions,
    })).sort((a, b) => {
      const aLatest = a.sessions[0]?.last_message_at ?? '';
      const bLatest = b.sessions[0]?.last_message_at ?? '';
      return bLatest.localeCompare(aLatest);
    });
  }

  // ========== Sync Progress ==========

  /**
   * 获取同步进度
   */
  getSyncProgress(tableName: string): SyncProgress | null {
    const row = this.db.prepare('SELECT * FROM sync_progress WHERE table_name = ?').get(tableName) as SyncProgress | undefined;
    return row ?? null;
  }

  /**
   * 更新同步进度
   */
  updateSyncProgress(tableName: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_progress (table_name, last_sync_time, updated_at)
      VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(table_name) DO UPDATE SET
        last_sync_time = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(tableName);
  }

  // ========== Agent Activity (Heatmap) ==========

  /**
   * 更新单日 agent 活动计数（增量）
   */
  updateAgentActivity(agentId: string, date: string, delta: number = 1): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        message_count = message_count + excluded.message_count
    `);
    stmt.run(agentId, date, delta);
  }

  /**
   * 批量获取 session_key → agent_id 映射
   * @param sessionKeys - session key 列表
   * @returns Map<sessionKey, agentId>
   */
  getSessionAgentIds(sessionKeys: string[]): Map<string, string> {
    if (sessionKeys.length === 0) return new Map();

    const placeholders = sessionKeys.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT session_key, agent_id
      FROM admin_sessions
      WHERE session_key IN (${placeholders})
        AND agent_id IS NOT NULL
    `).all(...sessionKeys) as { session_key: string; agent_id: string }[];

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.session_key, row.agent_id);
    }
    return map;
  }

  /**
   * 批量更新 agent 活动计数（用于批量同步）
   * @param records - 活动记录数组 [{agentId, date, count}]
   * 策略：先删除旧记录，再插入新记录（保证幂等性）
   * 配合 DataSync 的全量聚合，确保每次同步结果一致
   */
  upsertAgentActivityBatch(records: { agentId: string; date: string; count: number }[]): void {
    if (records.length === 0) return;

    // 使用增量更新：每次同步只处理新消息，所以用 message_count + excluded.message_count
    // 避免同名日期在多次同步中互相覆盖
    const upsertStmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        message_count = message_count + excluded.message_count
    `);

    const upsertMany = this.db.transaction((rows: typeof records) => {
      for (const row of rows) {
        upsertStmt.run(row.agentId, row.date, row.count);
      }
    });

    upsertMany(records);
    logger.info(`[DataRepository] Upserted ${records.length} activity records`);
  }

  /**
   * 从 admin_messages 全量重建 agent_activity_daily 表
   * 先清空表，再从所有消息按 (agent_id, date) 重新聚合
   * @returns 重建的记录数和错误信息
   */
  rebuildAgentActivity(): { count: number; error?: string } {
    try {
      const rebuildMany = this.db.transaction(() => {
        // 清空现有数据
        this.db.exec('DELETE FROM agent_activity_daily');

        // 从 admin_messages 聚合，需要通过 session_key 关联 admin_sessions 获取 agent_id
        const insertStmt = this.db.prepare(`
          INSERT INTO agent_activity_daily (agent_id, date, message_count)
          VALUES (?, ?, ?)
        `);

        const rows = this.db.prepare(`
          SELECT
            COALESCE(s.agent_id, 'unknown') as agent_id,
            substr(m.timestamp, 1, 10) as date,
            COUNT(*) as message_count
          FROM admin_messages m
          LEFT JOIN admin_sessions s ON m.session_key = s.session_key
          GROUP BY agent_id, date
          ORDER BY date ASC
        `).all() as { agent_id: string; date: string; message_count: number }[];

        let count = 0;
        for (const row of rows) {
          insertStmt.run(row.agent_id, row.date, row.message_count);
          count++;
        }
        return count;
      });

      const count = rebuildMany();
      logger.info(`[DataRepository] Rebuilt agent_activity_daily: ${count} records`);
      return { count };
    } catch (error: any) {
      logger.error('[DataRepository] rebuildAgentActivity failed:', error);
      return { count: 0, error: error.message };
    }
  }

  /**
   * 获取指定 agent 的活动数据（最近 N 天）
   * @param agentId - agent ID
   * @param days - 查询天数（默认 90 天）
   * @returns 每日活动计数数组 [{date, count}]
   */
  getAgentActivity(agentId: string, days: number = 90): { date: string; count: number }[] {
    const rows = this.db.prepare(`
      SELECT date, message_count as count
      FROM agent_activity_daily
      WHERE agent_id = ?
        AND date >= date('now', ?)
      ORDER BY date ASC
    `).all(agentId, `-${days} days`) as { date: string; count: number }[];

    return rows;
  }

  /**
   * 批量获取所有 agent 的活动数据（最近 N 天）
   * @param days - 查询天数（默认 90 天）
   * @returns 各 agent 及其活动热力图数组 [AdminAgent & {activity: [{date, count}]}]
   * 一次查询返回所有数据，避免 N+1 问题
   */
  getAgentsWithActivity(days: number = 90): (AdminAgent & { activity: { date: string; count: number }[] })[] {
    const agents = this.getAgents();

    // 一次查询所有 agent 的 activity 数据
    const rows = this.db.prepare(`
      SELECT agent_id, date, message_count as count
      FROM agent_activity_daily
      WHERE date >= date('now', ?)
      ORDER BY agent_id, date ASC
    `).all(`-${days} days`) as { agent_id: string; date: string; count: number }[];

    // 按 agent_id 分组
    const activityByAgent: Record<string, { date: string; count: number }[]> = {};
    for (const row of rows) {
      if (!activityByAgent[row.agent_id]) {
        activityByAgent[row.agent_id] = [];
      }
      activityByAgent[row.agent_id].push({ date: row.date, count: row.count });
    }

    // 合并到 agent 对象
    return agents.map(agent => ({
      ...agent,
      activity: activityByAgent[agent.agent_id] || []
    }));
  }

  // ========== Stats Computation (from admin_messages) ==========

  /**
   * 增量更新 session 统计（仅对本次同步涉及的 session keys）
   * 避免全表扫描，提升同步性能
   * @param sessionKeys 本次同步涉及的 session key 列表
   * @returns 更新涉及的 session 数量
   */
  computeSessionStatsIncremental(sessionKeys: string[]): number {
    if (sessionKeys.length === 0) return 0;

    let updated = 0;

    const updateStmt = this.db.prepare(`
      UPDATE admin_sessions
      SET message_count = ?, first_message_at = ?, last_message_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_key = ?
        AND (message_count != ? OR last_message_at != ? OR first_message_at IS NULL)
    `);

    const updateMany = this.db.transaction(() => {
      for (const sessionKey of sessionKeys) {
        const row = this.db.prepare(`
          SELECT
            COUNT(*) as message_count,
            MIN(timestamp) as first_message_at,
            MAX(timestamp) as last_message_at
          FROM admin_messages
          WHERE session_key = ?
        `).get(sessionKey) as { message_count: number; first_message_at: string | null; last_message_at: string | null } | undefined;

        if (!row) continue;
        const result = updateStmt.run(row.message_count, row.first_message_at, row.last_message_at, sessionKey, row.message_count, row.last_message_at);
        if (result.changes > 0) updated++;
      }
    });

    updateMany();
    return updated;
  }

  /**
   * 增量更新 agent 统计（仅对本次同步涉及的 agents）
   * 避免全表扫描，提升同步性能
   * @param agentIds 本次同步涉及的 agent id 列表
   * @returns 更新涉及的 agent 数量
   */
  computeAgentStatsIncremental(agentIds: string[]): number {
    if (agentIds.length === 0) return 0;

    let updated = 0;

    const updateStmt = this.db.prepare(`
      UPDATE admin_agents
      SET session_count = ?, message_count = ?, first_active_at = ?, last_active_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
        AND (session_count != ? OR message_count != ? OR first_active_at != ? OR last_active_at != ? OR first_active_at IS NULL)
    `);

    const updateMany = this.db.transaction(() => {
      for (const agentId of agentIds) {
        const row = this.db.prepare(`
          SELECT
            COUNT(DISTINCT m.session_key) as session_count,
            COUNT(*) as message_count,
            MIN(m.timestamp) as first_active_at,
            MAX(m.timestamp) as last_active_at
          FROM admin_messages m
          INNER JOIN admin_sessions s ON m.session_key = s.session_key
          WHERE s.agent_id = ?
            AND m.session_key NOT LIKE '%checkpoint%'
        `).get(agentId) as { session_count: number; message_count: number; first_active_at: string | null; last_active_at: string | null } | undefined;

        if (!row) continue;
        const result = updateStmt.run(
          row.session_count, row.message_count, row.first_active_at, row.last_active_at,
          agentId,
          row.session_count, row.message_count, row.first_active_at, row.last_active_at
        );
        if (result.changes > 0) updated++;
      }
    });

    updateMany();
    return updated;
  }

  // ========== Model Events ==========

  /**
   * 批量保存 model events（INSERT OR IGNORE 基于 event_id 去重）
   */
  saveModelEvents(events: Array<{
    session_key: string;
    event_type: string;
    event_id: string | null;
    data_json: string;
    timestamp: string;
  }>): number {
    if (events.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO admin_model_events (
        session_key, event_type, event_id, data_json, timestamp
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((rows: typeof events) => {
      for (const row of rows) {
        stmt.run(row.session_key, row.event_type, row.event_id, row.data_json, row.timestamp);
      }
    });

    insertMany(events);
    // 无法精确获知 INSERT OR IGNORE 跳过了多少，返回总数
    return events.length;
  }

  // ========== Stats ==========

  /**
   * 获取数据统计
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    todayMessageCount: number;
    lastSyncTime: string | null;
  } {
    const sessionRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_sessions').get() as { count: number };
    const messageRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_messages').get() as { count: number };
    const agentRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_agents').get() as { count: number };
    const todayRow = this.db.prepare("SELECT COUNT(*) as count FROM admin_messages WHERE date(timestamp) = date('now')").get() as { count: number };
    const syncRow = this.db.prepare("SELECT MAX(last_sync_time) as time FROM sync_progress").get() as { time: string | null };

    return {
      sessionCount: sessionRow.count,
      messageCount: messageRow.count,
      agentCount: agentRow.count,
      todayMessageCount: todayRow.count,
      lastSyncTime: syncRow.time
    };
  }

  /**
   * 获取系统状态统计（用于 timeline meta）
   * 3 条轻量查询：今日噪音过滤数、最近内存整理时间、最近上下文刷新时间
   *
   * 注意：is_system_noise 是 analyzeMessageMeta() 的运行时计算结果，非存储字段。
   * 此处用内容模式匹配近似复刻其判断逻辑（message_type='user' 的噪音消息）。
   */
  getSystemStatus(): { todayFiltered: number; lastCompaction: string | null; lastMemoryFlush: string | null; todayRetryCount: number; todayModelChangeCount: number } {
    const db = this.db;
    const today = new Date().toISOString().slice(0, 10);

    // 近似 is_system_noise 的 SQL 判断：message_type='user' 且匹配各类噪音内容模式
    const filtered = db.prepare(`
      SELECT COUNT(*) as c FROM admin_messages
      WHERE message_type = 'user'
        AND date(timestamp) = date(?)
        AND (
          content = 'HEARTBEAT_OK' OR content = 'NO_REPLY'
          OR content GLOB '[cron:*'
          OR (content GLOB 'System*' AND length(content) > 10 AND content NOT GLOB '*ocrates*')
          OR content GLOB 'Read HEARTBEAT.md*'
          OR content GLOB 'Exec completed*' OR content GLOB 'Exec failed*'
          OR content GLOB '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>*'
          OR content GLOB 'Pre-compaction memory flush*'
          OR content GLOB 'An async command completion event was triggered*'
          OR (content GLOB '[*' AND length(content) < 200 AND (
            content GLOB '*added * files?*' OR content GLOB '*modules transformed*' OR content GLOB '*built in*'
            OR content GLOB 'feat(*' OR content GLOB 'fix(*' OR content GLOB 'style(*'
            OR content GLOB 'refactor(*' OR content GLOB 'chore(*' OR content GLOB 'docs(*' OR content GLOB 'test(*'
          ))
        )
    `).get(today) as { c: number };

    const compaction = db.prepare(
      `SELECT MAX(timestamp) as t FROM admin_messages WHERE content LIKE ?`
    ).get('Pre-compaction memory flush%') as { t: string | null };

    let lastMemoryFlush: string | null = null;
    try {
      const memoryPath = path.join(os.homedir(), '.openclaw/workspace/MEMORY.md');
      const stat = fs.statSync(memoryPath);
      lastMemoryFlush = stat.mtime.toISOString();
    } catch {}

    // 今日 Retry 消息数
    const retryCount = db.prepare(`
      SELECT COUNT(*) as c FROM admin_messages
      WHERE date(timestamp) = date(?)
        AND content LIKE '[Retry%'
        AND message_type = 'user'
    `).get(today) as { c: number };

    // 今日 model_change 事件数
    const modelChangeCount = db.prepare(`
      SELECT COUNT(*) as c FROM admin_model_events
      WHERE date(timestamp) = date(?)
        AND event_type = 'model_change'
    `).get(today) as { c: number };

    return {
      todayFiltered: filtered.c || 0,
      lastCompaction: compaction.t || null,
      lastMemoryFlush,
      todayRetryCount: retryCount.c || 0,
      todayModelChangeCount: modelChangeCount.c || 0,
    };
  }

  // ========== Data Rebuild ==========

  /**
   * 重建会话消息计数
   * 
   * 问题：由于 collector 的 batchInsertMessages 使用 INSERT OR IGNORE，
   * 重复消息被忽略但 message_count 仍按 batch 总量累加，导致统计数据虚高。
   * 
   * 本方法按 admin_messages 实际行数重算所有 session 的 message_count，
   * 并重建 admin_agents 汇总统计。
   * 
   * @returns 重算影响的 session 数量
   */
  rebuildSessionMessageCounts(): number {
    logger.info('[DataRepository] Starting session message count rebuild...');

    // Step 1: 按实际消息数重算所有 session 的 message_count
    const updateSessionCounts = this.db.prepare(`
      UPDATE admin_sessions s
      SET 
        message_count = (
          SELECT COUNT(*) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        ),
        first_message_at = (
          SELECT MIN(m.timestamp) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        ),
        last_message_at = (
          SELECT MAX(m.timestamp) 
          FROM admin_messages m 
          WHERE m.session_key = s.session_key
        )
      WHERE EXISTS (
        SELECT 1 FROM admin_messages m 
        WHERE m.session_key = s.session_key
      )
    `);

    const sessionResult = updateSessionCounts.run();
    logger.info(`[DataRepository] Recomputed message_count for ${sessionResult.changes} sessions`);

    // Step 2: 重算所有 agent 的汇总统计
    const updateAgentStats = this.db.prepare(`
      UPDATE admin_agents aa
      SET 
        message_count = (
          SELECT COALESCE(SUM(message_count), 0) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
        ),
        session_count = (
          SELECT COUNT(DISTINCT session_key) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
        ),
        first_active_at = (
          SELECT MIN(first_message_at) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
            AND first_message_at IS NOT NULL
        ),
        last_active_at = (
          SELECT MAX(last_message_at) 
          FROM admin_sessions 
          WHERE agent_id = aa.agent_id
            AND session_key NOT LIKE '%checkpoint%'
            AND last_message_at IS NOT NULL
        ),
        updated_at = CURRENT_TIMESTAMP
    `);

    const agentResult = updateAgentStats.run();
    logger.info(`[DataRepository] Recomputed agent stats for ${agentResult.changes} agents`);

    return sessionResult.changes;
  }

  // ========== Data Archival (30-day retention) ==========

  // ========== Data Archival (30-day retention) ==========

  /**
   * 归档超过指定天数的 tool_call 消息（7天独立保留策略）
   * 幂等：只归档尚未归档的数据
   * @param daysToKeep 保留天数，默认 7
   * @returns 归档的消息数量
   */
  archiveOldToolCalls(daysToKeep: number = 7): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffISO = cutoffDate.toISOString();

    logger.info(`[DataRepository] Archiving tool_calls older than ${cutoffISO}`);

    let archivedCount = 0;
    this.db.transaction(() => {
      const deleted = this.db.prepare(
        `DELETE FROM admin_tool_calls WHERE created_at < ?`
      ).run(cutoffISO);
      archivedCount = deleted.changes;
    })();

    logger.info(`[DataRepository] Archived ${archivedCount} tool_calls`);
    return archivedCount;
  }

  /**
   * 归档超过指定天数的消息到 archive 表
   * 幂等：只归档尚未归档的数据
   * @param daysToKeep 保留天数，默认 30
   * @returns 归档的消息数量
   */
  archiveOldMessages(daysToKeep: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffISO = cutoffDate.toISOString();

    logger.info(`[DataRepository] Archiving messages older than ${cutoffISO}`);

    const archive = this.db.transaction(() => {
      // 1. 查找需要归档的消息（仅主表数据，不在 archive 中）
      const toArchive = this.db.prepare(`
        SELECT * FROM admin_messages
        WHERE timestamp < ?
          AND id NOT IN (SELECT source_id FROM admin_messages_archive WHERE source_id IS NOT NULL)
      `).all(cutoffISO) as AdminMessage[];

      if (toArchive.length === 0) {
        logger.info('[DataRepository] No messages to archive');
        return 0;
      }

      logger.info(`[DataRepository] Found ${toArchive.length} messages to archive`);

      // 2. 插入到 archive 表
      const insertArchive = this.db.prepare(`
        INSERT OR IGNORE INTO admin_messages_archive (
          source_id, source_module, session_key, message_type, content,
          model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
          is_system_context, timestamp, created_at, source_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const msg of toArchive) {
        insertArchive.run(
          msg.source_id ?? null,
          msg.source_module,
          msg.session_key,
          msg.message_type ?? null,
          msg.content ?? null,
          msg.model ?? null,
          msg.tokens_input ?? null,
          msg.tokens_output ?? null,
          msg.cost_total ?? null,
          msg.cost_input ?? null,
          msg.cost_output ?? null,
          msg.is_system_context ?? 0,
          msg.timestamp,
          msg.created_at,
          msg.source_created_at ?? null
        );
      }

      // 3. 从主表删除已归档的消息
      const sourceIds = toArchive.map(m => m.id).filter(id => id !== undefined);
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',');
        const deleted = this.db.prepare(
          `DELETE FROM admin_messages WHERE id IN (${placeholders})`
        ).run(...sourceIds);
        logger.info(`[DataRepository] Deleted ${deleted.changes} messages from main table`);
      }

      // 4. 可选 VACUUM（由调用方控制频率）
      return toArchive.length;
    });

    const count = archive();
    logger.info(`[DataRepository] Archived ${count} messages`);
    return count;
  }

  /**
   * 执行数据库 VACUUM（清理归档后的碎片空间）
   * 建议在归档后调用，但不要太频繁
   */
  vacuumIfNeeded(): void {
    try {
      this.db.exec('VACUUM');
      logger.info('[DataRepository] VACUUM completed after archival');
    } catch (error) {
      logger.warn('[DataRepository] VACUUM failed:', { error: String(error) });
    }
  }

  /**
   * 获取已归档消息（支持与主表统一查询接口）
   */
  getArchivedMessages(params: {
    session_key?: string;
    limit?: number;
    offset?: number;
  } = {}): { messages: AdminMessage[]; total: number } {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.session_key) {
      conditions.push('session_key = ?');
      values.push(params.session_key);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages_archive ${whereClause}`).get(...values) as { total: number };

    const rows = this.db.prepare(`
      SELECT * FROM admin_messages_archive ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as AdminMessage[];

    return { messages: rows, total: countRow.total };
  }

  /**
   * 启动每日归档定时器（每天凌晨 3 点）
   * admin_messages: 30天保留；admin_tool_calls: 7天保留（独立调度）
   * @param daysToKeep admin_messages 保留天数，默认 30
   * @param onComplete 归档完成回调
   * @returns interval timer id
   */
  startArchiveScheduler(daysToKeep: number = 30, onComplete?: (count: number) => void): NodeJS.Timeout {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const runArchive = () => {
      try {
        // 归档 admin_messages（30天）
        const count = this.archiveOldMessages(daysToKeep);
        if (count > 0) this.vacuumIfNeeded();
        onComplete?.(count);

        // 归档 admin_tool_calls（7天，独立策略）
        try {
          const toolCount = this.archiveOldToolCalls(7);
          if (toolCount > 0) {
            logger.info(`[DataRepository] Tool calls archive: ${toolCount} cleaned up`);
          }
        } catch (toolErr) {
          logger.error('[DataRepository] Scheduled tool_calls archive failed:', { error: String(toolErr) });
        }
      } catch (error) {
        logger.error('[DataRepository] Scheduled archive failed:', { error: String(error) });
      }
    };

    // 计算到次日凌晨 3 点的毫秒数
    const now = new Date();
    const next3AM = new Date(now);
    next3AM.setHours(3, 0, 0, 0);
    if (next3AM <= now) next3AM.setDate(next3AM.getDate() + 1);
    const initialDelay = next3AM.getTime() - now.getTime();

    logger.info(`[DataRepository] Archive scheduler will first run at ${next3AM.toISOString()} (in ${Math.round(initialDelay / 1000 / 60)}min), then every 24h`);

    // 先执行一次（延迟后），之后每 24 小时执行
    setTimeout(() => {
      runArchive();
      setInterval(runArchive, MS_PER_DAY);
    }, initialDelay);

    // 返回值仅用于兼容，实际清理由进程退出时自然结束
    return setTimeout(() => {}, 0);
  }

  deduplicateAdminMessages(): number {
    const dedup = this.db.transaction(() => {
      this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS _dedup_keep AS
        SELECT MIN(id) as keep_id FROM admin_messages
        GROUP BY session_key, message_type, timestamp, substr(content, 1, 200)`);
      const { total } = this.db.prepare('SELECT COUNT(*) as total FROM admin_messages').get() as { total: number };
      const { keep } = this.db.prepare('SELECT COUNT(*) as keep FROM _dedup_keep').get() as { keep: number };
      this.db.exec('DELETE FROM admin_messages WHERE id NOT IN (SELECT keep_id FROM _dedup_keep)');
      this.db.exec('DROP TABLE IF EXISTS _dedup_keep');
      return total - keep;
    });
    return dedup();
  }
}
