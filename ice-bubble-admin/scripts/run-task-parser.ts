import Database from 'better-sqlite3';
import { TaskParser } from '../src/data/task-parser.js';

const db = new Database('/mnt/d/workspace/ice-bubble/data/admin.db', { readonly: false, timeout: 10000 });
db.pragma('journal_mode = WAL');

const parser = new TaskParser(db);
const tasks = parser.parseSessionsSpawnRecords();
console.log(`Parsed ${tasks.length} sessions_spawn records`);

if (tasks.length > 0) {
  const inserted = parser.upsertTasks(tasks);
  console.log(`Upserted ${inserted} tasks`);
  
  const sample = db.prepare("SELECT id, title, status, agent_id, child_session_key FROM admin_tasks ORDER BY created_at DESC LIMIT 5").all();
  console.log("\nSample tasks:");
  for (const t of sample as any[]) {
    console.log(`  [${t.status}] ${t.agent_id}: ${(t.title || '').slice(0, 60)}`);
  }
  
  const stats = db.prepare("SELECT status, COUNT(*) as c FROM admin_tasks GROUP BY status").all();
  console.log("\nStats:", stats);
}

db.close();
