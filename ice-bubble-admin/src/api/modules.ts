/**
 * Modules API - 模块管理 REST 接口
 * 
 * @module modules
 */

import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ModuleScheduler } from '../modules/module-scheduler.js';

// config.json 路径（使用 process.cwd() 获取项目根目录）
function getConfigPath(): string {
  return join(process.cwd(), 'config', 'config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 构建完整的模块响应对象（静态配置 + 动态状态）
 */
interface ModuleStatus {
  state: 'running' | 'stopped' | 'error';
  lastPollTime: string | null;
  lastError: string | null;
  latencyMs?: number | null;
  runtime: {
    startTime: string | null;
    uptimeSeconds?: number;
    messagesCollected?: number;
    errorsCount?: number;
  } | null;
}

interface ModuleResponse {
  moduleKey: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pollInterval: number;
  registeredTime: string;
  version: string;
  status: ModuleStatus;
}

function buildModuleResponse(
  m: { moduleKey: string; name: string; baseUrl: string; enabled: boolean; pollInterval?: number; registeredTime?: string },
  version: string | null,
  status: ModuleStatus | null
): ModuleResponse {
  return {
    moduleKey: m.moduleKey,
    name: m.name,
    baseUrl: m.baseUrl,
    enabled: m.enabled,
    pollInterval: m.pollInterval ?? 0,
    registeredTime: m.registeredTime ?? '',
    version: version || '-',
    status: status || {
      state: 'running',
      lastPollTime: null,
      lastError: null,
      runtime: { startTime: null },
    },
  };
}

export function createModulesRouter(scheduler: ModuleScheduler): Router {
  const router = Router();

  /**
   * GET /api/modules
   * 获取所有模块列表（完整对象）
   */
  router.get('/', async (_req: Request, res: Response) => {
    const modules = scheduler.getModules();
    
    const moduleList = await Promise.all(
      modules.map(async (m) => {
        // 获取版本
        const version = (m as any).version || null;
        
        // 获取状态
        let status: ModuleStatus | null = null;
        
        if (m.moduleKey === 'admin') {
          const adminStatus = scheduler.getAdminStatus();
          status = {
            state: 'running',
            lastPollTime: adminStatus.runtime?.startTime || null,
            lastError: null,
            runtime: { startTime: adminStatus.runtime?.startTime || null },
          };
        } else {
          const dbStatus = await scheduler.getStatusFromDatabase(m.moduleKey);
          if (dbStatus) {
            status = {
              state: dbStatus.status,
              lastPollTime: dbStatus.lastPollTime || null,
              lastError: dbStatus.lastError || null,
            latencyMs: dbStatus.latencyMs || null,
              runtime: dbStatus.runtime ? {
                startTime: dbStatus.runtime.startTime,
                uptimeSeconds: dbStatus.runtime.uptimeSeconds,
                messagesCollected: dbStatus.runtime.messagesCollected,
                errorsCount: dbStatus.runtime.errorsCount,
              } : null,
            };
          }
        }
        
        return buildModuleResponse(m, version, status);
      })
    );
    
    res.json({ count: moduleList.length, modules: moduleList });
  });

  /**
   * GET /api/modules/:key
   * 获取单个模块详情（完整对象）
   */
  router.get('/:key', async (req: Request, res: Response) => {
    const { key } = req.params;
    const module = scheduler.getModule(key);

    if (!module) {
      res.status(404).json({ error: '模块不存在', moduleKey: key });
      return;
    }

    let version: string | null = null;
    let status: ModuleStatus | null = null;

    if (key === 'admin') {
      // admin 自检
      version = '1.0.0';
      const adminStatus = scheduler.getAdminStatus();
      status = {
        state: 'running',
        lastPollTime: adminStatus.runtime?.startTime || null,
        lastError: null,
        runtime: { startTime: adminStatus.runtime?.startTime || null },
      };
    } else {
      // 从数据库获取状态
      let dbStatus = await scheduler.getStatusFromDatabase(key);
      if (!dbStatus) {
        await scheduler.pollModuleNow(key);
        dbStatus = await scheduler.getStatusFromDatabase(key);
      }
      
      version = dbStatus?.version || null;
      if (dbStatus) {
        status = {
          state: dbStatus.status,
          lastPollTime: dbStatus.lastPollTime || null,
          lastError: dbStatus.lastError || null,
            latencyMs: dbStatus.latencyMs || null,
          runtime: dbStatus.runtime ? {
            startTime: dbStatus.runtime.startTime,
            uptimeSeconds: dbStatus.runtime.uptimeSeconds,
            messagesCollected: dbStatus.runtime.messagesCollected,
            errorsCount: dbStatus.runtime.errorsCount,
          } : null,
        };
      }
    }

    res.json(buildModuleResponse(module, version, status));
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

    const existing = scheduler.getModule(moduleKey);
    if (existing) {
      res.status(409).json({ error: '模块已存在', moduleKey });
      return;
    }

    const config = readConfig();
    const modules = (config.modules || []) as Array<Record<string, unknown>>;

    const now = new Date().toISOString();
    const newModule = {
      moduleKey,
      name,
      baseUrl,
      enabled: enabled !== false,
      pollInterval: pollInterval || 30000,
      registeredTime: now,
    };
    modules.push(newModule);
    config.modules = modules;
    writeConfig(config);

    scheduler.addModule(newModule as Parameters<typeof scheduler.addModule>[0]);

    await scheduler.registerModule({
      moduleKey,
      moduleName: name,
      moduleType: 'collector',
      status: enabled !== false ? 'running' : 'stopped',
    });

    res.status(201).json({ message: '模块添加成功', module: newModule });
  });

  /**
   * PUT /api/modules/:key
   * 更新模块
   */
  router.put('/:key', async (req: Request, res: Response) => {
    const { key } = req.params;

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

    const existingRegisteredTime = (modules[idx] as any).registeredTime;
    
    const updated = {
      ...(modules[idx] as Record<string, unknown>),
      ...(name !== undefined && { name }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(enabled !== undefined && { enabled }),
      ...(pollInterval !== undefined && { pollInterval }),
      registeredTime: existingRegisteredTime || new Date().toISOString(),
    };
    modules[idx] = updated;
    config.modules = modules;
    writeConfig(config);

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

    scheduler.removeModule(key);

    await scheduler.deleteModule(key);

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
      let normalizedUrl = baseUrl.trim();
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'http://' + normalizedUrl;
      }
      const urlObj = new URL(normalizedUrl);
      
      if (urlObj.port === '13000' || normalizedUrl.includes('localhost:13000')) {
        res.json({ success: true, moduleKey: 'admin', moduleType: 'admin', status: 'running', version: '1.0.0' });
        return;
      }
      
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
      
      const data = await response.json() as { moduleKey: string; moduleType: string; status: string; version: string };
      res.json({ success: true, moduleKey: data.moduleKey, moduleType: data.moduleType, status: data.status, version: data.version });
    } catch (err: any) {
      res.status(500).json({ error: `连接失败: ${err.message}` });
    }
  });

  return router;
}