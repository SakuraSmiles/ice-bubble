/**
 * Resources API - 静态资源
 *
 * GET /api/resources/avatars/:filename
 */

import { Router, Request, Response } from 'express';
import { DataRepository } from '../storage/data-repository.js';

export function createResourcesRouter(repository: DataRepository): Router {
  const router = Router();

  /**
   * GET /api/resources/avatars/:filename
   * 获取头像文件
   */
  router.get('/avatars/:filename', (req: Request, res: Response) => {
    const { filename } = req.params;
    
    const result = repository.getAvatar(filename);
    if (!result) {
      res.status(404).json({ error: 'Avatar not found' });
      return;
    }
    
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 缓存 1 天
    res.send(result.buffer);
  });

  return router;
}
