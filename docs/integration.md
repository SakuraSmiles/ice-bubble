# ice-bubble 模块接入规范

> 最近更新：2026-04-23

---

## Agent 状态字段规范

### 必填字段

- `status`: string，标准化枚举 (active/idle/offline)

### 可选字段

- `task_enhancement`: TaskEnhancement 对象
  - `status`: 'working' | 'idle'
  - `pending_count`: number
  - `source`: 'available' | 'unavailable' | 'none'

### 状态标准化映射

| 原始值 | 标准值 |
|--------|--------|
| 活跃/active | active |
| 空闲/idle | idle |
| 离线/offline | offline |
| null | offline |
