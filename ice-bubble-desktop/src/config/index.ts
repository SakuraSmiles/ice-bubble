/**
 * 客户端配置
 * 纯前端直连 Admin，无代理层
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

/**
 * API_BASE: Admin 完整 API 地址，如 `http://192.168.1.100:13000/api`
 * 使用 `export let` 实现 ESM live binding，其他模块 import 后能拿到最新值
 */
export let API_BASE = loadAdminConfig().url.replace(/\/+$/, '') + '/api';

/** 获取当前 Admin URL（不含 /api 后缀） */
export function getAdminUrl(): string {
  return loadAdminConfig().url.replace(/\/+$/, '');
}

/** 设置 Admin URL，更新 localStorage 和 API_BASE */
export function setAdminUrl(url: string): void {
  const cleaned = url.replace(/\/+$/, '');
  API_BASE = cleaned + '/api';
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
