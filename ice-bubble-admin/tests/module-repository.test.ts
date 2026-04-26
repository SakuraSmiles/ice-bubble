/**
 * ModuleRepository 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDatabase, initializeSchema } from './helpers/sqlite-test-helper.js';
import { ModuleRepository } from '../src/storage/module-repository.js';
import type Database from 'better-sqlite3';
import type { ModuleRegistry, ModuleHealth, ModuleStatus } from '../src/types/module.js';

function createRepo(db?: Database.Database) {
  const database = db || createInMemoryDatabase();
  initializeSchema(database);
  return new ModuleRepository(database);
}

describe('ModuleRepository', () => {
  describe('Module Registration (upsertModule)', () => {
    it('应该成功注册新模块', async () => {
      const repo = createRepo();
      const module: ModuleRegistry = {
        moduleKey: 'test-module',
        moduleName: 'Test Module',
        moduleType: 'collector',
        status: 'running',
        version: '1.0.0',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await repo.upsertModule(module);
      expect(result.moduleKey).toBe('test-module');
      expect(result.moduleName).toBe('Test Module');
      expect(result.status).toBe('running');
    });

    it('应该更新已存在的模块', async () => {
      const repo = createRepo();
      const module: ModuleRegistry = {
        moduleKey: 'test-module',
        moduleName: 'Original Name',
        moduleType: 'collector',
        status: 'running',
        version: '1.0.0',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await repo.upsertModule(module);
      module.moduleName = 'Updated Name';
      module.status = 'stopped';
      const updated = await repo.upsertModule(module);

      expect(updated.moduleName).toBe('Updated Name');
      expect(updated.status).toBe('stopped');
    });
  });

  describe('getModules (list with pagination)', () => {
    beforeEach(() => {
      const repo = createRepo();
    });

    it('应该返回空列表（无数据时）', async () => {
      const repo = createRepo();
      const result = await repo.getModules();
      expect(result.modules).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('应该支持分页', async () => {
      const repo = createRepo();
      for (let i = 0; i < 25; i++) {
        await repo.upsertModule({
          moduleKey: `module-${i}`,
          moduleName: `Module ${i}`,
          moduleType: 'collector',
          status: 'running',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const page1 = await repo.getModules({ page: 1, limit: 10 });
      expect(page1.modules.length).toBe(10);
      expect(page1.total).toBe(25);
      expect(page1.totalPages).toBe(3);

      const page2 = await repo.getModules({ page: 2, limit: 10 });
      expect(page2.modules.length).toBe(10);

      const page3 = await repo.getModules({ page: 3, limit: 10 });
      expect(page3.modules.length).toBe(5);
    });

    it('应该支持按 moduleType 过滤', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'C1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'm2', moduleName: 'A1', moduleType: 'admin', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      const result = await repo.getModules({ moduleType: 'collector' });
      expect(result.total).toBe(1);
      expect(result.modules[0].moduleKey).toBe('m1');
    });

    it('应该支持按 status 过滤', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'm2', moduleName: 'M2', moduleType: 'collector', status: 'stopped', createdAt: new Date(), updatedAt: new Date() });

      const result = await repo.getModules({ status: 'stopped' });
      expect(result.total).toBe(1);
      expect(result.modules[0].moduleKey).toBe('m2');
    });

    it('应该支持 search 模糊搜索', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'collector-a', moduleName: 'Collector Alpha', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'collector-b', moduleName: 'Collector Beta', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'admin-a', moduleName: 'Admin Alpha', moduleType: 'admin', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      const result = await repo.getModules({ search: 'Alpha' });
      expect(result.total).toBe(2);
    });

    it('应该支持排序参数（白名单）', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', version: '1.0.0', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'm2', moduleName: 'M2', moduleType: 'collector', status: 'running', version: '2.0.0', createdAt: new Date(), updatedAt: new Date() });

      const byVersion = await repo.getModules({ sortBy: 'version', sortOrder: 'desc' });
      expect(byVersion.modules[0].version).toBe('2.0.0');

      const byVersionAsc = await repo.getModules({ sortBy: 'version', sortOrder: 'asc' });
      expect(byVersionAsc.modules[0].version).toBe('1.0.0');
    });
  });

  describe('getModule (detail)', () => {
    it('应该返回模块详情', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', version: '1.0.0', createdAt: new Date(), updatedAt: new Date() });

      const detail = await repo.getModule('m1');
      expect(detail).not.toBeNull();
      expect(detail!.module.moduleKey).toBe('m1');
      expect(detail!.module.version).toBe('1.0.0');
    });

    it('不存在的模块应该返回 null', async () => {
      const repo = createRepo();
      const detail = await repo.getModule('non-existent');
      expect(detail).toBeNull();
    });
  });

  describe('updateModuleStatus', () => {
    it('应该更新模块状态', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      await repo.updateModuleStatus('m1', 'stopped');

      const detail = await repo.getModule('m1');
      expect(detail!.module.status).toBe('stopped');
    });

    it('更新不存在的模块应该抛出错误', async () => {
      const repo = createRepo();
      await expect(repo.updateModuleStatus('non-existent', 'running')).rejects.toThrow();
    });
  });

  describe('deleteModule', () => {
    it('应该删除模块', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      const deleted = await repo.deleteModule('m1');
      expect(deleted).toBe(true);

      const detail = await repo.getModule('m1');
      expect(detail).toBeNull();
    });

    it('删除不存在的模块应该返回 false', async () => {
      const repo = createRepo();
      const deleted = await repo.deleteModule('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('Module Runtime Status', () => {
    it('getModuleRuntimeStatus 应该返回 null（无数据时）', async () => {
      const repo = createRepo();
      const status = await repo.getModuleRuntimeStatus('non-existent');
      expect(status).toBeNull();
    });
  });

  describe('Module Health', () => {
    it('recordModuleHealth 应该记录健康状态', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      const health: ModuleHealth = {
        moduleKey: 'm1',
        healthStatus: 'healthy',
        checkTime: new Date(),
        details: { cpu: 10, memory: 20 },
        message: 'All good',
      };

      await repo.recordModuleHealth(health);
      const summary = await repo.getHealthSummary();
      expect(summary.totalModules).toBe(1);
      expect(summary.healthy).toBe(1);
    });

    it('getHealthSummary 应该正确统计健康状态', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });
      await repo.upsertModule({ moduleKey: 'm2', moduleName: 'M2', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      await repo.recordModuleHealth({ moduleKey: 'm1', healthStatus: 'healthy', checkTime: new Date() });
      await repo.recordModuleHealth({ moduleKey: 'm2', healthStatus: 'error', checkTime: new Date() });

      const summary = await repo.getHealthSummary();
      expect(summary.totalModules).toBe(2);
      expect(summary.healthy).toBe(1);
      expect(summary.error).toBe(1);
    });
  });

  describe('saveModuleStatus', () => {
    it('应该保存模块状态', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      await repo.saveModuleStatus('m1', {
        status: 'running',
        version: '2.0.0',
        runtime: {
          startTime: '2024-01-01T00:00:00Z',
          uptimeSeconds: 3600,
          messagesCollected: 100,
          errorsCount: 2,
        },
        lastPollTime: '2024-01-01T01:00:00Z',
        latencyMs: 50,
      });

      const status = await repo.getModuleStatus('m1');
      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');
      expect(status!.version).toBe('2.0.0');
      expect(status!.runtime!.uptimeSeconds).toBe(3600);
      expect(status!.latencyMs).toBe(50);
    });

    it('状态为 error 时应该保存错误信息', async () => {
      const repo = createRepo();
      await repo.upsertModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', createdAt: new Date(), updatedAt: new Date() });

      await repo.saveModuleStatus('m1', {
        status: 'error',
        lastPollTime: '2024-01-01T01:00:00Z',
        lastError: 'Connection refused',
        latencyMs: 0,
      });

      const status = await repo.getModuleStatus('m1');
      expect(status!.status).toBe('error');
      expect(status!.lastError).toBe('Connection refused');
    });
  });

  describe('registerModule', () => {
    it('应该注册模块（简化版 upsert）', async () => {
      const repo = createRepo();
      await repo.registerModule({
        moduleKey: 'collector-new',
        moduleName: 'New Collector',
        moduleType: 'collector',
        status: 'running',
        version: '1.0.0',
      });

      const detail = await repo.getModule('collector-new');
      expect(detail).not.toBeNull();
      expect(detail!.module.moduleName).toBe('New Collector');
    });
  });

  describe('getModuleCreatedAt / getModuleVersion', () => {
    it('应该返回模块创建时间', async () => {
      const repo = createRepo();
      await repo.registerModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running', version: '1.0.0' });

      const createdAt = repo.getModuleCreatedAt('m1');
      expect(createdAt).not.toBeNull();

      const version = repo.getModuleVersion('m1');
      expect(version).toBe('1.0.0');
    });

    it('不存在的模块应该返回 null', () => {
      const repo = createRepo();
      expect(repo.getModuleCreatedAt('non-existent')).toBeNull();
      expect(repo.getModuleVersion('non-existent')).toBeNull();
    });
  });

  describe('getDatabaseStats', () => {
    it('应该返回数据库统计', async () => {
      const repo = createRepo();
      await repo.registerModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running' });
      await repo.recordModuleHealth({ moduleKey: 'm1', healthStatus: 'healthy', checkTime: new Date() });

      const stats = await repo.getDatabaseStats();
      expect(stats.moduleCount).toBe(1);
      expect(stats.healthCount).toBe(1);
    });
  });
});
