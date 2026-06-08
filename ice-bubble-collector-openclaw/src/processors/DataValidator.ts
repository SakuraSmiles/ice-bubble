/**
 * DataValidator - 数据验证器
 * 
 * 负责 UnifiedMessage 数据验证，确保数据质量，防止无效数据写入数据库
 * 
 * @module DataValidator
 */

import { UnifiedMessage } from '../types/index.js';

/**
 * 验证结果接口
 */
export interface ValidationResult {
    /** 是否验证通过 */
    valid: boolean;
    
    /** 错误信息列表 */
    errors?: string[];
}

/**
 * DataValidator 类
 * 
 * 实现 UnifiedMessage 数据验证，包括必填字段、类型、格式、范围等验证
 * 
 * @example
 * const validator = new DataValidator();
 * 
 * // 单条验证
 * const result = validator.validate(message);
 * 
 * // 批量验证
 * const results = validator.validateBatch(messages);
 * 
 * // 过滤有效消息
 * const validMessages = validator.filterValid(messages);
 */
export class DataValidator {
    /** SessionKey 格式正则表达式 */
    private static readonly SESSION_KEY_REGEX = /^agent:[^:]+(:[^:]+){1,}$/;
    
    /** 有效的消息类型 */
    private static readonly VALID_MESSAGE_TYPES = ['user', 'agent', 'tool'] as const;
    
    /** 有效的数据来源 */
    private static readonly VALID_SOURCES = ['websocket', 'file', 'http'] as const;
    
    /** 允许的时间戳时间差（毫秒） */
    private static readonly TIMESTAMP_TOLERANCE_MS = 60000; // 1分钟

    /**
     * 验证 ID 字段
     * @param id - 消息 ID
     * @returns 错误信息，null 表示验证通过
     */
    private validateId(id: unknown): string | null {
        if (id === undefined || id === null) {
            return 'id: 字段必填';
        }
        
        if (typeof id !== 'string') {
            return 'id: 必须为字符串类型';
        }
        
        if (id.length === 0) {
            return 'id: 长度不能为空';
        }
        
        return null;
    }

    /**
     * 验证 SessionKey 字段
     * @param sessionKey - Session Key
     * @returns 错误信息，null 表示验证通过
     */
    private validateSessionKey(sessionKey: unknown): string | null {
        if (sessionKey === undefined || sessionKey === null) {
            return 'sessionKey: 字段必填';
        }
        
        if (typeof sessionKey !== 'string') {
            return 'sessionKey: 必须为字符串类型';
        }
        
        if (!DataValidator.SESSION_KEY_REGEX.test(sessionKey)) {
            return 'sessionKey: 格式不正确，期望格式: agent:xxx:xxx[...]';
        }
        
        return null;
    }

    /**
     * 验证 Timestamp 字段
     * @param timestamp - 消息时间戳
     * @returns 错误信息，null 表示验证通过
     */
    private validateTimestamp(timestamp: unknown): string | null {
        if (timestamp === undefined || timestamp === null) {
            return 'timestamp: 字段必填';
        }
        
        // 检查是否为 Date 对象
        if (!(timestamp instanceof Date)) {
            return 'timestamp: 必须为 Date 类型';
        }
        
        // 检查是否为有效日期
        if (isNaN(timestamp.getTime())) {
            return 'timestamp: 无效的日期对象';
        }
        
        const now = Date.now();
        const timestampMs = timestamp.getTime();
        
        // 时间戳不能为负数
        if (timestampMs < 0) {
            return 'timestamp: 不能为负数';
        }
        
        // 时间戳不能超过当前时间 + 容差（允许1分钟时间差）
        if (timestampMs > now + DataValidator.TIMESTAMP_TOLERANCE_MS) {
            return 'timestamp: 不能超过当前时间';
        }
        
        return null;
    }

    /**
     * 验证 MessageType 字段
     * @param messageType - 消息类型
     * @returns 错误信息，null 表示验证通过
     */
    private validateMessageType(messageType: unknown): string | null {
        if (messageType === undefined || messageType === null) {
            return 'messageType: 字段必填';
        }
        
        if (typeof messageType !== 'string') {
            return 'messageType: 必须为字符串类型';
        }
        
        if (!DataValidator.VALID_MESSAGE_TYPES.includes(messageType as typeof DataValidator.VALID_MESSAGE_TYPES[number])) {
            return `messageType: 值无效，有效值为: ${DataValidator.VALID_MESSAGE_TYPES.join(', ')}`;
        }
        
        return null;
    }

    /**
     * 验证 Source 字段
     * @param source - 数据来源
     * @returns 错误信息，null 表示验证通过
     */
    private validateSource(source: unknown): string | null {
        if (source === undefined || source === null) {
            return 'source: 字段必填';
        }
        
        if (typeof source !== 'string') {
            return 'source: 必须为字符串类型';
        }
        
        if (!DataValidator.VALID_SOURCES.includes(source as typeof DataValidator.VALID_SOURCES[number])) {
            return `source: 值无效，有效值为: ${DataValidator.VALID_SOURCES.join(', ')}`;
        }
        
        return null;
    }

    /**
     * 验证 Content 字段（可选）
     * @param content - 消息内容
     * @returns 错误信息，null 表示验证通过
     */
    private validateContent(content: unknown): string | null {
        // Content 是可选字段，如果不存在则跳过
        if (content === undefined || content === null) {
            return null;
        }
        
        if (typeof content !== 'string') {
            return 'content: 必须为字符串类型';
        }
        
        return null;
    }

    /**
     * 验证 Tokens 字段（可选）
     * @param tokens - Token 统计
     * @returns 错误信息，null 表示验证通过
     */
    private validateTokens(tokens: unknown): string | null {
        // Tokens 是可选字段，如果不存在则跳过
        if (tokens === undefined || tokens === null) {
            return null;
        }

        if (typeof tokens !== 'object' || tokens === null) {
            return 'tokens: 必须为对象类型';
        }

        const tokenObj = tokens as Record<string, unknown>;

        // 验证 input
        if (tokenObj.input !== undefined) {
            if (typeof tokenObj.input !== 'number') {
                return 'tokens.input: 必须为数字类型';
            }
            if (tokenObj.input < 0) {
                return 'tokens.input: 不能为负数';
            }
        }

        // 验证 output
        if (tokenObj.output !== undefined) {
            if (typeof tokenObj.output !== 'number') {
                return 'tokens.output: 必须为数字类型';
            }
            if (tokenObj.output < 0) {
                return 'tokens.output: 不能为负数';
            }
        }

        return null;
    }

    /**
     * 验证 Tools 字段（可选）
     * @param tools - 工具调用列表
     * @returns 错误信息，null 表示验证通过
     */
    private validateTools(tools: unknown): string | null {
        // Tools 是可选字段，如果不存在则跳过
        if (tools === undefined || tools === null) {
            return null;
        }
        
        if (!Array.isArray(tools)) {
            return 'tools: 必须为数组类型';
        }
        
        // 验证每个工具调用
        for (let i = 0; i < tools.length; i++) {
            const tool = tools[i];
            
            if (typeof tool !== 'object' || tool === null) {
                return `tools[${i}]: 必须为对象类型`;
            }
            
            // name 是必填字段
            if (tool.name === undefined || tool.name === null) {
                return `tools[${i}].name: 字段必填`;
            }
            
            if (typeof tool.name !== 'string') {
                return `tools[${i}].name: 必须为字符串类型`;
            }
            
            if (tool.name.length === 0) {
                return `tools[${i}].name: 长度不能为空`;
            }

            // input 字段验证
            // 对于 ToolResult 消息,input 可以是 undefined
            // 对于 ToolCall 消息,input 必须是对象
            if (tool.input !== undefined && tool.input !== null) {
                if (typeof tool.input !== 'object') {
                    return `tools[${i}].input: 必须为对象类型`;
                }
            }

            // result 和 durationMs 是可选字段，如果存在则验证类型
            if (tool.result !== undefined && tool.result !== null && typeof tool.result !== 'object') {
                return `tools[${i}].result: 必须为对象类型`;
            }
            
            if (tool.durationMs !== undefined) {
                if (typeof tool.durationMs !== 'number') {
                    return `tools[${i}].durationMs: 必须为数字类型`;
                }
                if (tool.durationMs < 0) {
                    return `tools[${i}].durationMs: 不能为负数`;
                }
            }
        }
        
        return null;
    }

    /**
     * 验证 Metadata 字段（可选）
     * @param metadata - 元数据
     * @returns 错误信息，null 表示验证通过
     */
    private validateMetadata(metadata: unknown): string | null {
        // Metadata 是可选字段，如果不存在则跳过
        if (metadata === undefined || metadata === null) {
            return null;
        }
        
        if (typeof metadata !== 'object' || metadata === null) {
            return 'metadata: 必须为对象类型';
        }
        
        return null;
    }

    /**
     * 验证单条消息
     * 
     * @param message - 待验证的消息
     * @returns 验证结果
     * 
     * @example
     * const result = validator.validate(message);
     * if (result.valid) {
     *   console.log('验证通过');
     * } else {
     *   console.error('验证失败:', result.errors);
     * }
     */
    validate(message: UnifiedMessage): ValidationResult {
        const errors: string[] = [];
        
        // 验证必填字段
        const idError = this.validateId(message.id);
        if (idError) errors.push(idError);
        
        const sessionKeyError = this.validateSessionKey(message.sessionKey);
        if (sessionKeyError) errors.push(sessionKeyError);
        
        const timestampError = this.validateTimestamp(message.timestamp);
        if (timestampError) errors.push(timestampError);
        
        const messageTypeError = this.validateMessageType(message.messageType);
        if (messageTypeError) errors.push(messageTypeError);
        
        const sourceError = this.validateSource(message.source);
        if (sourceError) errors.push(sourceError);
        
        // 验证可选字段
        const contentError = this.validateContent(message.content);
        if (contentError) errors.push(contentError);
        
        const tokensError = this.validateTokens(message.tokens);
        if (tokensError) errors.push(tokensError);
        
        const toolsError = this.validateTools(message.tools);
        if (toolsError) errors.push(toolsError);
        
        const metadataError = this.validateMetadata(message.metadata);
        if (metadataError) errors.push(metadataError);
        
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }

    /**
     * 批量验证消息
     * 
     * @param messages - 待验证的消息数组
     * @returns 验证结果数组（与输入顺序一一对应）
     * 
     * @example
     * const results = validator.validateBatch(messages);
     * results.forEach((result, index) => {
     *   if (!result.valid) {
     *     console.error(`消息 ${index} 验证失败:`, result.errors);
     *   }
     * });
     */
    validateBatch(messages: UnifiedMessage[]): ValidationResult[] {
        return messages.map(message => this.validate(message));
    }

    /**
     * 过滤无效消息，只保留有效的
     * 
     * @param messages - 待过滤的消息数组
     * @returns 有效消息数组
     * 
     * @example
     * const validMessages = validator.filterValid(messages);
     * console.log(`有效消息: ${validMessages.length}/${messages.length}`);
     */
    filterValid(messages: UnifiedMessage[]): UnifiedMessage[] {
        return messages.filter(message => this.validate(message).valid);
    }

    /**
     * 分离有效和无效消息
     * 
     * @param messages - 待分离的消息数组
     * @returns 包含有效消息和无效消息（带错误信息）的对象
     * 
     * @example
     * const { valid, invalid } = validator.separateValidInvalid(messages);
     * console.log(`有效: ${valid.length}, 无效: ${invalid.length}`);
     * 
     * invalid.forEach(item => {
     *   console.error(`消息 ${item.message.id} 验证失败:`, item.errors);
     * });
     */
    separateValidInvalid(messages: UnifiedMessage[]): {
        valid: UnifiedMessage[];
        invalid: Array<{ message: UnifiedMessage; errors: string[] }>;
    } {
        const valid: UnifiedMessage[] = [];
        const invalid: Array<{ message: UnifiedMessage; errors: string[] }> = [];
        
        for (const message of messages) {
            const result = this.validate(message);
            
            if (result.valid) {
                valid.push(message);
            } else {
                invalid.push({
                    message,
                    errors: result.errors!
                });
            }
        }
        
        return { valid, invalid };
    }
}
