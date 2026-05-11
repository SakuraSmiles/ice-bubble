/**
 * Workspace API - 文件工作区 REST 接口
 *
 * GET /api/workspace/tree       获取目录树 + git 状态
 * GET /api/workspace/git-status  获取 git 统计摘要
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/index.js';
import {
  resolveSafePath,
  validateDirectory,
  getDirectoryTree,
  getGitStatusSummary,
  scanDirectories,
} from '../services/workspace-service.js';

export function createWorkspaceRouter(): Router {
  const router = Router();

  /**
   * GET /api/workspace/tree?path=xxx
   * 获取目录树（含 git 状态）
   */
  router.get('/workspace/tree', (req: Request, res: Response) => {
    const rawPath = req.query.path ? String(req.query.path) : '';

    if (!rawPath) {
      res.status(400).json({ error: '缺少 path 参数' });
      return;
    }

    const safePath = resolveSafePath(rawPath);
    if (!safePath) {
      res.status(400).json({ error: '路径不合法，不允许目录穿越' });
      return;
    }

    const validation = validateDirectory(safePath);
    if (validation === 'not_found') {
      res.status(404).json({ error: '路径不存在', path: safePath });
      return;
    }
    if (validation === 'not_directory') {
      res.status(400).json({ error: '路径不是目录', path: safePath });
      return;
    }

    const maxDepth = req.query.depth ? Math.min(Number(req.query.depth), 10) : 1;

    try {
      const tree = getDirectoryTree(safePath, maxDepth);
      res.json(tree);
    } catch (err: any) {
      logger.error('[WorkspaceAPI] /tree error:', err);
      res.status(500).json({ error: '读取目录树失败', detail: err.message });
    }
  });

  /**
   * GET /api/workspace/git-status?path=xxx
   * 获取 git 状态统计
   */
  router.get('/workspace/git-status', (req: Request, res: Response) => {
    const rawPath = req.query.path ? String(req.query.path) : '';

    if (!rawPath) {
      res.status(400).json({ error: '缺少 path 参数' });
      return;
    }

    const safePath = resolveSafePath(rawPath);
    if (!safePath) {
      res.status(400).json({ error: '路径不合法，不允许目录穿越' });
      return;
    }

    const validation = validateDirectory(safePath);
    if (validation === 'not_found') {
      res.status(404).json({ error: '路径不存在', path: safePath });
      return;
    }
    if (validation === 'not_directory') {
      res.status(400).json({ error: '路径不是目录', path: safePath });
      return;
    }

    try {
      const summary = getGitStatusSummary(safePath);
      res.json(summary);
    } catch (err: any) {
      logger.error('[WorkspaceAPI] /git-status error:', err);
      res.status(500).json({ error: '获取 git 状态失败', detail: err.message });
    }
  });

  /**
   * GET /api/workspace/scan?base=xxx
   * 扫描一级子目录
   */
  router.get('/workspace/scan', (req: Request, res: Response) => {
    const rawBase = req.query.base ? String(req.query.base) : '';

    if (!rawBase) {
      res.status(400).json({ error: '缺少 base 参数' });
      return;
    }

    const safePath = resolveSafePath(rawBase);
    if (!safePath) {
      res.status(400).json({ error: '路径不合法，不允许目录穿越' });
      return;
    }

    const validation = validateDirectory(safePath);
    if (validation === 'not_found') {
      res.status(404).json({ error: '路径不存在', path: safePath });
      return;
    }
    if (validation === 'not_directory') {
      res.status(400).json({ error: '路径不是目录', path: safePath });
      return;
    }

    try {
      const result = scanDirectories(safePath);
      res.json(result);
    } catch (err: any) {
      logger.error('[WorkspaceAPI] /scan error:', err);
      res.status(500).json({ error: '扫描目录失败', detail: err.message });
    }
  });

  return router;
}
