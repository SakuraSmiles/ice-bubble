/**
 * Task 类型定义
 *
 * Task 模块只存储任务数据，agent_id 只是字符串引用，不做外键约束。
 * Agent 信息的权威来源是 Admin 模块，前端通过分别调用 Task API 和 Admin API 合并渲染。
 */

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'collected';

/**
 * 任务优先级
 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * 任务类型
 */
export type TaskType = 'TODO' | 'LOOP' | 'SUBAGENT' | 'CRON';

/**
 * 任务记录
 */
export interface Task {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** 所属 agent ID（字符串引用，不做外键约束） */
  agent_id: string;
  /** 任务类型 */
  type: TaskType;
  /** 父任务 ID（无则为 null） */
  parent_id: string | null;
  /** 子任务 ID 列表 */
  children_ids: string[];
  /** 任务描述 */
  description: string;
  /** 循环任务目标（LOOP 类型使用） */
  loop_target: string | null;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
  /** 被谁终止（null 表示正常结束） */
  terminated_by: string | null;
  /** 幂等键 */
  idempotency_key?: string;
}

/**
 * 创建任务的输入（用于内部插入/更新）
 */
export interface TaskInsert {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  agent_id: string;
  type: TaskType;
  parent_id?: string | null;
  children_ids?: string[];
  description?: string;
  loop_target?: string | null;
  created_at: string;
  updated_at: string;
  terminated_by?: string | null;
  /** 幂等键，用于防止重复创建任务 */
  idempotency_key?: string;
}

/**
 * OpenClaw task-store.json 中的任务结构（原始格式）
 */
export interface OpenClawTaskSource {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  agent_id: string;
  type: TaskType;
  parent_id: string | null;
  children_ids: string[];
  description: string;
  loop_target: string | null;
  steps: unknown[];
  current_step: number;
  loop_count: number;
  created_at: string;
  updated_at: string;
  terminated_by: string | null;
}

/**
 * OpenClaw task-store.json 文件结构
 */
export interface OpenClawTaskStore {
  tasks: Record<string, OpenClawTaskSource>;
  counter: number;
  statusUpdates?: Record<string, StatusUpdate>;
}

/**
 * 任务状态变更记录
 */
export interface StatusUpdate {
  status: TaskStatus;
  updated_at: string;
}

/**
 * 采集结果
 */
export interface CollectResult {
  collected: number;
  updated: number;
  errors: string[];
}
