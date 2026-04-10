<div align="center">

<h1>ice-bubble-topdesk</h1>

[![Tauri](https://img.shields.io/badge/tauri-2.0-brightgreen)](https://tauri.app/)
[![Vue.js](https://img.shields.io/badge/vue-3.5-blue)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.5-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repo](https://img.shields.io/badge/GitHub-100000?style=flat-square&logo=github&logoColor=white)](https://github.com/SakuraSmiles/ice-bubble)


> @ice-bubble/topdesk  
> ice-bubble 桌面端展示应用 — 调用 admin API 进行数据可视化

</div>

---

## 项目简介

`@ice-bubble/topdesk` 是 ice-bubble 微服务系统的桌面端展示模块，负责：
1. **数据展示**：通过 admin API 获取并展示系统数据
2. **模块监控**：实时监控各模块运行状态
3. **会话浏览**：查看会话列表和消息详情

### 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2.0 | Rust 后端 + Web 前端 |
| 前端框架 | Vue 3.5 | Composition API |
| 语言 | TypeScript 5.5 | 严格模式 |
| 构建工具 | Vite 6.0 | 快速构建 |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     ice-bubble-topdesk                      │
│                    (桌面应用窗口)                            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐      │
│  │   Overview  │  │  Modules    │  │   Sessions      │     │
│  │   概览页面   │  │  模块管理    │  │   会话记录       │      │
│  └─────────────┘  └─────────────┘  └─────────────────┘      │
│                          │                                   │
│                    HTTP Client                               │
└──────────────────────────┼───────────────────────────────────┘
                           │
                           │ HTTP API (13000)
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                    ice-bubble-admin                          │
│                       (端口 13000)                            │
└──────────────────────────┼───────────────────────────────────┘
                           │
                           │ HTTP API (13100)
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                ice-bubble-collector-openclaw                 │
│                       (端口 13100)                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 环境要求

- Node.js 18+
- Rust 1.70+
- Tauri CLI

### 安装系统依赖（Linux）

```bash
sudo apt-get install pkg-config libgtk-3-dev
sudo apt-get install libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
sudo apt-get install libwebkit2gtk-4.1-dev
```

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run tauri dev
```

### 构建

```bash
# 构建前端
npm run build

# 构建 Tauri 应用
npm run tauri build
```

---

## 配置说明

### Tauri 配置

配置文件位于 `src-tauri/tauri.conf.json`：

```json
{
  "productName": "ice-bubble-topdesk",
  "version": "1.0.0",
  "build": {
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "title": "ice-bubble-topdesk",
      "width": 1200,
      "height": 800
    }]
  }
}
```

### Admin API 地址

在代码中配置 `src/config.ts`：

```typescript
export const ADMIN_API_BASE = 'http://localhost:13000';
```

---

## 页面功能

| 页面 | 路径 | 功能 |
|------|------|------|
| 概览 | / | 系统统计、模块状态 |
| 模块管理 | /modules | 查看各模块运行状态 |
| 会话记录 | /sessions | 会话列表和详情 |

---

## API 调用

topdesk 通过 admin 模块获取数据：

| API | 说明 |
|-----|------|
| GET /api/data/stats | 统计汇总 |
| GET /api/data/sessions | 会话列表 |
| GET /api/data/messages | 消息列表 |
| GET /api/modules | 模块列表 |
| GET /api/modules/:key/status | 模块状态 |

---

## 项目结构

```
src/
├── main.ts                 # Vue 入口
├── App.vue                 # 根组件
├── config.ts              # 配置
├── api/
│   └── admin.ts           # Admin API 调用
├── views/
│   ├── Overview.vue       # 概览页
│   ├── Modules.vue        # 模块管理页
│   └── Sessions.vue       # 会话记录页
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
| npm run dev | Vite 开发服务器 |
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
