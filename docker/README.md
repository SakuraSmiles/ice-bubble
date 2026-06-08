# Ice Bubble Docker

Docker 容器化部署配置，用于替代 WSL2 上的 systemd 服务。

## 架构

| 服务 | Docker 临时端口 | 正式端口 | 说明 |
|------|--------------|---------|------|
| OpenClaw Gateway | 18790 | 18789 | AI 网关（含 Chromium + Docker CLI） |
| Ice Bubble Admin | 13001 | 13000 | 管理后台 |
| Collector OpenClaw | 13110 | 13100 | 数据采集（OpenClaw） |
| Collector OpenCode | 13111 | 13101 | 数据采集（OpenCode） |
| OpenDesign | 7457 | 7456 | AI 设计工具 |

> Desktop 前端不迁移，继续在 Windows 上通过 Vite 运行。

## 快速开始

### 1. 初始化配置

```bash
cd docker

# 环境变量（API keys 等）
cp .env.example .env
# 编辑 .env 填入真实值

# 服务配置文件
cp configs/admin-config.json.template configs/admin-config.json
cp configs/collector-openclaw-config.json.template configs/collector-openclaw-config.json
# 编辑 config 文件，替换 <GENERATE_A_SECURE_TOKEN> 等占位符
```

### 2. 构建与启动

```bash
docker compose build
docker compose up -d
```

### 3. 验证

```bash
bash verify.sh
```

## 部署模式

### 临时端口验证（当前）

Docker 使用临时端口，与 WSL systemd 服务并行运行，互不影响。

### 正式切换

验证通过后：
1. 停止 WSL systemd 服务
2. 修改 `docker-compose.yml` 中端口映射为正式端口
3. `docker compose up -d` 重新启动

## 目录结构

```
docker/
├── docker-compose.yml          # 服务编排
├── .env.example                # 环境变量模板（提交到 git）
├── .env                        # 实际环境变量（⚠️ 不提交）
├── verify.sh                   # 验证脚本
├── configs/
│   ├── README.md
│   ├── *.json.template         # 配置模板（提交到 git）
│   └── *.json                  # 实际配置（⚠️ 不提交）
└── dockerfiles/
    ├── openclaw-gateway/
    ├── ice-bubble-admin/
    ├── ice-bubble-collector-openclaw/
    ├── ice-bubble-collector-opencode/
    └── ice-bubble-opendesign/
```

## 注意事项

- OpenClaw 容器需要 `docker` 组权限来操作 Docker socket
- 所有容器通过 `ice-bubble-net` bridge 网络互联，服务间使用容器名访问
- Admin 和 Collector 使用 bind mount 模式（直接挂载源码，无需构建）
- OpenClaw 和 OpenDesign 使用多阶段构建（镜像内编译）
