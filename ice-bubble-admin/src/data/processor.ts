/**
 * ice-bubble Admin - 数据处理逻辑
 *
 * 处理 collector 数据，添加溯源字段
 */

import type { AdminSession, AdminMessage } from '../storage/data-repository.js';
import type { CollectorSession, CollectorMessage } from './collector-client.js';

/**
 * 处理 session 行，添加溯源字段
 */
export function processSession(row: CollectorSession, sourceModule: string, platform: string): AdminSession {
  return {
    session_key: row.session_key,
    source_module: sourceModule,
    agent_id: row.agent_id ?? null,
    channel: row.channel ?? null,
    message_count: row.message_count ?? 0,
    first_message_at: null, // collector sessions don't have first_message_at
    last_message_at: row.last_message_at ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_created_at: row.created_at ?? null,
    label: row.label ?? null,
    session_status: row.status ?? null,
    model: row.model ?? null,
    model_provider: row.model_provider ?? null,
    spawned_by: row.spawned_by ?? null,
    spawn_depth: row.spawn_depth ?? null,
    platform,
  };
}

/**
 * 检测消息内容是否包含 subagent 系统事件标记
 */
function isSubagentSystemContent(content: string | null): boolean {
  if (!content) return false;
  return content.includes('[Subagent Task]:') || content.includes('[Internal task completion event]');
}

/**
 * 处理 message 行，添加溯源字段
 * 系统上下文消息（subagent 事件）标记 is_system_context=1，content 清空
 */
export function processMessage(row: CollectorMessage, sourceModule: string, platform: string): AdminMessage {
  const rawContent = row.content ?? null;
  const systemContext = isSubagentSystemContent(rawContent);

  // 解析 tools_json 提取 tool_name 和 tool_input
  let tool_name: string | null = null;
  let tool_input: string | null = null;
  if (row.message_type === 'tool' && row.tools_json) {
    try {
      const tools = JSON.parse(row.tools_json) as Array<{ name?: string; input?: unknown }>;
      if (tools.length > 0 && tools[0].name) {
        tool_name = tools[0].name;
        tool_input = tools[0].input != null ? JSON.stringify(tools[0].input) : null;
      }
    } catch {
      // tools_json 解析失败，忽略
    }
  }

  return {
    source_id: row.message_id ?? String(row.id ?? ''),
    source_module: sourceModule,
    session_key: row.session_key,
    message_type: row.message_type ?? null,
    content: systemContext ? '' : rawContent,
    model: row.model ?? null,
    tokens_input: row.tokens_input ?? null,
    tokens_output: row.tokens_output ?? null,
    cost_total: row.cost_total ?? null,
    cost_input: row.cost_input ?? null,
    cost_output: row.cost_output ?? null,
    is_system_context: systemContext ? 1 : undefined,
    timestamp: row.timestamp,
    created_at: new Date().toISOString(),
    source_created_at: row.created_at ?? null,
    ...(tool_name != null ? { tool_name } : {}),
    ...(tool_input != null ? { tool_input } : {}),
    platform,
  };
}
