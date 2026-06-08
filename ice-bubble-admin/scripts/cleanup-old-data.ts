/**
 * 数据清理脚本 — 删除/归档 N 天前的旧数据
 *
 * 用法:
 *   npx tsx scripts/cleanup-old-data.ts [--days 3] [--db ./data/admin.db] [--no-reset] [--vacuum]
 *
 * 功能:
 *   1. 将 N 天前的 admin_messages 归档到 admin_messages_archive
 *   2. 删除已归档的 messages
 *   3. 删除 N 天前的 tool_calls 和 model_events
 *   4. 清理 orphan sessions
 *   5. 重置同步游标（让同步从头开始）
 *   6. 可选执行 VACUUM
 */

import Database from 'better-sqlite3';
import { resolve, join } from 'path';

// Parse args
const args = process.argv.slice(2);
let daysOld = 3;
let dbPath = resolve(__dirname, '..', 'data', 'admin.db');
let resetCursors = true;
let doVacuum = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) { daysOld = parseInt(args[i + 1], 10); i++; }
  if (args[i] === '--db' && args[i + 1]) { dbPath = resolve(args[i + 1]); i++; }
  if (args[i] === '--no-reset') { resetCursors = false; }
  if (args[i] === '--vacuum') { doVacuum = true; }
}

console.log(`[Cleanup] Starting: daysOld=${daysOld}, db=${dbPath}, resetCursors=${resetCursors}, vacuum=${doVacuum}`);

const db = new Database(dbPath, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - daysOld);
const cutoffStr = cutoff.toISOString();

const t0 = Date.now();
const results: Record<string, number> = {};

// 1. Archive old messages
console.log(`[Cleanup] Archiving messages before ${cutoffStr}...`);
const archiveResult = db.prepare(`
  INSERT OR IGNORE INTO admin_messages_archive
    (source_id, source_module, session_key, message_type, content, model,
     tokens_input, tokens_output, cost_total, cost_input, cost_output,
     is_system_context, timestamp, created_at, source_created_at, archived_at)
  SELECT
    source_id, source_module, session_key, message_type, content, model,
    tokens_input, tokens_output, cost_total, cost_input, cost_output,
    is_system_context, timestamp, created_at, source_created_at, datetime('now')
  FROM admin_messages
  WHERE timestamp < ?
`).run(cutoffStr);
results.archivedMessages = archiveResult.changes;
console.log(`[Cleanup] Archived ${archiveResult.changes} messages`);

// 2. Delete archived messages
const delMsgResult = db.prepare(`DELETE FROM admin_messages WHERE timestamp < ?`).run(cutoffStr);
results.deletedMessages = delMsgResult.changes;
console.log(`[Cleanup] Deleted ${delMsgResult.changes} messages`);

// 3. Delete old tool_calls
const delToolResult = db.prepare(`DELETE FROM admin_tool_calls WHERE created_at < ?`).run(cutoffStr);
results.deletedToolCalls = delToolResult.changes;
console.log(`[Cleanup] Deleted ${delToolResult.changes} tool_calls`);

// 4. Delete old model_events
const delEventsResult = db.prepare(`DELETE FROM admin_model_events WHERE timestamp < ?`).run(cutoffStr);
results.deletedModelEvents = delEventsResult.changes;
console.log(`[Cleanup] Deleted ${delEventsResult.changes} model_events`);

// 5. Rebuild session message counts
db.exec(`
  UPDATE admin_sessions SET message_count = (
    SELECT COUNT(*) FROM admin_messages WHERE admin_messages.session_key = admin_sessions.session_key
  )
`);

// 6. Delete orphan sessions
const delSessionsResult = db.prepare(`
  DELETE FROM admin_sessions
  WHERE session_key NOT IN (SELECT DISTINCT session_key FROM admin_messages)
`).run();
results.deletedSessions = delSessionsResult.changes;
console.log(`[Cleanup] Deleted ${delSessionsResult.changes} orphan sessions`);

// 7. Reset sync cursors
if (resetCursors) {
  const resetResult = db.prepare(`UPDATE sync_progress SET last_sync_time = NULL, last_sync_id = 0, updated_at = CURRENT_TIMESTAMP`).run();
  results.cursorsReset = resetResult.changes;
  console.log(`[Cleanup] Reset ${resetResult.changes} sync cursors`);
}

// 8. Vacuum
if (doVacuum) {
  console.log('[Cleanup] Running VACUUM...');
  db.exec('VACUUM');
}

// Summary
const elapsed = Date.now() - t0;
console.log(`\n[Cleanup] Completed in ${elapsed}ms`);