/**
 * 模块配置管理
 * 支持从 config/modules.json 读取配置，热更新配置
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';

// 获取项目根目录
function getProjectRoot(): string {
  // Vite 或 Node.js 环境
  if (typeof process !== 'undefined' && process.cwd) {
    return process.cwd();
  }
  // 备用：从 import.meta.url 获取
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = join(__filename, '..', '..', '..');
  return __dirname;
}

import { fileURLToPath } from 'url';

// 模块配置接口
export interface ModuleConfig {
  key: string;
  name: string;
  url: string;
  enabled: boolean;
}

// 配置文件接口
export interface ModulesConfig {
  modules: ModuleConfig[];
}

// 默认配置
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

// 获取配置文件路径
export function getConfigPath(): string {
  const root = getProjectRoot();
  return join(root, 'config', 'modules.json');
}

// 读取配置文件
export function loadConfig(): ModulesConfig {
  const configPath = getConfigPath();
  
  if (!existsSync(configPath)) {
    console.log('[Config] 配置文件不存在，使用默认配置');
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ModulesConfig;
    
    // 验证配置格式
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

// 当前配置缓存
let currentConfig: ModulesConfig = loadConfig();

// 热更新配置
let watchEnabled = false;

/**
 * 获取当前配置
 */
export function getConfig(): ModulesConfig {
  return currentConfig;
}

/**
 * 重新加载配置
 */
export function reloadConfig(): ModulesConfig {
  currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 启用热更新（开发模式）
 */
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

/**
 * 禁用热更新
 */
export function disableHotReload(): void {
  if (!watchEnabled) return;
  
  const configPath = getConfigPath();
  try {
    unwatchFile(configPath);
    watchEnabled = false;
    console.log('[Config] 已禁用配置文件热更新');
  } catch {}
}

/**
 * 根据路径查找对应的模块
 * 目前所有 /api/* 请求都转发到 admin 模块
 */
export function findModuleByPath(path: string): ModuleConfig | null {
  const config = getConfig();
  
  // 目前只有 admin 模块，所有 /api/* 都走 admin
  if (path.startsWith('/api/')) {
    const adminModule = config.modules.find(m => m.key === 'admin');
    return adminModule || null;
  }
  
  return null;
}

/**
 * 根据 key 查找模块
 */
export function findModuleByKey(key: string): ModuleConfig | null {
  const config = getConfig();
  return config.modules.find(m => m.key === key) || null;
}
