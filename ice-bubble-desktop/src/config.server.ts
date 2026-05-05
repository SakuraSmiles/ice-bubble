/**
 * Server-only config - DO NOT import from client-side code
 * Contains fs-dependent config loading and hot-reload
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = join(__filename, '..');

  // 0. 环境变量优先（sidecar 模式下由 lib.rs 注入）
  if (typeof process !== 'undefined' && process.env.ICE_RESOURCE_DIR) {
    const envDir = process.env.ICE_RESOURCE_DIR;
    if (existsSync(join(envDir, 'modules.json'))) {
      return envDir;
    }
  }

  // 1. Tauri 打包模式：config 目录在 exe_dir/server 的同级
  const tauriConfigDir = join(__dirname, '..', 'config');
  if (existsSync(join(tauriConfigDir, 'modules.json'))) {
    return tauriConfigDir;
  }

  // 1b. 当 config.server.js 作为独立文件在 exe_dir/ 运行时：
  //     __dirname = exe_dir/ → join(__dirname, 'config') = exe_dir/config/ ✅
  const localConfigDir = join(__dirname, 'config');
  if (existsSync(join(localConfigDir, 'modules.json'))) {
    return localConfigDir;
  }

  // 2. 开发模式：process.cwd()/config/modules.json
  if (typeof process !== 'undefined' && process.cwd) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'config', 'modules.json'))) {
      return join(cwd, 'config');
    }
  }

  // 3. 直接 tsx 运行：__dirname/../../config/modules.json
  const fallback = join(__dirname, '..', '..', 'config');
  if (existsSync(join(fallback, 'modules.json'))) {
    return fallback;
  }

  // 4. 兜底
  return join(process.cwd(), 'config');
}

export interface ModuleConfig {
  key: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface CorsConfig {
  enabled: boolean;
  origins: string[];
}

export interface ModulesConfig {
  modules: ModuleConfig[];
  /** 可选：Bearer Token 鉴权 */
  authToken?: string;
  /** 可选：CORS 允许来源 */
  cors?: CorsConfig;
  /** 可选：代理连接是否验证 TLS 证书（默认 true） */
  rejectUnauthorized?: boolean;
}

const DEFAULT_CONFIG: ModulesConfig = {
  modules: [
    {
      key: 'admin',
      name: 'Admin 管理后台',
      url: 'http://localhost:13000',
      enabled: true
    }
  ]
};

export function getConfigPath(): string {
  return join(getProjectRoot(), 'modules.json');
}

export function loadConfig(): ModulesConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    console.log('[Config] 配置文件不存在，使用默认配置');
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ModulesConfig;

    if (!config.modules || !Array.isArray(config.modules)) {
      console.warn('[Config] 配置格式错误，使用默认配置');
      return DEFAULT_CONFIG;
    }

    console.log(`[Config] 已加载配置文件: ${configPath}`);
    return config;
  } catch (error) {
    console.error('[Config] 读取配置文件失败:', error);
    return DEFAULT_CONFIG;
  }
}

let currentConfig: ModulesConfig = loadConfig();
let watchEnabled = false;

export function getConfig(): ModulesConfig {
  return currentConfig;
}

export function reloadConfig(): ModulesConfig {
  currentConfig = loadConfig();
  return currentConfig;
}

export function enableHotReload(): void {
  if (watchEnabled) return;

  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    console.log('[Config] 配置文件不存在，跳过热更新监听');
    return;
  }

  watchFile(configPath, { interval: 1000 }, () => {
    console.log('[Config] 检测到配置文件变化，重新加载...');
    reloadConfig();
  });

  watchEnabled = true;
  console.log('[Config] 已启用配置文件热更新');
}

export function disableHotReload(): void {
  if (!watchEnabled) return;

  const configPath = getConfigPath();
  try {
    unwatchFile(configPath);
    watchEnabled = false;
    console.log('[Config] 已禁用配置文件热更新');
  } catch {}
}

export function findModuleByPath(path: string): ModuleConfig | null {
  const config = getConfig();

  // 所有 /api/* 路由到 admin 服务
  if (path.startsWith('/api/')) {
    const adminModule = config.modules.find(m => m.key === 'admin');
    return adminModule || null;
  }

  return null;
}

export function findModuleByKey(key: string): ModuleConfig | null {
  const config = getConfig();
  return config.modules.find(m => m.key === key) || null;
}
