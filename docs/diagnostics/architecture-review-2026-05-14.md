# ice-bubble 架构盘点报告

> 日期：2026-05-14
> 概述：全面盘点三层架构（Desktop/Admin/Collector）的 API 路由、数据流、模块依赖关系，识别出路由重复注册、双连接冗余等风险。  
> 版本：1.1.1  
> 审计范围：ice-bubble-admin / ice-bubble-collector-openclaw / ice-bubble-desktop

---

## 一、项目概览

ice-bubble 是一个三层架构的 OpenClaw 多 Agent 团队协作管理系统：

| 层 | 模块 | 端口 | 技术栈 |
|---|------|------|--------|
| VIEW LAYER | ice-bubble-desktop | 1420 (dev) | Tauri + Vue3 + Element Plus + Pinia |
| BIZ LAYER | ice-bubble-admin | 13000 | Express + TypeScript + better-sqlite3 |
| DATA LAYER | ice-bubble-collector-openclaw | 13100 | Express + chokidar + better-sqlite3 |

三个模块通过 npm workspace 管理，统一版本号 `1.1.1`。

---

## 二、API 路由完整清单

### 2.1 Admin API（端口 13000）

#### 无需认证

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/health` | 健康检查 | `index.ts` (inline) |
| GET | `/api/auth/status` | 认证状态查询 | `index.ts` (inline) |
| POST | `/api/auth/verify` | Token 验证 | `index.ts` (inline) |
| GET | `/api/resources/avatars/:filename` | 头像文件（浏览器 img 标签） | `index.ts` (inline) |

#### 需要认证（Bearer Token）— 所有 `/api/*` 路由

**数据 API (`src/api/data.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/stats` | 数据统计 | `data.ts` |
| GET | `/api/sessions` | Sessions 列表（支持 agent_id/channel 过滤） | `data.ts` |
| GET | `/api/sessions/grouped` | 按 agent 分组的 sessions | `data.ts` |
| GET | `/api/sessions/:key` | 单个 session 详情 | `data.ts` |
| GET | `/api/messages` | 消息列表（支持 ?archived=true 查归档） | `data.ts` |
| GET | `/api/messages/timeline` | 消息时间线（支持筛选/搜索/翻页） | `data.ts` |
| POST | `/api/messages/deduplicate` | 去重 admin_messages | `data.ts` |
| GET | `/api/agents` | Agent 列表（含实时状态） | `data.ts` |
| GET | `/api/agents/overview` | Agent 概览聚合 | `data.ts` |
| GET | `/api/agents/with-activity` | Agent + 活动热力图 | `data.ts` |
| GET | `/api/agents/token-summary` | Token 统计 | `data.ts` |
| POST | `/api/agents/token-summary/rebuild` | 重建 Token 统计表 | `data.ts` |
| POST | `/api/agents/activity/rebuild` | 重建活动统计表 | `data.ts` |
| GET | `/api/agents/:id/avatar` | Agent 头像 | `data.ts` |
| PUT | `/api/agents/:id/avatar` | 更新 Agent 头像 | `data.ts` |
| GET | `/api/agents/:id/activity` | Agent 活动热力图 | `data.ts` |

**会话 API（内联）**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/sessions/:key/messages` | 会话消息列表 | `index.ts` (inline) |

**模块管理 API (`src/api/modules.ts`，前缀 `/api/modules`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/modules` | 模块列表 | `modules.ts` |
| POST | `/api/modules` | 新增模块 | `modules.ts` |
| GET | `/api/modules/:key` | 模块详情 | `modules.ts` |
| PUT | `/api/modules/:key` | 更新模块 | `modules.ts` |
| DELETE | `/api/modules/:key` | 删除模块 | `modules.ts` |
| GET | `/api/modules/:key/status` | 模块状态（手动触发轮询） | `modules.ts` |
| GET | `/api/modules/:key/config` | 模块运行时配置 | `modules.ts` |
| POST | `/api/modules/test-connection` | 测试模块连接 | `modules.ts` |

**资源 API (`src/api/resources.ts`，前缀 `/api/resources`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/resources/avatars/:filename` | 头像文件（从 DB 读取） | `resources.ts` |

**子 Agent 任务 API (`src/api/tasks.ts`，前缀 `/api/subagent-tasks`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/subagent-tasks` | 子 Agent 任务列表 | `tasks.ts` |

**会话分组 API (`src/api/session-groups.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/session-groups` | 获取分组列表 | `session-groups.ts` |
| POST | `/api/session-groups` | 创建分组 | `session-groups.ts` |
| PATCH | `/api/session-groups/:id` | 更新分组 | `session-groups.ts` |
| DELETE | `/api/session-groups/:id` | 删除分组 | `session-groups.ts` |
| POST | `/api/session-groups/:id/members` | 添加成员 | `session-groups.ts` |
| DELETE | `/api/session-groups/:id/members/:sessionKey` | 移除成员 | `session-groups.ts` |
| POST | `/api/sessions` | 创建新会话（通过 Gateway RPC） | `session-groups.ts` |

**会话偏好 API (`src/api/session-preferences.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/session-preferences` | 获取偏好（置顶/隐藏） | `session-preferences.ts` |
| PUT | `/api/session-preferences` | 更新偏好 | `session-preferences.ts` |

**统一会话 API (`src/api/sessions-unified.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/sessions/unified` | Gateway + Admin 合并会话 | `sessions-unified.ts` |

**工作区 API (`src/api/workspace.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/workspace/tree` | 目录树 + git 状态 | `workspace.ts` |
| GET | `/api/workspace/git-status` | Git 统计摘要 | `workspace.ts` |
| GET | `/api/workspace/scan` | 扫描一级子目录 | `workspace.ts` |

**设置 API (`src/api/settings.ts`)**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/settings` | 读取配置（掩码敏感字段） | `settings.ts` |
| PUT | `/api/settings` | 保存配置（白名单合并） | `settings.ts` |

**聊天 API**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| POST | `/api/chat/send` | 发送聊天消息（SSE 推送通道） | `index.ts` (inline) |
| POST | `/api/chat/abort` | 中止聊天流 | `index.ts` (inline) |
| GET | `/api/chat/stream` | SSE 聊天流 | `index.ts` (inline) |
| GET | `/api/chat/history` | 聊天历史（HTTP 代理→Gateway） | `chat-proxy.ts` |
| POST | `/api/chat/abort` | 中止（HTTP 代理→Gateway） | `chat-proxy.ts` |

**Gateway 代理 API**

| 方法 | 路径 | 说明 | 文件 |
|------|------|------|------|
| GET | `/api/gateway/sessions` | Gateway 会话列表 | `chat-proxy.ts` |

**WebSocket**

| 协议 | 路径 | 说明 | 文件 |
|------|------|------|------|
| WS | `/ws` | Desktop ↔ Admin ↔ Gateway 桥接 | `ws-server.ts` |

### 2.2 Collector API（端口 13100）

**Meta 路由 (`src/api/routes/meta.ts`)**

| 方法 | 路径 | 说明 | 需认证 | 文件 |
|------|------|------|--------|------|
| GET | `/api/meta/status` | 模块状态（含 runtime/health） | 可配置 | `meta.ts` |
| GET | `/api/meta/config` | 模块运行时配置 | 可配置 | `meta.ts` |

**Data 路由 (`src/api/routes/data.ts`)**

| 方法 | 路径 | 说明 | 需认证 | 文件 |
|------|------|------|--------|------|
| GET | `/api/data/sessions` | Sessions 列表（支持 since 增量） | 可配置 | `data.ts` |
| GET | `/api/data/messages` | 消息列表（支持 session_key/since） | 可配置 | `data.ts` |
| GET | `/api/data/agents` | Agent 列表 | 可配置 | `data.ts` |
| GET | `/api/data/events` | Session 事件列表 | 可配置 | `data.ts` |
| GET | `/api/data/stats` | 数据统计 | 可配置 | `data.ts` |

### 2.3 Desktop 前端请求清单

**REST API（通过 `src/api/client.ts`）**

| 方法 | Admin 端点 | 调用位置 |
|------|-----------|---------|
| GET | `/stats` | `client.ts` → `getStats()` |
| GET | `/sessions/unified` | `client.ts` → `getUnifiedSessions()` |
| GET | `/sessions` | `client.ts` → `getSessions()` |
| GET | `/sessions/:key` | `client.ts` → `getSession()` |
| GET | `/sessions/:key/messages` | `client.ts` → `getSessionMessages()` |
| GET | `/messages/timeline` (带噪音过滤) | `client.ts` → `getChatTimeline()` |
| GET | `/messages` | `client.ts` → `getMessages()` |
| GET | `/messages/timeline` | `client.ts` → `getMessagesTimeline()` |
| GET | `/modules` | `client.ts` → `getModules()` |
| GET | `/modules/:key/status` | `client.ts` → `getModuleStatus()` |
| GET | `/modules/:key/config` | `client.ts` → `getModuleConfig()` |
| POST | `/modules/test-connection` | `client.ts` → `testModuleConnection()` |
| POST/PUT | `/modules[/:key]` | `client.ts` → `saveModule()` |
| DELETE | `/modules/:key` | `client.ts` → `deleteModule()` |
| PUT | `/modules/:key` | `client.ts` → `toggleModule()` |
| GET | `/agents` | `client.ts` → `getAgents()` |
| GET | `/agents/with-activity` | `client.ts` → `getAgentsWithActivity()` |
| GET | `/agents/token-summary` | `client.ts` → `getTokenSummary()` |
| GET | `/session-groups` | `client.ts` → `getSessionGroups()` |
| POST | `/session-groups` | `client.ts` → `createGroup()` |
| PATCH | `/session-groups/:id` | `client.ts` → `updateGroup()` |
| DELETE | `/session-groups/:id` | `client.ts` → `deleteGroup()` |
| POST | `/session-groups/:id/members` | `client.ts` → `addGroupMember()` |
| DELETE | `/session-groups/:id/members/:key` | `client.ts` → `removeGroupMember()` |
| POST | `/sessions` | `client.ts` → `createSession()` |
| GET | `/session-preferences` | `client.ts` → `getSessionPreferences()` |
| PUT | `/session-preferences` | `client.ts` → `updateSessionPreferences()` |
| GET | `/settings` | `client.ts` → `getSettings()` |
| PUT | `/settings` | `client.ts` → `updateSettings()` |
| GET | `/subagent-tasks` | `client.ts` → `fetchSubagentTasks()` |

**Chat API（`src/api/chat.ts`）**

| 方法 | Admin 端点 | 说明 |
|------|-----------|------|
| POST | `/chat/send` | 发送聊天消息 |
| GET | `/chat/stream` | SSE 流式连接 |
| POST | `/chat/abort` | 中止聊天流（使用 inline 版本，非 chat-proxy 版本） |

**WebSocket（`src/services/gateway-client.ts`）**

| 协议 | 端点 | 说明 |
|------|------|------|
| WS | `/ws` | WebSocket 连接（req/res/event 协议） |
| — | `chat.send` | 通过 WS 发送消息 |
| — | `chat.abort` | 通过 WS 中止 |
| — | `chat.history` | 通过 WS 获取历史 |
| — | `sessions.list` | 通过 WS 获取会话列表 |

### 2.4 路由冲突分析

1. **`POST /api/chat/abort` 重复注册**：`index.ts` 内联版本和 `chat-proxy.ts` 都注册了此路由。Express 会使用先注册的版本（内联版本），proxy 版本被遮盖。Desktop 用户使用 `chat.ts` 中的 `abortChat()` 调用的是内联版本。

2. **`/api/resources/avatars/:filename` 重复注册**：`index.ts` 内联（无需认证）和 `resources.ts`（需认证）都处理此路径。内联版本在 auth 中间件之前注册，所以实际生效的是无需认证版本。`resources.ts` 版本永远不会被命中。

3. **路由顺序依赖**：`/api/sessions/unified` 必须在 `/api/sessions/:key` 之前注册，否则 `unified` 会被 `:key` 参数捕获。代码中通过注释和注册顺序保护了这一点，但缺乏自动化保护。

---

## 三、数据流完整审计

### 3.1 数据采集链路：OpenClaw → Collector SQLite

```
OpenClaw 进程
  ├── 写入 JSONL 会话文件
  │     (/home/dabai/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl)
  │
  ▼
FileWatcher (chokidar)
  ├── 监听 agents/ 目录文件变更
  ├── 支持 polling 模式（网络/跨系统场景）
  │
  ▼
FileCollector
  ├── readJsonlFileIncremental() — 增量读取新行
  ├── session-key-builder — 从文件路径构造 session_key
  │
  ▼
CollectionPipeline (管道处理)
  ├── 1. 解析：JSONL 行 → OpenClawEvent
  ├── 2. 转换：OpenClawEvent → SessionMessage (统一格式)
  ├── 3. 验证：DataValidator（必填字段检查）
  ├── 4. 去重：Deduplicator（基于 message_id + content hash）
  ├── 5. 批量写入：BatchWriter（20条/批，2s 刷新）
  │
  ▼
Collector SQLite (collector-dev.db)
  ├── collector_sessions
  ├── collector_messages
  └── collector_model_events
```

**隐患分析：**
- ✅ 增量读取 + 断点续传设计合理，`file-state.json` 记录已读位置
- ⚠️ chokidar polling 模式在 WSL 跨文件系统场景下性能低（500ms 轮询间隔）
- ✅ 去重机制可防重放，但 cacheSize 仅 5000，高频场景下可能溢出
- ⚠️ JSONL 文件如果被 OpenClaw 截断写（崩溃场景），可能导致最后一行解析失败（已通过 try-catch 降级处理）

### 3.2 数据同步链路：Collector → Admin

```
DataSync（定时调度器，60s 间隔）
  │
  ▼
CollectorClient（HTTP 客户端，10s 超时）
  ├── GET /api/data/sessions?since={lastSync}&offset=N
  ├── GET /api/data/messages?since={lastSync}&offset=N
  ├── GET /api/data/agents
  ├── GET /api/data/events?since={lastSync}&offset=N
  │
  ▼
Processor（processSession / processMessage）
  ├── 添加 source_module 溯源字段
  ├── 字段映射（collector → admin 格式）
  │
  ▼
DataRepository
  ├── saveSessions — 批量 upsert 到 admin_sessions
  ├── saveMessages — 批量 upsert 到 admin_messages
  ├── refreshAgents — 全量刷新 admin_agents
  ├── saveModelEvents — 写入 admin_model_events
  ├── computeSessionStatsIncremental — 增量统计
  ├── upsertAgentActivityBatch — 批量活动计数
  │
  ▼
Admin SQLite (admin.db)
  ├── admin_sessions
  ├── admin_messages
  ├── admin_agents
  ├── admin_model_events
  ├── admin_sync_progress（同步水位标记）
  ├── agent_activity_daily（聚合表）
  └── token_summary（聚合表）
```

**隐患分析：**
- ✅ 增量同步通过 `admin_sync_progress` 表的水位标记实现，避免全量拉取
- ✅ 批量分页拉取（500条/页），避免单次请求过大
- ⚠️ Admin 重启后 `admin_sync_progress` 中的 `last_sync_time` 可能丢失，导致重新拉取大量数据（`getSyncProgress` 无记录时 `since=undefined`，拉全量）
- ⚠️ 同步间隔 60s 是固定轮询，非事件驱动。Collector 有新数据后，Admin 最多延迟 60s 才能同步到
- ⚠️ Collector HTTP API 没有返回 `total` 字段来指示是否还有更多数据，依赖 `返回数量 < 请求数量` 判断（可靠但不够精确）
- ✅ 同步失败不阻塞其他同步任务（`catch` 后继续）

### 3.3 数据展示链路：Admin → Desktop

#### REST API（拉模式）

```
Desktop (Vue3)
  │
  ▼
api/client.ts (fetchJson)
  ├── Bearer Token 认证
  ├── API 监控 (apiMonitor)
  │
  ▼
Admin REST API (端口 13000)
  └── DataRepository → SQLite
```

#### WebSocket（推模式）

```
Desktop (gatewayClient)
  │
  ▼
WebSocket /ws
  │
  ▼
GatewayWsServer (Admin)
  ├── 认证（token query/header）
  ├── 发送 connect.hello
  ├── 转发 req → GatewayProxy.request()
  ├── 广播 Gateway 事件 → Desktop
  │
  ▼
GatewayProxy → Gateway (端口 18789)
```

**隐患分析：**
- ✅ REST 和 WebSocket 双通道，覆盖拉取和推送场景
- ⚠️ Desktop WebSocket 连接时，`GatewayProxy` 可能尚未连接成功（`index.ts` 中 `gatewayProxy` 可能为 null）。此时 `GatewayWsServer` 仍会启动，但转发到 Gateway 的请求会失败
- ✅ WebSocket 心跳 30s + ping/pong 断线检测
- ⚠️ Gateway 事件广播（chat/agent/sessions.changed 等）采用全量推送，所有 Desktop 客户端都会收到所有事件，未做 session 级别过滤

### 3.4 Gateway WebSocket 数据流向

```
┌─────────┐   WS    ┌──────────┐   WS    ┌─────────┐
│ Desktop │◄───────►│  Admin   │◄───────►│ Gateway │
│ (Vue3)  │  /ws    │(Gateway- │ 18789   │(OpenClaw│
│         │         │ WsServer)│         │  Core)  │
└─────────┘         └──────────┘         └─────────┘

请求流：Desktop → WsServer → GatewayProxy → Gateway → 响应原路返回
事件流：Gateway → GatewayProxy → WsServer → Desktop（广播）
```

**隐患分析：**
- ⚠️ Admin 同时维护两个到 Gateway 的 WebSocket 连接：
  1. `GatewayProxy`（`index.ts` 创建，用于 HTTP API proxy 和 WsServer 转发）
  2. `GatewayConnection`（`index.ts` 创建，用于 SSE 聊天推送）
  
  两个连接都向 Gateway 认证，功能有部分重叠。`GatewayConnection` 是 SSE 聊天通道，`GatewayProxy` 是请求/事件通道。架构上可以合并但当前未合并。
- ✅ 连接失败自动重连（指数退避，最高 30s）
- ✅ Gateway 不可用时 Admin 仍可独立运行（GatewayProxy 连接失败非致命）

---

## 四、模块间依赖关系

### 4.1 依赖图

```
                    ┌─────────────┐
                    │  OpenClaw   │
                    │  (Gateway)  │
                    │  :18789     │
                    └──┬──────┬───┘
                       │ WS   │ WS
              ┌────────▼──┐ ┌─▼───────────┐
              │ Collector │ │ Admin        │
              │ :13100    │ │ :13000       │
              │           │ │              │
              │ watches   │ │ polls HTTP   │
              │ JSONL ────┼─┼─► /api/data/*│
              │ → SQLite  │ │              │
              └───────────┘ │   ┌──────────┤
                            │   │Gateway   │
                            │   │WsServer  │
                            │   └────┬─────┘
                            │        │ WS /ws
                            │   ┌────▼─────┐
                            │   │ Desktop   │
                            │   │ :1420     │
                            │   │ (Tauri)   │
                            │   └──────────┘
                            │   REST /api/*
                            └───────────────┘
```

### 4.2 耦合点分析

#### 强耦合

| 耦合点 | 描述 | 风险等级 |
|--------|------|---------|
| Collector HTTP API 契约 | Admin 的 `CollectorClient` 严格依赖 Collector 的 `/api/data/*` 响应格式 | 🔴 高 |
| Gateway WebSocket 协议 | Admin、Desktop 均依赖 Gateway 的 req/res/event 协议和 `connect` 认证流程 | 🔴 高 |
| Collector → Admin 字段映射 | `processor.ts` 中的 session/message 字段映射是硬编码的 | 🟡 中 |
| 认证 Token | Admin 和 Collector 通过各自的 `auth.token` 配置独立认证，但 Desktop 只持有 Admin 的 token | 🟡 中 |

#### 松耦合

| 耦合点 | 描述 |
|--------|------|
| Desktop ↔ Admin REST API | 通过标准 HTTP + JSON，可独立替换 |
| Desktop 配置 | 通过 Setup 页面配置 Admin URL + Token，无需编译时绑定 |
| 模块注册 | Admin 通过 config.json 的 `modules` 数组动态注册 Collector |

### 4.3 共享/重复代码

| 内容 | 状态 | 建议 |
|------|------|------|
| OpenClaw 事件类型 | Collector 有完整定义（`types/openclaw.ts`），Admin 无直接引用 | 提取为 `@ice-bubble/shared` 共享包 |
| Collector DTO 类型 | Admin 在 `collector-client.ts` 中重复定义了 `CollectorSession`/`CollectorMessage` 等 | 与 Collector 的类型保持同步依赖 |
| 版本号 | 通过 `scripts/sync-version.js` 从根 `package.json` 同步到各模块 | 当前方案已足够 |
| 认证逻辑 | Admin 和 Collector 各自实现 Bearer Token 中间件，实现略有不同 | 可提取共享中间件 |
| SQLite 管理 | 两个模块各自实现 `SqliteManager`/`DbManager`，功能相似 | 可提取共享 DB 工具层 |

### 4.4 不必要的依赖

1. **Admin 直接依赖 Collector 的原始数据类型**：`collector-client.ts` 中重复定义了 `CollectorSession`、`CollectorMessage` 等接口，但没有与 Collector 的类型文件建立编译时依赖。如果 Collector 修改了字段，Admin 端不会有类型错误提示。

2. **Desktop API 路径硬编码**：`client.ts` 中的 API 路径（如 `/sessions/unified`、`/modules/test-connection`）是硬编码字符串，与 Admin 路由定义没有共享常量或类型安全。

3. **两个 Gateway 连接**（见 3.4 节）：`GatewayProxy` 和 `GatewayConnection` 各自独立连接 Gateway，存在冗余。

---

## 五、问题与风险汇总

### 🔴 高风险

1. **路由重复注册**：`POST /api/chat/abort` 和 `GET /api/resources/avatars/:filename` 均存在双注册，其中一个被遮蔽。虽然当前不影响功能，但是潜在的维护陷阱。

2. **同步水位丢失**：Admin 重启后 `admin_sync_progress` 中的 `last_sync_time` 如果丢失，会导致全量重新同步，可能造成大量 HTTP 请求和数据库写入。

3. **无共享类型定义**：Admin 和 Collector 之间的 API 契约完全靠约定维护，没有编译时类型检查。Collector 修改响应格式后，Admin 编译通过但运行时可能出错。

### 🟡 中风险

4. **轮询延迟**：Admin 以 60s 固定间隔轮询 Collector，新数据最多延迟 60s。对于聊天场景不够实时。

5. **Gateway 依赖非优雅降级**：当 Gateway 不可用时，`/api/sessions/unified` 返回 502，`/api/sessions` (POST) 返回 503，而非返回 Admin 本地数据。

6. **WebSocket 全量广播**：Gateway 事件未按 session 或 agent 过滤，所有 Desktop 客户端接收所有事件。

7. **WSL 跨文件系统**：Collector 在 WSL 中监听 Windows 文件系统时使用 polling 模式，延迟高（500ms 间隔）。

### 🟢 低风险

8. **Collector HTTP API 无 total 字段**：分页依赖 `返回数 < 请求数` 来判断结束，边界条件不够精确。

9. **Desktop API 路径硬编码**：无法通过 IDE 重构自动更新。

---

## 六、改进建议

### 短期（可快速落地）

1. **清理重复路由**：删除 `chat-proxy.ts` 中的 `POST /api/chat/abort`（已被 `index.ts` 内联版本遮盖），或统一到一个文件。
2. **删除 `resources.ts` 的无用路由**：`resources.ts` 中的 avatars 路由已被 `index.ts` 的无认证版本遮盖，可移除或统一。
3. **同步水位持久化加固**：在 `admin_sync_progress` 初始化时检查是否有数据但无水位记录，避免全量重拉。

### 中期（推荐）

4. **提取共享类型包**：创建 `packages/shared/` 目录（或 `@ice-bubble/types` npm 包），放置 Collector DTO 类型、Gateway 协议类型、API 路径常量。
5. **Gateway 连接合并**：评估是否可以将 `GatewayProxy` 和 `GatewayConnection` 合并为一个连接管理器，减少冗余。
6. **增加 WebSocket 事件过滤**：Gateway 事件广播时按 session_key 路由到订阅了该 session 的 Desktop 客户端，减少不必要的数据传输。

### 长期（架构优化）

7. **考虑事件驱动同步**：Collector 通过 Webhook 或消息队列通知 Admin 新数据到达，替代固定轮询。
8. **共享数据库访问层**：抽取 Admin 和 Collector 中重复的 SQLite 管理逻辑（WAL 配置、迁移框架、连接池）为共享工具包。
9. **API 路径常量化**：在共享包中定义 API 路径枚举，Desktop 和 Admin 共用，编译时检查。

---

*报告生成时间：2026-05-14 21:19 CST*  
*审计工具：静态代码分析（人工审查 + 自动化扫描）*
