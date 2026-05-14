# 技术准确性审查报告 — 代码-文档一致性

> 审查日期：2026-05-14
> 审查范围：ice-bubble 项目所有文档 vs 实际源代码
> 审查方法：逐一对比文档声明与代码实现

---

## 汇总

| 严重度 | 数量 |
|--------|------|
| 🔴 错误 | 5 |
| 🟡 过时 | 1 |
| 🟠 表述不清 | 2 |

---

## 一、端口号准确性

### 验证结果

| 文档声明 | 实际值 | 状态 |
|----------|--------|------|
| Desktop 前端 1420 | `vite.config.ts`: `const VITE_PORT = 1420` | ✅ 正确 |
| Admin 13000 | `config/config.json`: `"port": 13000` | ✅ 正确 |
| Collector 13100 | `config/config.json`: `"port": 13100` | ✅ 正确 |
| Task 13102（已废弃） | — | ✅ 已正确标注废弃 |
| Gateway 18789 | collector `config.json`: `"url": "wss://localhost:18789"` | ✅ 正确（collector 配置中引用） |

**结论：所有端口号与代码一致，无问题。**

---

## 二、API 路径准确性

### 🔴 错误 #1：Admin README 中数据 API 路径前缀错误

**文件：** `ice-bubble-admin/README.md` — "数据 API" 表格

**文档声明：**
```
GET /api/data/stats
GET /api/data/sessions
GET /api/data/sessions/:key
GET /api/data/messages
GET /api/data/agents
```

**实际代码：** `src/index.ts` 第 295 行：
```typescript
app.use('/api', createDataRouter({ ... }));
```

`createDataRouter` 内部路由定义（`src/api/data.ts`）：
```typescript
router.get('/stats', ...)
router.get('/sessions', ...)
router.get('/sessions/:key', ...)
router.get('/messages', ...)
router.get('/agents', ...)
```

**实际端点：** `/api/stats`, `/api/sessions`, `/api/data/agents` 不存在。

**代码证据：** `src/api/data.ts` 文件头部注释也明确写的是 `GET /api/stats`、`GET /api/sessions`。

**修正建议：** 将 Admin README 数据 API 表格中所有 `/api/data/` 前缀改为 `/api/`。

---

### 🔴 错误 #2：Admin README 的 API 文档与实际端点存在差异

**文件：** `ice-bubble-admin/README.md` — "数据 API" 表格

**文档列出但路径错误的端点：**

| 文档声明 | 实际端点 | 说明 |
|----------|----------|------|
| `GET /api/data/stats` | `GET /api/stats` | 前缀错误 |
| `GET /api/data/sessions` | `GET /api/sessions` | 前缀错误 |
| `GET /api/data/sessions/:key` | `GET /api/sessions/:key` | 前缀错误 |
| `GET /api/data/messages` | `GET /api/messages` | 前缀错误 |
| `GET /api/data/agents` | `GET /api/agents` | 前缀错误 |

**文档遗漏的实际端点：**

| 实际端点 | 位置 |
|----------|------|
| `GET /api/sessions/unified` | `sessions-unified.ts` |
| `GET /api/sessions/grouped` | `data.ts` |
| `GET /api/sessions/:key/messages` | `index.ts` |
| `GET /api/messages/timeline` | `data.ts` |
| `GET /api/messages/deduplicate` (POST) | `data.ts` |
| `GET /api/agents/with-activity` | `data.ts` |
| `GET /api/agents/token-summary` | `data.ts` |
| `POST /api/agents/token-summary/rebuild` | `data.ts` |
| `POST /api/agents/activity/rebuild` | `data.ts` |
| `GET /api/agents/overview` | `data.ts` |
| `GET /api/agents/:id/avatar` | `data.ts` |
| `PUT /api/agents/:id/avatar` | `data.ts` |
| `GET /api/agents/:id/activity` | `data.ts` |

**修正建议：** Admin README 的数据 API 表格应与 `docs/ARCHITECTURE.md` 保持一致（ARCHITECTURE.md 基本准确）。

---

### 🔴 错误 #5：Desktop README 中 `/api/tasks/*` 引用不存在的服务

**文件：** `ice-bubble-desktop/README.md` — "API 调用" 表格

**文档声明：**
```
GET /api/tasks/*           task    任务相关接口（见 task 模块文档）
GET /api/agents/:agent_id/tasks  task    成员关联的任务列表
```

**实际代码：** 项目中不存在独立的 task 服务。`src/api/tasks.ts` 实际挂载在 `/api/subagent-tasks`，且仅有一个 `GET /` 端点（获取子 agent 任务列表）。

Desktop client.ts 中的实际调用：`/subagent-tasks`（第 515 行）。

**修正建议：** 移除 `task` 相关条目，改为：
```
GET /api/subagent-tasks    admin   子 agent 任务列表
```

---

### 🟠 表述不清 #2：Desktop README 中 `/api/stats` 路径

**文件：** `ice-bubble-desktop/README.md` — "API 调用" 表格

文档中 `GET /api/stats` 标注目标服务为 `admin`，这正确。但结合 Admin README 的错误路径（`/api/data/stats`），两份文档之间存在矛盾。Admin README 是错误源头。

---

### 🟠 表述不清 #3：Desktop README API 调用表中有不存在的端点

**文件：** `ice-bubble-desktop/README.md`

**文档声明但 Desktop client.ts 中未实际调用的端点：**
- `GET /api/messages` — client.ts 中有 `fetchJson('/messages')` 但用于不同场景，实际存在
- Desktop README 中列出的大部分端点经核实确实存在于 admin 代码中

**结论：** Desktop README 的 API 表大部分正确，仅有 `task` 相关条目有误。

---

### docs/ARCHITECTURE.md API 表准确性

**对比结果：** ARCHITECTURE.md 中的 API 端点（§3.1 - §3.8）与代码高度一致。所有列出的端点均可在 `src/index.ts` 和各 router 文件中找到对应实现。

**一个小问题：** ARCHITECTURE.md §3.1 注释说 "GET /api/modules — 获取模块列表（含 registeredTime + version）"，代码确实返回这些字段，正确。

### docs/integration.md API 表准确性

**验证结果：** integration.md 描述的 Collector 端点 `/api/meta/status`、`/api/meta/config` 与 `collector/src/api/server.ts` 第 170、173 行的挂载路径一致。Collector 数据端点 `/api/data/sessions`、`/api/data/messages`、`/api/data/stats` 也与 `collector/src/api/routes/data.ts` 一致。

**注意：** Collector 的端点确实是 `/api/data/*` 前缀（与 Admin 不同）。这是正确的——Admin 的 data router 挂载在 `/api` 下，而 Collector 的 data router 挂载在 `/api/data` 下。

---

## 三、命令可执行性

### 🔴 错误 #3：根目录 `npm run dev` 不存在

**文件：** `README.md`（根目录）— "快速开始" 章节

**文档声明：**
```bash
# 一键启动所有服务
npm run dev
```

**实际代码：** 根目录 `package.json` scripts：
```json
{
  "sync-version": "...",
  "postversion": "...",
  "build:all": "...",
  "start:admin": "...",
  "start:collector": "...",
  "start:desktop": "..."
}
```

**不存在 `dev` 脚本。**

**修正建议：** 移除 `npm run dev` 的"一键启动"描述，或添加该脚本到根 `package.json`。

---

### 各子模块命令验证

| 模块 | 命令 | 存在 | 备注 |
|------|------|------|------|
| admin | `npm run dev` | ✅ | `tsx watch src/index.ts` |
| admin | `npm run build` | ✅ | `tsc` |
| admin | `npm run start` | ✅ | `node dist/index.js` |
| admin | `npm run typecheck` | ✅ | |
| collector | `npm run dev` | ✅ | `tsx watch src/start.ts` |
| collector | `npm run build` | ✅ | `tsc` |
| collector | `npm run start` | ✅ | `node dist/start.js` |
| collector | `npm run test:all` | ✅ | `vitest run` |
| collector | `npm run test:unit` | ✅ | `vitest run tests/unit/` |
| collector | `npm run test:coverage` | ✅ | |
| collector | `npm run lint` | ✅ | |
| collector | `npm run format` | ✅ | |
| collector | `npm run typecheck` | ✅ | |
| desktop | `npm run dev` | ✅ | `vite` |
| desktop | `npm run build` | ✅ | `vue-tsc --noEmit && vite build` |
| desktop | `npm run tauri dev` | ✅ | |
| desktop | `npm run tauri build` | ✅ | |
| desktop | `npm run tauri` | ✅ | 但 README 未列出 |

---

### 🟡 过时 #1：Collector README 测试数量声明

**文件：** `ice-bubble-collector-openclaw/README.md`

**文档声明：** "全量测试（298 个用例）"、"当前通过率: 298 / 298 (100%)"、badge 显示 `298/298`

**说明：** 这些数字可能是历史记录，未随代码变更更新。由于测试可能已增减，建议移除硬编码的测试数量，改为动态描述（如 "运行 `npm run test:all` 查看当前测试状态"）。

---

### 已验证通过：Collector WSL 脚本

`start-wsl.sh` 文件已确认存在（最后修改 2026-04-08），此文档声明无问题。

---

## 四、版本号准确性

### 验证结果

| 位置 | 声明版本 | 实际版本（package.json） | 状态 |
|------|----------|--------------------------|------|
| 根 README | `1.1.1`（统一发布版本） | `1.1.1`（根 package.json） | ✅ |
| 根 README | admin `1.2.0` | `1.2.0` | ✅ |
| 根 README | collector `1.1.1` | `1.1.1` | ✅ |
| 根 README | desktop `1.3.0` | `1.3.0` | ✅ |
| 核心模块表 | desktop `1.3.0` | `1.3.0` | ✅ |
| 核心模块表 | admin `1.2.0` | `1.2.0` | ✅ |
| 核心模块表 | collector `1.1.1` | `1.1.1` | ✅ |
| Desktop Tauri config | `"version": "1.0.0"` | desktop `1.3.0`（package.json） | ❌ 不一致 |

### 🔴 错误 #4：Desktop Tauri 配置版本号过时

**文件：** Desktop README 示例中的 `tauri.conf.json`

**文档声明：**
```json
{
  "productName": "ice-bubble-desktop",
  "version": "1.0.0",
  ...
}
```

**实际代码：** `src-tauri/tauri.conf.json`：
```json
{
  "version": "1.3.0",
  ...
}
```

**修正建议：** 更新 Desktop README 中的示例为 `"version": "1.3.0"`，或改用占位符避免未来再次过时。

---

## 五、架构描述准确性

### docs/ARCHITECTURE.md 架构验证

**四层架构（§1.1）：** 文档描述的三层（VIEW/BIZ/DATA）结构与实际项目结构一致。

**双通道架构（§7 数据流）：**
- REST 通道：Desktop → Admin → SQLite ✅
- WebSocket 通道：Desktop ↔ Admin ↔ Gateway ✅
- GatewayProxy 单一连接：代码中 `GatewayProxy` 类确实负责统一管理 Gateway 连接 ✅

**WebSocket 协议（§3.10）：**
- `WS /ws` 端点：`index.ts` 第 412 行确认 ✅
- req/res/event 类型：与 `gateway/ws-server.ts` 实现一致 ✅
- 心跳 30s：需确认代码中的具体实现值，但声明合理 ✅

**认证说明（§3 开头）：**
- `GET /health`：`index.ts` 第 391 行确认存在 ✅
- `GET /api/auth/status`：`index.ts` 第 169 行确认存在 ✅
- `POST /api/auth/verify`：`index.ts` 第 183 行确认存在 ✅
- `GET /api/resources/avatars/:filename`：`index.ts` 第 197-218 行，确认在 auth middleware 之前注册 ✅

**结论：** ARCHITECTURE.md 的免认证端点列表完全准确。

---

## 六、详细修正建议

### 优先级 P0（错误，应立即修复）

1. **Admin README 数据 API 路径前缀**：将所有 `/api/data/*` 改为 `/api/*`，或补充实际端点列表
2. **根 README `npm run dev`**：移除或添加该脚本
3. **Desktop README Tauri 版本号示例**：更新为 `1.3.0`
4. **Desktop README task 相关端点**：替换为 `/api/subagent-tasks`

### 优先级 P1（过时，应尽快更新）

5. **Collector 测试数量**：移除硬编码的 298 数字

### 优先级 P2（表述不清，可后续优化）

6. **Admin README 补充缺失端点**：对齐 ARCHITECTURE.md 的完整端点列表

---

## 附录：审查方法

- **端口号：** `grep` 搜索各模块 `config.json` 和源代码中的端口配置
- **API 路径：** 逐行检查 `admin/src/api/*.ts` 和 `admin/src/index.ts` 中的 `router.get/post/put/delete` 和 `app.get/post` 调用
- **命令：** 检查各模块 `package.json` 的 `scripts` 字段
- **版本号：** 对比各模块 `package.json` 的 `version` 字段
- **架构：** 阅读源代码中的模块导入和连接管理逻辑
