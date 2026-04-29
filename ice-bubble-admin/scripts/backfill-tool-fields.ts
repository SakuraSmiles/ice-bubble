/**
 * 回填 admin_tool_calls 的 tool_name 和 tool_input
 * 从 collector API 拉取历史消息，更新 admin.db
 *
 * 特殊处理 sessions_spawn：
 * - agent 消息中 toolCall 的 input 有完整的 {task, agentId, mode}
 * - tool 消息中 toolResult 的 input 为 {} 但 content 有 {childSessionKey, runId}
 * - 按时间顺序配对：同一 session_key 内，agent 消息在前，tool 消息在后
 * - 将 agent 消息中的 toolCall input 写入 tool 消息对应的 admin_tool_calls 记录
 */
import Database from 'better-sqlite3';
import { logger } from '../src/utils/index.js';

const ADMIN_DB = '/mnt/d/workspace/ice-bubble/data/admin.db';
const COLLECTOR_URL = 'http://localhost:13100';
const BATCH_SIZE = 500;
const SLEEP_MS = 100;

async function fetchMessages(sessionKey?: string, offset = 0): Promise<{ count: number; messages: any[] }> {
  const params = new URLSearchParams({ limit: String(BATCH_SIZE), offset: String(offset) });
  if (sessionKey) params.set('session_key', sessionKey);
  const url = `${COLLECTOR_URL}/api/data/messages?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Collector API error: ${res.status}`);
  return res.json();
}

interface ToolCallInfo {
  /** collector message id */
  msgId: number;
  sessionKey: string;
  timestamp: string;
  input: any;
}

interface ToolResultInfo {
  /** collector message id */
  msgId: number;
  sessionKey: string;
  timestamp: string;
  content: any;
}

function parseToolsJson(toolsJson: unknown): Array<{ name: string; input: any; result?: any }> {
  if (!toolsJson) return [];
  try {
    const tools = JSON.parse(typeof toolsJson === 'string' ? toolsJson : JSON.stringify(toolsJson));
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

async function main() {
  const db = new Database(ADMIN_DB, { readonly: false, timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // ---- Phase 1: 常规回填 (非 sessions_spawn) ----
  const spawnEmpty = db.prepare(
    "SELECT COUNT(*) as c FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND (tool_input IS NULL OR tool_input='{}')"
  ).get() as { c: number };
  console.log(`sessions_spawn records with empty tool_input: ${spawnEmpty.c}`);

  // ---- Phase 2: 回填 sessions_spawn ----
  // 获取所有需要回填的 sessions_spawn 记录的 source_id 和 session_key
  const emptySpawns = db.prepare(
    "SELECT source_id, session_key FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND (tool_input IS NULL OR tool_input='{}')"
  ).all() as Array<{ source_id: string; session_key: string }>;

  if (emptySpawns.length === 0) {
    console.log('No sessions_spawn records to backfill.');
    db.close();
    return;
  }

  // 按 session_key 分组，收集需要回填的 source_id (即 tool 消息的 collector id)
  const toolSourceIdsBySession = new Map<string, Set<string>>();
  for (const row of emptySpawns) {
    if (!toolSourceIdsBySession.has(row.session_key)) {
      toolSourceIdsBySession.set(row.session_key, new Set());
    }
    toolSourceIdsBySession.get(row.session_key)!.add(row.source_id);
  }

  console.log(`Need to backfill ${emptySpawns.length} records across ${toolSourceIdsBySession.size} sessions`);

  // 对每个 session，拉取所有消息，找到 agent 消息中的 sessions_spawn toolCall
  // 然后按时间顺序与 tool 消息配对
  const updateStmt = db.prepare(
    "UPDATE admin_tool_calls SET tool_input = ? WHERE source_id = ? AND tool_name = 'sessions_spawn' AND (tool_input IS NULL OR tool_input='{}')"
  );

  let totalUpdated = 0;

  for (const [sessionKey, toolSourceIds] of toolSourceIdsBySession) {
    // 拉取该 session 的所有消息
    const allMessages: any[] = [];
    let offset = 0;
    while (true) {
      const result = await fetchMessages(sessionKey, offset);
      allMessages.push(...result.messages);
      offset += BATCH_SIZE;
      if (result.messages.length < BATCH_SIZE) break;
      await new Promise(r => setTimeout(r, SLEEP_MS));
    }

    // 按时间排序
    allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // 提取 agent 消息中的 sessions_spawn toolCall input
    // 每条 agent 消息可能有多个 toolCall，提取所有 sessions_spawn 的
    const agentSpawns: ToolCallInfo[] = [];
    for (const msg of allMessages) {
      if (msg.message_type !== 'agent') continue;
      const tools = parseToolsJson(msg.tools_json);
      for (const tool of tools) {
        if (tool.name === 'sessions_spawn' && tool.input && Object.keys(tool.input).length > 0) {
          agentSpawns.push({
            msgId: msg.id,
            sessionKey: msg.session_key,
            timestamp: msg.timestamp,
            input: tool.input,
          });
        }
      }
    }

    // 提取 tool 消息中的 sessions_spawn toolResult
    const toolResults: ToolResultInfo[] = [];
    for (const msg of allMessages) {
      if (msg.message_type !== 'tool') continue;
      const tools = parseToolsJson(msg.tools_json);
      for (const tool of tools) {
        if (tool.name === 'sessions_spawn') {
          let content: any = null;
          try {
            content = msg.content ? JSON.parse(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)) : null;
          } catch {
            // content might be plain text, skip
          }
          toolResults.push({
            msgId: msg.id,
            sessionKey: msg.session_key,
            timestamp: msg.timestamp,
            content,
          });
          break; // 一个 tool 消息通常只有一个 tool
        }
      }
    }

    // 配对：对每个需要回填的 tool source_id，找到对应的 agent spawn
    for (const toolSourceId of toolSourceIds) {
      // 找到这个 tool 消息
      const toolResult = toolResults.find(tr => String(tr.msgId) === toolSourceId);
      if (!toolResult) {
        console.log(`  Warning: tool message ${toolSourceId} not found in collector for session ${sessionKey}`);
        continue;
      }

      const toolTime = new Date(toolResult.timestamp).getTime();

      // 找对应的 agent spawn: 时间在 tool 消息之前，尽可能最近的
      let bestMatch: ToolCallInfo | null = null;
      let bestTimeDiff = Infinity;

      for (const agentSpawn of agentSpawns) {
        const agentTime = new Date(agentSpawn.timestamp).getTime();
        const timeDiff = toolTime - agentTime;

        // agent 消息必须在 tool 消息之前
        if (timeDiff < 0) continue;

        // 5 分钟窗口
        if (timeDiff > 5 * 60 * 1000) continue;

        // 优先选最近的未匹配的
        if (timeDiff < bestTimeDiff) {
          bestTimeDiff = timeDiff;
          bestMatch = agentSpawn;
        }
      }

      if (bestMatch) {
        const inputJson = JSON.stringify(bestMatch.input);
        try {
          const result = updateStmt.run(inputJson, toolSourceId);
          if (result.changes > 0) {
            totalUpdated++;
            console.log(`  Updated source_id=${toolSourceId}: agent_msg=${bestMatch.msgId}, task="${String(bestMatch.input.task || '').slice(0, 60)}..."`);
          }
        } catch (e) {
          console.log(`  DB error for source_id=${toolSourceId}: ${e}`);
        }
      } else {
        console.log(`  No matching agent spawn for tool source_id=${toolSourceId} (time=${toolResult.timestamp})`);
      }
    }
  }

  // ---- 验证 ----
  const afterCount = db.prepare(
    "SELECT COUNT(*) as c FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND tool_input LIKE '%task%'"
  ).get() as { c: number };
  const stillEmpty = db.prepare(
    "SELECT COUNT(*) as c FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND (tool_input IS NULL OR tool_input='{}')"
  ).get() as { c: number };

  console.log(`\nDone! Updated ${totalUpdated} sessions_spawn records.`);
  console.log(`Records with task in tool_input: ${afterCount.c}`);
  console.log(`Records still empty: ${stillEmpty.c}`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
