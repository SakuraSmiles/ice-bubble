/**
 * ice-bubble Admin - 数据管理仓库（Facade 聚合门面）
 *
 * 负责 admin_sessions, admin_messages, admin_agents, sync_progress 表的 CRUD 操作。
 *
 * 内部按领域拆分为子 Repository：
 * - SessionRepository  → admin_sessions
 * - MessageRepository  → admin_messages + admin_tool_calls
 * - TimelineRepository → 多表 JOIN 时间线查询
 * - AgentRepository    → admin_agents
 * - ActivityRepository → agent_activity_daily
 * - TokenSummaryRepository → token_summary
 * - StatsRepository    → 统计、同步、归档
 *
 * DataRepository 对外保持与拆分前完全一致的 API 签名。
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import {
  SessionRepository,
  MessageRepository,
  TimelineRepository,
  AgentRepository,
  ActivityRepository,
  TokenSummaryRepository,
  StatsRepository,
} from './repositories/index.js';

// ========== 类型定义（保持原有导出，外部无感知） ==========

export interface AdminSession {
  session_key: string;
  source_module: string;
  agent_id: string | null;
  channel: string | null;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  source_created_at: string | null;
  label: string | null;
  session_status: string | null;
  model: string | null;
  model_provider: string | null;
  spawned_by: string | null;
  spawn_depth: number | null;
  platform: string;
}

export interface AdminMessage {
  id?: number;
  source_id: number | null;
  source_module: string;
  session_key: string;
  message_type: string | null;
  content: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_total: number | null;
  cost_input: number | null;
  cost_output: number | null;
  is_system_context?: number;
  timestamp: string;
  created_at: string;
  source_created_at: string | null;
  platform?: string;
}

/**
 * admin_tool_calls 表 row 类型
 * 与 AdminMessage 共享大部分字段，但使用 created_at 而非 timestamp
 * 合并查询时会 AS created_at AS timestamp 以统一字段名
 */
export interface AdminToolCall {
  id?: number;
  source_id: string;
  source_module: string;
  session_key: string;
  message_type: 'tool';
  content: string | null;
  created_at: string;
  timestamp?: string; // AS created_at AS timestamp，合并时使用
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_total: number | null;
  cost_input: number | null;
  cost_output: number | null;
  metadata: string | null;
  tool_name: string | null;
  tool_input: string | null;
}

export interface AdminAgent {
  agent_id: string;
  agent_name: string | null;
  workspace: string | null;
  session_count: number;
  message_count: number;
  first_active_at: string | null;
  last_active_at: string | null;
  model: string | null;
  avatar: string | null;
  source: string; // 采集器/平台来源，如 'openclaw'
  platform?: string;
  updated_at: string;
}

export interface SyncProgress {
  id?: number;
  table_name: string;
  last_sync_time: string | null;
  updated_at: string;
}

// ========== Timeline 类型 ==========

export interface TimelineMessage {
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
  /** 是否是系统噪音（执行通知/heartbeat等） */
  is_system_noise: boolean;
  /** 消息来源渠道（从 Sender metadata 解析，如 openclaw-control-ui） */
  source_channel: string | null;
  /** 消息使用的模型 */
  model: string | null;
  timestamp: string;
}

// ========== 数据仓库（Facade） ==========

export class DataRepository {
  private db: Database;
  private avatarsDir: string;

  private sessionRepo: SessionRepository;
  private messageRepo: MessageRepository;
  private timelineRepo: TimelineRepository;
  private agentRepo: AgentRepository;
  private activityRepo: ActivityRepository;
  private tokenSummaryRepo: TokenSummaryRepository;
  private statsRepo: StatsRepository;

  constructor(db: Database, avatarsDir: string) {
    this.db = db;
    this.avatarsDir = avatarsDir;

    // 初始化子 Repository（顺序取决于依赖）
    this.sessionRepo = new SessionRepository(db);
    this.tokenSummaryRepo = new TokenSummaryRepository(db);
    this.messageRepo = new MessageRepository(db, this.sessionRepo, this.tokenSummaryRepo);
    this.timelineRepo = new TimelineRepository(db, this.sessionRepo);
    this.agentRepo = new AgentRepository(db);
    this.activityRepo = new ActivityRepository(db);
    this.statsRepo = new StatsRepository(db);
  }

  /** 获取底层 Database 连接（仅供需要直接 SQL 访问的组件使用） */
  getDb(): Database {
    return this.db;
  }

  // ========== Avatar Files ==========

  /**
   * 获取头像文件
   * @param filename 头像文件名
   * @returns 文件数据 { buffer, contentType } 或 null
   */
  getAvatar(filename: string): { buffer: Buffer; contentType: string } | null {
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return null; // 防止路径遍历攻击
    }
    
    const filePath = path.join(this.avatarsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const ext = path.extname(filename).toLowerCase().slice(1);
    const contentType = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
    }[ext] || 'application/octet-stream';
    
    try {
      const buffer = fs.readFileSync(filePath);
      return { buffer, contentType };
    } catch {
      return null;
    }
  }

  // ========== Sessions（委托 SessionRepository） ==========

  saveSessions(sessions: AdminSession[]): void {
    return this.sessionRepo.saveSessions(sessions);
  }

  getSessions(params: {
    limit?: number;
    offset?: number;
    agent_id?: string;
    channel?: string;
    platform?: string;
  } = {}): { sessions: AdminSession[]; total: number } {
    return this.sessionRepo.getSessions(params);
  }

  getSession(sessionKey: string): AdminSession | null {
    return this.sessionRepo.getSession(sessionKey);
  }

  resolveSessionKey(sessionKey: string): string[] {
    return this.sessionRepo.resolveSessionKey(sessionKey);
  }

  getAllAdminSessions(): string[] {
    return this.sessionRepo.getAllAdminSessions();
  }

  getSessionTimestamps(): Map<string, { created_at: string | null; last_message_at: string | null }> {
    return this.sessionRepo.getSessionTimestamps();
  }

  getAdminSessionsForAgent(agentId: string): string[] {
    return this.sessionRepo.getAdminSessionsForAgent(agentId);
  }

  getSubagentTasks(params: {
    limit?: number;
    offset?: number;
    agent_id?: string;
    status?: string;
  } = {}): { tasks: Array<Pick<AdminSession, 'session_key' | 'label' | 'agent_id' | 'session_status' | 'spawned_by' | 'spawn_depth' | 'created_at' | 'last_message_at' | 'first_message_at' | 'message_count'>>; total: number } {
    return this.sessionRepo.getSubagentTasks(params);
  }

  getGroupedSessions(limitPerAgent?: number, offset?: number): { agentId: string; totalCount: number; sessions: AdminSession[] }[] {
    return this.sessionRepo.getGroupedSessions(limitPerAgent, offset);
  }

  getSessionAgentIds(sessionKeys: string[]): Map<string, string> {
    return this.sessionRepo.getSessionAgentIds(sessionKeys);
  }

  computeSessionStatsIncremental(sessionKeys: string[]): number {
    return this.sessionRepo.computeSessionStatsIncremental(sessionKeys);
  }

  getSessionLastMessageMap(): Map<string, { last_message: string | null; message_count: number }> {
    return this.sessionRepo.getSessionLastMessageMap();
  }

  getSessionFirstMessageMap(): Map<string, { first_message: string | null }> {
    return this.sessionRepo.getSessionFirstMessageMap();
  }

  /** @deprecated Use getSessionLastMessageMap instead */
  getAgentLastMessageMap(): Map<string, { last_message: string | null; message_count: number }> {
    return this.sessionRepo.getAgentLastMessageMap();
  }

  // ========== Token Summary（委托 TokenSummaryRepository） ==========

  getTokenSummary(agentId?: string, date?: string): Array<{
    agent_id: string;
    date: string;
    total_tokens_input: number;
    total_tokens_output: number;
    total_cost: number;
    cost_input: number;
    cost_output: number;
    message_count: number;
    updated_at: string;
  }> {
    return this.tokenSummaryRepo.getTokenSummary(agentId, date);
  }

  rebuildTokenSummary(): { affected_agents: number; duration_ms: number } {
    return this.tokenSummaryRepo.rebuildTokenSummary();
  }

  // ========== Messages（委托 MessageRepository） ==========

  saveMessages(messages: AdminMessage[]): number {
    return this.messageRepo.saveMessages(messages);
  }

  getMessages(params: {
    session_key?: string;
    limit?: number;
    offset?: number;
  } = {}): { messages: AdminMessage[]; total: number } {
    return this.messageRepo.getMessages(params);
  }

  getLatestAgentMessages(agentIds: string[]): Map<string, string | null> {
    return this.messageRepo.getLatestAgentMessages(agentIds);
  }

  deduplicateAdminMessages(): number {
    return this.messageRepo.deduplicateAdminMessages();
  }

  // ========== Timeline（委托 TimelineRepository） ==========

  getMessagesTimeline(params: {
    limit?: number;
    before?: string;
    since?: string;
    agent_ids?: string[];
    session_key?: string;
    message_types?: string;
    search?: string;
    exclude_system_noise?: boolean;
    exclude_cron?: boolean;
  } = {}): {
    messages: TimelineMessage[];
    has_more: boolean;
    pagination: { oldest: string | null; newest: string | null; total_in_range: number };
    meta: { agents_in_range: string[]; filter_applied: Record<string, unknown> };
  } {
    return this.timelineRepo.getMessagesTimeline(params);
  }

  // ========== Agents（委托 AgentRepository） ==========

  refreshAgents(collectorAgents: import('../data/collector-client.js').CollectorAgent[], sourceModule?: string, platform?: string): void {
    return this.agentRepo.refreshAgents(collectorAgents, sourceModule, platform);
  }

  getAgentsMap(): Map<string, { agent_name: string | null; avatar: string | null }> {
    return this.agentRepo.getAgentsMap();
  }

  getAgents(): AdminAgent[] {
    return this.agentRepo.getAgents();
  }

  getAgentAvatar(agentId: string): string | null {
    return this.agentRepo.getAgentAvatar(agentId);
  }

  updateAgentAvatar(agentId: string, avatar: string | null): void {
    return this.agentRepo.updateAgentAvatar(agentId, avatar);
  }

  getAgentsWithActivity(days?: number): (AdminAgent & { activity: { date: string; count: number }[] })[] {
    return this.agentRepo.getAgentsWithActivity(days);
  }

  computeAgentStatsIncremental(agentIds: string[]): number {
    return this.agentRepo.computeAgentStatsIncremental(agentIds);
  }

  // ========== Agent Activity（委托 ActivityRepository） ==========

  updateAgentActivity(agentId: string, date: string, delta?: number): void {
    return this.activityRepo.updateAgentActivity(agentId, date, delta);
  }

  upsertAgentActivityBatch(records: { agentId: string; date: string; count: number }[]): void {
    return this.activityRepo.upsertAgentActivityBatch(records);
  }

  rebuildAgentActivity(): { count: number; error?: string } {
    return this.activityRepo.rebuildAgentActivity();
  }

  getAgentActivity(agentId: string, days?: number): { date: string; count: number }[] {
    return this.activityRepo.getAgentActivity(agentId, days);
  }

  // ========== Stats / Sync / Archive（委托 StatsRepository） ==========

  getStats(): {
    sessionCount: number;
    messageCount: number;
    agentCount: number;
    todayMessageCount: number;
    lastSyncTime: string | null;
  } {
    return this.statsRepo.getStats();
  }

  getSystemStatus(): { todayFiltered: number; lastCompaction: string | null; lastMemoryFlush: string | null; todayRetryCount: number; todayModelChangeCount: number } {
    return this.statsRepo.getSystemStatus();
  }

  getSyncProgress(tableName: string): SyncProgress | null {
    return this.statsRepo.getSyncProgress(tableName);
  }

  updateSyncProgress(tableName: string, lastDataTimestamp?: string | number): void {
    return this.statsRepo.updateSyncProgress(tableName, lastDataTimestamp);
  }

  saveModelEvents(events: Array<{
    session_key: string;
    event_type: string;
    event_id: string | null;
    data_json: string;
    timestamp: string;
  }>): number {
    return this.statsRepo.saveModelEvents(events);
  }

  archiveOldToolCalls(daysToKeep?: number): number {
    return this.statsRepo.archiveOldToolCalls(daysToKeep);
  }

  archiveOldMessages(daysToKeep?: number): number {
    return this.statsRepo.archiveOldMessages(daysToKeep);
  }

  vacuumIfNeeded(): void {
    return this.statsRepo.vacuumIfNeeded();
  }

  getArchivedMessages(params: {
    session_key?: string;
    limit?: number;
    offset?: number;
  } = {}): { messages: AdminMessage[]; total: number } {
    return this.statsRepo.getArchivedMessages(params);
  }

  startArchiveScheduler(daysToKeep?: number, onComplete?: (count: number) => void): NodeJS.Timeout {
    return this.statsRepo.startArchiveScheduler(daysToKeep, onComplete);
  }

  rebuildSessionMessageCounts(): number {
    return this.statsRepo.rebuildSessionMessageCounts();
  }
}
