/**
 * CollectionPipeline - 数据处理管道
 *
 * 职责：
 * - 管理 OpenClaw 事件的处理流水线
 * - 转换 → 验证 → 去重 → 写入
 * - 统计和事件发射
 *
 * @module CollectionPipeline
 */

import { EventEmitter } from 'events';
import { OpenClawEvent, isMessageEvent } from '../types/openclaw.js';
import { SessionMessage, SessionEvent, UnifiedMessage } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { DataValidator } from '../processors/DataValidator.js';
import { Deduplicator } from '../processors/deduplicator.js';
import { BatchWriter } from '../processors/BatchWriter.js';
import { SQLiteManager } from '../storage/sqlite-manager.js';
import { convertOpenClawEvent } from '../converters/openclaw-to-unified.js';
import { parseSessionKey } from '../utils/session-key-builder.js';

const logger = new Logger('CollectionPipeline');

// ==================== 配置接口 ====================

export interface PipelineConfig {
  /** 批量处理大小 */
  batchSize: number;
  /** 从 openclaw.json 配置的 agent_id 集合，用于过滤幽灵 agent */
  configuredAgentIds?: Set<string>;
}

// ==================== 管道统计 ====================

export interface PipelineStats {
  totalEvents: number;
  successEvents: number;
  failedEvents: number;
}

// ==================== 事件接口 ====================

export interface PipelineEvents {
  /** 消息事件 */
  message: UnifiedMessage;
  /** 无效消息事件 */
  invalid: { message: UnifiedMessage; errors: string[] };
  /** 重复消息事件 */
  duplicate: { messageId: string };
  /** 批量刷新事件 */
  'batch:flush': { count: number };
  /** 错误事件 */
  error: Error;
}

// ==================== CollectionPipeline 类 ====================

export class CollectionPipeline extends EventEmitter {
  private stats: PipelineStats = {
    totalEvents: 0,
    successEvents: 0,
    failedEvents: 0,
  };

  /**
   * 构造函数
   *
   * @param sqliteManager - SQLite 管理器
   * @param validator - 数据验证器
   * @param deduplicator - 去重器
   * @param batchWriter - 批量写入器
   * @param config - 管道配置
   */
  constructor(
    private sqliteManager: SQLiteManager,
    private validator: DataValidator,
    private deduplicator: Deduplicator,
    private batchWriter: BatchWriter,
    config?: Partial<PipelineConfig>
  ) {
    super();
    const pipelineConfig = {
      batchSize: 100,
      ...config,
    } as Required<PipelineConfig>;
    this.batchSize = pipelineConfig.batchSize;
    this.configuredAgentIds = pipelineConfig.configuredAgentIds;

    // 监听 BatchWriter 事件，向上转发
    this.batchWriter.on('flush', ({ count }) => {
      this.emit('batch:flush', { count });
      logger.debug(`批量写入完成: ${count} 条消息`);
    });

    this.batchWriter.on('error', (error) => {
      logger.error('BatchWriter 错误', error);
      this.emit('error', error);
    });
  }

  private batchSize: number;
  private configuredAgentIds: Set<string> = new Set();

  // ========== 核心：处理事件管道 ==========

  /**
   * 批量处理 OpenClaw 事件
   *
   * 处理流程：
   * 1. 转换为 UnifiedMessage（convertOpenClawEvent）
   * 2. 数据验证（DataValidator）
   * 3. 去重检查（Deduplicator）
   * 4. 转换为 SessionMessage
   * 5. 批量写入（BatchWriter）
   *
   * @param events - OpenClaw 事件数组
   * @param sessionKey - Session Key
   */
  async processEvents(events: OpenClawEvent[], sessionKey: string): Promise<void> {
    if (events.length === 0) return;

    // 校验 sessionKey 格式
    if (!sessionKey || typeof sessionKey !== 'string' || sessionKey.length < 8) {
      throw new Error(`Invalid sessionKey format: ${sessionKey}`);
    }

    logger.debug(`批量处理 ${events.length} 个事件`);

    // 确保 Session 存在于数据库中（防御性调用，防止外键约束失败）
    await this.ensureSession(sessionKey);

    // 分批处理
    const batches = this.chunkArray(events, this.batchSize);

    for (const batch of batches) {
      for (const event of batch) {
        try {
          this.stats.totalEvents++;

          // 非 message 类型的事件直接存入 session_events 表
          if (!isMessageEvent(event)) {
            const sessionEvent: SessionEvent = {
              session_key: sessionKey,
              event_type: event.type,
              event_id: event.id,
              data_json: JSON.stringify(event),
              timestamp: event.timestamp,
            };
            this.batchWriter.addEvent(sessionEvent);
            this.stats.successEvents++;
            logger.debug(`存储非 message 事件: ${event.type} (${event.id})`);
            continue;
          }

          // 步骤1: 转换为 UnifiedMessage
          const message = convertOpenClawEvent(event, sessionKey);

          if (!message) {
            logger.debug(`事件转换返回 null，跳过: ${event.id}`);
            continue;
          }

          // 步骤1.5: 过滤 Sender metadata 全量版（重复源）
          // OpenClaw 将用户消息写两遍到 JSONL（全量版 + 截断版），在此丢弃全量版
          if (message.metadata?.is_duplicate_source === true) {
            logger.debug(`跳过 Sender metadata 全量版（重复源）: ${message.id}`);
            continue;
          }

          // 步骤2: 数据验证
          const validation = this.validator.validate(message);
          if (!validation.valid) {
            this.stats.failedEvents++;
            this.emit('invalid', { message, errors: validation.errors });
            logger.warn(`消息验证失败: ${message.id}`, { errors: validation.errors });
            continue;
          }

          // 步骤3: 去重检查（ID 级 + 内容级）
          if (this.deduplicator.isDuplicate(message.id)) {
            this.emit('duplicate', { messageId: message.id });
            logger.debug(`重复消息(ID)，跳过: ${message.id}`);
            continue;
          }
          this.deduplicator.markAsProcessed(message.id);

          // 步骤3.5: 内容级去重
          // Gateway subagent_announce 在后续 run 中重新注入已完成 subagent 报告，
          // 产生新 event ID 但内容完全相同。ID 去重无法拦截，需内容级去重。
          if (this.deduplicator.isContentDuplicate(message)) {
            this.emit('duplicate', { messageId: message.id });
            logger.debug(`重复消息(内容)，跳过: ${message.id}`);
            continue;
          }

          // 步骤4: 转换为 SessionMessage 格式
          const sessionMessage: SessionMessage = {
            messageId: message.id, // OpenClaw 原始消息 ID，用于去重
            sessionKey: message.sessionKey,
            messageType: message.messageType,
            content: message.content,
            model: message.model,
            tokensInput: message.tokens?.input,
            tokensOutput: message.tokens?.output,
            costTotal: message.tokens?.cost?.total,
            costInput: message.tokens?.cost?.input,
            costOutput: message.tokens?.cost?.output,
            toolsJson: message.tools ? JSON.stringify(message.tools) : undefined,
            timestamp: message.timestamp,
          };

          // 步骤5: 批量写入
          this.batchWriter.addMessage(sessionMessage);
          this.stats.successEvents++;

          // 发送单条消息事件
          this.emit('message', message);
        } catch (error) {
          this.stats.failedEvents++;
          logger.error(`事件处理失败: ${event.id}`, error as Error);
          this.emit('error', error);
        }
      }
    }

    logger.debug(
      `批量处理完成: 成功 ${this.stats.successEvents}，失败 ${this.stats.failedEvents}`
    );
  }

  // ========== Session 管理 ==========

  /**
   * 确保 Session 存在于数据库中
   *
   * @param sessionKey - Session Key（支持 4/5/6 段格式）
   */
  async ensureSession(sessionKey: string): Promise<void> {
    // 解析 sessionKey（使用 parseSessionKey 支持 4/5/6 段格式）
    const components = parseSessionKey(sessionKey);
    const { agentId, channel, accountId, type: sessionType, targetId: targetIdRaw } = components;

    // 检查 agent 是否在 openclaw.json 配置中，跳过幽灵 agent 的 session
    if (this.configuredAgentIds && !this.configuredAgentIds.has(agentId)) {
      logger.debug(`Agent [${agentId}] 不在配置中，跳过 Session 创建: ${sessionKey}`);
      return;
    }

    // 检查是否已存在
    const existingSession = await this.sqliteManager.getSession(sessionKey);
    if (existingSession) {
      return;
    }

    // 创建新 Session
    const session = {
      sessionKey,
      agentId,
      channel,
      accountId: accountId || undefined,
      peerId: targetIdRaw || undefined,
      guildId: sessionType === 'guild' ? targetIdRaw : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.sqliteManager.upsertSession(session);
    logger.debug(`创建 Session: ${sessionKey}`);
  }

  // ========== 生命周期 ==========

  /** 启动管道 */
  start(): void {
    this.batchWriter.start();
  }

  /** 停止管道（会刷新剩余缓冲区） */
  async stop(): Promise<void> {
    await this.batchWriter.stop();
  }

  // ========== 辅助方法 ==========

  /**
   * 获取统计信息
   */
  getStats(): PipelineStats {
    return { ...this.stats };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalEvents: 0,
      successEvents: 0,
      failedEvents: 0,
    };
    logger.info('Pipeline 统计信息已重置');
  }

  /**
   * 数组分块
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
