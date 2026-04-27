/**
 * ice-bubble Admin API
 *
 * ice-bubble 管理后台 API 服务入口
 */

import express from 'express';
import { config } from 'dotenv';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/index.js';
import { ModuleScheduler } from './modules/module-scheduler.js';
import { createModulesRouter } from './api/modules.js';
import { createDataRouter } from './api/data.js';
import { DBManager } from './storage/db-manager.js';
import { ModuleRepository } from './storage/module-repository.js';
import { DataRepository } from './storage/data-repository.js';
import { createResourcesRouter } from './api/resources.js';
import { DataSync } from './data/data-sync.js';
import { AgentOverviewService } from './data/agent-overview.js';
import { CollectorClient } from './data/collector-client.js';
import { createBearerAuthMiddleware, getAuthToken } from './utils/auth-middleware.js';

// 加载环境变量
config();

/**
 * 模块版本信息
 */
export const VERSION = '1.0.0';

// 读取配置 - 使用相对路径
const configPath = './config/config.json';

interface ServerConfig {
  port?: number;
  host?: string;
}

interface ModuleConfig {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval?: number;
}

interface DataSyncConfig {
  collectorBaseUrl?: string;
  moduleKey?: string;
  pollInterval?: number;
  batchSize?: number;
  taskApiBaseUrl?: string;
  subagentParserEnabled?: boolean;
}

interface AppConfig {
  server?: ServerConfig;
  modules?: ModuleConfig[];
  dataSync?: DataSyncConfig;
  auth?: { token?: string };
}

let configData: AppConfig;
try {
  configData = JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[index] Failed to parse ${configPath}: ${msg}`);
  process.exit(1);
}

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
  logger.info(`[Admin] 准备加载 ${configs.length} 个模块...`);

  for (const cfg of configs) {
    try {
      // 1. 检查模块是否已存在，存在则不更新注册时间
      const existingCreatedAt = await repository.getModuleCreatedAt(cfg.moduleKey);
      if (!existingCreatedAt) {
        await repository.registerModule({
          moduleKey: cfg.moduleKey,
          moduleName: cfg.name,
          moduleType: 'collector',
          status: 'running',
          version: 'unknown'
        });
      }

      // 2. 尝试获取状态
      const status = await scheduler.pollModuleNow(cfg.moduleKey);

      // 3. 保存状态
      if (status) {
        await repository.saveModuleStatus(cfg.moduleKey, status);
      }

      logger.info(`[Admin] 模块 ${cfg.moduleKey} 加载成功`);
    } catch (error) {
      logger.error(`[Admin] Module ${cfg.moduleKey} load failed`, { error });

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

  logger.info(`[Admin] 模块加载完成，共 ${configs.length} 个模块`);
}

/**
 * 启动管理后台服务
 */
export async function startAdmin(): Promise<void> {
    const app = express();
    app.use(express.json());

    // Bearer token auth middleware (skipped if no token configured — backward compatible)
    const authToken = getAuthToken(configData.auth?.token);
    if (authToken) {
        app.use('/api', createBearerAuthMiddleware({ token: authToken }));
    }

    const PORT = configData.server?.port || 13000;
    const HOST = configData.server?.host || 'localhost';

    // 初始化数据库
    const dbPath = join(__dirname, '..', '..', 'data', 'admin.db');
    const dbManager = new DBManager();
    await dbManager.init({ dbPath });
    await dbManager.migrate(14);  // 执行数据库迁移（v14: tool 消息拆分到独立表）
    const repository = new ModuleRepository(dbManager.getConnection());
    logger.info('[Admin] 数据库初始化完成');

    // 首次启动检查：如果数据库中没有模块，自动注册 admin 自己
    const existingModules = await repository.getModules({ limit: 1 });
    if (existingModules.modules.length === 0) {
      await repository.registerModule({
        moduleKey: 'admin',
        moduleName: 'Admin 管理后台',
        moduleType: 'admin',
        status: 'running',
        version: VERSION
      });
      logger.info('[Admin] 首次启动，自动注册 admin 模块到数据库');
    }

    // 初始化模块调度器
    const moduleConfigs = configData.modules || [];
    const scheduler = new ModuleScheduler(moduleConfigs, logger, repository);

    logger.info('[Admin] 模块调度器初始化完成');
    logger.info(`[Admin] 已配置 ${moduleConfigs.length} 个模块`);

    // 初始化数据仓库和同步调度器
    const avatarsDir = join(__dirname, '..', '..', 'data', 'avatars');
    // 确保头像目录存在
    if (!existsSync(avatarsDir)) {
      mkdirSync(avatarsDir, { recursive: true });
      logger.info('[Admin] Avatar directory created', { path: avatarsDir });
    }
    const dataRepository = new DataRepository(dbManager.getConnection(), avatarsDir);
    const dataSyncConfig = configData.dataSync || {};
    const dataSync = new DataSync(
      {
        collectorBaseUrl: dataSyncConfig.collectorBaseUrl || 'http://localhost:13100',
        moduleKey: dataSyncConfig.moduleKey || 'collector-openclaw',
        pollInterval: dataSyncConfig.pollInterval || 60000,
        batchSize: dataSyncConfig.batchSize || 500,
        taskApiBaseUrl: dataSyncConfig.taskApiBaseUrl,
        subagentParserEnabled: dataSyncConfig.subagentParserEnabled,
      },
      dataRepository
    );
    dataSync.start();
    logger.info('[Admin] 数据同步调度器初始化完成');

    // 启动每日归档调度器（凌晨 3 点执行，保留 30 天数据）
    dataRepository.startArchiveScheduler(30, (count) => {
      logger.info(`[Admin] 归档任务完成，共归档 ${count} 条消息`);
    });
    logger.info('[Admin] 数据归档调度器已启动');

    // 注册 API 路由
    app.use('/api', createDataRouter({
      repository: dataRepository,
      agentOverviewService: new AgentOverviewService(
        dataRepository,
        new CollectorClient({ baseUrl: dataSyncConfig.collectorBaseUrl || 'http://localhost:13100' })
      ),
    }));
    app.use('/api/modules', createModulesRouter(scheduler));
    app.use('/api/resources', createResourcesRouter(dataRepository));
    
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
        logger.info(`[Admin] 服务启动成功: http://${HOST}:${PORT}`);
        logger.info(`[Admin] API: http://${HOST}:${PORT}/api/modules`);
    });
}

startAdmin().catch((error) => {
    logger.error('Failed to start admin', { error });
    process.exit(1);
});
