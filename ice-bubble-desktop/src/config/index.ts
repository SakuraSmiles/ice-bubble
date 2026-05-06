/**
 * 客户端配置
 * 开发环境：API_BASE = '/api'（走 Vite proxy，避免 CORS 和 HTTPS 升级问题）
 * 生产环境（Tauri）：API_BASE = adminUrl + '/api'（直连 Admin）
 */

const STORAGE_KEY = 'ice-bubble-admin-config';
const DEFAULT_ADMIN_URL = 'http://localhost:13000';

function loadAdminConfig(): { url: string; authToken?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.url) return parsed;
    }
  } catch {}
  return { url: DEFAULT_ADMIN_URL };
}

/** 是否为开发环境（Vite dev server） */
function isDev(): boolean {
  return import.meta.env?.DEV === true;
}

/**
 * API_BASE: API 请求基础路径
 *
 * 开发环境 → '/api'（相对路径，走 Vite proxy → Admin）
 * 生产环境 → 'http://xxx:13000/api'（绝对路径，直连 Admin）
 *
 * 使用 `export let` 实现 ESM live binding，setAdminUrl 后其他模块自动拿到新值
 */
function resolveApiBase(): string {
  if (isDev()) return '/api';
  const url = loadAdminConfig().url.replace(/\/+$/, '');
  return url + '/api';
}

export let API_BASE = resolveApiBase();

/** 获取当前 Admin URL（不含 /api 后缀） */
export function getAdminUrl(): string {
  return loadAdminConfig().url.replace(/\/+$/, '');
}

/** 设置 Admin URL，更新 localStorage 和 API_BASE */
export function setAdminUrl(url: string): void {
  const cleaned = url.replace(/\/+$/, '');
  // 开发环境 API_BASE 不变（始终走 Vite proxy）
  if (!isDev()) {
    API_BASE = cleaned + '/api';
  }
  // 保留已有 authToken
  const existing = loadAdminConfig();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...existing,
    url: cleaned,
    lastConnected: Date.now(),
  }));
}

/** 保存 Admin Auth Token */
export function setAdminAuthToken(token: string): void {
  const existing = loadAdminConfig();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...existing,
    authToken: token,
  }));
}

/** 获取 Admin Auth Token */
export function getAdminAuthToken(): string {
  return loadAdminConfig().authToken || '';
}
