---
name: task-manager
description: |
  任务管理技能，处理所有与任务相关的事项，包括：任务派发、任务创建、任务分配、任务跟踪、TODO 管理、任务进度、父子任务、大任务拆分、多 Agent 协作、链式任务、循环任务、任务队列、工作流、派发任务给 dev/ops/tester、创建 TODO、查看任务状态、完成任务、阻塞任务、循环监控任务。
  
  触发关键词（任意一个或多个即触发）：
  - "任务"、"派发"、"分配"、"创建任务"、"TODO"、"待办"
  - "拆分成"、"拆分任务"、"子任务"、"父子任务"
  - "链式"、"循环"、"持续"、"监控"、"一直执行"
  - "完成了吗"、"进度"、"状态"、"还有哪些任务"
  - "dev"、"tester"、"ops"、"派给"、"分配给"
  - "stop"、"停止循环"、"终止任务"
---

# Task Manager

# Task Manager

## 核心设计原则

1. **简单通用** - 一句话概括任务
2. **持久化** - 任务状态存储在文件中，支持多轮交互
3. **可追溯** - 每个任务有唯一 ID
4. **进度可见** - 父子任务自动聚合进度

## 任务文件

任务数据存储在：`~/.openclaw/workspace/tasks/task-store.json`

```json
{
  "tasks": {
    "TASK-001": {
      "id": "TASK-001",
      "title": "修复 Token 显示问题",
      "status": "pending",
      "priority": "high",
      "agent_id": "dev",
      "created_at": "2026-04-22T22:00:00Z",
      "updated_at": "2026-04-22T22:00:00Z",
      "parent_id": null,
      "children_ids": [],
      "type": "TODO",
      "description": "详细描述..."
    }
  },
  "counter": 1
}
```

## 任务格式

### 单个任务
```
[TODO] 一句话任务描述
  ID: TASK-001
  负责人: dev
  优先级: high
```

### 父子任务
```
[PARENT] 大任务描述
  ID: TASK-002
  负责人: dev
  
  [TODO] 子任务1
    ID: TASK-003
    负责人: dev
    
  [TODO] 子任务2
    ID: TASK-004
    负责人: tester
```

### 链式任务（顺序执行）
```
[CHAIN] 流程名称
  ID: TASK-005
  步骤1 → 步骤2 → 步骤3
```

### 循环任务（持续运行）
```
[LOOP] 循环任务名称
  ID: TASK-006
  步骤1 → 步骤2 → [GOTO 步骤1]
  终止: stop / exit
```

## 状态定义

| 状态 | 标记 | 说明 |
|------|------|------|
| pending | 📋 | 待处理 |
| in_progress | 🔄 | 进行中 |
| review | 👀 | 待验收 |
| completed | ✅ | 已完成 |
| blocked | 🚫 | 已阻塞 |
| terminated | ⏹ | 已终止（手动） |
| loop_stopped | ⏹ | 循环已停止 |

## 优先级

| 优先级 | 标记 | 说明 |
|--------|------|------|
| urgent | 🔴 | 紧急 |
| high | 🟡 | 重要 |
| medium | 🔵 | 一般 |
| low | 🟢 | 常规 |

## 常用命令

### 创建任务
```typescript
// 单任务
create_task("修复 Token 显示问题", {
  agent_id: "dev",
  priority: "high",
  type: "TODO"
})

// 父子任务
create_task("重构模块", {
  agent_id: "dev",
  type: "PARENT",
  children: [
    { title: "步骤1", agent_id: "dev" },
    { title: "步骤2", agent_id: "dev" }
  ]
})

// 循环任务
create_task("监控服务", {
  agent_id: "ops",
  type: "LOOP",
  steps: ["检查状态", "分析结果", "发送报告"],
  loop_target: "检查状态"
})
```

### 查看任务
```typescript
// 列出所有任务
list_tasks()

// 查看特定任务
get_task("TASK-001")

// 按状态筛选
list_tasks({ status: "in_progress" })

// 按负责人筛选
list_tasks({ agent_id: "dev" })
```

### 更新任务
```typescript
// 更新状态
update_task("TASK-001", { status: "completed" })

// 标记完成
done_task("TASK-001")

// 阻塞任务
block_task("TASK-001", "缺少依赖")
```

### 循环控制
```typescript
// 停止循环任务
stop_loop("TASK-006")

// 暂停循环
pause_loop("TASK-006")

// 恢复循环
resume_loop("TASK-006")
```

## 进度计算

父子任务自动计算进度：
```
[PARENT] 重构项目 (进度: 2/5 = 40%)
  ├── [TODO] 步骤1 ✅
  ├── [TODO] 步骤2 ✅
  ├── [TODO] 步骤3 🔄 进行中
  ├── [TODO] 步骤4 📋 待处理
  └── [TODO] 步骤5 📋 待处理
```

## 任务派发示例

### 单任务派发
```
[TODO] 修复 Overview.vue Token 显示问题
  ID: TASK-20260422-001
  负责人: dev
  优先级: 🔴
  项目: ice-bubble-desktop
  
  验收标准:
  1. Token 统计正常显示
  2. 构建无报错
  3. 页面刷新数据正确
```

### 批量拆分派发
```
[PARENT] 代码质量修复
  ID: TASK-20260422-002
  负责人: dev（主负责）
  
  [TODO] 修复 ChatPanel 类型错误
    ID: TASK-20260422-003
    负责人: dev
    
  [TODO] 清理死代码
    ID: TASK-20260422-004
    负责人: dev
    
  [TODO] 验证修复结果
    ID: TASK-20260422-005
    负责人: tester
```

### 循环任务派发
```
[LOOP] 每分钟健康检查
  ID: TASK-20260422-006
  负责人: ops
  
  [TODO] 检查 Collector 端口
  [TODO] 检查 Admin API
  [TODO] 检查数据库连接
  [TODO] 记录异常
  [GOTO] 检查 Collector 端口
  
  终止条件: 用户输入 "stop"
```

## 循环任务终止

用户可通过以下方式终止 `[LOOP]` 任务：
- `stop` - 立即停止
- `exit` - 停止并记录终止原因
- `pause <id>` - 暂停特定循环任务
- `resume <id>` - 恢复暂停的任务

## 简洁示例

### 日常任务
```
[TODO] 修复 Token API
  ID: TASK-001
  负责人: dev
  🔴
```

### 链式工作流
```
[CHAIN] 部署流程
  build → test → deploy → verify
  负责人: dev
```

### 自动化循环
```
[LOOP] 持续监控
  check → alert → log → check
  终止: stop
```

## 最佳实践

1. **任务标题** - 一句话说清楚，不要超过50字
2. **及时更新** - 状态变化时立即更新
3. **分解任务** - 大任务拆分成小任务，便于跟踪
4. **明确负责人** - 每个任务指定明确的 Agent
5. **设置截止** - 重要任务设置时间限制
6. **记录异常** - 遇到问题及时记录原因

## 与其他 Agent 协作

### 给 dev 派发
```
[TODO] 开发新功能
  负责人: dev
  优先级: 🟡
  验收标准: ...
```

### 给 tester 派发
```
[TODO] 测试验证
  负责人: tester
  依赖: TASK-001（完成后自动开始）
```

### 给 ops 派发
```
[LOOP] 系统监控
  负责人: ops
  终止: stop
```

## 文件结构

```
~/.openclaw/workspace/
└── tasks/
    └── task-store.json    # 任务持久化存储
```

## 状态同步

- 每次任务操作后自动保存到 task-store.json
- 重启后任务状态不丢失
- 支持多轮交互的长期任务跟踪