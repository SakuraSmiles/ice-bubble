/**
 * OpenCode → UnifiedMessage 转换器
 *
 * 将 OpenCode 原始 session/message/part 数据转换为 ice-bubble UnifiedMessage 格式。
 *
 * 核心策略：
 * - session 保持原生 ses_xxx 格式作为 sessionKey
 * - message + parts 组合展开为 1-N 条 UnifiedMessage
 * - tool call 通过 callID 内存配对
 * - step-finish 的 tokens/cost 附加到前一条 agent 消息
 */

import type {
    OpenCodeSession,
    OpenCodeMessage,
    OpenCodePart,
    MessageData,
    AssistantMessageData,
    TokenInfo,
    PartData,
    TextPartData,
    ToolPartData,
    ReasoningPartData,
    StepFinishPartData,
    CompactionPartData,
    PatchPartData,
} from '../types/opencode.js';
import type { UnifiedMessage, ToolCall } from '../types/index.js';

// Re-export for convenience
export type { UnifiedMessage, ToolCall } from '../types/index.js';

// ==================== 工具函数 ====================

/**
 * 生成简单的字符串哈希（用于生成唯一 id）
 */
function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * 安全解析 JSON，失败返回 null
 */
function safeParseJson<T>(jsonStr: string): T | null {
    try {
        return JSON.parse(jsonStr) as T;
    } catch {
        return null;
    }
}

// ==================== Session 转换 ====================

/**
 * 将 OpenCode session 转换为 UnifiedMessage 兼容的 session 结构
 *
 * @returns 包含 platform='opencode' 的 session 描述对象
 */
export interface ConvertedSession {
    sessionKey: string;
    title: string;
    agent: string | null;
    model: string | null;
    platform: 'opencode';
    source: 'sqlite';
    directory: string;
    projectWorktree?: string | null;
    projectName?: string | null;
    createdAt: Date;
    updatedAt: Date;
    timeArchived: number | null;
}

/**
 * agent → messageType 的映射（用于 session 级别的默认类型推断）
 */
export function convertSession(
    session: OpenCodeSession,
    primaryAgent?: string | null,
    primaryModel?: string | null,
): ConvertedSession {
    return {
        sessionKey: session.id,
        title: session.title,
        agent: primaryAgent ?? session.agent,
        model: primaryModel ?? session.model,
        platform: 'opencode',
        source: 'sqlite',
        directory: session.directory,
        projectWorktree: session.project_worktree,
        projectName: session.project_name,
        createdAt: new Date(session.time_created),
        updatedAt: new Date(session.time_updated),
        timeArchived: session.time_archived,
    };
}

// ==================== Message 转换 ====================

/**
 * 转换上下文 —— 在处理一组 message 时维护配对状态
 */
export interface ConvertContext {
    /**
     * 待配对的 tool call：callID → 对应的 tool UnifiedMessage
     * 当下一条 user message 携带 tool result 内容时配对
     */
    pendingToolCalls: Map<string, UnifiedMessage>;
}

/**
 * 创建新的转换上下文
 */
export function createConvertContext(): ConvertContext {
    return {
        pendingToolCalls: new Map(),
    };
}

/**
 * 将一条 OpenCode message（含其 parts）转换为 UnifiedMessage[]
 *
 * 一个 message 可能展开为多条 UnifiedMessage（text、tool、reasoning 各一条）。
 * step-finish 不生成独立消息，其 tokens/cost 附加到前一条 agent 消息。
 * step-start 不生成独立消息。
 */
export function convertMessage(
    message: OpenCodeMessage,
    parts: OpenCodePart[],
    ctx: ConvertContext,
): UnifiedMessage[] {
    const msgData = safeParseJson<MessageData>(message.data);
    if (!msgData) return [];

    const results: UnifiedMessage[] = [];
    const sessionKey = message.session_id;
    const timestamp = new Date(message.time_created);

    if (msgData.role === 'user') {
        const userMsgs = convertUserMessageParts(message, parts, sessionKey, timestamp, ctx);
        results.push(...userMsgs);
    } else if (msgData.role === 'assistant') {
        const assistantData = msgData as AssistantMessageData;
        const agentMsgs = convertAssistantMessageParts(
            message, parts, sessionKey, timestamp, assistantData, ctx,
        );
        results.push(...agentMsgs);
    }

    return results;
}

/**
 * 批量转换 messages（按 time_created 排序后依次处理，保证 tool 配对正确）
 */
export function convertMessages(
    messagesWithParts: Array<{ message: OpenCodeMessage; parts: OpenCodePart[] }>,
): UnifiedMessage[] {
    const ctx = createConvertContext();
    // 按 time_created 排序确保 tool call/result 时序正确
    const sorted = [...messagesWithParts].sort(
        (a, b) => a.message.time_created - b.message.time_created,
    );

    const results: UnifiedMessage[] = [];
    for (const { message, parts } of sorted) {
        const msgs = convertMessage(message, parts, ctx);
        results.push(...msgs);
    }

    // 配对完成后，将剩余未配对的 tool call 也加入结果
    for (const pending of ctx.pendingToolCalls.values()) {
        results.push(pending);
    }
    ctx.pendingToolCalls.clear();

    return results;
}

// ==================== User Message 转换 ====================

/**
 * 转换 user message 的 parts
 *
 * 注意：OpenCode 的 tool result 在下一条 user message 中体现。
 * 这里检查 pendingToolCalls：如果当前 user message 的 parts 中有与 pending callID 匹配的内容，
 * 则将 result 附加到对应 tool call 上。
 */
function convertUserMessageParts(
    message: OpenCodeMessage,
    parts: OpenCodePart[],
    sessionKey: string,
    timestamp: Date,
    ctx: ConvertContext,
): UnifiedMessage[] {
    const results: UnifiedMessage[] = [];

    // 配对 pending tool calls，将已配对的消息加入结果
    const pairedTools = pairPendingToolCalls(parts, ctx);
    results.push(...pairedTools);

    // 提取 user message 的 text 内容
    const textParts = parts.filter(p => {
        const d = safeParseJson<PartData>(p.data);
        return d && d.type === 'text';
    });

    if (textParts.length > 0) {
        const textContent = textParts
            .map(p => {
                const d = safeParseJson<TextPartData>(p.data);
                return d?.text ?? '';
            })
            .join('\n');

        const msgData = safeParseJson<MessageData>(message.data);
        const id = buildMessageId(
            sessionKey, message.time_created, 'user', message.id,
        );

        results.push({
            id,
            sessionKey,
            messageType: 'user',
            timestamp,
            source: 'sqlite',
            content: textContent || undefined,
            metadata: {
                agentId: msgData && msgData.role === 'user' ? msgData.agent : undefined,
            },
        });
    } else {
        // user message 无 text parts（可能是纯 tool result 传递），仍生成一条空 user 消息
        const id = buildMessageId(
            sessionKey, message.time_created, 'user', message.id,
        );
        results.push({
            id,
            sessionKey,
            messageType: 'user',
            timestamp,
            source: 'sqlite',
        });
    }

    return results;
}

/**
 * 配对 pending tool calls：检查当前 message 的 parts 是否包含对应 tool result
 *
 * OpenCode 中 tool result 实际嵌入在 tool part 的 state.output 中，
 * 或者在下一个 user message 的 summary.diffs 中。但根据实际数据结构，
 * tool result 直接在 tool part 的 state.output 字段中。
 * 所以配对逻辑改为：遍历 parts 查找 tool part，
 * 如果其 callID 在 pendingToolCalls 中，直接配对。
 */
function pairPendingToolCalls(parts: OpenCodePart[], ctx: ConvertContext): UnifiedMessage[] {
    const paired: UnifiedMessage[] = [];
    for (const _part of parts) {
        const data = safeParseJson<PartData>(_part.data);
        if (!data || data.type !== 'tool') continue;

        const toolData = data as ToolPartData;
        const pending = ctx.pendingToolCalls.get(toolData.callID);
        if (pending) {
            // 将 output 附加到 pending tool call
            if (toolData.state.output && pending.tools) {
                pending.tools[0].result = toolData.state.output;
            }
            // 附加 duration
            if (toolData.state.time && pending.tools) {
                const duration =
                    (toolData.state.time.end ?? 0) - (toolData.state.time.start ?? 0);
                if (duration > 0) {
                    pending.tools[0].durationMs = duration;
                }
            }
            ctx.pendingToolCalls.delete(toolData.callID);
            paired.push(pending);
        }
    }
    return paired;
}

// ==================== Assistant Message 转换 ====================

/**
 * 转换 assistant message 的 parts，展开为多条 UnifiedMessage
 *
 * 处理顺序：
 * 1. step-start → 忽略
 * 2. reasoning → agent message with metadata.reasoning
 * 3. tool → tool message（pending 配对）
 * 4. text → agent message with content
 * 5. step-finish → 附加 tokens/cost 到前一条 agent message
 * 6. compaction → 忽略或标记
 * 7. patch → 附加 metadata
 */
function convertAssistantMessageParts(
    _message: OpenCodeMessage,
    parts: OpenCodePart[],
    sessionKey: string,
    _timestamp: Date,
    assistantData: AssistantMessageData,
    ctx: ConvertContext,
): UnifiedMessage[] {
    const results: UnifiedMessage[] = [];
    let lastAgentMsg: UnifiedMessage | null = null;

    // 从 assistant message data 直接提取 tokens/cost（如果存在）
    const hasTokensInData = !!(assistantData.tokens);
    const hasCostInData = !!(assistantData.cost);

    for (const part of parts) {
        const data = safeParseJson<PartData>(part.data);
        if (!data) continue;

        switch (data.type) {
            case 'step-start':
                // 忽略，不生成独立消息
                break;

            case 'reasoning': {
                const reasoningData = data as ReasoningPartData;
                const msg: UnifiedMessage = {
                    id: buildMessageId(
                        sessionKey, part.time_created, 'agent', part.id,
                    ),
                    sessionKey,
                    messageType: 'agent',
                    timestamp: new Date(part.time_created),
                    source: 'sqlite',
                    content: reasoningData.text,
                    model: assistantData.modelID,
                    metadata: {
                        reasoning: true,
                        agentId: assistantData.agent,
                        mode: assistantData.mode,
                    },
                };
                results.push(msg);
                lastAgentMsg = msg;
                break;
            }

            case 'tool': {
                const toolData = data as ToolPartData;
                const toolCall: ToolCall = {
                    name: toolData.tool,
                    input: toolData.state.input ?? {},
                };

                // 如果 tool 已完成且有 output，直接填入
                if (toolData.state.status === 'completed' && toolData.state.output) {
                    toolCall.result = toolData.state.output;
                }
                if (toolData.state.time) {
                    const duration =
                        (toolData.state.time.end ?? 0) - (toolData.state.time.start ?? 0);
                    if (duration > 0) {
                        toolCall.durationMs = duration;
                    }
                }

                const toolMsg: UnifiedMessage = {
                    id: buildMessageId(
                        sessionKey, part.time_created, 'tool', part.id,
                    ),
                    sessionKey,
                    messageType: 'tool',
                    timestamp: new Date(part.time_created),
                    source: 'sqlite',
                    tools: [toolCall],
                    model: assistantData.modelID,
                    metadata: {
                        agentId: assistantData.agent,
                        mode: assistantData.mode,
                        toolCallID: toolData.callID,
                        toolStatus: toolData.state.status,
                        toolTitle: toolData.state.title,
                    },
                };

                // 如果 tool 未完成或结果不确定，放入 pending 等待配对
                if (toolData.state.status !== 'completed' || !toolData.state.output) {
                    ctx.pendingToolCalls.set(toolData.callID, toolMsg);
                } else {
                    results.push(toolMsg);
                }
                break;
            }

            case 'text': {
                const textData = data as TextPartData;
                const msg: UnifiedMessage = {
                    id: buildMessageId(
                        sessionKey, part.time_created, 'agent', part.id,
                    ),
                    sessionKey,
                    messageType: 'agent',
                    timestamp: new Date(part.time_created),
                    source: 'sqlite',
                    content: textData.text,
                    model: assistantData.modelID,
                    metadata: {
                        agentId: assistantData.agent,
                        mode: assistantData.mode,
                    },
                };
                results.push(msg);
                lastAgentMsg = msg;
                break;
            }

            case 'step-finish': {
                const finishData = data as StepFinishPartData;
                // 附加 tokens/cost 到前一条 agent 消息
                const target = lastAgentMsg;
                if (target) {
                    if (finishData.tokens) {
                        target.tokens = mapTokens(finishData.tokens, finishData.cost);
                    } else if (hasTokensInData && assistantData.tokens) {
                        target.tokens = mapTokens(assistantData.tokens, assistantData.cost);
                    }
                }
                break;
            }

            case 'compaction': {
                // 上下文压缩事件，生成一条标记消息
                const compactionData = data as CompactionPartData;
                const msg: UnifiedMessage = {
                    id: buildMessageId(
                        sessionKey, part.time_created, 'agent', part.id,
                    ),
                    sessionKey,
                    messageType: 'agent',
                    timestamp: new Date(part.time_created),
                    source: 'sqlite',
                    content: '[Context Compaction]',
                    metadata: {
                        compaction: true,
                        autoCompaction: compactionData.auto,
                        mode: assistantData.mode,
                    },
                };
                results.push(msg);
                lastAgentMsg = msg;
                break;
            }

            case 'patch': {
                const patchData = data as PatchPartData;
                const msg: UnifiedMessage = {
                    id: buildMessageId(
                        sessionKey, part.time_created, 'agent', part.id,
                    ),
                    sessionKey,
                    messageType: 'agent',
                    timestamp: new Date(part.time_created),
                    source: 'sqlite',
                    content: `[Patch ${patchData.hash.slice(0, 8)}] ${patchData.files.join(', ')}`,
                    metadata: {
                        patch: true,
                        patchHash: patchData.hash,
                        patchFiles: patchData.files,
                        mode: assistantData.mode,
                    },
                };
                results.push(msg);
                lastAgentMsg = msg;
                break;
            }
        }
    }

    // 如果没有 step-finish part 但 assistantData 自身有 tokens/cost，附加到最后一条 agent 消息
    if (lastAgentMsg && !lastAgentMsg.tokens && (hasTokensInData || hasCostInData)) {
        if (assistantData.tokens) {
            lastAgentMsg.tokens = mapTokens(assistantData.tokens, assistantData.cost);
        }
    }

    return results;
}

// ==================== Token 映射 ====================

/**
 * 将 OpenCode TokenInfo 映射为 UnifiedMessage tokens 格式
 */
function mapTokens(tokenInfo: TokenInfo, cost?: number): UnifiedMessage['tokens'] {
    return {
        input: tokenInfo.input,
        output: tokenInfo.output,
        totalTokens: tokenInfo.total,
        cacheRead: tokenInfo.cache?.read,
        cacheWrite: tokenInfo.cache?.write,
        cost: cost != null
            ? { total: cost }
            : undefined,
    };
}

// ==================== ID 生成 ====================

/**
 * 生成 UnifiedMessage id
 *
 * 格式: opencode:{sessionKey}:{timestamp}:{messageType}:{hash}
 */
function buildMessageId(
    sessionKey: string,
    timestampMs: number,
    messageType: string,
    sourceId: string,
): string {
    const ts = new Date(timestampMs).toISOString();
    const hash = simpleHash(`${sourceId}:${messageType}`);
    return `opencode:${sessionKey}:${ts}:${messageType}:${hash}`;
}
