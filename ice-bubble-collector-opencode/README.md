<div align="center">

<h1>OpenCode 数据采集模块</h1>

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


> @ice-bubble/collector-opencode  
> OpenCode 数据采集模块 - 从 OpenCode SQLite 数据库采集 Session 和 Message 数据

</div>

---

## 项目简介

`@ice-bubble/collector-opencode` 是 ice-bubble 微服务系统的数据采集模块之一，负责从 [OpenCode](https://github.com/opencode-ai/opencode) 的本地 SQLite 数据库中采集 Session 和 Message 数据，转换为统一格式后通过 HTTP API 对外提供。

### 设计原则

- **只读采集**：仅读取 OpenCode 数据库，不修改任何原始数据
- **轮询同步**：定期轮询数据库变更，增量更新本地缓存
- **格式对齐**：API 响应格式与 collector-openclaw 完全对齐，Admin 的 CollectorClient 无需区分平台

### 核心功能

| 功能 | 说明 | 状态 |
|------|------|------|
| **SQLite 采集** | 读取 OpenCode 的 `opencode.db` 数据库 | ✅ 已实现 |
| **Session 采集** | 采集 Session 列表，包含 title、model、agent 等信息 | ✅ 已实现 |
| **Message 采集** | 采集消息及 Parts（文本、工具调用、推理过程等） | ✅ 已实现 |
| **数据转换** | OpenCode 原始格式 → 统一格式 (UnifiedMessage) | ✅ 已实现 |
| **HTTP API** | 提供标准化的数据查询接口 | ✅ 已实现 |
| **增量同步** | 基于 `time_updated` 的时间戳增量拉取 | ✅ 已实现 |

### 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ | 轻量化 |
| 语言 | TypeScript 5.3+ | 严格模式 |
| HTTP 框架 | Express 5 | REST API |
| 数据库 | better-sqlite3 (SQLite) | 只读访问 OpenCode DB |
| 日志 | winston | 结构化日志 |

---

## 数据来源

本模块从 OpenCode 的本地 SQLite 数据库读取数据，默认路径：

```
~/.local/share/opencode/opencode.db
```

### 数据库表结构

OpenCode 的数据库包含以下核心表：

| 表 | 说明 |
|------|------|
| `project` | 项目信息（工作目录、VCS 等） |
| `session` | 会话信息（标题、模型、Agent 等） |
| `message` | 消息记录（用户/助手消息） |
| `part` | 消息内容片段（文本、工具调用、推理等） |

### 数据流

```
┌──────────────────────────────┐
│  OpenCode SQLite 数据库       │  ← 数据源：只读访问
│  (opencode.db)               │
└──────────┬───────────────────┘
           │ SQLiteCollector 定期轮询
           ▼
┌──────────────────────────────┐
│  opencode-to-unified 转换     │  ← OpenCode 原始格式 → UnifiedMessage
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  HTTP API (Express 5)        │  ← 对外提供标准化接口
│  端口: 13101                 │
└──────────────────────────────┘
```

---

## API 端点

所有 API 端点的响应格式与 collector-openclaw **完全对齐**，Admin 的 CollectorClient 无需区分平台。

### 数据接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/data/sessions | 会话列表（支持分页） |
| GET | /api/data/messages | 消息列表（支持 session_key / since / 分页过滤） |
| GET | /api/data/stats | 数据统计（会话数、消息数、Agent 数） |
| GET | /api/data/agents | Agent 列表 |
| GET | /api/data/events | 空实现（OpenCode 无 events 概念） |

### 元数据接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/meta/status | 模块运行状态（版本、启动时间、健康状态） |
| GET | /api/meta/config | 模块当前配置 |

### API 响应示例

**GET /api/data/sessions**
```json
{
  "count": 42,
  "max_time_updated": 1716854400000,
  "sessions": [
    {
      "session_key": "ses_abc123...",
      "agent_id": "opencode:main",
      "channel": "opencode",
      "created_at": "2026-05-20T10:00:00.000Z",
      "updated_at": "2026-05-20T12:30:00.000Z",
      "message_count": 0,
      "label": "修复登录问题",
      "status": "active",
      "model": "claude-3-5-sonnet"
    }
  ]
}
```

**GET /api/data/stats**
```json
{
  "sessionCount": 42,
  "messageCount": 1856,
  "agentCount": 3,
  "lastUpdated": "2026-05-25T08:00:00.000Z"
}
```

**GET /api/meta/status**
```json
{
  "moduleKey": "collector-opencode",
  "moduleType": "collector",
  "version": "0.1.0",
  "status": "running",
  "runtime": {
    "startTime": "2026-05-25T08:00:00.000Z",
    "uptimeSeconds": 3600,
    "messagesCollected": 1856,
    "errorsCount": 0
  },
  "health": {
    "status": "healthy",
    "message": "正常"
  }
}
```

---

## 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- Windows 用户需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 better-sqlite3）

## 安装与启动

```bash
# 克隆项目
git clone <repo-url>
cd ice-bubble/ice-bubble-collector-opencode

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产启动
npm run build && npm run start
```

---

## 配置说明

配置文件位于 `config/config.json`，支持环境变量覆盖：

```json
{
  "opencodeDbPath": "~/.local/share/opencode/opencode.db",
  "httpPort": 13101,
  "httpHost": "0.0.0.0",
  "pollIntervalMs": 30000,
  "batchSize": 500,
  "logLevel": "info"
}
```

### 环境变量

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `OPENCODE_DB_PATH` | OpenCode 数据库路径 | `~/.local/share/opencode/opencode.db` |
| `COLLECTOR_PORT` | HTTP API 端口 | `13101` |
| `POLL_INTERVAL_MS` | 轮询间隔（毫秒） | `30000` |
| `LOG_LEVEL` | 日志级别 | `info` |

> 环境变量优先级高于配置文件。

---

## 默认配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `opencodeDbPath` | `~/.local/share/opencode/opencode.db` | OpenCode SQLite 数据库路径 |
| `httpPort` | `13101` | HTTP API 监听端口 |
| `httpHost` | `0.0.0.0` | HTTP API 监听地址 |
| `pollIntervalMs` | `30000` | 数据库轮询间隔（30 秒） |
| `batchSize` | `500` | 每轮最大采集消息数 |
| `logLevel` | `info` | 日志级别（error/warn/info/debug） |

---

## 项目结构

```
ice-bubble-collector-opencode/
├── config/                          # 配置文件
│   └── config.json                  # 配置文件（可选，有默认值）
│
├── src/                             # 源代码 (TypeScript)
│   ├── index.ts                     # 库入口（导出版本）
│   ├── start.ts                     # 应用启动入口
│   │
│   ├── api/                         # HTTP API 层
│   │   ├── index.ts                 #   路由注册
│   │   ├── server.ts                #   Express 服务启动
│   │   ├── types.ts                 #   API 类型定义
│   │   └── routes/
│   │       ├── data.ts              #   ★ 数据查询接口
│   │       └── meta.ts              #   ★ 模块状态接口
│   │
│   ├── collectors/                  # 采集层
│   │   └── sqlite-collector.ts      #   ★ SQLite 数据库采集器
│   │
│   ├── converters/                  # 转换层
│   │   ├── index.ts                 #   转换器导出
│   │   └── opencode-to-unified.ts   #   ★ OpenCode → UnifiedMessage 转换
│   │
│   ├── types/                       # 类型定义
│   │   ├── index.ts                 #   统一类型（UnifiedMessage 等）
│   │   └── opencode.ts              #   OpenCode 原始类型
│   │
│   ├── utils/                       # 工具函数
│   │   ├── config-loader.ts         #   配置加载器
│   │   ├── db-reader.ts             #   SQLite 数据库只读访问
│   │   └── logger.ts                #   Winston 日志封装
│   │
│   └── strategies/                  # 策略层
│       └── index.ts                 #   策略导出
│
├── package.json                     # NPM 项目配置
├── tsconfig.json                    # TypeScript 编译配置
└── README.md                        # 本文件
```

---

## 与 collector-openclaw 的关系

两个 Collector 共享相同的 **API 响应格式设计**，但数据来源和处理方式不同：

| 对比项 | collector-openclaw | collector-opencode |
|--------|-------------------|-------------------|
| **数据来源** | OpenClaw `.jsonl` 文件 | OpenCode SQLite 数据库 |
| **采集方式** | 文件监听（实时） | 定期轮询（30s） |
| **默认端口** | 13100 | 13101 |
| **Channel 标识** | discord / telegram / local 等 | `opencode` |
| **Session Key 格式** | `agent:{id}:{channel}:...` | `ses_{hex32}` |
| **消息内容** | JSONL 行内联 | Message 表 + Part 表关联 |
| **工具调用** | toolCall 类型 content item | Part 表 tool 类型 |
| **API 格式** | 统一格式 | 与 openclaw 对齐 |

---

## 许可证

[MIT License](LICENSE)

---

**最后更新**: 2026-05-25
