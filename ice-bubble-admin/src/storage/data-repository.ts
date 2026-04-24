/**
 * ice-bubble Admin - 数据管理仓库
 *
 * 负责 admin_sessions, admin_messages, admin_agents, sync_progress 表的 CRUD 操作
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/index.js';
import type { CollectorAgent } from '../data/collector-client.js';

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
  timestamp: string;
  created_at: string;
  source_created_at: string | null;
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

/**
 * 消息元信息（不存储在 DB，运行时计算）
 */
interface MessageMeta {
  is_cron: boolean;
  is_system_noise: boolean;
  clean_content: string;
  content_summary: string;
  source_channel: string | null;
}

function analyzeMessageMeta(msg: {
  message_type: string;
  content: string | null;
  agent_name: string;
}): MessageMeta {
  const content = msg.content || '';
  const meta: MessageMeta = {
    is_cron: false,
    is_system_noise: false,
    clean_content: content,
    content_summary: '',
    source_channel: null,
  };

  if (msg.message_type === 'user') {
    // 检测定时任务
    if (content.startsWith('[cron:')) {
      meta.is_cron = true;
      // 提取 cron 描述部分
      const cronEnd = content.indexOf(']');
      const afterCron = cronEnd > 0 ? content.substring(cronEnd + 1).trim() : content;
      meta.clean_content = afterCron || content;
    }
    // 检测系统执行通知（System: / System(...) 格式）
    else if (/^System[ :(]/.test(content) && content.length > 10) {
      meta.is_system_noise = true;
      meta.clean_content = content.substring(0, 150);
    }
    // 检测 Sender metadata 块（webchat 消息编码）
    else if (content.startsWith('Sender (untrusted metadata)')) {
      // 提取 Sender metadata 中的 label 作为渠道
      const senderMatch = content.match(/```json\s*\{[\s\S]*?"label"\s*:\s*"([^"]+)"[\s\S]*?\}\s*```/);
      if (senderMatch) {
        meta.source_channel = senderMatch[1];
      }
      // 去掉开头的 Sender metadata json 块
      const pattern = /^Sender \(untrusted metadata\):\n```json\n[\s\S]*?\n```\n*\n*/;
      const afterMeta = content.replace(pattern, '').trim();
      // 再去掉时间头（如 [Sat 2026-04-11 23:04 GMT+8] 或 [Fri 22:42]）
      const afterTime = afterMeta.replace(/^\[[^\]]+\]\s*/, '').trim();
      meta.clean_content = afterTime || content;
    }
    // 检测 HEARTBEAT_OK / NO_REPLY
    else if (content === 'HEARTBEAT_OK' || content === 'NO_REPLY') {
      meta.is_system_noise = true;
    }
  }

  // 生成 content_summary
  if (meta.clean_content) {
    if (msg.message_type === 'tool') {
      meta.content_summary = meta.clean_content.substring(0, 60) + (meta.clean_content.length > 60 ? '...' : '');
    } else {
      meta.content_summary = meta.clean_content.substring(0, 120);
    }
  }

  return meta;
}

// ========== 数据仓库 ==========

export class DataRepository {
  private db: Database;
  private avatarsDir: string;

  constructor(db: Database, avatarsDir: string) {
    this.db = db;
    this.avatarsDir = avatarsDir;
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
        first_message_at, last_message_at, created_at, updated_at, source_created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        source_module = excluded.source_module,
        agent_id = excluded.agent_id,
        channel = excluded.channel,
        message_count = excluded.message_count,
        first_message_at = excluded.first_message_at,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
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
          row.source_created_at ?? null
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

  // ========== Token Summary ==========

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
   */
  saveMessages(messages: AdminMessage[]): number {
    if (messages.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO admin_messages (
        source_id, source_module, session_key, message_type, content,
        model, tokens_input, tokens_output, cost_total, cost_input, cost_output,
        timestamp, created_at, source_created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    let inserted = 0;

    const insertMany = this.db.transaction((rows: AdminMessage[]) => {
      // 记录每条消息是否新插入（用于 token 统计去重）
      const newlyInserted: boolean[] = [];

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
          row.timestamp,
          now,
          row.source_created_at ?? null
        );
        const isNew = result.changes > 0;
        newlyInserted.push(isNew);
        if (isNew) inserted++;
      }

      // 收集需要更新的 token 数据
      // 1. 获取所有 session_key -> agent_id 映射
      const sessionKeys = [...new Set(rows.map(r => r.session_key))];
      const sessionAgentMap = this.getSessionAgentIds(sessionKeys);

      // 2. 按 agentId 聚合 token 数据（只统计新插入的消息）
      const tokenUpdates = new Map<string, {
        tokensInput: number;
        tokensOutput: number;
        costTotal: number;
        costInput: number;
        costOutput: number;
      }>();

      for (let i = 0; i < rows.length; i++) {
        // 只统计新插入的消息，避免重复计算
        if (!newlyInserted[i]) continue;

        const row = rows[i];
        const agentId = sessionAgentMap.get(row.session_key);
        if (!agentId) continue;

        // 只统计有 token 或 cost 的消息
        const hasTokenData =
          (row.tokens_input != null && row.tokens_input > 0) ||
          (row.tokens_output != null && row.tokens_output > 0) ||
          (row.cost_total != null && row.cost_total > 0);
        if (!hasTokenData) continue;

        const existing = tokenUpdates.get(agentId) || {
          tokensInput: 0,
          tokensOutput: 0,
          costTotal: 0,
          costInput: 0,
          costOutput: 0,
        };

        tokenUpdates.set(agentId, {
          tokensInput: existing.tokensInput + (row.tokens_input ?? 0),
          tokensOutput: existing.tokensOutput + (row.tokens_output ?? 0),
          costTotal: existing.costTotal + (row.cost_total ?? 0),
          costInput: existing.costInput + (row.cost_input ?? 0),
          costOutput: existing.costOutput + (row.cost_output ?? 0),
        });
      }

      // 3. 批量更新 token_summary
      if (tokenUpdates.size > 0) {
        const updates = Array.from(tokenUpdates.entries()).map(([agentId, data]) => ({
          agentId,
          ...data,
        }));
        try {
          this.batchUpdateTokenSummary(updates);
        } catch (error) {
          // token 更新失败不影响消息入库，记录错误
          logger.error('[DataRepository] Failed to update token_summary:', { error: String(error) });
        }
      }
    });

    insertMany(messages);
    return inserted;
  }

  /**
   * 获取消息列表
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM admin_messages ${whereClause}`).get(...values) as { total: number };

    const rows = this.db.prepare(`
      SELECT * FROM admin_messages ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as AdminMessage[];

    return { messages: rows, total: countRow.total };
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
    const conditions: string[] = ["m.message_type IN ('user', 'agent', 'tool')"];
    const values: unknown[] = [];

    if (params.message_types) {
      const types = params.message_types.split(',').map(s => s.trim()).filter(Boolean);
      if (types.length > 0 && types.length < 3) {
        conditions[0] = `m.message_type IN (${types.map(() => '?').join(', ')})`;
        values.push(...types);
      }
    }

    if (params.before) {
      conditions.push('m.timestamp < ?');
      values.push(params.before);
    }

    if (params.since) {
      conditions.push('m.timestamp > ?');
      values.push(params.since);
    }

    if (params.agent_ids && params.agent_ids.length > 0) {
      const agentPlaceholders = params.agent_ids.map(() => '?').join(', ');
      conditions.push(`s.agent_id IN (${agentPlaceholders})`);
      values.push(...params.agent_ids);
    }

    if (params.search) {
      conditions.push('m.content LIKE ?');
      values.push(`%${params.search}%`);
    }

    // 把噪音/cron 过滤下移到 SQL 中
    if (params.exclude_system_noise) {
      conditions.push("(m.content NOT IN ('HEARTBEAT_OK', 'NO_REPLY') AND m.content NOT LIKE 'System[ :(]%' AND m.content NOT LIKE 'System ([%')");
    }
    if (params.exclude_cron) {
      conditions.push("m.content NOT LIKE '[cron%'");
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Query
    const rows = this.db.prepare(`
      SELECT
        m.id,
        m.session_key,
        m.message_type,
        m.content,
        m.timestamp,
        m.model,
        s.agent_id,
        a.agent_name,
        a.avatar
      FROM admin_messages m
      LEFT JOIN admin_sessions s ON m.session_key = s.session_key
      LEFT JOIN admin_agents a ON s.agent_id = a.agent_id
      ${whereClause}
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

    const has_more = rows.length > limit;
    if (has_more) rows.pop();

    // 统计范围内的 agent
    const agentSet = new Set<string>();
    // 总行数（近似）
    let totalInRange = 0;
    try {
      const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM admin_messages m LEFT JOIN admin_sessions s ON m.session_key = s.session_key ${whereClause}`).get(...values) as { cnt: number };
      totalInRange = countRow.cnt;
    } catch { /* ignore */ }

    for (const row of rows) {
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

      let content = row.content;
      if (row.message_type === 'tool' && content && content.length > 300) {
        content = content.substring(0, 300);
      }

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
        updated_at = excluded.updated_at
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

    const upsertStmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id, date) DO UPDATE SET
        message_count = excluded.message_count
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
   * 从 admin_messages 计算并更新每个 session 的统计信息
   * - message_count: 消息总数
   * - first_message_at: 首条消息时间
   * - last_message_at: 末条消息时间
   * 仅当 message_count 或 last_message_at 发生变化时更新
   * @returns 更新涉及的 session 数量
   */
  computeSessionStats(): number {
    logger.info('[DataRepository] Computing session stats from admin_messages...');

    const computeAndUpsert = this.db.transaction(() => {
      // 获取所有 session_key
      const sessions = this.db.prepare('SELECT session_key FROM admin_sessions').all() as { session_key: string }[];
      let updated = 0;

      for (const { session_key } of sessions) {
        const row = this.db.prepare(`
          SELECT
            COUNT(*) as message_count,
            MIN(timestamp) as first_message_at,
            MAX(timestamp) as last_message_at
          FROM admin_messages
          WHERE session_key = ?
        `).get(session_key) as { message_count: number; first_message_at: string | null; last_message_at: string | null } | undefined;

        if (!row) continue;

        // 仅当 message_count 或 last_message_at 变化时更新
        const update = this.db.prepare(`
          UPDATE admin_sessions
          SET message_count = ?, first_message_at = ?, last_message_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_key = ?
            AND (message_count != ? OR last_message_at != ? OR first_message_at IS NULL)
        `);
        const result = update.run(row.message_count, row.first_message_at, row.last_message_at, session_key, row.message_count, row.last_message_at);
        if (result.changes > 0) updated++;
      }

      return updated;
    });

    const updated = computeAndUpsert();
    logger.info(`[DataRepository] Session stats computed: ${updated} sessions updated`);
    return updated;
  }

  /**
   * 从 admin_messages 计算并更新每个 agent 的统计信息
   * - session_count: 独立会话数（不含 checkpoint）
   * - message_count: 消息总数（不含 checkpoint）
   * - first_active_at: 首次活跃时间（不含 checkpoint）
   * - last_active_at: 最近活跃时间（不含 checkpoint）
   * 仅当任何统计值发生变化时更新
   * @returns 更新涉及的 agent 数量
   */
  computeAgentStats(): number {
    logger.info('[DataRepository] Computing agent stats from admin_messages...');

    const computeAndUpsert = this.db.transaction(() => {
      // 获取所有配置的 agent_id
      const agents = this.db.prepare('SELECT agent_id FROM admin_agents').all() as { agent_id: string }[];
      let updated = 0;

      for (const { agent_id } of agents) {
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
        `).get(agent_id) as { session_count: number; message_count: number; first_active_at: string | null; last_active_at: string | null } | undefined;

        if (!row) continue;

        // 仅当任何统计值变化时更新
        const update = this.db.prepare(`
          UPDATE admin_agents
          SET session_count = ?, message_count = ?, first_active_at = ?, last_active_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
            AND (session_count != ? OR message_count != ? OR first_active_at != ? OR last_active_at != ? OR first_active_at IS NULL)
        `);
        const result = update.run(
          row.session_count, row.message_count, row.first_active_at, row.last_active_at,
          agent_id,
          row.session_count, row.message_count, row.first_active_at, row.last_active_at
        );
        if (result.changes > 0) updated++;
      }

      return updated;
    });

    const updated = computeAndUpsert();
    logger.info(`[DataRepository] Agent stats computed: ${updated} agents updated`);
    return updated;
  }

  // ========== Stats ==========

  /**
   * 获取数据统计
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    lastSyncTime: string | null;
  } {
    const sessionRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_sessions').get() as { count: number };
    const messageRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_messages').get() as { count: number };
    const agentRow = this.db.prepare('SELECT COUNT(*) as count FROM admin_agents').get() as { count: number };
    const syncRow = this.db.prepare("SELECT MAX(last_sync_time) as time FROM sync_progress").get() as { time: string | null };

    return {
      sessionCount: sessionRow.count,
      messageCount: messageRow.count,
      agentCount: agentRow.count,
      lastSyncTime: syncRow.time
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
}
