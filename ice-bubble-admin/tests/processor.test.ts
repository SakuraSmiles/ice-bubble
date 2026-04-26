/**
 * Processor 单元测试
 */

import { describe, it, expect } from 'vitest';
import { processSession, processMessage } from '../src/data/processor.js';

describe('processor', () => {
  describe('processSession', () => {
    it('应该正确处理 session 行', () => {
      const input = {
        session_key: 'agent:test:s1',
        agent_id: 'test-agent',
        channel: 'channel-1',
        message_count: 10,
        last_message_at: '2024-01-01T12:00:00Z',
        created_at: '2024-01-01T10:00:00Z',
      };

      const result = processSession(input, 'collector-1');

      expect(result.session_key).toBe('agent:test:s1');
      expect(result.source_module).toBe('collector-1');
      expect(result.agent_id).toBe('test-agent');
      expect(result.channel).toBe('channel-1');
      expect(result.message_count).toBe(10);
      expect(result.first_message_at).toBeNull();
      expect(result.last_message_at).toBe('2024-01-01T12:00:00Z');
      expect(result.source_created_at).toBe('2024-01-01T10:00:00Z');
    });

    it('应该处理缺失字段', () => {
      const input = {
        session_key: 'agent:test:s2',
      };

      const result = processSession(input, 'collector-2');

      expect(result.session_key).toBe('agent:test:s2');
      expect(result.source_module).toBe('collector-2');
      expect(result.agent_id).toBeNull();
      expect(result.channel).toBeNull();
      expect(result.message_count).toBe(0);
    });
  });

  describe('processMessage', () => {
    it('应该正确处理普通消息', () => {
      const input = {
        id: 1,
        session_key: 'agent:test:s1',
        message_type: 'user',
        content: 'Hello world',
        model: 'gpt-4',
        tokens_input: 10,
        tokens_output: 20,
        cost_total: 0.01,
        cost_input: 0.005,
        cost_output: 0.005,
        timestamp: '2024-01-01T12:00:00Z',
        created_at: '2024-01-01T11:00:00Z',
      };

      const result = processMessage(input, 'collector-1');

      expect(result.source_id).toBe(1);
      expect(result.source_module).toBe('collector-1');
      expect(result.session_key).toBe('agent:test:s1');
      expect(result.message_type).toBe('user');
      expect(result.content).toBe('Hello world');
      expect(result.model).toBe('gpt-4');
      expect(result.tokens_input).toBe(10);
      expect(result.tokens_output).toBe(20);
      expect(result.cost_total).toBe(0.01);
      expect(result.is_system_context).toBeUndefined();
    });

    it('应该标记 subagent 系统事件消息', () => {
      const input = {
        id: 2,
        session_key: 'agent:test:s1',
        message_type: 'tool',
        content: 'Some text [Subagent Task]: doing something',
        model: 'gpt-4',
        timestamp: '2024-01-01T12:01:00Z',
        created_at: '2024-01-01T11:00:00Z',
      };

      const result = processMessage(input, 'collector-1');

      expect(result.content).toBe('');
      expect(result.is_system_context).toBe(1);
    });

    it('应该标记 internal task completion 消息', () => {
      const input = {
        id: 3,
        session_key: 'agent:test:s1',
        message_type: 'agent',
        content: '[Internal task completion event]',
        model: 'gpt-4',
        timestamp: '2024-01-01T12:02:00Z',
        created_at: '2024-01-01T11:00:00Z',
      };

      const result = processMessage(input, 'collector-1');

      expect(result.content).toBe('');
      expect(result.is_system_context).toBe(1);
    });

    it('应该处理缺失字段', () => {
      const input = {
        id: null,
        session_key: 'agent:test:s3',
        timestamp: '2024-01-01T12:00:00Z',
      };

      const result = processMessage(input, 'collector-3');

      expect(result.source_id).toBeNull();
      expect(result.message_type).toBeNull();
      expect(result.content).toBeNull();
      expect(result.model).toBeNull();
      expect(result.tokens_input).toBeNull();
      expect(result.is_system_context).toBeUndefined();
    });

    it('应该处理 null content', () => {
      const input = {
        id: 4,
        session_key: 'agent:test:s4',
        content: null,
        timestamp: '2024-01-01T12:00:00Z',
      };

      const result = processMessage(input, 'collector-4');
      expect(result.content).toBeNull();
      expect(result.is_system_context).toBeUndefined();
    });

    it('应该正确处理 cost 字段', () => {
      const input = {
        id: 5,
        session_key: 'agent:test:s5',
        cost_total: 0.05,
        cost_input: 0.02,
        cost_output: 0.03,
        timestamp: '2024-01-01T12:00:00Z',
      };

      const result = processMessage(input, 'collector-5');
      expect(result.cost_total).toBe(0.05);
      expect(result.cost_input).toBe(0.02);
      expect(result.cost_output).toBe(0.03);
    });
  });
});
