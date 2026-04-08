# WSL 部署指南

本文档说明如何在 WSL (Windows Subsystem for Linux) 环境中部署和运行 ice-bubble-collector-openclaw 模块。

---

## 📋 前置要求

### 1. WSL 环境

确保已安装 WSL2 并运行 Ubuntu 发行版：

```bash
# 检查 WSL 版本
wsl -l -v

# 预期输出：
#   NAME              STATE           VERSION
# * Ubuntu            Running         2
```

### 2. Node.js 环境

在 WSL 中安装 Node.js 18+：

```bash
# 方法 1: 使用 nvm (推荐)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18

# 方法 2: 使用 NodeSource
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version   # v18.x.x
npm --version    # 8.x.x 或更高
```

### 3. 构建工具

安装编译 native 模块所需的工具：

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3
```

---

## 🚀 快速开始

### 1. 进入项目目录

```bash
# 从 Windows 路径访问
cd /mnt/d/workspace/ice-bubble/ice-bubble-collector-openclaw

# 或者从 WSL 家目录访问（推荐先复制一份）
# cp -r /mnt/d/workspace/ice-bubble ~/ice-bubble
# cd ~/ice-bubble/ice-bubble-collector-openclaw
```

### 2. 安装依赖

```bash
npm install
```

**注意**：`better-sqlite3` 需要编译，首次安装可能需要几分钟。

### 3. 编译 TypeScript

```bash
npm run build
```

### 4. 创建数据目录

```bash
# 在项目上一级创建 data 目录
mkdir -p ../data
```

### 5. 验证配置

```bash
# 查看配置文件
cat config/config.development.json

# 关键配置项：
# - openclaw.dataDir: "/home/dabai/.openclaw"
# - collection.file.watchPath: "/home/dabai/.openclaw/agents"
# - storage.sqlite.dbPath: "../data/collector-dev.db"
```

### 6. 启动服务

```bash
# 开发模式（带热重载）
npm run dev

# 生产模式
npm start
```

---

## 📂 目录结构

### 项目在 WSL 中的推荐路径

```
~/ice-bubble/                              # WSL 家目录下的项目根目录
├── data/                                  # 数据存储目录
│   └── collector-dev.db                   # SQLite 数据库
└── ice-bubble-collector-openclaw/         # 模块目录
    ├── config/
    │   └── config.development.json        # 开发环境配置
    ├── src/                               # 源代码
    ├── dist/                              # 编译输出
    ├── node_modules/                      # 依赖
    └── package.json
```

### OpenClaw 数据目录

```
/home/dabai/.openclaw/                     # OpenClaw 根目录
├── agents/                                # Agent 数据目录（FileCollector 监听此目录）
│   ├── <agentId-1>/
│   │   └── sessions/
│   │       ├── session-1.jsonl
│   │       └── session-2.jsonl
│   └── <agentId-2>/
│       └── sessions/
└── openclaw.json                          # OpenClaw 主配置
```

---

## 🔧 配置说明

### config/config.development.json

```json
{
  "openclaw": {
    "dataDir": "/home/dabai/.openclaw",
    "gateway": {
      "enabled": false,
      "url": "wss://localhost:18789",
      "token": "",
      "reconnect": {
        "enabled": true,
        "interval": 5000,
        "maxAttempts": 10
      }
    },
    "api": {
      "enabled": false,
      "baseUrl": "http://localhost:18789",
      "token": ""
    }
  },
  "storage": {
    "sqlite": {
      "dbPath": "../data/collector-dev.db",
      "walMode": true,
      "busyTimeout": 5000
    },
    "redis": {
      "enabled": false,
      "url": "redis://localhost:6379",
      "keyPrefix": "openclaw:dev:"
    }
  },
  "collection": {
    "mode": "FILE_ONLY",
    "file": {
      "watchPath": "/home/dabai/.openclaw/agents",
      "enableWatch": true,
      "incremental": true,
      "batchSize": 50,
      "batchTimeout": 3000
    }
  },
  "processing": {
    "validator": {
      "enabled": true,
      "strictMode": false
    },
    "deduplicator": {
      "enabled": true,
      "cacheSize": 5000,
      "ttl": 3600000
    },
    "batchWriter": {
      "batchSize": 50,
      "batchTimeout": 3000,
      "maxRetries": 3
    }
  },
  "api": {
    "enabled": false,
    "port": 3000,
    "host": "localhost",
    "cors": {
      "enabled": true,
      "origins": ["http://localhost:3000"]
    }
  },
  "logging": {
    "level": "debug",
    "format": "pretty",
    "outputs": [
      {
        "type": "console",
        "colorize": true
      },
      {
        "type": "file",
        "path": "./logs/collector-dev.log",
        "maxSize": 10485760,
        "maxFiles": 3
      }
    ]
  },
  "monitoring": {
    "enabled": true,
    "metrics": {
      "enabled": true,
      "interval": 60000
    },
    "healthCheck": {
      "enabled": true,
      "interval": 30000
    }
  },
  "backup": {
    "enabled": false,
    "interval": "0 3 * * *",
    "retention": 7,
    "path": "./backups"
  }
}
```

### 关键配置项说明

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `openclaw.dataDir` | `/home/dabai/.openclaw` | OpenClaw 根目录（Linux 路径） |
| `collection.file.watchPath` | `/home/dabai/.openclaw/agents` | 文件监听路径（Linux 路径） |
| `storage.sqlite.dbPath` | `../data/collector-dev.db` | SQLite 数据库路径（相对路径） |
| `collection.mode` | `FILE_ONLY` | 仅文件采集模式 |
| `collection.file.enableWatch` | `true` | 启用实时文件监听 |

---

## 🧪 测试验证

### 1. 运行单元测试

```bash
npx vitest run
```

### 2. 运行集成测试

```bash
npx vitest run tests/integration
```

### 3. 运行手动测试

```bash
npm test
```

### 4. 验证数据采集

```bash
# 启动服务
npm run dev

# 在另一个终端查看日志
tail -f logs/collector-dev.log

# 检查数据库
sqlite3 ../data/collector-dev.db "SELECT COUNT(*) FROM sessions;"
sqlite3 ../data/collector-dev.db "SELECT COUNT(*) FROM messages;"
```

---

## 🔍 常见问题

### 1. better-sqlite3 编译失败

**问题**：`npm install` 时 `better-sqlite3` 编译失败

**解决方案**：
```bash
# 安装编译工具
sudo apt-get install -y build-essential python3

# 清除缓存重新安装
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### 2. 文件监听不工作

**问题**：FileCollector 无法监听到文件变化

**解决方案**：
```bash
# 检查 inotify 限制
cat /proc/sys/fs/inotify/max_user_watches

# 如果限制太低，增加限制
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### 3. 权限问题

**问题**：无法访问 OpenClaw 数据目录

**解决方案**：
```bash
# 检查目录权限
ls -la /home/dabai/.openclaw

# 如果权限不足，修改权限
chmod 755 /home/dabai/.openclaw
chmod 755 /home/dabai/.openclaw/agents
```

### 4. 路径问题

**问题**：找不到数据库文件

**解决方案**：
```bash
# 使用绝对路径替代相对路径
# 修改 config.development.json:
# "dbPath": "/home/dabai/ice-bubble/data/collector-dev.db"
```

---

## 🚀 生产环境部署

### 1. 使用 PM2 管理进程

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动服务
pm2 start dist/start.js --name collector-openclaw

# 查看状态
pm2 status

# 查看日志
pm2 logs collector-openclaw

# 设置开机自启
pm2 startup
pm2 save
```

### 2. 配置生产环境

```bash
# 复制生产环境配置
cp config/config.production.json.example config/config.production.json

# 编辑生产环境配置
vim config/config.production.json

# 启动生产环境
NODE_ENV=production npm start
```

### 3. 日志轮转

```bash
# 安装 logrotate
sudo apt-get install logrotate

# 创建日志轮转配置
sudo tee /etc/logrotate.d/collector-openclaw <<EOF
/home/dabai/ice-bubble/ice-bubble-collector-openclaw/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 dabai dabai
}
EOF
```

---

## 📊 性能优化

### 1. 数据库优化

```bash
# 定期执行 VACUUM
sqlite3 ../data/collector-dev.db "VACUUM;"

# 分析数据库
sqlite3 ../data/collector-dev.db "ANALYZE;"
```

### 2. 内存优化

```bash
# 限制 Node.js 内存使用
NODE_OPTIONS="--max-old-space-size=512" npm start
```

### 3. 文件监听优化

```bash
# 调整 inotify 参数
echo fs.inotify.max_user_instances=512 | sudo tee -a /etc/sysctl.conf
echo fs.inotify.max_queued_events=16384 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

## 🔄 开发工作流

### 使用 VS Code Remote - WSL

1. 安装 VS Code 扩展：`Remote - WSL`
2. 在 WSL 中打开项目：
   ```bash
   cd ~/ice-bubble/ice-bubble-collector-openclaw
   code .
   ```
3. VS Code 会自动连接到 WSL 环境

### 热重载开发

```bash
# 启动开发模式（自动重载）
npm run dev
```

### 调试模式

```bash
# 启用 Node.js 调试
NODE_OPTIONS="--inspect-brk" npm run dev
```

---

## 📝 维护命令

```bash
# 查看服务状态
pm2 status

# 重启服务
pm2 restart collector-openclaw

# 停止服务
pm2 stop collector-openclaw

# 查看日志
pm2 logs collector-openclaw

# 清理日志
pm2 flush

# 监控
pm2 monit
```

---

## 🔗 相关文档

- [快速开始指南](./快速开始.md)
- [配置说明](./配置说明.md)
- [架构设计](./dev/架构设计.md)
- [FileCollector 使用指南](./FileCollector使用指南.md)
- [测试指南](./测试指南.md)

---

## 💡 提示

1. **性能优先**：在 WSL 中运行比在 Windows 中运行性能更好
2. **路径一致**：使用 Linux 路径格式，避免路径转换问题
3. **实时监听**：WSL 支持文件监听，可以实时采集数据
4. **开发便利**：使用 VS Code Remote - WSL 可以获得完整的开发体验

---

**最后更新**: 2026-04-08
