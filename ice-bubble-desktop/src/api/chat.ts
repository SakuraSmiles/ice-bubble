/**
 * Chat API Client — 消息发送与 SSE 流
 * POST /api/chat/send  |  GET /api/chat/stream  |  POST /api/chat/abort
 */

import { API_BASE, getAdminAuthToken } from '../config';
import { request } from './client';
import { apiMonitor } from '../utils/monitor';

// ============ DTO ============

/** 消息发送请求体 */
export interface ChatSendRequest {
  sessionKey: string
  message: string
}

/** 消息发送响应体 */
export interface ChatSendResponse {
  success: boolean
  messageId?: string
  error?: string
}

/** SSE message 事件数据 */
export interface SSEMessageEvent {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  messageId: string
}

/** SSE error 事件数据 */
export interface SSEErrorEvent {
  message: string
}

/** SSE status 事件数据 */
export interface SSEStatusEvent {
  connected: boolean
}

/** SSE 事件处理器集合 */
export interface SSEHandlers {
  onMessage?: (event: SSEMessageEvent) => void
  onError?: (event: SSEErrorEvent) => void
  onStatus?: (event: SSEStatusEvent) => void
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const start = performance.now()
  try {
    const response = await request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const latency = Math.round(performance.now() - start)
    apiMonitor.record(path, 'POST', latency, response.ok)
    const data = await response.json() as T
    return data
  } catch (e: any) {
    const latency = Math.round(performance.now() - start)
    apiMonitor.record(path, 'POST', latency, false, e.message)
    throw e
  }
}

// ============ API 函数 ============

/**
 * 发送聊天消息
 * POST /api/chat/send
 */
export async function sendChat(
  sessionKey: string,
  message: string,
): Promise<ChatSendResponse> {
  const req: ChatSendRequest = { sessionKey, message }
  return postJson<ChatSendResponse>('/chat/send', req)
}

/**
 * 建立 SSE 流式连接，监听聊天消息
 * GET /api/chat/stream
 *
 * 返回 EventSource，调用方负责：
 * - 监听 'message' / 'error' / 'status' 事件
 * - 调用 .close() 清理资源
 */
export function getChatStream(
  sessionKey: string,
  handlers: SSEHandlers = {},
): EventSource {
  let url = `${API_BASE}/chat/stream?session=${encodeURIComponent(sessionKey)}`
  // EventSource 不支持自定义 headers，token 通过 query 参数传递
  const token = getAdminAuthToken()
  if (token) {
    url += `&token=${encodeURIComponent(token)}`
  }
  const es = new EventSource(url)

  es.addEventListener('message', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SSEMessageEvent
      handlers.onMessage?.(data)
    } catch {
      // ignore parse error
    }
  })

  es.addEventListener('error', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SSEErrorEvent
      handlers.onError?.(data)
    } catch {
      handlers.onError?.({ message: 'SSE connection error' })
    }
  })

  es.addEventListener('status', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SSEStatusEvent
      handlers.onStatus?.(data)
    } catch {
      // ignore parse error
    }
  })

  return es
}

/**
 * 中止正在进行的聊天流
 * POST /api/chat/abort
 */
export async function abortChat(sessionKey: string): Promise<{ success: boolean }> {
  return postJson<{ success: boolean }>('/chat/abort', { sessionKey })
}
