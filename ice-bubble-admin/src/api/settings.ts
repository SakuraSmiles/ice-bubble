/**
 * Settings API - 配置读写 REST 接口
 *
 * GET  /api/settings  — 读取配置（隐藏敏感字段）
 * PUT  /api/settings  — 保存配置（白名单字段合并写入）
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/index.js';

// config.json 路径（与 index.ts 一致，相对于运行目录）
function getConfigPath(): string {
  return './config/config.json';
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[settings] Failed to parse config.json: ${msg}`);
    process.exit(1);
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const path = getConfigPath();
  const tmp = path + '.tmp.' + Date.now();
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// 从 package.json 读取版本
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// 生成 token 预览（前4后4位）
function maskToken(token: string): string {
  if (!token || token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

// PUT 白名单：允许前端修改的字段路径
const ALLOWED_PUT_FIELDS: string[] = [
  'server.port',
  'server.host',
  'logging.level',
  'logging.format',
  'cleanup.enabled',
  'cleanup.healthDaysToKeep',
  'cleanup.eventDaysToKeep',
  'cleanup.statsDaysToKeep',
  'gateway.url',
  'cors.enabled',
  'cors.origins',
  'database.walMode',
  'database.foreignKeys',
  'dataSync.collectorBaseUrl',
  'dataSync.pollInterval',
  'dataSync.batchSize',
];

/**
 * GET /api/settings — 读取配置
 */
function handleGet(_req: Request, res: Response): void {
  const config = readConfig();

  const server = config.server as Record<string, unknown> | undefined;
  const auth = config.auth as Record<string, unknown> | undefined;
  const logging = config.logging as Record<string, unknown> | undefined;
  const cleanup = config.cleanup as Record<string, unknown> | undefined;
  const gateway = config.gateway as Record<string, unknown> | undefined;
  const cors = config.cors as Record<string, unknown> | undefined;
  const database = config.database as Record<string, unknown> | undefined;
  const dataSync = config.dataSync as Record<string, unknown> | undefined;

  const token = auth?.token as string | undefined;

  res.json({
    server: server ? { port: server.port, host: server.host } : { port: 13000, host: 'localhost' },
    auth: {
      tokenPreview: token ? maskToken(token) : null,
    },
    logging: logging ? { level: logging.level, format: logging.format } : { level: 'info', format: 'pretty' },
    cleanup: cleanup ? {
      enabled: cleanup.enabled,
      healthDaysToKeep: cleanup.healthDaysToKeep,
      eventDaysToKeep: cleanup.eventDaysToKeep,
      statsDaysToKeep: cleanup.statsDaysToKeep,
    } : null,
    gateway: gateway ? { url: gateway.url } : { url: 'ws://127.0.0.1:18789' },
    cors: cors ? { enabled: cors.enabled, origins: cors.origins } : null,
    database: database ? { walMode: database.walMode, foreignKeys: database.foreignKeys } : null,
    dataSync: dataSync ? {
      collectorBaseUrl: dataSync.collectorBaseUrl,
      pollInterval: dataSync.pollInterval,
      batchSize: dataSync.batchSize,
    } : null,
    version: getVersion(),
  });
}

/**
 * PUT /api/settings — 保存配置（白名单字段合并）
 */
function handlePut(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown>;
  const config = readConfig();

  let changed = false;

  for (const field of ALLOWED_PUT_FIELDS) {
    // 扁平化路径匹配 body 中的嵌套字段
    // body 结构与 GET 响应一致：{ server: { port: ... }, ... }
    const parts = field.split('.');
    if (parts.length !== 2) continue;

    const [group, key] = parts;
    const groupBody = body[group] as Record<string, unknown> | undefined;
    if (groupBody === undefined || !Object.prototype.hasOwnProperty.call(groupBody, key)) continue;

    // 确保目标分组存在
    if (typeof config[group] !== 'object' || config[group] === null || Array.isArray(config[group])) {
      config[group] = {};
    }

    const groupConfig = config[group] as Record<string, unknown>;
    const oldValue = groupConfig[key];
    const newValue = groupBody[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      groupConfig[key] = newValue;
      changed = true;
    }
  }

  if (changed) {
    writeConfig(config);
    logger.info('[settings] 配置已保存');
    console.log('[settings] 配置已更新，部分修改需要重启 Admin 服务才生效');
  }

  res.json({ success: true, changed });
}

/**
 * 创建 Settings 路由
 */
export function createSettingsRouter(): Router {
  const router = Router();

  router.get('/settings', handleGet);
  router.put('/settings', handlePut);

  return router;
}
