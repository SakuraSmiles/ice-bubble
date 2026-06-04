/**
 * websocket-manager.ts — WebSocket 连接管理器
 *
 * 状态机 + 重连策略 + 消息队列 + 心跳检测
 * 供 Vue 组件通过 provide/inject 或直接引用使用
 */
import { ref, type Ref } from 'vue'
import { GatewayClient } from './gateway-client'
import { ReconnectStrategy } from './reconnect-strategy'
import { MessageQueue } from './message-queue'
import { HeartbeatMonitor } from './heartbeat-monitor'
import type {
  ConnectionState,
  RetryInfo,
  QueueStatus,
  WebSocketManagerConfig,
} from '../types/connection'
import { DEFAULT_WS_MANAGER_CONFIG } from '../types/connection'

/** 事件回调类型 */
type EventCallback = (...args: unknown[]) => void

export class WebSocketManager {
  // ── 响应式状态（供 Vue 组件直接绑定）──
  readonly state: Ref<ConnectionState> = ref('IDLE')
  readonly retryInfo: Ref<RetryInfo | null> = ref(null)
  readonly queueStatus: Ref<QueueStatus> = ref({
    size: 0,
    maxSize: DEFAULT_WS_MANAGER_CONFIG.queueMaxSize,
    oldestMessageAge: 0,
  })
  readonly lastError: Ref<Error | null> = ref(null)
  readonly gatewayStatus: Ref<'available' | 'unavailable' | 'unknown'> = ref('unknown')

  // ── 内部组件 ──
  private client: GatewayClient
  private reconnectStrategy: ReconnectStrategy
  private messageQueue: MessageQueue
  private heartbeat: HeartbeatMonitor

  // ── 配置 ──
  private config: Required<WebSocketManagerConfig>

  // ── 内部状态 ──
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private listeners = new Map<string, Set<EventCallback>>()
  private stateChangeListeners = new Set<(state: ConnectionState) => void>()
  private destroyCalled = false

  // ── 网络恢复 / 窗口获焦 监听器 ──

  private visibilityListener: (() => void) | null = null

  constructor(config?: Partial<WebSocketManagerConfig>, client?: GatewayClient) {
    this.config = { ...DEFAULT_WS_MANAGER_CONFIG, ...config }

    // GatewayClient 作为底层传输层
    this.client = client ?? new GatewayClient()

    // 重连策略
    this.reconnectStrategy = new ReconnectStrategy({
      initialDelay: this.config.initialDelay,
      maxDelay: this.config.maxDelay,
      backoffFactor: this.config.backoffFactor,
      maxRetries: this.config.maxRetries,
      jitter: this.config.jitter,
    })

    // 消息队列
    this.messageQueue = new MessageQueue({
      maxSize: this.config.queueMaxSize,
      maxMessageAge: this.config.queueMaxMessageAge,
    })

    // 心跳检测
    this.heartbeat = new HeartbeatMonitor(
      {
        pingInterval: this.config.pingInterval,
        pongTimeout: this.config.pongTimeout,
        missedPongLimit: this.config.missedPongLimit,
      },
      {
        onSendPing: () => this.sendHeartbeatPing(),
        onDead: () => this.onHeartbeatDead(),
      },
    )

    // 监听底层客户端的 close 事件（用于区分 close code）
    this.client.onClose((event: CloseEvent) => {
      if (this.intentionalClose) return
      this.handleUnexpectedClose(event)
    })

    // 监听底层客户端的消息事件（给心跳重置计时器）
    this.client.onAnyMessage(() => {
      this.heartbeat.onMessageReceived()
    })

    // 监听 Gateway 状态事件
    this.setupGatewayStatusListener()
  }

  // ================================================================
  // 生命周期
  // ================================================================

  /**
   * 连接到 Admin
   * @returns true 表示连接成功，false 表示连接失败
   */
  async connect(): Promise<boolean> {
    if (this.destroyCalled) return false

    // FAILED → CONNECTING 允许重连（重置策略）
    if (this.state.value === 'FAILED') {
      this.reconnectStrategy.reset()
    }

    this.setState('CONNECTING')
    this.intentionalClose = false
    this.lastError.value = null

    // 绑定网络恢复 / 窗口获焦事件
    this.bindNetworkListeners()

    return this.attemptConnection()
  }

  /**
   * 主动断开连接（进入 DISCONNECTED，不自动重连）
   */
  disconnect(): void {
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.clearConnectTimeout()
    this.heartbeat.stop()
    this.client.disconnect()
    this.messageQueue.clear('用户主动断开')
    this.unbindNetworkListeners()
    this.setState('DISCONNECTED')
  }

  /**
   * FAILED 状态下用户手动重连
   */
  async manualReconnect(): Promise<boolean> {
    if (this.state.value !== 'FAILED') {
      return this.connect()
    }
    return this.connect()
  }

  /**
   * 销毁管理器，释放所有资源
   */
  destroy(): void {
    this.destroyCalled = true
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.clearConnectTimeout()
    this.heartbeat.destroy()
    this.messageQueue.destroy()
    this.reconnectStrategy.destroy()
    this.client.disconnect()
    this.unbindNetworkListeners()
    this.listeners.clear()
    this.stateChangeListeners.clear()
  }

  // ================================================================
  // 消息发送（自动处理入队逻辑）
  // ================================================================

  /**
   * 发送请求 — 连接正常时直接发送，否则入队
   * @returns Promise — 发送结果或队列等待结果
   */
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.state.value === 'CONNECTED') {
      return this.client.request(method, params)
    }
    // RECONNECTING / CONNECTING / FAILED / DISCONNECTED → 入队
    return this.messageQueue.enqueue(method, params ?? {})
  }

  // ================================================================
  // 便捷属性
  // ================================================================

  get isConnected(): boolean {
    return this.state.value === 'CONNECTED'
  }

  get sessionKey(): string | null {
    return this.client.sessionKey
  }

  /** 底层 GatewayClient 引用（供 useGatewayStream 等直接订阅事件） */
  get clientRef(): GatewayClient {
    return this.client
  }

  // ================================================================
  // 事件订阅
  // ================================================================

  /**
   * 订阅事件
   */
  on(event: string, callback: EventCallback): () => void {
    let callbacks = this.listeners.get(event)
    if (!callbacks) {
      callbacks = new Set()
      this.listeners.set(event, callbacks)
    }
    callbacks.add(callback)
    return () => {
      callbacks?.delete(callback)
      if (callbacks?.size === 0) this.listeners.delete(event)
    }
  }

  /**
   * 订阅连接状态变化
   */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateChangeListeners.add(callback)
    return () => {
      this.stateChangeListeners.delete(callback)
    }
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 尝试建立连接
   */
  private async attemptConnection(): Promise<boolean> {
    this.clearConnectTimeout()

    try {
      // 设置连接超时
      const connectPromise = this.client.connect()
      const timeoutPromise = new Promise<never>((_, reject) => {
        this.connectTimeoutTimer = setTimeout(() => {
          reject(new Error('连接超时'))
        }, this.config.connectTimeout)
      })

      await Promise.race([connectPromise, timeoutPromise])
      this.clearConnectTimeout()

      // 连接成功
      this.reconnectStrategy.reset()
      this.setState('CONNECTED')
      this.heartbeat.start()
      this.messageQueue.startExpiryCheck()

      // 刷新队列状态绑定
      this.syncQueueStatus()

      // 发送队列中的消息
      this.flushQueue()

      return true
    } catch (err) {
      this.clearConnectTimeout()
      this.lastError.value = err instanceof Error ? err : new Error(String(err))

      // 判断是否应该重连
      if (this.reconnectStrategy.exhausted) {
        this.setState('FAILED')
        this.emitState()
        return false
      }

      this.scheduleReconnect()
      return false
    }
  }

  /**
   * 处理意外关闭（非主动断开）
   */
  private handleUnexpectedClose(event: CloseEvent): void {
    this.lastError.value = new Error(`连接关闭: code=${event.code} reason="${event.reason || '无'}"`)

    const code = event.code

    // 1008 = 策略违规（如认证失败）→ FAILED，不重连
    // 1000 = 正常关闭但不是我们主动的（Admin 重启等）→ 应该重连
    // 1006 = 异常关闭（无 close frame）→ 重连
    if (code === 1008) {
      this.lastError.value = new Error(`连接被拒绝: ${event.reason || '认证失败'}`)
      this.setState('FAILED')
      this.heartbeat.stop()
      this.unbindNetworkListeners()
      return
    }

    // 其他所有 code（包括 1000、1006、1011 等）→ 尝试重连
    this.scheduleReconnect()
  }

  /**
   * 安排自动重连
   */
  private scheduleReconnect(): void {
    if (this.intentionalClose || this.destroyCalled) return
    this.clearReconnectTimer()

    const delay = this.reconnectStrategy.recordAttempt()

    if (delay < 0) {
      // 重连次数耗尽
      this.setState('FAILED')
      this.emitState()
      return
    }

    this.setState('RECONNECTING')
    this.retryInfo.value = {
      attempt: this.reconnectStrategy.currentAttempt,
      maxRetries: this.reconnectStrategy.maxRetries,
      nextRetryIn: delay,
      lastAttemptAt: Date.now(),
    }

    // 倒计时：每秒更新 nextRetryIn
    const startTime = Date.now()
    const countdownInterval = setInterval(() => {
      if (this.state.value !== 'RECONNECTING' || this.retryInfo.value === null) {
        clearInterval(countdownInterval)
        return
      }
      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, delay - elapsed)
      this.retryInfo.value = {
        ...this.retryInfo.value,
        nextRetryIn: remaining,
      }
    }, 1000)

    this.reconnectTimer = setTimeout(() => {
      clearInterval(countdownInterval)
      if (this.state.value !== 'RECONNECTING' || this.intentionalClose || this.destroyCalled) return
      this.attemptConnection()
    }, delay)
  }

  /**
   * 刷新队列中的消息
   */
  private async flushQueue(): Promise<void> {
    while (this.messageQueue.status.value.size > 0 && this.state.value === 'CONNECTED') {
      const msg = this.messageQueue.dequeue()
      if (!msg) break

      try {
        const result = await this.client.request(msg.method, msg.params)
        msg.resolve(result)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const requeued = this.messageQueue.requeue(msg)
        if (!requeued) {
          console.warn(`[WSManager] 消息最终失败: ${msg.method}`, error)
          const cbs = this.listeners.get('queue.error')
          if (cbs) for (const cb of cbs) { try { cb({ method: msg.method, error }) } catch { /* ignore */ } }
        }
        // 重连过程中发送失败 → 终止刷新，等待再次重连
        if (this.state.value !== 'CONNECTED') break
      }
    }
    this.syncQueueStatus()
  }

  /**
   * 发送心跳 ping
   */
  private sendHeartbeatPing(): void {
    if (this.state.value !== 'CONNECTED') return
    this.client.request('_ping').then((result) => {
      const data = result as { pong?: boolean; ts?: number; gatewayStatus?: string }
      if (data.gatewayStatus === 'disconnected') {
        this.gatewayStatus.value = 'unavailable'
      } else if (data.gatewayStatus === 'connected') {
        this.gatewayStatus.value = 'available'
      }
      this.heartbeat.onPong()
    }).catch(() => {
      // ping 失败由 heartbeat 的 onPongTimeout 处理
    })
  }

  /**
   * 心跳检测判定连接死亡
   */
  private onHeartbeatDead(): void {
    this.lastError.value = new Error('心跳超时，连接可能已断开')
    this.heartbeat.stop()
    // 触发重连
    this.scheduleReconnect()
  }

  /**
   * 监听 Gateway 状态事件（由 Admin WsServer 转发）
   */
  private setupGatewayStatusListener(): void {
    this.client.on('gateway.status', (payload: unknown) => {
      const data = payload as { connected: boolean; permanent?: boolean; reconnecting?: boolean }
      if (data.connected) {
        this.gatewayStatus.value = 'available'
        // Gateway 恢复 → 刷新队列
        this.flushQueue()
      } else {
        this.gatewayStatus.value = 'unavailable'
      }
    })

    this.client.on('gateway.reconnecting', (_payload: unknown) => {
      this.gatewayStatus.value = 'unavailable'
    })
  }

  /**
   * 设置新状态并通知
   */
  private setState(newState: ConnectionState): void {
    const prev = this.state.value
    if (prev === newState) return
    this.state.value = newState

    // 更新 retryInfo
    if (newState !== 'RECONNECTING') {
      this.retryInfo.value = null
    }

    this.emitState()
  }

  private emitState(): void {
    const state = this.state.value
    for (const cb of this.stateChangeListeners) {
      try { cb(state) } catch { /* ignore */ }
    }
  }

  private syncQueueStatus(): void {
    this.queueStatus.value = { ...this.messageQueue.status.value }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer !== null) {
      clearTimeout(this.connectTimeoutTimer)
      this.connectTimeoutTimer = null
    }
  }

  // ── 网络恢复 / 窗口获焦 ──

  private bindNetworkListeners(): void {
    this.unbindNetworkListeners()

    // 窗口获焦时加速重连（Tauri 桌面应用中 navigator.onLine 不可靠，不依赖它）
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible' && this.state.value === 'RECONNECTING') {
        this.clearReconnectTimer()
        this.attemptConnection()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityListener)
  }

  private unbindNetworkListeners(): void {
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener)
      this.visibilityListener = null
    }
  }
}

// ============ 单例导出 ============

import { gatewayClient } from './gateway-client'
export const wsManager = new WebSocketManager(undefined, gatewayClient)
