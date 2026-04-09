# 测试任务单：Collector API 层（服务于 admin）

> **派发对象**：测试攻城狮
> **派发时间**：2026-04-09
> **关联需求**：collector-openclaw 新增 HTTP API 接口层（满足 admin 接入规范）
> **优先级**：P0（阻塞联调）

---

## 一、背景说明

### 新增代码清单

| 文件 | 职责 | 行数(估) |
|------|------|---------|
| `src/api/types.ts` | Admin 规范响应类型定义 | ~80 |
| `src/api/routes/meta.ts` | GET /api/meta/status 路由 | ~120 |
| `src/api/server.ts` | Express 服务创建/启动 | ~110 |
| `src/start.ts`（修改）| 启动流程接入 HTTP 服务 | 步骤5新增 |

### 核心接口

```
GET /api/meta/status → ModuleStatusResponse
```

响应格式（必须严格符合 admin integration.md）：
```json
{
  "moduleKey": "collector-openclaw",
  "moduleType": "collector",
  "version": "1.0.0",
  "status": "running",
  "runtime": {
    "startTime": "ISO8601",
    "uptimeSeconds": 123,
    "messagesCollected": 100,
    "errorsCount": 0
  },
  "health": {
    "status": "healthy",
    "message": "正常"
  }
}
```

### 关键设计约束

1. **不暴露数据查询接口**（sessions/agents/tools 等），只服务 admin
2. **无认证中间件**（内网使用）
3. **CORS 允许所有来源**
4. **端口 13100**（config.json 中配置）

---

## 二、测试环境要求

### ⚠️ 绝对禁止事项

- ❌ **不得修改任何 src/ 下源码**
- ❌ **不得修改 config/config.json**
- ❌ **不得在项目根目录或 data/ 目录下产生持久化文件**
- ❌ **不得提交 .db / .db-wal / .db-shm 文件到 git**

### 必须遵守的测试规范

| 规范 | 说明 |
|------|------|
| **临时目录** | 所有文件操作必须在 os.tmpdir() 创建的临时目录中进行 |
| **临时数据库** | SQLite dbPath 必须指向临时目录 |
| **afterEach 清理** | 每个测试用例结束后必须清理所有临时资源 |
| **端口冲突** | 集成测试使用随机端口（port: 0）避免与开发端口 13100 冲突 |
| **超时控制** | 集成测试单个用例不超过 15 秒 |

### 现有基础设施（可复用）

```
tests/
├── helpers/
│   └── sqlite-test-helper.ts   ← 可复用的 SQLite 测试辅助
├── fixtures/
│   └── sample-messages.json     ← 测试数据
├── unit/                        ← 单元测试放这里
├── integration/                 ← 集成测试放这里
└── output/                      ← 覆盖率报告输出
```

---

## 三、测试任务清单

### 任务 A：API Server 单元测试

**产出文件**：`tests/unit/api/server.test.ts`

#### A1 — createApiServer 基础功能
- [ ] 返回有效的 Express Application 实例
- [ ] 注册了 JSON 解析中间件（body limit=1mb）
- [ ] 注册了 CORS 中间件（Access-Control-Allow-Origin=*）
- [ ] OPTIONS 请求返回 204

#### A2 — 路由注册验证
- [ ] GET `/api/meta/status` 返回 200（需要 mock collector）
- [ ] GET `/api/meta/unknown` 返回 404
- [ ] POST `/api/meta/status` 返回 404（只允许 GET）
- [ ] GET `/random-path` 返回 404

#### A3 — 错误处理
- [ ] 未捕获错误返回 500 + `{ error, code: 'INTERNAL_ERROR' }`
- [ ] 404 响应包含 `{ error: '接口不存在', code: 'NOT_FOUND' }`

#### A4 — 配置禁用场景
- [ ] config.enabled=false 时 createApiServer 正常返回 app（但不监听端口）

---

### 任务 B：Meta Route 单元测试

**产出文件**：`tests/unit/api/meta-route.test.ts`

#### B1 — /api/meta/status 正常响应
- [ ] 响应状态码 200
- [ ] body.moduleKey === `'collector-openclaw'`
- [ ] body.moduleType === `'collector'`
- [ ] body.version === `'1.0.0'`
- [ ] body.status === `'running'`
- [ ] body.runtime 存在且类型正确
- [ ] body.runtime.startTime 是有效 ISO8601 格式
- [ ] body.runtime.uptimeSeconds 是非负整数
- [ ] body.health 存在且 status 为合法值（healthy/warning/error）

#### B2 — runtime 字段正确性
- [ ] messagesCollected 与 collector.getStats().successEvents 一致
- [ ] errorsCount 与 collector.getStats().failedEvents 一致
- [ ] uptimeSeconds 随时间递增（两次请求间隔后 uptime 变大）

#### B3 — health 状态判定逻辑
- [ ] 无事件时 health.status = 'healthy', message='正常'
- [ ] 错误率 >10% 时 health.status='error'，message 包含百分比
- [ ] 错误率 1%~10% 时 health.status='warning'

#### B4 — 异常场景
- [ ] collector.getStats() 抛异常时返回 500
- [ ] 错误响应包含 `{ error, code: 'STATUS_FETCH_FAILED' }`

---

### 任务 C：API 集成测试（端到端）

**产出文件**：`tests/integration/api-integration.test.ts`

#### C1 — 完整生命周期
- [ ] 启动 FileCollector（临时目录 + 临时 DB，enableWatch=false）
- [ ] 启动 ApiServer（随机端口 port:0）
- [ ] HTTP GET /api/meta/status 返回完整状态 JSON
- [ ] 关闭 HttpServer
- [ ] 关闭 FileCollector
- [ ] 临时目录全部清理干净（无残留 .db/.wal/.shm）

#### C2 — 并发请求稳定性
- [ ] 50 个并发 GET /api/meta/status 全部返回 200
- [ ] 所有响应结构一致

#### C3 — 端口占用处理
- [ ] 端口被占用时 startApiServer reject EADDRINUSE 错误
- [ ] 不影响已有采集器运行状态

---

### 任务 D：回归测试（确保未破坏现有功能）

**执行方式**：运行全量已有测试套件

- [ ] `npx vitest run tests/unit/` 全部通过
- [ ] `npx vitest run tests/integration/` 全部通过
- [ ] 覆盖率不低于当前阈值（70% lines/functions/branches/statements）

---

## 四、测试技术要点

### 依赖安装（如需）

```bash
cd D:\workspace\ice-bubble\ice-bubble-collector-openclaw
npm install -D supertest @types/supertest
```

### Mock FileCollector 的方式

```typescript
// 使用 vi.fn() mock getStats 方法
const mockCollector = {
  getStats: vi.fn(() => ({
    totalFiles: 10,
    processedFiles: 8,
    skippedFiles: 1,
    totalEvents: 100,
    successEvents: 95,
    failedEvents: 3,
    retriedEvents: 2,
  })),
} as unknown as FileCollector;
```

### 集成测试端口处理

```typescript
// 使用 port: 0 让 OS 分配随机端口，避免冲突
const server = app.listen(0);
const actualPort = (server.address() as import('net').AddressInfo).port;
// 然后用 supertest 连接 http://127.0.0.1:${actualPort}
```

### 运行指定测试

```bash
# 只跑 API 相关单元测试
npx vitest run tests/unit/api/

# 只跑集成测试
npx vitest run tests/integration/api-integration.test.ts

# 全量 + 覆盖率
npm run test:coverage
```

---

## 五、验收标准

| 维度 | 标准 |
|------|------|
| **通过率** | 100%（0 failure） |
| **覆盖率** | 新增 API 层代码覆盖率 ≥ 80% |
| **无污染** | git status 无新增 data/ 或 dist/ 下的文件 |
| **无副作用** | 项目 data/ 目录下无新增 .db 文件 |
| **耗时** | 全量测试执行 < 60 秒 |

---

## 六、交付物清单

| # | 交付项 | 路径 |
|---|--------|------|
| 1 | Server 单元测试 | `tests/unit/api/server.test.ts` |
| 2 | Meta Route 单元测试 | `tests/unit/api/meta-route.test.ts` |
| 3 | 集成测试 | `tests/integration/api-integration.test.ts` |
| 4 | 测试结果报告 | 终端输出截图 + coverage HTML 报告 |

---

## 七、备注

- 测试框架：**vitest**（项目已配置，无需额外配置）
- HTTP 测试库：建议使用 **supertest**
- 如发现 bug，记录在 issue 中，**不要直接改源码**，反馈给开发人员
- 测试完成后确认 `git status` 干净（仅新增 test 文件）

---
