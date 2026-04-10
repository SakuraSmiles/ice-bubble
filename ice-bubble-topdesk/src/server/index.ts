import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 14000;
const ADMIN_API = process.env.ADMIN_API || 'http://localhost:13000';

// CORS 配置
app.use(cors({
  origin: ['http://localhost:14000', 'http://localhost:1420'],
  credentials: true
}));

// API 代理到 admin
app.use('/api', createProxyMiddleware({
  target: ADMIN_API,
  changeOrigin: true,
  pathRewrite: { '^/api': '/api' }
}));

// 静态文件服务（Vite build 后的 dist）
const distPath = join(__dirname, '../../dist');
app.use(express.static(distPath));

// SPA fallback - 需要排除 API 路由
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`topdesk server running on http://localhost:${PORT}`);
  console.log(`admin API proxy: ${ADMIN_API}`);
});
