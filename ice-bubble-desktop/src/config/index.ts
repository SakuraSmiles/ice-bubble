/**
 * 客户端配置
 * Desktop 纯展示层，不使用 Node.js API
 */

/**
 * API_BASE: 开发模式用相对路径 '/api'（通过 Vite proxy 转发），
 * Tauri 打包模式用 'http://localhost:{port}/api'（Express proxy）
 */
function getApiBase(): string {
  if (typeof window !== 'undefined' && (window as any).__ICE_SERVER_PORT) {
    return `http://localhost:${(window as any).__ICE_SERVER_PORT}/api`;
  }
  return '/api';
}

export const API_BASE = getApiBase();

export async function getProxyPort(): Promise<number> {
  // Tauri 模式下直接用注入的端口
  if (typeof window !== 'undefined' && (window as any).__ICE_SERVER_PORT) {
    return (window as any).__ICE_SERVER_PORT;
  }
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
