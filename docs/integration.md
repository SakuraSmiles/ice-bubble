# ice-bubble 模块接入规范

> 最近更新：2026-04-26

---

## 概述

ice-bubble 采用模块化架构，新增模块只需实现标准接口即可接入。任何 Collector、Task 模块只需实现以下规范中描述的端点即可注册到 admin 进行统一管理。

---

## 一、模块类型枚举

| moduleType | 说明 | 示例 |
|------------|------|------|
| `collector` | 数据采集模块 | ice-bubble-collector-openclaw |
| `task` | 任务管理模块 | ice-bubble-task |
| `admin` | 核心管理模块 | ice-bubble-admin（系统内置，不可删除） |
| `custom` | 自定义模块 | 第三方扩展模块 |

---

## 二、必须实现的端点

每个模块必须实现以下两个基础端点，供 admin 轮询使用：

### 2.1 GET /meta

返回模块元信息，admin 据此完成注册。

**响应格式：**

```json
{
  "moduleKey": "collector-openclaw",
  "name": "OpenClaw 数据采集器",
  "moduleType": "collector",
  "version": "1.0.0",
  "description": "OpenClaw 消息采集模块"
}
```

**字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| moduleKey | string | 是 | 全局唯一标识，建议与模块名一致 |
| name | string | 是 | 人类可读名称 |
| moduleType | string | 是 | 模块类型，取值见"模块类型枚举" |
| version | string | 是 | 当前版本号，语义化版本 |
| description | string | 否 | 模块功能描述 |

### 2.2 GET /status

返回模块运行时状态。

**响应格式：**

```json
{
  "state": "running",
  "lastPollTime": "2026-04-26T10:30:00.000Z",
  "lastError": null,
  "runtime": {
    "startTime": "2026-04-26T08:00:00.000Z",
    "uptimeSeconds": 9000
  }
}
```

**字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| state | string | 是 | 状态：`running` / `stopped` / `error` |
| lastPollTime | string | 是 | ISO 8601 时间戳，admin 最近一次轮询时间 |
| lastError | string \| null | 否 | 最近一次错误信息，无错误时为 null |
| runtime.startTime | string \| null | 否 | 进程启动时间 |
| runtime.uptimeSeconds | number \| null | 否 | 运行时长（秒） |

---

## 三、Agent 状态字段规范

### 3.1 必填字段

- `status`: string，标准化枚举 (`active` / `idle` / `offline`)

### 3.2 可选字段

- `task_enhancement`: TaskEnhancement 对象
  - `status`: `'working'` | `'idle'`
  - `pending_count`: number
  - `source`: `'available'` | `'unavailable'` | `'none'`

### 3.3 状态标准化映射

| 原始值 | 标准值 |
|--------|--------|
| 活跃 / active | active |
| 空闲 / idle | idle |
| 离线 / offline | offline |
| null | offline |

---

## 四、模块注册流程

1. **发现**：admin 根据 `config/modules.json` 中配置的 `baseUrl` 向目标模块发送 `GET /meta`
2. **注册**：响应验证通过后，写入 `module_registry` 表
3. **轮询**：admin 每隔 `pollInterval`（毫秒）调用 `GET /status` 更新运行状态
4. **状态合并**：runtime state + enabled 配置状态决定最终展示

---

## 五、数据上报接口（Collector 特化）

Collector 模块在完成数据采集后，需要将数据推送给 admin：

### 5.1 上报消息

```
POST {admin_baseUrl}/collectors/ingest
Content-Type: application/json

{
  "session_key": "xxx",
  "agent_id": "xxx",
  "channel": "xxx",
  "message_type": "user|agent|tool",
  "content": "...",
  "timestamp": "2026-04-26T10:30:00.000Z",
  "metadata": {}
}
```

### 5.2 上报 Agent 状态

```
POST {admin_baseUrl}/collectors/agents/status
Content-Type: application/json

{
  "agent_id": "xxx",
  "status": "active|idle|offline",
  "task_enhancement": { ... }
}
```

---

## 六、版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-23 | 1.0.0 | 初始版本，Agent 状态规范 |
| 2026-04-26 | 1.1.0 | 补充 meta/status 接口格式、moduleType 枚举、Collector 数据上报规范 |
