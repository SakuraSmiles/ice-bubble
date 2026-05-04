/**
 * TypeMapper - 类型映射工具
 * 
 * 解决 TypeScript 接口 (camelCase) 与 SQL 表 (snake_case) 的映射问题
 * 
 * 职责：
 * 1. 提供双向映射：TypeScript ↔ SQL
 * 2. 统一 null/undefined 处理
 * 3. 日期格式转换
 * 
 * @module TypeMapper
 */

import { SessionMessage, Agent, Session, ToolCall } from '../types/index.js';

// ==================== 数据库行类型 ====================

/**
 * UnifiedMessage 数据库行类型
 */
export interface UnifiedMessageRow {
  message_id: string | null;
  session_key: string;
  message_type: string;
  content: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_total: number | null;
  cost_input: number | null;
  cost_output: number | null;
  tools_json: string | null;
  timestamp: string;
  created_at: string | null;
  [key: string]: unknown; // 允许按列名索引
}

/**
 * UnifiedSession 数据库行类型
 */
export interface UnifiedSessionRow {
  session_key: string;
  agent_id: string;
  channel: string;
  account_id: string | null;
  peer_id: string | null;
  guild_id: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown; // 允许按列名索引
}

/**
 * UnifiedAgent 数据库行类型
 */
export interface UnifiedAgentRow {
  agent_id: string;
  agent_name: string | null;
  config_json: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown; // 允许按列名索引
}

// ==================== SessionMessage 映射 ====================

/**
 * SessionMessage 数据库映射
 */
export class SessionMessageMapper {
  /**
   * TypeScript → 数据库行
   */
  static toDb(message: SessionMessage): UnifiedMessageRow {
    return {
      message_id: message.messageId || null,
      session_key: message.sessionKey,
      message_type: message.messageType,
      content: message.content || null,
      model: message.model || null,
      tokens_input: message.tokensInput || null,
      tokens_output: message.tokensOutput || null,
      cost_total: message.costTotal || null,
      cost_input: message.costInput || null,
      cost_output: message.costOutput || null,
      tools_json: message.toolsJson || null,
      timestamp: message.timestamp.toISOString(),
      created_at: message.createdAt?.toISOString() || null
    };
  }

  /**
   * 数据库行 → TypeScript
   */
  static fromDb(row: UnifiedMessageRow): SessionMessage {
    const r = row as unknown as {
      id?: number; message_id: string | null; session_key: string; message_type: string;
      content: string | null; model: string | null; tokens_input: number | null;
      tokens_output: number | null; cost_total: number | null; cost_input: number | null;
      cost_output: number | null; tools_json: string | null; timestamp: string;
      created_at: string | null;
    };
    return {
      id: r.id,
      messageId: r.message_id || undefined,
      sessionKey: r.session_key,
      messageType: r.message_type as SessionMessage['messageType'],
      content: r.content || undefined,
      model: r.model || undefined,
      tokensInput: r.tokens_input || undefined,
      tokensOutput: r.tokens_output || undefined,
      costTotal: r.cost_total || undefined,
      costInput: r.cost_input || undefined,
      costOutput: r.cost_output || undefined,
      toolsJson: r.tools_json || undefined,
      timestamp: new Date(r.timestamp),
      createdAt: r.created_at ? new Date(r.created_at) : undefined
    };
  }

  /**
   * 批量转换：TypeScript → 数据库行
   */
  static batchToDb(messages: SessionMessage[]): UnifiedMessageRow[] {
    return messages.map(msg => this.toDb(msg));
  }

  /**
   * 批量转换：数据库行 → TypeScript
   */
  static batchFromDb(rows: UnifiedMessageRow[]): SessionMessage[] {
    return rows.map(row => this.fromDb(row));
  }
}

// ==================== Session 映射 ====================

/**
 * Session 数据库映射
 */
export class SessionMapper {
  /**
   * TypeScript → 数据库行
   */
  static toDb(session: Session): UnifiedSessionRow {
    return {
      session_key: session.sessionKey,
      agent_id: session.agentId,
      channel: session.channel,
      account_id: session.accountId || null,
      peer_id: session.peerId || null,
      guild_id: session.guildId || null,
      created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString()
    };
  }

  /**
   * 数据库行 → TypeScript
   */
  static fromDb(row: UnifiedSessionRow): Session {
    const r = row as unknown as {
      session_key: string; agent_id: string; channel: string;
      account_id: string | null; peer_id: string | null; guild_id: string | null;
      created_at: string; updated_at: string;
    };
    return {
      sessionKey: r.session_key,
      agentId: r.agent_id,
      channel: r.channel,
      accountId: r.account_id || undefined,
      peerId: r.peer_id || undefined,
      guildId: r.guild_id || undefined,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at)
    };
  }
}

// ==================== Agent 映射 ====================

/**
 * Agent 数据库映射
 */
export class AgentMapper {
  /**
   * TypeScript → 数据库行
   */
  static toDb(agent: Agent): UnifiedAgentRow {
    return {
      agent_id: agent.agentId,
      agent_name: agent.agentName || null,
      config_json: agent.configJson || null,
      status: agent.status,
      last_seen_at: agent.lastSeenAt?.toISOString() || null,
      created_at: agent.createdAt.toISOString(),
      updated_at: agent.updatedAt.toISOString()
    };
  }

  /**
   * 数据库行 → TypeScript
   */
  static fromDb(row: UnifiedAgentRow): Agent {
    const r = row as unknown as {
      agent_id: string; agent_name: string | null; config_json: string | null;
      status: string; last_seen_at: string | null; created_at: string; updated_at: string;
    };
    return {
      agentId: r.agent_id,
      agentName: r.agent_name || undefined,
      configJson: r.config_json || undefined,
      status: r.status as Agent['status'],
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

// ==================== ToolCall 映射 ====================

/**
 * ToolCall 数据库映射
 */
export class ToolCallMapper {
  /**
   * TypeScript → JSON 字符串
   */
  static toJson(toolCalls: ToolCall[] | undefined): string | null {
    if (!toolCalls || toolCalls.length === 0) {
      return null;
    }
    return JSON.stringify(toolCalls);
  }

  /**
   * JSON 字符串 → TypeScript
   */
  static fromJson(json: string | null | undefined): ToolCall[] | undefined {
    if (!json) {
      return undefined;
    }
    try {
      return JSON.parse(json);
    } catch (error) {
      console.warn('Failed to parse tools_json:', error);
      return undefined;
    }
  }
}

// ==================== 便捷函数 ====================

/**
 * 获取数据库列名（用于 SQL 查询）
 */
export function getDbColumns(entity: 'session_messages' | 'sessions' | 'agents'): string[] {
  const columnMap = {
    session_messages: [
      'id', 'message_id', 'session_key', 'message_type', 'content', 'model',
      'tokens_input', 'tokens_output', 'cost_total', 'cost_input', 'cost_output',
      'tools_json', 'timestamp', 'created_at'
    ],
    sessions: [
      'id', 'session_key', 'agent_id', 'channel', 'account_id',
      'peer_id', 'guild_id', 'created_at', 'updated_at'
    ],
    agents: [
      'id', 'agent_id', 'agent_name', 'config_json', 'status',
      'last_seen_at', 'created_at', 'updated_at'
    ]
  };

  return columnMap[entity] || [];
}

/**
 * 获取占位符（用于 SQL 查询）
 */
export function getPlaceholders(columns: string[]): string {
  return columns.map(() => '?').join(', ');
}