/**
 * message-queue.ts — WebSocket 断连期间的消息队列
 *
 * - 断连期间用户消息入队，重连成功后按序重发
 * - 每条消息有独立 Promise，调用方可感知成功/失败
 * - 队列满时丢弃最旧消息，消息超时自动丢弃
 */
import { ref, type Ref } from 'vue'
import type { QueueStatus } from '../types/connection'

/** 队列中的消息条目 */
export interface QueuedMessage {
  /** 唯一 ID */
  id: string
  /** Gateway 方法名 */
  method: string
  /** 请求参数 */
  params: Record<string, unknown>
  /** 入队时间戳 */
  timestamp: number
  /** 该条消息已重试次数 */
  retryCount: number
  /** 成功回调 */
  resolve: (value: unknown) => void
  /** 失败回调 */
  reject: (reason: Error) => void
}

/** MessageQueue 配置 */
export interface MessageQueueConfig {
  /** 队列最大长度，默认 50 */
  maxSize: number
  /** 单条消息最大存活时间（ms），默认 300000 (5分钟) */
  maxMessageAge: number
  /** 单条消息最大重试次数，默认 3 */
  maxMessageRetries: number
}

export class MessageQueue {
  private queue: QueuedMessage[] = []
  private config: Required<MessageQueueConfig>
  private expiryTimer: ReturnType<typeof setInterval> | null = null

  /** 队列状态（Vue 响应式） */
  readonly status: Ref<QueueStatus>

  constructor(config?: Partial<MessageQueueConfig>) {
    this.config = {
      maxSize: config?.maxSize ?? 50,
      maxMessageAge: config?.maxMessageAge ?? 300_000,
      maxMessageRetries: config?.maxMessageRetries ?? 3,
    }
    this.status = ref<QueueStatus>({
      size: 0,
      maxSize: this.config.maxSize,
      oldestMessageAge: 0,
    })
  }

  /**
   * 入队一条消息
   * @returns Promise — 重连成功发送后 resolve，失败/超时后 reject
   */
  enqueue(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const promise = new Promise<unknown>((resolve, reject) => {
      // 队列满时丢弃最旧消息
      if (this.queue.length >= this.config.maxSize) {
        const oldest = this.queue.shift()
        if (oldest) {
          oldest.reject(new Error('队列已满，丢弃最旧消息'))
          console.warn(`[MessageQueue] 队列满(${this.config.maxSize})，丢弃消息: ${oldest.method}`)
        }
      }

      this.queue.push({
        id,
        method,
        params,
        timestamp: Date.now(),
        retryCount: 0,
        resolve,
        reject,
      })
    })

    this.refreshStatus()
    return promise
  }

  /**
   * 出队一条消息（FIFO），返回消息条目
   * 队列空时返回 null
   */
  dequeue(): QueuedMessage | null {
    const msg = this.queue.shift() ?? null
    this.refreshStatus()
    return msg
  }

  /**
   * 将一条发送失败的消息重新放回队首（有限次）
   * @returns true 表示已重新入队，false 表示超过最大重试次数
   */
  requeue(msg: QueuedMessage): boolean {
    msg.retryCount++
    if (msg.retryCount > this.config.maxMessageRetries) {
      msg.reject(new Error(`消息重试 ${msg.retryCount - 1} 次后仍然失败: ${msg.method}`))
      return false
    }
    // 放回队首
    this.queue.unshift(msg)
    this.refreshStatus()
    return true
  }

  /** 清空队列，reject 所有待发送消息 */
  clear(reason = '连接已关闭'): void {
    for (const msg of this.queue) {
      msg.reject(new Error(reason))
    }
    this.queue = []
    this.refreshStatus()
  }

  /** 移除超时消息，reject 对应 Promise */
  purgeExpired(): void {
    const now = Date.now()
    const before = this.queue.length
    this.queue = this.queue.filter(msg => {
      const expired = now - msg.timestamp > this.config.maxMessageAge
      if (expired) {
        msg.reject(new Error(`消息已过期（${Math.round(this.config.maxMessageAge / 1000)}s 未发送）: ${msg.method}`))
      }
      return !expired
    })
    if (this.queue.length !== before) {
      this.refreshStatus()
    }
  }

  /** 启动过期检查定时器 */
  startExpiryCheck(intervalMs = 10_000): void {
    this.stopExpiryCheck()
    this.expiryTimer = setInterval(() => this.purgeExpired(), intervalMs)
  }

  /** 停止过期检查定时器 */
  stopExpiryCheck(): void {
    if (this.expiryTimer !== null) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  /** 刷新 Vue 响应式状态 */
  private refreshStatus(): void {
    const now = Date.now()
    this.status.value = {
      size: this.queue.length,
      maxSize: this.config.maxSize,
      oldestMessageAge: this.queue.length > 0
        ? now - this.queue[0].timestamp
        : 0,
    }
  }

  /** 销毁队列 */
  destroy(): void {
    this.clear('队列已销毁')
    this.stopExpiryCheck()
  }
}
