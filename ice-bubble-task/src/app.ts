/**
 * 应用主文件
 */

import express from 'express';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { logger } from './utils/logger.js';
import { DBManager } from './storage/db-manager.js';
import { TaskRepository } from './storage/task-repository.js';
import { createTasksRouter } from './api/tasks.js';
import { createOpenClawCollector } from './collectors/openclaw-collector.js';
import { createWorkBuddyCollector } from './collectors/workbuddy-collector.js';
import { createClaudeCodeCollector } from './collectors/claude-code-collector.js';
import { CollectScheduler } from './scheduler/collect-scheduler.js';
import { CleanupScheduler } from './scheduler/cleanup-scheduler.js';
import { AgentStatusScheduler } from './scheduler/agent-status-scheduler.js';
import type { CollectorInterface } from './collectors/collector-interface.js';

interface AppConfig {
  server: { port: number; host: string };
  database: {
    path: string;
    walMode: boolean;
    foreignKeys: boolean;
    performance: {
      cacheSize?: number;
      mmapSize?: number;
      pageSize?: number;
      busyTimeout?: number;
      journalSizeLimit?: number;
    };
  };
  collectors: {
    openclaw: { enabled: boolean; taskStorePath: string };
    workbuddy: { enabled: boolean; baseUrl: string };
    claudeCode: { enabled: boolean; taskStorePath: string };
  };
  scheduler: { collectIntervalMs: number; cleanupIntervalMs: number; taskTtlDays: number };
}

function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(p.replace('~', process.env.HOME ?? ''));
  }
  return p;
}

export async function startTask(): Promise<void> {
  // 加载配置
  const configPath = join(__dirname, '..', 'config', 'config.json');
  const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

  const app = express();
  app.use(express.json());

  const { host, port } = config.server;

  // 初始化数据库
  const dbPath = resolve(__dirname, '..', config.database.path);
  const dbManager = new DBManager();
  await dbManager.init({
    dbPath,
    walMode: config.database.walMode,
    foreignKeys: config.database.foreignKeys,
    performance: config.database.performance,
  });
  // v1: initial schema, v2: idempotency_key column
  await dbManager.migrate(2);

  const repository = new TaskRepository(dbManager.getConnection());
  logger.info('[Task] 数据库初始化完成', { dbPath });

  // 初始化采集器
  const collectors: CollectorInterface[] = [];

  if (config.collectors.openclaw.enabled) {
    const path = resolvePath(config.collectors.openclaw.taskStorePath);
    collectors.push(createOpenClawCollector(path, repository));
    logger.info('[Task] OpenClaw 采集器已注册', { path });
  }

  if (config.collectors.workbuddy.enabled) {
    collectors.push(createWorkBuddyCollector(config.collectors.workbuddy.baseUrl, repository));
    logger.info('[Task] WorkBuddy 采集器已注册（桩代码）');
  }

  if (config.collectors.claudeCode.enabled) {
    const path = resolvePath(config.collectors.claudeCode.taskStorePath);
    collectors.push(createClaudeCodeCollector(path, repository));
    logger.info('[Task] ClaudeCode 采集器已注册（桩代码）');
  }

  // 启动定时采集
  const scheduler = new CollectScheduler(collectors, config.scheduler.collectIntervalMs);
  scheduler.start();

  // 启动 TTL 清理调度器
  const cleanupScheduler = new CleanupScheduler(
    repository,
    config.scheduler.taskTtlDays,
    config.scheduler.cleanupIntervalMs
  );
  cleanupScheduler.start();

  // 启动 Agent 状态轮询调度器（供各 agent 查询任务）
  let agentScheduler: AgentStatusScheduler | null = null;
  const openclawTaskStorePath = config.collectors.openclaw.enabled
    ? resolvePath(config.collectors.openclaw.taskStorePath)
    : undefined;
  if (config.collectors.openclaw.enabled && openclawTaskStorePath) {
    agentScheduler = new AgentStatusScheduler(repository, openclawTaskStorePath, config.scheduler.collectIntervalMs);
    agentScheduler.start();
    logger.info('[Task] Agent 状态调度器已启动');
  }

  // 注册 API
  app.use('/api', createTasksRouter(repository, openclawTaskStorePath));

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      collectors: collectors.map(c => c.name),
      scheduler_running: scheduler.isRunning(),
      cleanup_running: cleanupScheduler.isRunning(),
      agent_scheduler_running: agentScheduler?.isRunning() ?? false
    });
  });

  // admin 接入规范：/api/meta/status 接口
  app.get('/api/meta/status', (_req, res) => {
    const stats = repository.getStats();
    res.json({
      status: 'running',
      version: '1.0.0',
      runtime: {
        startTime: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        taskCount: Object.values(stats).reduce((a, b) => a + b, 0) || 0,
        stats
      }
    });
  });

  // 启动服务器
  app.listen(port, host, () => {
    logger.info(`[Task] 服务启动: http://${host}:${port}`);
    logger.info(`[Task] API: http://${host}:${port}/api/tasks`);
  });
}

startTask().catch((error) => {
  logger.error('Failed to start task module', { error });
  process.exit(1);
});
