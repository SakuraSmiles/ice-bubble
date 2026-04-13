/**
 * ice-bubble Admin - 数据管理仓库
 *
 * 负责 admin_sessions, admin_messages, admin_agents, sync_progress 表的 CRUD 操作
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
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
   * Token 统计聚合接口
   */
  getTokenSummary(agentId?: string): Array<{
    agent_id: string;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    cost_input: number;
    cost_output: number;
    message_count: number;
    updated_at: string;
  }> {
    if (agentId) {
      const row = this.db.prepare(
        'SELECT * FROM token_summary WHERE agent_id = ?'
      ).get(agentId) as {
        agent_id: string;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
        updated_at: string;
      } | undefined;
      return row ? [row] : [];
    }
    return this.db.prepare(
      'SELECT * FROM token_summary ORDER BY updated_at DESC'
    ).all() as Array<{
      agent_id: string;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost: number;
      cost_input: number;
      cost_output: number;
      message_count: number;
      updated_at: string;
    }>;
  }

  /**
   * 批量更新 token_summary（在事务内执行）
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

    const upsertSQL = `
      INSERT INTO token_summary
        (agent_id, total_input_tokens, total_output_tokens, total_cost, cost_input, cost_output, message_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(agent_id) DO UPDATE SET
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        total_cost = total_cost + excluded.total_cost,
        cost_input = cost_input + excluded.cost_input,
        cost_output = cost_output + excluded.cost_output,
        message_count = message_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `;
    const stmt = this.db.prepare(upsertSQL);

    for (const update of updates) {
      stmt.run(
        update.agentId,
        update.tokensInput,
        update.tokensOutput,
        update.costTotal,
        update.costInput,
        update.costOutput
      );
    }
    console.log(`[DataRepository] Batch updated token_summary for ${updates.length} agents`);
  }

  /**
   * 全量重建 token_summary（从 admin_messages 聚合）
   * @returns 受影响的 agent 数量
   */
  rebuildTokenSummary(): { affected_agents: number; duration_ms: number } {
    console.log('[DataRepository] Starting token_summary rebuild...');
    const start = Date.now();

    const rebuild = this.db.transaction(() => {
      // 1. 清空 token_summary 表
      this.db.prepare('DELETE FROM token_summary').run();

      // 2. 按 agent_id 聚合 admin_messages 的 token 数据
      const rows = this.db.prepare(`
        SELECT
          s.agent_id,
          COALESCE(SUM(CAST(m.tokens_input AS INTEGER)), 0) as total_input_tokens,
          COALESCE(SUM(CAST(m.tokens_output AS INTEGER)), 0) as total_output_tokens,
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
        GROUP BY s.agent_id
      `).all() as Array<{
        agent_id: string;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost: number;
        cost_input: number;
        cost_output: number;
        message_count: number;
      }>;

      // 3. 重新插入
      const insertSQL = `
        INSERT INTO token_summary
          (agent_id, total_input_tokens, total_output_tokens, total_cost, cost_input, cost_output, message_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      const stmt = this.db.prepare(insertSQL);
      for (const row of rows) {
        stmt.run(
          row.agent_id,
          row.total_input_tokens,
          row.total_output_tokens,
          row.total_cost,
          row.cost_input,
          row.cost_output,
          row.message_count
        );
      }

      return rows.length;
    });

    const affected_agents = rebuild();
    const duration_ms = Date.now() - start;
    console.log(`[DataRepository] Token summary rebuilt: ${affected_agents} agents in ${duration_ms}ms`);

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
        if (result.changes > 0) inserted++;
      }

      // 收集需要更新的 token 数据
      // 1. 获取所有 session_key -> agent_id 映射
      const sessionKeys = [...new Set(rows.map(r => r.session_key))];
      const sessionAgentMap = this.getSessionAgentIds(sessionKeys);

      // 2. 按 agentId 聚合 token 数据（只统计有 token 或 cost 的消息）
      const tokenUpdates = new Map<string, {
        tokensInput: number;
        tokensOutput: number;
        costTotal: number;
        costInput: number;
        costOutput: number;
      }>();

      for (const row of rows) {
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
          console.error('[DataRepository] Failed to update token_summary:', error);
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
      console.log('[DataRepository] No collector agents to refresh');
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
      console.log(`[DataRepository] Refreshed ${collectorAgents.length} configured agents`);
    } catch (error) {
      console.error('[DataRepository] Failed to refresh agents:', error);
      throw error;
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

      console.log(`[DataRepository] Loaded ${map.size} agent models from messages`);
    } catch (error) {
      console.warn('[DataRepository] Failed to load agent models from messages:', error);
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
  getGroupedSessions(limitPerAgent: number = 5): { agentId: string; totalCount: number; sessions: AdminSession[] }[] {
    // 获取所有 sessions，按 agent_id 分组
    const allSessions = this.db.prepare(`
      SELECT * FROM admin_sessions
      ORDER BY agent_id, last_message_at DESC
    `).all() as AdminSession[];

    const groups: Record<string, AdminSession[]> = {};
    for (const session of allSessions) {
      if (!groups[session.agent_id]) {
        groups[session.agent_id] = [];
      }
      groups[session.agent_id].push(session);
    }

    // 转换为数组，每个 group 限制数量并保留总数
    return Object.entries(groups)
      .map(([agentId, sessions]) => ({
        agentId,
        totalCount: sessions.length,
        sessions: sessions.slice(0, limitPerAgent),
      }))
      .sort((a, b) => {
        // 按最新 session 的 last_message_at 倒序排列 groups
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
   * 策略：先删除旧记录，再插入新记录（保证幂等性）
   * 配合 DataSync 的全量聚合，确保每次同步结果一致
   */
  upsertAgentActivityBatch(records: { agentId: string; date: string; count: number }[]): void {
    if (records.length === 0) return;

    const deleteStmt = this.db.prepare(`
      DELETE FROM agent_activity_daily WHERE agent_id = ? AND date = ?
    `);

    const insertStmt = this.db.prepare(`
      INSERT INTO agent_activity_daily (agent_id, date, message_count) VALUES (?, ?, ?)
    `);

    const upsertMany = this.db.transaction((rows: typeof records) => {
      for (const row of rows) {
        // 先删除旧记录（如果存在）
        deleteStmt.run(row.agentId, row.date);
        // 再插入新记录
        insertStmt.run(row.agentId, row.date, row.count);
      }
    });

    upsertMany(records);
    console.log(`[DataRepository] Replaced ${records.length} activity records`);
  }

  /**
   * 获取指定 agent 的活动数据（最近 N 天）
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
    console.log('[DataRepository] Computing session stats from admin_messages...');

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
    console.log(`[DataRepository] Session stats computed: ${updated} sessions updated`);
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
    console.log('[DataRepository] Computing agent stats from admin_messages...');

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
    console.log(`[DataRepository] Agent stats computed: ${updated} agents updated`);
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
    console.log('[DataRepository] 开始重建会话消息计数...');

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
    console.log(`[DataRepository] 重算 ${sessionResult.changes} 个 session 的 message_count`);

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
            AND last_message_at IS NOT NOT NULL
        ),
        updated_at = CURRENT_TIMESTAMP
    `);

    const agentResult = updateAgentStats.run();
    console.log(`[DataRepository] 重算 ${agentResult.changes} 个 agent 的汇总统计`);

    return sessionResult.changes;
  }
}
