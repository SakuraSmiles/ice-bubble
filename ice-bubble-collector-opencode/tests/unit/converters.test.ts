/**
 * opencode-to-unified.ts 单元测试
 *
 * 测试内容：
 * 1. convertSession 转换
 * 2. convertMessage / convertMessages 转换
 * 3. Tool call 配对
 * 4. Token/Cost 附加
 * 5. 缺失字段处理
 */

import { describe, it, expect } from 'vitest';
import {
  convertSession,
  convertMessage,
  convertMessages,
  createConvertContext,
} from '../../src/converters/opencode-to-unified.js';
import type { OpenCodeMessage, OpenCodePart, ConvertContext } from '../../src/converters/opencode-to-unified.js';
import type { OpenCodeSession } from '../../src/types/opencode.js';
import {
  createMockSession,
  createMockMessage,
  createTextPart,
  createToolPart,
  createReasoningPart,
  createStepFinishPart,
} from '../helpers/test-data.js';

// ==================== convertSession 测试 ====================

describe('convertSession', () => {
  it('应该正确转换正常 session', () => {
    const session = createMockSession();
    const result = convertSession(session);

    expect(result.sessionKey).toBe('ses_abc123def456');
    expect(result.title).toBe('Test Session');
    expect(result.platform).toBe('opencode');
    expect(result.source).toBe('sqlite');
    expect(result.agent).toBe('coder');
    expect(result.model).toBe('claude-3-sonnet');
    expect(result.directory).toBe('/home/user/project');
    expect(result.createdAt).toEqual(new Date(1700000000000));
    expect(result.updatedAt).toEqual(new Date(1700000100000));
    expect(result.timeArchived).toBeNull();
  });

  it('应该处理 null agent 和 model', () => {
    const session = createMockSession({ agent: null, model: null });
    const result = convertSession(session);

    expect(result.agent).toBeNull();
    expect(result.model).toBeNull();
  });

  it('应该正确映射 project 关联字段', () => {
    const session = createMockSession({
      project_name: 'my-project',
      project_worktree: '/home/user/worktrees/feature',
    });
    const result = convertSession(session);

    expect(result.projectName).toBe('my-project');
    expect(result.projectWorktree).toBe('/home/user/worktrees/feature');
  });

  it('应该处理 time_archived 有值的情况', () => {
    const session = createMockSession({ time_archived: 1700000200000 });
    const result = convertSession(session);

    expect(result.timeArchived).toBe(1700000200000);
  });
});

// ==================== convertMessage 测试 ====================

describe('convertMessage', () => {
  it('应该转换 user message with text part', () => {
    const message = createMockMessage('user');
    const parts = [createTextPart('你好')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe('user');
    expect(results[0].content).toBe('你好');
    expect(results[0].sessionKey).toBe('ses_abc123def456');
    expect(results[0].source).toBe('sqlite');
    expect(results[0].id).toMatch(/^opencode:/);
  });

  it('应该转换 assistant message with text part', () => {
    const message = createMockMessage('assistant');
    const parts = [createTextPart('这是回复')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe('agent');
    expect(results[0].content).toBe('这是回复');
  });

  it('应该转换 assistant message with reasoning part', () => {
    const message = createMockMessage('assistant');
    const parts = [createReasoningPart('思考中...')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe('agent');
    expect(results[0].content).toBe('思考中...');
    expect(results[0].metadata?.reasoning).toBe(true);
  });

  it('应该转换 assistant message with completed tool part', () => {
    const message = createMockMessage('assistant');
    const parts = [createToolPart('bash', 'call_001')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe('tool');
    expect(results[0].tools).toHaveLength(1);
    expect(results[0].tools![0].name).toBe('bash');
    expect(results[0].tools![0].result).toBe('tool output');
  });

  it('应该将未完成的 tool 放入 pendingToolCalls', () => {
    const message = createMockMessage('assistant');
    const parts = [createToolPart('bash', 'call_002', {}, { status: 'running' })];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    // 未完成的 tool 不立即输出
    expect(results).toHaveLength(0);
    expect(ctx.pendingToolCalls.has('call_002')).toBe(true);
  });

  it('应该在 data 解析失败时返回空数组', () => {
    const message = createMockMessage('user', { data: 'invalid json{' });
    const parts: OpenCodePart[] = [];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(0);
  });

  it('应该处理 user message 无 text parts 的情况', () => {
    const message = createMockMessage('user');
    const parts: OpenCodePart[] = [];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].messageType).toBe('user');
    expect(results[0].content).toBeUndefined();
  });

  it('应该处理多个 text parts 合并', () => {
    const message = createMockMessage('user');
    const parts = [createTextPart('第一段'), createTextPart('第二段')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('第一段\n第二段');
  });
});

// ==================== step-finish Token 附加测试 ====================

describe('step-finish token attachment', () => {
  it('应该将 tokens/cost 附加到前一条 agent 消息', () => {
    const message = createMockMessage('assistant');
    const textPart = createTextPart('回复内容');
    const finishPart = createStepFinishPart();
    const ctx = createConvertContext();

    const results = convertMessage(message, [textPart, finishPart], ctx);

    expect(results).toHaveLength(1);
    expect(results[0].tokens).toBeDefined();
    expect(results[0].tokens!.input).toBe(80);
    expect(results[0].tokens!.output).toBe(20);
    expect(results[0].tokens!.totalTokens).toBe(100);
    expect(results[0].tokens!.cost).toBeDefined();
    expect(results[0].tokens!.cost!.total).toBe(0.005);
  });
});

// ==================== convertMessages 批量测试 ====================

describe('convertMessages', () => {
  it('应该按 time_created 排序处理', () => {
    const msg1 = createMockMessage('user', { time_created: 2000 }, { role: 'user' });
    const msg2 = createMockMessage('assistant', { time_created: 1000, id: 'msg_test002' }, { role: 'assistant' });

    const results = convertMessages([
      { message: msg1, parts: [createTextPart('late')] },
      { message: msg2, parts: [createTextPart('early')] },
    ]);

    // 应该按 time_created 升序排列，msg2(time=1000) 在前
    expect(results[0].content).toBe('early');
    expect(results[1].content).toBe('late');
  });

  it('应该保留未配对的 pending tool call', () => {
    const callID = 'call_unpaired_001';

    // assistant message with running tool (no result yet)
    const assistantMsg = createMockMessage('assistant', { id: 'msg_assist1' });
    const toolPart = createToolPart('bash', callID, {}, { status: 'running', output: undefined });

    const results = convertMessages([
      { message: assistantMsg, parts: [toolPart] },
    ]);

    // 未配对的 tool 应在结果末尾出现
    const toolMsg = results.find(r => r.messageType === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tools![0].name).toBe('bash');
  });

  it('应该正确处理已完成 tool 的内联 result', () => {
    // 完成的 tool 直接在 assistant message 中带 output，不需要配对
    const assistantMsg = createMockMessage('assistant', { id: 'msg_assist1' });
    const toolPart = createToolPart('read_file', 'call_inline_001', {}, {
      status: 'completed',
      output: 'file content here',
    });

    const results = convertMessages([
      { message: assistantMsg, parts: [toolPart] },
    ]);

    const toolMsg = results.find(r => r.messageType === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tools![0].name).toBe('read_file');
    expect(toolMsg!.tools![0].result).toBe('file content here');
  });
});

// ==================== ID 格式测试 ====================

describe('message id format', () => {
  it('应该以 opencode: 开头', () => {
    const message = createMockMessage('user');
    const parts = [createTextPart('test')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results[0].id).toMatch(/^opencode:/);
  });

  it('应该包含 sessionKey', () => {
    const message = createMockMessage('user', { session_id: 'ses_special123' });
    const parts = [createTextPart('test')];
    const ctx = createConvertContext();

    const results = convertMessage(message, parts, ctx);

    expect(results[0].id).toContain('ses_special123');
  });
});
