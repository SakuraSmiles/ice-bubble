# Task Manager Skill 安装指南

## 安装步骤

### 1. 复制 Skill 到 OpenClaw

```bash
# 复制整个 task-manager 目录
cp -r task-manager ~/.openclaw/workspace/skills/

# 或使用软链接（方便更新）
ln -s $(pwd)/task-manager ~/.openclaw/workspace/skills/task-manager
```

### 2. 初始化任务存储目录

```bash
# 创建任务存储目录
mkdir -p ~/.openclaw/workspace/tasks

# 复制默认存储文件（可选，首次运行会自动创建）
# cp task-store.json ~/.openclaw/workspace/tasks/
```

### 3. 重启 OpenClaw

```bash
openclaw gateway restart
```

### 4. 验证安装

在 OpenClaw 对话中输入：
```
创建一个 TODO 测试任务
```

如果 skill 正常工作，会创建任务并返回任务 ID。

---

## 目录结构

```
~/.openclaw/workspace/
├── skills/
│   └── task-manager/     # ← 复制到这里
│       ├── SKILL.md
│       ├── scripts/
│       │   └── task.py
│       └── INSTALL.md
└── tasks/
    └── task-store.json   # ← 任务持久化存储（自动创建）
```

---

## 卸载

```bash
rm -rf ~/.openclaw/workspace/skills/task-manager
```

---

## 更新

如果上游有更新，只需重新复制：

```bash
rm -rf ~/.openclaw/workspace/skills/task-manager
cp -r task-manager ~/.openclaw/workspace/skills/
openclaw gateway restart
```

---

## 依赖

- Python 3.8+（用于 task.py 脚本）
- OpenClaw 最新版本

---

## 故障排除

### Skill 没有触发

1. 检查文件是否正确放置：
   ```bash
   ls ~/.openclaw/workspace/skills/task-manager/
   ```

2. 检查 OpenClaw 是否正常加载 skill
3. 重启 OpenClaw

### task.py 报错

确保 Python 版本 >= 3.8：
```bash
python3 --version
```

---

如有问题，请提交 Issue 或联系开发者。