/**
 * CollectScheduler 测试
 *
 * 覆盖：start/stop 生命周期、调度间隔、重叠防止
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CollectScheduler } from '../scheduler/collect-scheduler.js';
import type { CollectorInterface } from '../collectors/collector-interface.js';
import type { CollectResult } from '../types/task.js';

// Silence Logger console output
vi.mock('../utils/logger.js', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
    child() { return this; }
    setLevel() {}
  },
}));

function mockCollector(overrides: {
  name?: string;
  collectResult?: CollectResult;
  isAvailableResult?: boolean;
  collectDelayMs?: number;
} = {}): { collector: CollectorInterface; mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const collectFn = vi.fn().mockImplementation(async () => {
    if (overrides.collectDelayMs) {
      await new Promise(r => setTimeout(r, overrides.collectDelayMs));
    }
    return overrides.collectResult ?? { collected: 1, updated: 0, errors: [] };
  });

  const availableFn = vi.fn().mockResolvedValue(
    overrides.isAvailableResult !== undefined ? overrides.isAvailableResult : true
  );

  return {
    collector: {
      name: overrides.name ?? 'mock-collector',
      collect: collectFn,
      isAvailable: availableFn,
    },
    mocks: { collect: collectFn, isAvailable: availableFn },
  };
}

describe('CollectScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── start/stop lifecycle ─────────────────────────────

  describe('start/stop', () => {
    it('isRunning is false before start', () => {
      const { collector } = mockCollector();
      const scheduler = new CollectScheduler([collector], 1000);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('isRunning is true after start', () => {
      const { collector } = mockCollector();
      const scheduler = new CollectScheduler([collector], 1000);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('isRunning is false after stop', () => {
      const { collector } = mockCollector();
      const scheduler = new CollectScheduler([collector], 1000);
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('start is idempotent — calling twice does not throw', () => {
      const { collector } = mockCollector();
      const scheduler = new CollectScheduler([collector], 1000);
      scheduler.start();
      scheduler.start(); // should not throw
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });
  });

  // ─── scheduling interval ──────────────────────────────

  describe('scheduling interval', () => {
    it('triggers collect after one interval', async () => {
      const { collector, mocks } = mockCollector();
      const scheduler = new CollectScheduler([collector], 5000);
      scheduler.start();

      expect(mocks.collect).not.toHaveBeenCalled();

      // Advance past the initial interval
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(100); // let the collect promise settle

      expect(mocks.collect).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('triggers collect multiple times over multiple intervals', async () => {
      const { collector, mocks } = mockCollector();
      const scheduler = new CollectScheduler([collector], 3000);
      scheduler.start();

      // First interval
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.collect).toHaveBeenCalledTimes(1);

      // Second interval
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.collect).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });
  });

  // ─── overlap prevention ───────────────────────────────

  describe('overlap prevention', () => {
    it('skips manual runCollect if a collect is already in progress', async () => {
      const { collector, mocks } = mockCollector({ collectDelayMs: 5000 });
      const scheduler = new CollectScheduler([collector], 1000);

      // Don't start the scheduler — just test runCollect directly
      // to avoid the scheduled collect interfering with the overlap test
      const p1 = scheduler.runCollect();
      expect(scheduler.isCollecting()).toBe(true);

      // Try another while first is still running
      const p2 = scheduler.runCollect();
      expect(scheduler.isCollecting()).toBe(true);

      // Let the first collect finish
      await vi.advanceTimersByTimeAsync(5000);
      await p1;
      await p2;

      // Only one actual collect call (the second was skipped)
      expect(mocks.collect).toHaveBeenCalledTimes(1);
    });

    it('handles collector errors gracefully', async () => {
      const collector = {
        name: 'failing-collector',
        collect: vi.fn().mockRejectedValue(new Error('network error')),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const scheduler = new CollectScheduler([collector], 1000);
      scheduler.start();

      // This should not throw
      await expect(scheduler.runCollect()).resolves.toBeUndefined();

      scheduler.stop();
    });

    it('skips unavailable collectors', async () => {
      const { mocks } = mockCollector({ isAvailableResult: false });

      const scheduler = new CollectScheduler([mocks as any], 1000);
      await scheduler.runCollect();

      expect(mocks.collect).not.toHaveBeenCalled();
    });
  });

  // ─── runCollect directly ──────────────────────────────

  describe('runCollect', () => {
    it('executes all available collectors', async () => {
      const c1 = mockCollector({ name: 'c1', collectResult: { collected: 1, updated: 0, errors: [] } });
      const c2 = mockCollector({ name: 'c2', collectResult: { collected: 2, updated: 1, errors: [] } });

      const scheduler = new CollectScheduler([c1.collector, c2.collector], 1000);
      await scheduler.runCollect();

      expect(c1.mocks.collect).toHaveBeenCalledTimes(1);
      expect(c2.mocks.collect).toHaveBeenCalledTimes(1);
    });

    it('isCollecting flag is set during collection', async () => {
      const { collector } = mockCollector({ collectDelayMs: 100 });
      const scheduler = new CollectScheduler([collector], 1000);

      expect(scheduler.isCollecting()).toBe(false);

      const promise = scheduler.runCollect();
      expect(scheduler.isCollecting()).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(scheduler.isCollecting()).toBe(false);
    });
  });
});
