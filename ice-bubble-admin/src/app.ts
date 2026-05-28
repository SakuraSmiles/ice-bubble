/**
 * Express 应用创建 — 纯应用层，不含业务初始化
 *
 * createApp() 负责：
 *   - body parser
 *   - CORS
 *   - rate-limit
 *   - 无认证路由（auth/status, auth/verify, avatars, attachments, media file）
 *   - Bearer auth 中间件
 *   - 占位 handler 注入点（attachmentQuery, mediaFile）
 */

import express, { Request, Response, NextFunction } from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppConfig } from './config.js';
import { createBearerAuthMiddleware } from './utils/auth-middleware.js';

export function createApp(configData: AppConfig, authToken: string) {
  const app = express();

  // body parser
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // CORS middleware — 基于配置收紧 origin
  const corsOrigins = configData.cors?.origins;
  const corsOriginAllowed = corsOrigins && corsOrigins.length > 0;
  app.use((req, res, next) => {
    if (corsOriginAllowed && corsOrigins) {
      const origin = req.headers.origin;
      if (origin && corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });

  // 速率限制：未认证请求 60 req/min per IP
  const getClientIp = (req: express.Request): string => {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  };

  // 用 require + 类型断言解决 monorepo 类型冲突
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rateLimit = require('express-rate-limit');

  const unauthLimiter = rateLimit.default({
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: (req: express.Request) => getClientIp(req),
    handler: (_req: express.Request, res: express.Response) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Too Many Requests' });
    },
  }) as unknown as express.RequestHandler;

  const authLimiter = rateLimit.default({
    windowMs: 60 * 1000,
    max: 300,
    keyGenerator: (req: express.Request) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        return `token:${authHeader.slice(7)}`;
      }
      return getClientIp(req);
    },
    skip: (req: express.Request) => {
      return !req.headers.authorization?.startsWith('Bearer ');
    },
    handler: (_req: express.Request, res: express.Response) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Too Many Requests' });
    },
  }) as unknown as express.RequestHandler;

  app.use(unauthLimiter);
  app.use(authLimiter);

  // Auth status endpoint — no auth required
  app.get('/api/auth/status', (_req, res) => {
    const configured = !!(process.env.ICE_AUTH_TOKEN || configData.auth?.token);
    // 这里 needsToken 逻辑保持简单：有固定 token 就不是 auto-generated
    res.json({
      configured,
      needsToken: false,
      tokenHint: undefined,
    });
  });

  // Token verification endpoint — no auth required
  app.post('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ valid: false, error: '未提供认证令牌' });
      return;
    }
    const provided = authHeader.slice(7);
    if (provided !== authToken) {
      res.status(401).json({ valid: false, error: '认证令牌无效' });
      return;
    }
    res.json({ valid: true });
  });

  // Avatar endpoint — no auth required
  const avatarsDirEarly = process.env.ADMIN_AVATARS_DIR || join(__dirname, '..', '..', 'data', 'avatars');
  if (!existsSync(avatarsDirEarly)) {
    mkdirSync(avatarsDirEarly, { recursive: true });
  }
  app.get('/api/resources/avatars/:filename', (req, res) => {
    const { filename } = req.params;
    if (!filename || filename.includes('..') || filename.includes('/')) {
      res.status(404).json({ error: 'Avatar not found' });
      return;
    }
    const filePath = join(avatarsDirEarly, filename);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Avatar not found' });
      return;
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    res.setHeader('Content-Type', mimeMap[ext || ''] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  });

  // Attachment query API — placeholder before auth middleware
  let attachmentQueryHandler: ((req: Request, res: Response) => void) | null = null;
  app.get('/api/attachments/query', (req, res) => {
    if (attachmentQueryHandler) { attachmentQueryHandler(req, res); return; }
    res.status(503).json({ attachments: [] });
  });

  // Attachment static files — no auth required
  const attachmentsDirEarly = process.env.ATTACHMENTS_DIR || join(process.env.HOME || '/root', '.local', 'share', 'ice-bubble', 'data', 'attachments');
  if (!existsSync(attachmentsDirEarly)) {
    mkdirSync(attachmentsDirEarly, { recursive: true });
  }
  app.get('/api/attachments/:filename', (req, res) => {
    const { filename } = req.params;
    if (!filename || filename.includes('..') || filename.includes('/') || filename === 'query') {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    const filePath = join(attachmentsDirEarly, filename);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    res.setHeader('Content-Type', mimeMap[ext || ''] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(filePath);
  });

  // Media file download — placeholder before auth middleware
  let mediaFileHandler: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
  app.get('/api/media/file/:id', (req, res, next) => {
    if (mediaFileHandler) { mediaFileHandler(req, res, next); return; }
    res.status(503).json({ error: 'Media service not ready' });
  });

  // Bearer token auth middleware for all /api/* routes
  app.use('/api', createBearerAuthMiddleware(authToken));

  return {
    app,
    setAttachmentQueryHandler: (handler: (req: Request, res: Response) => void) => {
      attachmentQueryHandler = handler;
    },
    setMediaFileHandler: (handler: (req: Request, res: Response, next: NextFunction) => void) => {
      mediaFileHandler = handler;
    },
  };
}
