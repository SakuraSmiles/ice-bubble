/**
 * 配置类型定义 + 配置加载 + VERSION
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getAuthToken } from './utils/auth-middleware.js';

// ── VERSION：从根 package.json 动态读取 ──
const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
export const VERSION: string = rootPkg.version;

// ── 配置路径 ──
export const configPath = './config/config.json';

// ── 类型定义 ──

export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface ModuleConfig {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval?: number;
  /** 当模块为 collector 类型时，配置数据同步参数 */
  sync?: {
    enabled?: boolean;
    pollInterval?: number;
    batchSize?: number;
  };
}

export interface DataSyncConfig {
  collectorBaseUrl?: string;
  moduleKey?: string;
  platform?: string;
  pollInterval?: number;
  batchSize?: number;
}

export interface DataSyncOpencodeConfig {
  collectorBaseUrl?: string;
  moduleKey?: string;
  pollInterval?: number;
  batchSize?: number;
}

export interface GatewayConfig {
  url?: string;
  token?: string;
}

export interface CorsConfig {
  enabled?: boolean;
  origins?: string[];
}

export interface OpenCodeConfig {
  serveUrl?: string;
  enabled?: boolean;
}

export interface AppConfig {
  server?: ServerConfig;
  modules?: ModuleConfig[];
  dataSync?: DataSyncConfig;
  dataSyncOpencode?: DataSyncOpencodeConfig;
  auth?: { token?: string };
  gateway?: GatewayConfig;
  cors?: CorsConfig;
  opencode?: OpenCodeConfig;
}

// ── 配置加载 ──

export function loadConfig(): AppConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[config] Failed to parse ${configPath}: ${msg}`);
    process.exit(1);
  }
}

// ── Auth token 解析 ──

export function resolveAuthToken(configData: AppConfig): string {
  return getAuthToken(configData.auth?.token);
}
