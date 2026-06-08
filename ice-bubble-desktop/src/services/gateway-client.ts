/**
 * GatewayClient — 浏览器端 WebSocket 客户端（纯传输层）
 *
 * 通过 Vite 代理连接到 Admin 的 /ws 端点，
 * 使用 req/res/event 协议与 Admin 通信，Admin 再转发到 Gateway。
 *
 * 【重构说明】
 * 重连逻辑已移至 WebSocketManager，本类回归为纯传输层：
 * - 移除 scheduleReconnect / reconnectAttempts / exponential backoff
 * - 新增 onClose() — 暴露原始 CloseEvent 供上层判断 close code
 * - 新增 onAnyMessage() — 每次收到消息时触发（供心跳重置）
 * - 保留 request() / on() / connect() / disconnect() 等底层方法
 */

// ============ 协议类型 ============

/** 请求消息 */
interface GatewayRequest {
  type: 'req'
  id: number
  method: string
  params?: Record<string, unknown>
}

/** 响应消息 */
interface GatewayResponse {
  type: 'res'
  id: number
  ok: boolean
  payload?: unknown
  error?: string
}

/** 事件消息 */
interface GatewayEvent {
  type: 'event'
  event: string
  payload?: unknown
  seq?: number
}

type GatewayMessage = GatewayRequest | GatewayResponse | GatewayEvent

/** 客户端标识信息 */
export interface ClientInfo {
  platform: string       // desktop-win / desktop-mac / mobile-android / mobile-ios / web
  appVersion?: string   // 应用版本号
  sessionId?: string    // 本次连接的唯一 ID
}

/** 检测当前平台标识 */
function detectPlatform(): string {
  const ua = navigator.userAgent
  // Mobile-first detection (mobile UAs often contain desktop markers)
  if (/iPhone|iPad|iPod/.test(ua)) return 'mobile-ios'
  if (/Android/.test(ua)) return 'mobile-android'
  if (/Win/.test(ua)) return 'desktop-win'
  if (/Mac/.test(ua)) return 'desktop-mac'
  if (/Linux/.test(ua)) return 'desktop-linux'
  return 'unknown'
}

/** pending 请求记录 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 事件回调类型 */
type EventCallback = (...args: unknown[]) => void

import { getAdminUrl, getAdminAuthToken } from '../config'

// ============ 常量 ===========

/** 请求超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000

// ============ GatewayClient ============

export class GatewayClient {
  private ws: WebSocket | null = null
  private reqId = 0
  private pending = new Map<number, PendingRequest>()
  private listeners = new Map<string, Set<EventCallback>>()
  private _connected = false
  private _sessionKey: string | null = null
  private intentionalClose = false

  // ── 新增：close 回调 ──
  private closeCallbacks = new Set<(event: CloseEvent) => void>()
  // ── 新增：任意消息回调 ──
  private anyMessageCallbacks = new Set<() => void>()

  // ============ 连接生命周期 ============

  /**
   * 连接到 Admin 的 /ws WebSocket 代理端点
   * 返回的 Promise 在收到 connect.hello 响应后 resolve
   */
  /**
   * 等待 Gateway 连接就绪。如果已连接则立即 resolve，
   * 如果正在连接则等待 connect 事件，否则返回 false。
   */
  async waitForConnect(timeoutMs = 5000): Promise<boolean> {
    if (this._connected) return true
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      const unsub = this.on('connect', () => {
        clearTimeout(timer)
        unsub()
        resolve(true)
      })
    })
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      // 已有连接正在进行，等待其完成
      await this.waitForConnect()
      return
    }

    this.intentionalClose = false
    let url: string;
    if (import.meta.env?.DEV) {
      url = `ws://${window.location.host}/ws`;
    } else {
      const adminUrl = getAdminUrl();
      url = adminUrl.replace(/^http/, 'ws') + '/ws';
    }

    // Append auth token as query parameter for WebSocket authentication
    const authToken = getAdminAuthToken();
    if (authToken) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}token=${encodeURIComponent(authToken)}`;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url)
      } catch (err) {
        this.emit('error', { message: 'Failed to create WebSocket', error: err })
        reject(err)
        return
      }

      this.ws.onopen = () => {
        // 连接建立后，立即发送 clientInfo 标识
        try {
          const platform = detectPlatform()
          let sessionId: string;
          try {
            sessionId = crypto.randomUUID();
          } catch (_) {
            sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          }
          const clientInfo: ClientInfo = { platform, sessionId }
          // 读取应用版本号（Vite 通过 define 注入）
          try { clientInfo.appVersion = (globalThis as any).__APP_VERSION__; } catch (_) { /* ignore */ }
          this.ws!.send(JSON.stringify({
            type: 'req',
            id: -1,
            method: 'client.identify',
            params: { clientInfo },
          }))
        } catch {
          // 标识发送失败不影响连接
        }
      }

      this.ws.onmessage = (event: MessageEvent) => {
        // 通知任意消息监听器（供心跳重置）
        this.notifyAnyMessage()
        try {
          const msg: GatewayMessage = JSON.parse(event.data as string)
          this.onMessage(msg)
        } catch {
          // 忽略解析失败的消息
        }
      }

      this.ws.onerror = () => {
        this.emit('error', { message: 'WebSocket error' })
        reject(new Error('WebSocket connection error'))
      }

      this.ws.onclose = (event: CloseEvent) => {
        if (this.intentionalClose) {
          this._connected = false
          this.cleanupPending(new Error('Client disconnected'))
        } else {
          // 通知上层处理（WebSocketManager 负责 close code 判断和重连）
          this.notifyClose(event)
          this._connected = false
          this.cleanupPending(new Error('Connection lost'))
          this.emit('disconnect', { message: 'Connection lost', code: event.code, reason: event.reason })
        }
      }

      // 设置一次性 connect 监听，等待 Admin 发来的 connect.hello 响应
      this.onceInternal('connect.hello', (payload) => {
        const data = payload as Record<string, unknown> | undefined
        this._connected = true
        this._sessionKey = (data?.sessionKey as string) ?? null
        this.emit('connect', payload)
        resolve()
      })
    })
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.intentionalClose = true

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this._connected = false
    this.cleanupPending(new Error('Client disconnected'))
  }

  // ============ 核心方法 ============

  /**
   * 发送请求并等待响应
   * @param method - 方法名
   * @param params - 请求参数
   * @returns Promise<响应 payload>
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'))
    }

    const id = ++this.reqId

    const req: GatewayRequest = {
      type: 'req',
      id,
      method,
      params,
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Request timeout: ${method}`))
        }
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.ws!.send(JSON.stringify(req))
      } catch (err) {
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(id)
        }
        reject(err)
      }
    })
  }

  // ============ 便捷方法 ============

  /**
   * 向指定会话发送消息
   */
  async sendMessage(
    sessionKey: string,
    message: string,
    attachments?: unknown[],
  ): Promise<unknown> {
    return this.request('chat.send', {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
      ...(attachments ? { attachments } : {}),
    })
  }

  /**
   * 中止指定会话的当前 Turn
   */
  async abortTurn(sessionKey: string): Promise<unknown> {
    return this.request('chat.abort', { sessionKey })
  }

  /**
   * 向正在处理的会话追加消息（Steer）
   */
  async steerSession(sessionKey: string, message: string): Promise<unknown> {
    return this.request('sessions.steer', { key: sessionKey, message })
  }

  /**
   * 获取会话聊天历史
   */
  async getChatHistory(sessionKey: string, limit?: number): Promise<unknown> {
    return this.request('chat.history', {
      sessionKey,
      ...(limit !== undefined ? { limit } : {}),
    })
  }

  /**
   * 获取所有会话列表
   */
  async listSessions(): Promise<unknown> {
    return this.request('sessions.list')
  }

  // ============ 事件订阅 ============

  /**
   * 订阅事件
   * @param event - 事件名
   * @param callback - 回调函数
   * @returns 取消订阅函数
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
      if (callbacks?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  // ============ 新增：Close 回调 ============

  /**
   * 注册 WebSocket close 事件回调
   * 每次连接意外关闭时触发，传递原始 CloseEvent
   * @returns 取消订阅函数
   */
  onClose(callback: (event: CloseEvent) => void): () => void {
    this.closeCallbacks.add(callback)
    return () => {
      this.closeCallbacks.delete(callback)
    }
  }

  /**
   * 注册任意消息接收回调
   * 每次收到 WebSocket 消息时触发（供心跳重置计时器）
   * @returns 取消订阅函数
   */
  onAnyMessage(callback: () => void): () => void {
    this.anyMessageCallbacks.add(callback)
    return () => {
      this.anyMessageCallbacks.delete(callback)
    }
  }

  // ============ 状态访问器 ============

  /**
   * 当前是否已连接并通过认证
   */
  get isConnected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * WebSocket readyState（原始值）
   */
  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED
  }

  /**
   * 当前主会话的 sessionKey
   * 在 connect.hello 事件中由 Admin 设置
   */
  get sessionKey(): string | null {
    return this._sessionKey
  }

  // ============ 内部方法 ============

  /**
   * 处理收到的消息
   */
  private onMessage(msg: GatewayMessage): void {
    switch (msg.type) {
      case 'res':
        this.handleResponse(msg)
        break
      case 'event':
        this.handleEvent(msg)
        break
      default:
        // 忽略未知类型
        break
    }
  }

  /**
   * 处理响应消息
   */
  private handleResponse(res: GatewayResponse): void {
    // Guard: negative IDs are fire-and-forget (e.g. client.identify)
    if (typeof res.id === 'number' && res.id < 0) return
    const pending = this.pending.get(res.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(res.id)

    if (res.ok) {
      pending.resolve(res.payload)
    } else {
      pending.reject(new Error(res.error ?? 'Unknown error'))
    }
  }

  /**
   * 处理 Admin 转发的事件消息
   */
  private handleEvent(event: GatewayEvent): void {
    const { event: eventName, payload } = event

    // 根据事件名进行分发
    switch (eventName) {
      // Agent 回复消息（包含文本、工具调用、思考过程等）
      case 'chat':
        this.emit('chat', payload)
        break

      // Agent 状态变化（thinking/tool_call/replying 等）
      case 'agent':
        this.emit('agent', payload)
        break

      // 会话新增消息
      case 'session.message':
        this.emit('session.message', payload)
        break

      // 会话列表变化
      case 'sessions.changed':
        this.emit('sessions.changed', payload)
        break

      // Admin 已处理完认证质询，GatewayClient 无需处理
      case 'connect.challenge':
        // 不处理，Admin 已处理
        break

      // 认证成功（res 类型中包含，但也可能以事件形式发送）
      case 'connect.hello':
        this._connected = true
        this.emit('connect.hello', payload)
        break

      default:
        // 分发所有其他事件
        this.emit(eventName, payload)
        break
    }
  }

  /**
   * 清理所有 pending 请求
   */
  private cleanupPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /**
   * 触发事件
   */
  private emit(event: string, data: unknown): void {
    const callbacks = this.listeners.get(event)
    if (!callbacks) return

    for (const cb of callbacks) {
      try {
        cb(data)
      } catch {
        // 忽略回调异常，避免影响其他监听器
      }
    }
  }

  /**
   * 内部一次性事件监听（用于 connect 流程中的 connect.hello）
   */
  private onceInternal(event: string, callback: EventCallback): void {
    const unsubscribe = this.on(event, (...args: unknown[]) => {
      unsubscribe()
      callback(...args)
    })
  }

  /**
   * 通知 close 回调
   */
  private notifyClose(event: CloseEvent): void {
    for (const cb of this.closeCallbacks) {
      try { cb(event) } catch { /* ignore */ }
    }
  }

  /**
   * 通知任意消息回调
   */
  private notifyAnyMessage(): void {
    for (const cb of this.anyMessageCallbacks) {
      try { cb() } catch { /* ignore */ }
    }
  }
}

// ============ 单例导出 ============

export const gatewayClient = new GatewayClient()
