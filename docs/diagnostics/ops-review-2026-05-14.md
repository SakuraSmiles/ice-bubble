# 运维可操作性审查报告

**项目**: ice-bubble
**审查日期**: 2026-05-14
**审查人**: 运维小助手 (ops subagent)
**审查角度**: 部署可操作性、故障排查可验证性、文档与实现一致性

---

## 一、部署文档审查

### 1.1 WSL 部署指南（ice-bubble-collector-openclaw/docs/WSL部署指南.md）

#### 🔴 严重 — 引用不存在的文件

**位置**: 第 383 行

```bash
cp config/config.production.json.example config/config.production.json
```

**问题**: `config/config.production.json.example` 文件不存在。实际文件是 `config/config.production.json`（无 `.example` 后缀）。

**影响**: 运维人员按文档操作会失败，不知道该用哪个文件作为生产配置模板。

**修复建议**: 将命令改为 `cp config/config.production.json config/config.production.json` 或直接说明用 `config.production.json`。

---

#### 🔴 严重 — 引用不存在的文档

**位置**: WSL部署指南.md 末尾"相关文档"节

```markdown
- [快速开始指南](./快速开始.md)
```

**问题**: `./快速开始.md` 文件不存在于 `ice-bubble-collector-openclaw/docs/` 目录。

**影响**: 运维人员点击链接得到 404，增加困惑。

**修复建议**: 删除该链接，或确认文件是否存在。

---

#### 🟡 中等 — PM2 日志轮转说明不完整

**位置**: WSL部署指南.md "日志轮转"节

**问题**: logrotate 配置中指定了日志路径 `/home/dabai/ice-bubble/...`，但如果用户按"推荐"把项目放在 `~/ice-bubble/`，实际路径是 `/home/dabai/ice-bubble/ice-bubble-collector-openclaw/logs/*.log`，与 logrotate 配置不一致。

**影响**: logrotate 可能找不到日志文件，磁盘最终被撑满。

**修复建议**: 在 logrotate 配置中使用通配模式或动态路径说明。

---

#### 🟡 中等 — 路径建议与 logrotate 配置不一致

**位置**: WSL部署指南.md

**问题**: 文档"推荐"将项目放在 `~/ice-bubble/`（即 `/home/dabai/ice-bubble/`），但 PM2 和 logrotate 配置都隐含了更深一层的路径结构 `ice-bubble/ice-bubble-collector-openclaw/`。

**影响**: 新人按"推荐"复制项目后，路径会多一层，导致 PM2 进程找不着、logrotate 失效。

**修复建议**: 统一路径规范，或在每个工具的配置段落中明确说明当前假定的项目根路径。

---

### 1.2 主 README.md

#### 🟡 中等 — 依赖启动顺序说明缺少验证方法

**位置**: README.md "启动依赖顺序"节

**问题**: 说明了 collector → admin → desktop 的启动顺序，但没有说明如何**验证**每一层"已就绪"。

**影响**: 运维人员不知道启动后要确认什么指标才算成功。

**修复建议**: 每步加一行验证命令，例如：
```bash
# 验证 collector 就绪
curl http://localhost:13100/api/meta/status | jq '.status'
# 期望: "running"
```

---

### 1.3 ice-bubble-desktop README.md

#### 🟡 中等 — Tauri 环境准备缺少系统依赖具体命令

**位置**: ice-bubble-desktop/README.md "安装系统依赖（Linux）"节

```bash
sudo apt-get install pkg-config libgtk-3-dev
sudo apt-get install libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
sudo apt-get install libwebkit2gtk-4.1-dev
```

**问题**: 这些包名在某些 Ubuntu 版本（如 24.04、Debian sid）可能有变化，或需要额外的 `libwebkit2gtk-6.0-dev`（Tauri 2.0 新版）。文档没有说明如何确认安装成功。

**影响**: Linux 新人可能在桌面环境依赖上卡住，不知道是包名错了还是缺了别的。

**修复建议**: 增加验证步骤：`dpkg -l | grep webkit2gtk`，并提供非 Ubuntu 发行版的参考。

---

## 二、运维文档审查

### 2.1 systemd service 文件缺失

#### 🔴 严重

**问题**: WSL 部署指南的生产部署节提到 PM2 管理进程，但文档中散布着"systemctl"相关概念（监控服务状态）。实际上**项目中没有任何 `.service` 文件**。

**影响**: 在生产 Linux 环境中，没有 systemd unit 文件就无法用 systemctl 管理服务；用 PM2 则缺少与系统启动的集成（除非额外配置 pm2 服务）。

**修复建议**: 提供标准的 systemd unit 文件模板，例如：
```
/etc/systemd/system/ice-bubble-collector.service
```
至少应包含 `collector`、`admin`、`desktop` 三个服务。

---

### 2.2 备份与恢复文档缺失

#### 🔴 严重

**问题**: 配置文件中出现了 `backup` 配置项（cron 表达式、保留天数、备份路径），但**没有任何文档说明**：
- 备份实际执行什么操作（只备份 SQLite？还是包括配置文件？）
- 备份文件是什么格式（.tar.gz？.sql？）
- 如何手动触发一次备份
- 如何从备份恢复
- 数据目录（`data/`）是否需要包含在备份范围内

**影响**: 发生数据丢失时运维人员不知道有哪些数据需要保护、恢复流程是什么。

**修复建议**: 编写 `docs/备份与恢复.md`，至少包含：备份范围说明、手动备份脚本示例、恢复步骤、从备份恢复后如何重启服务。

---

### 2.3 数据库维护文档缺失

#### 🟡 中等

**问题**: 配置文件中有 `cleanup` 项（数据保留天数），SQLite 有 WAL 模式，但没有文档说明：
- 如何手动 VACUUM（当 WAL 文件过大时）
- `cleanup.retentionDays` 的实际行为（哪些表被清理？清理频率？）
- 如何安全地重置同步偏移量（重新同步 collector 数据）

**影响**: 数据库可能随时间膨胀，WAL 文件占用大量磁盘空间，运维人员无法诊断。

**修复建议**: 在"运维文档"中增加数据库维护节，说明 VACUUM 命令执行时机、WAL 文件大小监控。

---

### 2.4 数据迁移文档缺失

#### 🟡 中等

**问题**: 没有任何文档说明：
- 如何将 collector 从一台机器迁移到另一台
- 如何在不停机情况下切换 OpenClaw 数据目录
- collector 和 admin 的数据库是否可以分别迁移

**影响**: 生产环境需要迁移或扩容时，运维人员无文档可依。

---

## 三、API 文档审查

### 3.1 /api/meta/status — version 字段与实现不符

#### 🟡 中等

**文档位置**: ice-bubble-collector-openclaw/docs/API.md

**文档写的是**:
```json
"version": "1.0.0"
```

**实际响应**（已验证）:
```json
"version": "1.1.1"
```

**原因**: 代码从 `package.json` 动态读取版本号，文档写的是静态值未同步。

**影响**: 依赖版本号做兼容性判断的系统会出错。

**修复建议**: 将文档中的 `"version": "1.0.0"` 改为 `"version": "动态读取自 package.json"` 或直接注明"以实际响应为准"。

---

### 3.2 /api/meta/config — 响应格式与文档严重不符

#### 🔴 严重

**文档写的响应结构**:
```json
{
  "config": {
    "watchPath": "/home/user/.openclaw/agents",
    "dbPath": "/path/to/collector.db",
    "batchSize": 50,
    ...
  }
}
```

**实际响应**（已 curl 验证）:
```json
{
  "watchPath": "/home/dabai/.openclaw/agents",
  "scanInterval": 5000,
  "batchSize": 20,
  "flushInterval": 5000,
  "dbPath": "/home/dabai/.local/share/ice-bubble/data/collector-dev.db",
  "enabledDedup": true,
  "enabledValidation": true,
  "incrementalEnabled": true,
  "incrementalStatePath": "/mnt/d/workspace/ice-bubble/data/file-state.json",
  "collectionMode": "FILE_ONLY",
  "watchEnabled": true
}
```

**差异点**:
1. 文档将响应包装在 `config` 对象中，实际是扁平 JSON
2. 文档缺少大量字段：`scanInterval`, `flushInterval`, `enabledDedup`, `enabledValidation`, `incrementalEnabled`, `incrementalStatePath`, `collectionMode`, `watchEnabled`
3. `batchSize` 文档说 50，实际运行时是 20（说明运行时配置与示例配置不同，但这本身没问题，问题在于文档没有说明实际值从配置读取）

**影响**: 调用方如果按文档解析响应会得到 `undefined` 所有字段，导致配置展示功能完全失效。

**修复建议**: 按实际响应重新编写文档响应示例。

---

### 3.3 /api/data/sessions — 文档缺少多个实际返回字段

#### 🟡 中等

**文档列出字段**: `session_key`, `agent_id`, `channel`, `account_id`, `peer_id`, `guild_id`, `created_at`, `updated_at`, `message_count`, `last_message_at`

**实际额外返回字段**（已 curl 验证）:
- `label`
- `status`
- `model`
- `model_provider`
- `spawned_by`
- `spawn_depth`

**影响**: 调用方无法获知这些字段含义，不知道是否需要处理。

**修复建议**: 将这些字段补入 API.md 响应示例和字段说明表。

---

### 3.4 /api/data/messages — 文档缺少 cost 字段

#### 🟡 中等

**文档列出字段**: `id`, `session_key`, `message_type`, `content`, `model`, `tokens_input`, `tokens_output`, `tools_json`, `timestamp`, `created_at`

**实际额外返回字段**（已 curl 验证）:
- `cost_total`
- `cost_input`
- `cost_output`

**影响**: 如果调用方按文档字段做类型映射，这些字段会被忽略；后续如果需要按成本分析消息，字段不可见。

**修复建议**: 将 `cost_*` 字段补入 API.md。

---

### 3.5 admin API 认证说明与实际不符

#### 🟡 中等

**问题**: collector API.md "安全说明"称"无认证机制"，但实际 admin 的 `/api/data/stats` 等端点需要 Bearer Token（已在运行时验证：未提供 token 时返回 `{"error":"未提供认证令牌","code":"UNAUTHORIZED"}`）。

**影响**: 运维人员按 collector API 文档理解"无认证"，直接上手调用 admin 接口时会被 401 卡住。

**修复建议**: 在 admin README.md 和 collector API.md 的安全说明中明确：collector HTTP API 无认证，admin API 需要 Bearer Token（见 admin 配置中的 `auth.token`）。

---

## 四、FileCollector 使用指南审查

### 4.1 TypeScript 接口与实际 collector 配置的映射关系不清

#### 🟡 中等

**问题**: `FileCollector使用指南.md` 展示了 `FileCollectorConfig` 接口，包含 `openclawDataDir`、`enableWatch` 等字段。但这个接口是**直接实例化 FileCollector 类**时使用的，与 `config.json` 中的配置结构不同：
- `config.json` 用 `openclaw.dataDir`
- `FileCollectorConfig` 用 `openclawDataDir`（camelCase）

**影响**: 如果运维人员想通过理解 config.json 来理解 FileCollector 的工作原理，会产生混淆——不知道这两个是否对应、是否可以混用。

**修复建议**: 在文档中明确说明"配置文件路径（`openclaw.dataDir`）与直接实例化 FileCollector 时传入的选项（`openclawDataDir`）的对应关系"。

---

## 五、缺失的必要运维文档

| 文档 | 严重度 | 说明 |
|------|--------|------|
| systemd service/unit 文件 | 🔴 严重 | 项目没有任何 .service 文件 |
| 备份与恢复操作指南 | 🔴 严重 | 配置了 backup 但无操作文档 |
| 数据迁移/迁移步骤 | 🟡 中等 | 扩容/迁移场景无文档 |
| 数据库维护手册 | 🟡 中等 | VACUUM、WAL 清理无说明 |
| 故障排查手册（troubleshooting） | 🟡 中等 | 现有 FAQ 过于简单，无系统性排查路径 |

---

## 六、综合评价

### 可操作性评分：★★★☆☆（3/5）

| 维度 | 评分 | 说明 |
|------|------|------|
| 依赖前置说明 | ★★★★☆ | Node.js 版本、系统包基本列清 |
| 启动步骤连贯性 | ★★★☆☆ | 有顺序但无验证方法 |
| 故障排查覆盖 | ★★☆☆☆ | FAQ 很少，无系统性排查路径 |
| API 文档准确性 | ★★☆☆☆ | 多个端点格式与实现严重不符 |
| 运维持久化操作 | ★★☆☆☆ | 无 backup/restore/migration 文档 |

### 最需优先修复的问题（按影响排序）

1. **API.md `/api/meta/config` 响应格式完全错误** — 会导致调用方功能失效
2. **systemd service 文件缺失** — 生产环境无法用 systemctl 管理
3. **备份恢复文档缺失** — 数据无保护
4. **API.md 多处字段缺失/错误** — 影响系统集成可靠性
5. **WSL 部署指南引用不存在文件** — 新人部署第一步就失败
