# Task-Session 架构融合方案

> 作者：三宝（开发辅助）
> 日期：2026-04-29
> 状态：技术调研 / 待评审

---

## 1. 现状分析

### 1.1 当前 Task 服务的架构

ice-bubble-task 服务（`/mnt/d/workspace/ice-bubble/ice-bubble-task/`）的核心数据流：

```
Main Agent (curl) → POST /api/tasks → SQLite (tasks 表)
                                            ↓
                                  AgentStatusScheduler (轮询 pending tasks)
                                            ↓
                                  按 agent_id 分组 → 等待 agent 来取
                                            ↓
                                  通过 PATCH /api/tasks/:id/status 更新状态
                                            ↓
                                  写入 task-store.json statusUpdates
                                            ↓
                                  OpenClawCollector 采集 → 同步回 SQLite
```

#### 关键代码引用

**任务数据结构**（`src/types/task.ts`）：
```typescript
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  agent_id: string;        // ← 只是字符串引用，没有外键约束
  type: TaskType;          // 'TODO' | 'LOOP' | 'SUBAGENT' | 'CRON'
  parent_id: string | null;
  children_ids: string[];
  // ...
}
```

**任务创建 API**（`src/api/tasks.ts:48-80`）：
```typescript
router.post('/tasks', (req, res) => {
  const { title, agent_id, priority, type, description, parent_id, idempotency_key } = req.body;
  // 手动指定 agent_id，没有 session 概念
  // ...
});
```

**Agent 状态轮询**（`src/scheduler/agent-status-scheduler.ts:80-95`）：
```typescript
// 1. 查询所有 pending 任务
const pendingTasks = this.repository.findTasks({ status: 'pending', limit: 1000 });
// 2. 按 agent_id 分组
const byAgent = new Map<string, string[]>();
for (const task of pendingTasks.tasks) {
  const list = byAgent.get(task.agent_id) || [];
  list.push(task.id);
  byAgent.set(task.agent_id, list);
}
```

**OpenClaw 采集器**（`src/collectors/openclaw-collector.ts:33-46`）：
```typescript
const tasks: TaskInsert[] = Object.values(store.tasks).map((t: OpenClawTaskSource) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  agent_id: t.agent_id,  // ← 仅从 task-store.json 获取 agent_id
  // ...
}));
```

### 1.2 当前按内容划分任务的问题

| 问题 | 具体表现 | 根因 |
|------|---------|------|
| **任务上下文丢失** | Subagent "没有获取到"任务 | 任务创建时只传了 title/description，没有携带 session 信息。Subagent 启动后不知道要执行哪个任务 |
| **agent_id 标识模糊** | `agent_id` 是自由字符串，如 `"dev3"` | 无法区分同一 agent 的多个并发 subagent session |
| **手动创建容易遗漏** | Main agent 通过 curl 创建任务 | 需要 main agent 正确解析意图、拆分任务、逐个创建，任何环节出错都会导致任务丢失 |
| **状态同步不可靠** | task-store.json ↔ SQLite 双向同步 | 依赖文件锁 + 轮询，存在 TOCTOU 竞态窗口（代码里已有 T9/T10 修复，但架构层面仍存在） |
| **父子任务脱节** | 子任务和执行它的 subagent 没有关联 | `children_ids` 只是 ID 数组，不记录哪个 subagent session 在执行哪个子任务 |
| **无法追踪执行上下文** | 任务失败后无法恢复 | 没有记录任务在哪个 session 中执行、执行了多久、消耗了多少 tokens |

---

## 2. OpenClaw 的 Session/Subagent 机制

### 2.1 Session 体系

OpenClaw 的 session 层级结构：

```
agent:main:main          ← 主 session（冰镇虾头）
├── agent:main:subagent:uuid1   ← subagent 1
├── agent:dev3:subagent:uuid2   ← subagent 2（不同 agent）
│   └── agent:dev3:subagent:uuid3   ← 嵌套 subagent
```

关键文件：

| 文件 | 路径 | 内容 |
|------|------|------|
| **Session Store** | `~/.openclaw/agents/{agent}/sessions/sessions.json` | 每个 session 的元数据（sessionId、startedAt、endedAt、status、tokens、cost 等） |
| **Subagent Registry** | `~/.openclaw/state/subagents/runs.json` | subagent 运行记录，包含父子关系 |
| **Task Registry** | `~/.openclaw/state/tasks/runs.sqlite` | OpenClaw 原生任务系统 |
| **Transcripts** | `~/.openclaw/agents/{agent}/sessions/{key}/` | 每个 session 的对话记录 |

### 2.2 Subagent Run 数据结构

从 `subagent-registry-state-BdxY8kqY.js` 中提取的核心字段：

```typescript
interface SubagentRunEntry {
  runId: string;                    // 运行 ID（UUID）
  childSessionKey: string;          // 子 agent 的 session key，如 "agent:dev3:subagent:uuid"
  requesterSessionKey: string;      // 请求者 session key，如 "agent:main:main"
  controllerSessionKey: string;     // 控制器 session key
  startedAt: number;                // 开始时间戳
  endedAt?: number;                 // 结束时间戳
  outcome?: { status: "ok" | "error" | "timeout"; error?: string };
  spawnMode: "run" | "session";     // 派生模式
  requesterOrigin: {                // 来源渠道
    channel?: string;
    accountId?: string;
  };
  endedReason?: string;             // "subagent-complete" | "subagent-error" | "subagent-killed"
  runTimeoutSeconds?: number;       // 超时设置
}
```

**持久化路径**（代码引用 `subagent-registry-state-BdxY8kqY.js`）：
```javascript
function resolveSubagentRegistryPath() {
    return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}
```

### 2.3 OpenClaw 原生 Task 系统

OpenClaw 已有内建的 task 系统（`task-registry-DabR0MkC.js`）：

```typescript
interface Task {
  taskId: string;
  runId?: string;
  runtime: "acp" | "subagent" | "cron";  // 原生支持 subagent 运行时
  task: string;        // 任务描述
  label?: string;      // 显示名称
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
  deliveryStatus: "pending" | "delivered";
  notifyPolicy: "silent" | "state_changes" | "terminal_only";
  terminalSummary?: string;
  error?: string;
}
```

原生 task 系统已经支持 **subagent runtime**——任务可以直接绑定到 subagent session 执行，并自动跟踪完成状态。

---

## 3. 按 Session 划分任务的含义与优势

### 3.1 "按 Session 划分任务"意味着什么

当前模式：
```
任务列表: [
  { id: "t1", title: "修改登录页面", agent_id: "dev3" },
  { id: "t2", title: "修复 bug #123", agent_id: "dev3" },
]
↓ 轮询发现 pending → 手动 spawn subagent → subagent 自己来取
```

Session 模式：
```
Session: agent:dev3:subagent:abc123
  └─ 绑定任务: { taskId: "t1", title: "修改登录页面" }
     ↓ session 启动时自动携带任务上下文
     ↓ subagent 启动后立刻知道要做什么
```

核心变化：
- **任务不再只属于 agent_id，而是绑定到具体的 childSessionKey**
- **任务的创建和 subagent 的 spawn 是同一个原子操作**
- **任务上下文通过 session 初始化注入，而不是等待 subagent 轮询获取**

### 3.2 优势

| 优势 | 说明 |
|------|------|
| **上下文不丢失** | Subagent 启动时 sessionKey 已确定，任务通过 session 初始化注入，无需轮询 |
| **精确追踪** | 每个 subagent session 对应 0-N 个任务，可以追踪执行时长、tokens、结果 |
| **天然隔离** | 不同 subagent 的 session 互不干扰，不存在"抢任务"问题 |
| **自动生命周期** | Subagent 结束时（complete/error/timeout），关联任务自动更新状态 |
| **嵌套支持** | Subagent 可以继续 spawn 子 subagent，任务树和 session 树天然对应 |
| **失败恢复** | 如果 subagent 意外终止，session 状态可查，任务可以重新派发 |

### 3.3 代价与风险

| 风险 | 缓解措施 |
|------|---------|
| Session 创建有开销 | Session 开销是 OpenClaw 原生机制，不可消除但可接受 |
| Session 泄漏（僵尸 session） | OpenClaw 已有 stale detection（`STALE_UNENDED_SUBAGENT_RUN_MS = 7200s`） |
| 复杂度增加 | 初期只改造关键路径，保留 agent_id 向后兼容 |

---

## 4. 融合方案：内容 + Session 双维度

完全抛弃当前方案不现实。建议采用**双维度融合**：

```
                    内容维度                    Session 维度
                ┌─────────────────┐        ┌─────────────────┐
                │  父任务（内容）  │  ────  │  父 Session      │
                │  title: "重构XX" │        │  agent:main:main │
                └────────┬────────┘        └────────┬────────┘
                         │                          │
              ┌──────────┼──────────┐    ┌──────────┼──────────┐
              ▼          ▼          ▼    ▼          ▼          ▼
        ┌─────────┐ ┌─────────┐ ┌─────┐ ┌──────┐ ┌──────┐ ┌──────┐
        │ 子任务1  │ │ 子任务2  │ │子任务3│ │sess-A│ │sess-B│ │sess-C│
        │ 登录页  │ │ API改造 │ │测试  │ │dev3:x │ │dev3:y │ │dev3:z│
        └─────────┘ └─────────┘ └─────┘ └──────┘ └──────┘ └──────┘
              │          │          │         │         │         │
              └──────────┴──────────┘         └─────────┴─────────┘
                      │                              │
                      └──────── 绑定关系 ────────────┘
```

### 4.1 数据模型改造

在现有 `Task` 表中增加 session 关联字段：

```typescript
// src/types/task.ts — 新增字段
export interface Task {
  // ... 现有字段不变 ...

  /** 绑定的子 agent session key（可选） */
  session_key: string | null;

  /** 任务来源：手动创建 / session 自动生成 / 采集同步 */
  source: 'manual' | 'session' | 'collector';

  /** OpenClaw subagent runId（用于关联 runs.json 中的执行记录） */
  run_id: string | null;

  /** 任务执行结果摘要（subagent 完成时写入） */
  result_summary: string | null;

  /** tokens 消耗（从 session store 同步） */
  tokens_consumed: number | null;
}
```

### 4.2 核心流程改造

#### 流程 1：Main Agent 派发任务（新建路径）

```
Main Agent 决定派发任务
    │
    ▼
POST /api/tasks/dispatch  ← 新增 API
  {
    title: "修改登录页面",
    description: "将登录页从 class 组件改为函数组件",
    agent_id: "dev3",
    parent_id: "T1",           // 父任务 ID
    spawn_options: {
      context: "session",       // 通过 session 上下文派发
      model: "qwen3.6-plus",    // 可选：指定模型
      timeout_seconds: 600      // 可选：超时
    }
  }
    │
    ▼
Task Service 执行：
  1. 创建子任务（status: queued）
  2. 通过 OpenClaw API / internal hook 触发 sessions_spawn
     - requesterSessionKey: "agent:main:main"
     - 携带 task 上下文（通过 subagent context）
  3. 记录 run_id + session_key 到任务记录
  4. 任务状态自动变为 in_progress（subagent 启动时更新）
    │
    ▼
Subagent 启动
  - 系统自动注入任务上下文（task title, description, parent info）
  - Subagent 无需"获取"任务——它已经知道要做什么
    │
    ▼
Subagent 执行完成
  - 通过回调 / 采集器 将结果写回 task service
  - 任务状态 → completed
  - 写入 result_summary
```

#### 流程 2：OpenClaw 原生 Task 系统对接

OpenClaw 已有 subagent 任务机制。ice-bubble-task 可以作为**外部看板**，从 OpenClaw 原生 task registry 同步数据：

```
新增采集器: OpenClawTaskCollector
  │
  ├─ 数据源: ~/.openclaw/state/tasks/runs.sqlite
  ├─ 数据源: ~/.openclaw/state/subagents/runs.json
  ├─ 数据源: ~/.openclaw/agents/*/sessions/sessions.json
  │
  └─ 同步逻辑:
       1. 读取 OpenClaw 原生 task runs
       2. 匹配 subagent run 的 childSessionKey
       3. 合并 session 元数据（tokens, cost, duration）
       4. Upsert 到 ice-bubble-task 的 SQLite
```

#### 流程 3：现有 API 向后兼容

现有 API 全部保留，但增加 session 维度的查询：

```
GET /api/tasks?session_key=agent:dev3:subagent:abc123
    → 返回该 session 关联的所有任务

GET /api/sessions/agent:dev3:subagent:abc123/tasks
    → 同上，REST 风格

GET /api/tasks/workspace
    → 现有接口不变，但 agent_groups 中增加 session_key 字段
```

### 4.3 改造范围

| 文件 | 改造内容 | 优先级 |
|------|---------|--------|
| `src/types/task.ts` | 增加 session_key, run_id, source, result_summary, tokens_consumed | P0 |
| `src/storage/db-manager.ts` | 数据库迁移：新增列 | P0 |
| `src/storage/task-repository.ts` | 新增 findBySessionKey, findByRunId 方法 | P0 |
| `src/api/tasks.ts` | 新增 POST /api/tasks/dispatch、GET /api/sessions/:key/tasks | P0 |
| `src/collectors/openclaw-collector.ts` | 增加 session store + subagent runs 采集 | P1 |
| `src/collectors/` | 新建 `openclaw-task-collector.ts`（对接原生 task registry） | P1 |
| `src/scheduler/agent-status-scheduler.ts` | 增加 session 维度的 pending 任务查询 | P1 |
| `config/config.json` | 新增 openclaw state dir 配置 | P2 |

### 4.4 数据库迁移

```sql
-- v3: 增加 session 关联字段
ALTER TABLE tasks ADD COLUMN session_key TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN run_id TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE tasks ADD COLUMN result_summary TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN tokens_consumed INTEGER DEFAULT NULL;

-- 索引
CREATE INDEX idx_tasks_session_key ON tasks(session_key);
CREATE INDEX idx_tasks_run_id ON tasks(run_id);
CREATE INDEX idx_tasks_source ON tasks(source);
```

---

## 5. OpenClaw 可被 Task Service 利用的数据

### 5.1 Session Store（`sessions.json`）

每个 agent 的 session 元数据：
```json
{
  "agent:dev3:subagent:abc123": {
    "sessionId": "abc123",
    "startedAt": 1714356000000,
    "endedAt": 1714356300000,
    "runtimeMs": 300000,
    "status": "done",
    "inputTokens": 15000,
    "outputTokens": 3000,
    "totalTokens": 18000,
    "estimatedCostUsd": 0.012,
    "provider": "alibaba",
    "model": "qwen3.6-plus"
  }
}
```

**Task Service 可以利用**：
- 任务执行时长（endedAt - startedAt）
- Token 消耗（totalTokens）
- 成本估算（estimatedCostUsd）
- 执行状态（done / failed / killed / timeout）

### 5.2 Subagent Registry（`runs.json`）

```json
{
  "version": 2,
  "runs": {
    "run-uuid-1": {
      "runId": "run-uuid-1",
      "childSessionKey": "agent:dev3:subagent:abc123",
      "requesterSessionKey": "agent:main:main",
      "controllerSessionKey": "agent:main:main",
      "startedAt": 1714356000000,
      "endedAt": 1714356300000,
      "outcome": { "status": "ok" },
      "spawnMode": "session",
      "requesterOrigin": { "channel": "webchat" }
    }
  }
}
```

**Task Service 可以利用**：
- 父子任务关系（requesterSessionKey → childSessionKey）
- 任务执行结果（outcome）
- 来源渠道（requesterOrigin）

### 5.3 原生 Task Registry（`runs.sqlite`）

OpenClaw 原生 task 系统的 SQLite，包含完整的任务生命周期。

**Task Service 可以利用**：
- 任务状态机（queued → running → succeeded/failed）
- 任务与 subagent 的绑定关系（runtime: "subagent"）
- 终端摘要（terminalSummary）
- 错误信息（error）

### 5.4 数据读取路径

```
OpenClaw State Dir (默认 ~/.openclaw/state/)
├── subagents/
│   └── runs.json              ← Subagent 运行记录
├── tasks/
│   └── runs.sqlite            ← 原生 Task 注册表
└── agents/
    └── {agent}/
        └── sessions/
            └── sessions.json   ← Session 元数据
```

---

## 6. 实施路线

### Phase 1：基础改造（2-3 天）

1. **数据库迁移 v3**：增加 session_key、run_id 等字段
2. **TaskRepository 扩展**：新增 session 维度查询方法
3. **新增 Dispatch API**：`POST /api/tasks/dispatch`
4. **手动绑定**：Main agent 在 spawn subagent 时，手动将 task ID 传递给 subagent context

### Phase 2：采集器增强（2-3 天）

5. **OpenClaw 采集器升级**：读取 session store + subagent runs
6. **新建 OpenClawTaskCollector**：对接原生 task registry（runs.sqlite）
7. **自动状态同步**：subagent 结束时，自动更新关联任务状态

### Phase 3：自动化（3-4 天）

8. **自动派发**：Task service 监听新任务创建，自动触发 sessions_spawn
9. **Session 注入**：确保 subagent 启动时自动获取任务上下文
10. **Workspace 视图增强**：按 session 分组展示任务

### Phase 4：优化（按需）

11. **Token/成本统计**：从 session store 同步
12. **失败重试**：subagent 异常终止时自动重新派发
13. **嵌套 subagent 支持**：子任务可以 spawn 孙任务

---

## 7. 回答核心问题

### Q1: 当前按内容划分任务的问题是什么？

1. **内容与执行者解耦**：任务描述（"修改登录页面"）和执行它的 subagent session 之间没有关联。Subagent 启动后需要"找"自己的任务，而不是"被分配"任务。
2. **agent_id 粒度过粗**：多个 subagent 共享同一个 agent_id（如 "dev3"），无法区分具体是哪个 subagent 在执行。
3. **依赖轮询**：AgentStatusScheduler 轮询 pending tasks，subagent 需要主动查询，存在时间窗口导致"没有获取到"。
4. **手动拆分不可靠**：Main agent 需要正确识别子任务边界，手动创建，容易出错。

### Q2: 按 session 划分任务意味着什么？有什么优势？

意味着**任务的生命周期与 session 的生命周期绑定**：
- 创建任务 → spawn subagent → session 启动 → 自动执行 → session 结束 → 自动更新状态

优势：
- **零等待**：Subagent 启动时任务上下文已注入
- **精确追踪**：每个 session 的执行数据（时长、tokens、结果）自动关联到任务
- **自动清理**：Session 结束时任务自动标记完成/失败
- **天然支持并发**：不同 session 并行执行，互不干扰

### Q3: 两种方式能否结合？怎么结合？

**能，且应该结合。**

- **内容维度**定义任务的"是什么"（标题、描述、优先级、父子关系）
- **Session 维度**定义任务的"谁在做、怎么做"（执行者、执行环境、执行结果）
- 两者通过 `task.session_key ↔ session.childSessionKey` 关联

具体结合方式：
1. 父任务保持内容维度（"重构用户模块"）
2. 每个子任务绑定一个 subagent session
3. Subagent session 结束 → 子任务自动标记完成
4. 所有子任务完成 → 父任务标记完成
5. 内容维度用于展示和搜索，Session 维度用于执行和追踪

### Q4: OpenClaw 的哪些数据可以被 Task Service 利用？

| 数据源 | 文件路径 | 可用信息 |
|--------|---------|---------|
| Session Store | `~/.openclaw/agents/{agent}/sessions/sessions.json` | 执行时长、tokens、成本、状态 |
| Subagent Registry | `~/.openclaw/state/subagents/runs.json` | 父子关系、执行结果、来源渠道 |
| Task Registry | `~/.openclaw/state/tasks/runs.sqlite` | 完整任务生命周期、与 subagent 的绑定 |
| Transcripts | `~/.openclaw/agents/{agent}/sessions/{key}/` | 执行过程的对话记录（调试用） |

---

## 8. 风险与注意事项

1. **不修改 OpenClaw 核心代码**：所有集成通过读取 OpenClaw 的状态文件实现，不侵入 OpenClaw 运行时
2. **向后兼容**：现有 API 全部保留，新增字段都有默认值
3. **文件锁保护**：读取 OpenClaw 状态文件时使用文件锁（withFileLock），避免与 OpenClaw 运行时冲突
4. **数据一致性**：OpenClaw 的状态文件是 OpenClaw 的权威来源，ice-bubble-task 是镜像，不反向写入
5. **权限问题**：Task Service 运行用户需要对 OpenClaw state 目录有读权限

---

## 附录：当前文件索引

| 文件 | 路径 | 用途 |
|------|------|------|
| 任务类型 | `src/types/task.ts` | Task 数据结构定义 |
| 任务 API | `src/api/tasks.ts` | REST API 路由 |
| 任务仓库 | `src/storage/task-repository.ts` | SQLite 数据访问 |
| 采集器 | `src/collectors/openclaw-collector.ts` | 从 task-store.json 采集 |
| Agent 调度 | `src/scheduler/agent-status-scheduler.ts` | Pending 任务轮询 |
| 主应用 | `src/app.ts` | 应用启动、路由注册 |
| Subagent Registry | `~/.openclaw/state/subagents/runs.json` | OpenClaw subagent 运行记录 |
| Session Store | `~/.openclaw/agents/{agent}/sessions/sessions.json` | OpenClaw session 元数据 |
| Task Registry | `~/.openclaw/state/tasks/runs.sqlite` | OpenClaw 原生任务系统 |
