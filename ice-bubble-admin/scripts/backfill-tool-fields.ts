/**
 * 回填 admin_tool_calls 的 tool_name 和 tool_input
 * 从 collector API 拉取历史 tool 消息，更新 admin.db
 */
import Database from 'better-sqlite3';
import { logger } from '../src/utils/index.js';

const ADMIN_DB = '/mnt/d/workspace/ice-bubble/data/admin.db';
const COLLECTOR_URL = 'http://localhost:13100';
const BATCH_SIZE = 200;
const SLEEP_MS = 100;

async function fetchToolMessages(offset: number): Promise<any[]> {
  const url = `${COLLECTOR_URL}/api/data/messages?message_types=tool&limit=${BATCH_SIZE}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Collector API error: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

async function main() {
  const db = new Database(ADMIN_DB, { readonly: false, timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const totalBefore = db.prepare("SELECT COUNT(*) as c FROM admin_tool_calls WHERE tool_name IS NOT NULL").get() as { c: number };
  console.log(`Before: ${totalBefore.c} records with tool_name`);

  let offset = 0;
  let totalUpdated = 0;
  let totalProcessed = 0;

  while (true) {
    const messages = await fetchToolMessages(offset);
    if (messages.length === 0) break;

    const updateStmt = db.prepare("UPDATE admin_tool_calls SET tool_name = ?, tool_input = ? WHERE source_id = ? AND tool_name IS NULL");

    for (const msg of messages) {
      const tj = msg.tools_json;
      if (!tj) continue;

      try {
        const tools = JSON.parse(typeof tj === 'string' ? tj : JSON.stringify(tj));
        if (!Array.isArray(tools) || tools.length === 0) continue;

        const tool = tools[0];
        if (!tool.name) continue;

        const toolName = tool.name;
        const toolInput = tool.input != null ? JSON.stringify(tool.input) : null;
        const sourceId = String(msg.id);

        try {
          const result = updateStmt.run(toolName, toolInput, sourceId);
          if (result.changes > 0) totalUpdated++;
        } catch (e) {
          // busy, skip and retry next batch
        }
      } catch {
        // skip malformed JSON
      }
      totalProcessed++;
    }

    console.log(`Batch offset=${offset}: processed=${messages.length}, updated so far=${totalUpdated}`);
    offset += BATCH_SIZE;

    if (messages.length < BATCH_SIZE) break;
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }

  const totalAfter = db.prepare("SELECT COUNT(*) as c FROM admin_tool_calls WHERE tool_name IS NOT NULL").get() as { c: number };

  // 输出统计
  const byName = db.prepare("SELECT tool_name, COUNT(*) as c FROM admin_tool_calls WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC").all() as Array<{ tool_name: string; c: number }>;

  console.log(`\nDone! Processed: ${totalProcessed}, Updated: ${totalUpdated}`);
  console.log(`Before: ${totalBefore.c}, After: ${totalAfter.c}`);
  console.log(`\nBy tool_name:`);
  for (const row of byName) {
    console.log(`  ${row.tool_name}: ${row.c}`);
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
