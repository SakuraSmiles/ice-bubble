/**
 * Module Scheduler - 模块调度器
 * 
 * 负责定时从各个模块获取状态数据
 * 
 * @module ModuleScheduler
 */

export interface ModuleEndpointConfig {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval?: number;
}

export interface ModuleStatus {
  moduleKey: string;
  moduleType: string;
  version: string;
  status: 'running' | 'stopped' | 'error';
  runtime?: {
    startTime: string;
    uptimeSeconds: number;
    messagesCollected?: number;
    errorsCount?: number;
  };
  health?: {
    status: 'healthy' | 'warning' | 'error';
    message?: string;
  };
}

// 前向声明，避免循环依赖
import type { ModuleRepository } from '../storage/module-repository.js';

export class ModuleScheduler {
  private modules: ModuleEndpointConfig[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private logger = console;
  private repository?: ModuleRepository;
  private adminStartTime: Date;

  constructor(modules: ModuleEndpointConfig[], repository?: ModuleRepository) {
    this.modules = modules.filter(m => m.enabled);
    this.repository = repository;
    this.adminStartTime = new Date();
  }

  /**
   * 设置存储仓库（供后续注入）
   */
  setRepository(repository: ModuleRepository): void {
    this.repository = repository;
  }

  /**
   * 启动调度器
   */
  start(): void {
    this.logger.log('[ModuleScheduler] 启动调度器');
    for (const module of this.modules) {
      this.pollModule(module);
      const interval = module.pollInterval || 30000;
      const timer = setInterval(() => this.pollModule(module), interval);
      this.timers.set(module.moduleKey, timer);
    }
    this.logger.log(`[ModuleScheduler] 已启动 ${this.modules.length} 个模块`);
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.logger.log('[ModuleScheduler] 停止调度器');
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * 手动触发单个模块的状态更新
   */
  async pollModuleNow(moduleKey: string): Promise<ModuleStatus | null> {
    const module = this.modules.find(m => m.moduleKey === moduleKey);
    if (!module) {
      this.logger.warn(`[ModuleScheduler] 模块不存在: ${moduleKey}`);
      return null;
    }
    return this.pollModule(module);
  }

  /**
   * 获取所有模块列表（包含 admin 自己）
   */
  getModules(): ModuleEndpointConfig[] {
    const adminSelf: ModuleEndpointConfig = {
      moduleKey: 'admin',
      name: 'Admin 管理后台',
      baseUrl: `http://localhost:${process.env.PORT || 13000}`,
      enabled: true,
      pollInterval: 0  // admin 自己不需要轮询
    };
    return [adminSelf, ...this.modules];
  }

  /**
   * 获取单个模块配置
   */
  getModule(moduleKey: string): ModuleEndpointConfig | undefined {
    // 先在 modules 中查找
    const found = this.modules.find(m => m.moduleKey === moduleKey);
    if (found) return found;

    // 如果是 admin 自己，返回自检配置
    if (moduleKey === 'admin') {
      return {
        moduleKey: 'admin',
        name: 'Admin 管理后台',
        baseUrl: `http://localhost:${process.env.PORT || 13000}`,
        enabled: true,
        pollInterval: 0
      };
    }

    return undefined;
  }

  /**
   * 获取模块状态
   */
  private async pollModule(module: ModuleEndpointConfig): Promise<ModuleStatus | null> {
    try {
      // 设置 NO_PROXY 避免代理问题
      const originalNoProxy = process.env.NO_PROXY;
      process.env.NO_PROXY = process.env.NO_PROXY + ',localhost';
      
      const url = `${module.baseUrl.replace(/\/$/, '')}/api/meta/status`;
      const response = await fetch(url);
      
      // 恢复 NO_PROXY
      process.env.NO_PROXY = originalNoProxy;
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json() as unknown as ModuleStatus;
      this.logger.log(`[ModuleScheduler] 获取到 ${module.moduleKey} 状态: ${data.status || 'unknown'}`);

      // 存入数据库
      if (this.repository) {
        await this.repository.saveModuleStatus(module.moduleKey, data);
      }

      return data;
    } catch (error) {
      this.logger.error(`[ModuleScheduler] 获取 ${module.moduleKey} 失败:`, error);
      return null;
    }
  }

  /**
   * 获取 admin 自检状态
   */
  getAdminStatus(): ModuleStatus {
    const uptimeSeconds = Math.floor((Date.now() - this.adminStartTime.getTime()) / 1000);
    return {
      moduleKey: 'admin',
      moduleType: 'admin',
      version: '1.0.0',
      status: 'running',
      runtime: {
        startTime: this.adminStartTime.toISOString(),
        uptimeSeconds,
        messagesCollected: 0,
        errorsCount: 0
      },
      health: {
        status: 'healthy',
        message: 'Admin 服务运行正常'
      }
    };
  }

  /**
   * 获取模块运行时配置
   */
  async getModuleConfig(moduleKey: string): Promise<Record<string, unknown> | null> {
    const module = this.modules.find(m => m.moduleKey === moduleKey);
    if (!module) {
      this.logger.warn(`[ModuleScheduler] 模块不存在: ${moduleKey}`);
      return null;
    }

    try {
      // 设置 NO_PROXY 避免代理问题
      const originalNoProxy = process.env.NO_PROXY;
      process.env.NO_PROXY = process.env.NO_PROXY + ',localhost';
      
      const url = `${module.baseUrl.replace(/\/$/, '')}/api/meta/config`;
      const response = await fetch(url);
      
      // 恢复 NO_PROXY
      process.env.NO_PROXY = originalNoProxy;
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json() as Record<string, unknown>;
      this.logger.log(`[ModuleScheduler] 获取到 ${module.moduleKey} 配置`);
      
      return data;
    } catch (error) {
      this.logger.error(`[ModuleScheduler] 获取 ${module.moduleKey} 配置失败:`, error);
      return null;
    }
  }

  /**
   * 从数据库获取模块状态（供 API 使用）
   */
  async getStatusFromDatabase(moduleKey: string): Promise<ModuleStatus | null> {
    if (!this.repository) {
      return null;
    }

    try {
      const row = await this.repository.getModuleStatus(moduleKey);
      if (!row) return null;

      return {
        moduleKey,
        moduleType: '',
        version: row.version || '',
        status: row.status,
        runtime: row.runtime ? {
          startTime: row.runtime.startTime,
          uptimeSeconds: row.runtime.uptimeSeconds,
          messagesCollected: row.runtime.messagesCollected,
          errorsCount: row.runtime.errorsCount,
        } : undefined,
      };
    } catch (error) {
      this.logger.error(`[ModuleScheduler] 从数据库获取 ${moduleKey} 状态失败:`, error);
      return null;
    }
  }
}