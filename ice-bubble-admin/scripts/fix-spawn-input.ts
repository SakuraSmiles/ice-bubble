import Database from 'better-sqlite3';

const ADMIN_DB = '/mnt/d/workspace/ice-bubble/data/admin.db';
const COLLECTOR_URL = 'http://localhost:13100';
const BATCH = 500;

async function main() {
  const db = new Database(ADMIN_DB, { readonly: false, timeout: 5000 });
  db.pragma('journal_mode = WAL');

  // 1. 从collector拉取所有tool消息
  let offset = 0;
  let fixed = 0;
  let spawnPairs = new Map<number, any>(); // session_key排序，存储有input的spawn

  while (true) {
    const res = await fetch(`${COLLECTOR_URL}/api/data/messages?message_types=tool&limit=${BATCH}&offset=${offset}`);
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0) break;

    for (const m of msgs) {
      const tj = m.tools_json;
      if (!tj) continue;
      const tools = JSON.parse(typeof tj === 'string' ? tj : JSON.stringify(tj));
      for (const t of tools) {
        if (t.name !== 'sessions_spawn') continue;
        const inp = t.input;
        if (inp && typeof inp === 'object' && inp.task) {
          // 这条有完整的input
          const sourceId = String(m.id);
          const toolInput = JSON.stringify(inp);
          
          const existing = db.prepare("SELECT tool_input FROM admin_tool_calls WHERE source_id = ?").get(sourceId) as any;
          if (existing && (!existing.tool_input || existing.tool_input === '{}')) {
            db.prepare("UPDATE admin_tool_calls SET tool_input = ?, tool_name = 'sessions_spawn' WHERE source_id = ?").run(toolInput, sourceId);
            fixed++;
          }
        }
      }
    }
    offset += BATCH;
    if (msgs.length < BATCH) break;
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`Fixed ${fixed} sessions_spawn records with tool_input`);

  // 2. 重新运行task-parser
  const { TaskParser } = await import('../src/data/task-parser.js');
  const parser = new TaskParser(db);
  const tasks = parser.parseSessionsSpawnRecords();
  console.log(`Parsed ${tasks.length} sessions_spawn records`);
  
  if (tasks.length > 0) {
    // 先清除旧数据
    db.prepare("DELETE FROM admin_tasks").run();
    const inserted = parser.upsertTasks(tasks);
    console.log(`Upserted ${inserted} tasks`);

    const sample = db.prepare("SELECT id, title, status, agent_id FROM admin_tasks ORDER BY created_at DESC LIMIT 10").all();
    console.log("\nSample tasks:");
    for (const t of sample as any[]) {
      console.log(`  [${t.status}] ${(t.agent_id || '???').padEnd(8)} ${(t.title || '').slice(0, 70)}`);
    }

    const stats = db.prepare("SELECT status, COUNT(*) as c FROM admin_tasks GROUP BY status").all();
    console.log("\nStats:", JSON.stringify(stats));
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
