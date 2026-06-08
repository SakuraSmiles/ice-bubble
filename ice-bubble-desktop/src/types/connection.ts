/**
 * connection.ts — WebSocket 连接管理相关类型定义
 */

/** 连接状态枚举 */
export type ConnectionState =
  | 'IDLE'          // 初始状态，未尝试连接
  | 'CONNECTING'    // 正在建立 WebSocket 连接
  | 'CONNECTED'     // 已连接并通过认证
  | 'RECONNECTING'  // 自动重连中
  | 'FAILED'        // 重连次数耗尽，等待用户操作
  | 'DISCONNECTED'  // 用户主动断开

/** 重连信息 */
export interface RetryInfo {
  /** 当前重试次数（从 1 开始） */
  attempt: number
  /** 最大重试次数 */
  maxRetries: number
  /** 下次重连还需等待的毫秒数 */
  nextRetryIn: number
  /** 上次重连尝试的时间戳 */
  lastAttemptAt: number
}

/** 消息队列状态 */
export interface QueueStatus {
  /** 当前队列中的消息数 */
  size: number
  /** 队列最大容量 */
  maxSize: number
  /** 队列中最旧消息的存活时间（ms），队列空时为 0 */
  oldestMessageAge: number
}

/** WebSocketManager 配置 */
export interface WebSocketManagerConfig {
  // ── 重连策略 ──
  /** 初始重连延迟（ms），默认 1000 */
  initialDelay: number
  /** 最大重连延迟（ms），默认 30000 */
  maxDelay: number
  /** 退避因子，默认 2 */
  backoffFactor: number
  /** 最大重试次数，默认 20 */
  maxRetries: number
  /** 抖动比例（±），默认 0.2 即 ±20% */
  jitter: number

  // ── 心跳检测 ──
  /** ping 间隔（ms），默认 15000 */
  pingInterval: number
  /** 等待 pong 超时（ms），默认 10000 */
  pongTimeout: number
  /** 连续丢失 pong 上限，默认 2 */
  missedPongLimit: number

  // ── 消息队列 ──
  /** 队列最大长度，默认 50 */
  queueMaxSize: number
  /** 单条消息最大存活时间（ms），默认 300000 (5分钟) */
  queueMaxMessageAge: number

  // ── 连接 ──
  /** 连接超时（ms），默认 10000 */
  connectTimeout: number
}

/** WebSocketManager 默认配置 */
export const DEFAULT_WS_MANAGER_CONFIG: WebSocketManagerConfig = {
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxRetries: 20,
  jitter: 0.2,

  pingInterval: 15000,
  pongTimeout: 10000,
  missedPongLimit: 2,

  queueMaxSize: 50,
  queueMaxMessageAge: 300_000,

  connectTimeout: 10000,
}
