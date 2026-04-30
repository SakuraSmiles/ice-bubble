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
import { createTasksRouter } from './api/tasks.js';
import { DataSync } from './data/data-sync.js';
import { AgentOverviewService } from './data/agent-overview.js';
import { CollectorClient } from './data/collector-client.js';
import { createBearerAuthMiddleware, getAuthToken } from './utils/auth-middleware.js';
import { GatewayConnection } from './server/gateway/connection.js';
import { GatewayRpc } from './server/gateway/rpc.js';
import { SSEManager } from './server/chat/sse-manager.js';

import { ChatController } from './server/chat/controller.js';

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

interface GatewayConfig {
  url?: string;
  token?: string;
}

interface AppConfig {
  server?: ServerConfig;
  modules?: ModuleConfig[];
  dataSync?: DataSyncConfig;
  auth?: { token?: string };
  gateway?: GatewayConfig;
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
    await dbManager.migrate(17);  // 执行数据库迁移（v17: admin_tasks 表）
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
    app.use('/api/tasks', createTasksRouter({ db: dbManager.getConnection() }));

    // ── Chat Gateway Integration (B7) ──
    const gwConfig = configData.gateway || {};
    const gatewayUrl = gwConfig.url || 'ws://127.0.0.1:18789';
    const gatewayToken = gwConfig.token || '';
    const gatewayConn = new GatewayConnection(gatewayUrl, gatewayToken);
    const gatewayRpc = new GatewayRpc(gatewayConn);
    const sseManager = new SSEManager(gatewayRpc);
    const chatController = new ChatController(gatewayRpc, sseManager);

    // Sessions API: handled by createDataRouter in data.ts

    app.get('/api/sessions/:key/messages', (req, res) => {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const result = dataRepository.getMessages({ session_key: req.params.key, limit, offset });
      // 从 session_key 提取 agent_id，补充头像和名称
      const agentId = req.params.key.split(':')[1] || '';
      const agentInfo = (() => {
        const agents = dataRepository.getAgents();
        const a = agents.find(ag => ag.agent_id === agentId);
        return { name: a?.agent_name ?? null, avatar: a?.avatar ?? null };
      })();
      const messages = result.messages.map((m) => ({
        id: String(m.id ?? m.source_id ?? ''),
        session_key: m.session_key,
        role: m.message_type === 'agent' ? 'assistant' : (m.message_type ?? 'user'),
        content: m.content ?? '',
        created_at: m.created_at,
        model: m.model ?? null,
        agent_id: agentId,
        agent_name: agentInfo.name,
        avatar: agentInfo.avatar,
      }));
      res.json({ messages, total: result.total });
    });

    // Chat routes
    app.post('/api/chat/send', (req, res) => chatController.send(req, res));
    app.post('/api/chat/abort', (req, res) => chatController.abort(req, res));
    app.get('/api/chat/stream', (req, res) => chatController.stream(req, res));

    // Connect to Gateway in background — failure should NOT crash the server
    gatewayConn.connect().catch((err) => {
        logger.warn('[Admin] Gateway connection failed (will auto-retry)', {
            error: err instanceof Error ? err.message : String(err),
            url: gatewayUrl,
        });
    });

    gatewayConn.on('reconnect', () => {
        logger.info('[Admin] Gateway reconnecting...', { url: gatewayUrl });
        sseManager.broadcastAll('status', { connected: false });
    });

    gatewayConn.on('disconnect', () => {
        logger.warn('[Admin] Gateway disconnected');
        sseManager.broadcastAll('status', { connected: false });
    });

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
