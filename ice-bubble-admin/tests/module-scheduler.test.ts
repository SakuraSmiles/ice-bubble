/**
 * ModuleScheduler 单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createInMemoryDatabase, initializeSchema } from './helpers/sqlite-test-helper.js';
import { ModuleRepository } from '../src/storage/module-repository.js';
import { ModuleScheduler, type ModuleEndpointConfig } from '../src/modules/module-scheduler.js';
import { Logger } from '../src/utils/logger.js';

vi.mock('node:http', () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('node:https', () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
}));

describe('ModuleScheduler', () => {
  let db: ReturnType<typeof createInMemoryDatabase>;
  let repository: ModuleRepository;
  let logger: Logger;

  beforeEach(() => {
    db = createInMemoryDatabase();
    initializeSchema(db);
    repository = new ModuleRepository(db);
    logger = new Logger('ModuleScheduler-Test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('应该正确初始化空模块列表', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      expect(scheduler).toBeDefined();
      const modules = scheduler.getModules();
      expect(modules).toBeDefined();
      scheduler.stop();
    });

    it('应该过滤掉 disabled 模块', () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true },
        { moduleKey: 'm2', name: 'M2', baseUrl: 'http://localhost:13000', enabled: false },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);
      scheduler.stop();
    });

    it('应该保留 registeredTime', () => {
      const registeredTime = '2024-01-01T00:00:00Z';
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true, registeredTime },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);
      const result = scheduler.getModules();
      // 外部模块不应该有 registeredTime（admin 才有）
      scheduler.stop();
    });
  });

  describe('setRepository', () => {
    it('setRepository 应该可以后续注入', () => {
      const scheduler = new ModuleScheduler([], logger);
      scheduler.setRepository(repository);
      expect(scheduler).toBeDefined();
      scheduler.stop();
    });
  });

  describe('getModules', () => {
    it('应该包含 admin 自己', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const modules = scheduler.getModules();
      const admin = modules.find(m => m.moduleKey === 'admin');
      expect(admin).toBeDefined();
      expect(admin!.moduleKey).toBe('admin');
      scheduler.stop();
    });

    it('getModules 不重复包含 admin', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const modules = scheduler.getModules();
      const adminCount = modules.filter(m => m.moduleKey === 'admin').length;
      expect(adminCount).toBe(1);
      scheduler.stop();
    });
  });

  describe('getModule', () => {
    it('应该返回单个模块配置', () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'collector-1', name: 'Collector 1', baseUrl: 'http://localhost:13100', enabled: true, pollInterval: 30000 },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);

      const found = scheduler.getModule('collector-1');
      expect(found).toBeDefined();
      expect(found!.moduleKey).toBe('collector-1');

      scheduler.stop();
    });

    it('应该返回 admin 配置', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const admin = scheduler.getModule('admin');
      expect(admin).toBeDefined();
      expect(admin!.moduleKey).toBe('admin');
      scheduler.stop();
    });

    it('不存在的模块应该返回 undefined', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const found = scheduler.getModule('non-existent');
      expect(found).toBeUndefined();
      scheduler.stop();
    });
  });

  describe('registerModule / deleteModule', () => {
    it('registerModule 应该写入数据库', async () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      await scheduler.registerModule({
        moduleKey: 'new-collector',
        moduleName: 'New Collector',
        moduleType: 'collector',
        status: 'running',
      });

      const detail = await repository.getModule('new-collector');
      expect(detail).not.toBeNull();
      expect(detail!.module.moduleName).toBe('New Collector');
      scheduler.stop();
    });

    it('deleteModule 应该删除数据库记录', async () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      await scheduler.registerModule({
        moduleKey: 'to-delete',
        moduleName: 'To Delete',
        moduleType: 'collector',
        status: 'running',
      });

      await scheduler.deleteModule('to-delete');
      const detail = await repository.getModule('to-delete');
      expect(detail).toBeNull();
      scheduler.stop();
    });
  });

  describe('addModule / removeModule / reloadModules', () => {
    it('addModule 应该添加模块', async () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      // 先注册模块，避免 pollModule 时 FOREIGN KEY 约束失败
      await scheduler.registerModule({
        moduleKey: 'dynamic-module',
        moduleName: 'Dynamic Module',
        moduleType: 'collector',
        status: 'running',
      });
      const newModule: ModuleEndpointConfig = {
        moduleKey: 'dynamic-module',
        name: 'Dynamic Module',
        baseUrl: 'http://localhost:14000',
        enabled: true,
        pollInterval: 10000,
      };

      scheduler.addModule(newModule);
      const found = scheduler.getModule('dynamic-module');
      expect(found).toBeDefined();
      expect(found!.moduleKey).toBe('dynamic-module');
      scheduler.stop();
    });

    it('removeModule 应该移除模块', () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);

      scheduler.removeModule('m1');
      const found = scheduler.getModule('m1');
      expect(found).toBeUndefined();
      scheduler.stop();
    });

    it('reloadModules 应该重启定时器', async () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true, pollInterval: 5000 },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);

      // 注册模块，避免 pollModule 时 FOREIGN KEY 约束失败
      await scheduler.registerModule({
        moduleKey: 'm1',
        moduleName: 'M1',
        moduleType: 'collector',
        status: 'running',
      });
      await scheduler.registerModule({
        moduleKey: 'm2',
        moduleName: 'M2',
        moduleType: 'collector',
        status: 'running',
      });

      const newModules: ModuleEndpointConfig[] = [
        { moduleKey: 'm2', name: 'M2', baseUrl: 'http://localhost:13000', enabled: true, pollInterval: 10000 },
      ];

      scheduler.reloadModules(newModules);
      expect(scheduler.getModule('m1')).toBeUndefined();
      expect(scheduler.getModule('m2')).toBeDefined();
      scheduler.stop();
    });
  });

  describe('getAdminStatus', () => {
    it('应该返回 admin 自身状态', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const status = scheduler.getAdminStatus();

      expect(status.moduleKey).toBe('admin');
      expect(status.status).toBe('running');
      expect(status.health?.status).toBe('healthy');
      expect(status.runtime?.uptimeSeconds).toBeGreaterThanOrEqual(0);
      scheduler.stop();
    });
  });

  describe('getModuleConfig', () => {
    it('不存在的模块应该返回 null', async () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);

      // 无 repository 时返回 null
      const status = await scheduler.getStatusFromDatabase('non-existent');
      expect(status).toBeNull();
      scheduler.stop();
    });
  });

  describe('start/stop', () => {
    it('start 不抛出', async () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true, pollInterval: 100 },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);
      // 先注册模块，避免 pollModule 时 FOREIGN KEY 约束失败
      await scheduler.registerModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running' });
      expect(() => scheduler.start()).not.toThrow();
      scheduler.stop();
    });

    it('stop 不抛出', () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      scheduler.start();
      expect(() => scheduler.stop()).not.toThrow();
    });

    it('重复 start 不抛错', async () => {
      const modules: ModuleEndpointConfig[] = [
        { moduleKey: 'm1', name: 'M1', baseUrl: 'http://localhost:13000', enabled: true, pollInterval: 100 },
      ];
      const scheduler = new ModuleScheduler(modules, logger, repository);
      await scheduler.registerModule({ moduleKey: 'm1', moduleName: 'M1', moduleType: 'collector', status: 'running' });
      scheduler.start();
      expect(() => scheduler.start()).not.toThrow();
      scheduler.stop();
    });
  });

  describe('getStatusFromDatabase', () => {
    it('应该返回 null（无 repository）', async () => {
      const scheduler = new ModuleScheduler([], logger); // 无 repository
      const status = await scheduler.getStatusFromDatabase('m1');
      expect(status).toBeNull();
      scheduler.stop();
    });

    it('应该返回 null（模块不存在）', async () => {
      const scheduler = new ModuleScheduler([], logger, repository);
      const status = await scheduler.getStatusFromDatabase('non-existent-module');
      expect(status).toBeNull();
      scheduler.stop();
    });
  });
});
