<div align="center">

<h1>ice-bubble</h1>

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repo](https://img.shields.io/badge/GitHub-100000?style=flat-square&logo=github&logoColor=white)](https://github.com/SakuraSmiles/ice-bubble)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen?style=flat-square)](https://github.com/SakuraSmiles/ice-bubble)
[![Coverage](https://img.shields.io/badge/coverage-85%25+-green?style=flat-square)](https://github.com/SakuraSmiles/ice-bubble)


> ice-bubble 多 Agent 团队协作管理系统 — 三层架构：数据采集 · 业务核心 · 桌面展示

**当前版本：** `1.0.0` (所有模块统一版本号)

</div>

---

## 项目简介

ice-bubble 采用模块化结构，提供 OpenClaw 的功能扩展。

---

## 核心模块

| 层级 | 模块 | 版本 | 说明 |
|------|------|------|------|
| **VIEW LAYER** | **ice-bubble-desktop** | `1.0.0` | 桌面端展示应用（Tauri + Vue3 + Element Plus + Express），面向最终用户 |
| **BIZ LAYER** | **ice-bubble-admin** | `1.0.0` | 核心业务逻辑（API 服务、模块管理、数据同步），整体内聚 |
| **TASK LAYER** | **ice-bubble-task** | `1.0.0` | 任务管理（任务调度、状态追踪、结果存储） |
| **DATA LAYER** | **ice-bubble-collector-openclaw** | `1.0.0` | OpenClaw 数据采集器，封装输入输出，暴露标准接口，可水平扩展 |

> DATA LAYER 设计为可插拔：未来新增数据源（如 WorkBuddy）只需实现标准接口的 Collector 即可。

---

## 架构图

<div align="center">

![系统架构图](./docs/ice-bubble.drawio.svg)

</div>

---

## 文档导航


| 文档 | 说明 |
|------|------|
| [desktop](./ice-bubble-desktop/README.md) | 桌面端展示应用详细文档 |
| [admin](./ice-bubble-admin/README.md) | 核心业务模块详细文档 |
| [collector-openclaw](./ice-bubble-collector-openclaw/README.md) | 数据采集模块详细文档 |
| [接入规范](./docs/integration.md) | 模块接入标准和规范 |

---

## 项目结构

```
ice-bubble/
├── .gitattributes
├── .gitignore
├── LICENSE
├── README.md
├── data/                              ← 运行时数据（SQLite 等）
├── docs/
│   ├── ice-bubble.drawio.svg         ← 系统架构图
│   └── integration.md                 ← 模块接入规范
├── ice-bubble-admin/                  ← BIZ LAYER：核心业务逻辑
│   ├── README.md
│   ├── config/
│   ├── src/
│   └── docs/
├── ice-bubble-task/                   ← TASK LAYER：任务管理
│   ├── README.md
│   ├── config/
│   └── src/
├── ice-bubble-collector-openclaw/     ← DATA LAYER：OpenClaw 数据采集器
│   ├── README.md
│   ├── config/
│   ├── src/
│   ├── tests/
│   └── docs/
└── ice-bubble-desktop/                ← VIEW LAYER：桌面端展示应用
    ├── README.md
    ├── .env.example
    ├── src/
    └── src-tauri/
```

## 服务端口

| 模块 | 端口 | 说明 |
|------|------|------|
| desktop 后端 | 14000 | Express API 代理 |
| admin | 13000 | 业务 API |
| task | 13102 | 任务管理 API |
| collector | 13100 | 数据采集 API |

## 快速开始

### 启动依赖顺序

```
1. collector-openclaw  (13100)  — 数据源，最先启动
2. admin              (13000)  — 依赖 collector，提供业务 API
3. task               (13102)  — 独立运行，依赖 admin 提供 agent 信息
4. desktop            (14000)  — 代理层，聚合 admin + task 数据
```

### 启动命令

```bash
# 1. 数据采集层
cd ice-bubble-collector-openclaw && npm run dev

# 2. 业务管理层（另起终端）
cd ice-bubble-admin && npm run dev

# 3. 任务管理层（另起终端）
cd ice-bubble-task && npm run dev

# 4. 桌面端（另起终端）
cd ice-bubble-desktop && npm run dev:all
```

> Desktop 的 Express 代理会自动将 `/api/tasks/*` 转发至 task 服务（13102），
> 其他 `/api/*` 转发至 admin 服务（13000）。

### 认证配置

所有 API 服务（admin / collector / task）支持可选的 Bearer Token 认证。

**配置方式（环境变量优先）：**

```bash
# 方式一：环境变量（推荐，生产环境使用）
export ICE_AUTH_TOKEN="your-secret-token"

# 方式二：config.json 备用（仅开发环境使用）
# 在各模块的 config/config.json 中添加：
# {
#   "auth": { "token": "your-secret-token" }
# }
```

**Desktop 前端配置：**

在 Desktop 的 `.env` 文件中配置：

```bash
VITE_ICE_AUTH_TOKEN=your-secret-token
```

---

## License

MIT © SakuraSmiles
