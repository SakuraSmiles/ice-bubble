/**
 * Server-only config - DO NOT import from client-side code
 * Contains fs-dependent config loading and hot-reload
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

function getProjectRoot(): string {
  if (typeof process !== 'undefined' && process.cwd) {
    return process.cwd();
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = join(__filename, '..', '..');
  return __dirname;
}

export interface ModuleConfig {
  key: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface ModulesConfig {
  modules: ModuleConfig[];
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
  const root = getProjectRoot();
  return join(root, 'config', 'modules.json');
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
