/**
 * AgentOverview 单元测试
 */

import { describe, it, expect } from 'vitest';
import { normalizeAgentStatus, calculateAgentStatus, OpenClawStatus, TaskEnhancementStatus } from '../src/data/agent-overview.js';

describe('agent-overview', () => {
  describe('normalizeAgentStatus', () => {
    it('应该将 工作 映射为 active', () => {
      expect(normalizeAgentStatus('工作')).toBe(OpenClawStatus.active);
    });

    it('应该将 活跃 映射为 active', () => {
      expect(normalizeAgentStatus('活跃')).toBe(OpenClawStatus.active);
    });

    it('应该将 休假 映射为 idle', () => {
      expect(normalizeAgentStatus('休假')).toBe(OpenClawStatus.idle);
    });

    it('应该将 离线 映射为 offline', () => {
      expect(normalizeAgentStatus('离线')).toBe(OpenClawStatus.offline);
    });

    it('应该将 失联 映射为 offline', () => {
      expect(normalizeAgentStatus('失联')).toBe(OpenClawStatus.offline);
    });
  });

  describe('calculateAgentStatus', () => {
    it('collector 失败且无 session 时返回 失联', () => {
      expect(calculateAgentStatus(0, null, true)).toBe('失联');
    });

    it('collector 在线且有 recent session 时返回 工作', () => {
      const recent = new Date(Date.now() - 60000).toISOString(); // 1 分钟前
      expect(calculateAgentStatus(1, recent, false)).toBe('工作');
    });

    it('无 lastActiveAt 时返回 失联', () => {
      expect(calculateAgentStatus(0, null, false)).toBe('失联');
    });

    it('lastActiveAt 在 2 分钟内返回 工作', () => {
      const recent = new Date(Date.now() - 60000).toISOString(); // 1 分钟前
      expect(calculateAgentStatus(0, recent, false)).toBe('工作');
    });

    it('lastActiveAt 在 2 分钟到 24 小时返回 活跃', () => {
      const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 小时前
      expect(calculateAgentStatus(0, hoursAgo, false)).toBe('活跃');
    });

    it('lastActiveAt 在 24-72 小时返回 休假', () => {
      const daysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48 小时前
      expect(calculateAgentStatus(0, daysAgo, false)).toBe('休假');
    });

    it('lastActiveAt 超过 72 小时返回 离线', () => {
      const daysAgo = new Date(Date.now() - 96 * 3600 * 1000).toISOString(); // 96 小时前
      expect(calculateAgentStatus(0, daysAgo, false)).toBe('离线');
    });
  });

  describe('TaskEnhancementStatus', () => {
    it('应该包含 working, idle, none', () => {
      expect(TaskEnhancementStatus.working).toBe('working');
      expect(TaskEnhancementStatus.idle).toBe('idle');
      expect(TaskEnhancementStatus.none).toBe('none');
    });
  });
});
