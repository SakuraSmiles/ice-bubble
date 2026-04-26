/**
 * AgentStatusScheduler 测试
 *
 * 覆盖：start/stop 生命周期、调度间隔
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentStatusScheduler } from './agent-status-scheduler.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';

// Silence Logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
}));

function mockRepository(overrides: {
  findTasksResult?: { tasks: unknown[]; total: number };
  updateTaskStatusResult?: boolean;
} = {}) {
  return {
    findTasks: vi.fn().mockReturnValue(
      overrides.findTasksResult ?? { tasks: [], total: 0 }
    ),
    updateTaskStatus: vi.fn().mockReturnValue(
      overrides.updateTaskStatusResult !== undefined ? overrides.updateTaskStatusResult : true
    ),
    findById: vi.fn().mockReturnValue(null),
    upsertTask: vi.fn(),
    upsertTasks: vi.fn().mockReturnValue(0),
    findByAgentId: vi.fn().mockReturnValue({ tasks: [], total: 0 }),
    findByParentId: vi.fn().mockReturnValue([]),
    findParentTasks: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
    getTasksOlderThan: vi.fn().mockReturnValue([]),
  };
}

let testDir: string;
let testStorePath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `agent-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  testStorePath = join(testDir, 'task-store.json');
});

afterEach(() => {
  try {
    // Cleanup lock dir if exists
    const lockDir = testStorePath + '.lock';
    if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('AgentStatusScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── start/stop lifecycle ─────────────────────────────

  describe('start/stop', () => {
    it('isRunning is false before start', () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('isRunning is true after start', () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('isRunning is false after stop', () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('start is idempotent', () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });
  });

  // ─── scheduling interval ──────────────────────────────

  describe('scheduling interval', () => {
    it('triggers sync after one interval', async () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 5000);
      scheduler.start();

      expect(repo.findTasks).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(100);

      expect(repo.findTasks).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('triggers sync multiple times', async () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 3000);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(100);
      expect(repo.findTasks).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(100);
      expect(repo.findTasks).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('uses custom interval from constructor', async () => {
      const repo = mockRepository();
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 7500);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(5000);
      expect(repo.findTasks).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(100);
      expect(repo.findTasks).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });
  });

  // ─── sync behavior ────────────────────────────────────

  describe('sync', () => {
    it('sync finds pending tasks', async () => {
      const repo = mockRepository({
        findTasksResult: { tasks: [{ id: 't1', agent_id: 'a1', status: 'pending' }], total: 1 },
      });
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();

      // Advance past the interval so the scheduled sync fires
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(100);

      expect(repo.findTasks).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('processes pending tasks', async () => {
      const repo = mockRepository({
        findTasksResult: {
          tasks: [
            { id: 't1', agent_id: 'agent-1', status: 'pending' },
            { id: 't2', agent_id: 'agent-1', status: 'pending' },
          ],
          total: 2,
        },
      });
      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(100);

      expect(repo.findTasks).toHaveBeenCalledWith({ status: 'pending', limit: 1000 });

      scheduler.stop();
    });

    it('syncs statusUpdates from task-store.json', async () => {
      // Create a store with pending statusUpdates
      const storeData = {
        tasks: {},
        counter: 5,
        statusUpdates: {
          'task-1': { status: 'completed', updated_at: '2024-01-01T00:00:00Z' },
          'task-2': { status: 'failed', updated_at: '2024-01-01T00:01:00Z' },
        },
      };
      writeFileSync(testStorePath, JSON.stringify(storeData), 'utf-8');

      const repo = mockRepository({
        findTasksResult: { tasks: [], total: 0 },
      });

      const scheduler = new AgentStatusScheduler(repo, testStorePath, 1000);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(100);

      // Should have updated both task statuses
      expect(repo.updateTaskStatus).toHaveBeenCalledWith('task-1', 'completed');
      expect(repo.updateTaskStatus).toHaveBeenCalledWith('task-2', 'failed');

      // Store should be cleaned up (statusUpdates cleared)
      const afterContent = JSON.parse(require('fs').readFileSync(testStorePath, 'utf-8'));
      expect(afterContent.statusUpdates).toEqual({});
      expect(afterContent.counter).toBe(5);

      scheduler.stop();
    });
  });
});
