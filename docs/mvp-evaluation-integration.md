> ⚠️ 本文档标记于 2026-04，可能与当前实现不一致，仅供参考

# MVP 评估：Admin 集成 Subagent Task 解析方案

## 1. 背景与目标

在 Admin 的 `DataSync` 类中实现消息解析引擎，自动从 collector 采集的消息中识别 subagent 事件，调用 Task API 创建/更新任务。

---

## 2. 整体架构

```
Collector SQLite
    │ HTTP /api/data/messages
    ▼
CollectorClient
    │ CollectorMessage[]
    ▼
DataSync.syncMessages()     ← 现有逻辑，批量同步
    │
    ├─ processor.processMessage()   ← 溯源字段处理
    │
    ├─ repository.saveMessages()     ← 写入 admin.db
    │
    └─ [事件] messages-synced        ← NEW: 批次完成事件
           │
           ▼
    SubagentEventParser            ← NEW: 独立文件
           │ 接收 CollectorMessage[] + sourceModule
           │ 1. 跳过 is_system_noise
           │ 2. 解析 [Subagent Task]: xxx  → POST /api/tasks
           │ 3. 解析 completion event     → PATCH /api/tasks/:id/status
           │
           ▼
    TaskClient                      ← NEW: Task HTTP 客户端（含降级）
           │ /health 探测 + 缓存
           │ POST /api/tasks
           │ PATCH /api/tasks/:id/status
           ▼
    ice-bubble-task  API (SQLite)
```

### 关键设计决策

- **事件总线不引入 EventEmitter**：直接在 `syncMessages` 批次循环结束后调用解析器函数，避免运行时类型问题
- **解析与同步串行但独立**：解析在 `syncAll()` 的 `await` 链中执行，不会拖慢下一个 poll 周期（poll 由 `setInterval` 独立触发）
- **Task 模块降级**：静默降级，Task 不可用时只记录 error log，不影响消息同步

---

## 3. Event Emitter 集成

### 3.1 集成点

在 `data-sync.ts` 的 `syncMessages` 方法中，每批次处理完成后 emit 事件：

```typescript
// data-sync.ts 修改点（syncMessages 内部）
while (true) {
    const data = await this.client.getMessages({ limit, offset, since });
    if (data.messages.length === 0) break;

    const processed = data.messages.map(row => processMessage(row, sourceModule));
    this.repository.saveMessages(processed);
    totalSynced += processed.length;

    // [NEW] 触发 subagent 事件解析（fire-and-forget，不阻塞主循环）
    this.emit('messages-synced', processed, sourceModule);

    this.repository.updateSyncProgress('admin_messages');
    if (data.messages.length < limit) break;
    offset += limit;
}
```

### 3.2 是否需要新文件

**建议新增两个文件**：

1. `src/data/subagent-event-parser.ts` — 消息解析引擎
2. `src/data/task-client.ts` — Task HTTP 客户端（含降级）

理由：
- `data-sync.ts` 职责已足够清晰（同步调度），解析逻辑独立后更利测试
- TaskClient 涉及网络调用和降级策略，独立利于维护

### 3.3 异步解析是否拖慢周期

**不会**。解析通过 `emit('messages-synced', ...)` 触发，当前实现为 `setImmediate` 或直接调用，解析失败不影响 `syncMessages` 的下一个循环。

更优方案：**批次结束时直接调用解析器函数**，不在 sync 流程中等待结果：

```typescript
// 批次循环结束后调用，不 await
this.parseSubagentEvents(processed, sourceModule);
```

---

## 4. 消息解析逻辑

### 4.1 跳过条件

以下消息**跳过解析**：

1. `message_type` 非 `user` 的（Subagent Task 事件出现在 user 消息中）
2. `is_system_noise === true` 的消息（通过 `analyzeMessageMeta` 判定）
3. `content` 为 null 或空字符串
4. session_key 包含 `checkpoint` 的

```typescript
// subagent-event-parser.ts
function shouldSkip(msg: CollectorMessage): boolean {
    if (msg.message_type !== 'user') return true;
    if (!msg.content) return true;
    if (msg.session_key.includes('checkpoint')) return true;

    // 复用已有的噪音识别
    const meta = analyzeMessageMeta({ message_type: msg.message_type, content: msg.content, agent_name: '' });
    if (meta.is_system_noise) return true;

    return false;
}
```

### 4.2 Subagent Task 创建事件

**消息格式**：`[Subagent Task]: <title> [agent_id=<id>]`

**提取逻辑**：

```typescript
interface SubagentTaskEvent {
    type: 'create';
    title: string;
    agent_id: string;
    raw_message: CollectorMessage;
}

function parseSubagentTaskEvent(content: string): SubagentTaskEvent | null {
    const match = content.match(/^\[Subagent Task\]:\s*(.+?)(?:\s+agent_id=(\S+))?$/);
    if (!match) return null;
    return { type: 'create', title: match[1].trim(), agent_id: match[2] ?? 'unknown', raw_message: null as any };
}
```

**调用 API**：

```typescript
await taskClient.createTask({ title, agent_id });
// POST /api/tasks → { id, title, agent_id, status: 'pending', ... }
```

> 注意：Subagent 发布的任务消息中，`agent_id` 可能缺失，此时降级为 `'unknown'` 或从 `session_key` 推导。

### 4.3 Subagent Task Completion 事件

**消息格式**：根据 collector 中 collector 写入的 completion event 内容确定。

通用匹配逻辑：

```typescript
interface CompletionEvent {
    type: 'completion';
    taskId: string;  // 对应 TaskRepository 中已创建的 task id
    status: 'completed' | 'failed';
    raw_message: CollectorMessage;
}

function parseCompletionEvent(content: string): CompletionEvent | null {
    // 匹配 [Subagent completion] <taskId> completed/failed
    const match = content.match(/^\[Subagent completion\]:\s*(\S+)\s+(completed|failed)$/);
    if (!match) return null;
    return { type: 'completion', taskId: match[1], status: match[2] as 'completed' | 'failed', raw_message: null as any };
}
```

> **风险**：completion event 的消息格式需要与 subagent 侧确认。当前 MVP 阶段可先实现通用正则，格式不符则静默跳过。

### 4.4 解析失败处理策略

| 场景 | 处理方式 |
|------|---------|
| 消息格式不匹配 | 静默跳过，记录 debug log |
| Task API 调用失败（网络） | 记录 error log，重试 1 次，失败则放弃 |
| Task ID 找不到 | 记录 warning，跳过 |
| TaskClient 降级（不可用） | 静默跳过 |

---

## 5. Task 模块降级设计

### 5.1 健康探测

Task API 没有独立的 `/health` 端点，探测方式为直接调用 `GET /api/tasks?limit=1`，超时 3s 内返回则认为可用。

### 5.2 缓存策略

```typescript
class TaskClient {
    private available: boolean | null = null;      // null = 未探测，true/false = 已探测
    private lastCheck: number = 0;
    private readonly CHECK_INTERVAL = 60_000;      // 60s 内不重复探测

    async isAvailable(): Promise<boolean> {
        const now = Date.now();
        if (this.available !== null && now - this.lastCheck < this.CHECK_INTERVAL) {
            return this.available;
        }
        try {
            const res = await fetch(`${this.baseUrl}/api/tasks?limit=1`, { signal: AbortSignal.timeout(3000) });
            this.available = res.ok;
        } catch {
            this.available = false;
        }
        this.lastCheck = now;
        return this.available;
    }
}
```

### 5.3 是否需要新建 TaskClient 类

**是**。理由：

- `CollectorClient` 只负责读 collector 数据，不适合承担向 Task API 写数据的职责
- TaskClient 需要独立的降级状态管理，与 `DataSync` 解耦
- 未来 Task API 可能有更多端点（PATCH status 等），Client 封装更清晰

---

## 6. 关键代码示例

### 6.1 TaskClient

```typescript
// src/data/task-client.ts
export class TaskClient {
    private baseUrl: string;
    private available: boolean | null = null;
    private lastCheck = 0;
    private readonly CHECK_INTERVAL = 60_000;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    async isAvailable(): Promise<boolean> {
        const now = Date.now();
        if (this.available !== null && now - this.lastCheck < this.CHECK_INTERVAL) {
            return this.available;
        }
        try {
            const res = await fetch(`${this.baseUrl}/api/tasks?limit=1`, { signal: AbortSignal.timeout(3000) });
            this.available = res.ok;
        } catch {
            this.available = false;
        }
        this.lastCheck = now;
        return this.available;
    }

    async createTask(params: { title: string; agent_id: string; priority?: string; description?: string }): Promise<{ id: string } | null> {
        if (!await this.isAvailable()) return null;
        try {
            const res = await fetch(`${this.baseUrl}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return null;
            return (await res.json()) as { id: string };
        } catch {
            return null;
        }
    }

    async updateTaskStatus(id: string, status: string): Promise<boolean> {
        if (!await this.isAvailable()) return false;
        try {
            const res = await fetch(`${this.baseUrl}/api/tasks/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
                signal: AbortSignal.timeout(5000),
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}
```

### 6.2 SubagentEventParser

```typescript
// src/data/subagent-event-parser.ts
import type { CollectorMessage } from './collector-client.js';
import type { TaskClient } from './task-client.js';

export interface ParserConfig {
    taskClient: TaskClient;
    taskApiBaseUrl: string;
}

const SUBAGENT_TASK_RE = /^\[Subagent Task\]:\s*(.+?)(?:\s+agent_id=(\S+))?$/;
const COMPLETION_RE = /^\[Subagent completion\]:\s*(\S+)\s+(completed|failed)$/;

export class SubagentEventParser {
    private client: TaskClient;

    constructor(client: TaskClient) {
        this.client = client;
    }

    async parseBatch(messages: CollectorMessage[], sourceModule: string): Promise<{ created: number; updated: number; errors: number }> {
        let created = 0, updated = 0, errors = 0;

        for (const msg of messages) {
            if (this.shouldSkip(msg)) continue;

            const content = msg.content!;

            // [Subagent Task]: xxx
            const taskMatch = content.match(SUBAGENT_TASK_RE);
            if (taskMatch) {
                const title = taskMatch[1].trim();
                const agent_id = taskMatch[2] ?? this.inferAgentId(msg.session_key);
                try {
                    const result = await this.client.createTask({ title, agent_id });
                    if (result) created++;
                } catch { errors++; }
                continue;
            }

            // [Subagent completion]: <id> completed/failed
            const compMatch = content.match(COMPLETION_RE);
            if (compMatch) {
                const taskId = compMatch[1];
                const status = compMatch[2];
                try {
                    const ok = await this.client.updateTaskStatus(taskId, status);
                    if (ok) updated++;
                } catch { errors++; }
            }
        }

        return { created, updated, errors };
    }

    private shouldSkip(msg: CollectorMessage): boolean {
        if (msg.message_type !== 'user') return true;
        if (!msg.content) return true;
        if (msg.session_key.includes('checkpoint')) return true;
        // 复用已有的噪音检测
        const { analyzeMessageMeta } = require('../storage/data-repository.js');
        const meta = analyzeMessageMeta({ message_type: msg.message_type, content: msg.content, agent_name: '' });
        return meta.is_system_noise;
    }

    private inferAgentId(sessionKey: string): string {
        // session_key 格式: agent:{agentId}:{channel}:{account}
        const match = sessionKey.match(/^agent:([^:]+):/);
        return match ? match[1] : 'unknown';
    }
}
```

### 6.3 DataSync 集成点

```typescript
// data-sync.ts — 改动
import { SubagentEventParser } from './subagent-event-parser.js';
import { TaskClient } from './task-client.js';

// 在构造函数中初始化
constructor(config: Partial<DataSyncConfig>, repository: DataRepository) {
    // ... 现有代码 ...
    const taskApiBase = config.taskApiBaseUrl ?? 'http://localhost:13102';
    this.taskClient = new TaskClient(taskApiBase);
    this.eventParser = new SubagentEventParser(this.taskClient);
}

// 在 syncMessages 批次循环结束后调用
private async syncMessages(sourceModule: string): Promise<void> {
    // ... 现有批次循环 ...
    while (true) {
        const data = await this.client.getMessages({ limit, offset, since });
        if (data.messages.length === 0) break;
        const processed = data.messages.map(row => processMessage(row, sourceModule));
        this.repository.saveMessages(processed);
        totalSynced += processed.length;
        this.repository.updateSyncProgress('admin_messages');

        // 解析 subagent 事件（fire-and-forget）
        this.eventParser.parseBatch(processed, sourceModule).catch(err => {
            logger.error('[DataSync] Subagent event parse failed', { error: err });
        });

        if (data.messages.length < limit) break;
        offset += limit;
    }
    // ...
}
```

---

## 7. 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| **新增** | `src/data/task-client.ts` | Task HTTP 客户端，含降级和缓存逻辑 |
| **新增** | `src/data/subagent-event-parser.ts` | Subagent 事件解析引擎 |
| **修改** | `src/data/data-sync.ts` | 集成 eventParser，Config 增加 taskApiBaseUrl |
| **修改** | `src/index.ts` | 构造 DataSync 时传入 taskApiBaseUrl |
| **修改** | `config/config.json` | 增加 taskApiBaseUrl 配置项 |

---

## 8. 预估代码行数（分文件）

| 文件 | 预估行数 | 说明 |
|------|---------|------|
| `src/data/task-client.ts` | ~80 行 | 含 isAvailable、createTask、updateTaskStatus |
| `src/data/subagent-event-parser.ts` | ~120 行 | 解析逻辑、正则、skip 判定 |
| `src/data/data-sync.ts` | +15 行 | 集成调用 |
| `config/config.json` | +1 行 | taskApiBaseUrl 配置 |
| **合计** | **~216 行** | |

---

## 9. MVP 范围界定

### Phase 1（MVP — 最小可用）

- 仅实现 `[Subagent Task]: xxx` → `POST /api/tasks` 的创建流程
- 不实现 completion 事件（等 subagent 侧确认格式后再做）
- TaskClient 降级：静默跳过，不重试
- 不修改 `config/config.json`，Task URL 写死在代码中或从环境变量读取

### Phase 2（完善）

- 实现 completion 事件解析（等 subagent 格式确认）
- TaskClient 增加重试逻辑（1 次）
- 配置化 taskApiBaseUrl
- 解析结果写入 admin.db 的专用表（可选，用于审计）

### Phase 3（产品化）

- 解析错误写入专用日志表
- WebSocket 实时推送任务创建通知给前端
- 任务列表页面支持查看 subagent 创建的任务

---

## 10. 风险与注意事项

### 10.1 格式不确定性

**风险**：Subagent 发布的 `[Subagent Task]:` 格式和 completion 事件格式尚未与 subagent 侧确认。
**缓解**：Phase 1 仅依赖正则匹配，格式不匹配静默跳过，不影响现有流程。

### 10.2 循环依赖

**风险**：`analyzeMessageMeta` 在 `data-repository.ts` 中通过 `require()` 引入，可能形成循环依赖。
**缓解**：将 `analyzeMessageMeta` 提取到独立文件 `src/utils/message-meta.ts`，data-sync 和 data-repository 均引用它。

### 10.3 消息重复解析

**风险**：如果 sync 同一批消息多次（如重试），subagent task 会被重复创建。
**缓解**：
- `saveMessages` 使用 `INSERT OR IGNORE`，消息去重
- 但解析器在消息保存后执行，仍可能重复解析
- 建议在 TaskClient.createTask 时做幂等检查（通过 title + agent_id 查重）

### 10.4 Task API 可用性

**风险**：Task API 和 Admin 可能部署在不同端口，Admin 启动时 Task API 未就绪。
**缓解**：TaskClient.isAvailable() 懒探测，首次调用时触发，不阻塞 Admin 启动。

### 10.5 性能

**风险**：每批次消息都触发 HTTP 调用给 Task API。
**缓解**：TaskClient 缓存可用性状态（60s），且 `POST /api/tasks` 本身是轻量 SQLite 写入。

---

## 11. 配置项

```typescript
// DataSyncConfig 增加字段
export interface DataSyncConfig {
    // ... 现有字段 ...
    /** Task API base URL（默认 http://localhost:13102）*/
    taskApiBaseUrl?: string;
    /** 是否启用 subagent 事件解析（默认 true） */
    subagentParserEnabled?: boolean;
}
```

```json
// config/config.json
{
    "dataSync": {
        "collectorBaseUrl": "http://localhost:13100",
        "moduleKey": "collector-openclaw",
        "pollInterval": 60000,
        "batchSize": 500,
        "taskApiBaseUrl": "http://localhost:13102",
        "subagentParserEnabled": true
    }
}
```
