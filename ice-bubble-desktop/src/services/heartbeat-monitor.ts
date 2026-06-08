/**
 * heartbeat-monitor.ts — WebSocket 心跳检测
 *
 * - 每 pingInterval 发送一次应用层 ping
 * - 等待 pongTimeout 后判定丢失
 * - 连续 missedPongLimit 次丢失触发 onDead 回调
 * - 收到任何服务端消息时重置等待计时器
 */
import type { WebSocketManagerConfig } from '../types/connection'

type HeartbeatState = 'IDLE' | 'WAITING' | 'DEAD'

export interface HeartbeatMonitorCallbacks {
  /** 需要发送 ping 时调用 */
  onSendPing: () => void
  /** 连续丢失 pong 达到上限时调用 */
  onDead: () => void
}

export class HeartbeatMonitor {
  private config: Required<Pick<WebSocketManagerConfig,
    'pingInterval' | 'pongTimeout' | 'missedPongLimit'>>
  private callbacks: HeartbeatMonitorCallbacks

  private state: HeartbeatState = 'IDLE'
  private missedCount = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    config: Pick<WebSocketManagerConfig, 'pingInterval' | 'pongTimeout' | 'missedPongLimit'>,
    callbacks: HeartbeatMonitorCallbacks,
  ) {
    this.config = config as Required<typeof config>
    this.callbacks = callbacks
  }

  /** 连续丢失次数（供调试） */
  get missedPongs(): number {
    return this.missedCount
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this.pingTimer !== null
  }

  /**
   * 启动心跳
   * 应在连接成功后调用
   */
  start(): void {
    this.stop()
    this.state = 'IDLE'
    this.missedCount = 0

    // 立即发第一次 ping
    this.sendPing()

    // 定时发送
    this.pingTimer = setInterval(() => {
      if (this.state === 'WAITING') {
        // 上一次 pong 还没回来，先判定超时
        this.onPongTimeout()
      }
      if (this.state !== 'DEAD') {
        this.sendPing()
      }
    }, this.config.pingInterval)
  }

  /** 停止心跳 */
  stop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    this.state = 'IDLE'
    this.missedCount = 0
  }

  /**
   * 收到 pong 响应
   */
  onPong(): void {
    if (this.state !== 'WAITING') return
    this.clearPongTimer()
    this.state = 'IDLE'
    this.missedCount = 0
  }

  /**
   * 收到任何服务端消息时调用（重置 pong 等待计时器）
   * 表示连接仍然活跃
   */
  onMessageReceived(): void {
    if (this.state === 'WAITING') {
      // 收到消息说明连接活着，等同 pong
      this.clearPongTimer()
      this.state = 'IDLE'
      this.missedCount = 0
    }
  }

  /** 销毁 */
  destroy(): void {
    this.stop()
  }

  // ── 内部方法 ──

  private sendPing(): void {
    this.state = 'WAITING'
    this.callbacks.onSendPing()

    // 设置 pong 超时
    this.clearPongTimer()
    this.pongTimer = setTimeout(() => {
      this.onPongTimeout()
    }, this.config.pongTimeout)
  }

  private onPongTimeout(): void {
    if (this.state !== 'WAITING') return
    this.clearPongTimer()
    this.missedCount++

    if (this.missedCount >= this.config.missedPongLimit) {
      this.state = 'DEAD'
      this.callbacks.onDead()
    } else {
      // 还未到上限，等待下次 ping 周期再重试
      this.state = 'IDLE'
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }
}
