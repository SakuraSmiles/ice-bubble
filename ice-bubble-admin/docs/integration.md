# 模块接入指南

> ice-bubble-admin 模块接入规范文档

## 概述

本文档说明：
1. 如何将外部模块接入 admin 进行统一管理
2. Collector 模块需要提供的 HTTP API 接口

---

## Part 1: Collector 接入规范

Collector 模块需要提供以下 HTTP API 接口供 admin 调用：

### 1.1 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/meta/status | 获取模块状态 |
| GET | /api/meta/config | 获取模块配置 |
| GET | /api/data/stats | 获取数据统计 |
| GET | /api/data/sessions | 获取会话列表 |
| GET | /api/data/messages | 获取消息列表 |

### 1.2 GET /api/meta/status

获取模块运行时状态。

**请求**
```
GET /api/meta/status
```

**响应**
```json
{
  "moduleKey": "collector-openclaw",
  "moduleType": "collector",
  "version": "1.0.0",
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

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| moduleKey | string | 是 | 模块唯一标识 |
| moduleType | string | 是 | 模块类型 |
| version | string | 否 | 模块版本 |
| status | string | 是 | 运行状态：running/stopped/error |
| runtime | object | 否 | 运行时信息 |
| runtime.startTime | string | 否 | 启动时间 ISO8601 |
| runtime.uptimeSeconds | number | 否 | 运行秒数 |
| runtime.messagesCollected | number | 否 | 采集消息数 |
| runtime.errorsCount | number | 否 | 错误次数 |
| health | object | 否 | 健康信息 |
| health.status | string | 否 | healthy/warning/error |
| health.message | string | 否 | 健康描述 |

### 1.3 GET /api/meta/config

获取模块运行时配置。

**请求**
```
GET /api/meta/config
```

**响应**
```json
{
  "config": {
    "watchPath": "/home/user/.openclaw/agents",
    "dbPath": "/path/to/collector.db",
    "batchSize": 50,
    "batchTimeout": 3000,
    "dedup": {
      "enabled": true,
      "cacheSize": 5000
    }
  }
}
```

### 1.4 GET /api/data/stats

获取数据统计信息。

**请求**
```
GET /api/data/stats
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

### 1.5 GET /api/data/sessions

获取会话列表（支持分页）。

**请求**
```
GET /api/data/sessions?limit=100&offset=0&since=2026-04-09T00:00:00Z
```

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 100，最大 1000 |
| offset | number | 否 | 偏移量，默认 0 |
| since | string | 否 | ISO8601 时间戳，仅返回该时间之后更新的记录 |

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
      "last_message_at": "2026-04-09T13:49:11.244Z"
    }
  ]
}
```

### 1.6 GET /api/data/messages

获取消息列表（支持分页和过滤）。

**请求**
```
GET /api/data/messages?limit=100&offset=0&since=2026-04-09T00:00:00Z
GET /api/data/messages?session_key=agent:main:local:default:direct:xxx&limit=100
```

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_key | string | 否 | 会话标识，不填则返回所有消息 |
| limit | number | 否 | 每页数量，默认 100，最大 1000 |
| offset | number | 否 | 偏移量，默认 0 |
| since | string | 否 | ISO8601 时间戳，仅返回该时间之后的消息 |

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
      "tools_json": "[{\"name\":\"exec\",\"input\":{},\"result\":{}}]",
      "timestamp": "2026-04-09T15:16:58.089Z",
      "created_at": null
    }
  ]
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | number | 消息自增 ID |
| session_key | string | 关联的会话标识 |
| message_type | string | 消息类型：user/agent/tool |
| content | string | 消息内容 |
| model | string | AI 模型名称（仅 agent 消息） |
| tokens_input | number | 输入 Token 数 |
| tokens_output | number | 输出 Token 数 |
| tools_json | string | 工具调用 JSON（仅 tool 消息） |
| timestamp | string | 消息时间 ISO8601 |
| created_at | string | 入库时间 |

---

## Part 2: Admin 配置规范

### 2.1 模块配置

在 admin 的 `config.json` 中添加模块配置：

```json
{
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

### 2.2 配置字段说明

**modules[].配置**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| moduleKey | string | 是 | 模块唯一标识 |
| name | string | 是 | 模块名称（用于展示） |
| baseUrl | string | 是 | Collector HTTP API 基础地址 |
| enabled | boolean | 否 | 是否启用，默认 true |
| pollInterval | number | 否 | 状态轮询间隔（毫秒），默认 30000 |

**dataSync 配置**

| 字段 | 类型 | 说明 |
|------|------|------|
| collectorBaseUrl | string | Collector HTTP API 地址 |
| pollInterval | number | 数据同步间隔（毫秒），默认 60000 |
| batchSize | number | 每批同步条数，默认 500 |

---

## Part 3: Admin REST API

admin 提供以下接口供前端调用：

### 3.1 模块管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取所有模块列表 |
| GET | /api/modules/:key | 获取单个模块详情 |
| GET | /api/modules/:key/status | 获取模块状态 |
| GET | /api/modules/:key/config | 获取模块配置 |

### 3.2 数据接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stats | 获取统计汇总 |
| GET | /api/sessions | 获取会话列表 |
| GET | /api/sessions/:key | 获取会话详情 |
| GET | /api/messages | 获取消息列表 |
| GET | /api/agents | 获取 Agent 列表 |

### 3.3 错误响应格式

所有接口错误响应格式：

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

**常见错误码**

| 错误码 | 说明 |
|--------|------|
| MODULE_NOT_FOUND | 模块不存在 |
| SESSION_NOT_FOUND | 会话不存在 |
| FETCH_FAILED | 获取 Collector 数据失败 |
| DATABASE_ERROR | 数据库操作失败 |

---

## Part 4: 数据溯源

admin 从 collector 同步的数据包含溯源字段：

| 字段 | 说明 | 示例 |
|------|------|------|
| source_module | 来源模块标识 | collector-openclaw |
| source_id | 原始数据 ID | 84846 |
| source_created_at | 原始创建时间 | 2026-04-09T15:16:58.089Z |

---

**版本**: 1.0.0
**最后更新**: 2026-04-09
