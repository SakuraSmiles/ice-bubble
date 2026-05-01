# Collector sessions.json 采集方案

## 背景

OpenClaw 的 session 元数据存储在 `~/.openclaw/agents/{agentId}/sessions/sessions.json` 中，
包含 `label`、`status`、`model`、`spawnedBy` 等丰富信息。
当前 Collector 只读取 `*.jsonl` 消息文件，从未读取 `sessions.json`，导致 Admin 层缺少这些元数据。

## sessions.json 结构

```json
{
  "agent:dev:subagent:0b119bef-xxxx": {
    "sessionId": "0b119bef-8469-4379-b478-a4db9d0fe6fa",
    "status": "done",
    "label": "task-TASK-20260423-AGENT-STATUS-1",
    "model": "MiniMax-M2.7-highspeed",
    "modelProvider": "minimax-cn",
    "spawnedBy": "agent:main:main",
    "spawnDepth": 1,
    "subagentRole": "leaf",
    "spawnedWorkspaceDir": "/home/dabai/.openclaw/workspace/dev/config",
    "startedAt": 1775190790104,
    "endedAt": 1775190712658,
    "runtimeMs": 620931,
    "inputTokens": 36,
    "outputTokens": 17,
    "totalTokens": 59147,
    "estimatedCostUsd": 1.328149,
    "channel": "webchat",
    "lastChannel": "webchat",
    "sessionFile": "/home/dabai/.openclaw/agents/dev/sessions/012582c0-xxxx.jsonl",
    "updatedAt": 1777541525826
  }
}
```

## P0 采集字段

| 字段 | 类型 | 说明 |
|------|------|------|
| label | TEXT | session标题（65/547个session有值） |
| status | TEXT | done/failed/timeout/running |
| model | TEXT | 使用的模型 |
| model_provider | TEXT | 模型provider |
| spawned_by | TEXT | 父session key |
| spawn_depth | INTEGER | subagent嵌套深度 |

P1 后续可扩展：input_tokens/output_tokens/total_tokens, started_at/ended_at/runtime_ms, estimated_cost_usd, aborted_last_run, compaction_count

## UUID 桥接逻辑（关键）

Collector 构造的 session_key 格式（6段）：
```
agent:dev:local:default:direct:0b119bef-8469-4379-b478-a4db9d0fe6fa
```

sessions.json 的 key 格式（4段）：
```
agent:dev:subagent:0b119bef-8469-4379-b478-a4db9d0fe6fa
```

**桥接方式：提取 session 的 UUID（即 jsonl 文件名），与 sessions.json 中所有 entry 的 `sessionId` 匹配。**

一个 session 对应一个 jsonl 文件，文件名 = `sessionId`。
sessions.json 中每个 entry 的 `sessionId` 字段也是这个 UUID。
所以匹配逻辑是：`jsonl文件名 == sessions.json entry.sessionId`

## 实现步骤

### Step 1: Collector sessions 表新增列

文件：`src/storage/sqlite-manager.ts`

```sql
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN model_provider TEXT;
ALTER TABLE sessions ADD COLUMN spawned_by TEXT;
ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER DEFAULT 0;
```

注意：SQLite 不支持 IF NOT EXISTS 语法加列，需要用 try-catch 或检查列是否存在。

### Step 2: FileCollector 新增 sessions.json 读取

文件：`src/collectors/FileCollector.ts`

在采集循环中（`collectSessionFiles` 或类似方法）新增：

1. 遍历 `~/.openclaw/agents/*/sessions/sessions.json`
2. 解析 JSON
3. 对每个 entry，通过 `sessionId`（即 UUID）找到对应的 Collector session_key
4. 更新 sessions 表的 label/status/model 等字段

```typescript
private async syncSessionMetadata(): Promise<void> {
    // 找到所有 agents/*/sessions/sessions.json
    const pattern = path.join(this.config.openclawDataDir, 'agents', '*', 'sessions', 'sessions.json');
    const files = await fs.promises.glob(pattern);

    for (const filePath of files) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        const agentId = extractAgentIdFromPath(filePath);

        for (const [sessionJsonKey, entry] of Object.entries(data)) {
            const sessionId = entry.sessionId; // UUID
            if (!sessionId) continue;

            // 通过 sessionId 找到 Collector 的 session_key
            const sessionKey = `agent:${agentId}:local:default:direct:${sessionId}`;

            // 更新 sessions 表
            await this.sqliteManager.updateSessionMetadata(sessionKey, {
                label: entry.label || null,
                status: entry.status || 'unknown',
                model: entry.model || null,
                modelProvider: entry.modelProvider || null,
                spawnedBy: entry.spawnedBy || null,
                spawnDepth: entry.spawnDepth || 0,
            });
        }
    }
}
```

### Step 3: sqlite-manager 新增 updateSessionMetadata 方法

```typescript
async updateSessionMetadata(sessionKey: string, meta: {
    label?: string | null;
    status?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    spawnedBy?: string | null;
    spawnDepth?: number | null;
}): Promise<void> {
    await this.db.run(`
        UPDATE sessions SET
            label = COALESCE(?, label),
            status = COALESCE(?, status),
            model = COALESCE(?, model),
            model_provider = COALESCE(?, model_provider),
            spawned_by = COALESCE(?, spawned_by),
            spawn_depth = COALESCE(?, spawn_depth),
            updated_at = CURRENT_TIMESTAMP
        WHERE session_key = ?
    `, [meta.label, meta.status, meta.model, meta.modelProvider, meta.spawnedBy, meta.spawnDepth, sessionKey]);
}
```

### Step 4: Collector API 返回新字段

文件：`src/api/routes/data.ts`（sessions相关路由）

确保 GET /api/sessions 返回 label/status/model/spawned_by/spawn_depth 字段。

### Step 5: 集成到采集循环

在 FileCollector 的 `collect` 或 `collectAll` 方法中，在消息文件采集之后调用 `syncSessionMetadata()`。
建议每轮采集都调用（sessions.json 通常 < 100KB，全量读取也很快）。

## 注意事项

1. **Agent 提取**：从路径 `~/.openclaw/agents/{agentId}/sessions/sessions.json` 中提取 agentId
2. **空 label 的 session**：很多 session 没有 label（尤其是主 session），COALESCE 保留已有值
3. **sessions.json 不存在**：新 agent 目录可能还没有 sessions.json，需要 try-catch
4. **重复更新**：每轮都全量读取 sessions.json 是安全的（文件小），不需要增量逻辑
5. ** dreaming/cron session**：sessions.json 中包含 dreaming session，这些也有 label（如 "Cron: xxx"），应该一并采集
