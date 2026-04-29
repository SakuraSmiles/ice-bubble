/**
 * 客户端配置
 * Desktop 纯展示层，不使用 Node.js API
 */

// API_BASE: 所有 API 请求通过 Vite dev server 或生产服务端代理
export const API_BASE = '/api';

export async function getProxyPort(): Promise<number> {
  let port = 14000;
  try {
    const res = await fetch('/__port');
    if (res.ok) {
      const data = await res.json();
      port = data.port;
    }
  } catch {}
  return port;
}

// Admin 服务地址
// 服务端直接请求Admin，浏览器端通过Desktop proxy（相对路径）
export const ADMIN_API_BASE = typeof process !== 'undefined' && process.env.ADMIN_API
  ? process.env.ADMIN_API
  : (typeof process !== 'undefined' ? 'http://localhost:13000' : '');
