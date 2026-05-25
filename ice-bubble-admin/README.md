<div align="center">

<h1>ice-bubble-admin</h1>

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repo](https://img.shields.io/badge/GitHub-100000?style=flat-square&logo=github&logoColor=white)](https://github.com/SakuraSmiles/ice-bubble)


> @ice-bubble/admin  
> ice-bubble 管理后台 API 服务 — 模块管理、数据同步、统一数据访问接口

</div>

---

## 项目简介

`@ice-bubble/admin` 是 ice-bubble 微服务系统的管理模块，负责：
1. **模块管理**：注册、查询、监控各个 collector 模块
2. **数据同步**：从 collector 增量同步 sessions、messages、agents 数据
3. **数据 API**：提供统一的数据访问接口

### 核心功能

| 功能 | 说明 | 状态 |
|------|------|------|
| 模块注册 | 从配置文件自动加载模块 | ✅ |
| 模块状态监控 | 定时查询 collector 状态 | ✅ |
| 数据同步 | 增量同步 sessions/messages/agents | ✅ |
| 数据溯源 | 记录数据来源模块和原始 ID | ✅ |
| REST API | 提供模块和数据接口 | ✅ |

### 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ | TypeScript 执行环境 |
| 语言 | TypeScript 5.3+ | 严格模式 |
| 数据库 | better-sqlite3 | SQLite 持久化存储 |
| HTTP 客户端 | Node.js fetch | 与 collector 通信 |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     ice-bubble-admin                        │
│                        (端口 13000)                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐    │
│  │   Modules   │  │    Data     │  │   Storage       │    │
│  │  Scheduler  │  │    Sync     │  │   Repository    │    │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘    │
│         │                │                   │              │
│         └────────────────┼───────────────────┘              │
│                          │                                  │
│                    SQLite (admin.db)                        │
└──────────┬───────────────┼───────────────────┬─────────────┘
           │               │                   │
           │ HTTP API      │ HTTP API          │
           │               │                   │
┌──────────▼───────────────┼───────────────────▼─────────────┐
│        Collector (openclaw)     Collector (opencode)        │
│           端口 13100              端口 13101                │
│  ┌─────────────────────┐   ┌─────────────────────┐        │
│  │ /api/data/sessions  │   │ /api/data/sessions  │        │
│  │ /api/data/messages  │   │ /api/data/messages  │        │
│  │ /api/data/stats     │   │ /api/data/stats     │        │
│  │ /api/data/agents    │   │ /api/data/agents    │        │
│  │ /api/meta/status    │   │ /api/meta/status    │        │
│  └─────────────────────┘   └─────────────────────┘        │
│           │                        │                       │
│    SQLite (只读)           OpenCode DB (只读)               │
│    .jsonl 文件               opencode.db (SQLite)            │
└─────────────────────────────────────────────────────────────┘
```

> **重要**：Admin 绝对不能直接访问 Collector 的 SQLite 数据库，必须通过 HTTP API 通信。两个 Collector 的 API 响应格式完全对齐，CollectorClient 无需区分平台。

---

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 生产启动
npm run start
```

---

## 配置说明

配置文件位于 `config/config.json`：

```json
{
  "server": {
    "port": 13000,
    "host": "localhost"
  },
  "auth": {
    "token": "your-secret-token"
  },
  "cors": {
    "enabled": true,
    "origins": ["http://localhost:3000"]
  },
  "database": {
    "path": "../data/admin.db",
    "walMode": true,
    "foreignKeys": true,
    "performance": {
      "cacheSize": -64000,
      "mmapSize": 268435456,
      "pageSize": 4096,
      "busyTimeout": 5000
    }
  },
  "logging": {
    "level": "info",
    "format": "pretty"
  },
  "cleanup": {
    "enabled": true,
    "healthDaysToKeep": 30,
    "eventDaysToKeep": 90,
    "statsDaysToKeep": 365,
    "schedule": "0 2 * * *"
  },
  "gateway": {
    "url": "ws://127.0.0.1:18789",
    "token": "your-gateway-token"
  },
  "modules": [
    {
      "moduleKey": "collector-openclaw",
      "name": "OpenClaw数据采集",
      "baseUrl": "http://localhost:13100",
      "enabled": true,
      "pollInterval": 30000
    },
    {
      "moduleKey": "collector-opencode",
      "name": "OpenCode数据采集",
      "baseUrl": "http://localhost:13101",
      "enabled": true,
      "pollInterval": 30000
    }
  ],
  "dataSync": {
    "collectorBaseUrl": "http://localhost:13100",
    "pollInterval": 60000,
    "batchSize": 500,
    "taskApiBaseUrl": "http://localhost:13102",
    "subagentParserEnabled": true
  },
  "dataSyncOpencode": {
    "collectorBaseUrl": "http://localhost:13101",
    "pollInterval": 30000,
    "batchSize": 500
  }
}
```

### 配置说明

| 配置项 | 说明 |
|--------|------|
| `auth.token` | Bearer Token 认证令牌。未设置时自动生成随机令牌，启动时日志输出。实际只检查 `auth.token`，没有 `enabled` 字段 |
| `cors.origins` | CORS 允许的来源列表 |
| `dataSync` | OpenClaw Collector 的数据同步配置（兼容保留，仍指向 `collector-openclaw`） |
| `dataSyncOpencode` | OpenCode Collector 的数据同步配置（双 Collector 架构关键配置） |
| `gateway` | OpenClaw Gateway 连接配置，用于 WebSocket 代理和 Chat SSE |

---

## API 文档

### 模块管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取所有模块列表 |
| GET | /api/modules/:key | 获取单个模块详情 |
| POST | /api/modules | 新增模块 |
| PUT | /api/modules/:key | 更新模块配置 |
| DELETE | /api/modules/:key | 删除模块 |
| POST | /api/modules/test-connection | 测试模块连接 |
| GET | /api/modules/:key/status | 获取模块状态 |
| GET | /api/modules/:key/config | 获取模块配置 |

### 数据 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stats | 获取统计汇总 |
| GET | /api/sessions | 获取会话列表 |
| GET | /api/sessions/:key | 获取会话详情 |
| GET | /api/sessions/:key/messages | 获取会话消息列表 |
| GET | /api/sessions/grouped | 获取分组会话列表 |
| GET | /api/sessions/timeline | 获取会话时间线 |
| GET | /api/sessions/flows | 获取会话流程图数据 |
| GET | /api/sessions/pending-summary | 获取待生成摘要的会话 |
| PUT | /api/sessions/summary | 更新会话摘要 |
| GET | /api/sessions/unified | 获取统一会话列表（结合 Gateway 实时状态） |
| GET | /api/messages | 获取消息列表 |
| GET | /api/messages/timeline | 获取时间线消息（群聊风格，支持过滤） |
| POST | /api/messages/deduplicate | 消息去重 |
| GET | /api/agents | 获取 Agent 列表 |
| GET | /api/agents/overview | 获取 Agent 概览（聚合统计） |
| GET | /api/agents/with-activity | 获取带活跃数据的 Agent 列表 |
| GET | /api/agents/token-summary | 获取 Token 统计汇总 |
| POST | /api/agents/token-summary/rebuild | 重建 Token 统计缓存 |
| POST | /api/agents/activity/rebuild | 重建 Agent 活动数据缓存 |
| GET | /api/agents/:id/avatar | 获取 Agent 头像 |
| PUT | /api/agents/:id/avatar | 上传 Agent 头像 |
| GET | /api/agents/:id/activity | 获取 Agent 活动详情 |

### Session Groups API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/session-groups | 获取会话分组列表 |
| POST | /api/session-groups | 创建会话分组 |
| PATCH | /api/session-groups/:id | 更新会话分组 |
| DELETE | /api/session-groups/:id | 删除会话分组 |
| POST | /api/session-groups/:id/members | 添加成员到分组 |
| DELETE | /api/session-groups/:id/members/:sessionKey | 从分组移除成员 |
| POST | /api/sessions | 创建新会话 |

### Session Preferences API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/session-preferences | 获取会话偏好设置 |
| PUT | /api/session-preferences | 更新会话偏好设置 |

### Workspace API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/workspace/tree | 获取工作区目录树 |
| GET | /api/workspace/git-status | 获取工作区 Git 状态 |
| GET | /api/workspace/scan | 扫描工作区 |

### Settings API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/settings | 获取系统设置 |
| PUT | /api/settings | 更新系统设置 |

### Subagent Tasks API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/subagent-tasks | 获取子任务列表 |

### Auth API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/auth/status | 获取认证状态 |
| POST | /api/auth/verify | 验证认证令牌 |

### Chat Gateway API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat/send | 发送聊天消息 |
| POST | /api/chat/abort | 中止当前回复 |
| GET | /api/chat/stream | SSE 聊天流 |
| GET | /api/chat/history | 聊天历史 |
| GET | /api/chat/sessions | 聊天 Sessions |

### Resources API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/resources/avatars/:filename | Agent 头像（无需认证，浏览器 `<img>` 无法发送 Authorization） |

> 注：头像上传端点 `PUT /api/agents/:id/avatar` 在 Agents API 中列出。

### Attachments API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/attachments/query | 查询附件（支持 `?session_key=...` 过滤） |
| GET | /api/attachments/:filename | 附件文件（无需认证，浏览器 `<img>` 无法发送 Authorization） |

### Media API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/media/batch | 批量媒体查询 |
| GET | /api/media/file/:id | 媒体文件下载（无需认证） |

### Gateway 代理路由

| 方法 | 路径 | 说明 |
|------|------|------|
| * | /api/gateway/* | Gateway HTTP 代理（转发至 OpenClaw Gateway） |
| WS | /ws | WebSocket 连接（Gateway 实时通信） |

### Health API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 健康检查（返回 `{ status: "ok", version: "..." }`） |

**GET /api/stats**
```json
{
  "sessionCount": 248,
  "messageCount": 96076,
  "agentCount": 17,
  "lastSyncTime": "2026-04-09 15:35:43"
}
```

**GET /api/sessions（Admin 自有端点）**
```json
{
  "sessions": [
    {
      "session_key": "agent:main:local:default:direct:c520c69e-...",
      "agent_id": "main",
      "channel": "local",
      "message_count": 2513,
      "last_message_at": "2026-05-14T14:38:00.000Z",
      "created_at": "2026-04-09T04:33:01.450Z"
    }
  ]
}
```

> 注：`/api/data/sessions` 为 Collector（13100）端点，Admin 通过数据同步从 Collector 获取。

---

## 项目结构

```
src/
├── index.ts                 # 入口文件（应用启动、路由注册、服务初始化）
├── api/
│   ├── chat-proxy.ts        # Chat / Gateway HTTP 代理路由
│   ├── data.ts              # 数据管理 REST API（sessions/messages/agents/stats）
│   ├── media.ts             # 媒体查询与文件下载路由
│   ├── modules.ts           # 模块管理 REST API
│   ├── resources.ts         # 资源路由（头像等）
│   ├── session-groups.ts    # 会话分组 REST API
│   ├── session-preferences.ts  # 会话偏好设置 REST API
│   ├── sessions-unified.ts  # 统一会话列表（结合 Gateway 实时状态）
│   ├── settings.ts          # 系统设置 REST API
│   ├── tasks.ts             # 子任务管理 REST API
│   └── workspace.ts         # 工作区 REST API
├── gateway/
│   ├── gateway-proxy.ts     # Gateway WebSocket 代理客户端
│   ├── index.ts             # GatewayProxy 导出
│   └── ws-server.ts         # WebSocket 服务器（/ws 端点）
├── modules/
│   └── module-scheduler.ts  # 模块调度器
├── server/
│   ├── chat/
│   │   ├── controller.ts    # Chat SSE 控制器
│   │   ├── sse-manager.ts   # SSE 连接管理
│   │   ├── session-cache.ts # Chat Session 缓存
│   │   └── attachment-storage.ts  # 附件存储管理
│   └── gateway/
│       ├── connection.ts    # Gateway 连接管理
│       └── rpc.ts           # Gateway RPC 适配器
├── services/
│   └── workspace-service.ts # 工作区服务
├── data/
│   ├── agent-overview.ts    # Agent 概览聚合统计服务
│   ├── collector-client.ts  # Collector HTTP 客户端
│   ├── data-sync.ts         # 数据同步调度器
│   └── processor.ts         # 数据处理（溯源字段）
├── storage/
│   ├── index.ts             # 存储层导出
│   ├── db-manager.ts        # 数据库管理器
│   ├── module-repository.ts # 模块存储仓库
│   └── data-repository.ts   # 数据存储仓库
├── types/
│   └── module.ts            # 模块类型定义
└── utils/
    ├── auth-middleware.ts   # Bearer Token 认证中间件
    ├── detect-channel.ts    # Channel 检测工具
    ├── detect-cron.ts       # Cron 检测工具
    ├── detect-system-noise.ts  # 系统噪声检测
    ├── index.ts             # 工具函数导出
    ├── logger.ts            # 日志工具
    └── message-meta.ts      # 消息元数据工具
```

> `app.ts` 已废弃（仅保留注释），入口文件为 `index.ts`。

---

## 数据溯源

admin 从 collector 同步的数据包含以下溯源字段：

| 字段 | 说明 |
|------|------|
| source_module | 来源模块标识（如 `collector-openclaw` 或 `collector-opencode`） |
| source_id | 原始数据 ID |
| source_created_at | 原始创建时间 |

---

## 增量同步

数据同步采用**时间 + 去重**策略：

1. **基于时间**：使用 `last_sync_time` 记录同步时间
2. **组合去重**：使用 `(session_key, source_id)` 确保不重复
3. **同一事务**：同步时间与数据写入在同一事务，失败回滚

---

## 脚本命令

| 命令 | 说明 |
|------|------|
| npm run dev | 开发模式（热重载） |
| npm run build | 构建 TypeScript |
| npm run start | 生产启动 |
| npm run typecheck | 类型检查 |

---

## License

MIT © SakuraSmiles
