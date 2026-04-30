/**
 * 回填 admin_tasks 中 title = 'Untitled Task' 的记录
 *
 * 根因：processor.ts 只处理 tool 类型消息，sessions_spawn 的 task/agentId/mode
 * 实际存储在 collector 的 agent 类型消息的 tools_json 字段中，
 * 导致 admin_tool_calls 的 tool_input 为空，task-parser 解析出 "Untitled Task"。
 *
 * 修复方式：
 * 1. 从 collector agent 消息中提取 sessions_spawn 的 {task, agentId, mode}
 * 2. 通过 childSessionKey（tool 消息 content 中的 UUID）匹配 admin_tasks 记录
 * 3. 只更新 title = 'Untitled Task' 的记录，不覆盖已有数据
 */
import Database from 'better-sqlite3';
const ADMIN_DB = '/mnt/d/workspace/ice-bubble/data/admin.db';
const COLLECTOR_DB = '/mnt/d/workspace/ice-bubble/data/collector.db';

function parseToolsJson(toolsJson: unknown): Array<{ name?: string; input?: unknown }> {
  if (!toolsJson) return [];
  try {
    const tools = typeof toolsJson === 'string' ? JSON.parse(toolsJson) : toolsJson;
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

interface AgentSpawnInfo {
  sessionKey: string;
  timestamp: string;
  task: string;
  agentId: string;
  mode: string;
}

interface ToolMsgInfo {
  msgId: number;
  sessionKey: string;
  timestamp: string;
  childSessionKey: string;
  runId: string;
}

function main() {
  const adminDb = new Database(ADMIN_DB, { readonly: false, timeout: 5000 });
  adminDb.pragma('journal_mode = WAL');
  adminDb.pragma('busy_timeout = 5000');

  const collectorDb = new Database(COLLECTOR_DB, { readonly: true, timeout: 5000 });
  collectorDb.pragma('journal_mode = WAL');
  collectorDb.pragma('busy_timeout = 5000');

  // ---- Phase 1: 找到所有需要回填的 admin_tasks 记录 ----
  const untitledTasks = adminDb.prepare(`
    SELECT id, title, agent_id, child_session_key, run_id, requester_session_key, created_at
    FROM admin_tasks
    WHERE title = 'Untitled Task'
    ORDER BY created_at DESC
  `).all() as Array<{
    id: string;
    title: string;
    agent_id: string;
    child_session_key: string;
    run_id: string;
    requester_session_key: string;
    created_at: string;
  }>;

  console.log(`Found ${untitledTasks.length} admin_tasks records with title = 'Untitled Task'`);
  if (untitledTasks.length === 0) {
    adminDb.close();
    collectorDb.close();
    return;
  }

  // ---- Phase 2: 从 collector 提取所有 sessions_spawn agent 消息 ----
  // 按 session_key 分组收集 tool 消息（提供 childSessionKey 和 runId）
  const agentSpawnsBySession = new Map<string, AgentSpawnInfo[]>();
  const toolMsgsBySession = new Map<string, ToolMsgInfo[]>();

  const collectorMessages = collectorDb.prepare(`
    SELECT id, session_key, message_type, tools_json, content, timestamp
    FROM messages
    WHERE message_type IN ('agent', 'tool')
      AND tools_json IS NOT NULL
      AND tools_json != ''
      AND tools_json != '[]'
    ORDER BY timestamp ASC
  `).all() as Array<{
    id: number;
    session_key: string;
    message_type: string;
    tools_json: string;
    content: string;
    timestamp: string;
  }>;

  console.log(`Loaded ${collectorMessages.length} agent/tool messages from collector`);

  for (const msg of collectorMessages) {
    const tools = parseToolsJson(msg.tools_json);
    const spawnTool = tools.find(t => t.name === 'sessions_spawn');

    if (msg.message_type === 'agent' && spawnTool && spawnTool.input) {
      const input = spawnTool.input as { task?: string; agentId?: string; mode?: string };
      if (!agentSpawnsBySession.has(msg.session_key)) {
        agentSpawnsBySession.set(msg.session_key, []);
      }
      agentSpawnsBySession.get(msg.session_key)!.push({
        sessionKey: msg.session_key,
        timestamp: msg.timestamp,
        task: input.task || '',
        agentId: input.agentId || '',
        mode: input.mode || '',
        childSessionKey: '', // 暂时为空，等配对时从 tool 消息获取
      });
    } else if (msg.message_type === 'tool' && spawnTool) {
      // tool 消息的 content 有 {childSessionKey, runId}
      let contentObj: { childSessionKey?: string; runId?: string } = {};
      try {
        if (msg.content) {
          contentObj = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        }
      } catch { /* ignore */ }

      if (!toolMsgsBySession.has(msg.session_key)) {
        toolMsgsBySession.set(msg.session_key, []);
      }
      toolMsgsBySession.get(msg.session_key)!.push({
        msgId: msg.id,
        sessionKey: msg.session_key,
        timestamp: msg.timestamp,
        childSessionKey: contentObj.childSessionKey || '',
        runId: contentObj.runId || '',
      });
    }
  }

  // ---- Phase 3: 配对 agent spawn 和 tool 消息，建立 childSessionKey -> spawnInfo 映射 ----
  const childSessionKeyToSpawn = new Map<string, { task: string; agentId: string; mode: string }>();

  for (const [sessionKey, agentSpawns] of agentSpawnsBySession) {
    const toolMsgs = toolMsgsBySession.get(sessionKey) || [];

    // 按时间排序
    agentSpawns.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    toolMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // 对每个 agent spawn，找最近的 tool 消息（时间在 agent 之后，5分钟窗口内）
    for (const spawn of agentSpawns) {
      const agentTime = new Date(spawn.timestamp).getTime();

      // 找时间在 agent 之后最近的 tool 消息
      let bestMatch: ToolMsgInfo | null = null;
      let bestTimeDiff = Infinity;

      for (const toolMsg of toolMsgs) {
        const toolTime = new Date(toolMsg.timestamp).getTime();
        const timeDiff = toolTime - agentTime;
        if (timeDiff < 0) continue;         // 必须在 agent 之后
        if (timeDiff > 5 * 60 * 1000) continue; // 5分钟窗口
        if (timeDiff < bestTimeDiff) {
          bestTimeDiff = timeDiff;
          bestMatch = toolMsg;
        }
      }

      if (bestMatch && bestMatch.childSessionKey) {
        childSessionKeyToSpawn.set(bestMatch.childSessionKey, {
          task: spawn.task,
          agentId: spawn.agentId,
          mode: spawn.mode,
        });
      }
    }
  }

  console.log(`Matched ${childSessionKeyToSpawn.size} childSessionKey -> spawn info`);

  // ---- Phase 4: 更新 admin_tasks ----
  const updateStmt = adminDb.prepare(`
    UPDATE admin_tasks
    SET title = ?,
        agent_id = ?,
        mode = COALESCE(NULLIF(?, ''), mode),
        task_description = CASE
          WHEN ? != '' AND (task_description IS NULL OR task_description = '') THEN ?
          ELSE task_description
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND title = 'Untitled Task'
  `);

  let totalUpdated = 0;

  for (const task of untitledTasks) {
    // 优先通过 child_session_key 匹配（最精确）
    let spawnInfo = childSessionKeyToSpawn.get(task.child_session_key);

    // 备选：通过 run_id 在 tool 消息中查找
    if (!spawnInfo && task.run_id) {
      for (const [, toolMsgs] of toolMsgsBySession) {
        const toolMsg = toolMsgs.find(t => t.runId === task.run_id);
        if (toolMsg) {
          const agentSpawns = agentSpawnsBySession.get(toolMsg.sessionKey) || [];
          // 找时间最接近的 agent spawn
          const toolTime = new Date(toolMsg.timestamp).getTime();
          let bestSpawn: AgentSpawnInfo | null = null;
          let bestDiff = Infinity;
          for (const spawn of agentSpawns) {
            const diff = Math.abs(toolTime - new Date(spawn.timestamp).getTime());
            if (diff < bestDiff && diff <= 5 * 60 * 1000) {
              bestDiff = diff;
              bestSpawn = spawn;
            }
          }
          if (bestSpawn) {
            spawnInfo = {
              task: bestSpawn.task,
              agentId: bestSpawn.agentId,
              mode: bestSpawn.mode,
            };
          }
          break;
        }
      }
    }

    if (!spawnInfo) {
      console.log(`  No spawn info for task id=${task.id} (child_session_key=${task.child_session_key}, run_id=${task.run_id})`);
      continue;
    }

    if (!spawnInfo.task && !spawnInfo.agentId) {
      console.log(`  Spawn info found but empty for task id=${task.id}`);
      continue;
    }

    const newTitle = extractTitle(spawnInfo.task) || task.title;
    try {
      const result = updateStmt.run(
        newTitle,
        spawnInfo.agentId || task.agent_id,
        spawnInfo.mode || '',
        spawnInfo.task || '',
        spawnInfo.task || '',
        task.id
      );
      if (result.changes > 0) {
        totalUpdated++;
        console.log(`  Updated id=${task.id}: title="${newTitle}", agent_id="${spawnInfo.agentId}"`);
      }
    } catch (e) {
      console.log(`  DB error for id=${task.id}: ${e}`);
    }
  }

  // ---- 验证 ----
  const afterUntitled = adminDb.prepare(
    "SELECT COUNT(*) as c FROM admin_tasks WHERE title = 'Untitled Task'"
  ).get() as { c: number };

  const afterWithAgent = adminDb.prepare(
    "SELECT COUNT(*) as c FROM admin_tasks WHERE title != 'Untitled Task' AND agent_id != '' AND agent_id IS NOT NULL"
  ).get() as { c: number };

  console.log(`\nDone! Updated ${totalUpdated} admin_tasks records.`);
  console.log(`Records still Untitled: ${afterUntitled.c}`);
  console.log(`Records with title and agent_id: ${afterWithAgent.c}`);

  adminDb.close();
  collectorDb.close();
}

function extractTitle(taskDescription: string): string {
  if (!taskDescription) return '';
  const firstLine = taskDescription.split('\n')[0].trim();
  if (!firstLine) return '';

  // ## 任务：xxx
  const taskMatch = firstLine.match(/^##\s*任务[：:]\s*(.+)/);
  if (taskMatch) return taskMatch[1].trim();

  // # agent: xxx 或 # xxx
  const h1Match = firstLine.match(/^#\s+(.+)/);
  if (h1Match) {
    const rest = h1Match[1].trim();
    const agentPrefixMatch = rest.match(/^[\w-]+:\s*(.+)/);
    if (agentPrefixMatch) return agentPrefixMatch[1].trim();
    return rest;
  }

  // [PARENT] xxx 等方括号前缀
  const bracketMatch = firstLine.match(/^\[[A-Z]+\]\s*(.+)/);
  if (bracketMatch) return bracketMatch[1].trim();

  // 身份+任务描述格式
  const actionMatch = firstLine.match(/(?:执行|完成)\s*(.+)/);
  if (actionMatch && firstLine.includes('。')) {
    return actionMatch[1].replace(/。$/, '').trim();
  }
  const periodMatch = firstLine.match(/。\s*(.+)/);
  if (periodMatch) return periodMatch[1].trim();

  // 请xxx 开头
  if (firstLine.startsWith('请')) return firstLine;

  // 其他
  if (firstLine.length > 40) {
    return firstLine.substring(0, 40) + '…';
  }
  return firstLine;
}

main();
