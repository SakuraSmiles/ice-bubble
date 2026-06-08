/**
 * SessionRepository — 管理 admin_sessions 表的所有 CRUD 操作
 *
 * 职责：
 * - Session 的增删改查（save/get/list/resolve）
 * - Session 统计计算（消息数、时间范围）
 * - Session 分组查询（子 agent 任务、按 agent 分组）
 * - Session → Agent 映射
 */

import type { Database } from 'better-sqlite3';
import type {
  AdminSession,
} from '../data-repository.js';

export class SessionRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ========== Session 写入 ==========

  /**
   * 批量保存 sessions（upsert）
   */
  saveSessions(sessions: AdminSession[]): void {
    if (sessions.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO admin_sessions (
        session_key, source_module, agent_id, channel, message_count,
        first_message_at, last_message_at, created_at, updated_at, source_created_at,
        label, session_status, model, model_provider, spawned_by, spawn_depth, platform
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        spawn_depth = excluded.spawn_depth,
        platform = excluded.platform
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
          row.spawn_depth ?? 0,
          row.platform ?? 'openclaw'
        );
      }
    });

    insertMany(sessions);
  }

  // ========== Session 查询 ==========

  /**
   * 获取 session 列表
   */
  getSessions(params: {
    limit?: number;
    offset?: number;
    agent_id?: string;
    channel?: string;
    platform?: string;
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
    if (params.platform) {
      conditions.push('platform = ?');
      values.push(params.platform);
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
    // 0. ses_xxx 格式（OpenCode 等）：直接精确匹配
    if (sessionKey.startsWith('ses_')) {
      const direct = this.db.prepare('SELECT session_key FROM admin_sessions WHERE session_key = ?').get(sessionKey);
      return direct ? [sessionKey] : [];
    }

    // 1. 先尝试直接匹配
    const directRow = this.db.prepare(
      'SELECT session_key, agent_id, last_message_at FROM admin_sessions WHERE session_key = ?'
    ).get(sessionKey) as { session_key: string; agent_id: string | null; last_message_at: string | null } | undefined;
    if (directRow) {
      // 1a. 精确匹配到简写格式的 key（如 agent:main:main），检查该 agent 是否有
      //     更新的活跃 session。简写 key 的特征：segment 数量 ≤ 3 且没有 UUID。
      const parts = sessionKey.split(':');
      const hasUuid = sessionKey.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const isShorthandKey = parts.length <= 3 && !hasUuid;

      if (isShorthandKey && directRow.agent_id) {
        // 查找该 agent 最新的 session（排除 trajectory/checkpoint）
        const latestRow = this.db.prepare(
          `SELECT session_key, last_message_at FROM admin_sessions
           WHERE agent_id = ? AND session_key != ?
             AND session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint'
             AND message_count > 0
           ORDER BY last_message_at DESC NULLS LAST
           LIMIT 1`
        ).get(directRow.agent_id, sessionKey) as { session_key: string; last_message_at: string | null } | undefined;

        if (latestRow && latestRow.last_message_at && directRow.last_message_at) {
          if (latestRow.last_message_at > directRow.last_message_at) {
            // agent 有比精确匹配更新的 session → 使用最新 session
            return [latestRow.session_key];
          }
        }
        // 即使 last_message_at 相等或精确匹配的更新，也优先返回精确匹配
        // 但如果没有 last_message_at 可比较，则尝试查找有消息的最新 session
        if (!latestRow && !directRow.last_message_at) {
          const anyActiveRow = this.db.prepare(
            `SELECT session_key FROM admin_sessions
             WHERE agent_id = ? AND session_key != ?
               AND session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint'
               AND message_count > 0
             ORDER BY last_message_at DESC NULLS LAST
             LIMIT 1`
          ).get(directRow.agent_id, sessionKey) as { session_key: string } | undefined;
          if (anyActiveRow) return [anyActiveRow.session_key];
        }
      }
      return [sessionKey];
    }

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

    // 3. 非 UUID 格式（如 agent:main:main）且无精确匹配: 按 agent_id 查找最新 session
    //    注意：subagent 会话不回退查找，因为 Collector 不存储 subagent 消息
    if (agentId && !sessionKey.includes(':subagent:')) {
      // 查找该 agent 最新的活跃 session（不限 channel）
      const latestRows = this.db.prepare(
        `SELECT session_key FROM admin_sessions
         WHERE agent_id = ?
           AND session_key NOT LIKE '%.trajectory' AND session_key NOT LIKE '%.checkpoint'
         ORDER BY last_message_at DESC NULLS LAST, message_count DESC NULLS LAST
         LIMIT 1`
      ).all(agentId) as { session_key: string }[];
      if (latestRows.length > 0) return latestRows.map(r => r.session_key);
    }

    return [];
  }

  // ========== Admin Session 辅助查询 ==========

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

  // ========== 子 Agent 任务 ==========

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

  // ========== 分组 Sessions ==========

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

  // ========== Session → Agent 映射 ==========

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

  // ========== Session 统计计算 ==========

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

  // ========== Session 消息映射 ==========

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
    const t0 = Date.now();
    // Efficient query: uses a composite subquery via MIN(timestamp) instead of
    // a correlated subquery with ORDER BY + LIMIT per row.
    const rows = this.db.prepare(`
      SELECT
        s.session_key,
        substr(mf.content, 1, 120) as first_message
      FROM admin_sessions s
      LEFT JOIN (
        SELECT session_key, MIN(timestamp) as min_ts
        FROM admin_messages
        WHERE message_type = 'user'
        GROUP BY session_key
      ) fm ON fm.session_key = s.session_key
      LEFT JOIN admin_messages mf ON mf.session_key = fm.session_key
        AND mf.timestamp = fm.min_ts
        AND mf.message_type = 'user'
      WHERE s.session_key IS NOT NULL
      GROUP BY s.session_key
    `).all() as Array<{
      session_key: string;
      first_message: string | null;
    }>;
    const t1 = Date.now();
    console.log(`[SessionRepo][perf] getSessionFirstMessageMap: ${t1 - t0}ms (${rows.length} rows)`);
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
}
