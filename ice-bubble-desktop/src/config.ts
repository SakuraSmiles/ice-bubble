// 开发环境使用 /api 代理，生产环境直接调用 admin
// @ts-expect-error import.meta.dev 在 Vite 中存在
const isDev = import.meta?.dev ?? true;
export const API_BASE = isDev ? '/api' : 'http://localhost:13000';

// Admin 服务地址（服务端使用）
export const ADMIN_API_BASE = process.env.ADMIN_API || 'http://localhost:13000';
