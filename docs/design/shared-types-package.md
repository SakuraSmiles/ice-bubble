# @ice-bubble/types 共享类型包设计方案

> 版本: v1.0 | 日期: 2026-05-28 | 状态: 设计阶段

## 1. 背景与问题

### 当前现状

ice-bubble 项目是一个 npm workspaces monorepo，包含以下模块：

| 模块 | 包名 | 类型定义位置 |
|---|---|---|
| collector-openclaw | `@ice-bubble/collector-openclaw` | `src/types/index.ts` + `src/types/openclaw.ts` |
| collector-opencode | `@ice-bubble/collector-opencode` | `src/types/index.ts` + `src/types/opencode.ts` |
| admin | `@ice-bubble/admin` | `src/types/module.ts` + `src/data/collector-client.ts` + `src/storage/data-repository.ts` |

### 存在问题

1. **UnifiedMessage 重复定义**
   - `collector-openclaw/src/types/index.ts` 定义了完整的 `UnifiedMessage`
   - `collector-opencode/src/types/index.ts` 复制了一份 `UnifiedMessage`，但有微小差异：
     - `source` 字面量不同：openclaw 是 `'websocket' | 'file' | 'http'`，opencode 多了 `'sqlite'`
     - `metadata` 类型不同：openclaw 定义了具体字段，opencode 是 `Record<string, unknown>`

2. **ToolCall 重复定义**
   - 两个 collector 定义了完全相同的 `ToolCall` 接口

3. **HTTP API 契约类型分散**
   - `CollectorSession`、`CollectorMessage`、`CollectorAgent` 等定义在 `admin/src/data/collector-client.ts`
   - 这些是 admin 与 collector 之间的 API 契约，应该两边共享

4. **理解成本高**
   - 对接新 Collector 时，需要理解每个模块各自的类型定义
   - 字段名不一致（snake_case vs camelCase）、可选性不一致

5. **类型演进不一致**
   - 修改 `UnifiedMessage` 需要同时改两个地方
   - 容易出现遗漏

---

## 2. 类型分析

### 2.1 跨模块共享的类型

| 类型 | collector-openclaw | collector-opencode | admin | 共享必要性 |
|---|---|---|---|---|
| **UnifiedMessage** | ✅ 完整定义 | ✅ 复制（有差异） | ❌ (但处理它) | 🔴 **必须** |
| **ToolCall** | ✅ | ✅ 完全一致 | ❌ | 🔴 **必须** |
| **Collector (接口)** | ✅ | ❌ | ❌ | 🟡 推荐 |
| **CollectorSession** | ❌ | ❌ | ✅ collector-client.ts | 🔴 **必须** (API 契约) |
| **CollectorMessage** | ❌ | ❌ | ✅ collector-client.ts | 🔴 **必须** (API 契约) |
| **CollectorAgent** | ❌ | ❌ | ✅ collector-client.ts | 🔴 **必须** (API 契约) |
| **CollectorEvent** | ❌ | ❌ | ✅ collector-client.ts | 🟡 推荐 |
| **CollectorStats** | ❌ | ❌ | ✅ collector-client.ts | 🟡 推荐 |

### 2.2 不应共享的类型

| 类型 | 原因 |
|---|---|
| OpenClaw 原始类型 (MessageEvent, TokenUsage, etc.) | 仅 collector-openclaw 使用，属于数据源适配层 |
| OpenCode 原始类型 (OpenCodeSession, OpenCodePart, etc.) | 仅 collector-opencode 使用，属于数据源适配层 |
| Module 管理类型 (ModuleRegistry, ModuleHealth, etc.) | admin 内部模块管理，不与其他模块交互 |
| AdminSession / AdminMessage / AdminAgent | admin 内部存储类型，不应外泄 |
| WSEvent / WSMessage | collector-openclaw 的 WebSocket 专用类型 |
| CollectionMode | collector-openclaw 内部采集模式 |
| CollectionLog | 采集日志，各 collector 内部类型 |

### 2.3 关键差异分析：UnifiedMessage

```
字段          | collector-openclaw                          | collector-opencode
-------------|---------------------------------------------|----------------------
source       | 'websocket' \| 'file' \| 'http'             | + 'sqlite'
metadata     | { userId?, agentId?, channel?, eventId?, ... } | Record<string, unknown>
```

**统一方案**：
- `source` 使用更宽泛的类型：`'websocket' | 'file' | 'http' | 'sqlite'`
- `metadata` 使用 `Record<string, unknown>`，注释中列出常用字段

---

## 3. 包设计

### 3.1 目录结构

```
packages/types/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 # 统一导出（re-export 所有模块）
    ├── message.ts               # 核心消息类型
    ├── session.ts               # Session 相关类型
    ├── agent.ts                 # Agent 相关类型
    ├── collector.ts             # Collector 接口与配置
    ├── api.ts                   # HTTP API 契约类型（admin ↔ collector）
    └── common.ts                # 通用工具类型
```

### 3.2 package.json

```json
{
  "name": "@ice-bubble/types",
  "version": "1.0.0",
  "description": "ice-bubble 共享类型定义",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./message": {
      "types": "./dist/message.d.ts",
      "import": "./dist/message.js"
    },
    "./session": {
      "types": "./dist/session.d.ts",
      "import": "./dist/session.js"
    },
    "./agent": {
      "types": "./dist/agent.d.ts",
      "import": "./dist/agent.js"
    },
    "./collector": {
      "types": "./dist/collector.d.ts",
      "import": "./dist/collector.js"
    },
    "./api": {
      "types": "./dist/api.d.ts",
      "import": "./dist/api.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "typecheck": "tsc --noEmit",
    "rebuild": "npm run clean && npm run build",
    "prepublishOnly": "npm run build"
  },
  "files": [
    "dist"
  ],
  "type": "module"
}
```

### 3.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "allowSyntheticDefaultImports": true,
    "noEmitOnError": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 4. 类型清单

### 4.1 `common.ts` — 通用工具类型

```typescript
/** 消息角色 */
export type MessageRole = 'user' | 'agent' | 'tool';

/** 数据来源 */
export type DataSource = 'websocket' | 'file' | 'http' | 'sqlite';

/** Agent 运行状态 */
export type AgentStatus = 'online' | 'offline' | 'busy';
```

### 4.2 `message.ts` — 核心消息类型

```typescript
/** 工具调用 */
export interface ToolCall {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
}

/** Token 统计 */
export interface TokenUsage {
    input: number;
    output: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: TokenCost;
}

export interface TokenCost {
    total?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/**
 * 统一消息格式 — 所有 Collector 的标准输出
 *
 * 这是处理层的标准输入，每个 Collector 必须将各自的数据源
 * 转换为此格式。
 *
 * @example
 * const msg: UnifiedMessage = {
 *   id: 'agent:agent-001:discord:direct:peer-456:2026-04-08T10:00:00Z:user:a1b2c3',
 *   sessionKey: 'agent:agent-001:discord:direct:peer-456',
 *   messageType: 'user',
 *   timestamp: new Date('2026-04-08T10:00:00Z'),
 *   source: 'websocket',
 *   content: '帮我分析错误',
 *   metadata: { userId: 'user-789' }
 * };
 */
export interface UnifiedMessage {
    /** 消息唯一标识，格式: {sessionKey}:{timestamp}:{messageType}:{hash} */
    id: string;

    /** Session Key, 格式: agent:{agentId}:{channel}:{accountId}:{type}:{targetId} */
    sessionKey: string;

    /** 消息类型 */
    messageType: MessageRole;

    /** 消息时间戳 */
    timestamp: Date;

    /** 数据来源 */
    source: DataSource;

    /** 消息文本内容 */
    content?: string;

    /** AI 模型标识，仅 agent 类型消息 */
    model?: string;

    /** Token 使用统计 + 费用，仅 agent 类型消息 */
    tokens?: TokenUsage;

    /** 工具调用列表，仅 agent / tool 类型消息 */
    tools?: ToolCall[];

    /** 原始数据（调试用） */
    raw?: unknown;

    /**
     * 扩展元数据
     * 常用字段：userId, agentId, channel, eventId
     */
    metadata?: Record<string, unknown>;
}
```

### 4.3 `session.ts` — Session 类型

```typescript
/**
 * Session 数据传输对象
 *
 * Collector 对外暴露的 Session 视图，是 HTTP API 的响应类型。
 */
export interface SessionDTO {
    sessionKey: string;
    agentId: string;
    channel: string;
    accountId?: string | null;
    peerId?: string | null;
    guildId?: string | null;
    createdAt: string | null;
    updatedAt: string;
    messageCount: number;
    lastMessageAt: string | null;
    label?: string | null;
    status?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    spawnedBy?: string | null;
    spawnDepth?: number | null;
}

/**
 * Session 事件
 */
export interface SessionEvent {
    id?: number;
    sessionKey: string;
    eventType: string;
    eventId?: string | null;
    dataJson: string;
    timestamp: string;
    createdAt?: string;
}
```

### 4.4 `agent.ts` — Agent 类型

```typescript
/**
 * Agent 数据传输对象
 *
 * Collector 对外暴露的 Agent 视图。
 */
export interface AgentDTO {
    agentId: string;
    agentName: string | null;
    workspace?: string | null;
    source?: string | null;
    configJson: string;
    status: string;
    lastSeenAt: string;
    createdAt: string;
    updatedAt: string;
}
```

### 4.5 `collector.ts` — Collector 接口

```typescript
/**
 * Collector 接口
 *
 * 所有 Collector 模块必须实现此接口。
 */
export interface Collector {
    /** 启动采集器 */
    start(): Promise<void>;

    /** 停止采集器 */
    stop(): Promise<void>;
}

/**
 * Collector 运行统计
 */
export interface CollectorStats {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    lastUpdated: string | null;
}
```

### 4.6 `api.ts` — HTTP API 契约类型

```typescript
import type { SessionDTO } from './session.js';
import type { AgentDTO } from './agent.js';
import type { SessionEvent } from './session.js';
import type { CollectorStats } from './collector.js';

// ========== Sessions API ==========

export interface GetSessionsResponse {
    count: number;
    maxTimeUpdated?: number;
    sessions: SessionDTO[];
}

// ========== Messages API ==========

/**
 * Collector 端消息 API 响应格式
 *
 * 注意：这是 HTTP API 的 wire format，字段使用 snake_case
 * （对应 collector 端 SQLite 列名）。不应与 UnifiedMessage 混淆。
 */
export interface MessageItemDTO {
    id: number | null;
    sessionKey: string;
    messageType: string;
    content: string | null;
    model: string | null;
    tokensInput: number | null;
    tokensOutput: number | null;
    costTotal: number | null;
    costInput: number | null;
    costOutput: number | null;
    toolsJson: string | null;
    timestamp: string;
    createdAt: string | null;
}

export interface GetMessagesResponse {
    count: number;
    maxTimeUpdated?: number;
    messages: MessageItemDTO[];
}

// ========== Agents API ==========

export interface GetAgentsResponse {
    count: number;
    agents: AgentDTO[];
}

// ========== Events API ==========

export interface GetEventsResponse {
    count: number;
    events: SessionEvent[];
}

// ========== Stats API ==========

export type GetStatsResponse = CollectorStats;
```

### 4.7 `index.ts` — 统一导出

```typescript
// 核心类型
export type { UnifiedMessage, ToolCall, TokenUsage, TokenCost } from './message.js';
export type { MessageRole, DataSource, AgentStatus } from './common.js';

// Session
export type { SessionDTO, SessionEvent } from './session.js';

// Agent
export type { AgentDTO } from './agent.js';

// Collector
export type { Collector, CollectorStats } from './collector.js';

// API 契约
export type {
    GetSessionsResponse,
    MessageItemDTO,
    GetMessagesResponse,
    GetAgentsResponse,
    GetEventsResponse,
    GetStatsResponse,
} from './api.js';
```

---

## 5. 迁移方案

### 5.1 总体步骤

```
Phase 1: 创建 @ice-bubble/types 包
Phase 2: 迁移 collector-openclaw
Phase 3: 迁移 collector-opencode
Phase 4: 迁移 admin
Phase 5: 清理 & 验证
```

### 5.2 Phase 1: 创建包

1. 创建 `packages/types/` 目录结构
2. 复制上述 `package.json`、`tsconfig.json`、所有 `src/*.ts` 文件
3. 根 `package.json` 添加 `"packages/types"` 到 `workspaces` 数组
4. `npm install`（创建 workspace 软链接）
5. `npm run build -w @ice-bubble/types`（验证可编译）

### 5.3 Phase 2: 迁移 collector-openclaw

#### 变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/types/index.ts` | **修改** | 删除已迁移的类型，改为 re-export 自 `@ice-bubble/types` |
| `src/types/openclaw.ts` | **保留** | OpenClaw 原始类型，不移入共享包 |
| `package.json` | **修改** | 添加 `"@ice-bubble/types": "*"` 到 devDependencies |
| 所有 import 路径 | **修改** | `from '../types/index.js'` → `from '@ice-bubble/types'` |

#### types/index.ts 改造后

```typescript
// OpenClaw 原始类型（保留）
export * from './openclaw.js';

// 从共享包导入核心类型
export type {
  UnifiedMessage,
  ToolCall,
  TokenUsage,
  TokenCost,
  MessageRole,
  DataSource,
  AgentStatus,
  SessionDTO,
  SessionEvent,
  AgentDTO,
  Collector,
  CollectorStats,
  MessageItemDTO,
  GetSessionsResponse,
  GetMessagesResponse,
  GetAgentsResponse,
  GetEventsResponse,
  GetStatsResponse,
} from '@ice-bubble/types';

// collector-openclaw 特有类型（保留）
export enum CollectionMode { ... }
export interface Session { ... }       // SQLite 内部 row 类型
export interface SessionMessage { ... } // SQLite 内部 row 类型
export interface Agent { ... }         // SQLite 内部 row 类型
export interface Tool { ... }
export interface CollectionLog { ... }
export interface WSEvent { ... }
export interface WSMessage { ... }
export interface SQLiteManagerConfig { ... }
```

#### 使用方改造

以下文件使用 `UnifiedMessage` / `ToolCall`，需要确认导入路径：

- `src/collectors/CollectionPipeline.ts` → 从 `@ice-bubble/types` 导入 `UnifiedMessage`
- `src/processors/DataValidator.ts` → 同上
- `src/processors/deduplicator.ts` → 同上
- `src/utils/type-mapper.ts` → 同上
- `src/api/routes/data.ts` → 已导入 `Session, SessionMessage`（内部类型，不变）

### 5.4 Phase 3: 迁移 collector-opencode

#### 变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/types/index.ts` | **修改** | 删除 `UnifiedMessage`、`ToolCall` 定义，改为 re-export |
| `src/types/opencode.ts` | **保留** | OpenCode 原始类型，不移入共享包 |
| `package.json` | **修改** | 添加 `"@ice-bubble/types": "*"` |
| `src/converters/opencode-to-unified.ts` | **修改** | 导入路径切换 |

#### types/index.ts 改造后

```typescript
// OpenCode 原始类型（保留）
export type { OpenCodeProject, OpenCodeSession, OpenCodeMessage, OpenCodePart } from './opencode.js';
export type {
    MessageData, UserMessageData, AssistantMessageData,
    TokenInfo, PartData, TextPartData, ToolPartData,
    ToolState, ReasoningPartData, StepStartPartData,
    StepFinishPartData, CompactionPartData, PatchPartData,
    SessionWithProject, MessageWithParts,
} from './opencode.js';

// 从共享包导入核心类型
export type {
    UnifiedMessage,
    ToolCall,
    Collector,
    CollectorStats,
    SessionDTO,
    AgentDTO,
} from '@ice-bubble/types';
```

### 5.5 Phase 4: 迁移 admin

#### 变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/data/collector-client.ts` | **修改** | 删除已迁移的类型，从共享包导入 |
| `package.json` | **修改** | 添加 `"@ice-bubble/types": "*"` |

#### collector-client.ts 改造后

```typescript
// 从共享包导入 HTTP API 契约类型
import type {
    SessionDTO,
    AgentDTO,
    SessionEvent,
    CollectorStats,
    MessageItemDTO,
    GetSessionsResponse,
    GetMessagesResponse,
    GetAgentsResponse,
    GetEventsResponse,
} from '@ice-bubble/types';

// 兼容性别名（不改动其他文件中的引用）
export type CollectorSession = SessionDTO;
export type CollectorMessage = MessageItemDTO;
export type CollectorAgent = AgentDTO;
export type CollectorEvent = SessionEvent;
export type { CollectorStats, GetSessionsResponse, GetMessagesResponse, GetAgentsResponse, GetEventsResponse };
```

### 5.6 Phase 5: 清理 & 验证

1. 确认所有模块 `npm run build` 通过
2. 确认所有模块 `npm run typecheck` 通过
3. 检查是否有残留的本地 `UnifiedMessage` / `ToolCall` 定义
4. 更新 `README.md` 中关于项目结构的文档
5. 提交 PR

---

## 6. 注意事项

### 6.1 命名一致性

| 当前分散命名 | 共享包统一命名 | 说明 |
|---|---|---|
| openclaw: `Session` / admin: `CollectorSession` | `SessionDTO` | 加 DTO 后缀避免与各模块内部 Session 混淆 |
| openclaw: `Agent` / admin: `CollectorAgent` | `AgentDTO` | 同上 |
| admin: `CollectorMessage` | `MessageItemDTO` | 区别于 `UnifiedMessage` |
| openclaw: `SessionMessage` | **保留不变** | SQLite 内部类型，不共享 |
| openclaw: `SessionEvent` | `SessionEvent` | 各模块字段一致，保持原名 |

### 6.2 Snake Case vs Camel Case

- 共享包中的 HTTP API 类型（`SessionDTO`, `MessageItemDTO`, `AgentDTO`）使用 **camelCase**
- admin 的 `collector-client.ts` 当前使用 snake_case 是因为直接映射 collector 的 SQLite 列名
- 迁移时：共享包统一用 camelCase，admin 端在 `processSession()` / `processMessage()` 中做转换（已经是这么做的）

### 6.3 不破坏现有 API

- 各模块的 `types/index.ts` 继续导出所有原有类型
- 外部使用者（如 ice-bubble-desktop）只需从各模块的 types/index.ts 导入即可，无需改引用路径
- 内部实现逐步迁移到 `@ice-bubble/types` 直接导入

### 6.4 版本策略

- `@ice-bubble/types` 版本从 `1.0.0` 开始
- 各模块使用 `"@ice-bubble/types": "*"`（workspace 协议，始终使用本地版本）
- 类型变更时，types 包的版本号独立演进

### 6.5 不迁移的内容

以下类型明确**不迁移**到共享包，各自模块内部维护：

- **OpenClaw 原始类型** (`openclaw.ts`)：MessageEvent, TokenUsage, ToolCallContent 等
- **OpenCode 原始类型** (`opencode.ts`)：OpenCodeSession, OpenCodePart, PartData 等
- **Admin 内部类型**：AdminSession, AdminMessage, AdminAgent, ModuleRegistry 等
- **WebSocket 类型**：WSEvent, WSMessage
- **模块配置类型**：CollectorConfig, SQLiteManagerConfig, ModuleConfig 等

---

## 7. 文件树总览

```
ice-bubble/
├── packages/
│   └── types/                          # 🆕 共享类型包
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                # 统一导出
│           ├── common.ts               # MessageRole, DataSource, AgentStatus
│           ├── message.ts              # UnifiedMessage, ToolCall, TokenUsage
│           ├── session.ts              # SessionDTO, SessionEvent
│           ├── agent.ts                # AgentDTO
│           ├── collector.ts            # Collector 接口, CollectorStats
│           └── api.ts                  # HTTP API 响应类型
├── ice-bubble-collector-openclaw/
│   └── src/types/
│       ├── index.ts                    # 🔧 re-export + 保留内部类型
│       └── openclaw.ts                 # ✅ 保持不变
├── ice-bubble-collector-opencode/
│   └── src/types/
│       ├── index.ts                    # 🔧 re-export + 保留内部类型
│       └── opencode.ts                 # ✅ 保持不变
├── ice-bubble-admin/
│   ├── src/types/module.ts             # ✅ 保持不变（admin 内部）
│   └── src/data/collector-client.ts    # 🔧 类型替换为共享包导入
└── package.json                        # 🔧 workspaces 添加 packages/types
```

---

## 8. 总结

| 维度 | 收益 |
|---|---|
| **消除重复** | `UnifiedMessage`、`ToolCall`、HTTP API 类型只定义一次 |
| **API 契约统一** | admin 和 collector 共享同一份 API 类型，避免字段不一致 |
| **对接新 Collector** | 只需实现 `Collector` 接口，输出 `UnifiedMessage`，无需重新定义类型 |
| **类型演进** | 修改 `UnifiedMessage` 一处生效，编译期即可发现所有需要适配的地方 |
| **包体积** | 纯类型包，无运行时依赖，不会增加产物体积 |
