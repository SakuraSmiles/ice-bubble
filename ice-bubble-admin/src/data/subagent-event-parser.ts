/**
 * ice-bubble Admin — Subagent 事件解析引擎
 *
 * 从 Collector 消息中识别 Subagent 派发事件和完成事件，
 * 通过 TaskClient 创建/更新任务。
 *
 * 架构：CollectorMessage → SubagentEventParser → TaskClient → Task API
 *
 * @module data/subagent-event-parser
 */

import type { CollectorMessage } from './collector-client.js';
import { TaskClient } from './task-client.js';
import { logger } from '../utils/index.js';
import { analyzeMessageMeta } from '../utils/message-meta.js';

// ── 接口 ──

export interface SubagentEventParserConfig {
    taskClient: TaskClient;
}

// ── 正则表达式（基于实际消息样本，已在 final-integration-design.md 定稿） ──

/**
 * 匹配 [Subagent Task]: 后的任务描述（跨多行，直到消息末尾）
 *
 * 使用 [\s\S]+$ 匹配任意字符包括换行，$ 锚定到字符串末尾。
 * 捕获组 $1 = 任务描述全文（需 .trim()）
 */
const SUBAGENT_TASK_REGEX = /\[Subagent Task\]:\s*([\s\S]+)$/m;

/**
 * 从 session_key 提取 agent_id
 * 格式: agent:{agent_id}:{channel}:{account}:...
 */
const SESSION_KEY_AGENT_REGEX = /^agent:([^:]+):/;

/**
 * 多行匹配 [Internal task completion event] 块
 *
 * 捕获组：
 *   $1 = session_key
 *   $2 = session_id
 *   $3 = type（固定 "subagent task"）
 *   $4 = task description
 *   $5 = status
 *   $6 = result content（可选，可能不存在）
 *
 * result 区域用非贪婪匹配 + 可选分组，向后兼容无 result 的情况。
 */
const SUBAGENT_COMPLETION_REGEX = new RegExp(
    '\\[Internal task completion event\\]' +
    '\\s*source:\\s*subagent' +
    '\\s*session_key:\\s*(\\S+)' +
    '\\s*session_id:\\s*([\\w-]+)' +
    '\\s*type:\\s*([^\\n]+)' +
    '\\s*task:\\s*([^\\n]+)' +
    '\\s*status:\\s*([^\\n]+)' +
    '(?:[\\s\\S]*?<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>\\s*([\\s\\S]*?)\\s*<<<END_UNTRUSTED_CHILD_RESULT>>>)?'
);

// ── 预过滤 ──

/**
 * 快速预过滤：用 String.includes() 判断是否包含子代理事件标记，
 * 避免对无关消息运行正则引擎。
 */
export function hasSubagentEvent(content: string): boolean {
    // 必须是以关键词开头的独立事件，而不是在文本中间出现（避免将代码讨论中的引用当作事件匹配）
    return content.startsWith('[Subagent Task]:')
        || content.startsWith('[Internal task completion event]');
}

// ── 系统噪音检测 ──

/**
 * 判断消息是否为系统噪音（心跳、执行通知等）
 * 复用 analyzeMessageMeta 的逻辑，确保与 timeline 过滤一致
 */
function isSystemNoise(messageType: string, content: string | null): boolean {
    if (!content) return true;
    const meta = analyzeMessageMeta({ message_type: messageType, content, agent_name: '' });
    return meta.is_system_noise;
}

// ── 解析器 ──

export class SubagentEventParser {
    private taskClient: TaskClient;

    /** 已处理的幂等键集合：`${collectorMessageId}:${eventType}` */
    private processedKeys = new Map<string, number>(); // key → timestamp (ms)

    /** session_id → task_id 映射，用于完成事件反向查找 */
    private sessionIdToTaskId = new Map<string, string>();

    /** 允许处理的 message_type 集合 */
    private readonly ALLOWED_TYPES = new Set(['user', 'agent', 'tool']);

    /** processedKeys 上限，防止无限膨胀 */
    private readonly MAX_PROCESSED_KEYS = 10000;

    /** sessionIdToTaskId 条目最大存活时间（ms），超时后清理 */
    private readonly SESSION_ENTRY_TTL_MS = 10 * 60 * 1000; // 10 分钟

    /** 记录添加时间，用于 TTL 清理 */
    private sessionIdToTaskIdAddedAt = new Map<string, number>();

    constructor(config: SubagentEventParserConfig) {
        this.taskClient = config.taskClient;
    }

    /**
     * 判断消息是否应该跳过
     *
     * 跳过条件：
     *   - message_type 不在允许列表中（user/agent/tool）
     *   - content 为空
     *   - 系统噪音（heartbeat、执行通知等）
     */
    private shouldSkip(message: CollectorMessage): boolean {
        if (!this.ALLOWED_TYPES.has(message.message_type)) return true;
        if (!message.content) return true;
        if (isSystemNoise(message.message_type, message.content)) return true;
        return false;
    }

    /**
     * 幂等检查
     * @returns true 表示已处理过，应跳过
     */
    private isProcessed(messageId: number | null, eventType: string): boolean {
        if (messageId === null) return false;
        const key = `${messageId}:${eventType}`;
        if (this.processedKeys.has(key)) return true;
        this.processedKeys.set(key, Date.now());

        // 超过上限，清理最旧的 20%
        if (this.processedKeys.size > this.MAX_PROCESSED_KEYS) {
            const entries = Array.from(this.processedKeys.entries());
            entries.sort((a, b) => a[1] - b[1]);
            const toRemove = entries.slice(0, Math.floor(this.MAX_PROCESSED_KEYS * 0.2));
            for (const [k] of toRemove) this.processedKeys.delete(k);
        }
        return false;
    }

    /**
     * 从 content 中提取任务标题
     * 规则：
     *   - 用正则 /^##\s+(.+)/m 匹配第一行 Markdown 标题 → group 1 作为标题
     *   - 如果匹配不到（fallback），取 content 前 60 字符
     *   - 标题最多 60 字符
     */
    private extractTaskTitle(content: string): string {
        const mdTitleMatch = content.match(/^##\s+(.+)/m);
        let title: string;
        if (mdTitleMatch) {
            title = mdTitleMatch[1].trim();
        } else {
            title = content.substring(0, 60).trim();
        }
        // 最多 60 字符
        if (title.length > 60) {
            title = title.substring(0, 60);
        }
        return title;
    }

    /**
     * 处理派发事件：提取任务标题 → 调用 TaskClient.createTask
     */
    private async handleTaskDispatch(message: CollectorMessage): Promise<boolean> {
        const content = message.content;
        if (!content) return false;

        const match = content.match(SUBAGENT_TASK_REGEX);
        if (!match) return false;

        const rawTaskTitle = match[1].trim();
        const taskTitle = this.extractTaskTitle(rawTaskTitle);
        const agentMatch = message.session_key.match(SESSION_KEY_AGENT_REGEX);
        const agentId = agentMatch ? agentMatch[1] : 'unknown';

        const result = await this.taskClient.createTaskWithSessionId({
            title: taskTitle,
            agent_id: agentId,
            description: rawTaskTitle,
        }, message.session_key);

        if (result) {
            // 记录 session_key → task_id 映射，供完成事件反向查找
            this.sessionIdToTaskId.set(message.session_key, result.id!);
            this.sessionIdToTaskIdAddedAt.set(message.session_key, Date.now());
            logger.debug(`[SubagentEventParser] 任务创建成功: ${result.id} | agent=${agentId} | title=${taskTitle.substring(0, 50)}`);
            return true;
        }

        logger.warn(`[SubagentEventParser] 任务创建失败（Task API 不可用）: agent=${agentId} | msgId=${message.id}`);
        return false;
    }

    /**
     * 处理完成事件：提取 session_id/status → 调用 TaskClient.updateTaskStatus
     */
    private async handleCompletion(message: CollectorMessage): Promise<boolean> {
        const content = message.content;
        if (!content) return false;

        const match = content.match(SUBAGENT_COMPLETION_REGEX);
        if (!match) return false;

        const childSessionKey = match[1];
        const status = match[5].trim();

        // 优先用内存映射查找 task_id
        let taskId: string | null | undefined = this.sessionIdToTaskId.get(childSessionKey);

        // 映射未命中时，通过 Task API 反向查找
        if (!taskId) {
            const agentMatch = childSessionKey.match(SESSION_KEY_AGENT_REGEX);
            const agentId = agentMatch ? agentMatch[1] : null;
            if (agentId) {
                taskId = await this.taskClient.lookupTaskBySessionId(agentId, childSessionKey);
            }
        }

        if (!taskId) {
            logger.warn(`[SubagentEventParser] 完成事件未找到对应任务: sessionKey=${childSessionKey} | msgId=${message.id}`);
            return false;
        }

        const updated = await this.taskClient.updateTaskStatus(taskId, status);
        if (updated) {
            // 清理映射，释放内存
            this.sessionIdToTaskId.delete(childSessionKey);
            logger.debug(`[SubagentEventParser] 任务状态更新成功: ${taskId} -> ${status}`);
            return true;
        }

        logger.warn(`[SubagentEventParser] 任务状态更新失败: taskId=${taskId} | msgId=${message.id}`);
        return false;
    }

    /**
     * 解析一批消息，返回统计结果
     *
     * 处理流程：
     *   1. 预过滤（includes 快速跳过）
     *   2. shouldSkip 过滤（非 user / 空内容 / 系统噪音）
     *   3. 幂等检查
     *   4. 派发事件 → 创建任务
     *   5. 完成事件 → 更新任务状态
     *
     * 所有错误内部 catch，不向外抛异常。
     *
     * @param messages Collector 消息数组
     * @param sourceModule 来源模块标识（用于日志）
     * @returns 处理统计 { created, updated, errors }
     */
    /** 仅处理创建时间在设定范围内的消息（跳过历史重放） */
    private readonly MAX_AGE_MS = 5 * 60 * 1000; // 5 分钟

    /**
     * 清理过期的 sessionIdToTaskId 条目（TTL 驱动）
     * 在每批处理开始前调用，防止长运行时内存持续增长
     */
    private pruneSessionMappings(): void {
        const now = Date.now();
        for (const [sessionKey, addedAt] of this.sessionIdToTaskIdAddedAt) {
            if (now - addedAt > this.SESSION_ENTRY_TTL_MS) {
                this.sessionIdToTaskId.delete(sessionKey);
                this.sessionIdToTaskIdAddedAt.delete(sessionKey);
            }
        }
    }

    async parseBatch(messages: CollectorMessage[], sourceModule: string): Promise<{
        created: number;
        updated: number;
        errors: number;
    }> {
        let created = 0;
        let updated = 0;
        let errors = 0;
        const now = Date.now();

        // 批次开始前清理过期映射，防止内存持续增长
        this.pruneSessionMappings();

        for (const message of messages) {
            // 时间过滤：跳过超过 5 分钟的旧消息（防止历史重放创建脏数据）
            const msgTime = new Date(message.created_at || message.timestamp || now).getTime();
            if (now - msgTime > this.MAX_AGE_MS) continue;
            try {
                // 1. shouldSkip：过滤非 user / 空内容 / 系统噪音
                if (this.shouldSkip(message)) continue;

                const content = message.content;
                if (!content) continue;

                // 2. 预过滤：快速跳过不含子代理事件的消息
                if (!hasSubagentEvent(content)) continue;

                // 3. 派发事件处理
                if (content.includes('[Subagent Task]:')) {
                    if (this.isProcessed(message.id, 'subagent_task_dispatch')) continue;
                    const ok = await this.handleTaskDispatch(message);
                    if (ok) created++;
                    else errors++;
                }

                // 4. 完成事件处理
                if (content.includes('[Internal task completion event]')) {
                    if (this.isProcessed(message.id, 'subagent_task_completion')) continue;
                    const ok = await this.handleCompletion(message);
                    if (ok) updated++;
                    else errors++;
                }
            } catch (err) {
                errors++;
                logger.warn(`[SubagentEventParser] 消息解析异常 [${sourceModule}] msgId=${message.id}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (created > 0 || updated > 0) {
            logger.info(`[SubagentEventParser] [${sourceModule}] 批次处理完成: created=${created}, updated=${updated}, errors=${errors}`);
        }

        return { created, updated, errors };
    }

    /**
     * 获取已处理键的数量（用于监控/调试）
     */
    getProcessedCount(): number {
        return this.processedKeys.size;
    }

    /**
     * 获取待完成映射的数量（用于监控/调试）
     */
    getPendingCompletionCount(): number {
        return this.sessionIdToTaskId.size;
    }

    /**
     * 强制清理所有内存中的映射（用于测试或资源重置）
     */
    clearMemory(): void {
        this.processedKeys.clear();
        this.sessionIdToTaskId.clear();
        this.sessionIdToTaskIdAddedAt.clear();
    }
}
