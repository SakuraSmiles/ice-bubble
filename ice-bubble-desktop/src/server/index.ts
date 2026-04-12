/**
 * Desktop Express 服务器
 * 动态代理中间件集成
 */

import { createServer } from 'http';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import { enableHotReload, disableHotReload, reloadConfig } from '../config/index.js';
import { createProxyMiddleware } from '../middleware/proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const START_PORT = 14000;
const MAX_PORT = 14010;

// 写入端口文件供前端读取
function writePortFile(port: number) {
  const portFile = join(__dirname, '../../.server-port');
  try {
    writeFileSync(portFile, String(port));
    console.log(`[Server] 端口: ${port}`);
  } catch {}
}

// 创建 Express 应用
const app = express();

// 解析 JSON 请求体
app.use(express.json({ limit: '10mb' }));

// 解析 URL 编码请求体
app.use(express.urlencoded({ extended: true }));

// CORS 头
app.use((_req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// 处理 OPTIONS 预检请求
app.options('*', (_req: Request, res: Response) => {
  res.status(200).end();
});

// 返回当前服务器端口
app.get('/__port', (_req: Request, res: Response) => {
  res.json({ port: (server.address() as any)?.port ?? START_PORT });
});

// 启用配置文件热更新（开发模式）
const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
  enableHotReload();
}

// 动态代理中间件 - 处理 /api/* 请求
app.use('/api', createProxyMiddleware());

// 静态文件服务 - 开发环境使用 Vite，生产环境使用 dist
app.use(express.static(join(__dirname, '../../dist')));

// 处理 SPA 路由 - 确保 index.html 被正确返回
app.get('*', (_req: Request, res: Response) => {
  const indexPath = join(__dirname, '../../dist/index.html');
  
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// 创建 HTTP 服务器
const server = createServer(app);

// 尝试启动，端口冲突则尝试下一个
async function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[Server] Desktop 启动: http://localhost:${port}`);
      resolve(port);
    });
    
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (port < MAX_PORT) {
          console.log(`[Server] 端口 ${port} 已被占用，尝试 ${port + 1}...`);
          server.close();
          tryListen(port + 1).then(resolve);
        } else {
          console.error('[Server] 没有可用的端口');
          resolve(null);
        }
      } else {
        console.error('[Server] 启动错误:', err);
        resolve(null);
      }
    });
  });
}

// 优雅关闭
function gracefulShutdown() {
  console.log('[Server] 正在关闭...');
  disableHotReload();
  server.close(() => {
    console.log('[Server] 已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// 启动服务器
async function start() {
  console.log('[Server] 启动中...');
  console.log('[Config] 当前配置:', JSON.stringify(reloadConfig(), null, 2));
  
  const port = await tryListen(START_PORT);
  if (port) {
    writePortFile(port);
    console.log('[Server] 准备就绪');
  }
}

start();

export { app, server };
