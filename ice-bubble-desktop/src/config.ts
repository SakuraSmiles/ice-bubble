// 统一使用 /api 代理，由服务端处理
export const API_BASE = '/api';

// Admin 服务地址（服务端使用）
export const ADMIN_API_BASE = process.env.ADMIN_API || 'http://localhost:13000';
