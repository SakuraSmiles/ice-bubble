/**
 * 启动编排 + 服务初始化 + 路由注册
 */

import { config } from 'dotenv';
import { join } from 'path';
import { logger } from './utils/index.js';
import { VERSION, loadConfig, resolveAuthToken } from './config.js';
import { createApp } from './app.js';
import { ModuleScheduler } from './modules/module-scheduler.js';
import { createModulesRouter } from './api/modules.js';
import { createDataRouter } from './api/data.js';
import { DBManager } from './storage/db-manager.js';
import { ModuleRepository } from './storage/module-repository.js';
import { DataRepository } from './storage/data-repository.js';
import { createResourcesRouter } from './api/resources.js';
import { createSubagentTasksRouter } from './api/tasks.js';
import { DataSync } from './data/data-sync.js';
import { AgentOverviewService } from './data/agent-overview.js';
import { CollectorClient } from './data/collector-client.js';
import { GatewayRpc } from './server/gateway/rpc.js';
import { SSEManager } from './server/chat/sse-manager.js';
import { ChatController } from './server/chat/controller.js';
import { AttachmentStorage } from './server/chat/attachment-storage.js';
import { OpenCodeHttpClient } from './server/chat/opencode-client.js';
import { createOpenCodeChatRouter } from './api/opencode-chat.js';
import { GatewayProxy } from './gateway/index.js';
import { createSessionCacheManager } from './services/session-cache.js';
import { GatewayWsServer } from './gateway/ws-server.js';
import { createChatProxyRouter, createSessionProxyRouter } from './api/chat-proxy.js';
import { createSessionsUnifiedRouter } from './api/sessions-unified.js';
import { createSessionGroupsRouter } from './api/session-groups.js';
import { createSessionPreferencesRouter } from './api/session-preferences.js';
import { createWorkspaceRouter } from './api/workspace.js';
import { createSettingsRouter } from './api/settings.js';
import { createMediaRouter, createMediaFileRouter } from './api/media.js';
import { createHealthRouter } from './api/health.js';
import { createDocsRouter } from './api/docs/index.js';
import { OpenDesignProxy } from './proxy/opendesign-proxy.js';
import { createOpenDesignRouter } from './api/opendesign-proxy-routes.js';

// 加载环境变量（最早时机）
config();

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
      // 代理类模块（如 opendesign）不走 collector 轮询，直接注册为 running
      const isProxyModule = cfg.moduleKey === 'opendesign' || !!(cfg as any).proxy?.type;

      // 1. 检查模块是否已存在，存在则不更新注册时间
      const existingCreatedAt = await repository.getModuleCreatedAt(cfg.moduleKey);
      if (!existingCreatedAt) {
        await repository.registerModule({
          moduleKey: cfg.moduleKey,
          moduleName: cfg.name,
          moduleType: isProxyModule ? 'proxy' : 'collector',
          status: 'running',
          version: 'unknown'
        });
      }

      if (isProxyModule) {
        logger.info(`[Admin] 模块 ${cfg.moduleKey} (proxy) 跳过 collector 轮询`);
        // 代理模块：清除旧的错误状态，标记为 running
        await repository.saveModuleStatus(cfg.moduleKey, {
          status: 'running',
          lastPollTime: new Date().toISOString(),
          lastError: undefined,
          latencyMs: 0,
        });
        continue;
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
  // 加载配置
  const configData = loadConfig();
  const authToken = resolveAuthToken(configData);

  // 创建 Express 应用
  const { app, setAttachmentQueryHandler, setMediaFileHandler } = createApp(configData, authToken);

  const PORT = configData.server?.port || 13000;
  const HOST = configData.server?.host || '0.0.0.0';

  // 初始化数据库
  const dbPath = process.env.ADMIN_DB_PATH || join(__dirname, '..', '..', 'data', 'admin.db');
  const dbManager = new DBManager();
  await dbManager.init({ dbPath });
  await dbManager.migrate(27);  // 执行数据库迁移（v27: sync_progress last_sync_id 游标）
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
  const IB_DATA_DIR = process.env.IB_DATA_DIR || join(process.env.HOME || '/root', '.local', 'share', 'ice-bubble');
  const avatarsDirEarly = process.env.ADMIN_AVATARS_DIR || join(__dirname, '..', '..', 'data', 'avatars');
  const dataRepository = new DataRepository(dbManager.getConnection(), avatarsDirEarly);

  // 初始化附件存储
  const attachmentsDir = process.env.ATTACHMENTS_DIR || join(IB_DATA_DIR, 'data', 'attachments');
  const attachmentStorage = new AttachmentStorage(attachmentsDir, dbManager.getConnection());
  logger.info('[Admin] Attachment storage initialized', { dir: attachmentsDir });

  // ── 配置驱动的数据同步：从 modules 自动发现 collector 并创建 DataSync ──
  const dataSyncs: DataSync[] = [];
  const createdModuleKeys = new Set<string>();
  const legacyDataSyncConfigs = new Map<string, { collectorBaseUrl: string; moduleKey: string; platform: string; pollInterval: number; batchSize: number }>();

  // 1. 收集 legacy 配置作为 fallback
  if (configData.dataSync) {
    const ds = configData.dataSync;
    legacyDataSyncConfigs.set(ds.moduleKey || 'collector-openclaw', {
      collectorBaseUrl: ds.collectorBaseUrl || 'http://localhost:13100',
      moduleKey: ds.moduleKey || 'collector-openclaw',
      platform: 'openclaw',
      pollInterval: ds.pollInterval || 60000,
      batchSize: ds.batchSize || 500,
    });
  }
  if (configData.dataSyncOpencode) {
    const ds = configData.dataSyncOpencode;
    legacyDataSyncConfigs.set(ds.moduleKey || 'collector-opencode', {
      collectorBaseUrl: ds.collectorBaseUrl || 'http://localhost:13101',
      moduleKey: ds.moduleKey || 'collector-opencode',
      platform: 'opencode',
      pollInterval: ds.pollInterval || 30000,
      batchSize: ds.batchSize || 500,
    });
  }

  // 2. 遍历 modules，优先使用 sync 字段，fallback 到 legacy 配置
  for (const mod of moduleConfigs) {
    if (!mod.enabled || !mod.baseUrl) continue;
    // 非 collector 类型模块跳过（moduleKey 以 collector- 开头或 sync 字段存在）
    if (!mod.moduleKey.startsWith('collector-') && !mod.sync) continue;

    let syncConfig: { collectorBaseUrl: string; moduleKey: string; platform: string; pollInterval: number; batchSize: number };

    if (mod.sync) {
      // 新配置路径：从 module 的 sync 字段读取
      if (mod.sync.enabled === false) continue;
      const platform = mod.moduleKey.replace(/^collector-/, '');
      syncConfig = {
        collectorBaseUrl: mod.baseUrl,
        moduleKey: mod.moduleKey,
        platform,
        pollInterval: mod.sync.pollInterval || 30000,
        batchSize: mod.sync.batchSize || 500,
      };
    } else {
      // Fallback：从 legacy 配置匹配
      const legacy = legacyDataSyncConfigs.get(mod.moduleKey);
      if (!legacy) continue;
      syncConfig = legacy;
    }

    const sync = new DataSync(syncConfig, dataRepository);
    sync.start();
    dataSyncs.push(sync);
    createdModuleKeys.add(syncConfig.moduleKey);
    logger.info(`[Admin] 数据同步调度器初始化完成 (${syncConfig.platform})`);
  }

  // 3. 兜底：如果 modules 中没有匹配到 legacy 配置，直接创建
  for (const [key, syncConfig] of legacyDataSyncConfigs) {
    if (createdModuleKeys.has(key)) continue;
    const sync = new DataSync(syncConfig, dataRepository);
    sync.start();
    dataSyncs.push(sync);
    createdModuleKeys.add(key);
    logger.info(`[Admin] 数据同步调度器初始化完成 (${syncConfig.platform}, legacy)`);
  }

  // 启动每日归档调度器（凌晨 3 点执行，保留 30 天数据）
  dataRepository.startArchiveScheduler(30, (count) => {
    logger.info(`[Admin] 归档任务完成，共归档 ${count} 条消息`);
  });
  logger.info('[Admin] 数据归档调度器已启动');

  // ── GatewayProxy (初始化提前，供后续路由使用) ──
  let gatewayProxy: GatewayProxy | null = null;
  let sessionCache: ReturnType<typeof createSessionCacheManager> | null = null;
  try {
    const gatewayOpts: { gatewayUrl?: string; authToken?: string } = {};
    if (configData.gateway?.url) {
      gatewayOpts.gatewayUrl = configData.gateway.url;
    }
    if (configData.gateway?.token) {
      gatewayOpts.authToken = configData.gateway.token;
    }
    gatewayProxy = new GatewayProxy(gatewayOpts);
    logger.info('[Admin] GatewayProxy connecting...', { url: gatewayOpts.gatewayUrl || process.env.GATEWAY_URL || 'default' });
    await gatewayProxy.connect();
    logger.info('[Admin] GatewayProxy connected');

    // ── Session Cache: start background refresh loop ──
    sessionCache = createSessionCacheManager(gatewayProxy);
    sessionCache.start();
    logger.info('[Admin] SessionCacheManager started (30s refresh)');
  } catch (err) {
    logger.warn('[Admin] GatewayProxy connection failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── OpenCode Chat Client ──
  const opencodeConfig = configData.opencode;
  let opencodeClient: OpenCodeHttpClient | null = null;
  if (opencodeConfig?.enabled !== false) {
    const serveUrl = opencodeConfig?.serveUrl || 'http://localhost:4097';
    opencodeClient = new OpenCodeHttpClient({ baseUrl: serveUrl });

    const healthy = await opencodeClient.healthCheck().catch(() => false);
    if (healthy) {
      logger.info(`[Admin] OpenCode client connected at ${serveUrl}`);
    } else {
      logger.warn(`[Admin] OpenCode is not reachable at ${serveUrl} — routes will still be registered`);
    }
  } else {
    logger.info('[Admin] OpenCode chat is disabled in config');
  }

  // ── OpenDesign Proxy ──
  let opendesignProxy: OpenDesignProxy | null = null;
  const odModuleConfig = moduleConfigs.find(
    m => m.moduleKey === 'opendesign' || m.proxy?.type === 'opendesign'
  );
  const odTopConfig = configData.opendesign;
  const odEnabled = odTopConfig?.enabled !== false && (odModuleConfig?.enabled !== false);

  if (odEnabled) {
    const odBaseUrl =
      odTopConfig?.baseUrl ||
      odModuleConfig?.baseUrl ||
      undefined;
    const odAuthToken =
      odTopConfig?.authToken ||
      odModuleConfig?.proxy?.authToken ||
      undefined;

    opendesignProxy = new OpenDesignProxy({
      baseUrl: odBaseUrl,
      authToken: odAuthToken,
      timeoutMs: odTopConfig?.timeoutMs || odModuleConfig?.proxy?.timeoutMs,
      sseTimeoutMs: odTopConfig?.sseTimeoutMs || odModuleConfig?.proxy?.sseTimeoutMs,
    });

    opendesignProxy.startHealthMonitoring();

    const healthResult = await opendesignProxy.healthCheck();
    if (healthResult.healthy) {
      logger.info(`[Admin] OpenDesign proxy connected at ${opendesignProxy.getBaseUrl()}`);
    } else {
      logger.warn(
        `[Admin] OpenDesign daemon is not reachable at ${opendesignProxy.getBaseUrl()} — routes will still be registered`
      );
    }
  } else {
    logger.info('[Admin] OpenDesign proxy is disabled');
  }

  // ── OpenDesign Routes ──
  if (opendesignProxy) {
    const defaultAgentId =
      odTopConfig?.defaultAgentId ||
      odModuleConfig?.proxy?.defaultAgentId ||
      undefined;
    app.use('/api/design', createOpenDesignRouter(opendesignProxy, { defaultAgentId }));
    logger.info(`[Admin] OpenDesign routes registered at /api/design${defaultAgentId ? ` (defaultAgentId=${defaultAgentId})` : ''}`);
  }

  // 注册 API 路由
  // IMPORTANT: Unified sessions route must be BEFORE data router,
  // because data router's /sessions/:key would match /sessions/unified
  if (gatewayProxy && sessionCache) {
    app.use('/api', createSessionsUnifiedRouter({ sessionCache, repository: dataRepository }));
  }
  app.use('/api', createDataRouter({
    repository: dataRepository,
    db: dbManager.getConnection(),
    dataSyncs,
    agentOverviewService: new AgentOverviewService(
      dataRepository,
      new CollectorClient({ baseUrl: moduleConfigs.find(m => m.moduleKey.startsWith('collector-') && m.enabled)?.baseUrl || 'http://localhost:13100' })
    ),
    gatewayProxy,
  }));
  app.use('/api/modules', createModulesRouter(scheduler));
  app.use('/api/resources', createResourcesRouter(dataRepository));
  app.use('/api/subagent-tasks', createSubagentTasksRouter({ db: dbManager.getConnection() }));
  app.use('/api', createSessionGroupsRouter({ db: dbManager.getConnection(), gatewayProxy }));
  app.use('/api', createSessionPreferencesRouter({ db: dbManager.getConnection() }));
  app.use('/api', createWorkspaceRouter());
  app.use('/api', createSettingsRouter());

  // OpenCode chat routes (if client is available)
  if (opencodeClient) {
    app.use('/api/opencode', createOpenCodeChatRouter(opencodeClient));
    logger.info('[Admin] OpenCode chat routes registered at /api/opencode');
  }

  // ── Chat Gateway Integration ──
  let gatewayRpc: GatewayRpc | null = null;
  let sseManager: SSEManager | null = null;
  let chatController: ChatController | null = null;
  if (gatewayProxy) {
    gatewayRpc = new GatewayRpc(gatewayProxy);
    sseManager = new SSEManager();
    chatController = new ChatController(gatewayRpc, sseManager, attachmentStorage);
    logger.info('[Admin] GatewayRpc (chat SSE) initialized via GatewayProxy');
  } else {
    logger.warn('[Admin] No GatewayProxy — chat SSE will not be available');
  }

  // Sessions messages endpoint
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
      // 透传原始字段，供前端过滤
      message_type: m.message_type,
      is_system_context: m.is_system_context ?? 0,
    }));
    res.json({ messages, total: result.total });
  });

  // Media routes (after auth middleware — metadata queries are authenticated)
  const IB_MEDIA_DIR = process.env.IB_MEDIA_DIR || join(process.env.HOME || '/root', '.openclaw', 'media', 'inbound');
  const gatewayMediaDir = IB_MEDIA_DIR;
  const IB_CANVAS_DIR = process.env.IB_CANVAS_DIR || join(process.env.HOME || '/root', '.openclaw', 'canvas');
  const canvasDir = IB_CANVAS_DIR;
  const mediaMetaRouter = createMediaRouter({
    db: dbManager.getConnection(),
    attachmentsDir: attachmentsDir,
    gatewayProxy,
    gatewayMediaDir,
    canvasDir,
  });
  app.use('/api/media', mediaMetaRouter);

  // Wire up media file handler (registered before auth, now we have DB access)
  const mediaFileRouter = createMediaFileRouter({
    db: dbManager.getConnection(),
    attachmentsDir: attachmentsDir,
    gatewayProxy,
    gatewayMediaDir,
    canvasDir,
  });
  setMediaFileHandler((req, res, next) => mediaFileRouter(req, res, next));

  // Attachment query handler
  setAttachmentQueryHandler((req, res) => {
    const sessionKey = req.query.session_key as string;
    if (!sessionKey) { res.status(400).json({ attachments: [] }); return; }
    const attachments = attachmentStorage.getAttachments(sessionKey);
    res.json({ attachments });
  });

  // Chat routes (only if GatewayProxy is available)
  if (chatController) {
    app.post('/api/chat/send', (req, res) => chatController!.send(req, res));
    app.post('/api/chat/abort', (req, res) => chatController!.abort(req, res));
    app.get('/api/chat/stream', (req, res) => chatController!.stream(req, res));
  }

  // HTTP proxy routes (via GatewayProxy)
  if (gatewayProxy) {
    app.use('/api/chat', createChatProxyRouter(gatewayProxy, dataRepository));
    app.use('/api/gateway', createSessionProxyRouter(gatewayProxy));
    logger.info('[Admin] GatewayProxy HTTP routes registered');
  }

  // GatewayProxy event forwarding to SSE clients
  if (gatewayProxy) {
    gatewayProxy.on('disconnected', () => {
      logger.warn('[Admin] Gateway disconnected');
      sseManager?.broadcastAll('status', { connected: false });
    });
    gatewayProxy.on('reconnecting', () => {
      logger.info('[Admin] Gateway reconnecting...');
      sseManager?.broadcastAll('status', { connected: false });
    });
    gatewayProxy.on('connected', () => {
      logger.info('[Admin] Gateway reconnected');
      sseManager?.broadcastAll('status', { connected: true });
    });
  }

  // 健康检查
  app.use(createHealthRouter(dbManager.getConnection(), configData));

  // OpenAPI 文档（在 auth middleware 之后，需 Bearer Token）
  app.use('/api/docs', createDocsRouter());

  // /api/openapi.json 快捷入口（重定向到 /api/docs/openapi.json）
  app.get('/api/openapi.json', (_req, res) => res.redirect('/api/docs/openapi.json'));

  // 启动调度器
  scheduler.start();

  // 启动后，加载配置中的模块
  await bootstrapModules(scheduler, repository, moduleConfigs);

  // 启动服务器
  const httpServer = app.listen(PORT, HOST, () => {
    logger.info(`[Admin] 服务启动成功: http://${HOST}:${PORT}`);
    logger.info(`[Admin] API: http://${HOST}:${PORT}/api/modules`);
  });

  // 挂载 WebSocket 服务器到 /ws（通过 GatewayProxy）
  if (gatewayProxy) {
    try {
      const wsServer = new GatewayWsServer(gatewayProxy, authToken, attachmentStorage);
      wsServer.start(httpServer);
      logger.info('[Admin] WebSocket server started on /ws');
    } catch (err) {
      logger.warn('[Admin] WebSocket server failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
