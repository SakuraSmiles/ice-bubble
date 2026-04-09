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

// ==================== SessionMessage 映射 ====================

/**
 * SessionMessage 数据库映射
 */
export class SessionMessageMapper {
  /**
   * TypeScript → 数据库行
   */
  static toDb(message: SessionMessage): Record<string, any> {
    return {
      session_key: message.sessionKey,
      message_type: message.messageType,
      content: message.content || null,
      model: message.model || null,
      tokens_input: message.tokensInput || null,
      tokens_output: message.tokensOutput || null,
      tools_json: message.toolsJson || null,
      timestamp: message.timestamp.toISOString(),
      created_at: message.createdAt?.toISOString() || null
    };
  }

  /**
   * 数据库行 → TypeScript
   */
  static fromDb(row: any): SessionMessage {
    return {
      id: row.id,
      sessionKey: row.session_key,
      messageType: row.message_type,
      content: row.content || undefined,
      model: row.model || undefined,
      tokensInput: row.tokens_input || undefined,
      tokensOutput: row.tokens_output || undefined,
      toolsJson: row.tools_json || undefined,
      timestamp: new Date(row.timestamp),
      createdAt: row.created_at ? new Date(row.created_at) : undefined
    };
  }

  /**
   * 批量转换：TypeScript → 数据库行
   */
  static batchToDb(messages: SessionMessage[]): Record<string, any>[] {
    return messages.map(msg => this.toDb(msg));
  }

  /**
   * 批量转换：数据库行 → TypeScript
   */
  static batchFromDb(rows: any[]): SessionMessage[] {
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
  static toDb(session: Session): Record<string, any> {
    return {
      session_key: session.sessionKey,
      agent_id: session.agentId,
      channel: session.channel,
      account_id: session.accountId || null,
      peer_id: session.peerId || null,
      guild_id: session.guildId || null,
      created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString(),
      message_count: session.messageCount,
      last_message_at: session.lastMessageAt?.toISOString() || null
    };
  }

  /**
   * 数据库行 → TypeScript
   */
  static fromDb(row: any): Session {
    return {
      sessionKey: row.session_key,
      agentId: row.agent_id,
      channel: row.channel,
      accountId: row.account_id || undefined,
      peerId: row.peer_id || undefined,
      guildId: row.guild_id || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : undefined
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
  static toDb(agent: Agent): Record<string, any> {
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
  static fromDb(row: any): Agent {
    return {
      agentId: row.agent_id,
      agentName: row.agent_name || undefined,
      configJson: row.config_json || undefined,
      status: row.status,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : undefined,
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
      'id', 'session_key', 'message_type', 'content', 'model',
      'tokens_input', 'tokens_output', 'tools_json', 'timestamp', 'created_at'
    ],
    sessions: [
      'id', 'session_key', 'agent_id', 'channel', 'account_id',
      'peer_id', 'guild_id', 'created_at', 'updated_at', 'message_count', 'last_message_at'
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