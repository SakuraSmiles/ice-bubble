/**
 * openclaw-to-unified.ts 单元测试
 * 
 * 测试内容：
 * 1. User 消息转换
 * 2. Assistant 消息转换
 * 3. ToolResult 消息转换
 * 4. 边界情况处理
 * 5. 数据完整性验证
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  convertOpenClawEvent,
  convertUserMessage,
  convertAssistantMessage,
  convertToolResultMessage,
  validateUnifiedMessage,
  shouldSkipEmptyMessage,
} from '../../../src/converters/openclaw-to-unified';
import {
  MessageEvent,
  Message,
  TextContent,
  ToolCallContent,
} from '../../../src/types/openclaw';
import { UnifiedMessage } from '../../../src/types/index';

const TEST_SESSION_KEY = 'agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4';

describe('openclaw-to-unified converter', () => {
  // ==================== User 消息转换测试 ====================

  describe('convertUserMessage', () => {
    it('应该正确转换简单的 User 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-001',
        parentId: null,
        timestamp: '2026-04-08T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '帮我分析错误' }],
          timestamp: 1775189790619,
        },
      };

      const result = convertUserMessage(event, TEST_SESSION_KEY);

      expect(result.id).toBe('test-001');
      expect(result.sessionKey).toBe(TEST_SESSION_KEY);
      expect(result.messageType).toBe('user');
      expect(result.source).toBe('file');
      expect(result.content).toBe('帮我分析错误');
      expect(result.timestamp).toEqual(new Date('2026-04-08T10:00:00.000Z'));
      expect(result.metadata?.eventId).toBe('test-001');
      expect(result.metadata?.parentId).toBeUndefined();
    });

    it('应该正确处理多个 text 内容', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-002',
        parentId: null,
        timestamp: '2026-04-08T10:01:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
          ],
          timestamp: 1775189790619,
        },
      };

      const result = convertUserMessage(event, TEST_SESSION_KEY);

      expect(result.content).toBe('第一段\n第二段');
      expect(result.metadata?.contentCount).toBe(2);
    });

    it('应该正确处理带 parentId 的消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-003',
        parentId: 'parent-001',
        timestamp: '2026-04-08T10:02:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '回复消息' }],
          timestamp: 1775189790619,
        },
      };

      const result = convertUserMessage(event, TEST_SESSION_KEY);

      expect(result.metadata?.parentId).toBe('parent-001');
    });

    it('应该正确处理空内容', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-004',
        parentId: null,
        timestamp: '2026-04-08T10:03:00.000Z',
        message: {
          role: 'user',
          content: [],
          timestamp: 1775189790619,
        },
      };

      const result = convertUserMessage(event, TEST_SESSION_KEY);

      expect(result.content).toBe('');
    });
  });

  // ==================== Assistant 消息转换测试 ====================

  describe('convertAssistantMessage', () => {
    it('应该正确转换简单的 Assistant 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-005',
        parentId: null,
        timestamp: '2026-04-08T10:04:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我来帮你分析' }],
          api: 'anthropic-messages',
          provider: 'minimax-cn',
          model: 'MiniMax-M2.7',
          usage: {
            input: 36,
            output: 78,
            totalTokens: 13149,
            cacheRead: 100,
            cacheWrite: 50,
            cost: {
              input: 0.00005,
              output: 0.000085,
              cacheRead: 0.00001,
              cacheWrite: 0.00002,
              total: 0.000135,
            },
          },
          stopReason: 'stop',
          responseId: 'resp-001',
          timestamp: 1775189790719,
        },
      };

      const result = convertAssistantMessage(event, TEST_SESSION_KEY);

      expect(result.id).toBe('test-005');
      expect(result.messageType).toBe('agent');
      expect(result.content).toBe('我来帮你分析');
      expect(result.model).toBe('MiniMax-M2.7');
      expect(result.tokens).toEqual({ input: 36, output: 78 });
      expect(result.metadata?.provider).toBe('minimax-cn');
      expect(result.metadata?.api).toBe('anthropic-messages');
      expect(result.metadata?.stopReason).toBe('stop');
      expect(result.metadata?.responseId).toBe('resp-001');
      expect(result.metadata?.totalTokens).toBe(13149);
      expect(result.metadata?.cost).toBe(0.000135);
    });

    it('应该正确处理带工具调用的 Assistant 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-006',
        parentId: null,
        timestamp: '2026-04-08T10:05:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '思考中...', thinkingSignature: 'sig-001' },
            { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'ls -la' } },
            { type: 'toolCall', id: 'call_2', name: 'read_file', arguments: { path: '/tmp/file' } },
            { type: 'text', text: '执行完成' },
          ],
          model: 'claude-3-5-sonnet',
          stopReason: 'toolUse',
          timestamp: 1775189790819,
        },
      };

      const result = convertAssistantMessage(event, TEST_SESSION_KEY);

      expect(result.messageType).toBe('agent');
      expect(result.content).toBe('执行完成');
      expect(result.tools).toHaveLength(2);
      expect(result.tools![0]).toEqual({
        name: 'exec',
        input: { command: 'ls -la' },
        result: undefined,
      });
      expect(result.tools![1]).toEqual({
        name: 'read_file',
        input: { path: '/tmp/file' },
        result: undefined,
      });
      expect(result.metadata?.thinkingIncluded).toBe(true);
      expect(result.metadata?.contentTypes).toEqual(['thinking', 'toolCall', 'toolCall', 'text']);
      expect(result.metadata?.stopReason).toBe('toolUse');
    });

    it('应该正确处理没有 usage 的消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-007',
        parentId: null,
        timestamp: '2026-04-08T10:06:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '简单回复' }],
          timestamp: 1775189790919,
        },
      };

      const result = convertAssistantMessage(event, TEST_SESSION_KEY);

      expect(result.tokens).toBeUndefined();
      expect(result.metadata?.totalTokens).toBeUndefined();
      expect(result.metadata?.cost).toBeUndefined();
    });
  });

  // ==================== ToolResult 消息转换测试 ====================

  describe('convertToolResultMessage', () => {
    it('应该正确转换成功的工具结果', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-008',
        parentId: null,
        timestamp: '2026-04-08T10:07:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'exec',
          content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
          details: {
            status: 'completed',
            exitCode: 0,
            durationMs: 150,
            cwd: '/home/user',
          },
          isError: false,
          timestamp: 1775189791019,
        },
      };

      const result = convertToolResultMessage(event, TEST_SESSION_KEY);

      expect(result.id).toBe('test-008');
      expect(result.messageType).toBe('tool');
      expect(result.content).toBe('file1.txt\nfile2.txt');
      expect(result.tools).toHaveLength(1);
      expect(result.tools![0]).toEqual({
        name: 'exec',
        input: undefined,
        result: {
          status: 'completed',
          approvalId: undefined,
          output: 'file1.txt\nfile2.txt',
        },
        durationMs: 150,
      });
      expect(result.metadata?.toolCallId).toBe('call_1');
      expect(result.metadata?.isError).toBe(false);
      expect(result.metadata?.status).toBe('completed');
      expect(result.metadata?.exitCode).toBe(0);
      expect(result.metadata?.durationMs).toBe(150);
      expect(result.metadata?.cwd).toBe('/home/user');
    });

    it('应该正确处理需要审批的工具结果', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-009',
        parentId: null,
        timestamp: '2026-04-08T10:08:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_2',
          toolName: 'exec',
          content: [{ type: 'text', text: 'Approval required (id bc5f3f08...)' }],
          details: {
            status: 'approval-pending',
            approvalId: 'bc5f3f08-2378-4069-a0e5-17e3a1f6522a',
            approvalSlug: 'exec-command',
            command: 'rm -rf /tmp',
            expiresAtMs: 1712572800000,
            cwd: '/home/user',
            warningText: 'Destructive command',
          },
          isError: false,
          timestamp: 1775189791119,
        },
      };

      const result = convertToolResultMessage(event, TEST_SESSION_KEY);

      expect(result.messageType).toBe('tool');
      expect(result.metadata?.status).toBe('approval-pending');
      expect(result.metadata?.approval).toEqual({
        id: 'bc5f3f08-2378-4069-a0e5-17e3a1f6522a',
        slug: 'exec-command',
        command: 'rm -rf /tmp',
        expiresAt: new Date(1712572800000),
      });
    });

    it('应该正确处理错误的工具结果', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-010',
        parentId: null,
        timestamp: '2026-04-08T10:09:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_3',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'Error: File not found' }],
          details: {
            status: 'error',
            exitCode: 1,
            durationMs: 10,
          },
          isError: true,
          timestamp: 1775189791219,
        },
      };

      const result = convertToolResultMessage(event, TEST_SESSION_KEY);

      expect(result.messageType).toBe('tool');
      expect(result.metadata?.isError).toBe(true);
      expect(result.metadata?.status).toBe('error');
      expect(result.metadata?.exitCode).toBe(1);
      expect(result.metadata?.approval).toBeUndefined();
    });
  });

  // ==================== 主转换函数测试 ====================

  describe('convertOpenClawEvent', () => {
    it('应该正确路由 User 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-011',
        parentId: null,
        timestamp: '2026-04-08T10:10:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '测试' }],
          timestamp: 1775189791319,
        },
      };

      const result = convertOpenClawEvent(event, TEST_SESSION_KEY);

      expect(result).not.toBeNull();
      expect(result?.messageType).toBe('user');
    });

    it('应该正确路由 Assistant 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-012',
        parentId: null,
        timestamp: '2026-04-08T10:11:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '回复' }],
          timestamp: 1775189791419,
        },
      };

      const result = convertOpenClawEvent(event, TEST_SESSION_KEY);

      expect(result).not.toBeNull();
      expect(result?.messageType).toBe('agent');
    });

    it('应该正确路由 ToolResult 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-013',
        parentId: null,
        timestamp: '2026-04-08T10:12:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'test',
          content: [{ type: 'text', text: '结果' }],
          timestamp: 1775189791519,
        },
      };

      const result = convertOpenClawEvent(event, TEST_SESSION_KEY);

      expect(result).not.toBeNull();
      expect(result?.messageType).toBe('tool');
    });

    it('应该忽略非 MessageEvent 事件', () => {
      const event = {
        type: 'session',
        id: 'test-014',
        parentId: null,
        timestamp: '2026-04-08T10:13:00.000Z',
        version: 1,
        cwd: '/home/user',
      };

      const result = convertOpenClawEvent(event as any, TEST_SESSION_KEY);

      expect(result).toBeNull();
    });

    it('应该处理未知的消息角色', () => {
      const event = {
        type: 'message',
        id: 'test-015',
        parentId: null,
        timestamp: '2026-04-08T10:14:00.000Z',
        message: {
          role: 'unknown',
          content: [{ type: 'text', text: '测试' }],
          timestamp: 1775189791619,
        },
      };

      const result = convertOpenClawEvent(event as any, TEST_SESSION_KEY);

      expect(result).toBeNull();
    });
  });

  // ==================== 验证函数测试 ====================

  describe('validateUnifiedMessage', () => {
    it('应该验证有效的消息', () => {
      const message: UnifiedMessage = {
        id: 'test-001',
        sessionKey: TEST_SESSION_KEY,
        messageType: 'user',
        timestamp: new Date('2026-04-08T10:00:00.000Z'),
        source: 'file',
        content: '测试内容',
      };

      expect(validateUnifiedMessage(message)).toBe(true);
    });

    it('应该拒绝缺少必填字段的消息', () => {
      const message: any = {
        id: 'test-002',
        sessionKey: TEST_SESSION_KEY,
        // 缺少 messageType
        timestamp: new Date('2026-04-08T10:00:00.000Z'),
        source: 'file',
      };

      expect(validateUnifiedMessage(message)).toBe(false);
    });

    it('应该拒绝无效的 messageType', () => {
      const message: any = {
        id: 'test-003',
        sessionKey: TEST_SESSION_KEY,
        messageType: 'invalid',
        timestamp: new Date('2026-04-08T10:00:00.000Z'),
        source: 'file',
      };

      expect(validateUnifiedMessage(message)).toBe(false);
    });

    it('应该拒绝无效的 source', () => {
      const message: any = {
        id: 'test-004',
        sessionKey: TEST_SESSION_KEY,
        messageType: 'user',
        timestamp: new Date('2026-04-08T10:00:00.000Z'),
        source: 'invalid',
      };

      expect(validateUnifiedMessage(message)).toBe(false);
    });
  });

  // ==================== 空消息判断测试 ====================

  describe('shouldSkipEmptyMessage', () => {
    it('应该跳过空内容数组', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-016',
        parentId: null,
        timestamp: '2026-04-08T10:15:00.000Z',
        message: {
          role: 'user',
          content: [],
          timestamp: 1775189791719,
        },
      };

      expect(shouldSkipEmptyMessage(event)).toBe(true);
    });

    it('应该跳过没有 text 的 User 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-017',
        parentId: null,
        timestamp: '2026-04-08T10:16:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'thinking' as any, thinking: '思考' }],
          timestamp: 1775189791819,
        },
      };

      expect(shouldSkipEmptyMessage(event)).toBe(true);
    });

    it('应该保留没有 text 的 ToolResult 消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-018',
        parentId: null,
        timestamp: '2026-04-08T10:17:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'exec',
          content: [{ type: 'text', text: 'result' }], // ToolResult 需要有内容
          timestamp: 1775189791919,
        },
      };

      expect(shouldSkipEmptyMessage(event)).toBe(false);
    });

    it('应该保留包含 text 的消息', () => {
      const event: MessageEvent = {
        type: 'message',
        id: 'test-019',
        parentId: null,
        timestamp: '2026-04-08T10:18:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '有内容' }],
          timestamp: 1775189792019,
        },
      };

      expect(shouldSkipEmptyMessage(event)).toBe(false);
    });
  });
});
