<div style="text-align:center;">

# @ice-bubble/collector-openclaw


[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-298%2F298-brightgreen)](https://github.com/SakuraSmiles/ice-bubble)
[![Coverage](https://img.shields.io/badge/coverage-85%25+-green)](https://github.com/SakuraSmiles/ice-bubble)


> OpenClaw 数据采集模块 - 实时采集 Session 数据、Agent 状态、工具调用信息

</div>

---

## 项目简介

`@ice-bubble/collector-openclaw` 是 ice-bubble 微服务系统的核心采集模块，负责从 OpenClaw 实时采集数据并统一存储。采用 **Facade（外观模式）+ 管道架构**，将复杂的采集流程封装为简洁的对外接口。

### 核心功能

| 功能 | 说明 | 状态 |
|------|------|------|
| **文件采集** | 监听 `.jsonl` 文件变化，实时采集 Session 数据 | ✅ 已实现 |
| **数据转换** | OpenClaw 原始格式 → 统一格式 (UnifiedMessage) | ✅ 已实现 |
| **数据验证** | 格式校验 + 时间戳合法性检查 | ✅ 已实现 |
| **去重处理** | LRU 缓存去重 (>200,000 msg/s) | ✅ 已实现 |
| **批量写入** | SQLite 事务批量写入 (>10,000 msg/s) | ✅ 已实现 |
| **WebSocket 订阅** | 实时订阅 OpenClaw Gateway 事件 | 🚧 骨架 |
| **HTTP API 同步** | 全量同步和补偿机制 | 🚧 骨架 |

### 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ | 轻量化，内存 < 50MB |
| 语言 | TypeScript 5.3+ | 严格模式 |
| 主数据库 | better-sqlite3 (SQLite) | 持久化存储 |
| 辅助缓存 | ioredis (Redis) | 可选，状态缓存/去重 |
| 文件监听 | chokidar | 跨平台文件监听 |
| WebSocket | ws | Gateway 订阅（待实现） |
| HTTP 客户端 | axios | API 同步（待实现） |
| 日志 | winston | 结构化日志 |
| 测试 | vitest | 单元测试 + 集成测试 |

---

## 📥📤 输入 / 输出规格

> **面向读者**: 集群中其他模块的开发者、系统集成人员、排查问题时的数据参考
>
> 本章节定义本模块的**数据契约（Data Contract）**：它消费什么、产出什么、数据长什么样。

### 一句话概括

```
OpenClaw 原始 JSONL 文件 → 解析 → 清洗转换 → 写入 SQLite 数据库
```

---

### 📥 输入（数据来源）

| 来源 | 格式 | 位置 | 当前状态 |
|------|------|------|----------|
| **OpenClaw Session JSONL 文件** | JSON Lines (`.jsonl`) | `~/.openclaw/agents/{agentId}/sessions/*.jsonl` | ✅ 主力 |
| **WebSocket 事件流** | JSON (Gateway 推送) | `wss://gateway:18789` | 🚧 骨架 |
| **HTTP API** | JSON (REST) | `/v1/sessions` 等 | 🚧 骨架 |

#### 输入数据格式 — OpenClaw 原始事件

每行一个 JSON 对象，代表一个事件。核心事件类型：

```typescript
// === 基础结构 ===
interface BaseEvent {
  type: string;           // 'session' | 'message' | 'model_change' | 'thinking_level_change' | 'custom'
  id: string;             // 事件唯一 ID
  parentId: string | null;// 父事件 ID
  timestamp: string;      // ISO 8601 时间戳
}

// === 消息事件（最核心）===
interface MessageEvent extends BaseEvent {
  type: 'message';
  message: Message;
}

interface Message {
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContentItem[];   // 内容数组（文本/思考/工具调用）
  timestamp: number;               // Unix 时间戳 (毫秒)
  api?: string;                    // 'anthropic-messages' | 'ollama'
  model?: string;                  // 模型名，如 'claude-3-5-sonnet'
  usage?: TokenUsage;              // Token 消耗统计
  stopReason?: string;             // 'toolUse' | 'stop' | 'end_turn'
}

// === 内容项（联合类型）===
type MessageContentItem =
  | { type: 'text'; text: string }                                    // 纯文本
  | { type: 'thinking'; thinking: string; thinkingSignature: string } // AI 思考过程
  | { type: 'toolCall'; id: string; name: string; arguments: object };// 工具调用
```

#### Session 标识规则

每个 Session 用 **Session Key** 唯一标识：

```
格式: agent:{agentId}:{channel}:{accountId}:{type}:{peerId}
示例: agent:my-agent:discord:acc-001:direct:user-123
```

| 字段 | 说明 | 示例 |
|------|------|------|
| `agentId` | Agent 实例 ID | `my-agent`, `dev-assistant` |
| `channel` | 通信渠道 | `discord`, `slack`, `telegram` |
| `accountId` | 账号 ID | `acc-001` |
| `type` | 会话类型 | `direct`(私聊), `guild`(频道) |
| `peerId` | 对端用户/频道 ID | `user-123`, `channel-456` |

---

### 📤 输出（数据产物）

本模块的最终产出是 **SQLite 数据库**，包含以下 5 张表：

#### 数据库表结构总览

```
┌─────────────────┐     ┌────────────────────┐
│    sessions     │────<│   session_messages  │
│  (会话元信息)    │ 1:N │   (消息明细)        │
└────────┬────────┘     └────────────────────┘
         │
┌────────▼────────┐     ┌──────────────────┐
│     agents      │     │       tools       │
│  (Agent 信息)    │     │  (工具调用统计)    │
└─────────────────┘     └──────────────────┘

┌─────────────────────┐
│   collection_logs   │
│  (采集运行日志)      │
└─────────────────────┘
```

#### 表 1: sessions（会话）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_key` | TEXT | ✅ PK | Session Key，主键 |
| `agent_id` | TEXT | ✅ | Agent ID |
| `channel` | TEXT | ✅ | 渠道 |
| `account_id` | TEXT | | 账号 ID |
| `peer_id` | TEXT | | 对端 ID |
| `guild_id` | TEXT | | 频道/服务器 ID |
| `created_at` | TIMESTAMP | ✅ | 会话创建时间 |
| `updated_at` | TIMESTAMP | ✅ | 最后更新时间 |
| `message_count` | INTEGER | ✅ | 消息计数（默认 0） |
| `last_message_at` | TIMESTAMP | | 最后消息时间 |

#### 表 2: session_messages（消息）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | INTEGER | ✅ PK | 自增主键 |
| `session_key` | TEXT | ✅ FK | 关联 sessions 表 |
| `message_type` | TEXT | ✅ | `'user' \| 'agent' \| 'tool'` |
| `content` | TEXT | | 消息内容（文本） |
| `model` | TEXT | | AI 模型名称（仅 agent） |
| `tokens_input` | INTEGER | | 输入 Token 数（仅 agent） |
| `tokens_output` | INTEGER | | 输出 Token 数（仅 agent） |
| `tools_json` | TEXT | | 工具调用 JSON（仅 tool） |
| `timestamp` | TIMESTAMP | ✅ | 原始消息时间戳 |
| `created_at` | TIMESTAMP | ✅ | 入库时间 |

> **查询示例**：
> ```sql
> -- 查询某会话的所有对话
> SELECT * FROM session_messages WHERE session_key = 'agent:my-agent:discord:acc-001:direct:user-123'
> ORDER BY timestamp ASC;
>
> -- 统计某 Agent 的 Token 消耗
> SELECT SUM(tokens_input), SUM(tokens_output) FROM session_messages WHERE message_type = 'agent';
>
> -- 查找包含工具调用的消息
> SELECT * FROM session_messages WHERE tools_json IS NOT NULL;
> ```

#### 表 3: agents（Agent 信息）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent_id` | TEXT | ✅ PK | Agent ID |
| `agent_name` | TEXT | | 显示名称 |
| `config_json` | TEXT | | 配置快照（JSON 字符串） |
| `status` | TEXT | ✅ | `'online' \| 'offline' \| 'busy'` |
| `last_seen_at` | TIMESTAMP | | 最后活跃时间 |

#### 表 4: tools（工具统计）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tool_name` | TEXT | ✅ PK | 工具名称 |
| `description` | TEXT | | 描述 |
| `call_count` | INTEGER | ✅ | 调用次数（默认 0） |
| `avg_duration_ms` | INTEGER | | 平均耗时(ms) |
| `last_called_at` | TIMESTAMP | | 最后调用时间 |

#### 表 5: collection_logs（采集日志）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | INTEGER | ✅ PK | 自增主键 |
| `collector_type` | TEXT | ✅ | `'websocket' \| 'file' \| 'http'` |
| `event_type` | TEXT | | 事件类型 |
| `session_key` | TEXT | | 相关 Session Key |
| `status` | TEXT | ✅ | `'success' \| 'failed' \| 'pending'` |
| `error_message` | TEXT | | 错误信息 |
| `duration_ms` | INTEGER | | 处理耗时(ms) |
| `created_at` | TIMESTAMP | ✅ | 日志时间 |

---

### 🔄 内部中间格式（UnifiedMessage）

输入和输出之间的**处理层统一格式**，所有采集器在写入数据库前都必须转换为该格式：

```typescript
interface UnifiedMessage {
  // ===== 必填字段 =====
  id: string;                          // 去重用唯一ID，格式: {sessionKey}:{ts}:{type}:{hash}
  sessionKey: string;                  // Session Key
  messageType: 'user' | 'agent' | 'tool';
  timestamp: Date;                     // 消息原始时间戳
  source: 'websocket' | 'file' | 'http'; // 数据来源标记

  // ===== 可选字段 =====
  content?: string;                    // 文本内容
  model?: string;                      // AI模型名（如 claude-3-5-sonnet）
  tokens?: { input: number; output: number }; // Token统计
  tools?: ToolCall[];                  // 工具调用列表
  raw?: unknown;                       // 原始JSON（调试用）
  metadata?: Record<string, unknown>;  // 扩展元数据
}
```

### 数据流向图

```
┌──────────────────────┐
│  OpenClaw .jsonl 文件  │  ← 输入：原始 JSON Lines
└──────────┬───────────┘
           │ FileWatcher 监听文件变化
           ▼
┌──────────────────────┐
│  file-reader 增量解析   │  ← 逐行解析，跳过已读行
└──────────┬───────────┘
           │ 输出: OpenClawEvent[]
           ▼
┌──────────────────────┐
│  CollectionPipeline   │  ← 核心：ensureSession → 转换 → 验证 → 去重
└──────────┬───────────┘
           │ 输出: UnifiedMessage[] (中间格式)
           ▼
┌──────────────────────┐
│  BatchWriter          │  ← 事务批量写入 SQLite
└──────────┬───────────┘
           │ 输出: sessions + session_messages + agents + tools + logs
           ▼
┌──────────────────────┐
│  SQLite 数据库文件      │  ← 最终产物：供其他模块查询消费
└──────────────────────┘
```

### 本模块对外提供的价值

| 能力 | 说明 | 适用场景 |
|------|------|----------|
| **标准化存储** | 异构数据源 → 统一 Schema | Dashboard 展示、数据分析 |
| **实时同步** | 文件变化 < 1s 内入库 | 监控看板、告警系统 |
| **完整对话历史** | 保留 user/agent/tool 全链路 | 问题回溯、质量审计 |
| **Token 统计** | 每条 AI 回复的成本数据 | 成本分析、用量报表 |
| **工具调用追踪** | 谁、何时、用了什么工具、结果如何 | 行为分析、安全审计 |

---

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- Windows 用户需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 better-sqlite3）

### 安装与构建

```bash
# 克隆项目
git clone <repo-url>
cd ice-bubble-collector-openclaw

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

### 开发模式

```bash
# 启动开发模式（热重载）
npm run dev

# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 代码格式化
npm run format
```

### 运行测试

```bash
# 全量测试（298 个用例）
npm run test:all

# 仅单元测试
npm run test:unit

# 测试并生成覆盖率报告
npm run test:coverage

# 监听模式（文件变更自动重跑）
npx vitest
```

> **当前通过率**: **298 / 298 (100%)**

---

## WSL 部署

如果你的 OpenClaw 运行在 WSL 中，推荐在 WSL 中部署本模块以获得最佳性能。

### 一键启动

```bash
cd /mnt/d/workspace/ice-bubble/ice-bubble-collector-openclaw

./start-wsl.sh dev      # 开发模式（热重载）
./start-wsl.sh start    # 生产模式
./start-wsl.sh test     # 运行全量测试
```

详细文档：[WSL 部署指南](./docs/WSL部署指南.md)

---

## 项目结构

```
ice-bubble-collector-openclaw/
├── config/                          # 配置文件
│   ├── config.json                  # 当前使用配置
│   ├── config.development.json      # 开发环境配置
│   ├── config.production.json       # 生产环境配置
│   └── config.example.json          # 配置模板
│
├── src/                             # 源代码 (TypeScript)
│   ├── index.ts                     # 库入口（导出类型和版本）
│   ├── start.ts                     # 应用启动入口
│   │
│   ├── collectors/                  # 采集层
│   │   ├── base.ts                  #   采集器基类接口
│   │   ├── FileCollector.ts         #   ★ 文件采集器（Facade 模式）
│   │   ├── FileWatcher.ts           #   ★ chokidar 文件监听器
│   │   ├── CollectionPipeline.ts    #   ★ 数据处理管道
│   │   ├── websocket.ts             #   WebSocket 采集器（骨架）
│   │   └── http.ts                  #   HTTP 采集器（骨架）
│   │
│   ├── converters/                  # 转换层
│   │   └── openclaw-to-unified.ts   #   OpenClaw → UnifiedMessage
│   │
│   ├── processors/                  # 处理层
│   │   ├── DataValidator.ts         #   数据验证
│   │   ├── deduplicator.ts          #   LRU 去重
│   │   └── BatchWriter.ts           #   批量写入
│   │
│   ├── storage/                     # 存储层
│   │   ├── sqlite-manager.ts        #   SQLite 管理（主存储）
│   │   └── redis-manager.ts         #   Redis 管理（辅助）
│   │
│   ├── strategies/                  # 策略层
│   │   ├── base.ts                  #   策略基类
│   │   └── manager.ts               #   策略管理器
│   │
│   ├── types/                       # 类型定义
│   │   ├── index.ts                 #   统一类型（SessionMessage 等）
│   │   └── openclaw.ts              #   OpenClaw 原始类型
│   │
│   └── utils/                       # 工具函数
│       ├── config-loader.ts         #   配置加载器
│       ├── file-reader.ts           #   JSONL 文件读取（支持增量/BOM）
│       ├── session-key-builder.ts   #   Session Key 构建器
│       └── logger.ts               #   Winston 日志封装
│
├── tests/                           # 测试代码
│   ├── unit/                        #   单元测试 (~270 用例)
│   │   ├── collectors/              #     FileCollector / FileWatcher / CollectionPipeline / reliability
│   │   ├── converters/              #     openclaw-to-unified
│   │   ├── processors/              #     DataValidator / Deduplicator / BatchWriter
│   │   └── utils/                   #     file-reader / session-key-builder
│   ├── integration/                 #   集成测试 (~16 用例)
│   │   └── file-collector-integration.test.ts
│   ├── benchmark/                   #   性能基准测试
│   ├── helpers/                     #   测试辅助（sqlite-test-helper）
│   ├── fixtures/                    #   测试数据
│   ├── manual/                      #   手动测试脚本
│   └── scripts/                     #   独立测试脚本
│
├── scripts/                         # 工具脚本
│   ├── init-db.ts                   #   数据库初始化
│   ├── backup.ts                    #   数据备份
│   └── health-check.ts              #   健康检查
│
├── docs/                            # 文档
│   ├── 配置说明.md                  # 向导：配置详解
│   ├── 测试指南.md                  # 向导：测试策略
│   ├── FileCollector使用指南.md      # 向导：FileCollector 使用
│   ├── WSL部署指南.md               # 向导：WSL 部署
│   ├── dev/                         # 开发文档
│   │   ├── 架构设计.md              #   系统架构（最详细）
│   │   ├── 存储层设计.md            #   SQLite/Redis 设计
│   │   └── 数据转换映射.md          #   字段映射规则
│   └── test/                        # 测试文档
│       └── 最终测试报告.md           #   综合报告 + ADR 决策记录
│
├── dist/                            # 编译输出（自动生成，gitignore）
├── .editorconfig                    # 编辑器配置
├── .eslintrc.cjs                    # ESLint 配置
├── .prettierrc                      # Prettier 配置
├── .gitignore                       # Git 忽略规则
├── package.json                     # NPM 项目配置
├── tsconfig.json                    # TypeScript 编译配置
├── vitest.config.ts                 # Vitest 测试框架配置
├── start-wsl.sh                     # WSL 启动辅助脚本
└── README.md                        # 本文件
```

---

## 核心架构

### 五层架构（实际代码结构）

```
┌─────────────────────────────────────────────────────────────┐
│                    API / 启动层                              │
│               start.ts / index.ts                            │
└─────────────────────────────┬───────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    采集层 (Collectors)                        │
│  ┌──────────────────────┐  ┌────────────┐  ┌────────────┐  │
│  │   FileCollector      │  │ WebSocket  │  │ HTTP API   │  │
│  │   (Facade 协调者)    │  │ Collector  │  │ Collector  │  │
│  │  ┌────────────────┐  │  │  (骨架)    │  │  (骨架)    │  │
│  │  │ FileWatcher    │  │  └────────────┘  └────────────┘  │
│  │  │ CollectionPipe │  │                                  │
│  │  │     line        │  │                                  │
│  │  └────────────────┘  │                                  │
│  └──────────────────────┘                                  │
└─────────────────────────────┬───────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    处理层 (Processors)                        │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐    │
│  │DataValidator │→│Deduplicator │→│  BatchWriter      │    │
│  │  验证+过滤    │  │ LRU去重    │  │  批量事务写入     │    │
│  └──────────────┘  └────────────┘  └──────────────────┘    │
└─────────────────────────────┬───────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    存储层 (Storage)                           │
│  ┌──────────────────────┐  ┌────────────────────────┐      │
│  │   SQLiteManager      │  │   RedisManager         │      │
│  │   (持久化 - 主存储)   │  │   (可选 - 缓存/去重)    │      │
│  │   sessions/messages  │  │   状态/队列/PubSub      │      │
│  └──────────────────────┘  └────────────────────────┘      │
└─────────────────────────────┬───────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    基础设施层                                 │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │config-loader│ │file-reader│ │logger   │ │session-key │  │
│  └────────────┘ └──────────┘ └──────────┘ └────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

```
OpenClaw .jsonl 文件
       ↓ (FileWatcher 监听)
原始 JSON Lines
       ↓ (file-reader 增量解析)
OpenClawEvent[]
       ↓ (CollectionPipeline.processEvents)
  ├─ ensureSession()        ← 自动创建 Session 记录
  ├─ convertOpenClawEvent() ← OpenClaw → UnifiedMessage
  ├─ DataValidator.validate ← 格式/时间戳验证
  ├─ Deduplicator.isDuplicate ← LRU 去重
  └─ BatchWriter.addMessage  ← 事务批量写入
       ↓
SQLite 数据库 (sessions / messages 表)
```

### 关键组件职责

#### FileCollector（外观模式/Facade）

作为整个文件采集的协调者，内部编排以下子组件：

| 子组件 | 职责 | 文件 |
|--------|------|------|
| **FileWatcher** | chokidar 文件监听生命周期管理 | `collectors/FileWatcher.ts` |
| **CollectionPipeline** | 数据处理管道（转换→验证→去重→写入） | `collectors/CollectionPipeline.ts` |
| **DataValidator** | 数据格式验证、时间戳合法性 | `processors/DataValidator.ts` |
| **Deduplicator** | LRU 缓存去重 | `processors/deduplicator.ts` |
| **BatchWriter** | SQLite 事务批量写入 | `processors/BatchWriter.ts` |

#### CollectionPipeline（数据处理管道）

核心管道，确保数据按顺序经过每个处理阶段：

1. **ensureSession(sessionKey)** — 确保 Session 记录存在（避免 FOREIGN KEY 错误）
2. **convertOpenClawEvent(event)** — 原始事件转换为统一格式
3. **DataValidator.validate(msg)** — 验证消息格式和字段合法性
4. **Deduplicator.isDuplicate(msg)** — LRU 缓存去重
5. **BatchWriter.addMessage(msg)** — 加入批量缓冲区，定期刷新到数据库

---

## 配置说明

### 配置文件层次

```
config/
├── config.example.json      # 完整配置模板（所有选项）
├── config.development.json  # 开发环境配置（FILE_ONLY 模式）
├── config.production.json   # 生产环境配置（HYBRID_PRIORITY 模式）
└── config.json              # 当前生效配置
```

### 关键配置项

```jsonc
{
  "collection": {
    "mode": "FILE_ONLY",           // FILE_ONLY | WEBSOCKET_ONLY | HTTP_ONLY | HYBRID_PRIORITY
    "file": {
      "watchPath": "~/.openclaw/agents",
      "enableWatch": true,
      "batchSize": 50,
      "batchTimeout": 3000
    }
  },
  "processing": {
    "validator": { "strictMode": false },
    "deduplicator": { "cacheSize": 5000 },
    "batchWriter": { "batchSize": 20, "batchTimeout": 2000 }
  },
  "storage": {
    "sqlite": { "dbPath": "../data/collector-dev.db" }
  }
}
```

详细配置请参考 [配置说明](./docs/配置说明.md)。

---

## 测试体系

### 测试矩阵

| 层级 | 数量 | 文件 | 状态 |
|------|------|------|------|
| DataValidator | ~47 | `processors/DataValidator.test.ts` | ✅ |
| Deduplicator | ~23 | `processors/Deduplicator.test.ts` | ✅ |
| openclaw-to-unified | ~23 | `converters/openclaw-to-unified.test.ts` | ✅ |
| session-key-builder | ~28 | `utils/session-key-builder.test.ts` | ✅ |
| FileWatcher | ~20 | `collectors/FileWatcher.test.ts` | ✅ |
| FileCollector 主测试 | ~24 | `collectors/FileCollector.test.ts` | ✅ |
| FileCollector-reliability | ~14 | `collectors/FileCollector-reliability.test.ts` | ✅ |
| CollectionPipeline | ~27 | `collectors/CollectionPipeline.test.ts` | ✅ |
| BatchWriter | ~12+2 | `processors/BatchWriter.test.ts` + `.simple.test.ts` | ✅ |
| file-reader | ~21+14 | `utils/file-reader.test.ts` + `-bom.test.ts` | ✅ |
| file-collector-integration | ~16 | `integration/file-collector-integration.test.ts` | ✅ |
| **合计** | **~298** | | **100% 通过** |

### Windows 兼容性注意事项

- 文件名不能含冒号 `:`，测试中使用下划线替代
- 所有时间戳必须使用过去的时间（基准时间 = `Date.now()` - 偏移量）
- chokidar 在 Windows 上延迟较高，集成测试等待时间 ≥ 3s

详细测试指南请参考 [测试指南](./docs/测试指南.md)。

---

## 开发指南

### 代码规范

- **TypeScript strict mode**: 所有文件必须通过严格类型检查
- **ESLint**: `npm run lint` 检查代码质量
- **Prettier**: `npm run format` 格式化代码（4空格缩进、单引号、分号）
- **EditorConfig**: 统一编辑器配置

### Git 提交规范

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `docs` | 文档更新 |
| `style` | 代码格式调整 |
| `refactor` | 代码重构（不改变行为） |
| `test` | 测试相关 |
| `chore` | 构建/工具链相关 |

### 关键设计决策 (ADR)

1. **Facade 模式**: FileCollector 作为协调者，内部组件可独立替换
2. **CollectionPipeline.ensureSession()**: 写入消息前自动创建 Session 记录
3. **Windows 路径安全**: 冒号替换为下划线，避免 ENOENT 错误
4. **时间戳规范化**: 测试中全部使用过去时间戳

---

## 依赖说明

### 生产依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| better-sqlite3 | ^9.4.0 | SQLite 数据库引擎 |
| chokidar | ^3.5.0 | 文件监听 |
| ioredis | ^5.3.0 | Redis 客户端 |
| winston | ^3.11.0 | 日志管理 |
| axios | ^1.6.0 | HTTP 客户端（待使用） |
| ws | ^8.16.0 | WebSocket（待使用） |
| dotenv | ^16.4.0 | 环境变量加载 |
| node-cron | ^3.0.0 | 定时任务（待使用） |

### 开发依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| typescript | ^5.3.0 | TypeScript 编译器 |
| tsx | ^4.7.0 | TypeScript 直接执行（开发用） |
| vitest | ^1.2.0 | 测试框架 |
| eslint | ^8.56.0 | 代码质量检查 |
| prettier | ^3.2.0 | 代码格式化 |

---

## 文档索引

> 本模块文档遵循 **「现状/设计导向」** 原则：只保留描述系统当前状态、设计理念和实现方式的文档，不保留过程性记录。

### 向导文档（面向用户）

| 文档 | 说明 |
|------|------|
| [配置说明](./docs/配置说明.md) | 配置文件完整说明，含所有选项和默认值 |
| [测试指南](./docs/测试指南.md) | 测试策略、用例模板与最佳实践 |
| [FileCollector 使用指南](./docs/FileCollector使用指南.md) | FileCollector API 级详细用法 |
| [WSL 部署指南](./docs/WSL部署指南.md) | WSL 环境专属部署步骤与脚本说明 |

### 开发文档（面向开发者）

| 文档 | 说明 |
|------|------|
| [架构设计](./docs/dev/架构设计.md) | 系统整体架构、数据源分析、策略模式伪代码、性能基准 |
| [存储层设计](./docs/dev/存储层设计.md) | SQLite/Redis 完整表结构、索引策略、实现细节 |
| [数据转换映射](./docs/dev/数据转换映射.md) | OpenClaw 原始格式 → UnifiedMessage 字段级映射规则 |

### 测试文档

| 文档 | 说明 |
|------|------|
| [最终测试报告](./docs/test/最终测试报告.md) | 综合测试报告 + ADR 决策记录 |

---

## 许可证

[MIT License](LICENSE)

---

**最后更新**: 2026-04-09
**测试状态**: 298/298 全通过 (100%)
