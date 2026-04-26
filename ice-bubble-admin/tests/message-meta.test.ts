/**
 * message-meta 单元测试
 */

import { describe, it, expect } from 'vitest';
import { analyzeMessageMeta, isSystemNoise } from '../src/utils/message-meta.js';

describe('message-meta', () => {
  describe('analyzeMessageMeta', () => {
    it('应该处理 user 类型 HEARTBEAT_OK', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'HEARTBEAT_OK',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
      expect(result.clean_content).toBe('HEARTBEAT_OK');
    });

    it('应该处理 user 类型 NO_REPLY', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'NO_REPLY',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 cron 消息', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: '[cron:daily] 每天早上执行',
        agent_name: 'Test Agent',
      });
      expect(result.is_cron).toBe(true);
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 System: 格式', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'System: some command executed',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 Sender metadata 块', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'Sender (untrusted metadata):\n```json\n{"label": "telegram"}\n```\nActual message here',
        agent_name: 'Test Agent',
      });
      expect(result.source_channel).toBe('telegram');
    });

    it('应该检测 Read HEARTBEAT.md', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'Read HEARTBEAT.md for status',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 Exec completed', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'Exec completed: ls -la',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 Exec failed', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'Exec failed: command not found',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 git commit 输出', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: '[abc123] built in 1.5s, 3 modules transformed',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该检测 vite build 输出', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: '[build] built in 1.5s, 3 modules transformed',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理 agent 类型空内容', () => {
      const result = analyzeMessageMeta({
        message_type: 'agent',
        content: '',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理 agent 类型 NULL', () => {
      const result = analyzeMessageMeta({
        message_type: 'agent',
        content: 'NULL',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理 agent 类型 HEARTBEAT_OK', () => {
      const result = analyzeMessageMeta({
        message_type: 'agent',
        content: 'HEARTBEAT_OK',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
      expect(result.clean_content).toBe('');
    });

    it('应该处理 agent 类型任务状态消息', () => {
      const result = analyzeMessageMeta({
        message_type: 'agent',
        content: '暂无活跃子任务',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理 tool 类型空回复', () => {
      const result = analyzeMessageMeta({
        message_type: 'tool',
        content: '',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
      expect(result.clean_content).toBe('');
    });

    it('应该处理 tool 类型 NULL', () => {
      const result = analyzeMessageMeta({
        message_type: 'tool',
        content: 'NULL',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理 tool 类型 {}', () => {
      const result = analyzeMessageMeta({
        message_type: 'tool',
        content: '{}',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(true);
    });

    it('应该处理普通 user 消息', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'Hello, how are you?',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(false);
      expect(result.is_cron).toBe(false);
      expect(result.clean_content).toBe('Hello, how are you?');
    });

    it('应该生成 content_summary', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: 'This is a normal user message that is somewhat long',
        agent_name: 'Test Agent',
      });
      expect(result.content_summary.length).toBeGreaterThan(0);
      expect(result.content_summary.length).toBeLessThanOrEqual(120);
    });

    it('应该处理 null content', () => {
      const result = analyzeMessageMeta({
        message_type: 'user',
        content: null,
        agent_name: 'Test Agent',
      });
      expect(result.clean_content).toBe('');
      expect(result.is_system_noise).toBe(false);
    });

    it('应该处理 agent 类型普通消息', () => {
      const result = analyzeMessageMeta({
        message_type: 'agent',
        content: 'I think we should proceed with the plan.',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(false);
      expect(result.clean_content).toBe('I think we should proceed with the plan.');
    });

    it('应该处理 tool 类型普通消息', () => {
      const result = analyzeMessageMeta({
        message_type: 'tool',
        content: 'File created successfully at /path/to/file.txt',
        agent_name: 'Test Agent',
      });
      expect(result.is_system_noise).toBe(false);
      expect(result.content_summary.length).toBeLessThanOrEqual(63);
    });
  });

  describe('isSystemNoise', () => {
    it('应该识别 null content', () => {
      expect(isSystemNoise('user', null)).toBe(true);
    });

    it('应该识别空字符串', () => {
      expect(isSystemNoise('user', '')).toBe(true);
    });

    it('应该识别 NULL 字符串', () => {
      expect(isSystemNoise('user', 'NULL')).toBe(true);
    });

    it('应该识别 HEARTBEAT_OK', () => {
      expect(isSystemNoise('user', 'HEARTBEAT_OK')).toBe(true);
      expect(isSystemNoise('agent', 'HEARTBEAT_OK')).toBe(true);
    });

    it('应该识别 NO_REPLY', () => {
      expect(isSystemNoise('user', 'NO_REPLY')).toBe(true);
    });

    it('应该识别 cron 消息', () => {
      expect(isSystemNoise('user', '[cron:daily]')).toBe(true);
    });

    it('应该识别 System: 格式', () => {
      expect(isSystemNoise('user', 'System: running command')).toBe(true);
    });

    it('应该识别 Read HEARTBEAT.md', () => {
      expect(isSystemNoise('user', 'Read HEARTBEAT.md')).toBe(true);
    });

    it('应该识别 Exec completed', () => {
      expect(isSystemNoise('user', 'Exec completed: ls')).toBe(true);
    });

    it('应该识别 Exec failed', () => {
      expect(isSystemNoise('user', 'Exec failed: error')).toBe(true);
    });

    it('应该识别 git commit', () => {
      expect(isSystemNoise('user', '[abc123] built in 1.5s, 3 modules transformed')).toBe(true);
    });

    it('应该识别 vite build', () => {
      expect(isSystemNoise('user', '[x123] built in 1s, 5 modules')).toBe(true);
    });

    it('应该识别 agent 暂无活跃子任务', () => {
      expect(isSystemNoise('agent', '暂无活跃子任务')).toBe(true);
    });

    it('应该识别 agent 任务状态巡检完成', () => {
      expect(isSystemNoise('agent', '任务状态巡检完成')).toBe(true);
    });

    it('应该识别 tool {}', () => {
      expect(isSystemNoise('tool', '{}')).toBe(true);
    });

    it('应该识别 tool []', () => {
      expect(isSystemNoise('tool', '[]')).toBe(true);
    });

    it('应该识别 tool ok', () => {
      expect(isSystemNoise('tool', 'ok')).toBe(true);
    });

    it('应该识别 tool null', () => {
      expect(isSystemNoise('tool', 'null')).toBe(true);
    });

    it('应该识别普通消息为非噪音', () => {
      expect(isSystemNoise('user', 'Hello world')).toBe(false);
      expect(isSystemNoise('agent', 'I think we should go')).toBe(false);
      expect(isSystemNoise('tool', 'File created at /path')).toBe(false);
    });

    it('应该识别短 System: 为非噪音', () => {
      expect(isSystemNoise('user', 'System: hi')).toBe(false);
    });
  });
});
