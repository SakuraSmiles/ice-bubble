# ice-bubble 架构设计文档

> 最近更新：2026-05-06

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

### 3.1 模块管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/modules | 获取模块列表（含 registeredTime + version） |
| GET | /api/modules/:key | 获取模块详情（含运行时 status） |
| POST | /api/modules | 新增模块 |
| PUT | /api/modules/:key | 更新模块配置 |
| DELETE | /api/modules/:key | 删除模块 |
| POST | /api/modules/test-connection | 测试连接 |

### 3.2 模块状态响应结构

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

1. collector 采集 OpenClaw 消息 → admin
2. admin API 标准化状态
3. 前端获取 agents → 增强展示

---

## 八、版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-10 | 1.0.0 | 初始版本，三层架构完成 |
| 2026-05-06 | 1.0.0 | 移除 Express 代理，改为直连模式 |