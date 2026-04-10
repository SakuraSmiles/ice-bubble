// 开发环境使用 /api 代理，生产环境动态获取端口
// 生产环境会尝试端口 14000-14010，使用 /api 让服务端重定向
export const API_BASE = '/api';

export async function getProxyPort(): Promise<number> {
  // 默认端口
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
export const ADMIN_API_BASE = process.env.ADMIN_API || 'http://localhost:13000';
