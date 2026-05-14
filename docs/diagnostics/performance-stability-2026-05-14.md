# Ice Bubble 性能与稳定性诊断报告

> 日期：2026-05-14
> 概述：内存分析、数据库健康检查、API 响应时间、启动稳定性全覆盖，发现 Collector 重启后 crash loop（构建不同步）和旧 DB 损坏两大紧急问题。

**日期:** 2026-05-14 22:44–22:55 CST  
**诊断人:** 开发程序猿 (subagent)

---

## 一、内存分析

### 1.1 当前状态（重启后）

| 服务 | PID | RSS | Peak | 备注 |
|------|-----|-----|------|------|
| Admin | 23544 | 128MB | — | 重启后 5min |
| Collector | 23789 | 292MB | 418MB | 重启后 5min, CPU 31%（初始扫描） |
| Gateway | 4650 | 1.2GB | — | 非本项目 |

### 1.2 发现

**🔴 严重 — Collector peak memory 曾达 2.1GB（重启前旧进程 PID 377）**

- 旧进程 systemd 显示 `Memory: 311.5M (peak: 2.1G)` — 这意味着 Collector 曾消耗 2.1GB 峰值内存
- 当前重启后稳定在 ~292MB，初始扫描期间 peak 418MB
- Collector 监听 **40 个 agent 目录**（含大量历史 agent），有 **1698 个 .jsonl 文件**需要监听

**🟡 中等 — Admin 内存合理**

- 重启后 128MB，运行中约 185MB。对于一个聚合查询服务来说合理
- 未发现 OOM 相关日志

**🟡 中等 — Collector watcher 数量偏多**

- 监听 37 个 agent 的 sessions 目录（部分是废弃的历史 agent）
- 建议添加 agent 过滤/白名单配置，避免监听无用的 `test-*`、`arch-*` 等

### 1.3 修复建议

- **短期:** 为 Collector 添加 `agentFilter` 或 `ignoredAgents` 配置，跳过不活跃的 agent 目录
- **中期:** 监控 Collector 内存趋势，设置内存告警阈值（如 >500MB 告警）
- **长期:** 调查 2.1GB peak 的根因（可能是全量扫描时的大 JSON 解析）

---

## 二、数据库健康检查

### 2.1 活跃数据库（.local 路径）

| 数据库 | 路径 | 大小 | Integrity | 状态 |
|--------|------|------|-----------|------|
| admin.db | ~/.local/share/ice-bubble/data/admin.db | 55MB | ✅ ok | 健康 |
| collector-dev.db | ~/.local/share/ice-bubble/data/collector-dev.db | 250MB | ✅ ok | 健康 |
| collector-dev.db-wal | 同上 | 4MB | — | WAL 正常 |

### 2.2 旧数据库（workspace 路径）

| 数据库 | 路径 | 大小 | Integrity | 状态 |
|--------|------|------|-----------|------|
| admin.db | /mnt/d/workspace/ice-bubble/data/admin.db | 84MB | ✅ ok | 已废弃（未在使用） |
| collector-dev.db | /mnt/d/workspace/ice-bubble/data/collector-dev.db | 228MB | ❌ 损坏 | 大量 btree 损坏 |
| collector-dev.db.corrupted.* | 同上 | — | — | 5/1 的损坏备份 |

### 2.3 活跃数据库表行数

**admin.db:**

| 表名 | 行数 |
|------|------|
| admin_messages | 36,906 |
| admin_tool_calls | 8,104 |
| admin_messages_archive | 5,239 |
| admin_model_events | 7,761 |
| admin_sessions | 3,561 |
| admin_agents | 10 |

**collector-dev.db:**

| 表名 | 行数 |
|------|------|
| session_messages | 80,191 |
| session_messages_archive | 20,320 |
| session_events | 7,761 |
| sessions | 3,561 |
| agents | 10 |
| collection_logs | 0 |
| tools | 0 |

### 2.4 索引检查

**admin.db:** 38 个索引，覆盖所有查询字段 ✅  
**collector-dev.db:** 19 个索引，覆盖所有查询字段 ✅

### 2.5 碎片率

- **admin.db:** 0%（无碎片，无 freelist）
- **collector-dev.db:** WAL 模式运行中，4MB WAL 文件，正常

### 2.6 空文件清理

| 文件 | 大小 | 建议 |
|------|------|------|
| data/admin-dev.db | 0B | ✅ 可删除 |
| data/collector-optimized.db | 0B | ✅ 可删除 |
| data/collector.db | 0B | ✅ 可删除 |
| ice-bubble-collector-openclaw/data/collector.db | 0B | ✅ 可删除 |
| data/collector-dev.db.corrupted.* (×3) | ~456MB | ✅ 可删除（已损坏旧数据） |
| data/admin.db (workspace) | 84MB | ✅ 可删除（旧数据，已被 .local 替代） |
| data/collector-dev.db (workspace) | 228MB | ⚠️ 损坏，可删除 |

**清理后可释放约 ~815MB 磁盘空间**

### 2.7 发现

**🔴 严重 — workspace 下的 collector-dev.db 严重损坏**

- `PRAGMA integrity_check` 返回 100+ 条错误
- `session_messages` 和 `session_messages_archive` 表完全不可读
- B-tree 结构大面积损坏（page 引用错误、rowid 乱序）
- 但这不影响运行 — 活跃 DB 在 `~/.local/share/ice-bubble/data/` 下
- 已有 `.corrupted.20260501` 备份，说明 5/1 就曾发生过损坏

**🟡 中等 — 两个位置存在重复数据库**

- 活跃路径: `~/.local/share/ice-bubble/data/`
- 旧路径: `/mnt/d/workspace/ice-bubble/data/`（workspace 路径下的 DB 不再被使用）
- 旧路径下有损坏的 DB 和损坏备份，占用约 730MB

### 2.8 修复建议

- **立即:** 删除 workspace 下的旧/损坏/空 DB 文件
- **短期:** 清理无用的 `test-*` agent 目录（约 10 个），减少 Collector 监听负担
- **中期:** 添加数据库健康检查 cron（每小时 `PRAGMA integrity_check`）
- **中期:** 添加 Collector 启动时的 DB integrity check，损坏时自动告警

---

## 三、API 响应时间

所有端点均在正常范围内。

### Admin (localhost:13000)

| 端点 | Run 1 | Run 2 | Run 3 | 平均 | 评级 |
|------|-------|-------|-------|------|------|
| GET /health | 3.0ms | 1.9ms | 1.8ms | **2.2ms** | ✅ 优秀 |
| GET /api/stats | 1.6ms | 2.0ms | 2.1ms | **1.9ms** | ✅ 优秀 |
| GET /api/agents | 1.6ms | 1.8ms | 1.7ms | **1.7ms** | ✅ 优秀 |
| GET /api/sessions?limit=50 | 1.6ms | 1.7ms | 2.1ms | **1.8ms** | ✅ 优秀 |
| GET /api/messages/timeline?limit=20 | 2.0ms | 1.8ms | 1.9ms | **1.9ms** | ✅ 优秀 |

### Collector (localhost:13100)

| 端点 | Run 1 | Run 2 | Run 3 | 平均 | 评级 |
|------|-------|-------|-------|------|------|
| GET /api/meta/status | 4.0ms | 2.8ms | 3.9ms | **3.6ms** | ✅ 优秀 |
| GET /api/data/stats | 2.3ms | 1.8ms | 2.0ms | **2.0ms** | ✅ 优秀 |
| GET /api/data/sessions?limit=50 | 2.7ms | 2.6ms | 3.0ms | **2.8ms** | ✅ 优秀 |

**结论: 所有端点响应时间 <5ms，无需优化。** 当前数据量（~3.6k sessions, ~80k messages）下查询性能极好。

---

## 四、启动/停止稳定性

### 4.1 Admin 重启

| 步骤 | 结果 |
|------|------|
| systemctl restart | ✅ 成功 |
| 5s 后状态 | ✅ active (running) |
| /health 响应 | ✅ 200, 4ms |
| 启动耗时 | ~2s（从进程启动到服务可用） |
| 首次同步 | 135ms 完成（89 sessions, 2037 messages, 367 events） |
| 日志异常 | ✅ 无异常 |

### 4.2 Collector 重启

| 步骤 | 结果 |
|------|------|
| systemctl restart | ⚠️ 首次失败 |
| 5s 后状态 | ❌ crash loop（exit-code） |
| 错误信息 | `exports is not defined in ES module scope` |
| 根因 | **代码修改后未重新编译** — `package.json` 改为 `"type": "module"` 但 `dist/` 仍是旧 CJS 输出 |
| 手动 `npm run build` 后 | ✅ 正常启动 |
| 初始扫描耗时 | ~22s（全量扫描 1698 个文件） |
| /api/meta/status | ✅ 200, 4ms（扫描完成后） |
| 内存 | 292MB（peak 418MB） |

### 4.3 发现

**🔴 严重 — Collector 构建不同步导致无法重启**

- commit `6297d2d` 在 5/1 左右将 `package.json` 添加了 `"type": "module"`
- 但 `dist/` 目录未重新编译，仍是 CJS 输出（`"use strict"` + `exports.xxx`）
- 旧进程（PID 377）从 5/1 一直运行到今天未重启，所以问题未暴露
- 一旦服务重启就会 crash loop
- **systemd `Restart=always` 会不断尝试重启**，产生大量错误日志

**🟡 中等 — Collector 初始扫描较慢（~22s）**

- 扫描 40 个 agent 目录的 1698 个文件
- 扫描期间 API 返回 502（服务未就绪）
- 扫描期间 CPU 31%

### 4.4 修复建议

- **立即:** 确保 CI/CD 或 pre-push hook 中包含 `npm run build`，防止编译不同步
- **短期:** 添加 systemd `ExecStartPre=/usr/bin/npm run build --prefix /mnt/d/workspace/ice-bubble/ice-bubble-collector-openclaw`
- **短期:** Collector 初始扫描期间返回 503（Service Unavailable）而非 502（Bad Gateway），更准确地表示服务正在启动
- **中期:** 考虑增量扫描优化，跳过长时间未修改的 agent 目录

---

## 五、错误恢复测试

### 5.1 Collector 不可达场景

| 步骤 | Admin 行为 |
|------|-----------|
| Collector 停止后 | ✅ DataSync 报 ERROR（`fetch failed`），但 Admin 继续运行 |
| ModuleScheduler 检测 | ✅ 将 collector-openclaw 标记为 `status: error` |
| DataSync | ✅ 单次同步失败后继续等待下次周期 |
| Collector 恢复后 | ✅ 下次同步周期自动恢复，status 回到 `running` |
| 恢复后首次同步 | ✅ 135ms 完成 |

### 5.2 systemd Restart 策略

| 服务 | Restart | RestartSec | TimeoutStopSec |
|------|---------|------------|----------------|
| Admin | always | 5s | 30s |
| Collector | always | 5s | 30s |

**结论: 错误恢复机制工作正常。** Admin 优雅处理 Collector 不可达，不会崩溃或挂起。Collector 恢复后自动重连。

### 5.3 改进建议

- **短期:** DataSync 失败日志中缺少具体错误信息（只有 `{"error":{}}`），建议记录完整的 error.message
- **短期:** 考虑在 Admin 日志中区分 "Collector 不可达" 和 "Collector 返回错误" 两种场景

---

## 六、同步延迟分析

### 6.1 数据流

```
OpenClaw (file write)
    ↓ 实时（FileWatcher）
Collector (file read + parse + DB write)
    ↓ 周期性（~60s）
Admin (sync from Collector API → admin.db）
```

### 6.2 延迟数据

| 环节 | 延迟 | 数据来源 |
|------|------|---------|
| OpenClaw → Collector（FileWatcher） | 实时（秒级） | 日志时间戳对比 |
| Collector → Admin（Sync） | ~60s 周期 | sync_progress 表 |
| Admin Sync 耗时 | 131–135ms | 日志 "Sync completed in Xms" |
| Collector 全量扫描 | ~22s | 仅重启时 |

### 6.3 发现

- **同步延迟可接受:** OpenClaw 文件变更 → Collector 实时感知 → Admin 最多 60s 拉取
- **Admin 同步高效:** 2000+ 消息同步仅需 135ms（增量模式）
- **无队列积压:** Collector 的 `messagesCollected` 在重启前后一致（462,936 vs 467,961，差异为重启期间新产生的消息）

---

## 七、问题汇总

### 🔴 严重（需立即处理）

| # | 问题 | 影响 | 修复建议 |
|---|------|------|---------|
| 1 | Collector 构建不同步，重启后 crash loop | 服务不可恢复 | 确保 build 步骤在部署/重启前执行 |
| 2 | workspace 下 collector-dev.db 严重损坏 | 不影响运行，但占用 228MB | 删除旧 DB 文件 |

### 🟡 中等（建议近期处理）

| # | 问题 | 影响 | 修复建议 |
|---|------|------|---------|
| 3 | Collector peak memory 2.1GB（历史） | 可能 OOM | 添加内存监控和 agent 过滤 |
| 4 | Collector 监听 40 个 agent 目录 | 浪费内存和 inotify | 添加 agent 白名单/黑名单 |
| 5 | workspace 下旧 DB 文件占用 ~815MB | 浪费磁盘 | 清理空文件和旧 DB |
| 6 | Collector 初始扫描 22s + 返回 502 | 重启窗口期不可用 | 改为 503 + 优化扫描 |

### 🟢 轻微（可择机处理）

| # | 问题 | 影响 | 修复建议 |
|---|------|------|---------|
| 7 | DataSync 失败日志缺少具体错误信息 | 排查不便 | 记录完整 error |
| 8 | 无数据库健康检查机制 | 损坏无法及时发现 | 添加周期性 integrity check |

---

## 八、总体评估

| 维度 | 评分 | 说明 |
|------|------|------|
| API 性能 | ⭐⭐⭐⭐⭐ | 所有端点 <5ms |
| 启动稳定性 | ⭐⭐⭐ | Admin 正常，Collector 有构建不同步问题 |
| 错误恢复 | ⭐⭐⭐⭐ | 优雅降级，自动恢复 |
| 数据库健康 | ⭐⭐⭐ | 活跃 DB 健康，旧 DB 需清理 |
| 内存管理 | ⭐⭐⭐ | 正常运行合理，peak 偏高 |
| 同步延迟 | ⭐⭐⭐⭐ | 秒级感知，分钟级同步 |

**一句话总结:** 服务运行时表现优秀（API 快、错误恢复好），但运维层面存在问题（构建不同步导致 Collector 无法重启、旧数据库堆积）。
