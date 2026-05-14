# Collector HTTP API 文档

> ice-bubble-collector-openclaw 提供给 admin 的 HTTP API 接口

## 概述

Collector 模块通过 HTTP API 向 admin 提供数据访问接口，实现**数据层分离**：
- Collector 负责采集和存储
- Admin 通过 HTTP API 获取数据，不直接访问 Collector 的数据库

## 架构

```
Collector SQLite → Collector HTTP API → Admin HTTP Client → Admin SQLite → Admin REST API
```

**设计原则**：
1. Admin 不直接访问 Collector 的数据库
2. 通过标准 HTTP API 获取数据
3. 支持跨服务器部署

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/meta/status | 获取模块状态 |
| GET | /api/meta/config | 获取模块配置 |
| GET | /api/data/stats | 获取数据统计 |
| GET | /api/data/sessions | 获取会话列表 |
| GET | /api/data/messages | 获取消息列表 |

---

## /api/meta/* — 模块元数据接口

### GET /api/meta/status

获取模块运行时状态。

**请求**
```bash
curl http://localhost:13100/api/meta/status
```

**响应**
```json
{
  "moduleKey": "collector-openclaw",
  "moduleType": "collector",
  "version": "1.1.2",
  "status": "running",
  "runtime": {
    "startTime": "2026-04-09T12:32:00Z",
    "uptimeSeconds": 3600,
    "messagesCollected": 19563,
    "errorsCount": 0
  },
  "health": {
    "status": "healthy",
    "message": "正常"
  }
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| moduleKey | string | 模块唯一标识 |
| moduleType | string | 模块类型 |
| version | string | 模块版本 |
| status | string | 运行状态：running/stopped/error |
| runtime | object | 运行时信息 |
| runtime.startTime | string | 启动时间 ISO8601 |
| runtime.uptimeSeconds | number | 运行秒数 |
| runtime.messagesCollected | number | 已采集消息数 |
| runtime.errorsCount | number | 错误次数 |
| health | object | 健康信息 |
| health.status | string | healthy/warning/error |
| health.message | string | 健康描述 |

---

### GET /api/meta/config

获取模块运行时配置。

**请求**
```bash
curl http://localhost:13100/api/meta/config
```

**响应**
```json
{
  "watchPath": "/home/user/.openclaw/agents",
  "dbPath": "/path/to/collector.db",
  "batchSize": 50,
  "batchTimeout": 3000,
  "dedup": {
    "enabled": true,
    "cacheSize": 5000
  },
  "validation": {
    "enabled": true,
    "strictMode": false
  }
}
```

---

## /api/data/* — 数据查询接口

### GET /api/data/stats

获取数据统计信息。

**请求**
```bash
curl http://localhost:13100/api/data/stats
```

**响应**
```json
{
  "sessionCount": 248,
  "messageCount": 96076,
  "agentCount": 17,
  "lastUpdated": "2026-04-09T13:50:07.368Z"
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| sessionCount | number | 会话总数 |
| messageCount | number | 消息总数 |
| agentCount | number | Agent 总数 |
| lastUpdated | string | 最后更新时间 ISO8601 |

---

### GET /api/data/sessions

获取会话列表。

**请求**
```bash
# 基本请求
curl "http://localhost:13100/api/data/sessions"

# 分页请求
curl "http://localhost:13100/api/data/sessions?limit=100&offset=0"

# 增量查询（按时间过滤）
curl "http://localhost:13100/api/data/sessions?since=2026-04-09T00:00:00Z"
```

**Query 参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| limit | number | 否 | 100 | 每页数量，最大 1000 |
| offset | number | 否 | 0 | 偏移量 |
| since | string | 否 | - | ISO8601 时间戳，仅返回该时间之后更新的记录 |

**响应**
```json
{
  "count": 248,
  "sessions": [
    {
      "session_key": "agent:main:local:default:direct:c520c69e-9977-485b-92c3-010e01b30afb",
      "agent_id": "main",
      "channel": "local",
      "account_id": "default",
      "peer_id": "c520c69e-9977-485b-92c3-010e01b30afb",
      "guild_id": null,
      "created_at": "2026-04-08T14:09:43.882Z",
      "updated_at": "2026-04-09T13:49:11.244Z",
      "message_count": 392,
      "last_message_at": "2026-04-09T13:49:11.244Z",
      "label": null,
      "status": null,
      "model": null,
      "model_provider": null,
      "spawned_by": null,
      "spawn_depth": 0
    }
  ]
}
```

**Sessions 字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| session_key | string | 会话唯一标识 |
| agent_id | string | Agent ID |
| channel | string | 通信渠道 |
| account_id | string | 账号 ID |
| peer_id | string | 对端用户 ID |
| guild_id | string | 频道/服务器 ID |
| created_at | string | 会话创建时间 ISO8601 |
| updated_at | string | 最后更新时间 ISO8601 |
| message_count | number | 消息数量 |
| last_message_at | string | 最后消息时间 ISO8601 |
| label | string | 会话标签 |
| status | string | 会话状态 |
| model | string | 使用的 AI 模型名称 |
| model_provider | string | AI 模型提供商 |
| spawned_by | string | 派生来源父会话 key |
| spawn_depth | number | 派生深度（0 表示非派生会话） |

---

### GET /api/data/messages

获取消息列表。

**请求**
```bash
# 获取所有消息（默认）
curl "http://localhost:13100/api/data/messages?limit=100"

# 按会话过滤
curl "http://localhost:13100/api/data/messages?session_key=agent:main:local:default:direct:c520c69e&limit=100"

# 按时间过滤
curl "http://localhost:13100/api/data/messages?since=2026-04-09T00:00:00Z&limit=100"
```

**Query 参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| session_key | string | 否 | - | 会话标识，不填则返回所有消息 |
| limit | number | 否 | 100 | 每页数量，最大 1000 |
| offset | number | 否 | 0 | 偏移量 |
| since | string | 否 | - | ISO8601 时间戳，仅返回该时间之后的消息 |

**响应**
```json
{
  "count": 96076,
  "messages": [
    {
      "id": 84846,
      "session_key": "agent:main:local:default:direct:c520c69e-9977-485b-92c3-010e01b30afb",
      "message_type": "tool",
      "content": "...",
      "model": null,
      "tokens_input": null,
      "tokens_output": null,
      "cost_total": null,
      "cost_input": null,
      "cost_output": null,
      "tools_json": "[{\"name\":\"exec\",\"input\":{},\"result\":{\"status\":\"completed\"}}]",
      "timestamp": "2026-04-09T15:16:58.089Z",
      "created_at": null
    }
  ]
}
```

**Messages 字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | number | 消息自增 ID |
| session_key | string | 关联的会话标识 |
| message_type | string | 消息类型：user/agent/tool |
| content | string | 消息内容（文本） |
| model | string | AI 模型名称（仅 agent 消息） |
| tokens_input | number | 输入 Token 数（仅 agent 消息） |
| tokens_output | number | 输出 Token 数（仅 agent 消息） |
| cost_total | number | 总消耗（仅 agent 消息） |
| cost_input | number | 输入消耗（仅 agent 消息） |
| cost_output | number | 输出消耗（仅 agent 消息） |
| tools_json | string | 工具调用 JSON（仅 tool 消息） |
| timestamp | string | 消息原始时间 ISO8601 |
| created_at | string | 入库时间 ISO8601 |

---

## 错误响应

所有接口的错误响应格式统一：

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

**常见错误码**

| 错误码 | HTTP 状态码 | 说明 |
|--------|-------------|------|
| NOT_FOUND | 404 | 接口不存在 |
| SESSIONS_FETCH_FAILED | 500 | 获取 sessions 失败 |
| MESSAGES_FETCH_FAILED | 500 | 获取 messages 失败 |
| STATS_FETCH_FAILED | 500 | 获取统计失败 |
| INTERNAL_ERROR | 500 | 内部服务器错误 |

---

## 安全说明

当前 API 设计适用于**内网环境**：

1. **无认证机制**：暂未实现，未来可添加 API Key 或 OAuth
2. **CORS 开放**：默认允许所有来源，生产环境应限制
3. **无接口限流**：可能被滥用，当前场景影响小

**生产环境部署建议**：
- 限制 CORS 来源
- 添加 API Key 认证
- 添加接口限流

---

**版本**: 1.1.2
**最后更新**: 2026-05-14
