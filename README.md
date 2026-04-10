<div align="center">

<h1>ice-bubble</h1>

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repo](https://img.shields.io/badge/GitHub-100000?style=flat-square&logo=github&logoColor=white)](https://github.com/SakuraSmiles/ice-bubble)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen?style=flat-square)](https://github.com/SakuraSmiles/ice-bubble)
[![Coverage](https://img.shields.io/badge/coverage-85%25+-green?style=flat-square)](https://github.com/SakuraSmiles/ice-bubble)


> ice-bubble 多 Agent 团队协作管理系统 — 三层架构：数据采集 · 业务核心 · 桌面展示

</div>

---

## 项目简介

ice-bubble 采用模块化结构，提供 OpenClaw 的功能扩展。

---

## 核心模块

| 层级 | 模块 | 说明 | 状态 |
|------|------|------|------|
| **VIEW LAYER** | **ice-bubble-topdesk** | 桌面端展示应用（Tauri + Vue3)，面向最终用户 | 🚧 开发中 |
| **BIZ LAYER** | **ice-bubble-admin** | 核心业务逻辑（API 服务、状态管理、任务调度），整体内聚 | 🚧 开发中 |
| **DATA LAYER** | **ice-bubble-collector-openclaw** | OpenClaw 数据采集器，封装输入输出，暴露标准接口，可水平扩展 | ✅ 已实现 |

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
| [collector-openclaw](./ice-bubble-collector-openclaw/README.md) | 数据采集模块详细文档 |
| [admin](./ice-bubble-admin/README.md) | 核心业务模块详细文档 |

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
│   └── ice-bubble.drawio.svg         ← 系统架构图
├── ice-bubble-admin/                  ← BIZ LAYER：核心业务逻辑
│   ├── README.md
│   ├── config/
│   ├── src/
│   └── docs/
├── ice-bubble-collector-openclaw/     ← DATA LAYER：OpenClaw 数据采集器
│   ├── README.md
│   ├── config/
│   ├── src/
│   ├── tests/
│   └── docs/
└── ice-bubble-topdesk/                ← VIEW LAYER：桌面端展示应用
```

---

## License

MIT © SakuraSmiles
