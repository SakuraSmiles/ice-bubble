# Ice Bubble Skills

这里是 Ice Bubble 项目的 OpenClaw Skills 集合。

## 可用 Skills

| Skill | 说明 | 状态 |
|-------|------|------|
| [task-manager](./task-manager/) | 任务管理：派发、跟踪、链式任务、循环任务 | ✅ 可用 |

## 安装说明

详见各 skill 目录下的 `INSTALL.md`。

## 添加新的 Skill

1. 在本目录创建 skill 子目录
2. 包含 `SKILL.md` 主文件
3. 添加 `INSTALL.md` 安装说明
4. 可选：`scripts/` 目录存放工具脚本

---

## task-manager 简介

简洁通用的 OpenClaw 任务管理技能：

- ✅ 任务 ID 持久化
- ✅ 父子任务拆分
- ✅ 链式/循环任务
- ✅ 多 Agent 协作支持
- ✅ 进度跟踪

详见 [task-manager](./task-manager/) 目录。