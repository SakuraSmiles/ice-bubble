<div align="center">

<h1>ice-bubble-admin</h1>

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


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
└──────────────────────────┼──────────────────────────────────┘
                           │
                           │ HTTP API
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                    Collector                                 │
│                   (端口 13100)                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              /api/meta/status                       │    │
│  │              /api/meta/config                       │    │
│  │              /api/data/sessions                     │    │
│  │              /api/data/messages                     │    │
│  │              /api/data/stats                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
│                    SQLite (collector.db)                     │
└─────────────────────────────────────────────────────────────┘
```

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
  "cors": {
    "enabled": true,
    "origins": ["http://localhost:3000"]
  },
  "database": {
    "path": "../data/admin.db"
  },
  "modules": [
    {
      "moduleKey": "collector-openclaw",
      "name": "OpenClaw采集器",
      "baseUrl": "http://localhost:13100",
      "enabled": true,
      "pollInterval": 30000
    }
  ],
  "dataSync": {
    "collectorBaseUrl": "http://localhost:13100",
    "pollInterval": 60000,
    "batchSize": 500
  }
}
```

---

## API 文档

### 模块管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取所有模块列表 |
| GET | /api/modules/:key | 获取单个模块详情 |
| GET | /api/modules/:key/status | 获取模块状态 |
| GET | /api/modules/:key/config | 获取模块配置 |

### 数据 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/data/stats | 获取统计汇总 |
| GET | /api/data/sessions | 获取会话列表 |
| GET | /api/data/sessions/:key | 获取会话详情 |
| GET | /api/data/messages | 获取消息列表 |
| GET | /api/data/agents | 获取 Agent 列表 |

### API 响应示例

**GET /api/data/stats**
```json
{
  "sessionCount": 248,
  "messageCount": 96076,
  "agentCount": 17,
  "lastSyncTime": "2026-04-09 15:35:43"
}
```

**GET /api/data/sessions**
```json
{
  "count": 2,
  "total": 248,
  "limit": 50,
  "offset": 0,
  "sessions": [
    {
      "session_key": "agent:main:local:default:direct:c520c69e-9977-485b-92c3-010e01b30afb",
      "source_module": "collector-openclaw",
      "agent_id": "main",
      "channel": "local",
      "message_count": 2513,
      "first_message_at": null,
      "last_message_at": "2026-04-09T13:50:07.368Z",
      "source_created_at": "2026-04-09T04:33:01.450Z"
    }
  ]
}
```

---

## 项目结构

```
src/
├── index.ts                 # 入口文件
├── app.ts                   # 应用主文件
├── api/
│   ├── modules.ts           # 模块管理 REST API
│   └── data.ts             # 数据管理 REST API
├── modules/
│   └── module-scheduler.ts  # 模块调度器
├── data/
│   ├── collector-client.ts  # Collector HTTP 客户端
│   ├── data-sync.ts         # 数据同步调度器
│   └── processor.ts         # 数据处理（溯源字段）
├── storage/
│   ├── db-manager.ts        # 数据库管理器
│   ├── module-repository.ts # 模块存储仓库
│   └── data-repository.ts   # 数据存储仓库
├── types/
│   └── module.ts            # 模块类型定义
└── utils/
    └── logger.ts            # 日志工具
```

---

## 数据溯源

admin 从 collector 同步的数据包含以下溯源字段：

| 字段 | 说明 |
|------|------|
| source_module | 来源模块标识（如 collector-openclaw） |
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
