/**
 * AgentRepository — 管理 admin_agents 表的 CRUD 操作与统计计算
 *
 * 职责：
 * - Agent 列表查询、头像管理
 * - 同步配置 agent（refreshAgents，从 Collector 数据 + sessions 统计数据聚合）
 * - Agent 活动热力图数据关联（getAgentsWithActivity）
 * - Agent 统计增量更新
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/index.js';
import type { CollectorAgent } from '../../data/collector-client.js';
import type { AdminAgent } from '../data-repository.js';

export class AgentRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ========== Agent 同步 ==========

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
  refreshAgents(collectorAgents: CollectorAgent[], sourceModule: string = 'unknown', platform: string = 'openclaw'): void {
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
      INSERT INTO admin_agents (agent_id, agent_name, workspace, session_count, message_count, first_active_at, last_active_at, model, source, platform, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id) DO UPDATE SET
        agent_name = excluded.agent_name,
        workspace = excluded.workspace,
        session_count = excluded.session_count,
        message_count = excluded.message_count,
        first_active_at = excluded.first_active_at,
        last_active_at = excluded.last_active_at,
        model = excluded.model,
        source = excluded.source,
        platform = excluded.platform,
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
            sourceModule,
            platform
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

  // ========== Agent 查询 ==========

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

  // ========== Agent + Activity 联合查询 ==========

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

  // ========== Agent 统计增量更新 ==========

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
}
