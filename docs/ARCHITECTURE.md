# ice-bubble 架构设计文档

> 最近更新：2026-05-14

---

## 一、核心设计思想

### 1.1 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      VIEW LAYER                              │
│              ice-bubble-desktop (Desktop)                   │
│              Tauri + Vue3 + Element Plus                   │
│                    端口：1420                               │
└──────────────────────────┬──────────────────────────────────┘
                         │ 直连
┌──────────────────────────▼──────────────────────────────────┐
│                      BIZ LAYER                               │
│                 ice-bubble-admin (Admin)                    │
│              Express + SQLite + ModuleScheduler             │
│                    端口：13000                              │
└──────────┬──────────────────────────────────────────────────┘
           │ HTTP
┌─────────────────────────────────────────────────────────────┘
┌──────────▼──────────────────────────────────────────────────┐
│                      DATA LAYER                             │
│           ice-bubble-collector-openclaw (Collector)         │
│                    端口：13100                              │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心原则

| 原则 | 说明 |
|------|------|
| **直连模式** | Desktop 通过 Vite proxy（开发）或 Tauri（生产）直连 Admin |
| **数据库驱动** | 配置存 config.json，状态存 SQLite |
| **双状态机** | enabled（配置状态）+ status（运行时状态）分离 |
| **时区安全** | 使用 ISO 8601 时间戳（带 Z 后缀） |
| **自动降级** | 生产环境端口冲突自动尝试备用端口 |

---

## 二、模块设计

### 2.1 Admin 模块（ice-bubble-admin）

```typescript
// 核心功能
- 模块注册表管理（module_registry）
- 运行时状态追踪（module_runtime_status）
- 定时轮询调度（ModuleScheduler）
- 数据同步服务（DataSync）
```

**端口**：13000

**数据库表**：
```sql
module_registry:     模块注册信息（含 registeredTime）
module_runtime_status: 运行时状态（含 lastPollTime）
```

### 2.2 Collector 模块（ice-bubble-collector-openclaw）

```typescript
// 核心功能
- OpenClaw 消息采集
- 会话管理
- 消息存储（SQLite）
```

**端口**：13100

### 2.3 Desktop 模块（ice-bubble-desktop）

```typescript
// 架构模式
- 开发环境：Vite Dev Server + Vite proxy 转发
- 生产环境：Tauri 打包，前端直连 Admin
```

**端口**：1420


---

## 三、API 设计

> 所有 `/api/*` 端点（除特殊标注）均需 Bearer Token 认证。
> 无需认证的端点：`GET /health`、`GET /api/auth/status`、`POST /api/auth/verify`、`GET /api/resources/avatars/:filename`

### 3.1 模块管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取模块列表（含 registeredTime + version） |
| GET | /api/modules/:key | 获取模块详情（含运行时 status） |
| GET | /api/modules/:key/status | 手动触发轮询，获取模块最新状态 |
| GET | /api/modules/:key/config | 获取模块运行时配置 |
| POST | /api/modules | 新增模块 |
| PUT | /api/modules/:key | 更新模块配置 |
| DELETE | /api/modules/:key | 删除模块 |
| POST | /api/modules/test-connection | 测试连接 |

### 3.2 会话管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sessions | Sessions 列表（支持 agent_id/channel 过滤） |
| GET | /api/sessions/unified | Gateway + Admin 合并会话（按最后消息时间排序） |
| GET | /api/sessions/grouped | 按 agent 分组的 sessions |
| GET | /api/sessions/:key | 单个 session 详情 |
| GET | /api/sessions/:key/messages | 会话消息列表 |
| POST | /api/sessions | 创建新会话（通过 Gateway RPC） |

### 3.3 Agent API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/agents | Agent 列表（含实时状态） |
| GET | /api/agents/overview | Agent 概览聚合 |
| GET | /api/agents/with-activity | Agent + 活动热力图 |
| GET | /api/agents/token-summary | Token 统计 |
| POST | /api/agents/token-summary/rebuild | 重建 Token 统计表 |
| POST | /api/agents/activity/rebuild | 重建活动统计表 |
| GET | /api/agents/:id/avatar | Agent 头像 |
| PUT | /api/agents/:id/avatar | 更新 Agent 头像 |
| GET | /api/agents/:id/activity | Agent 活动热力图 |

### 3.4 会话分组 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/session-groups | 获取分组列表 |
| POST | /api/session-groups | 创建分组 |
| PATCH | /api/session-groups/:id | 更新分组 |
| DELETE | /api/session-groups/:id | 删除分组 |
| POST | /api/session-groups/:id/members | 添加成员 |
| DELETE | /api/session-groups/:id/members/:sessionKey | 移除成员 |

### 3.5 会话偏好 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/session-preferences | 获取偏好（置顶/隐藏） |
| PUT | /api/session-preferences | 更新偏好 |

### 3.6 工作区 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/workspace/tree | 目录树 + git 状态 |
| GET | /api/workspace/git-status | Git 统计摘要 |
| GET | /api/workspace/scan | 扫描一级子目录 |

### 3.7 设置 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/settings | 读取配置（掩码敏感字段） |
| PUT | /api/settings | 保存配置（白名单合并） |

### 3.8 聊天 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat/send | 发送聊天消息（SSE 推送通道） |
| GET | /api/chat/stream | SSE 聊天流 |
| POST | /api/chat/abort | 中止聊天流 |
| GET | /api/chat/history | 聊天历史（HTTP 代理 → Gateway） |

### 3.9 模块状态响应结构

```typescript
interface ModuleDetailResponse {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval: number;
  registeredTime: string;  // ISO 8601
  version: string;
  status: {
    state: 'running' | 'stopped' | 'error' | null;
    lastPollTime: string;
    lastError?: string;
    runtime: {
      startTime?: string;
      uptimeSeconds?: number;
    };
  };
}
```

### 3.10 WebSocket 协议

**端点：** `WS /ws`

Desktop 通过 WebSocket 与 Admin 通信，Admin 作为 Gateway 的代理。

**协议类型：**

| 类型 | 方向 | 说明 |
|------|------|------|
| `req` | Desktop → Admin → Gateway | 请求响应模式（带 id） |
| `event` | Gateway → Admin → Desktop | 服务端推送事件（无 id） |
| `res` | Gateway → Admin → Desktop | 请求响应（带 id） |

**认证：** Token 通过 query 参数 `?token=...` 或 header 传递

**核心事件：**

| 事件名 | 来源 | 说明 |
|--------|------|------|
| `chat.message` | Gateway | 新聊天消息 |
| `chat.response` | Gateway | 聊天响应片段 |
| `chat.done` | Gateway | 聊天完成 |
| `agent.status.changed` | Gateway | Agent 状态变更 |
| `sessions.changed` | Gateway | 会话列表变更 |

**心跳：** 30s ping/pong 超时检测

**注意事项：**
- Desktop WebSocket 连接时，Admin 会先与 Gateway 建立内部连接
- 连接失败时 Admin 仍可独立运行（Gateway 不可用不影响 Admin REST API）
- Gateway 事件采用广播模式，所有 Desktop 客户端均收到所有事件

---

## 四、关键设计决策

### 4.1 配置 vs 状态分离

| 类型 | 存储 | 说明 |
|------|------|------|
| **配置** | config.json | 模块地址、轮询间隔、启用状态 |
| **运行时** | SQLite | 实际运行状态、最后轮询时间、错误信息 |

### 4.2 admin 模块不可删除

- 系统中始终保留 admin 模块
- 删除按钮对其永远隐藏
- 从数据库读取注册时间，保证持久化

### 4.3 前端表单校验

```typescript
interface FormRules {
  name: [required, min(2), max(50)];
  baseUrl: [required, URL验证(ip/port)];
  pollInterval: [required, positive integer];
}
```

### 4.4 URL 校验规则

```
允许格式：
- http://localhost:13000
- http://127.0.0.1:13000
- https://localhost:13000

禁止：
- 非 localhost/127.0.0.1
- 无端口或非法端口
```

---

## 五、生产部署

### 5.1 Tauri 打包流程

```bash
# 1. 构建前端
npm run build

# 2. 打包 Tauri
npm run tauri build
# → 生成安装包（包含 dist/）
```

---

## 六、技术栈

| 层级 | 技术 |
|------|------|
| Desktop | Tauri + Vue3 + Element Plus + TypeScript |
| Admin | Express + TypeScript + better-sqlite3 |
| Collector | Node.js + TypeScript + better-sqlite3 |
| 构建 | Vite + esbuild + Tauri |

---

## 七、Agent 状态系统

### 设计原则
- OpenClaw 状态为主（单一权威数据源）
- 任务系统为辅（状态增强）

### 状态枚举

| 枚举值 | 含义 | 来源 |
|--------|------|------|
| active | 活跃 | OpenClaw |
| idle | 空闲 | OpenClaw |
| offline | 离线 | OpenClaw |

### Task Enhancement

```typescript
interface TaskEnhancement {
  status: 'working' | 'idle';
  pending_count: number;
  source: 'available' | 'unavailable' | 'none';
}
```

### 展示格式

| OpenClaw 状态 | 任务增强 | 最终展示 |
|---------------|----------|----------|
| active | working | Active (Working) |
| active | idle | Active |
| idle | working | Idle (Working) |
| idle | idle | Idle |
| offline | any | Offline |

### 数据流

```
Desktop ──WebSocket──► Admin ──WebSocket──► Gateway
 (Vue3)                (WsServer)            (OpenClaw)
   │                     │
   │                     └── REST /api/* ──► Admin SQLite
   │
   └── 直连 REST（模块管理、数据查询）
```

**双通道架构：**
- **REST 通道**：Desktop 直连 Admin（端口 13000），用于数据查询和模块管理
- **WebSocket 通道**：Desktop ↔ Admin ↔ Gateway，用于实时聊天和事件推送
- Admin 与 Gateway 之间通过单一 GatewayProxy 连接（请求转发 + 事件订阅）
- 头像文件 `/api/resources/avatars/:filename` 无需认证（浏览器 `<img>` 无法携带 Authorization header），路径穿越已修复（`..` 和 `/` 校验）

---

## 八、版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-10 | 1.0.0 | 初始版本，三层架构完成 |
| 2026-05-06 | 1.0.0 | 移除 Express 代理，改为直连模式 |
| 2026-05-14 | 1.1.1 | 补充完整 API 端点、Gateway 双连接合并、WebSocket 协议说明、头像路径穿越修复 |