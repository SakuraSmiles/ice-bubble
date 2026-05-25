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
│  │     概览页面      │  │    模块管理      │  │   会话（多平台）  │      │
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
│                   │      (端口 13000)       │
                    └───────────┬─────────────┘
                                │
                     ┌──────────┼──────────────┐
                     │ HTTP API │ HTTP API      │
                     ▼          ▼              │
          ┌──────────────┐ ┌──────────────┐   │
          │  collector    │ │  collector    │   │
          │  openclaw     │ │  opencode     │   │
          │  (13100)      │ │  (13101)      │   │
          └──────────────┘ └──────────────┘   │
```

### 端口说明

| 模块 | 端口 | 说明 |
|------|------|------|
| desktop 前端 | 1420 | Vite Dev Server（开发）/ Tauri 窗口（生产） |
| admin | 13000 | 管理 API |
| collector (openclaw) | 13100 | OpenClaw 数据采集 API |
| collector (opencode) | 13101 | OpenCode 数据采集 API |

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

### Tauri 开发/生产模式

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
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ice-bubble-desktop",
  "version": "1.5.1",
  "identifier": "com.icebubble.desktop",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "title": "ice-bubble-desktop",
      "width": 1200,
      "height": 800,
      "resizable": true,
      "fullscreen": false,
      "minWidth": 800,
      "minHeight": 600
    }],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ]
  }
}
```

### Admin API 地址

Desktop 通过 Setup 页面（`/setup`）动态配置 Admin API 地址和 Auth Token，使用 Tauri Store 或 localStorage 持久化，不依赖代码中的硬编码配置。

---

## 页面功能

| 页面 | 路径 | 功能 |
|------|------|------|
| 初始设置 | /setup | 配置 Admin 地址和 Auth Token |
| 概览 | / | 系统统计、模块状态 |
| 模块管理 | /modules | 查看各模块运行状态 |
| 成员列表 | /agents | Agent 列表和状态 |
| 全部会话 | /sessions | 所有会话列表（支持 OpenClaw / OpenCode 平台区分） |
| 任务管理 | /tasks | 任务列表和管理 |
| 聊天 | /chat | 聊天界面（嵌套在工作区 Layout 中，实际加载 Workspace.vue） |
| 工作区 | /workspace/:key | 单个 Agent 的工作区视图 |
| 系统设置 | /settings | 系统设置页面 |
| 日志查看 | /logs | 日志查看页面 |

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
| GET | /api/agents | admin | 成员列表（支持 OpenClaw / OpenCode 平台标识） |
| GET | /api/agents/with-activity | admin | 带活跃数据的成员列表 |
| GET | /api/agents/token-summary | admin | Token 统计汇总 |
| GET | /api/subagent-tasks | admin | 任务列表 |
| GET | /api/sessions/unified | admin | 统一会话列表（结合 Gateway 实时状态） |
| GET/POST/PATCH/DELETE | /api/session-groups | admin | 会话分组管理 |
| GET/PUT | /api/session-preferences | admin | 会话偏好设置 |
| PUT | /api/sessions/summary | admin | 更新会话摘要 |
| WS | /ws | admin | Gateway WebSocket 实时通信 |

---

## 项目结构

```
src/
├── main.ts                 # Vue 入口
├── App.vue                 # 根组件
├── version.ts              # 版本信息
├── vite-env.d.ts           # Vite 类型声明
├── config/
│   └── index.ts           # 统一配置
├── api/
│   ├── client.ts          # API 调用封装
│   ├── client.test.ts     # API 客户端测试
│   └── chat.ts            # Chat API 封装
├── composables/
│   ├── useGitStatus.ts    # Git 状态 Hook
│   ├── useLogger.ts       # 日志 Hook
│   └── useNow.ts          # 实时时间 Hook
├── views/
│   ├── useChat.ts          # Chat 组合式函数
│   ├── Layout.vue          # 主布局组件
│   ├── Overview.vue        # 概览页
│   ├── Modules.vue         # 模块管理页
│   ├── AllSessions.vue     # 全部会话页（非 Sessions.vue）
│   ├── Agents.vue          # 成员列表页
│   ├── Tasks.vue           # 任务管理页
│   ├── Workspace.vue       # 工作区页（也用于 /chat 路由）
│   ├── Setup.vue           # 初始设置页
│   ├── Settings.vue        # 系统设置页
│   ├── Logs.vue            # 日志查看页
│   ├── NotFound.vue        # 404 页面
│   └── components/         # 视图级子组件
│       ├── AgentTaskTree.vue
│       ├── AgentTodoList.vue
│       ├── ChatTimeline.vue
│       ├── LoadingSkeleton.vue
│       ├── MessageBubble.vue
│       ├── MessageInput.vue
│       ├── NewChatDialog.vue
│       ├── ParentTaskProgress.vue
│       ├── RecentSessions.vue
│       ├── SessionList.vue
│       ├── SessionSelector.vue
│       ├── SessionTimeline.vue
│       ├── StatusDropdown.vue
│       ├── SubSessionList.vue
│       ├── SystemHealth.vue
│       ├── TaskList.vue
│       └── chat/            # Chat 相关组件
│           ├── MessageBubble.vue
│           ├── ToolCallBadge.vue
│           ├── media-parser.ts
│           ├── session-cache.ts
│           ├── types.ts
│           ├── useChatData.ts
│           └── useGatewayStream.ts
├── stores/
│   ├── chatStore.ts        # 聊天状态管理
│   ├── chat-input.ts       # 聊天输入状态
│   ├── sessionGroupStore.ts      # 会话分组状态
│   ├── sessionPreferencesStore.ts  # 会话偏好状态
│   └── workspaceStore.ts   # 工作区状态
├── services/
│   └── gateway-client.ts   # Gateway WebSocket 客户端
├── components/             # 全局共享组件
│   ├── AddWorkspaceDialog.vue
│   ├── AppFooter.vue
│   ├── ChatPanel.vue
│   ├── ConnectionAlert.vue
│   ├── EmptyState.vue
│   ├── FileTree.vue
│   ├── GlobalSearch.vue
│   ├── MarkdownContent.vue
│   ├── PageHeader.vue
│   ├── SessionList.vue
│   ├── VirtualScroller.vue
│   └── WorkspacePanel.vue
├── utils/
│   ├── adminConnection.ts  # Admin 连接检测
│   ├── adminConnection.test.ts
│   ├── format.ts           # 格式化工具
│   ├── markdown.ts         # Markdown 工具
│   ├── monitor.ts          # 服务监控
│   └── validators.ts       # 校验工具
└── assets/                 # 静态资源
    ├── fonts.css
    ├── interactions.css
    └── fonts/               # 字体文件
        ├── Eurostile-ExtendedTwo.otf
        ├── Exo2-Regular.woff2
        ├── Montserrat-Regular.woff2
        ├── NotoSansSC-Regular.woff2
        └── Orbitron-Regular.woff2

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

## 多平台支持

Desktop 现在支持展示来自两个平台的会话数据：

| 平台 | Channel 标识 | 数据来源 | 说明 |
|------|-------------|---------|------|
| **OpenClaw** | discord / telegram / local / ... | collector-openclaw (13100) | OpenClaw Agent 的对话数据 |
| **OpenCode** | `opencode` | collector-opencode (13101) | OpenCode 的本地开发会话 |

### 平台区分

- 会话列表和 Agent 列表均包含平台标识，方便区分数据来源
- 聊天界面的消息气泡支持根据平台类型显示不同的视觉标识
- 概览页的统计数据汇总了两个平台的数据

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
