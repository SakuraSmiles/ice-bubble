<div align="center">

<h1>ice-bubble-desktop</h1>

[![Tauri](https://img.shields.io/badge/tauri-2.0-brightgreen)](https://tauri.app/)
[![Vue.js](https://img.shields.io/badge/vue-3.5-blue)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.5-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repo](https://img.shields.io/badge/GitHub-100000?style=flat-square&logo=github&logoColor=white)](https://github.com/SakuraSmiles/ice-bubble)


> @ice-bubble/desktop  
> ice-bubble 桌面端展示应用 — 调用 admin API 进行数据可视化

</div>

---

## 项目简介

`@ice-bubble/desktop` 是 ice-bubble 微服务系统的桌面端展示模块，负责：
1. **数据展示**：通过 admin API 获取并展示系统数据
2. **模块监控**：实时监控各模块运行状态
3. **会话浏览**：查看会话列表和消息详情

### 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2.0 | Rust 后端 + Web 前端 |
| 前端框架 | Vue 3.5 | Composition API |
| UI 组件库 | Element Plus | GitHub 风格主题 |
| 语言 | TypeScript 5.5 | 严格模式 |
| 构建工具 | Vite 6.0 | 快速构建 |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ice-bubble-desktop                           │
│                      (桌面应用窗口 / 浏览器)                          │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │    Overview     │  │    Modules      │  │    Sessions     │      │
│  │     概览页面      │  │    模块管理      │  │    会话记录      │      │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘      │
│           │                   │                   │                │
│           └───────────────────┼───────────────────┘                │
│                               │                                    │
│                    Vue 3 前端 (fetch /api/*)                        │
└───────────────────────────────┼────────────────────────────────────┘
                                │
                     Vite proxy（开发）/ Tauri（生产）
                                │
                    ┌───────────▼─────────────┐
                    │    ice-bubble-admin     │
                    │      (端口 13000)       │
                    └───────────┬─────────────┘
                                │
                                │ HTTP API (13100)
                                │
                    ┌───────────▼─────────────┐
                    │ ice-bubble-collector     │
                    │      (端口 13100)       │
                    └─────────────────────────┘
```

### 端口说明

| 模块 | 端口 | 说明 |
|------|------|------|
| desktop 前端 | 1420 | Vite Dev Server（开发）/ Tauri 窗口（生产） |
| admin | 13000 | 管理 API |
| collector | 13100 | 数据采集 API |

---

## 快速开始

### 环境要求

- Node.js 18+
- Rust 1.70+
- Tauri CLI 2.0

### 安装系统依赖（Linux）

```bash
sudo apt-get install pkg-config libgtk-3-dev
sudo apt-get install libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
sudo apt-get install libwebkit2gtk-4.1-dev
```

### 配置

复制 `.env.example` 为 `.env`（如果不存在则创建）。

> Desktop 通过 Setup 页面配置 Admin 地址，`.env` 文件仅用于开发环境变量。

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 生产模式

```bash
# Tauri 开发模式
npm run tauri dev

# 构建
npm run build
```

---

## 配置说明

### Tauri 配置

配置文件位于 `src-tauri/tauri.conf.json`：

```json
{
  "productName": "ice-bubble-desktop",
  "version": "1.0.0",
  "build": {
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "title": "ice-bubble-desktop",
      "width": 1200,
      "height": 800
    }]
  }
}
```

### Admin API 地址

在代码中配置 `src/config/index.ts`：

```typescript
export const ADMIN_API_BASE = 'http://localhost:13000';
```

---

## 页面功能

| 页面 | 路径 | 功能 |
|------|------|------|
| 初始设置 | /setup | 配置 Admin 地址和 Auth Token |
| 概览 | / | 系统统计、模块状态 |
| 模块管理 | /modules | 查看各模块运行状态 |
| 成员列表 | /agents | Agent 列表和状态 |
| 全部会话 | /sessions | 所有会话列表和详情 |
| 任务管理 | /tasks | 任务列表和管理 |
| 工作区 | /workspace/:key | 单个 Agent 的工作区视图 |
| 聊天 | /chat | 对话界面 |

---

## API 调用

desktop 通过 Vite proxy（开发）或 Tauri（生产）直连 admin 服务：

| 方法 | 路径 | 目标服务 | 说明 |
|------|------|---------|------|
| GET | /api/stats | admin | 系统统计 |
| GET | /api/sessions | admin | 会话列表 |
| GET | /api/sessions/:key | admin | 会话详情 |
| GET | /api/sessions/:key/messages | admin | 会话消息列表 |
| GET | /api/messages | admin | 消息列表 |
| GET | /api/messages/timeline | admin | 时间线消息（支持过滤） |
| GET | /api/modules | admin | 模块列表 |
| GET | /api/modules/:key/status | admin | 模块状态 |
| GET | /api/modules/:key/config | admin | 模块配置 |
| POST | /api/modules/test-connection | admin | 测试模块连接 |
| POST | /api/modules | admin | 新增模块 |
| PUT | /api/modules/:key | admin | 更新模块 |
| DELETE | /api/modules/:key | admin | 删除模块 |
| GET | /api/agents | admin | 成员列表 |
| GET | /api/agents/with-activity | admin | 带活跃数据的成员列表 |
| GET | /api/agents/token-summary | admin | Token 统计汇总 |
| GET | /api/subagent-tasks | admin | 任务列表 |

---

## 项目结构

```
src/
├── main.ts                 # Vue 入口
├── App.vue                 # 根组件
├── config/
│   └── index.ts           # 统一配置
├── api/
│   └── client.ts          # API 调用封装
├── views/
│   ├── Overview.vue       # 概览页
│   ├── Modules.vue        # 模块管理页
│   ├── Sessions.vue       # 会话记录页
│   ├── Agents.vue         # 成员列表页
│   ├── AllSessions.vue    # 全部会话页
│   ├── Tasks.vue          # 任务管理页
│   ├── Setup.vue          # 初始设置页
│   ├── Workspace.vue      # 工作区页
│   └── Chat.vue           # 聊天页
└── components/
    └── ...

src-tauri/
├── Cargo.toml             # Rust 依赖
├── tauri.conf.json       # Tauri 配置
└── src/
    ├── lib.rs             # Rust 入口
    └── main.rs            # 主函数
```

---

## 脚本命令

| 命令 | 说明 |
|------|------|
| npm run dev | Vite 前端开发服务器 |
| npm run build | 构建前端 |
| npm run tauri dev | Tauri 开发模式 |
| npm run tauri build | 构建 Tauri 应用 |

---

## 构建产物

| 平台 | 包 | 说明 |
|------|-----|------|
| Linux | .deb | Debian/Ubuntu 安装包 |
| Linux | .rpm | Fedora/RHEL 安装包 |
| macOS | .dmg | macOS 安装包（待实现） |
| Windows | .exe | Windows 安装包（待实现） |

---

## License

MIT © SakuraSmiles
