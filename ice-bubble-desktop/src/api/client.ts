/**
 * API Client - Desktop 统一 API 调用层
 * 所有 view 层 API 请求必须通过此模块
 */

import { API_BASE } from '../config';
import { apiMonitor } from '../utils/monitor';

// Auth token: read from environment variable (Vite) or config
function getAuthToken(): string {
  // Vite uses import.meta.env for env vars
  const envToken = (import.meta as any).env?.VITE_ICE_AUTH_TOKEN;
  return envToken || '';
}

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
  agent_name: string | null;
  channel: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  last_message: string | null;
  created_at: string;
  label?: string | null;
  session_status?: string | null;
  model?: string | null;
  model_provider?: string | null;
  spawned_by?: string | null;
  spawn_depth?: number | null;
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

export interface TimelineMessageDTO {
  id: number;
  session_key: string;
  agent_id: string | null;
  agent_name: string;
  avatar: string | null;
  message_type: 'user' | 'agent' | 'tool';
  content: string | null;
  /** 清洗后的用户内容（去掉 metadata/json 前缀等） */
  clean_content: string | null;
  /** 用于列表预览的简短摘要 */
  content_summary: string | null;
  /** 是否是定时任务 */
  is_cron: boolean;
  /** 是否是系统噪音 */
  is_system_noise: boolean;
  /** 消息来源渠道 */
  source_channel: string | null;
  /** 消息使用的模型 */
  model: string | null;
  timestamp: string;
}

export interface TimelinePaginationDTO {
  oldest: string | null;
  newest: string | null;
  total_in_range: number;
}

export interface TimelineMetaDTO {
  agents_in_range: string[];
  filter_applied: Record<string, unknown>;
  system_status?: {
    todayFiltered: number;
    lastCompaction: string | null;
    lastMemoryFlush: string | null;
  };
}

export interface TimelineResponseDTO {
  messages: TimelineMessageDTO[];
  has_more: boolean;
  pagination: TimelinePaginationDTO;
  meta: TimelineMetaDTO;
}

export type AgentStatus = '失联' | '工作' | '工作中' | '活跃' | '休假' | '离线';

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
  latest_message: string | null;
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

// ============ 任务 DTO（由 AgentTaskTree / ParentTaskProgress 使用） ============

export interface TaskItemDTO {
  task_id: string;
  title: string;
  status: string;
  updated_at?: string;
}

export interface AgentGroupDTO {
  agent_id: string;
  active_children: TaskItemDTO[];
  completed_children: TaskItemDTO[];
}

export interface ParentTaskDTO {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  agent_groups: AgentGroupDTO[];
}

// ============ 内部工具 ============

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const start = performance.now();
  const method = options?.method || 'GET';
  try {
    // Build headers with Bearer token if configured
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string> || {}),
    };
    const authToken = getAuthToken();
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    // API_BASE = '/api'（相对路径），请求通过 Vite dev server 或生产环境同源代理转发
    // credentials: 'include' 确保浏览器发送 cookie（用于会话认证）
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
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

  /** 获取对话面板用的timeline消息（复用timeline API的噪音过滤） */
  getChatTimeline: (sessionKey: string, params?: { limit?: number; before?: string; since?: string }) => {
    const qp = new URLSearchParams({
      session_key: sessionKey,
      limit: String(params?.limit ?? 100),
      exclude_system_noise: 'true',
      exclude_cron: 'true',
      message_types: 'user,agent',
    });
    if (params?.before) qp.set('before', params.before);
    if (params?.since) qp.set('since', params.since);
    return fetchJson<{ messages: TimelineMessageDTO[]; has_more: boolean; pagination: { oldest: string | null; newest: string | null } }>(`/messages/timeline?${qp.toString()}`);
  },

  // 消息
  getMessages: (params?: { session_key?: string; limit?: number; offset?: number }) => {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {})
    ).toString() : '';
    return fetchJson<{ messages: MessageDTO[] }>(`/messages${query}`);
  },

  getMessagesTimeline: (params?: {
    limit?: number;
    before?: string;
    since?: string;
    agent_ids?: string[];
    message_types?: string;
    search?: string;
    exclude_system_noise?: boolean;
    exclude_cron?: boolean;
  }) => {
    const entries: Record<string, string> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) entries[k] = v.join(',');
          else entries[k] = String(v);
        }
      }
    }
    const query = Object.keys(entries).length > 0 ? '?' + new URLSearchParams(entries).toString() : '';
    return fetchJson<TimelineResponseDTO>(`/messages/timeline${query}`);
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
