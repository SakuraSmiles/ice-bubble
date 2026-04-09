/**
 * ice-bubble Admin API
 *
 * ice-bubble 管理后台 API 服务入口
 */

import express from 'express';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ModuleScheduler } from './modules/module-scheduler.js';
import { createModulesRouter } from './api/modules.js';
import { createDataRouter } from './api/data.js';
import { DBManager } from './storage/db-manager.js';
import { ModuleRepository } from './storage/module-repository.js';
import { DataRepository } from './storage/data-repository.js';
import { DataSync } from './data/data-sync.js';

// 加载环境变量
config();

/**
 * 模块版本信息
 */
export const VERSION = '1.0.0';

// 读取配置 - 使用相对路径
const configPath = './config/config.json';
const configData = JSON.parse(readFileSync(configPath, 'utf-8'));

/**
 * 启动时自动加载模块
 * 从 config.json 读取模块配置，尝试连接并注册模块
 */
async function bootstrapModules(
  scheduler: ModuleScheduler,
  repository: ModuleRepository,
  moduleConfigs: Array<{ moduleKey: string; name: string; baseUrl: string; enabled: boolean; pollInterval?: number }>
): Promise<void> {
  const configs = moduleConfigs.filter(c => c.enabled);
  console.log(`[Admin] 准备加载 ${configs.length} 个模块...`);

  for (const cfg of configs) {
    try {
      // 1. 尝试获取状态
      const status = await scheduler.pollModuleNow(cfg.moduleKey);

      // 2. 注册模块
      await repository.registerModule({
        moduleKey: cfg.moduleKey,
        moduleName: cfg.name,
        moduleType: 'collector',
        status: status ? status.status : 'error',
        version: status?.version || 'unknown'
      });

      // 3. 保存状态
      if (status) {
        await repository.saveModuleStatus(cfg.moduleKey, status);
      }

      console.log(`[Admin] 模块 ${cfg.moduleKey} 加载成功`);
    } catch (error) {
      console.error(`[Admin] 模块 ${cfg.moduleKey} 加载失败:`, error);

      // 即使失败也注册
      await repository.registerModule({
        moduleKey: cfg.moduleKey,
        moduleName: cfg.name,
        moduleType: 'collector',
        status: 'error',
        version: 'unknown'
      });
    }
  }

  console.log(`[Admin] 模块加载完成，共 ${configs.length} 个模块`);
}

/**
 * 启动管理后台服务
 */
export async function startAdmin(): Promise<void> {
    const app = express();
    app.use(express.json());

    const PORT = configData.server?.port || 13101;
    const HOST = configData.server?.host || 'localhost';

    // 初始化数据库
    const dbPath = join(__dirname, '..', '..', 'data', 'admin.db');
    const dbManager = new DBManager();
    await dbManager.init({ dbPath });
    const repository = new ModuleRepository(dbManager.getConnection());
    console.log('[Admin] 数据库初始化完成');

    // 初始化模块调度器
    const moduleConfigs = configData.modules || [];
    const scheduler = new ModuleScheduler(moduleConfigs, repository);

    console.log('[Admin] 模块调度器初始化完成');
    console.log(`[Admin] 已配置 ${moduleConfigs.length} 个模块`);

    // 初始化数据仓库和同步调度器
    const dataRepository = new DataRepository(dbManager.getConnection());
    const dataSyncConfig = configData.dataSync || {};
    const dataSync = new DataSync(
      {
        collectorBaseUrl: dataSyncConfig.collectorBaseUrl || 'http://localhost:13100',
        pollInterval: dataSyncConfig.pollInterval || 60000,
        batchSize: dataSyncConfig.batchSize || 500,
      },
      dataRepository
    );
    dataSync.start();
    console.log('[Admin] 数据同步调度器初始化完成');

    // 注册 API 路由
    app.use('/api/modules', createModulesRouter(scheduler));
    app.use('/api/data', createDataRouter(dataRepository));
    
    // 健康检查
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', version: VERSION });
    });

    // 启动调度器
    scheduler.start();

    // 启动后，加载配置中的模块
    await bootstrapModules(scheduler, repository, moduleConfigs);

    // 启动服务器
    app.listen(PORT, HOST, () => {
        console.log(`[Admin] 服务启动成功: http://${HOST}:${PORT}`);
        console.log(`[Admin] API: http://${HOST}:${PORT}/api/modules`);
    });
}

startAdmin().catch((error) => {
    console.error('Failed to start admin', error);
    process.exit(1);
});
