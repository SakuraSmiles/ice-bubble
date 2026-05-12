/**
 * 客户端配置
 * 开发环境：API_BASE = '/api'（走 Vite proxy，避免 CORS 和 HTTPS 升级问题）
 * 生产环境（Tauri）：API_BASE = adminUrl + '/api'（直连 Admin）
 *
 * 存储策略：
 * - Tauri 环境 → @tauri-apps/plugin-store（JSON 文件持久化，重装不丢失）
 * - Dev 环境   → localStorage（fallback）
 * - 首次 Tauri 启动时自动从 localStorage 迁移旧配置
 */

const STORAGE_KEY = 'ice-bubble-admin-config';
const SETUP_DONE_KEY = 'ice-bubble-setup-done';
const DEFAULT_ADMIN_URL = 'http://localhost:13000';
const STORE_FILE = 'settings.json';

// ============ 内存缓存 ============

let cachedUrl = DEFAULT_ADMIN_URL;
let cachedAuthToken = '';
let cachedSetupDone = false;

// ============ 环境检测 ============

let isTauri = false;
let store: any = null; // Tauri Store 实例

function isDev(): boolean {
  return import.meta.env?.DEV === true;
}

// ============ localStorage fallback（dev 模式） ============

function lsGet(key: string): any {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: any): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function lsRemove(key: string): void {
  localStorage.removeItem(key);
}

// ============ 初始化 ============

/**
 * 初始化配置存储，在 App 启动时调用。
 * Tauri 环境：打开 Store 文件，迁移 localStorage 旧数据（如有），加载到内存缓存。
 * Dev 环境：从 localStorage 加载到内存缓存。
 */
export async function initConfig(): Promise<void> {
  // 检测 Tauri 环境
  isTauri = !!(window as any).__TAURI_INTERNALS__;

  if (isTauri) {
    try {
      // 延迟导入，dev 模式下不需要
      const { load } = await import('@tauri-apps/plugin-store');
      store = await load(STORE_FILE);

      // 从 Store 加载
      cachedUrl = (await store.get('adminUrl' as string)) || DEFAULT_ADMIN_URL;
      cachedAuthToken = (await store.get('authToken' as string)) || '';
      cachedSetupDone = (await store.get('setupDone' as string)) || false;

      // 一次性迁移：如果 Store 为空但 localStorage 有旧数据
      const lsData = lsGet(STORAGE_KEY);
      const lsSetupDone = localStorage.getItem(SETUP_DONE_KEY) === 'true';

      if ((lsData && (!cachedUrl || cachedUrl === DEFAULT_ADMIN_URL) && lsData.url) ||
          lsSetupDone && !cachedSetupDone) {
        // 有旧数据需要迁移
        if (lsData?.url && lsData.url !== DEFAULT_ADMIN_URL) {
          cachedUrl = lsData.url;
          await store.set('adminUrl', lsData.url);
        }
        if (lsData?.authToken) {
          cachedAuthToken = lsData.authToken;
          await store.set('authToken', lsData.authToken);
        }
        if (lsSetupDone) {
          cachedSetupDone = true;
          await store.set('setupDone', true);
        }
        if (lsData?.lastConnected) {
          await store.set('lastConnected', lsData.lastConnected);
        }
        await store.save();
        // 迁移完成，清除 localStorage 旧数据
        lsRemove(STORAGE_KEY);
        localStorage.removeItem(SETUP_DONE_KEY);
      }
    } catch (e) {
      console.warn('[config] Tauri Store 初始化失败，fallback 到 localStorage:', e);
      isTauri = false;
    }
  }

  // Dev 模式 或 Store fallback：从 localStorage 加载
  if (!isTauri) {
    const data = lsGet(STORAGE_KEY);
    if (data?.url) cachedUrl = data.url;
    if (data?.authToken) cachedAuthToken = data.authToken;
    cachedSetupDone = localStorage.getItem(SETUP_DONE_KEY) === 'true';
  }

  // 更新 API_BASE
  updateApiBase();
}

// ============ 内部存储 ============

async function persistConfig(): Promise<void> {
  if (isTauri && store) {
    await store.set('adminUrl', cachedUrl);
    await store.set('authToken', cachedAuthToken);
    await store.set('setupDone', cachedSetupDone);
    await store.save();
  } else {
    const existing = lsGet(STORAGE_KEY) || {};
    lsSet(STORAGE_KEY, {
      ...existing,
      url: cachedUrl,
      authToken: cachedAuthToken,
      lastConnected: Date.now(),
    });
    if (cachedSetupDone) {
      localStorage.setItem(SETUP_DONE_KEY, 'true');
    }
  }
}

// ============ API_BASE ============

function updateApiBase(): void {
  if (!isDev()) {
    API_BASE = cachedUrl.replace(/\/+$/, '') + '/api';
  }
}

/**
 * API_BASE: API 请求基础路径
 *
 * 开发环境 → '/api'（相对路径，走 Vite proxy → Admin）
 * 生产环境 → 'http://xxx:13000/api'（绝对路径，直连 Admin）
 */
export let API_BASE = '/api';

// ============ 公开接口 ============

/** 获取 Admin URL（同步，从内存缓存读） */
export function getAdminUrl(): string {
  return cachedUrl.replace(/\/+$/, '');
}

/** 设置 Admin URL（异步，写文件 + 更新缓存） */
export async function setAdminUrl(url: string): Promise<void> {
  cachedUrl = url.replace(/\/+$/, '');
  updateApiBase();
  await persistConfig();
}

/** 获取 Admin Auth Token（同步，从内存缓存读） */
export function getAdminAuthToken(): string {
  return cachedAuthToken || '';
}

/** 设置 Admin Auth Token（异步，写文件 + 更新缓存） */
export async function setAdminAuthToken(token: string): Promise<void> {
  cachedAuthToken = token;
  await persistConfig();
}

/** 标记 Setup 完成 */
export async function setSetupComplete(): Promise<void> {
  cachedSetupDone = true;
  await persistConfig();
}

/** 是否已完成 Setup */
export function isSetupDone(): boolean {
  return cachedSetupDone;
}

/** 获取完整配置（用于 adminConnection 等需要读取原始数据的场景） */
export function getRawConfig(): { url: string; authToken: string; lastConnected?: number } {
  return {
    url: cachedUrl,
    authToken: cachedAuthToken,
  };
}
