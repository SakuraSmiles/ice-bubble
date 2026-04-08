/**
 * DataValidator 单元测试
 */

import { DataValidator, ValidationResult } from '../../../src/processors/DataValidator';
import { UnifiedMessage } from '../../../src/types';

describe('DataValidator', () => {
    let validator: DataValidator;

    // 创建有效的测试消息
    const createValidMessage = (overrides?: Partial<UnifiedMessage>): UnifiedMessage => ({
        id: 'agent:agent-001:discord:acc-123:direct:peer-456:2026-04-08T10:00:00Z:user:a1b2c3',
        sessionKey: 'agent:agent-001:discord:acc-123:direct:peer-456',
        messageType: 'user',
        timestamp: new Date(),
        source: 'websocket',
        content: '测试消息',
        ...overrides
    });

    beforeEach(() => {
        validator = new DataValidator();
    });

    describe('✅ 有效消息验证', () => {
        test('有效消息应该通过验证', () => {
            const message = createValidMessage();
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        test('包含可选字段的有效消息应该通过验证', () => {
            const message = createValidMessage({
                tokens: { input: 100, output: 50 },
                tools: [
                    {
                        name: 'read_file',
                        input: { path: '/test/file.txt' },
                        result: { content: 'test' },
                        durationMs: 150
                    }
                ],
                metadata: {
                    userId: 'user-789',
                    agentId: 'agent-001'
                }
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        test('Guild 类型的 SessionKey 应该通过验证', () => {
            const message = createValidMessage({
                sessionKey: 'agent:agent-001:discord:acc-123:guild:channel-789'
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
        });
    });

    describe('❌ 必填字段验证', () => {
        test('缺少 id 字段时应该验证失败', () => {
            const message = createValidMessage();
            delete (message as any).id;
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('id: 字段必填');
        });

        test('缺少 sessionKey 字段时应该验证失败', () => {
            const message = createValidMessage();
            delete (message as any).sessionKey;
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('sessionKey: 字段必填');
        });

        test('缺少 timestamp 字段时应该验证失败', () => {
            const message = createValidMessage();
            delete (message as any).timestamp;
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('timestamp: 字段必填');
        });

        test('缺少 messageType 字段时应该验证失败', () => {
            const message = createValidMessage();
            delete (message as any).messageType;
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('messageType: 字段必填');
        });

        test('缺少 source 字段时应该验证失败', () => {
            const message = createValidMessage();
            delete (message as any).source;
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('source: 字段必填');
        });
    });

    describe('❌ 字段类型验证', () => {
        test('id 类型错误时应该验证失败', () => {
            const message = createValidMessage({ id: 123 as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('id: 必须为字符串类型');
        });

        test('sessionKey 类型错误时应该验证失败', () => {
            const message = createValidMessage({ sessionKey: 123 as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('sessionKey: 必须为字符串类型');
        });

        test('timestamp 类型错误时应该验证失败', () => {
            const message = createValidMessage({ timestamp: '2026-04-08' as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('timestamp: 必须为 Date 类型');
        });

        test('messageType 类型错误时应该验证失败', () => {
            const message = createValidMessage({ messageType: 123 as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('messageType: 必须为字符串类型');
        });

        test('source 类型错误时应该验证失败', () => {
            const message = createValidMessage({ source: 123 as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('source: 必须为字符串类型');
        });
    });

    describe('❌ SessionKey 格式验证', () => {
        test('SessionKey 格式错误时应该验证失败', () => {
            const invalidFormats = [
                'invalid-key',
                'agent:agent-001',
                'agent:agent-001:discord',
                'agent:agent-001:discord:acc-123',
                'agent:agent-001:discord:acc-123:invalid:peer-456', // invalid type
                ''
            ];
            
            invalidFormats.forEach(format => {
                const message = createValidMessage({ sessionKey: format });
                const result = validator.validate(message);
                
                expect(result.valid).toBe(false);
                expect(result.errors).toBeDefined();
                expect(result.errors!.some(err => err.includes('sessionKey: 格式不正确'))).toBe(true);
            });
        });
    });

    describe('❌ MessageType 值验证', () => {
        test('messageType 值无效时应该验证失败', () => {
            const invalidTypes = ['invalid', 'USER', 'Agent', 'TOOL', ''];
            
            invalidTypes.forEach(type => {
                const message = createValidMessage({ messageType: type as any });
                const result = validator.validate(message);
                
                expect(result.valid).toBe(false);
                expect(result.errors).toBeDefined();
                expect(result.errors!.some(err => err.includes('messageType: 值无效'))).toBe(true);
            });
        });

        test('有效的 messageType 值应该通过验证', () => {
            const validTypes = ['user', 'agent', 'tool'] as const;
            
            validTypes.forEach(type => {
                const message = createValidMessage({ messageType: type });
                const result = validator.validate(message);
                
                expect(result.valid).toBe(true);
            });
        });
    });

    describe('❌ Source 值验证', () => {
        test('source 值无效时应该验证失败', () => {
            const invalidSources = ['invalid', 'WEBSOCKET', 'File', 'HTTP', ''];
            
            invalidSources.forEach(source => {
                const message = createValidMessage({ source: source as any });
                const result = validator.validate(message);
                
                expect(result.valid).toBe(false);
                expect(result.errors).toBeDefined();
                expect(result.errors!.some(err => err.includes('source: 值无效'))).toBe(true);
            });
        });

        test('有效的 source 值应该通过验证', () => {
            const validSources = ['websocket', 'file', 'http'] as const;
            
            validSources.forEach(source => {
                const message = createValidMessage({ source });
                const result = validator.validate(message);
                
                expect(result.valid).toBe(true);
            });
        });
    });

    describe('❌ Timestamp 范围验证', () => {
        test('timestamp 为无效日期时应该验证失败', () => {
            const message = createValidMessage({ timestamp: new Date('invalid') });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('timestamp: 无效的日期对象');
        });

        test('timestamp 超过当前时间 + 1分钟时应该验证失败', () => {
            const futureDate = new Date(Date.now() + 120000); // 当前时间 + 2分钟
            const message = createValidMessage({ timestamp: futureDate });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('timestamp: 不能超过当前时间');
        });

        test('timestamp 为过去时间时应该通过验证', () => {
            const pastDate = new Date(Date.now() - 3600000); // 1小时前
            const message = createValidMessage({ timestamp: pastDate });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
        });
    });

    describe('❌ Tokens 验证', () => {
        test('tokens 类型错误时应该验证失败', () => {
            const message = createValidMessage({ tokens: 'invalid' as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tokens: 必须为对象类型');
        });

        test('tokens.input 为负数时应该验证失败', () => {
            const message = createValidMessage({ tokens: { input: -100, output: 50 } });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tokens.input: 不能为负数');
        });

        test('tokens.output 为负数时应该验证失败', () => {
            const message = createValidMessage({ tokens: { input: 100, output: -50 } });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tokens.output: 不能为负数');
        });

        test('tokens.input 类型错误时应该验证失败', () => {
            const message = createValidMessage({ tokens: { input: '100' as any, output: 50 } });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tokens.input: 必须为数字类型');
        });

        test('tokens.output 类型错误时应该验证失败', () => {
            const message = createValidMessage({ tokens: { input: 100, output: '50' as any } });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tokens.output: 必须为数字类型');
        });

        test('tokens 为有效值时应该通过验证', () => {
            const message = createValidMessage({ tokens: { input: 100, output: 50 } });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
        });
    });

    describe('❌ Tools 验证', () => {
        test('tools 类型错误时应该验证失败', () => {
            const message = createValidMessage({ tools: 'invalid' as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools: 必须为数组类型');
        });

        test('tools 元素类型错误时应该验证失败', () => {
            const message = createValidMessage({ tools: ['invalid'] as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0]: 必须为对象类型');
        });

        test('tools 缺少 name 字段时应该验证失败', () => {
            const message = createValidMessage({
                tools: [{ input: { path: '/test' } } as any]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0].name: 字段必填');
        });

        test('tools.name 为空字符串时应该验证失败', () => {
            const message = createValidMessage({
                tools: [{ name: '', input: { path: '/test' } }]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0].name: 长度不能为空');
        });

        test('tools 缺少 input 字段时应该验证通过（ToolResult 场景）', () => {
            // input 字段已改为可选（支持 ToolResult 消息没有 input）
            const message = createValidMessage({
                tools: [{ name: 'read_file', result: { status: 'completed' } }] as any
            });

            const result = validator.validate(message);

            // input 可选，所以缺少 input 不应报错
            expect(result.valid).toBe(true);
        });

        test('tools.input 类型错误时应该验证失败', () => {
            const message = createValidMessage({
                tools: [{ name: 'read_file', input: 'invalid' as any }]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0].input: 必须为对象类型');
        });

        test('tools.durationMs 为负数时应该验证失败', () => {
            const message = createValidMessage({
                tools: [{
                    name: 'read_file',
                    input: { path: '/test' },
                    durationMs: -100
                }]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0].durationMs: 不能为负数');
        });

        test('tools.durationMs 类型错误时应该验证失败', () => {
            const message = createValidMessage({
                tools: [{
                    name: 'read_file',
                    input: { path: '/test' },
                    durationMs: '100' as any
                }]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('tools[0].durationMs: 必须为数字类型');
        });

        test('有效的 tools 应该通过验证', () => {
            const message = createValidMessage({
                tools: [
                    {
                        name: 'read_file',
                        input: { path: '/test/file.txt' },
                        result: { content: 'test' },
                        durationMs: 150
                    }
                ]
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
        });
    });

    describe('❌ Metadata 验证', () => {
        test('metadata 类型错误时应该验证失败', () => {
            const message = createValidMessage({ metadata: 'invalid' as any });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('metadata: 必须为对象类型');
        });

        test('有效的 metadata 应该通过验证', () => {
            const message = createValidMessage({
                metadata: {
                    userId: 'user-789',
                    agentId: 'agent-001',
                    customField: 'value'
                }
            });
            
            const result = validator.validate(message);
            
            expect(result.valid).toBe(true);
        });
    });

    describe('✅ 批量验证功能', () => {
        test('批量验证应该返回正确的结果数组', () => {
            const messages = [
                createValidMessage(), // 有效
                createValidMessage({ id: '' }), // 无效
                createValidMessage(), // 有效
                createValidMessage({ sessionKey: 'invalid' }), // 无效
            ];
            
            const results = validator.validateBatch(messages);
            
            expect(results).toHaveLength(4);
            expect(results[0].valid).toBe(true);
            expect(results[1].valid).toBe(false);
            expect(results[2].valid).toBe(true);
            expect(results[3].valid).toBe(false);
        });
    });

    describe('✅ 过滤无效消息功能', () => {
        test('filterValid 应该只返回有效消息', () => {
            const messages = [
                createValidMessage(), // 有效
                createValidMessage({ id: '' }), // 无效
                createValidMessage(), // 有效
                createValidMessage({ sessionKey: 'invalid' }), // 无效
            ];
            
            const validMessages = validator.filterValid(messages);
            
            expect(validMessages).toHaveLength(2);
            expect(validMessages[0]).toBe(messages[0]);
            expect(validMessages[1]).toBe(messages[2]);
        });

        test('所有消息都有效时应该返回全部', () => {
            const messages = [
                createValidMessage(),
                createValidMessage(),
                createValidMessage(),
            ];
            
            const validMessages = validator.filterValid(messages);
            
            expect(validMessages).toHaveLength(3);
        });

        test('所有消息都无效时应该返回空数组', () => {
            const messages = [
                createValidMessage({ id: '' }),
                createValidMessage({ sessionKey: '' }),
                createValidMessage({ messageType: 'invalid' as any }),
            ];
            
            const validMessages = validator.filterValid(messages);
            
            expect(validMessages).toHaveLength(0);
        });
    });

    describe('✅ 分离有效和无效消息功能', () => {
        test('separateValidInvalid 应该正确分离消息', () => {
            const messages = [
                createValidMessage(), // 有效
                createValidMessage({ id: '' }), // 无效
                createValidMessage(), // 有效
                createValidMessage({ sessionKey: 'invalid' }), // 无效
            ];
            
            const { valid, invalid } = validator.separateValidInvalid(messages);
            
            expect(valid).toHaveLength(2);
            expect(invalid).toHaveLength(2);
            
            expect(valid[0]).toBe(messages[0]);
            expect(valid[1]).toBe(messages[2]);
            
            expect(invalid[0].message).toBe(messages[1]);
            expect(invalid[0].errors).toBeDefined();
            expect(invalid[0].errors.length).toBeGreaterThan(0);
            
            expect(invalid[1].message).toBe(messages[3]);
            expect(invalid[1].errors).toBeDefined();
            expect(invalid[1].errors.length).toBeGreaterThan(0);
        });

        test('所有消息都有效时 invalid 应该为空数组', () => {
            const messages = [
                createValidMessage(),
                createValidMessage(),
                createValidMessage(),
            ];
            
            const { valid, invalid } = validator.separateValidInvalid(messages);
            
            expect(valid).toHaveLength(3);
            expect(invalid).toHaveLength(0);
        });

        test('所有消息都无效时 valid 应该为空数组', () => {
            const messages = [
                createValidMessage({ id: '' }),
                createValidMessage({ sessionKey: '' }),
                createValidMessage({ messageType: 'invalid' as any }),
            ];
            
            const { valid, invalid } = validator.separateValidInvalid(messages);
            
            expect(valid).toHaveLength(0);
            expect(invalid).toHaveLength(3);
        });
    });

    describe('⚡ 性能测试', () => {
        test('10,000 条消息验证时间应该 < 100ms', () => {
            const messages: UnifiedMessage[] = [];
            
            // 生成 10,000 条测试消息
            for (let i = 0; i < 10000; i++) {
                messages.push(createValidMessage({
                    id: `msg-${i}`,
                    content: `测试消息 ${i}`
                }));
            }
            
            const startTime = Date.now();
            const results = validator.validateBatch(messages);
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            expect(results).toHaveLength(10000);
            expect(duration).toBeLessThan(100);
            
            console.log(`性能测试: ${messages.length} 条消息验证耗时 ${duration}ms (${Math.round(messages.length / duration * 1000)} msg/s)`);
        });

        test('filterValid 性能测试', () => {
            const messages: UnifiedMessage[] = [];
            
            // 生成 10,000 条测试消息（90% 有效）
            for (let i = 0; i < 10000; i++) {
                if (i % 10 === 0) {
                    // 10% 无效消息
                    messages.push(createValidMessage({ id: '' }));
                } else {
                    messages.push(createValidMessage({
                        id: `msg-${i}`,
                        content: `测试消息 ${i}`
                    }));
                }
            }
            
            const startTime = Date.now();
            const validMessages = validator.filterValid(messages);
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            expect(validMessages).toHaveLength(9000);
            expect(duration).toBeLessThan(100);
            
            console.log(`filterValid 性能: ${messages.length} 条消息过滤耗时 ${duration}ms`);
        });
    });
});
