/**
 * Modules API - 模块管理 REST 接口
 * 
 * @module modules
 */

import { Router, Request, Response } from 'express';
import { ModuleScheduler } from '../modules/module-scheduler.js';

export function createModulesRouter(scheduler: ModuleScheduler): Router {
  const router = Router();

  /**
   * GET /api/modules
   * 获取所有模块列表
   */
  router.get('/', (_req: Request, res: Response) => {
    const modules = scheduler.getModules();
    res.json({
      count: modules.length,
      modules: modules.map(m => ({
        moduleKey: m.moduleKey,
        name: m.name,
        baseUrl: m.baseUrl,
        enabled: m.enabled,
        pollInterval: m.pollInterval
      }))
    });
  });

  /**
   * GET /api/modules/:key
   * 获取单个模块详情
   */
  router.get('/:key', async (req: Request, res: Response) => {
    const { key } = req.params;
    const module = scheduler.getModule(key);

    if (!module) {
      res.status(404).json({ error: '模块不存在', moduleKey: key });
      return;
    }

    // 优先从数据库读取状态，失败则尝试从 collector 获取
    let status = await scheduler.getStatusFromDatabase(key);
    if (!status) {
      status = await scheduler.pollModuleNow(key);
    }

    res.json({
      module,
      status: status || null
    });
  });

  /**
   * GET /api/modules/:key/status
   * 手动触发模块状态更新
   */
  router.get('/:key/status', async (req: Request, res: Response) => {
    const { key } = req.params;
    const status = await scheduler.pollModuleNow(key);
    
    if (!status) {
      res.status(404).json({ error: '获取状态失败', moduleKey: key });
      return;
    }
    
    res.json(status);
  });

  /**
   * GET /api/modules/:key/config
   * 获取模块运行时配置
   */
  router.get('/:key/config', async (req: Request, res: Response) => {
    const { key } = req.params;
    const module = scheduler.getModule(key);
    
    if (!module) {
      res.status(404).json({ error: '模块不存在', moduleKey: key });
      return;
    }

    const config = await scheduler.getModuleConfig(key);
    
    if (!config) {
      res.status(404).json({ error: '获取配置失败', moduleKey: key });
      return;
    }
    
    res.json(config);
  });

  return router;
}