/**
 * session-key-builder.ts 单元测试
 * 
 * 测试内容：
 * 1. SessionKey 构造
 * 2. SessionKey 解析
 * 3. 组件提取
 * 4. 格式验证
 */

import { describe, it, expect } from 'vitest';
import {
  buildSessionKeyFromPath,
  parseSessionKey,
  buildSessionKey,
  extractAgentId,
  extractChannel,
  extractAccountId,
  extractTargetId,
  isValidSessionKey,
  SessionKeyComponents,
} from '../../../src/utils/session-key-builder';

describe('session-key-builder', () => {
  // ==================== buildSessionKeyFromPath 测试 ====================

  describe('buildSessionKeyFromPath', () => {
    it('应该从包含 SessionKey 的文件名提取', () => {
      const filePath = '/home/user/.openclaw/agents/dev/sessions/agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4');
    });

    it('应该从 UUID 文件名构造本地 SessionKey', () => {
      const filePath = '/home/user/.openclaw/agents/dev/sessions/012582c0-3fc5-4a35-818c-0dd9a1c359d4.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4');
    });

    it('应该从非 UUID 文件名构造 SessionKey', () => {
      const filePath = '/home/user/.openclaw/agents/prod/sessions/custom-session-name.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:prod:local:default:direct:custom-session-name');
    });

    it('应该正确处理 Windows 路径', () => {
      const filePath = 'C:\\Users\\dabai\\.openclaw\\agents\\dev\\sessions\\agent:dev:local:default:direct:012582c0.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:dev:local:default:direct:012582c0');
    });

    it('应该处理路径中不包含 agents 目录的情况', () => {
      const filePath = '/tmp/sessions/test-session.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:unknown:local:default:direct:test-session');
    });

    it('应该处理文件名已经是 SessionKey 格式的情况', () => {
      const filePath = '/any/path/agent:prod:discord:acc-123:direct:peer-456.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:prod:discord:acc-123:direct:peer-456');
    });

    it('应该正确处理 guild 类型的 SessionKey', () => {
      const filePath = '/home/user/.openclaw/agents/bot/sessions/agent:bot:discord:acc-123:guild:123456789.jsonl';
      
      const result = buildSessionKeyFromPath(filePath);
      
      expect(result).toBe('agent:bot:discord:acc-123:guild:123456789');
    });
  });

  // ==================== parseSessionKey 测试 ====================

  describe('parseSessionKey', () => {
    it('应该正确解析标准 SessionKey', () => {
      const sessionKey = 'agent:dev:local:default:direct:012582c0-3fc5-4a35-818c-0dd9a1c359d4';
      
      const result = parseSessionKey(sessionKey);
      
      expect(result).toEqual({
        agentId: 'dev',
        channel: 'local',
        accountId: 'default',
        type: 'direct',
        targetId: '012582c0-3fc5-4a35-818c-0dd9a1c359d4',
      });
    });

    it('应该正确解析 Discord SessionKey', () => {
      const sessionKey = 'agent:prod:discord:acc-123:direct:peer-456';
      
      const result = parseSessionKey(sessionKey);
      
      expect(result).toEqual({
        agentId: 'prod',
        channel: 'discord',
        accountId: 'acc-123',
        type: 'direct',
        targetId: 'peer-456',
      });
    });

    it('应该正确解析 guild 类型 SessionKey', () => {
      const sessionKey = 'agent:bot:discord:acc-123:guild:123456789';
      
      const result = parseSessionKey(sessionKey);
      
      expect(result).toEqual({
        agentId: 'bot',
        channel: 'discord',
        accountId: 'acc-123',
        type: 'guild',
        targetId: '123456789',
      });
    });

    it('应该拒绝无效的前缀', () => {
      const sessionKey = 'user:dev:local:default:direct:012582c0';
      
      expect(() => parseSessionKey(sessionKey)).toThrow('无效的 SessionKey 格式');
    });

    it('应该拒绝错误的格式（部分数量不对）', () => {
      const sessionKey = 'agent:dev:local:default';
      
      expect(() => parseSessionKey(sessionKey)).toThrow('SessionKey 格式错误');
    });

    it('应该拒绝错误的前缀', () => {
      const sessionKey = 'session:dev:local:default:direct:012582c0';
      
      // 先检查是否以 'agent:' 开头
      expect(() => parseSessionKey(sessionKey)).toThrow('无效的 SessionKey 格式');
    });
  });

  // ==================== buildSessionKey 测试 ====================

  describe('buildSessionKey', () => {
    it('应该正确构造 SessionKey', () => {
      const components: SessionKeyComponents = {
        agentId: 'dev',
        channel: 'local',
        accountId: 'default',
        type: 'direct',
        targetId: '012582c0',
      };
      
      const result = buildSessionKey(components);
      
      expect(result).toBe('agent:dev:local:default:direct:012582c0');
    });

    it('应该拒绝空组件', () => {
      const components: any = {
        agentId: '',
        channel: 'local',
        accountId: 'default',
        type: 'direct',
        targetId: '012582c0',
      };
      
      expect(() => buildSessionKey(components)).toThrow('SessionKey 组件不能为空');
    });

    it('应该拒绝缺少组件', () => {
      const components: any = {
        agentId: 'dev',
        channel: 'local',
        // 缺少 accountId
        type: 'direct',
        targetId: '012582c0',
      };
      
      expect(() => buildSessionKey(components)).toThrow('SessionKey 组件不能为空');
    });
  });

  // ==================== extractAgentId 测试 ====================

  describe('extractAgentId', () => {
    it('应该正确提取 Agent ID', () => {
      const sessionKey = 'agent:dev:local:default:direct:012582c0';
      
      expect(extractAgentId(sessionKey)).toBe('dev');
    });

    it('应该提取不同的 Agent ID', () => {
      expect(extractAgentId('agent:prod:discord:acc-123:direct:peer-456')).toBe('prod');
      expect(extractAgentId('agent:bot:slack:acc-456:guild:789')).toBe('bot');
    });
  });

  // ==================== extractChannel 测试 ====================

  describe('extractChannel', () => {
    it('应该正确提取 Channel', () => {
      const sessionKey = 'agent:dev:local:default:direct:012582c0';
      
      expect(extractChannel(sessionKey)).toBe('local');
    });

    it('应该提取不同的 Channel', () => {
      expect(extractChannel('agent:prod:discord:acc-123:direct:peer-456')).toBe('discord');
      expect(extractChannel('agent:bot:slack:acc-456:guild:789')).toBe('slack');
    });
  });

  // ==================== extractAccountId 测试 ====================

  describe('extractAccountId', () => {
    it('应该正确提取 Account ID', () => {
      const sessionKey = 'agent:dev:local:default:direct:012582c0';
      
      expect(extractAccountId(sessionKey)).toBe('default');
    });

    it('应该提取不同的 Account ID', () => {
      expect(extractAccountId('agent:prod:discord:acc-123:direct:peer-456')).toBe('acc-123');
      expect(extractAccountId('agent:bot:slack:acc-456:guild:789')).toBe('acc-456');
    });
  });

  // ==================== extractTargetId 测试 ====================

  describe('extractTargetId', () => {
    it('应该正确提取 Target ID', () => {
      const sessionKey = 'agent:dev:local:default:direct:012582c0';
      
      expect(extractTargetId(sessionKey)).toBe('012582c0');
    });

    it('应该提取不同的 Target ID', () => {
      expect(extractTargetId('agent:prod:discord:acc-123:direct:peer-456')).toBe('peer-456');
      expect(extractTargetId('agent:bot:slack:acc-456:guild:789')).toBe('789');
    });
  });

  // ==================== isValidSessionKey 测试 ====================

  describe('isValidSessionKey', () => {
    it('应该返回 true 对于有效的 SessionKey', () => {
      expect(isValidSessionKey('agent:dev:local:default:direct:012582c0')).toBe(true);
      expect(isValidSessionKey('agent:prod:discord:acc-123:direct:peer-456')).toBe(true);
      expect(isValidSessionKey('agent:bot:slack:acc-456:guild:789')).toBe(true);
    });

    it('应该返回 false 对于无效的 SessionKey', () => {
      expect(isValidSessionKey('invalid-key')).toBe(false);
      expect(isValidSessionKey('user:dev:local:default:direct:012582c0')).toBe(false);
      expect(isValidSessionKey('agent:dev:local:default')).toBe(false);
      expect(isValidSessionKey('')).toBe(false);
    });
  });

  // ==================== 集成测试 ====================

  describe('集成测试', () => {
    it('应该支持 SessionKey 的往返转换', () => {
      const components: SessionKeyComponents = {
        agentId: 'test-agent',
        channel: 'discord',
        accountId: 'test-acc',
        type: 'direct',
        targetId: 'test-target',
      };
      
      // 构造 SessionKey
      const sessionKey = buildSessionKey(components);
      
      // 解析 SessionKey
      const parsed = parseSessionKey(sessionKey);
      
      // 验证往返一致性
      expect(parsed).toEqual(components);
    });

    it('应该支持从路径构造并解析', () => {
      const filePath = '/home/user/.openclaw/agents/my-agent/sessions/test-session.jsonl';
      
      // 从路径构造
      const sessionKey = buildSessionKeyFromPath(filePath);
      
      // 解析
      const components = parseSessionKey(sessionKey);
      
      // 验证
      expect(components.agentId).toBe('my-agent');
      expect(components.targetId).toBe('test-session');
    });
  });
});
