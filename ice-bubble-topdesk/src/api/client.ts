import { API_BASE } from '../config';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include'
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

// API 函数
export const api = {
  // 统计
  getStats: () => fetchJson('/data/stats'),

  // 会话
  getSessions: (params?: { limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return fetchJson(`/data/sessions${query}`);
  },

  getSession: (key: string) => fetchJson(`/data/sessions/${encodeURIComponent(key)}`),

  // 消息
  getMessages: (params?: { session_key?: string; limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {})
    ).toString() : '';
    return fetchJson(`/data/messages${query}`);
  },

  // 模块
  getModules: () => fetchJson('/modules'),
  getModuleStatus: (key: string) => fetchJson(`/modules/${key}/status`),
  getModuleConfig: (key: string) => fetchJson(`/modules/${key}/config`)
};
