/**
 * Design API Client — OpenDesign 设计接口
 * 所有请求通过 Admin 代理 /api/design/* 转发到 OD daemon
 */

import { API_BASE, getAdminAuthToken } from '../config';
import { request } from './client';
import { apiMonitor } from '../utils/monitor';

// ============ DTO ============

export interface DesignProject {
  id: string;
  name: string;
  description?: string;
  /** camelCase — matches OD daemon response */
  createdAt?: number;
  /** camelCase — matches OD daemon response */
  updatedAt?: number;
  /** snake_case fallback (client-only) */
  created_at?: string;
  /** snake_case fallback (client-only) */
  updated_at?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  status?: { value: string } | null;
}

export interface DesignChatRequest {
  message: string;
  /** OD daemon 使用 camelCase: projectId（非 project_id） */
  projectId?: string;
}

// SSE 事件类型 — 对齐 OD daemon 的实际事件格式
//
// OD daemon 通过 createSseResponse 发送标准 SSE:
//   event: <name>\ndata: <json>\n\n
//
// 事件名称: start | agent | error | end | stdout | stderr
// agent 子类型 (data.type): status | text_delta | tool_use | tool_result | ...

export interface DesignSSEEvent {
  /** SSE event: 行的值 */
  sseEvent?: string;
  /** 解析后的 data 载荷（可能为 null，如 [DONE]） */
  data: Record<string, unknown> | null;
}

// ============ SSE 工具函数 ============

export interface SSEEventHandlers {
  onEvent?: (event: DesignSSEEvent) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/** POST 请求返回 SSE 流（使用 fetch + ReadableStream） */
export function postSSE(
  path: string,
  body: unknown,
  handlers: SSEEventHandlers,
): AbortController {
  const controller = new AbortController();
  const token = getAdminAuthToken();

  fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        let errMsg = `SSE request failed: ${response.status}`;
        try {
          const errBody = await response.text();
          if (errBody) errMsg += ` — ${errBody.slice(0, 200)}`;
        } catch { /* ignore */ }
        throw new Error(errMsg);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let pendingEventName = ''; // 跨 chunk 保留 event name

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 解析标准 SSE 格式: "event: <name>\ndata: <json>\n\n"
        // （也兼容仅 "data: <json>\n" 的简易格式）
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            pendingEventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (jsonStr === '[DONE]') {
              handlers.onDone?.();
              return;
            }
            let data: Record<string, unknown> | null = null;
            try {
              data = JSON.parse(jsonStr);
            } catch {
              // 忽略解析错误
            }
            handlers.onEvent?.({ sseEvent: pendingEventName || undefined, data });
            pendingEventName = '';
          }
          // id: 行被忽略
        }
      }
      handlers.onDone?.();
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        handlers.onError?.(err);
      }
    });

  return controller;
}

// ============ REST API ============

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const start = performance.now();
  const method = options?.method || 'GET';
  try {
    const response = await request(path, options);
    const latency = Math.round(performance.now() - start);
    if (!response.ok) {
      apiMonitor.record(path, method, latency, false, `HTTP ${response.status}`);
      throw new Error(`API error: ${response.status}`);
    }
    apiMonitor.record(path, method, latency, true);
    return response.json();
  } catch (e: any) {
    const latency = Math.round(performance.now() - start);
    apiMonitor.record(path, method, latency, false, e.message);
    throw e;
  }
}

/** 获取项目列表 */
export function getDesignProjects(): Promise<{ projects: DesignProject[] }> {
  return fetchJson('/design/projects');
}

/** 创建项目（POST 到 OD daemon，通过 Admin 代理） */
export async function createDesignProject(data: {
  name: string;
  description?: string;
}): Promise<DesignProject> {
  const id = crypto.randomUUID();
  return fetchJson<{ project: DesignProject; conversationId: string }>('/design/projects', {
    method: 'POST',
    body: JSON.stringify({ id, name: data.name }),
  }).then(res => res.project);
}

/** 创建设计聊天（返回 SSE 流） */
export function createDesignChat(
  data: DesignChatRequest,
  handlers: SSEEventHandlers,
): AbortController {
  return postSSE('/design/chat', data, handlers);
}
