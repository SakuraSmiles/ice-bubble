/**
 * Fix 5 blank tasks in admin_tasks (title=Untitled Task, agent_id empty)
 * 
 * These 5 tasks were missed by the backfill script because the collector
 * restarted and message IDs changed. This script manually fixes them using
 * data found in the collector's SQLite database.
 * 
 * Run: cd /mnt/d/workspace/ice-bubble/ice-bubble-admin && npx tsx scripts/fix-empty-tasks.ts
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_DB = '/mnt/d/workspace/ice-bubble/data/admin.db';
const COLLECTOR_DB = '/mnt/d/workspace/ice-bubble/data/collector-dev.db';

// The 5 blank task runIds and their corrected data
const FIXES: Record<string, { agent_id: string; task: string }> = {
  'fea10fa0-4649-4029-a9e7-0076835d321a': {
    agent_id: 'dev',
    task: `你是ice-bubble-admin的后端开发工程师。需要修复一个关键的数据回填问题。

## 问题
admin_tool_calls中的sessions_spawn记录，tool_input字段大部分是\`{}\`（空对象），导致task-parser无法提取任务描述和agent_id。

### 根因
collector中sessions_spawn的数据分两种消息：
1. **assistant消息（message_type=agent）**：包含toolCalls，有\`tools_json\`，其中\`input\`有完整的{task, agentId, mode}，但\`result\`为空（因为spawn是异步的）
2. **toolResult消息（message_type=tool）**：包含tool_result，\`tools_json\`中\`input\`为空，但\`content\`有{childSessionKey, runId}

之前的回填脚本只查了\`message_types=tool\`，漏掉了agent消息中的toolCall input。

### 你的任务

修改回填脚本\`/mnt/d/workspace/ice-bubble/ice-bubble-admin/scripts/backfill-tool-fields.ts\`，使其能正确回填sessions_spawn的tool_input：

#### 方案
1. 先从collector拉取所有agent类型消息，提取sessions_spawn的toolCall信息（按session_key索引）
2. 每条toolCall有：session_key, timestamp, input{task, agentId, mode}, result{runId}
3. 然后从collector拉取所有tool类型消息，提取sessions_spawn的toolResult信息
4. **配对逻辑**：同一session_key内，按时间顺序，assistant消息在前，toolResult消息在后。匹配条件：
   - 如果toolCall有result.runId，按runId在toolResult.content中匹配
   - 如果没有runId，按时间窗口匹配（同一session_key，tool消息在assistant消息之后5分钟内）
5. 将匹配到的toolCall的input写入admin_tool_calls的tool_input字段

#### 验证
回填完成后：
\`\`\`bash
sqlite3 /mnt/d/workspace/ice-bubble/data/admin.db "SELECT COUNT(*) FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND tool_input LIKE '%task%';"
\`\`\`
期望结果应该是40+条。

然后重新运行task-parser：
\`\`\`bash
cd /mnt/d/workspace/ice-bubble/ice-bubble-admin && npx tsx scripts/run-task-parser.ts
\`\`\`
期望结果：任务有正确的title和agent_id，不再是"Untitled Task"和null。

### 注意
- admin.db可能被admin服务锁定。如果锁定，脚本中加retry逻辑（busy_timeout=5000）。
- collector API：\`http://localhost:13100\`
- admin.db路径：\`/mnt/d/workspace/ice-bubble/data/admin.db\`
- 脚本要幂等（重复运行安全）`,
  },
  '6305e926-ca03-4712-ac17-8d7311e92291': {
    agent_id: 'dev3',
    task: `你是ice-bubble-desktop的前端开发工程师。执行P1任务：在Overview左侧面板实现任务列表。

## 背景
我们要在Overview页面左侧展示任务列表（替代之前移走的系统健康卡片）。后端API已就绪：

\`\`\`
GET http://localhost:13000/api/tasks          → 任务列表
GET http://localhost:13000/api/tasks/:id      → 单个任务
\`\`\`

需要显示的内容：
- 任务标题（title）
- 状态标签（status: running/completed/failed）
- 创建时间（created_at）
- agent_id（哪个agent执行的）

## 技术方案
使用Element Plus的组件：
- el-card 作为容器
- el-tag 作为状态标签（running=blue, completed=green, failed=red）
- 支持滚动（max-height）

## 验收标准
- 任务列表能正常显示（调用Admin API）
- 状态标签颜色正确
- 列表根据任务数量自适应高度`,
  },
  'ad720587-37cd-42e0-b87a-d92fda3b93fb': {
    agent_id: 'dev',
    task: `你是ice-bubble-admin的后端开发工程师。执行P2任务：将task-parser集成到admin定时同步中 + 修复running状态。

## 任务1：在DataSync中集成TaskParser

文件：\`/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/data-sync.ts\`

在\`syncAll()\`方法中，消息同步完成后，调用TaskParser.refreshTasks()来刷新任务数据。

## 任务2：修复running状态

当subagent运行时，对应任务应该显示running状态。但目前即使subagent在运行，任务状态可能还是completed。

原因：task-parser从admin_sessions表的状态判断任务状态，但如果subagent的session被清理了，状态会变成completed。

方案：从OpenClaw的runs.json读取当前活跃的run，将对应任务标记为running。

## 文件
- \`/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/task-parser.ts\`（已实现，需添加refreshTasks方法）
- \`/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/data-sync.ts\`（需集成）

## 验证
运行后：
\`\`\`bash
sqlite3 /mnt/d/workspace/ice-bubble/data/admin.db "SELECT id, title, status FROM admin_tasks WHERE status='running';"
\`\`\`
应该能看到当前正在运行的subagent任务。`,
  },
  'fa4b2404-8f5f-4557-b2b9-0bd646010a4c': {
    agent_id: 'tester',
    task: `你是ice-bubble项目的测试工程师。对Task模块迁移到Admin的改动进行全面回归验证。

## 背景
我们将任务数据合并到Admin中（原独立 task 模块已废弃）。改动涉及：
- admin_tool_calls表增加tool_name/tool_input列
- 新增admin_tasks表
- 新增task-parser（从sessions_spawn推导任务）
- Admin API新增 /api/tasks 端点

## 验证项

### 1. 构建验证
\`\`\`bash
cd /mnt/d/workspace/ice-bubble/ice-bubble-admin && npx tsc --noEmit
cd /mnt/d/workspace/ice-bubble/ice-bubble-desktop && npx vue-tsc --noEmit
\`\`\`

### 2. 数据库验证
\`\`\`bash
sqlite3 /mnt/d/workspace/ice-bubble/data/admin.db "SELECT COUNT(*) FROM admin_tasks;"
sqlite3 /mnt/d/workspace/ice-bubble/data/admin.db "SELECT COUNT(*) FROM admin_tool_calls WHERE tool_name='sessions_spawn';"
\`\`\`

### 3. API验证
\`\`\`bash
curl http://localhost:13000/api/tasks?limit=5 | jq '.'
\`\`\`

### 4. 功能验证
- [ ] 任务列表能显示
- [ ] 任务状态正确（running/completed/failed）
- [ ] 任务详情页能打开
- [ ] 无console.error

## 输出格式
\`\`\`
## tester 回归报告

### 构建
admin: ✅/❌ error
desktop: ✅/❌ error

### 数据库
admin_tasks: N 条
sessions_spawn: N 条

### API
/api/tasks: ✅/❌

### 功能
- [ ] 任务列表
- [ ] 任务状态
- [ ] 任务详情
- [ ] 无console.error

### 结论
✅ 可合并 / ❌ 问题列表
\`\`\``,
  },
  '2586ae6c-0162-40a7-8064-0a8432f7fe42': {
    agent_id: 'dev',
    task: `优化ice-bubble-desktop的任务列表组件样式和标题展示。

## 文件
\`/mnt/d/workspace/ice-bubble/ice-bubble-desktop/src/views/components/TaskList.vue\`

## 当前问题

### 1. 标题展示优化
当前title字段是完整的task描述（有时几百字），直接显示太长。需要智能截取：
- 提取第一行作为主标题（如果是"## 任务：xxx"格式，取冒号后的内容）
- 如果第一行超过30字符，截断加省略号
- 完整描述放到展开详情中显示
- hover tooltip显示完整第一行

### 2. 状态标签优化
当前状态用文字显示，可以改成el-tag：
- running: <el-tag type="warning">运行中</el-tag>
- completed: <el-tag type="success">已完成</el-tag>
- failed: <el-tag type="danger">失败</el-tag>

### 3. 时间显示
created_at 显示格式优化：
- 24小时内：显示"X小时前"
- 超过24小时：显示"MM-DD HH:mm"

## 技术要求
- 不改变API调用逻辑
- TypeScript严格
- 样式与现有组件一致（el-card, el-tag等Element Plus组件）
- 构建验证：\`cd /mnt/d/workspace/ice-bubble/ice-bubble-desktop && npm run build\``,
  },
};

function extractTitle(task: string): string {
  const firstLine = task.split('\n')[0].trim();
  
  // ## 任务：xxx
  if (firstLine.startsWith('## 任务：')) {
    return firstLine.substring(5).trim();
  }
  // ## 任务: xxx (English colon)
  if (firstLine.startsWith('## 任务:')) {
    return firstLine.substring(5).trim();
  }
  // # agent: xxx or # xxx：xxx
  if (firstLine.startsWith('# ')) {
    const rest = firstLine.substring(2);
    // # agent: xxx
    if (rest.startsWith('agent: ')) {
      return rest.substring(7).trim();
    }
    // # xxx：xxx (full-width colon)
    const colonIdx = rest.indexOf('：');
    if (colonIdx > 0) {
      return rest.substring(colonIdx + 1).trim();
    }
    return rest;
  }
  // [PARENT] xxx or [TODO] xxx
  if (firstLine.startsWith('[')) {
    const endBracket = firstLine.indexOf(']');
    if (endBracket > 0) {
      return firstLine.substring(endBracket + 1).trim();
    }
  }
  // 你是xxx。执行xxx。格式
  if (firstLine.startsWith('你是')) {
    const execMatch = firstLine.match(/执行(P\d+)?任务：(.+)/);
    if (execMatch) return execMatch[2].trim();
    const dotIdx = firstLine.indexOf('。');
    if (dotIdx > 0 && dotIdx < 50) {
      return firstLine.substring(dotIdx + 1).trim();
    }
  }
  // 请xxx开头
  if (firstLine.startsWith('请')) {
    return firstLine;
  }
  // 其他：截断
  if (firstLine.length > 40) {
    return firstLine.substring(0, 40) + '…';
  }
  return firstLine;
}

function main() {
  console.log('=== Fix 5 blank tasks ===\n');

  const adminDb = new Database(ADMIN_DB, { readonly: false });
  adminDb.pragma('busy_timeout = 5000');

  let fixed = 0;
  for (const [runId, data] of Object.entries(FIXES)) {
    const title = extractTitle(data.task);
    
    // Check current state
    const row = adminDb.prepare(`
      SELECT id, title, agent_id FROM admin_tasks WHERE run_id = ?
    `).get(runId) as { id: string; title: string; agent_id: string } | undefined;

    if (!row) {
      console.log(`[SKIP] ${runId}: not found in admin_tasks`);
      continue;
    }

    console.log(`\n=== ${runId} ===`);
    console.log(`  Before: title="${row.title}", agent_id="${row.agent_id}"`);
    console.log(`  After:  title="${title}", agent_id="${data.agent_id}"`);

    // Update admin_tasks
    const result = adminDb.prepare(`
      UPDATE admin_tasks 
      SET title = ?, agent_id = ?, task_description = ?, mode = 'run', updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
    `).run(title, data.agent_id, data.task, runId);

    if (result.changes > 0) {
      fixed++;
      console.log(`  ✅ admin_tasks updated`);
    } else {
      console.log(`  ⚠️  no changes`);
    }

    // Also update admin_tool_calls for this runId (the sessions_spawn record)
    const tcResult = adminDb.prepare(`
      UPDATE admin_tool_calls
      SET tool_input = ?
      WHERE content LIKE '%' || ? || '%'
      AND tool_name = 'sessions_spawn'
    `).run(JSON.stringify({ agentId: data.agent_id, mode: 'run', task: data.task }), runId);

    if (tcResult.changes > 0) {
      console.log(`  ✅ admin_tool_calls updated`);
    } else {
      console.log(`  ⚠️  admin_tool_calls not updated (may already have data)`);
    }
  }

  console.log(`\n=== Summary: fixed ${fixed}/5 tasks ===`);

  // Verify
  const remaining = adminDb.prepare(`
    SELECT id, title, agent_id FROM admin_tasks WHERE title = 'Untitled Task'
  `).all();
  console.log(`\nRemaining Untitled Tasks: ${remaining.length}`);

  adminDb.close();
}

main();

// Additional tasks from the same spawn batch (today 00:20)
// These also have blank tool_input because they were spawned after the backfill ran
const ADDITIONAL_FIXES: Record<string, { agent_id: string; task: string }> = {
  'dd5b3cde-96ed-4595-b502-ec18e10cc073': {
    agent_id: 'dev',
    task: `优化task-parser的任务标题提取逻辑。

## 文件
\`/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/task-parser.ts\`

## 当前问题
admin_tasks表的title字段直接存的是tool_input.task的完整第一行，格式混乱。需要封装一个标题提取函数，在parseSessionsSpawnRecords中生成更简洁的标题。

## 当前title的几种格式（示例）
1. \`# dev: admin API 合并逻辑 — getMessages / getMessagesTimeline / saveMessages\`
2. \`## 任务：实现 Agent 状态系统\`
3. \`[PARENT] 创建任务模块\`
4. \`[TODO] Desktop Overview 接入 Task API\`
5. \`请实现任务展示优化，按最新一次任务分组展示。\`
6. \`你是ice-bubble-admin的后端开发工程师。执行历史数据回填任务。\\n\\n## 任务：...\`
7. \`# 系统状态卡片：数据层设计方案\`

## 提取规则（extractTitle函数）
按优先级处理：
1. 如果是\`## 任务：xxx\`格式 → 取冒号后的内容，去掉前后空白
2. 如果是\`# agent: xxx\`或\`# xxx：xxx\`格式 → 去掉\`# \`前缀和agent前缀
3. 如果是\`[PARENT] xxx\`或\`[TODO] xxx\`格式 → 去掉方括号前缀
4. 如果是\`你是xxx。执行xxx。\`格式（身份+任务描述）→ 取"执行"或"完成"之后的内容，如果找不到则取第一个句号后的内容
5. 如果是\`请xxx\`开头 → 直接取
6. 其他 → 取第一行，如果超过40字符截断加\`…\`

## 实现位置
在task-parser.ts中新增一个\`private extractTitle(taskDescription: string): string\`方法，在parseSingleRecord中调用它生成title。task_description字段保持原始值不变。

## 修改后重新运行
\`\`\`bash
cd /mnt/d/workspace/ice-bubble/ice-bubble-admin && npx tsx scripts/run-task-parser.ts
\`\`\`
验证输出中title不再有\`# \`、\`## 任务：\`、\`[PARENT]\`等前缀。

## 构建验证
\`\`\`bash
cd /mnt/d/workspace/ice-bubble/ice-bubble-admin && npx tsc --noEmit
\`\`\``,
  },
  'f5fff672-45e9-47af-81a2-2b23807b3af3': {
    agent_id: 'dev3',
    task: `修改TaskList组件，让任务列表根据页面高度动态调整展示数量，不再出现滚动条。

## 文件
\`/mnt/d/workspace/ice-bubble/ice-bubble-desktop/src/views/components/TaskList.vue\`

## 当前问题
任务列表硬编码请求\`limit=50\`条数据，超出左侧面板高度时出现滚动条。需要改成根据容器高度动态计算。

## 方案

### 1. 动态limit
- 任务行高度大约32px（padding 6px*2 + 内容20px）
- 展开详情大约80px，统计栏约36px
- 用ResizeObserver监听容器高度变化
- 计算公式：\`limit = Math.floor((containerHeight - headerHeight) / rowHeight)\`，减去一些buffer
- 默认limit最小为5，最大不超过20（避免请求太多）

### 2. API调用
当前：\`\${ADMIN_API_BASE}/api/tasks?limit=50&offset=0\`
改为：\`\${ADMIN_API_BASE}/api/tasks?limit=\${dynamicLimit}&offset=0\`

### 3. 容器样式
- 任务列表容器设\`overflow: hidden\`，不再内部滚动
- 如果任务多，显示"N 更多"的提示
- 统计栏始终固定在顶部

## 重要约束
- **不要修改样式风格**（不要加色条、改标签样式等，只做动态数量适配）
- 不修改StatusDropdown.vue
- 保持30秒自动刷新
- TypeScript严格
- 构建验证：\`cd /mnt/d/workspace/ice-bubble/ice-bubble-desktop && npm run build\``,
  },
};
