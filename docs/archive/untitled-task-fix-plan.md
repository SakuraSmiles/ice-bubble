# Untitled Task 问题修复方案

## 一、根因确认

### 问题现象
`admin_tasks` 中大量任务 title 为 "Untitled Task"，agent_id 为空。

### 直接原因
`processor.ts` 的 `processMessage` 函数**只从 `message_type === 'tool'` 的消息中提取 `tool_name` 和 `tool_input`**：

```typescript
// processor.ts 当前逻辑
if (row.message_type === 'tool' && row.tools_json) {
  const tools = JSON.parse(row.tools_json);
  if (tools.length > 0 && tools[0].name) {
    tool_name = tools[0].name;
    tool_input = tools[0].input != null ? JSON.stringify(tools[0].input) : null;
  }
}
```

### sessions_spawn 的数据分布特点

`sessions_spawn` 的数据分散在**两条消息**中：

| 消息类型 | `tools_json[0].input` | `content` |
|---------|----------------------|-----------|
| **agent** | ✅ 有完整 `{task, agentId, mode}` | 空 |
| **tool** | ❌ `{}`（空） | `{childSessionKey, runId}` |

agent 消息包含 `tools_json`，其中 `tools_json[0].input` 有完整的 task/agentId/mode。
tool 消息的 `tools_json[0].input` 是空的，结果在 `content` 字段中。

由于 processor 只处理 tool 消息，`admin_tool_calls` 中所有 sessions_spawn 的 `tool_input` 都是 `{}`，
导致 `task-parser.ts` 的 `parseSingleRecord` 解析出空 task → "Untitled Task"。

### 数据已部分修复
`backfill-tool-fields.ts` 脚本已通过 collector API 配对 agent/tool 消息，
回填了现有 `admin_tool_calls` 记录的 `tool_input`。**历史79条记录问题已解决**。

---

## 二、修复方案

### 方案一：在 processor.ts 中处理 agent 类型消息（推荐）

#### 核心思路
在 `processMessage` 中，对 `message_type === 'agent'` 的消息，
如果 `tools_json` 中包含 `sessions_spawn` 调用，额外提取其 `tool_input`，
**更新对应 tool 消息在 `admin_tool_calls` 中的记录**。

#### 实现步骤

**Step 1：在 `processMessage` 中，对 agent 消息提取 sessions_spawn 的 tool_input**

```typescript
// 当 message_type === 'agent' 时，提取 sessions_spawn 的 tool_input
if (row.message_type === 'agent' && row.tools_json) {
  try {
    const tools = JSON.parse(row.tools_json) as Array<{ name?: string; input?: unknown }>;
    for (const tool of tools) {
      if (tool.name === 'sessions_spawn' && tool.input) {
        // 将 sessions_spawn 的 input 暂存（通过 side effect 传递）
        // 或直接在这里 UPDATE admin_tool_calls
      }
    }
  } catch { /* 忽略 */ }
}
```

**Step 2：配对逻辑**

当处理 agent 消息中的 sessions_spawn 时，需要找到对应 tool 消息的 `source_id`，
然后 UPDATE `admin_tool_calls` 中该记录的 `tool_input`。

配对方式与 `backfill-tool-fields.ts` 一致：
- 同一 `session_key`
- agent 消息时间在 tool 消息之前
- 时间窗口 ≤ 5 分钟
- 优先选最近的

**Step 3：数据写入**

在 `data-repository.ts` 的 `batchInsertMessages` 中，
agent 消息走 `admin_messages` 插入流程，
但对于 sessions_spawn 调用，**同时更新 `admin_tool_calls`**：

```typescript
// 在 batchInsertMessages 的 agent messages 处理中增加：
if (sessionsSpawnCalls.length > 0) {
  // 找到对应的 tool 消息，UPDATE admin_tool_calls 的 tool_input
  const updateStmt = this.db.prepare(`
    UPDATE admin_tool_calls
    SET tool_input = ?
    WHERE session_key = ? AND tool_name = 'sessions_spawn'
      AND created_at >= ? AND created_at <= ?
      AND (tool_input IS NULL OR tool_input = '{}')
  `);
  // 配对后更新
}
```

**优点**：
- 修复针对性强，只改 sessions_spawn 场景
- 不改变 `admin_tool_calls` 表结构
- 与 `backfill-tool-fields.ts` 的配对逻辑一致
- 未来新数据在写入时就被正确处理，无需额外脚本

**缺点**：
- 需要在 agent 消息处理时 UPDATE 已存在的 `admin_tool_calls` 记录（可能有 race condition，但 collector 写入是串行的，风险低）
- 需要查询 admin_messages 或 admin_tool_calls 做配对，有轻微额外开销

---

### 方案二：在 task-parser.ts 中配对查询（不推荐）

#### 核心思路
不改变 `processor.ts`，在 `task-parser.ts` 的 `parseSessionsSpawnRecords` 中，
对于 `tool_input` 为空的记录，通过 collector API 查询同 session 的 agent 消息获取 input。

#### 实现步骤

在 `parseSingleRecord` 中，当 `toolInputObj.task` 为空时：
1. 调用 collector API，按 `requester_session_key` 拉取该 session 的所有消息
2. 找到时间上先于当前 tool 消息的 agent 消息
3. 从中提取 sessions_spawn 的 toolCall input
4. 用获取到的 input 解析 title

**优点**：
- 不需要改 `processor.ts` 和数据写入逻辑
- 问题隔离在 parser 层

**缺点**：
- 每个空 `tool_input` 的记录都要额外调用 collector API，开销大
- 79 条历史记录 = 79 次 API 调用（可以 batch，但复杂）
- 实时性差：parser 运行时依赖外部 API
- 与现有 `backfill-tool-fields.ts` 重复，且不如后者完善

---

### 方案三：改变 admin_tool_calls 的写入策略（改动较大）

#### 核心思路
让 `admin_tool_calls` 直接存储 agent 消息的 `source_id`（而非 tool 消息的），
或者同时存储 agent 和 tool 两条记录。

#### 实现步骤
1. 在 `admin_tool_calls` 增加 `agent_source_id` 字段
2. 或者将 agent 消息也写入 `admin_tool_calls`（tool_name = 'sessions_spawn'）

**优点**：数据结构更清晰

**缺点**：
- 需要修改表结构
- `data-repository.ts` 和 `task-parser.ts` 都要改
- 改动范围大，容易引入新问题

---

## 三、推荐方案

**推荐方案一（processor.ts 中处理）**，理由：

1. **影响范围最小**：只改 `processor.ts` 和 `data-repository.ts` 的 agent 消息处理分支
2. **与现有脚本一致**：配对逻辑与 `backfill-tool-fields.ts` 完全相同，可以复用
3. **无额外运行时开销**：新数据在写入时就正确处理，不需要后续修复
4. **历史数据已有保障**：`backfill-tool-fields.ts` 已修复79条记录

---

## 四、实施计划

### 与 dev3 的分工

| 负责方 | 任务 |
|--------|------|
| **dev3** | 已有数据的修复脚本（`backfill-tool-fields.ts` 已完成，历史数据已修复） |
| **dev2（本案）** | `processor.ts` + `data-repository.ts` 修复，确保新数据不再出现此问题 |

### dev2 具体修改点

#### 1. `processor.ts` — `processMessage` 函数

在 `message_type === 'agent'` 的分支中，检测 sessions_spawn 调用：

```typescript
// 伪代码
if (row.message_type === 'agent' && row.tools_json) {
  try {
    const tools = JSON.parse(row.tools_json);
    for (const tool of tools) {
      if (tool.name === 'sessions_spawn' && tool.input) {
        // 通过 return value 传递 sessions_spawn input
        // 供调用方（data-repository）使用
      }
    }
  } catch { /* ... */ }
}
```

#### 2. `data-repository.ts` — `batchInsertMessages` 函数

在 agent 消息写入 `admin_messages` 后，
如果检测到 sessions_spawn 调用，执行配对 UPDATE：

```typescript
// 伪代码
if (agentSessionsSpawnCalls.length > 0) {
  // 按 session_key + 时间窗口 配对
  // UPDATE admin_tool_calls SET tool_input = ? WHERE ...
}
```

#### 3. 配对查询（SQL）

```sql
-- 找到 session 内最近的 sessions_spawn agent toolCall
SELECT tool_input FROM admin_messages
WHERE session_key = ?
  AND message_type = 'agent'
  AND tools_json LIKE '%sessions_spawn%'
  AND created_at < ?
ORDER BY created_at DESC
LIMIT 1
```

### 验证方法

修复后，新的 sessions_spawn 调用应该：
1. `admin_tool_calls` 中 `tool_name = 'sessions_spawn'` 且 `tool_input` 包含 `{task, agentId, mode}`
2. `admin_tasks` 中对应任务 title 不再是 "Untitled Task"

```bash
# 验证新数据
sqlite3 /mnt/d/workspace/ice-bubble/data/admin.db \
  "SELECT COUNT(*) FROM admin_tool_calls WHERE tool_name='sessions_spawn' AND tool_input LIKE '%task%' AND created_at > datetime('now', '-1 day');"
```

---

## 五、风险与注意事项

1. **Race condition**：agent 消息和 tool 消息处理时间差可能导致 tool 消息先被插入 `admin_tool_calls`（空 input），之后才被 agent 消息的逻辑更新。**影响**：极少数情况下，新数据仍可能有一两条空 input。**缓解**：INSERT OR IGNORE + 后续 UPDATE 覆盖。
2. **backfill-tool-fields.ts 已有配对逻辑**：不要重复发明轮子，配对 SQL 直接复用该脚本的逻辑。
3. **不改变 task-parser.ts**：parser 只读 `admin_tool_calls`，让它保持简单。

---

## 六、文件索引

- `processor.ts`: `/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/processor.ts`
- `data-repository.ts`: `/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/storage/data-repository.ts`
- `task-parser.ts`: `/mnt/d/workspace/ice-bubble/ice-bubble-admin/src/data/task-parser.ts`
- `backfill-tool-fields.ts`: `/mnt/d/workspace/ice-bubble/ice-bubble-admin/scripts/backfill-tool-fields.ts`（历史数据已修复）
- `fix-spawn-input.ts`: `/mnt/d/workspace/ice-bubble/ice-bubble-admin/scripts/fix-spawn-input.ts`（早期尝试，有缺陷）
