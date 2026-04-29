/**
 * 任务解析器
 *
 * 从 admin_tool_calls 中解析 sessions_spawn 记录，生成 admin_tasks 数据
 */

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

export class TaskParser {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 从 admin_tool_calls 中解析所有 sessions_spawn 记录
   * 生成 admin_tasks 数据并返回
   */
  parseSessionsSpawnRecords(): ParsedTask[] {
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
    `).all() as Array<{
      source_id: string;
      source_module: string;
      requester_session_key: string;
      tool_name: string;
      tool_input: string;
      content: string;
      created_at: string;
    }>;

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
   * 解析单条 sessions_spawn 记录
   */
  private parseSingleRecord(row: {
    source_id: string;
    source_module: string;
    requester_session_key: string;
    tool_name: string;
    tool_input: string;
    content: string;
    created_at: string;
  }): ParsedTask | null {
    // 解析 tool_input JSON → 获取 task、agentId、mode 等
    let toolInputObj: { task?: string; agentId?: string; mode?: string } = {};
    try {
      if (row.tool_input) {
        toolInputObj = JSON.parse(row.tool_input);
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

    // 从 tool_input.task 中提取第一行作为标题
    const title = task.split('\n')[0].trim().substring(0, 200) || 'Untitled Task';

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
      WHERE session_key LIKE ?
      ORDER BY last_message_at DESC
      LIMIT 1
    `).get(`%${uuid}%`) as {
      first_message_at: string | null;
      last_message_at: string | null;
      message_count: number;
    } | undefined;

    return row ?? null;
  }

  /**
   * 推导任务状态
   * 规则：
   * - 无 runId → queued
   * - 有 runId，检查 admin_sessions 中是否有对应的 session 记录
   * - admin_sessions 有记录且有 last_message_at → completed
   * - admin_sessions 有记录但无 last_message_at → running
   * - admin_sessions 无记录（subagent session 已清理）→ completed（历史任务默认完成）
   */
  private deriveTaskStatus(
    childSessionKey: string | null,
    childSession: { first_message_at: string | null; last_message_at: string | null; message_count: number } | null
  ): 'queued' | 'running' | 'completed' | 'failed' | 'timeout' {
    if (!childSessionKey) {
      return 'queued';
    }

    if (!childSession) {
      // subagent session 已被清理，历史任务默认 completed
      return 'completed';
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
        title = excluded.title,
        status = excluded.status,
        agent_id = excluded.agent_id,
        requester_session_key = excluded.requester_session_key,
        child_session_key = excluded.child_session_key,
        run_id = excluded.run_id,
        mode = excluded.mode,
        task_description = excluded.task_description,
        result_summary = excluded.result_summary,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
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
