/**
 * 测试数据工厂
 *
 * 为 converter 和 config-loader 测试提供可复用的 mock 数据
 */

import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodePart,
  MessageData,
  UserMessageData,
  AssistantMessageData,
  PartData,
  TextPartData,
  ToolPartData,
  ReasoningPartData,
  StepFinishPartData,
} from '../../src/types/opencode.js';

// ==================== Session 工厂 ====================

export function createMockSession(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    id: 'ses_abc123def456',
    project_id: 'proj_001',
    parent_id: null,
    slug: 'test-session',
    directory: '/home/user/project',
    title: 'Test Session',
    version: '1.0.0',
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    revert: null,
    permission: null,
    time_created: 1700000000000,
    time_updated: 1700000100000,
    time_compacting: null,
    time_archived: null,
    workspace_id: null,
    path: null,
    agent: 'coder',
    model: 'claude-3-sonnet',
    ...overrides,
  };
}

// ==================== Message 工厂 ====================

export function createMockMessage(
  role: 'user' | 'assistant',
  overrides: Partial<OpenCodeMessage> = {},
  dataOverrides: Partial<MessageData> = {},
): OpenCodeMessage {
  const baseData: MessageData =
    role === 'user'
      ? {
          role: 'user',
          time: { created: 1700000000000 },
          ...dataOverrides,
        }
      : {
          role: 'assistant',
          mode: 'code',
          time: { created: 1700000000000 },
          ...dataOverrides,
        };

  return {
    id: 'msg_test001',
    session_id: 'ses_abc123def456',
    time_created: 1700000000000,
    time_updated: 1700000001000,
    data: JSON.stringify(baseData),
    ...overrides,
  };
}

// ==================== Part 工厂 ====================

export function createTextPart(text: string, overrides: Partial<OpenCodePart> = {}): OpenCodePart {
  const data: TextPartData = { type: 'text', text };
  return {
    id: 'prt_text001',
    message_id: 'msg_test001',
    session_id: 'ses_abc123def456',
    time_created: 1700000000000,
    time_updated: 1700000000000,
    data: JSON.stringify(data),
    ...overrides,
  };
}

export function createToolPart(
  toolName: string,
  callID: string,
  overrides: Partial<OpenCodePart> = {},
  stateOverrides: Record<string, unknown> = {},
): OpenCodePart {
  const data: ToolPartData = {
    type: 'tool',
    callID,
    tool: toolName,
    state: {
      status: 'completed',
      input: {},
      output: 'tool output',
      ...stateOverrides,
    } as any,
  };
  return {
    id: 'prt_tool001',
    message_id: 'msg_test001',
    session_id: 'ses_abc123def456',
    time_created: 1700000000000,
    time_updated: 1700000000000,
    data: JSON.stringify(data),
    ...overrides,
  };
}

export function createReasoningPart(
  text: string,
  overrides: Partial<OpenCodePart> = {},
): OpenCodePart {
  const data: ReasoningPartData = { type: 'reasoning', text };
  return {
    id: 'prt_reason001',
    message_id: 'msg_test001',
    session_id: 'ses_abc123def456',
    time_created: 1700000000000,
    time_updated: 1700000000000,
    data: JSON.stringify(data),
    ...overrides,
  };
}

export function createStepFinishPart(
  overrides: Partial<OpenCodePart> = {},
  tokenOverrides: Record<string, unknown> = {},
): OpenCodePart {
  const data: StepFinishPartData = {
    type: 'step-finish',
    reason: 'stop',
    tokens: {
      total: 100,
      input: 80,
      output: 20,
      reasoning: 0,
      ...tokenOverrides,
    },
    cost: 0.005,
  };
  return {
    id: 'prt_finish001',
    message_id: 'msg_test001',
    session_id: 'ses_abc123def456',
    time_created: 1700000000000,
    time_updated: 1700000000000,
    data: JSON.stringify(data),
    ...overrides,
  };
}
