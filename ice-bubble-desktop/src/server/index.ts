/**
 * Desktop Express 服务器
 * 动态代理中间件集成
 */

import { createServer, IncomingMessage } from 'http';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { enableHotReload, disableHotReload, reloadConfig, findModuleByKey, getConfig } from '../config.server.js';
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

// 解析原始请求体（用于代理），同时支持 JSON 解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

// CORS 头 — 从 modules.json 读取允许来源
app.use((req: Request, res: Response, next) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const config = reloadConfig();
  let allowedOrigins: string[];

  if (isDev) {
    // 开发环境允许本地开发服务器
    allowedOrigins = ['http://localhost:1420', 'http://localhost:14000'];
  } else if (config.cors?.origins && config.cors.origins.length > 0) {
    allowedOrigins = config.cors.origins;
  } else {
    // 配置文件不存在或无 origins 时，默认允许所有来源（内网/开发阶段）
    allowedOrigins = ['*'];
  }

  const origin = req.header('origin');
  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// 处理 OPTIONS 预检请求
app.options('/{*path}', (_req: Request, res: Response) => {
  res.status(200).end();
});

// 返回当前服务器端口
app.get('/__port', (_req: Request, res: Response) => {
  res.json({ port: (currentServer?.address() as any)?.port ?? START_PORT });
});

// 启用配置文件热更新（开发模式）
const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
  enableHotReload();
}

// 动态代理中间件 - 处理 /api/* 请求
app.use('/api', createProxyMiddleware());

// 静态文件服务 - 开发环境使用 Vite，生产环境使用 dist
app.use(express.static(join(__dirname, '../dist')));

// 处理 SPA 路由 - 确保 index.html 被正确返回
app.get('/{*path}', (_req: Request, res: Response) => {
  const indexPath = join(__dirname, '../dist/index.html');
  
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// 校验 WebSocket 请求的 Origin header
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin as string | undefined;
  const host = req.headers.host as string | undefined;

  // 允许空 origin（非浏览器客户端）
  if (!origin) return true;

  // 允许 localhost / loopback
  try {
    const originUrl = new URL(origin);
    const { hostname } = originUrl;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    ) {
      return true;
    }

    // 允许同源请求（origin 的 host 部分与请求 host 匹配）
    if (host) {
      const originHost = originUrl.host; // includes port
      if (originHost === host) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

// WebSocket 代理 — 将 /ws 升级请求转发到 Admin
function setupWebSocketProxy(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url || '/', `http://${req.headers.host}`);

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Origin 校验
    if (!isOriginAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Token 鉴权（WebSocket 没有 Authorization header，依赖查询参数）
    const config = getConfig();
    if (config.authToken) {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token || token !== config.authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const adminModule = findModuleByKey('admin');
    if (!adminModule || !adminModule.enabled) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const adminUrl = new URL('/ws', adminModule.url);
    const isSecure = adminUrl.protocol === 'wss:';
    const rejectUnauthorized = config.rejectUnauthorized ?? true;
    const targetWs = new WebSocket(`${isSecure ? 'wss' : 'ws'}://${adminUrl.host}${adminUrl.pathname}${adminUrl.search}`, {
      rejectUnauthorized,
    });

    targetWs.on('open', () => {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        // 双向转发
        clientWs.on('message', (data, isBinary) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(data, { binary: isBinary });
          }
        });

        targetWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });

        clientWs.on('close', (code, reason) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.close(code, reason);
          }
        });

        targetWs.on('close', (code, reason) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
          }
        });

        clientWs.on('error', (err) => {
          console.error('[WS Proxy] Client error:', err.message);
          targetWs.terminate();
        });

        targetWs.on('error', (err) => {
          console.error('[WS Proxy] Target error:', err.message);
          clientWs.terminate();
        });
      });
    });

    targetWs.on('error', (err) => {
      console.error('[WS Proxy] Connection to admin failed:', err.message);
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });
  });
}

// 追踪当前运行的 server 实例
let currentServer: ReturnType<typeof createServer> | null = null;

// 尝试启动，端口冲突则创建新 server 重试
async function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    // 每次尝试都创建新的 server 实例
    const newServer = createServer(app);
    currentServer = newServer;
    
    setupWebSocketProxy(newServer);

    newServer.listen(port, () => {
      console.log(`[Server] Desktop 启动: http://localhost:${port}`);
      resolve(port);
    });
    
    newServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        newServer.close(() => {
          if (port < MAX_PORT) {
            console.log(`[Server] 端口 ${port} 已被占用，尝试 ${port + 1}...`);
            tryListen(port + 1).then(resolve);
          } else {
            console.error('[Server] 没有可用的端口 (14000-14010 均被占用)');
            console.error('[Server] 请关闭占用这些端口的进程后重试');
            process.exit(1);
          }
        });
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
  if (currentServer) {
    currentServer.close(() => {
      console.log('[Server] 已关闭');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
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

export { app };
