/**
 * SubagentEventParser 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CollectorMessage } from '../src/data/collector-client.js';

// Mock analyzeMessageMeta before importing parser
vi.mock('../src/utils/message-meta.js', () => ({
  analyzeMessageMeta: vi.fn(),
  isSystemNoise: vi.fn(),
}));

// Mock TaskClient
const mockTaskClient = {
  createTaskWithSessionId: vi.fn(),
  updateTaskStatus: vi.fn(),
  lookupTaskBySessionId: vi.fn(),
};

import { SubagentEventParser, hasSubagentEvent } from '../src/data/subagent-event-parser.js';
import { analyzeMessageMeta, isSystemNoise } from '../src/utils/message-meta.js';

const { mocked } = vi;

function makeMsg(overrides: Partial<CollectorMessage> = {}): CollectorMessage {
  return {
    id: 1,
    session_key: 'agent:test-agent:webchat:account1:ch1',
    message_type: 'user',
    content: 'Hello',
    model: 'gpt-4',
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('hasSubagentEvent', () => {
  it('应该识别 [Subagent Task]: 开头', () => {
    expect(hasSubagentEvent('[Subagent Task]: 做一些事情')).toBe(true);
  });

  it('应该识别 [Internal task completion event] 开头', () => {
    expect(hasSubagentEvent('[Internal task completion event]')).toBe(true);
  });

  it('应该拒绝无关内容', () => {
    expect(hasSubagentEvent('Hello world')).toBe(false);
    expect(hasSubagentEvent('[Subagent] something')).toBe(false);
    expect(hasSubagentEvent('See [Subagent Task]: in text')).toBe(false);
  });

  it('应该区分消息中间 vs 开头', () => {
    expect(hasSubagentEvent('Some text\n[Subagent Task]: not at start')).toBe(false);
  });
});

describe('SubagentEventParser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked(analyzeMessageMeta).mockReturnValue({
      is_cron: false,
      is_system_noise: false,
      clean_content: '',
      content_summary: '',
      source_channel: null,
    });
    mocked(isSystemNoise).mockReturnValue(false);
  });

  describe('constructor', () => {
    it('应该正确初始化', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      expect(parser).toBeDefined();
      expect(parser.getProcessedCount()).toBe(0);
      expect(parser.getPendingCompletionCount()).toBe(0);
    });
  });

  describe('isProcessed (LRU eviction)', () => {
    it('新消息应该返回 false 并记录', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      expect(parser.isProcessed(123, 'event_type')).toBe(false);
      expect(parser.getProcessedCount()).toBe(1);
    });

    it('重复消息应该返回 true（幂等）', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      parser.isProcessed(123, 'event_type');
      expect(parser.isProcessed(123, 'event_type')).toBe(true);
      expect(parser.getProcessedCount()).toBe(1);
    });

    it('不同事件类型不共享幂等键', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      parser.isProcessed(123, 'type_a');
      expect(parser.isProcessed(123, 'type_b')).toBe(false);
      expect(parser.getProcessedCount()).toBe(2);
    });

    it('null messageId 应该跳过幂等检查', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      expect(parser.isProcessed(null, 'event_type')).toBe(false);
      expect(parser.isProcessed(null, 'event_type')).toBe(false);
      expect(parser.getProcessedCount()).toBe(0);
    });

    it('LRU 溢出时应该清理最旧的 20%', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // MAX_PROCESSED_KEYS = 10000, 填充超过上限
      for (let i = 0; i < 11000; i++) {
        parser.isProcessed(i, 'event_type');
      }
      // 应该清理到约 8000 条（保留 80%）
      expect(parser.getProcessedCount()).toBeLessThanOrEqual(10000);
      expect(parser.getProcessedCount()).toBeGreaterThan(8000);
    });
  });

  describe('extractTaskTitle', () => {
    it('应该提取 Markdown 标题', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // @ts-ignore access private method for testing
      expect(parser.extractTaskTitle('## 修复登录 Bug\n\n内容...')).toBe('修复登录 Bug');
    });

    it('没有 Markdown 标题时取前 60 字符', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const long = '这是一段很长的文本描述一个任务的内容，会被截取到60个字符以保证标题不会过长';
      // @ts-ignore access private method for testing
      expect(parser.extractTaskTitle(long).length).toBeLessThanOrEqual(60);
    });

    it('标题最长 60 字符', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // @ts-ignore access private method for testing
      const title = parser.extractTaskTitle('## 修复一个非常非常非常非常非常非常非常非常非常非常非常长的Bug描述内容');
      expect(title.length).toBeLessThanOrEqual(60);
    });
  });

  describe('shouldSkip', () => {
    it('应该跳过不允许的 message_type', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ message_type: 'system' });
      // @ts-ignore access private method for testing
      expect(parser.shouldSkip(msg)).toBe(true);
    });

    it('应该跳过空 content', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: null });
      // @ts-ignore access private method for testing
      expect(parser.shouldSkip(msg)).toBe(true);
    });

    it('应该跳过系统噪音消息', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      mocked(analyzeMessageMeta).mockReturnValue({
        is_cron: false,
        is_system_noise: true,
        clean_content: 'HEARTBEAT_OK',
        content_summary: '',
        source_channel: null,
      });
      const msg = makeMsg({ message_type: 'user', content: 'HEARTBEAT_OK' });
      // @ts-ignore access private method for testing
      expect(parser.shouldSkip(msg)).toBe(true);
    });

    it('正常消息不应该跳过', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      mocked(isSystemNoise).mockReturnValue(false);
      const msg = makeMsg({ message_type: 'user', content: '正常消息' });
      // @ts-ignore access private method for testing
      expect(parser.shouldSkip(msg)).toBe(false);
    });
  });

  describe('pruneSessionMappings (TTL cleanup)', () => {
    it('应该清理过期的 session 条目', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // 直接操作私有成员模拟旧条目
      // @ts-ignore
      parser.sessionIdToTaskId.set('old-session', 'task-1');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set('old-session', Date.now() - 20 * 60 * 1000); // 20 分钟前

      // @ts-ignore
      parser.pruneSessionMappings();

      // @ts-ignore
      expect(parser.sessionIdToTaskId.has('old-session')).toBe(false);
    });

    it('新条目不应该被清理', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // @ts-ignore
      parser.sessionIdToTaskId.set('new-session', 'task-1');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set('new-session', Date.now());

      // @ts-ignore
      parser.pruneSessionMappings();

      // @ts-ignore
      expect(parser.sessionIdToTaskId.has('new-session')).toBe(true);
    });
  });

  describe('handleTaskDispatch', () => {
    it('TaskClient.createTaskWithSessionId 成功时返回 true', async () => {
      mockTaskClient.createTaskWithSessionId.mockResolvedValue({ id: 'task-123' });
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({
        content: '[Subagent Task]: ## 修复 Bug\n\n任务描述',
        session_key: 'agent:test:webchat:acc:ch',
      });

      // @ts-ignore
      const result = await parser.handleTaskDispatch(msg);

      expect(result).toBe(true);
      expect(mockTaskClient.createTaskWithSessionId).toHaveBeenCalledOnce();
    });

    it('TaskClient 返回 null 时返回 false', async () => {
      mockTaskClient.createTaskWithSessionId.mockResolvedValue(null);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: '## 任务' });

      // @ts-ignore
      const result = await parser.handleTaskDispatch(msg);

      expect(result).toBe(false);
    });

    it('无 content 时返回 false', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: null });

      // @ts-ignore
      const result = await parser.handleTaskDispatch(msg);

      expect(result).toBe(false);
    });

    it('无 SUBAGENT_TASK_REGEX 匹配时返回 false', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: '这不是子任务消息' });

      // @ts-ignore
      const result = await parser.handleTaskDispatch(msg);

      expect(result).toBe(false);
    });
  });

  describe('handleCompletion', () => {
    it('找到 taskId 时更新状态成功返回 true', async () => {
      mockTaskClient.updateTaskStatus.mockResolvedValue(true);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // 预先放入映射
      // @ts-ignore
      parser.sessionIdToTaskId.set('agent:child:webchat:acc:ch', 'task-456');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set('agent:child:webchat:acc:ch', Date.now());

      const msg = makeMsg({
        content: `[Internal task completion event]
source: subagent
session_key: agent:child:webchat:acc:ch
session_id: child-session-id
type: subagent task
task: 子任务描述
status: completed`,
      });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(true);
      expect(mockTaskClient.updateTaskStatus).toHaveBeenCalledWith('task-456', 'completed');
      // @ts-ignore
      expect(parser.sessionIdToTaskId.has('agent:child:webchat:acc:ch')).toBe(false);
    });

    it('未找到 taskId 但 lookupTaskBySessionId 成功', async () => {
      mockTaskClient.updateTaskStatus.mockResolvedValue(true);
      mockTaskClient.lookupTaskBySessionId.mockResolvedValue('found-task-id');
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });

      const msg = makeMsg({
        content: `[Internal task completion event]
source: subagent
session_key: agent:child:webchat:acc:ch
session_id: child-session-id
type: subagent task
task: 子任务描述
status: completed`,
      });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(true);
      expect(mockTaskClient.lookupTaskBySessionId).toHaveBeenCalled();
    });

    it('updateTaskStatus 返回 false 时 handleCompletion 返回 false', async () => {
      mockTaskClient.updateTaskStatus.mockResolvedValue(false);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // @ts-ignore
      parser.sessionIdToTaskId.set('agent:child:webchat:acc:ch', 'task-456');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set('agent:child:webchat:acc:ch', Date.now());

      const msg = makeMsg({
        content: `[Internal task completion event]
source: subagent
session_key: agent:child:webchat:acc:ch
session_id: child-session-id
type: subagent task
task: 子任务描述
status: failed`,
      });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(false);
    });

    it('无 content 时返回 false', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: null });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(false);
    });

    it('无匹配正则时返回 false', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: '这不是完成事件消息' });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(false);
    });

    it('未找到 taskId 时记录警告并返回 false', async () => {
      mockTaskClient.lookupTaskBySessionId.mockResolvedValue(null);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });

      const msg = makeMsg({
        content: `[Internal task completion event]
source: subagent
session_key: agent:child:webchat:acc:ch
session_id: child-session-id
type: subagent task
task: 子任务描述
status: completed`,
      });

      // @ts-ignore
      const result = await parser.handleCompletion(msg);

      expect(result).toBe(false);
    });
  });

  describe('parseBatch', () => {
    it('空消息数组返回零统计', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const result = await parser.parseBatch([], 'test-module');
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('跳过超过 5 分钟的旧消息', async () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const msg = makeMsg({
        id: 999,
        content: '[Subagent Task]: 任务',
        timestamp: oldTime,
        created_at: oldTime,
      });

      const result = await parser.parseBatch([msg], 'test-module');

      expect(result.created).toBe(0);
      expect(mockTaskClient.createTaskWithSessionId).not.toHaveBeenCalled();
    });

    it('shouldSkip 的消息被跳过', async () => {
      mocked(isSystemNoise).mockReturnValue(true);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ message_type: 'user', content: 'HEARTBEAT_OK' });

      const result = await parser.parseBatch([msg], 'test-module');

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
    });

    it('正确处理派发事件', async () => {
      mockTaskClient.createTaskWithSessionId.mockResolvedValue({ id: 'task-new' });
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({
        content: '[Subagent Task]: 修复登录问题',
      });

      const result = await parser.parseBatch([msg], 'test-module');

      expect(result.created).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('正确处理完成事件', async () => {
      mockTaskClient.updateTaskStatus.mockResolvedValue(true);
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const sessionKey = 'agent:test:webchat:acc:ch';
      const msg = makeMsg({
        session_key: sessionKey,
        content: `[Internal task completion event]
source: subagent
session_key: ${sessionKey}
session_id: sid-123
type: subagent task
task: 任务
status: completed`,
      });

      // 预先放入映射
      // @ts-ignore
      parser.sessionIdToTaskId.set(sessionKey, 'task-existing');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set(sessionKey, Date.now());

      const result = await parser.parseBatch([msg], 'test-module');

      expect(result.updated).toBe(1);
    });

    it('parseBatch 内部异常不影响其他消息处理', async () => {
      mockTaskClient.createTaskWithSessionId.mockRejectedValue(new Error('network error'));
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ content: '[Subagent Task]: 做事情' });

      const result = await parser.parseBatch([msg], 'test-module');

      expect(result.errors).toBe(1);
    });

    it('幂等：同一消息处理两次只计数一次', async () => {
      mockTaskClient.createTaskWithSessionId.mockResolvedValue({ id: 'task-1' });
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      const msg = makeMsg({ id: 42, content: '[Subagent Task]: 做事情' });

      const firstResult = await parser.parseBatch([msg], 'test-module');
      expect(firstResult.created).toBe(1);

      const secondResult = await parser.parseBatch([msg], 'test-module');
      expect(secondResult.created).toBe(0); // 幂等跳过
      expect(mockTaskClient.createTaskWithSessionId).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearMemory', () => {
    it('应该清空所有内存映射', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      parser.isProcessed(1, 'type_a');
      // @ts-ignore
      parser.sessionIdToTaskId.set('session-1', 'task-1');
      // @ts-ignore
      parser.sessionIdToTaskIdAddedAt.set('session-1', Date.now());

      parser.clearMemory();

      expect(parser.getProcessedCount()).toBe(0);
      expect(parser.getPendingCompletionCount()).toBe(0);
    });
  });

  describe('getPendingCompletionCount', () => {
    it('应该返回待完成映射数量', () => {
      const parser = new SubagentEventParser({ taskClient: mockTaskClient as any });
      // @ts-ignore
      parser.sessionIdToTaskId.set('session-1', 'task-1');
      // @ts-ignore
      parser.sessionIdToTaskId.set('session-2', 'task-2');

      expect(parser.getPendingCompletionCount()).toBe(2);
    });
  });
});
