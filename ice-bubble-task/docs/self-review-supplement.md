# Task-Session 架构融合方案 — 自我评审与补充

> 作者：三宝（开发辅助）
> 日期：2026-04-30
> 性质：方案作者的自我评审与修正

---

## 前言

本文是对《Task-Session 架构融合方案》的架构级自我评审。我重新审视了方案文档、ice-bubble-task 当前代码、ice-bubble-collector-openclaw 代码，以及 OpenClaw 实际运行时数据，逐一回答用户提出的 6 个评估维度，并对原方案提出修正。

---

## 1. 模块边界

### 1.1 改造主要影响哪些模块？

| 模块 | 改造程度 | 职责变化 |
|------|---------|---------|
| **ice-bubble-task** | 核心改造 | 从"纯任务 CRUD + 轮询采集"变为"任务 CRUD + Session 关联 + 派发 + 多源采集"。职责边界发生实质性扩展。 |
| **ice-bubble-collector-openclaw** | 轻微影响 | 可能需要调整采集输出格式以适配 task service 的 session 字段。但 CollectorInterface 已经定义得很清楚，不需要大改。 |
| **ice-bubble-admin**（前端） | Phase 1 零改动 | 只是 API 返回的 task 对象多了几个字段，JSON 向前兼容。Phase 2+ 需要新增 Session 维度的 UI。 |

### 1.2 OpenClawTaskCollector 应该放在哪里？

**原方案说新建 `src/collectors/openclaw-task-collector.ts`，放在 ice-bubble-task 模块中。现在经过代码审查，我确认这个判断是正确的。**

理由：
- ice-bubble-collector-openclaw 的核心职责是"从 OpenClaw 的各种数据源采集并转换为统一格式"，它产出的是 `CollectionEvent` 类型
- OpenClawTaskCollector 的本质是"读取 OpenClaw 状态文件 → 转换为 TaskEvent → 写入 ice-bubble-task 的 DB"
- 这个采集动作的"消费端"是 ice-bubble-task，所以 collector 应该放在 ice-bubble-task 的 `src/collectors/` 下
- ice-bubble-collector-openclaw 提供的 `CollectorInterface` 和 `CollectionPipeline` 可以作为参考框架，但 OpenClawTaskCollector 不需要继承它们——它有自己的数据模型

**结论：OpenClawTaskCollector 放在 `ice-bubble-task/src/collectors/openclaw-task-collector.ts`。**

### 1.3 Dispatch API 放哪里？

**原方案说新建 `POST /api/tasks/dispatch`。修正：不应该在 tasks.ts 中追加，而是单独建 `src/api/dispatch.ts`。**

理由：
- `tasks.ts` 已经是约 200 行的文件，包含完整的 CRUD 路由
- Dispatch 的核心逻辑（创建任务 → spawn subagent → 绑定 session_key）是事务性的，风格与 CRUD 完全不同
- Dispatch 需要依赖 OpenClaw 的 Gateway API（或内部调用），而 tasks.ts 目前是纯本地操作

**修正后的文件结构：**
```
src/api/
  tasks.ts          ← 保持纯 CRUD（GET/POST/PATCH/DELETE tasks）
  dispatch.ts       ← 新建：任务派发 + Session 生命周期
```

Dispatch API 应该在 `app.ts` 中作为独立路由注册：
```typescript
app.use('/api', dispatchRouter);
```

---

## 2. 方法放置（具体到文件和函数）

### 2.1 新增字段 — `src/types/task.ts`

在现有 `Task` interface 末尾追加：

```typescript
export interface Task {
  // ... 现有字段不变 ...

  /** 绑定的 OpenClaw subagent session key，格式: agent:{agentName}:subagent:{uuid} */
  session_key: string | null;

  /** 关联的 OpenClaw subagent runId */
  run_id: string | null;

  /** 任务来源：manual=手动创建, session=spawn时自动生成, collector=采集同步 */
  source: TaskSource;

  /** subagent 执行结果摘要 */
  result_summary: string | null;

  /** 从 session store 同步的 tokens 消耗 */
  tokens_consumed: number | null;
}

// 新增枚举，与 TaskStatus、TaskType 风格一致
export type TaskSource = 'manual' | 'session' | 'collector';
```

`TaskInsert` 类型同步增加这些字段（可选，带默认值）。

### 2.2 数据库迁移 — `src/storage/db-manager.ts`

在现有 `MIGRATIONS` 数组末尾追加 v3：

```typescript
{
  version: 3,
  up: (db: Database) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN session_key TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE tasks ADD COLUMN run_id TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'manual'`);
    db.exec(`ALTER TABLE tasks ADD COLUMN result_summary TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE tasks ADD COLUMN tokens_consumed INTEGER DEFAULT NULL`);
    db.exec(`CREATE INDEX idx_tasks_session_key ON tasks(session_key)`);
    db.exec(`CREATE INDEX idx_tasks_run_id ON tasks(run_id)`);
    db.exec(`CREATE INDEX idx_tasks_source ON tasks(source)`);
  },
}
```

放在 `runMigrations()` 中已有的 v1、v2 之后。

### 2.3 新查询方法 — `src/storage/task-repository.ts`

在 `TaskRepository` 类中新增：

```typescript
findBySessionKey(sessionKey: string, limit?: number): { tasks: Task[]; total: number }
findByRunId(runId: string): Task | null
findTasksBySource(source: TaskSource, limit?: number): { tasks: Task[]; total: number }
updateTaskSession(taskId: string, sessionKey: string, runId: string): void
updateTaskResult(taskId: string, summary: string, tokens: number): void
```

同时改造现有的 `findTasks()` 方法，增加可选的 `session_key` filter 参数。

### 2.4 Dispatch API — `src/api/dispatch.ts`（新建）

```typescript
router.post('/tasks/dispatch', async (req, res) => {
  // 1. 参数校验（title, agent_id, spawn_options）
  // 2. 创建任务记录（status: queued, source: 'session'）
  // 3. 调用 OpenClaw Gateway sessions_spawn
  // 4. 绑定 session_key + run_id 到任务记录
  // 5. 返回 { taskId, sessionKey, runId }
});
```

**关键：Dispatch 的核心逻辑应该封装为 `src/services/dispatch-service.ts`：**

```typescript
class DispatchService {
  async dispatchTask(params: DispatchParams): Promise<DispatchResult> {
    // 1. 创建任务
    const task = await this.repository.createTask({ ...params, source: 'session' });
    // 2. Spawn subagent
    const spawnResult = await this.openclawAdapter.spawnSubagent({
      agentId: params.agent_id,
      context: { taskId: task.id, title: params.title, description: params.description },
      ...params.spawn_options,
    });
    // 3. 绑定
    await this.repository.updateTaskSession(task.id, spawnResult.childSessionKey, spawnResult.runId);
    return { taskId: task.id, sessionKey: spawnResult.childSessionKey, runId: spawnResult.runId };
  }
}
```

### 2.5 采集逻辑 — `src/collectors/openclaw-task-collector.ts`（新建）

```typescript
class OpenClawTaskCollector {
  private readonly openclawStateDir: string;  // 从 config 读取

  async collect(): Promise<void> {
    // 1. 读取 runs.json
    const runs = await this.readSubagentRuns();
    // 2. 读取各 agent 的 sessions.json
    const sessions = await this.readSessionMetadata();
    // 3. 匹配 & 合并
    for (const run of runs) {
      const sessionMeta = sessions[run.childSessionKey];
      // 4. Upsert 到 task service DB
      await this.upsertTaskFromRun(run, sessionMeta);
    }
  }

  private async readSubagentRuns(): Promise<SubagentRunEntry[]> {
    const path = join(this.openclawStateDir, 'subagents', 'runs.json');
    // 使用 withFileLock 读取
  }

  private async readSessionMetadata(): Promise<Record<string, SessionMeta>> {
    // 扫描 ~/.openclaw/agents/*/sessions/sessions.json
  }
}
```

**调度方式**：复用现有的 `AgentStatusScheduler` 的轮询机制，或者新建一个独立的 `SessionSyncScheduler`（推荐后者，因为轮询间隔可以不同）。

### 2.6 现有采集器改造 — `src/collectors/openclaw-collector.ts`

**Phase 1 不建议改动现有采集器。** 保持它只读 `task-store.json`。新建的 OpenClawTaskCollector 独立运行，互不干扰。

---

## 3. 独立性

### 3.1 ⚠️ 原方案的路径错误 — 需要修正

**原方案写的路径全部带 `state/` 前缀，这是错误的。** 经过实际验证：

| 数据源 | 原方案写的是 | 实际路径 |
|--------|------------|---------|
| Subagent Registry | `~/.openclaw/state/subagents/runs.json` | **`~/.openclaw/subagents/runs.json`** |
| Task Registry | `~/.openclaw/state/tasks/runs.sqlite` | **`~/.openclaw/tasks/runs.sqlite`** |
| Session Store | `~/.openclaw/agents/{agent}/sessions/sessions.json` | ✅ 正确 |

OpenClaw 的 state 目录就是 `~/.openclaw/` 本身（除非设置了 `OPENCLAW_STATE_DIR` 环境变量）。所有子目录直接在 `~/.openclaw/` 下，没有中间一层 `state/`。

**所有路径相关的代码必须使用 OpenClaw 的 `resolveStateDir()` 函数或 `OPENCLAW_STATE_DIR` 环境变量来动态解析，不能硬编码。**

### 3.2 松耦合方案 — Adapter 层

**这是我需要补充的最重要的架构决策：所有 OpenClaw 内部文件/接口的访问必须集中到一个 Adapter 层。**

```typescript
// src/adapters/openclaw-state-adapter.ts
interface OpenClawStateAdapter {
  /** 读取 subagent runs.json */
  listSubagentRuns(): Promise<SubagentRunEntry[]>;

  /** 读取指定 agent 的 sessions.json */
  listSessionMetadata(agentId: string): Promise<SessionMeta[]>;

  /** 读取原生 task registry（runs.sqlite） */
  listNativeTasks(): Promise<NativeTaskEntry[]>;

  /** 通过 Gateway API spawn subagent */
  spawnSubagent(params: SpawnParams): Promise<SpawnResult>;

  /** 获取 state dir（支持 OPENCLAW_STATE_DIR 覆盖） */
  getStateDir(): string;
}
```

**为什么需要 adapter 层？**

1. **格式变化隔离**：OpenClaw 升级可能随时改变 `runs.json` 的字段结构、`runs.sqlite` 的 schema。如果这些读取散落在 collector、dispatch、scheduler 各处，改动范围不可控。集中在 adapter 层，只需要改一个文件。

2. **路径解析统一**：`resolveStateDir()` 逻辑复杂（支持 `OPENCLAW_STATE_DIR` 覆盖、legacy dirs 回退、nix mode）。不应该在每个 collector 里重复实现。

3. **错误处理统一**：文件不存在、JSON 解析失败、SQLite 损坏 — 所有这些 OpenClaw 特有的错误应该在 adapter 层转换为统一的 `OpenClawStateError`，业务层不需要关心。

4. **可测试性**：adapter 层可以 mock，collector 和 dispatch 的逻辑可以独立测试。

### 3.3 格式版本检测

在 adapter 层加入格式版本检测：

```typescript
async listSubagentRuns(): Promise<SubagentRunEntry[]> {
  const raw = JSON.parse(await readFile(path));
  if (!raw.version || raw.version < 2) {
    this.logger.warn('Unexpected runs.json format, expected version >= 2');
    // 降级处理或抛出自定义错误
  }
  return raw.runs;
}
```

### 3.4 能否独立运行？

**能，但需要配置开关。** 在 `config.json` 中增加：

```json
{
  "openclaw": {
    "enabled": true,
    "stateDir": null,  // null = 自动检测
    "collectors": {
      "taskStore": true,     // 读 task-store.json（现有）
      "subagentRuns": true,  // 读 runs.json（新增）
      "nativeTasks": false   // 读 runs.sqlite（新增，默认关闭）
    },
    "dispatch": {
      "enabled": false,      // Dispatch API，默认关闭
      "gatewayUrl": null     // OpenClaw Gateway API 地址
    }
  }
}
```

这样即使 OpenClaw 状态文件完全不可用，task service 仍然可以作为独立的 CRUD 服务运行。

---

## 4. 可扩展性

### 4.1 数据库 Schema 扩展性

**原方案是直接加列，这是对的，但需要补充一个长远考虑：metadata JSON 列。**

SQLite 的 ALTER TABLE 能力有限（不能 DROP COLUMN，不能 ADD CONSTRAINT），每次加列都意味着一次迁移。建议预留一个 `metadata` 列：

```sql
ALTER TABLE tasks ADD COLUMN metadata TEXT DEFAULT '{}';
```

这样未来扩展（如 `project`、`tags`、`custom_fields`）不需要每次都 ALTER TABLE。

**具体建议**：

| 扩展维度 | 实现方式 | 优先级 |
|---------|---------|--------|
| `session_key` / `run_id` | 独立列（需要索引和查询） | P0 — 本次改造 |
| `source` | 独立列（需要过滤） | P0 — 本次改造 |
| `result_summary` / `tokens_consumed` | 独立列（前端需要展示） | P0 — 本次改造 |
| `project` | metadata JSON 内部 | P3 — 未来需求 |
| `tags` | 独立关联表（需要 JOIN 查询） | P3 — 未来需求 |
| `custom_fields` | metadata JSON 内部 | P3 — 未来需求 |

### 4.2 对接其他 Agent 框架

**这是原方案没有深入讨论的部分。**

当前方案中 `session_key` 的格式是 OpenClaw 专属的（`agent:{name}:subagent:{uuid}`）。如果未来要对接 Claude Code、Cursor 等其他框架，这个字段语义就不够通用。

**建议**：本次改造保持 `session_key` 为 OpenClaw 格式，但在设计时考虑以下兼容性：

1. `session_key` 字段本身是通用的字符串，可以存储任何框架的 session 标识
2. 新增 `session_provider` 字段（可选，放到 metadata JSON 中）：
   ```json
   { "session_provider": "openclaw" }
   ```
3. Collector 接口 `CollectorInterface` 已经是抽象的。对接其他框架只需要实现新的 collector，不需要改核心代码。

**结论：本次不做 session_provider 字段，但架构上预留了扩展空间。**

### 4.3 按项目/标签维度扩展

通过 `metadata JSON` 列实现，不需要改 schema：

```sql
-- 查询某项目的所有任务
SELECT * FROM tasks WHERE json_extract(metadata, '$.project') = 'ice-bubble';

-- 查询带特定标签的任务
SELECT * FROM tasks WHERE json_each.value = 'urgent'
FROM tasks, json_each(json_extract(metadata, '$.tags'));
```

SQLite 的 JSON 函数查询效率不如独立列，但对于当前规模（<10K 任务）完全可以接受。

---

## 5. 兼容性

### 5.1 API 向后兼容性 — ✅ 完全兼容

| API | 兼容性 | 说明 |
|-----|--------|------|
| `POST /api/tasks` | ✅ | 新增字段都是可选的，有默认值。现有调用方不传这些字段不受影响。 |
| `GET /api/tasks` | ✅ | 返回的 task 对象多了几个字段。JSON 向前兼容，现有客户端忽略新字段即可。 |
| `PATCH /api/tasks/:id/status` | ✅ | 逻辑不变。 |
| `PATCH /api/tasks/:id` | ✅ | 允许更新新字段，但不强制。 |
| `DELETE /api/tasks/:id` | ✅ | 逻辑不变。 |
| `GET /api/tasks/workspace` | ✅ | 响应结构中 agent_groups 的每个 task 对象多了新字段，不会破坏现有客户端。 |
| `GET /api/tasks?session_key=xxx` | ✅ 新增 | 新的 query parameter，不影响现有查询。 |

### 5.2 数据库迁移方案

**ALTER TABLE + DEFAULT 是最安全的迁移方式：**

```sql
-- v3 迁移
ALTER TABLE tasks ADD COLUMN session_key TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN run_id TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN result_summary TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN tokens_consumed INTEGER DEFAULT NULL;
CREATE INDEX idx_tasks_session_key ON tasks(session_key);
CREATE INDEX idx_tasks_run_id ON tasks(run_id);
CREATE INDEX idx_tasks_source ON tasks(source);
```

**影响分析**：
- 现有数据的所有新字段自动为 NULL / 'manual'
- 不需要数据转换
- 迁移是原子的（SQLite DDL 隐式事务）
- 如果迁移失败（概率极低），SQLite 会回滚

### 5.3 前端改动范围

| 阶段 | 前端改动 | 工作量 |
|------|---------|--------|
| **Phase 1** | 零改动。API 返回的新字段被前端忽略。 | 0 |
| **Phase 2** | Admin Dashboard 新增 "Session" 列，展示 session_key（截断显示）。 | 0.5 天 |
| **Phase 3** | Session 维度的视图：按 session 分组展示任务、执行时长、tokens。 | 1-2 天 |

**建议：在方案文档中明确前端改动时间线，避免前端团队 surprise。**

---

## 6. 方案修正

### 6.1 需要修正的地方

#### 修正 1：OpenClaw 状态文件路径

| 原方案 | 修正后 |
|--------|--------|
| `~/.openclaw/state/subagents/runs.json` | `~/.openclaw/subagents/runs.json` |
| `~/.openclaw/state/tasks/runs.sqlite` | `~/.openclaw/tasks/runs.sqlite` |

**根因**：OpenClaw 的 state dir 就是 `~/.openclaw/`，所有子目录直接在其下，没有 `state/` 中间层。

#### 修正 2：新增 `OpenClawStateAdapter` 层

**原方案**没有明确提出 adapter 层，只是说"读取 OpenClaw 状态文件"。这是一个架构缺陷。

**修正**：所有 OpenClaw 内部文件/接口的访问集中在 `src/adapters/openclaw-state-adapter.ts`：
- 路径解析（支持 `OPENCLAW_STATE_DIR` 环境变量）
- 格式版本检测
- 统一错误处理
- 可 mock 可测试

#### 修正 3：Phase 1 不做自动 spawn

**原方案** Phase 1 包含 "通过 OpenClaw API / internal hook 触发 sessions_spawn"。

**修正：Phase 1 只做手动绑定。** Main Agent 自己在 spawn subagent 时携带 task context，subagent 启动后回调 task service 绑定 session_key。

理由：
- Task Service 从"被动采集"变成"主动调度"是职责边界的根本性变化
- 双向依赖（Task Service → OpenClaw spawn, OpenClaw → Task Service collect）增加了故障面
- 手动绑定风险最低，可以验证 session_key 关联逻辑是否正确
- 自动 spawn 放到 Phase 3，等基础架构稳定后再做

**修正后的实施路线：**

| Phase | 内容 | 变化 |
|-------|------|------|
| **P0** | DB 迁移 v3 + Task/TaskInsert 加字段 + Repository 新方法 | 不变 |
| **P0** | 现有 API 支持 `session_key` query filter | 不变 |
| **P1** | `OpenClawStateAdapter` + 从 runs.json/sessions.json 采集 | **新增：adapter 层** |
| **P1** | `OpenClawTaskCollector`（runs.json + sessions.json 数据源） | 不变 |
| **P2** | Dispatch API（创建任务 + 手动绑定 session_key，不自动 spawn） | **修正：不自动 spawn** |
| **P3** | 自动 spawn（Task Service 主动调 OpenClaw） | 不变，延后 |
| **P3** | runs.sqlite 对接 | 不变 |

#### 修正 4：`result_summary` 和 `tokens_consumed` 的存储策略

**原方案**说这两个字段存在 tasks 表里。

**修正：这两个字段放在 tasks 表里是可以的，但需要明确它们是"最终快照"，不是实时数据。**

- `result_summary`：subagent 完成时写入一次，之后不更新。这是任务的"结案报告"。
- `tokens_consumed`：subagent 完成时从 session store 同步一次。如果 session store 后续被压缩（compaction），这个值可能不再准确。

**不应该做的**：不要做定期的 UPDATE 来同步这两个字段。它们是快照，不是实时视图。如果需要实时数据，应该从 session store 按需查询。

#### 修正 5：`source` 字段用枚举

**原方案**把 `source` 写成字面量联合类型 `'manual' | 'session' | 'collector'` 内联在 interface 上。

**修正**：独立定义 `TaskSource` 类型别名，和 `TaskStatus`、`TaskType` 保持同等风格：

```typescript
export type TaskSource = 'manual' | 'session' | 'collector';
```

#### 修正 6：`session_key` 需要格式校验

**原方案**没有提到格式校验。当前代码中 `agent_id` 是自由字符串已经造成了混乱，`session_key` 必须从第一天就有格式约束。

**修正**：在 `TaskInsert` 的验证层增加格式校验：

```typescript
const SESSION_KEY_REGEX = /^agent:[a-z0-9_-]+:(?:subagent|main):[a-z0-9-]+$/;

if (sessionKey && !SESSION_KEY_REGEX.test(sessionKey)) {
  throw new ValidationError(`Invalid session_key format: ${sessionKey}`);
}
```

### 6.2 更轻量的实现路径

如果团队希望最小化改造范围，可以考虑以下**精简版**方案：

#### 精简版：只做 session_key 关联

1. **DB 迁移**：只加 `session_key` 一列（不加 run_id、source、result_summary、tokens_consumed）
2. **API**：只在 `findTasks()` 中增加 `session_key` filter，不新建 dispatch API
3. **绑定**：Main Agent 在 subagent 的 context 中携带 task ID，subagent 启动后调用 `PATCH /api/tasks/:id` 绑定自己的 session_key
4. **采集**：不改采集器，只在手动绑定时记录关联

**优点**：改动量减少 70%，1 天可以完成。
**缺点**：丢失自动化能力，无法从 OpenClaw 状态文件自动同步。

**建议**：先用精简版验证 session_key 关联的可行性，确认没问题后再全量实施原方案。

---

## 7. OpenClaw 原生 Task 系统的再思考

经过实际查看 `~/.openclaw/tasks/runs.sqlite` 的 schema，我发现 OpenClaw 原生 task 系统比我们想象的更完善：

```sql
CREATE TABLE task_runs (
  task_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,           -- "acp" | "subagent" | "cron"
  source_id TEXT,
  owner_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  child_session_key TEXT,          -- ← 已经有 session_key！
  parent_task_id TEXT,
  agent_id TEXT,
  run_id TEXT,                     -- ← 已经有 run_id！
  label TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  last_event_at INTEGER,
  cleanup_after INTEGER,
  error TEXT,
  progress_summary TEXT,
  terminal_summary TEXT,           -- ← 已经有 result_summary 的等价物！
  terminal_outcome TEXT,
  parent_flow_id TEXT,
  requester_session_key TEXT,
  task_kind TEXT
);
```

**这意味着 OpenClaw 原生 task 系统已经有了我们方案中大部分字段！**

| ice-bubble-task 方案字段 | OpenClaw runs.sqlite 对应字段 | 状态 |
|-------------------------|---------------------------|------|
| session_key | child_session_key | ✅ 已有 |
| run_id | run_id | ✅ 已有 |
| result_summary | terminal_summary | ✅ 已有 |
| agent_id | agent_id | ✅ 已有 |
| parent_id | parent_task_id | ✅ 已有 |

**这对方案的含义**：

1. **Phase 3 的 runs.sqlite 对接价值更高了** — 因为 OpenClaw 原生系统已经有了我们需要的大部分数据。
2. **Phase 1/2 的独立 schema 仍然是必要的** — 因为 ice-bubble-task 需要自己的业务逻辑（父子任务的业务含义、自定义状态流转、与 Admin Dashboard 的集成），不能直接依赖 OpenClaw 的 schema。
3. **最佳策略可能是"双写"** — 手动创建的任务写入 ice-bubble-task 的 DB，OpenClaw 原生任务通过采集器同步过来。两者通过 `run_id` 关联。

---

## 8. 总结

### 修正清单

| # | 修正项 | 影响 |
|---|--------|------|
| 1 | OpenClaw 状态文件路径（去掉 `state/` 前缀） | 所有文件读取代码 |
| 2 | 新增 `OpenClawStateAdapter` 层 | 松耦合、可测试、格式变化隔离 |
| 3 | Phase 1 不做自动 spawn，只做手动绑定 | 降低改造风险 |
| 4 | `result_summary`/`tokens_consumed` 是快照，不实时同步 | 减少不必要的 UPDATE |
| 5 | `source` 用独立类型别名 | 代码风格一致 |
| 6 | `session_key` 需要格式校验 | 防止脏数据 |
| 7 | 提供精简版方案（只做 session_key 关联） | 给团队一个最小化改造选项 |

### 架构决策确认

| 决策 | 结论 | 理由 |
|------|------|------|
| OpenClawTaskCollector 放哪？ | ice-bubble-task/src/collectors/ | 消费端在 task service |
| Dispatch API 放哪？ | 独立文件 src/api/dispatch.ts | 风格与 CRUD 不同，避免 tasks.ts 膨胀 |
| 是否读 runs.sqlite？ | Phase 1 不读，Phase 3 再考虑 | 最强耦合，优先用 JSON 数据源 |
| 是否自动 spawn？ | Phase 1 不自动，Phase 3 再做 | 双向依赖风险高 |
| 是否兼容？ | 100% 向后兼容 | 新字段可选+默认值，API 不破坏 |
