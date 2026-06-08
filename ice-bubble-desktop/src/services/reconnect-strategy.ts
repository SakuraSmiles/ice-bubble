/**
 * reconnect-strategy.ts — WebSocket 重连策略（指数退避 + 抖动）
 */
import type { WebSocketManagerConfig } from '../types/connection'

export class ReconnectStrategy {
  private attempt = 0
  private config: Required<Pick<WebSocketManagerConfig,
    'initialDelay' | 'maxDelay' | 'backoffFactor' | 'maxRetries' | 'jitter'>>

  constructor(config: Pick<WebSocketManagerConfig,
    'initialDelay' | 'maxDelay' | 'backoffFactor' | 'maxRetries' | 'jitter'>) {
    this.config = config as Required<typeof config>
  }

  /** 当前重试次数 */
  get currentAttempt(): number {
    return this.attempt
  }

  /** 是否已达最大重试次数 */
  get exhausted(): boolean {
    return this.attempt >= this.config.maxRetries
  }

  /** 最大重试次数 */
  get maxRetries(): number {
    return this.config.maxRetries
  }

  /**
   * 计算下次重连的延迟时间（含抖动）
   * @returns 延迟毫秒数；如果已耗尽重试次数返回 -1
   */
  nextDelay(): number {
    if (this.exhausted) return -1

    const base = Math.min(
      this.config.initialDelay * Math.pow(this.config.backoffFactor, this.attempt),
      this.config.maxDelay,
    )

    // 施加 ±jitter% 的随机抖动
    const jitterRange = base * this.config.jitter
    const jitter = (Math.random() * 2 - 1) * jitterRange // [-jitter, +jitter]
    return Math.max(0, Math.round(base + jitter))
  }

  /** 记录一次重连尝试，返回下次延迟 */
  recordAttempt(): number {
    this.attempt++
    return this.nextDelay()
  }

  /** 重置重连计数器 */
  reset(): void {
    this.attempt = 0
  }

  /** 销毁 */
  destroy(): void {
    this.attempt = 0
  }
}
