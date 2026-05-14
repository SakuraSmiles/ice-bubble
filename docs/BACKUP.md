# 数据备份与恢复

> 最近更新：2026-05-14

---

## 概述

本文档说明 ice-bubble 各模块的数据备份与恢复方法，包括数据库、配置文件和原始会话文件。

---

## 需要备份的文件

### Collector 数据目录

Collector 的 SQLite 数据库和增量状态文件位于：

```
~/.local/share/ice-bubble/data/
├── collector-dev.db          # SQLite 数据库（会话、消息、统计数据）
├── file-state.json          # FileCollector 增量采集状态
└── admin.db                 # Admin 模块数据库（头像等）
```

### 配置文件

| 模块 | 配置文件路径 |
|------|-------------|
| Collector | `ice-bubble-collector-openclaw/config/config.development.json` |
| Collector | `ice-bubble-collector-openclaw/config/config.production.json` |
| Admin | `ice-bubble-admin/config/config.json` |

### OpenClaw 原始会话文件

FileCollector 监听的数据源目录：

```
~/.openclaw/agents/<agentId>/sessions/
├── session-xxx.jsonl
└── session-yyy.jsonl
```

> **注意**：这是 OpenClaw 的原始数据，通常不需要单独备份（由 OpenClaw 自己管理），但如果需要完整恢复，建议一并备份。

---

## 备份命令

### 全量备份脚本

```bash
#!/bin/bash
# backup-ice-bubble.sh

BACKUP_DIR="$HOME/ice-bubble-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 备份 Collector 数据目录
cp -r ~/.local/share/ice-bubble/data/ "$BACKUP_DIR/ice-bubble-data/"

# 备份配置文件
cp ice-bubble-collector-openclaw/config/config.development.json "$BACKUP_DIR/" 2>/dev/null
cp ice-bubble-collector-openclaw/config/config.production.json "$BACKUP_DIR/" 2>/dev/null
cp ice-bubble-admin/config/config.json "$BACKUP_DIR/" 2>/dev/null

# 备份 OpenClaw 原始会话文件（可选，体积可能较大）
cp -r ~/.openclaw/agents/ "$BACKUP_DIR/openclaw-agents/" 2>/dev/null

# 创建压缩包
cd "$BACKUP_DIR/.."
tar -czf "ice-bubble-backup-$(date +%Y%m%d-%H%M%S).tar.gz" "$(basename "$BACKUP_DIR")"

echo "备份完成：$BACKUP_DIR"
```

### 分模块备份

```bash
# 备份 Collector SQLite 数据库
cp ~/.local/share/ice-bubble/data/collector-dev.db ~/ice-bubble-backup-$(date +%Y%m%d).db

# 备份 FileCollector 增量状态
cp ~/.local/share/ice-bubble/data/file-state.json ~/ice-bubble-file-state-$(date +%Y%m%d).json

# 备份 Admin 数据库
cp ~/.local/share/ice-bubble/data/admin.db ~/ice-bubble-admin-backup-$(date +%Y%m%d).db
```

---

## 恢复步骤

### 1. 停止服务

```bash
# 使用 systemd 管理
systemctl --user stop ice-bubble-admin.service
systemctl --user stop ice-bubble-collector.service

# 或使用 PM2
pm2 stop all
```

### 2. 恢复数据库

```bash
# 恢复 Collector 数据库
cp <备份目录>/ice-bubble-data/collector-dev.db ~/.local/share/ice-bubble/data/collector-dev.db

# 恢复 Admin 数据库
cp <备份目录>/ice-bubble-data/admin.db ~/.local/share/ice-bubble/data/admin.db

# 恢复 FileCollector 增量状态（可选）
cp <备份目录>/ice-bubble-data/file-state.json ~/.local/share/ice-bubble/data/file-state.json
```

### 3. 恢复配置文件

```bash
cp <备份文件>/config.development.json ice-bubble-collector-openclaw/config/config.development.json
cp <备份文件>/config.production.json ice-bubble-collector-openclaw/config/config.production.json
cp <备份文件>/config.json ice-bubble-admin/config/config.json
```

### 4. 恢复 OpenClaw 原始会话（可选）

```bash
# 如果需要从备份恢复原始会话文件
cp -r <备份目录>/openclaw-agents/* ~/.openclaw/agents/
```

### 5. 重启服务

```bash
# 使用 systemd 管理
systemctl --user start ice-bubble-collector.service
systemctl --user start ice-bubble-admin.service

# 或使用 PM2
pm2 restart all
```

---

## 定时自动备份

### cron 任务示例

每天凌晨 3 点执行全量备份：

```bash
# 编辑 crontab
crontab -e

# 添加以下行：
0 3 * * * $HOME/backup-ice-bubble.sh >> $HOME/backup-ice-bubble.log 2>&1
```

### 备份轮转

建议保留最近 7 天的每日备份，使用以下脚本清理旧备份：

```bash
#!/bin/bash
# cleanup-old-backups.sh

BACKUP_DIR="$HOME/ice-bubble-backups"
find "$BACKUP_DIR" -name "ice-bubble-backup-*.tar.gz" -mtime +7 -delete
find "$BACKUP_DIR" -type d -name "2*" -mtime +7 -exec rm -rf {} + 2>/dev/null

echo "清理完成"
```

---

## 验证备份完整性

恢复前，建议验证备份文件的完整性：

```bash
# 检查压缩包
tar -tzf ice-bubble-backup-20260514.tar.gz | head

# 检查数据库
sqlite3 collector-dev.db "SELECT COUNT(*) FROM sessions;"
sqlite3 collector-dev.db "SELECT COUNT(*) FROM messages;"
```

---

## 数据目录汇总

| 用途 | 路径 |
|------|------|
| Collector 数据库 | `~/.local/share/ice-bubble/data/collector-dev.db` |
| Admin 数据库 | `~/.local/share/ice-bubble/data/admin.db` |
| FileCollector 状态 | `~/.local/share/ice-bubble/data/file-state.json`（可选，首次运行前可能不存在） |
| 用户头像目录 | `~/.local/share/ice-bubble/data/avatars/` |
| OpenClaw 数据根目录 | `~/.openclaw/` |

---

## 注意事项

1. **备份时停止写入**：建议在停止服务后进行备份，以保证数据一致性
2. **压缩包体积**：OpenClaw 原始会话文件可能较大，酌情选择是否包含在备份中
3. **数据库路径**：以上路径为默认路径，实际路径由各模块的配置文件中的 `ADMIN_DB_PATH`、`dbPath` 等字段决定，请对照检查
4. **跨平台注意**：数据目录位于 Linux/WSL/macOS 的用户目录下，Windows 原生环境不可直接访问

---

**版本**: 1.0.0
**最后更新**: 2026-05-14
