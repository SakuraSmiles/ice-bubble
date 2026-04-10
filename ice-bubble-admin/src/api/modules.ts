/**
 * Modules API - 模块管理 REST 接口
 * 
 * @module modules
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ModuleScheduler } from '../modules/module-scheduler.js';

// config.json 路径（相对于 src/）
function getConfigPath(): string {
  // 从模块文件位置向上两级到项目根目录，再进入 config/
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(projectRoot, 'config', 'config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export function createModulesRouter(scheduler: ModuleScheduler): Router {
  const router = Router();

  /**
   * GET /api/modules
   * 获取所有模块列表
   */
  router.get('/', async (_req: Request, res: Response) => {
    const modules = scheduler.getModules();
    
    // 获取每个模块的 version
    const modulesWithVersion = await Promise.all(
      modules.map(async (m) => {
        // version 来自 scheduler 内存（从数据库读取的）
        const version = (m as any).version || null;
        return {
          moduleKey: m.moduleKey,
          name: m.name,
          baseUrl: m.baseUrl,
          enabled: m.enabled,
          pollInterval: m.pollInterval,
          registeredTime: m.registeredTime,
          version,
        };
      })
    );
    
    res.json({
      count: modulesWithVersion.length,
      modules: modulesWithVersion
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

    // admin 自检状态（state=null 表示由前端特殊处理显示为"运行中"）
    if (key === 'admin') {
      const adminStatus = scheduler.getAdminStatus();
      res.json({
        moduleKey: module.moduleKey,
        name: module.name,
        baseUrl: module.baseUrl,
        enabled: module.enabled,
        pollInterval: module.pollInterval,
        registeredTime: module.registeredTime,
        version: '1.0.0',
        status: {
          state: null,
          lastPollTime: adminStatus.runtime?.startTime || null,
          lastError: null,
          runtime: { startTime: adminStatus.runtime?.startTime || null },
        }
      });
      return;
    }

    // 优先从数据库读取状态，失败则尝试从 collector 获取
    let dbStatus = await scheduler.getStatusFromDatabase(key);
    if (!dbStatus) {
      await scheduler.pollModuleNow(key);
      dbStatus = await scheduler.getStatusFromDatabase(key);
    }

    res.json({
      moduleKey: module.moduleKey,
      name: module.name,
      baseUrl: module.baseUrl,
      enabled: module.enabled,
      pollInterval: module.pollInterval,
      registeredTime: module.registeredTime,
      version: dbStatus?.version || module.version || null,
      status: dbStatus ? {
        state: dbStatus.status,
        lastPollTime: dbStatus.lastPollTime || null,
        lastError: dbStatus.lastError || null,
        runtime: {
          startTime: dbStatus.runtime?.startTime || null,
        },
      } : {
        state: 'running',
        lastPollTime: null,
        lastError: null,
        runtime: { startTime: null },
      }
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
   * POST /api/modules
   * 新增模块
   */
  router.post('/', async (req: Request, res: Response) => {
    console.log('[DEBUG POST /api/modules] req.body:', JSON.stringify(req.body));
    console.log('[DEBUG] headers:', JSON.stringify(req.headers));
    
    const { moduleKey, name, baseUrl, enabled, pollInterval } = req.body as {
      moduleKey: string;
      name: string;
      baseUrl: string;
      enabled: boolean;
      pollInterval?: number;
    };

    if (!moduleKey || !name || !baseUrl) {
      res.status(400).json({ error: '缺少必填字段：moduleKey, name, baseUrl' });
      return;
    }

    // 防止重复
    const existing = scheduler.getModule(moduleKey);
    if (existing) {
      res.status(409).json({ error: '模块已存在', moduleKey });
      return;
    }

    const config = readConfig();
    const modules = (config.modules || []) as Array<Record<string, unknown>>;

    const newModule = {
      moduleKey,
      name,
      baseUrl,
      enabled: enabled !== false,
      pollInterval: pollInterval || 30000,
    };
    modules.push(newModule);
    config.modules = modules;
    writeConfig(config);

    // 添加到内存
    scheduler.addModule(newModule as Parameters<typeof scheduler.addModule>[0]);

    // 注册到数据库
    if (scheduler['repository']) {
      await scheduler['repository'].registerModule({
        moduleKey,
        moduleName: name,
        moduleType: 'collector',
        status: enabled !== false ? 'running' : 'stopped',
      });
    }

    res.status(201).json({ message: '模块添加成功', module: newModule });
  });

  /**
   * PUT /api/modules/:key
   * 更新模块
   */
  router.put('/:key', async (req: Request, res: Response) => {
    const { key } = req.params;

    // admin 自己不允许更新
    if (key === 'admin') {
      res.status(403).json({ error: '禁止更新 admin 模块' });
      return;
    }

    const { name, baseUrl, enabled, pollInterval } = req.body as {
      name?: string;
      baseUrl?: string;
      enabled?: boolean;
      pollInterval?: number;
    };

    const config = readConfig();
    const modules = (config.modules || []) as Array<Record<string, unknown>>;
    const idx = modules.findIndex(m => m.moduleKey === key);

    if (idx === -1) {
      res.status(404).json({ error: '模块不存在', moduleKey: key });
      return;
    }

    const updated = {
      ...(modules[idx] as Record<string, unknown>),
      ...(name !== undefined && { name }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(enabled !== undefined && { enabled }),
      ...(pollInterval !== undefined && { pollInterval }),
    };
    modules[idx] = updated;
    config.modules = modules;
    writeConfig(config);

    // 更新内存
    scheduler.removeModule(key);
    scheduler.addModule(updated as Parameters<typeof scheduler.addModule>[0]);

    res.json({ message: '模块更新成功', module: updated });
  });

  /**
   * DELETE /api/modules/:key
   * 删除模块
   */
  router.delete('/:key', async (req: Request, res: Response) => {
    const { key } = req.params;

    // admin 自己不允许删除
    if (key === 'admin') {
      res.status(403).json({ error: '禁止删除 admin 模块' });
      return;
    }

    const config = readConfig();
    const modules = (config.modules || []) as Array<Record<string, unknown>>;
    const idx = modules.findIndex(m => m.moduleKey === key);

    if (idx === -1) {
      res.status(404).json({ error: '模块不存在', moduleKey: key });
      return;
    }

    modules.splice(idx, 1);
    config.modules = modules;
    writeConfig(config);

    // 从内存移除
    scheduler.removeModule(key);

    // 从数据库删除
    if (scheduler['repository']) {
      await scheduler['repository'].deleteModule(key);
    }

    res.json({ message: '模块删除成功', moduleKey: key });
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

  /**
   * POST /api/modules/test-connection
   * 测试模块连接（统一由 admin 转发，解决跨域问题）
   */
  router.post('/test-connection', async (req: Request, res: Response) => {
    const { baseUrl } = req.body as { baseUrl: string };
    
    if (!baseUrl) {
      res.status(400).json({ error: '缺少模块地址' });
      return;
    }
    
    try {
      // 检测 admin 自身（端口 13000）
      let normalizedUrl = baseUrl.trim();
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'http://' + normalizedUrl;
      }
      const urlObj = new URL(normalizedUrl);
      
      // 如果是 admin 自身（13000），直接返回成功（admin 无需 /api/meta/status）
      if (urlObj.port === '13000' || normalizedUrl.includes('localhost:13000')) {
        res.json({ success: true, moduleKey: 'admin', moduleType: 'admin', status: 'running', version: '1.0.0' });
        return;
      }
      
      // 其他模块正常测试
      let url = normalizedUrl.replace(/\/$/, '') + '/api/meta/status';
      const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      
      if (!response.ok) {
        if (response.status === 404) {
          res.status(404).json({ error: '该地址不支持 /api/meta/status 接口' });
          return;
        }
        res.status(response.status).json({ error: `HTTP ${response.status}` });
        return;
      }
      
      const data = await response.json();
      res.json({ success: true, moduleKey: data.moduleKey, moduleType: data.moduleType, status: data.status, version: data.version });
    } catch (err: any) {
      res.status(500).json({ error: `连接失败: ${err.message}` });
    }
  });

  return router;
}
/**
 * POST /api/modules/test-connection
 * 测试模块连接（统一由 admin 转发，解决跨域问题）
 */
