/**
 * Media API — 通过 media ID 查询和下载附件文件
 *
 * GET /api/media/:id          — 查询单个 media 元数据
 * GET /api/media/batch        — 批量查询 media 元数据
 * GET /api/media/file/:id     — 下载附件文件（浏览器 <img> 可直接使用）
 */

import { Router, Request, Response, NextFunction } from 'express';
import { existsSync, statSync, copyFileSync } from 'fs';
import { basename, join } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GatewayProxy } from '../gateway/gateway-proxy.js';

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bin: 'application/octet-stream',
};

interface MediaItem {
  id: string;
  url: string;
  mimeType: string;
  fileName: string;
  size: number;
  source: 'admin' | 'gateway';
}

interface MediaMetaOptions {
  db: Database;
  attachmentsDir: string;
  gatewayProxy: GatewayProxy | null;
  gatewayMediaDir?: string;
  canvasDir?: string;
}

/**
 * 从 Admin DB 查询 media 记录
 */
function findInAdmin(db: Database, id: string): MediaItem | null {
  const row = db.prepare(`
    SELECT id, file_path, mime_type, file_size FROM attachments WHERE id = ?
  `).get(id) as { id: string; file_path: string; mime_type: string; file_size: number } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    url: `/api/media/file/${row.id}`,
    mimeType: row.mime_type || 'application/octet-stream',
    fileName: row.file_path,
    size: row.file_size,
    source: 'admin',
  };
}

/**
 * 从 Admin 本地磁盘按文件名查找（兼容直接用文件名作为 ID 的场景）
 */
function findInAdminByFilename(db: Database, filename: string, attachmentsDir: string): MediaItem | null {
  const row = db.prepare(`
    SELECT id, file_path, mime_type, file_size FROM attachments WHERE file_path = ?
  `).get(filename) as { id: string; file_path: string; mime_type: string; file_size: number } | undefined;

  if (!row) {
    // DB 中没有记录，但磁盘上可能有文件
    const filePath = join(attachmentsDir, filename);
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
    return {
      id: filename,
      url: `/api/media/file/${filename}`,
      mimeType: MIME_MAP[ext] || 'application/octet-stream',
      fileName: filename,
      size: stat.size,
      source: 'admin',
    };
  }
  return {
    id: row.id,
    url: `/api/media/file/${row.id}`,
    mimeType: row.mime_type || 'application/octet-stream',
    fileName: row.file_path,
    size: row.file_size,
    source: 'admin',
  };
}

/**
 * 从 Gateway media 目录查找
 */
function findInGateway(id: string, gatewayMediaDir: string): MediaItem | null {
  const filePath = join(gatewayMediaDir, id);
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const ext = id.split('.').pop()?.toLowerCase() || 'bin';
  return {
    id,
    url: `/api/media/file/${id}`,
    mimeType: MIME_MAP[ext] || 'application/octet-stream',
    fileName: id,
    size: stat.size,
    source: 'gateway',
  };
}

/**
 * 从 canvas 目录查找
 */
function findInCanvas(id: string, canvasDir: string): MediaItem | null {
  const filePath = join(canvasDir, id);
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const ext = id.split('.').pop()?.toLowerCase() || 'bin';
  return {
    id,
    url: `/api/media/file/${id}`,
    mimeType: MIME_MAP[ext] || 'application/octet-stream',
    fileName: id,
    size: stat.size,
    source: 'gateway',
  };
}

/**
 * 查找媒体文件的本地磁盘路径
 */
function resolveFilePath(id: string, db: Database, attachmentsDir: string, gatewayMediaDir: string | undefined, canvasDir?: string): string | null {
  // 1. 尝试按 UUID 从 Admin DB 查找文件名
  const row = db.prepare(`SELECT file_path FROM attachments WHERE id = ?`).get(id) as { file_path: string } | undefined;
  if (row) {
    const p = join(attachmentsDir, row.file_path);
    if (existsSync(p)) return p;
  }

  // 2. 尝试直接作为文件名在 Admin attachments 目录查找
  if (!id.includes('..') && !id.includes('/')) {
    const p = join(attachmentsDir, id);
    if (existsSync(p)) return p;
  }

  // 3. 尝试 Gateway media 目录
  if (gatewayMediaDir && !id.includes('..') && !id.includes('/')) {
    const p = join(gatewayMediaDir, id);
    if (existsSync(p)) return p;
  }

  // 4. 尝试 canvas 目录
  if (canvasDir && !id.includes('..') && !id.includes('/')) {
    const p = join(canvasDir, id);
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * 查询单个 media 元数据
 */
function getMediaMeta(id: string, opts: MediaMetaOptions): MediaItem | null {
  // 1. Admin DB by UUID
  const fromDb = findInAdmin(opts.db, id);
  if (fromDb) return fromDb;

  // 2. Admin by filename
  const fromFilename = findInAdminByFilename(opts.db, id, opts.attachmentsDir);
  if (fromFilename) return fromFilename;

  // 3. Gateway media dir
  if (opts.gatewayMediaDir) {
    const fromGateway = findInGateway(id, opts.gatewayMediaDir);
    if (fromGateway) return fromGateway;
  }

  // 4. Canvas dir
  if (opts.canvasDir && !id.includes('..') && !id.includes('/')) {
    const fromCanvas = findInCanvas(id, opts.canvasDir);
    if (fromCanvas) return fromCanvas;
  }

  return null;
}

/**
 * 解析文件名对应 mimeType
 */
function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * 创建 Media 路由（含文件下载，需在 auth middleware 之前注册）
 */
export function createMediaRouter(opts: MediaMetaOptions): Router {
  const router = Router();

  // GET /api/media/batch?ids=id1,id2,id3
  router.get('/batch', (req: Request, res: Response) => {
    const idsStr = req.query.ids as string;
    if (!idsStr) {
      res.status(400).json({ error: 'Missing ids parameter' });
      return;
    }
    const ids = idsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 50) {
      res.status(400).json({ error: 'ids must contain 1-50 values' });
      return;
    }
    const items: MediaItem[] = [];
    for (const id of ids) {
      const item = getMediaMeta(id, opts);
      if (item) items.push(item);
    }
    res.json({ items });
  });

  // GET /api/media/:id
  router.get('/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id || id.includes('..') || id.includes('/')) {
      res.status(400).json({ error: 'Invalid media ID' });
      return;
    }
    const item = getMediaMeta(id, opts);
    if (!item) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }
    res.json(item);
  });

  return router;
}

/**
 * 创建 Media 文件下载处理器（无 auth，浏览器 <img> 可直接使用）
 * ⚠️ 必须在 auth middleware 之前注册
 * 返回普通函数，可直接作为 (req, res, next) => void 使用
 */
export function createMediaFileRouter(opts: MediaMetaOptions): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, _next: NextFunction) => {
    const id = req.params?.id;
    if (!id || id.includes('..') || id.includes('/')) {
      res.status(400).json({ error: 'Invalid media ID' });
      return;
    }

    // 查找本地文件
    const filePath = resolveFilePath(id, opts.db, opts.attachmentsDir, opts.gatewayMediaDir, opts.canvasDir);
    if (!filePath) {
      res.status(404).json({ error: 'Media file not found' });
      return;
    }

    const mimeType = guessMime(id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);

    // Proxy-Cache: 如果文件来自 Gateway 目录，自动复制到 Admin 本地
    if (opts.gatewayMediaDir && filePath.startsWith(opts.gatewayMediaDir)) {
      const filename = basename(filePath);
      const adminPath = join(opts.attachmentsDir, filename);
      if (existsSync(adminPath)) return; // 已缓存，跳过
      try {
        copyFileSync(filePath, adminPath);
        const stat = statSync(filePath);
        opts.db.prepare(`
          INSERT OR IGNORE INTO attachments (id, session_key, file_path, mime_type, file_size, created_at)
          VALUES (?, '__gateway_cache__', ?, ?, ?, ?)
        `).run(randomUUID(), filename, mimeType, stat.size, new Date().toISOString());
      } catch (err) {
        console.warn('[Media] Proxy-cache failed', { id, error: String(err) });
      }
    }
  };
}
