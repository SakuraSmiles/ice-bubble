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

// Admin 服务地址（服务端使用）
export const ADMIN_API_BASE = typeof process !== 'undefined'
  ? (process.env.ADMIN_API || 'http://localhost:13000')
  : 'http://localhost:13000';
