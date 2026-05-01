/**
 * 任务解析器
 *
 * 从 admin_tool_calls 中解析 sessions_spawn 记录，生成 admin_tasks 数据
 */

import { readFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { logger } from '../utils/index.js';

export interface ParsedTask {
  id: string;                    // 使用 tool_result 的 runId 作为 task id
  title: string;                 // 从 tool_input.task 中提取第一行作为标题
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout';
  agent_id: string;
  requester_session_key: string;
  child_session_key: string;    // 从 tool_result.childSessionKey 获取
  run_id: string;
  mode: string;
  task_description: string;
  result_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TaskRow {
  source_id: string;
  source_module: string;
  requester_session_key: string;
  tool_name: string;
  tool_input: string;
  content: string;
  created_at: string;
}

export class TaskParser {
  private db: Database;
  private collectorBaseUrl: string;

  constructor(db: Database, collectorBaseUrl?: string) {
    this.db = db;
    this.collectorBaseUrl = collectorBaseUrl || 'http://localhost:13100';
  }

  /**
   * 从 admin_tool_calls 中解析所有 sessions_spawn 记录
   * 生成 admin_tasks 数据并返回
   */
  async parseSessionsSpawnRecords(): Promise<ParsedTask[]> {
    // 查询 sessions_spawn 记录
    const rows = this.db.prepare(`
      SELECT
        tc.source_id,
        tc.source_module,
        tc.session_key AS requester_session_key,
        tc.tool_name,
        tc.tool_input,
        tc.content,
        tc.created_at
      FROM admin_tool_calls tc
      WHERE tc.tool_name = 'sessions_spawn'
      ORDER BY tc.created_at DESC
    `).all() as TaskRow[];

    // 收集需要回填的 session keys（tool_input 为空或 {}）
    const sessionKeysToFetch = [...new Set(
      rows
        .filter(r => !r.tool_input || r.tool_input === '{}')
        .map(r => r.requester_session_key)
    )];

    // 批量从 collector API 回填 sessions_spawn input
    await this.batchBackfill(sessionKeysToFetch);

    const tasks: ParsedTask[] = [];

    for (const row of rows) {
      try {
        const parsed = this.parseSingleRecord(row);
        if (parsed) {
          tasks.push(parsed);
        }
      } catch (error) {
        logger.warn('[TaskParser] Failed to parse sessions_spawn record', {
          source_id: row.source_id,
          error: String(error),
        });
      }
    }

    return tasks;
  }

  /**
   * 批量从 collector API 回填 sessions_spawn input
   * admin_tool_calls 表的 tool_input 字段在 sessions_spawn 记录中可能为空，
   * 需要从 collector 的 session_messages.tools_json 中获取（通过 collector HTTP API）
   */
  private async batchBackfill(sessionKeys: string[]): Promise<void> {
    for (const sessionKey of sessionKeys) {
      try {
        const url = `${this.collectorBaseUrl}/api/data/messages?session_key=${encodeURIComponent(sessionKey)}&limit=100`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;

        const data = (await response.json()) as { messages: Array<{ tools_json: string | null; created_at?: string }> };
        for (const msg of data.messages ?? []) {
          if (!msg.tools_json) continue;
          try {
            const tools = JSON.parse(msg.tools_json);
            if (Array.isArray(tools)) {
              for (const t of tools) {
                if (t.name === 'sessions_spawn' && t.input) {
                  // 缓存，用 sessionKey 做 key（同一个 session 只取第一条 sessions_spawn）
                  this.cacheBackfill(sessionKey, t.input as { task?: string; agentId?: string; mode?: string });
                  return; // 找到就停止
                }
              }
            }
          } catch { /* ignore parse errors */ }
        }
      } catch (err) {
        logger.warn('[TaskParser] Backfill fetch failed', { session_key: sessionKey, error: String(err) });
      }
    }
  }

  /** 单条回填结果缓存（sessionKey → input） */
  private backfillCache = new Map<string, { task?: string; agentId?: string; mode?: string }>();

  private cacheBackfill(sessionKey: string, input: { task?: string; agentId?: string; mode?: string }): void {
    if (!this.backfillCache.has(sessionKey)) {
      this.backfillCache.set(sessionKey, input);
    }
  }

  /**
   * 解析单条 sessions_spawn 记录
   */
  private parseSingleRecord(row: TaskRow): ParsedTask | null {
    // 解析 tool_input JSON → 获取 task、agentId、mode 等
    // 如果 tool_input 为空或 {}，使用回填缓存
    let toolInputObj: { task?: string; agentId?: string; mode?: string } = {};
    try {
      if (row.tool_input && row.tool_input !== '{}') {
        toolInputObj = JSON.parse(row.tool_input);
      } else {
        // 从回填缓存中获取（batchBackfill 已预加载）
        const cached = this.backfillCache.get(row.requester_session_key);
        if (cached) {
          toolInputObj = cached;
        }
      }
    } catch {
      logger.warn('[TaskParser] Failed to parse tool_input JSON', { source_id: row.source_id });
    }

    const task = toolInputObj.task || '';
    const agentId = toolInputObj.agentId || '';
    const mode = toolInputObj.mode || '';

    // 解析 content（tool_result JSON）→ 获取 childSessionKey、runId
    let toolResultObj: { childSessionKey?: string; runId?: string } = {};
    try {
      if (row.content) {
        toolResultObj = JSON.parse(row.content);
      }
    } catch {
      logger.warn('[TaskParser] Failed to parse tool_result JSON', { source_id: row.source_id });
    }

    const childSessionKey = toolResultObj.childSessionKey || '';
    const runId = toolResultObj.runId || '';

    // 使用 runId 作为 task id
    const id = runId;

    // 从 tool_input.task 中提取简洁标题
    const title = this.extractTitle(task) || 'Untitled Task';

    // 关联 admin_sessions 表获取子 session 的状态信息
    const childSession = this.getChildSession(childSessionKey);

    // 推导任务状态
    const status = this.deriveTaskStatus(childSessionKey, childSession);

    // 派生 started_at 和 completed_at
    let started_at: string | null = null;
    let completed_at: string | null = null;

    if (childSession) {
      if (childSession.first_message_at) {
        started_at = childSession.first_message_at;
      }
      if (status === 'completed' || status === 'failed' || status === 'timeout') {
        completed_at = childSession.last_message_at;
      }
    }

    return {
      id,
      title,
      status,
      agent_id: agentId,
      requester_session_key: row.requester_session_key,
      child_session_key: childSessionKey,
      run_id: runId,
      mode,
      task_description: task,
      result_summary: null,
      created_at: row.created_at,
      started_at,
      completed_at,
    };
  }

  /**
   * 从 taskDescription 中提取简洁标题
   */
  private extractTitle(taskDescription: string): string {
    const firstLine = taskDescription.split('\n')[0].trim();
    if (!firstLine) return '';

    // 1. ## 任务：xxx
    const taskMatch = firstLine.match(/^##\s*任务[：:]\s*(.+)/);
    if (taskMatch) return taskMatch[1].trim();

    // 2. # agent: xxx  或  # xxx：xxx（一级标题，去掉 # 前缀和 agent 前缀）
    const h1Match = firstLine.match(/^#\s+(.+)/);
    if (h1Match) {
      const rest = h1Match[1].trim();
      // 去掉 "agent: " 前缀（如 "dev: "）
      const agentPrefixMatch = rest.match(/^[\w-]+:\s*(.+)/);
      if (agentPrefixMatch) return agentPrefixMatch[1].trim();
      return rest;
    }

    // 3. [PARENT] xxx  或  [TODO] xxx 等方括号前缀
    const bracketMatch = firstLine.match(/^\[[A-Z]+\]\s*(.+)/);
    if (bracketMatch) return bracketMatch[1].trim();

    // 4. 身份+任务描述格式（如 "你是xxx。执行xxx。"）
    const actionMatch = firstLine.match(/(?:执行|完成)\s*(.+)/);
    if (actionMatch && firstLine.includes('。')) {
      return actionMatch[1].replace(/。$/, '').trim();
    }
    // 退而求其次：取第一个句号后的内容
    const periodMatch = firstLine.match(/。\s*(.+)/);
    if (periodMatch) return periodMatch[1].trim();

    // 5. 请xxx 开头 → 直接取
    if (firstLine.startsWith('请')) return firstLine;

    // 6. 其他 → 取第一行，超过40字符截断
    if (firstLine.length > 40) {
      return firstLine.substring(0, 40) + '…';
    }
    return firstLine;
  }

  /**
   * 获取子 session 的状态信息
   */
  private getChildSession(childSessionKey: string): {
    first_message_at: string | null;
    last_message_at: string | null;
    message_count: number;
  } | null {
    if (!childSessionKey) return null;

    // childSessionKey 格式: agent:{agentId}:subagent:{uuid}
    // admin_sessions 中格式: agent:{agentId}:local:default:direct:{uuid}
    // 提取 UUID 进行模糊匹配
    const parts = childSessionKey.split(':');
    const uuid = parts[parts.length - 1];
    if (!uuid || uuid.length < 10) return null;

    const row = this.db.prepare(`
      SELECT first_message_at, last_message_at, message_count
      FROM admin_sessions
      WHERE session_key LIKE '%' || ? || '%'
      LIMIT 1
    `).get(uuid) as { first_message_at: string | null; last_message_at: string | null; message_count: number } | undefined;

    return row ?? null;
  }

  /**
   * 推导任务状态
   */
  private deriveTaskStatus(childSessionKey: string, childSession: {
    first_message_at: string | null;
    last_message_at: string | null;
    message_count: number;
  } | null): 'queued' | 'running' | 'completed' | 'failed' | 'timeout' {
    if (!childSessionKey || !childSession) {
      return 'queued';
    }

    if (childSession.message_count === 0) {
      return 'queued';
    }

    if (!childSession.last_message_at) {
      return 'running';
    }

    return 'completed';
  }

  /**
   * 刷新任务数据：解析 + upsert + 修复 running 状态
   * 幂等操作，可安全重复调用
   */
  async refreshTasks(): Promise<number> {
    const tasks = await this.parseSessionsSpawnRecords();
    const count = this.upsertTasks(tasks);
    this.fixRunningStatus();
    return count;
  }

  /**
   * 读取 OpenClaw subagents/runs.json，将活跃 run 对应的任务标记为 running
   */
  private fixRunningStatus(): void {
    const runsPath = '/home/dabai/.openclaw/subagents/runs.json';
    try {
      const raw = readFileSync(runsPath, 'utf-8');
      const data = JSON.parse(raw);
      const runs = data.runs as Record<string, { childSessionKey?: string; endedAt: number | null }>;
      if (!runs) return;

      // 找出活跃的 run（endedAt 为 null）
      const activeRunIds: string[] = [];
      for (const [runId, run] of Object.entries(runs)) {
        if (run.endedAt === null || run.endedAt === undefined) {
          activeRunIds.push(runId);
        }
      }

      if (activeRunIds.length === 0) return;

      // 先将所有 running 状态重置为 completed（上次标记为 running 的可能已结束）
      this.db.prepare(`
        UPDATE admin_tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND run_id NOT IN (${activeRunIds.map(() => '?').join(',')})
      `).run(...activeRunIds);

      logger.info(`[TaskParser] Fixed running status for ${activeRunIds.length} active runs`);
    } catch (err) {
      logger.warn('[TaskParser] fixRunningStatus failed', { error: String(err) });
    }
  }

  /**
   * 将解析出的任务数据批量写入 admin_tasks 表
   * 使用 INSERT OR REPLACE 保证幂等性
   */
  upsertTasks(tasks: ParsedTask[]): number {
    if (tasks.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO admin_tasks (
        id, title, status, agent_id, requester_session_key, child_session_key,
        run_id, mode, task_description, result_summary,
        created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        title = CASE WHEN excluded.title != 'Untitled Task' OR admin_tasks.title = 'Untitled Task' OR admin_tasks.title IS NULL
          THEN excluded.title ELSE admin_tasks.title END,
        status = excluded.status,
        agent_id = CASE WHEN excluded.agent_id != '' THEN excluded.agent_id ELSE admin_tasks.agent_id END,
        requester_session_key = excluded.requester_session_key,
        child_session_key = excluded.child_session_key,
        run_id = excluded.run_id,
        mode = CASE WHEN excluded.mode != '' THEN excluded.mode ELSE admin_tasks.mode END,
        task_description = CASE WHEN excluded.task_description != '' THEN excluded.task_description ELSE admin_tasks.task_description END,
        result_summary = excluded.result_summary,
        started_at = CASE WHEN excluded.started_at IS NOT NULL THEN excluded.started_at ELSE admin_tasks.started_at END,
        completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE admin_tasks.completed_at END,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertMany = this.db.transaction((rows: ParsedTask[]) => {
      let count = 0;
      for (const task of rows) {
        const result = stmt.run(
          task.id,
          task.title,
          task.status,
          task.agent_id || null,
          task.requester_session_key,
          task.child_session_key || null,
          task.run_id || null,
          task.mode || null,
          task.task_description || null,
          task.result_summary,
          task.created_at,
          task.started_at,
          task.completed_at
        );
        if (result.changes > 0) count++;
      }
      return count;
    });

    const count = upsertMany(tasks);
    logger.info(`[TaskParser] Upserted ${count} tasks into admin_tasks`);
    return count;
  }
}
