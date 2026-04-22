/**
 * API Client - Desktop 统一 API 调用层
 * 所有 view 层 API 请求必须通过此模块
 */

import { API_BASE } from '../config';
import { apiMonitor } from '../utils/monitor';

// ============ DTO 接口 ============

export interface StatsDTO {
  sessionCount: number;
  messageCount: number;
  moduleCount: number;
  collectorStatus: 'running' | 'stopped' | 'unknown';
}

export interface SessionDTO {
  session_key: string;
  agent_id: string;
  channel: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface SessionsResponseDTO {
  sessions: SessionDTO[];
}

export interface MessageDTO {
  id: string;
  session_key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export interface ModuleStatusDTO {
  state: 'running' | 'stopped' | 'error' | null;
  lastPollTime?: string;
  lastError?: string;
  latencyMs?: number | null;
}

export interface ModuleDTO {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval: number;
  version?: string;
  registeredTime?: string;
  status?: {
    state?: 'running' | 'stopped' | 'error' | string;
    runtime?: { startTime?: string };
    latencyMs?: number | null;
    lastPollTime?: string;
    lastError?: string;
  };
}

export interface ModulesResponseDTO {
  modules: ModuleDTO[];
}

export type AgentStatus = '失联' | '工作' | '活跃' | '休假' | '离线';

export interface AgentDTO {
  agent_id: string;
  agent_name: string | null;
  workspace: string | null;
  session_count: number;
  message_count: number;
  first_active_at: string | null;
  last_active_at: string | null;
  updated_at: string;
  avatar: string | null;
  model: string | null;
  source: string;
  /** 统一状态，由 admin 层 calculateAgentStatus 计算 */
  status: AgentStatus;
}

export interface AgentsResponseDTO {
  agents: AgentDTO[];
  count: number;
}

export interface ActivityDayDTO {
  date: string;
  count: number;
}

export interface TokenStatsDTO {
  agent_id: string;
  total_tokens_input: number;
  total_tokens_output: number;
  total_cost: number;
  cost_input: number;
  cost_output: number;
  message_count: number;
}

export interface AgentWithActivityDTO extends AgentDTO {
  activity: ActivityDayDTO[];
  // Token stats (可选，由单独接口获取后填充)
  token_stats?: TokenStatsDTO | null;
  todayTokenStats?: TokenStatsDTO | null;
  yesterdayTokenStats?: TokenStatsDTO | null;
}

export interface AgentsWithActivityResponseDTO {
  agents: AgentWithActivityDTO[];
}

export interface TokenSummaryDTO {
  agent_id: string;
  date: string;
  total_tokens_input: number;
  total_tokens_output: number;
  total_cost: number;
  cost_input: number;
  cost_output: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface TokenSummaryResponseDTO {
  summary: TokenSummaryDTO[];
}

// ============ 内部工具 ============

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const start = performance.now();
  const method = options?.method || 'GET';
  try {
    // API_BASE = '/api'（相对路径），请求通过 Vite dev server 或生产环境同源代理转发
    // credentials: 'include' 确保浏览器发送 cookie（用于会话认证）
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: 'include'
    });
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

// ============ API 方法 ============

export const api = {
  // 统计
  getStats: (): Promise<StatsDTO> => fetchJson('/stats'),

  // 会话
  getSessions: (params?: { limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {})
    ).toString() : '';
    return fetchJson<SessionsResponseDTO>(`/sessions${query}`);
  },

  getSession: (key: string) =>
    fetchJson<SessionDTO>(`/sessions/${encodeURIComponent(key)}`),

  getSessionMessages: (sessionKey: string, params?: { limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {})
    ).toString() : '';
    return fetchJson<{ messages: MessageDTO[] }>(`/sessions/${encodeURIComponent(sessionKey)}/messages${query}`);
  },

  // 消息
  getMessages: (params?: { session_key?: string; limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {})
    ).toString() : '';
    return fetchJson<{ messages: MessageDTO[] }>(`/messages${query}`);
  },

  // 模块
  getModules: () => fetchJson<ModulesResponseDTO>('/modules'),
  getModuleStatus: (key: string) => fetchJson<ModuleStatusDTO>(`/modules/${key}/status`),
  getModuleConfig: (key: string) => fetchJson<ModuleDTO>(`/modules/${key}/config`),

  testModuleConnection: (baseUrl: string) =>
    fetchJson<{ success: boolean; moduleKey?: string; error?: string }>('/modules/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl }),
    }),

  saveModule: (body: { moduleKey: string; name: string; baseUrl: string; enabled: boolean; pollInterval: number }, method: 'POST' | 'PUT' = 'POST', key?: string) =>
    fetchJson<{ error?: string }>(key ? `/modules/${key}` : '/modules', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  deleteModule: (key: string) =>
    fetchJson<{ error?: string }>(`/modules/${key}`, { method: 'DELETE' }),

  toggleModule: (key: string, enabled: boolean) =>
    fetchJson<{ error?: string }>(`/modules/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  // 成员
  getAgents: () => fetchJson<AgentsResponseDTO>('/agents'),
  getAgentsWithActivity: (days = 90) =>
    fetchJson<AgentsWithActivityResponseDTO>(`/agents/with-activity?days=${days}`),
  getTokenSummary: (agentId?: string, date?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (date) params.set('date', date);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchJson<TokenSummaryResponseDTO>(`/agents/token-summary${query}`);
  },
};
