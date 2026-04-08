# OpenClaw-Session数据格式参考

> **文档说明**: 本文档基于 OpenClaw 真实运行数据反向分析总结，可能存在未覆盖的数据类型。如遇到新类型，请及时补充更新。  
> **数据来源**: OpenClaw 实例（WSL）  
> **采集时间**: 2026-04-08  
> **验证规模**: 124 个 Session 文件全量扫描  
> **当前覆盖**: ✅ 已覆盖所有已发现的数据类型（截至采集时间）

---

## 📋 目录

1. [核心发现](#核心发现)
2. [数据结构分析](#数据结构分析)
3. [事件类型定义](#事件类型定义)
4. [消息类型定义](#消息类型定义)
5. [特殊场景说明](#特殊场景说明)
6. [TypeScript 类型定义](#typescript-类型定义)
7. [数据库表结构](#数据库表结构)

---

## 🎯 数据格式概述

OpenClaw 采用事件驱动架构，Session 数据存储在 `.jsonl` 文件中，每行是一个事件（Event）。

### 事件的基本结构

```json
{
  "type": "message",
  "id": "bedd2c2c",
  "parentId": "babae8ca",
  "timestamp": "2026-04-03T04:16:30.643Z",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "帮我分析错误"
      }
    ],
    "timestamp": 1775189790619
  }
}
```

### 三层类型体系

OpenClaw 的类型体系分为三层：

| 层级 | 字段 | 说明 | 示例值 |
|------|------|------|--------|
| **事件层** | `type` | 事件类型 | `session`, `message`, `model_change` 等 |
| **消息层** | `message.role` | 消息角色 | `user`, `assistant`, `toolResult` |
| **内容层** | `message.content[].type` | 内容类型 | `text`, `thinking`, `toolCall` |

---

## 📊 数据结构分析

### 事件树结构

每个事件都有：
- `id`: 事件唯一标识
- `parentId`: 父事件 ID（形成事件树）
- `timestamp`: ISO 8601 时间戳

```
session (root)
  └─ model_change (parentId: null)
      └─ thinking_level_change
          └─ custom (model-snapshot)
              └─ message (user)
                  └─ message (assistant)
                      └─ message (toolResult)
                          └─ message (assistant)
                              └─ ...
```

### 数据流程

```
.jsonl 文件
  ↓ 每行一个事件
Event (事件)
  ├── SessionEvent
  ├── ModelChangeEvent
  ├── ThinkingLevelChangeEvent
  ├── CustomEvent
  └── MessageEvent (消息事件)
      └── Message (消息对象)
          └── MessageContentItem[] (内容数组)
              ├── TextContent
              ├── ThinkingContent
              └── ToolCallContent
```

---

## 🏗️ 事件类型定义

### 1. Session 元数据事件

```json
{
  "type": "session",
  "version": 3,
  "id": "012582c0-3fc5-4a35-818c-0dd9a1c359d4",
  "timestamp": "2026-04-03T04:16:30.616Z",
  "cwd": "/home/dabai/.openclaw/workspace/dev/config"
}
```

**作用**: Session 的元数据，记录 session ID、版本、工作目录等。

---

### 2. Model Change 事件

```json
{
  "type": "model_change",
  "id": "e142264b",
  "parentId": null,
  "timestamp": "2026-04-03T04:16:30.618Z",
  "provider": "minimax-cn",
  "modelId": "MiniMax-M2.7"
}
```

**作用**: 记录模型变更。

**Provider 列表**:
- `minimax-cn` - MiniMax（中国）
- `ollama` - Ollama 本地模型

**Model 列表**:
- `MiniMax-M2.5`, `MiniMax-M2.7`
- `deepseek-coder:33b-instruct`
- `huihui_ai/deepseek-r1-abliterated:32b`

---

### 3. Thinking Level Change 事件

```json
{
  "type": "thinking_level_change",
  "id": "b773064c",
  "parentId": "e142264b",
  "timestamp": "2026-04-03T04:16:30.618Z",
  "thinkingLevel": "low"
}
```

**ThinkingLevel 值**: `low` | `medium` | `high`

---

### 4. Custom 事件

```json
{
  "type": "custom",
  "customType": "model-snapshot",
  "data": {
    "timestamp": 1775189790619,
    "provider": "minimax-cn",
    "modelApi": "anthropic-messages",
    "modelId": "MiniMax-M2.7"
  },
  "id": "babae8ca",
  "parentId": "b773064c",
  "timestamp": "2026-04-03T04:16:30.619Z"
}
```

**CustomType**: 目前只发现 `model-snapshot`

**API 类型**:
- `anthropic-messages` - Anthropic API 格式
- `ollama` - Ollama API 格式

---

### 5. Message 事件（核心）

Message 事件是最重要的事件类型，包含实际的用户和 AI 对话。

详见下一章节。

---

## 💬 消息类型定义

### 1. User 消息

```json
{
  "type": "message",
  "id": "bedd2c2c",
  "parentId": "babae8ca",
  "timestamp": "2026-04-03T04:16:30.643Z",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "[Fri 2026-04-03 12:16 GMT+8] [Subagent Context] You are running as a subagent..."
      }
    ],
    "timestamp": 1775189790619
  }
}
```

---

### 2. Assistant 消息（纯文本）

```json
{
  "type": "message",
  "id": "a68b6aee",
  "parentId": "f04ed3dc",
  "timestamp": "2026-04-03T04:16:35.900Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "I need to approve this first.",
        "thinkingSignature": "c656de8a40fe7988f797fd639827f3082c6688997509b64fb4022ff391f1265a"
      },
      {
        "type": "text",
        "text": "/approve bc5f3f08 allow-once"
      }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn",
    "model": "MiniMax-M2.7",
    "usage": {
      "input": 1092,
      "output": 22,
      "cacheRead": 12214,
      "cacheWrite": 0,
      "totalTokens": 13328,
      "cost": {
        "input": 0.0005459999999999999,
        "output": 0.000033,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0.000579
      }
    },
    "stopReason": "stop",
    "timestamp": 1775189793969,
    "responseId": "061e7222ed965957c72268af94cee6d2"
  }
}
```

---

### 3. Assistant 消息（包含 toolCall）

```json
{
  "type": "message",
  "id": "79381d9b",
  "parentId": "bedd2c2c",
  "timestamp": "2026-04-03T04:16:33.704Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me start by reading the session.ts file...",
        "thinkingSignature": "22a98a168f61e98082bcabcbfa152ea64b62e38eb5cad68f5c0ba695b22cc0d2"
      },
      {
        "type": "toolCall",
        "id": "call_function_okm0dl5ye5bd_1",
        "name": "exec",
        "arguments": {
          "command": "wc -l /mnt/d/workspace/ice-box/src/lib/session.ts"
        }
      }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn",
    "model": "MiniMax-M2.7",
    "usage": {
      "input": 36,
      "output": 78,
      "cacheRead": 3580,
      "cacheWrite": 9455,
      "totalTokens": 13149,
      "cost": {
        "input": 0.000018,
        "output": 0.000117,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0.000135
      }
    },
    "stopReason": "toolUse",
    "timestamp": 1775189790642,
    "responseId": "061e721fe126c3448a74f7a585e4e451"
  }
}
```

**StopReason 类型**:
- `toolUse` - AI 调用工具
- `stop` - AI 正常结束
- `end_turn` - AI 结束回合

---

### 4. ToolResult 消息

```json
{
  "type": "message",
  "id": "f04ed3dc",
  "parentId": "79381d9b",
  "timestamp": "2026-04-03T04:16:33.969Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_function_okm0dl5ye5bd_1",
    "toolName": "exec",
    "content": [
      {
        "type": "text",
        "text": "Approval required (id bc5f3f08, full bc5f3f08-2378-4069-a0e5-17e3a1f6522a). Host: gateway..."
      }
    ],
    "details": {
      "status": "approval-pending",
      "approvalId": "bc5f3f08-2378-4069-a0e5-17e3a1f6522a",
      "approvalSlug": "bc5f3f08",
      "expiresAtMs": 1775191593955,
      "host": "gateway",
      "command": "wc -l /mnt/d/workspace/ice-box/src/lib/session.ts",
      "cwd": "/home/dabai/.openclaw/workspace/dev/config",
      "warningText": ""
    },
    "isError": false,
    "timestamp": 1775189793956
  }
}
```

**Details 字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | 执行状态（`completed`, `approval-pending`, `error`） |
| `exitCode` | number | 退出码（0=成功，1=失败） |
| `durationMs` | number | 执行时长（毫秒） |
| `aggregated` | string | 聚合输出 |
| `cwd` | string | 工作目录 |

**Approval 相关字段**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `approvalId` | string | 完整审批 ID |
| `approvalSlug` | string | 短 ID |
| `expiresAtMs` | number | 过期时间（Unix ms） |
| `host` | string | 执行主机 |
| `command` | string | 待审批命令 |
| `warningText` | string | 警告文本 |

---

## 🔍 特殊场景说明

### 场景 1: 错误状态的双重标识

ToolResult 消息中有两个独立的错误标识：

```json
{
  "message": {
    "role": "toolResult",
    "content": [{
      "type": "text",
      "text": "src/services/health.service.ts(2428,36): error TS2802: ..."
    }],
    "details": {
      "status": "completed",
      "exitCode": 1,
      "durationMs": 1712
    },
    "isError": false
  }
}
```

**字段说明**:
- `exitCode: 1` = 命令执行失败（业务层面）
- `isError: false` = OpenClaw 系统正常（系统层面）

这两个字段代表不同层面的错误状态，需要分别处理：

```typescript
if (message.isError) {
  // OpenClaw 系统错误
} else if (message.details?.exitCode !== 0) {
  // 命令执行错误
}
```

---

### 场景 2: 超长消息内容 📦

某些 toolResult 的 content 极长（可能超过 1MB），需要存储优化。

**处理建议**:
```sql
-- 方案 1: 使用 TEXT 类型（SQLite 自动处理大文本）
CREATE TABLE messages (
  content TEXT
);

-- 方案 2: 单独存储超长内容
CREATE TABLE message_contents (
  message_id TEXT PRIMARY KEY,
  content TEXT,
  is_large BOOLEAN,
  compressed_size INTEGER
);
```

---

### 场景 3: Approval 流程 🔐

```json
{
  "details": {
    "status": "approval-pending",
    "approvalId": "bc5f3f08-2378-4069-a0e5-17e3a1f6522a",
    "approvalSlug": "bc5f3f08",
    "expiresAtMs": 1775191593955,
    "command": "wc -l /path/to/file",
    "warningText": ""
  }
}
```

**解析 Approval 信息**:
```typescript
function parseApprovalInfo(details: ToolResultDetails): ApprovalInfo | null {
  if (details.status !== 'approval-pending') return null;
  
  return {
    id: details.approvalId!,
    slug: details.approvalSlug!,
    expiresAt: new Date(details.expiresAtMs!),
    command: details.command!,
    warning: details.warningText
  };
}
```

---

### 场景 4: Subagent Context 🤖

User 消息可能包含系统注入的 Subagent Context：

```
[Fri 2026-04-03 12:16 GMT+8] [Subagent Context] You are running as a subagent (depth 1/1)...
```

**识别方式**: 检查 `content[0].text` 是否以 `[Subagent Context]` 开头。

---

## 📝 TypeScript 类型定义

### 1. 基础事件类型

```typescript
/**
 * 基础事件
 */
export interface BaseEvent {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;  // ISO 8601
}

/**
 * 事件类型枚举
 */
export type EventType = 
  | 'session'
  | 'model_change'
  | 'thinking_level_change'
  | 'custom'
  | 'message';

/**
 * OpenClaw 事件（联合类型）
 */
export type OpenClawEvent = 
  | SessionEvent
  | ModelChangeEvent
  | ThinkingLevelChangeEvent
  | CustomEvent
  | MessageEvent;
```

---

### 2. 具体事件类型

```typescript
/**
 * Session 元数据事件
 */
export interface SessionEvent extends BaseEvent {
  type: 'session';
  version: number;
  cwd: string;
}

/**
 * 模型变更事件
 */
export interface ModelChangeEvent extends BaseEvent {
  type: 'model_change';
  provider: string;
  modelId: string;
}

/**
 * Thinking 级别变更事件
 */
export interface ThinkingLevelChangeEvent extends BaseEvent {
  type: 'thinking_level_change';
  thinkingLevel: 'low' | 'medium' | 'high';
}

/**
 * 自定义事件
 */
export interface CustomEvent extends BaseEvent {
  type: 'custom';
  customType: string;
  data: Record<string, unknown>;
}

/**
 * 消息事件
 */
export interface MessageEvent extends BaseEvent {
  type: 'message';
  message: Message;
}
```

---

### 3. 消息类型

```typescript
/**
 * 消息
 */
export interface Message {
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContentItem[];
  timestamp: number;  // Unix timestamp (ms)
  
  // AI 回复特有字段
  api?: 'anthropic-messages' | 'ollama';
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  stopReason?: 'toolUse' | 'stop' | 'end_turn';
  responseId?: string;
  
  // 工具结果特有字段
  toolCallId?: string;
  toolName?: string;
  details?: ToolResultDetails;
  isError?: boolean;
}

/**
 * 消息角色枚举
 */
export type MessageRole = 
  | 'user'
  | 'assistant'
  | 'toolResult';
```

---

### 4. 消息内容类型

```typescript
/**
 * 消息内容项（联合类型）
 */
export type MessageContentItem = 
  | TextContent
  | ThinkingContent
  | ToolCallContent;

/**
 * 文本内容
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Thinking 内容
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature: string;
}

/**
 * 工具调用内容
 */
export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

---

### 5. Token 使用统计

```typescript
/**
 * Token 使用统计
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

---

### 6. ToolResult Details

```typescript
/**
 * ToolResult Details
 */
export interface ToolResultDetails {
  status: 'completed' | 'approval-pending' | 'error';
  exitCode?: number;
  durationMs?: number;
  aggregated?: string;
  cwd?: string;
  
  // Approval 相关字段
  approvalId?: string;
  approvalSlug?: string;
  expiresAtMs?: number;
  host?: string;
  command?: string;
  warningText?: string;
}
```

---

## 🗄️ 数据库表结构

### sessions 表

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  version INTEGER,
  cwd TEXT,
  timestamp TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### events 表

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  timestamp TEXT NOT NULL,
  data JSON NOT NULL,  -- 完整的事件 JSON
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (parent_id) REFERENCES events(id)
);

CREATE INDEX idx_events_session_id ON events(session_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_timestamp ON events(timestamp);
```

---

### messages 表（从 MessageEvent 提取）

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content JSON NOT NULL,
  timestamp INTEGER NOT NULL,
  
  -- AI 回复字段
  api TEXT,
  provider TEXT,
  model TEXT,
  usage JSON,
  stop_reason TEXT,
  response_id TEXT,
  
  -- 工具结果字段
  tool_call_id TEXT,
  tool_name TEXT,
  details JSON,
  is_error BOOLEAN,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_tool_call_id ON messages(tool_call_id);
```

---

## 📊 数据类型统计

| 类别 | 数量 | 完整类型 |
|------|------|---------|
| **事件类型** | 5 | session, model_change, thinking_level_change, custom, message |
| **消息角色** | 3 | user, assistant, toolResult |
| **内容类型** | 3 | text, thinking, toolCall |
| **Provider** | 2 | minimax-cn, ollama |
| **API** | 2 | anthropic-messages, ollama |
| **StopReason** | 3 | toolUse, stop, end_turn |
| **ThinkingLevel** | 3 | low, medium, high |
| **CustomType** | 1 | model-snapshot |

---

## ✅ 总结

### 数据格式特点

1. **事件驱动架构**: 每行是一个事件，事件通过 `parentId` 形成树状结构
2. **三层类型体系**:
   - 事件类型（`event.type`）: 5 种事件
   - 消息角色（`message.role`）: 3 种角色
   - 内容类型（`message.content[].type`）: 3 种类型
3. **完整 Token 统计**: 包含 input、output、cacheRead、cacheWrite、totalTokens 和成本
4. **双重错误标识**: `isError` 和 `exitCode` 代表不同层面的错误状态

### 数据采集建议

1. 使用 TypeScript 联合类型定义完整的类型系统
2. 对超长内容进行分离存储
3. 正确处理系统错误（`isError`）和命令错误（`exitCode`）
4. 支持 Approval 流程的解析和存储

---

**文档版本**: v1.0  
**最后更新**: 2026-04-08  
**验证状态**: ✅ 已通过真实数据验证