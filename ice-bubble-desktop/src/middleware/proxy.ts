/**
 * 动态代理中间件
 * 白名单机制：只允许转发到 modules.json 中配置的模块地址
 */

import http from 'http';
import { Request, Response } from 'express';
import { findModuleByPath } from '../config/index.js';

/**
 * 创建代理中间件
 */
export function createProxyMiddleware() {
  return async (req: Request, res: Response) => {
    const originalPath = req.originalUrl || req.url;
    
    console.log(`[Proxy] ${req.method} ${originalPath}`);

    // 1. 查找目标模块
    const targetModule = findModuleByPath(originalPath);
    
    if (!targetModule) {
      console.log(`[Proxy] 模块未配置: ${originalPath}`);
      res.status(404).json({ error: 'Module not configured' });
      return;
    }

    // 2. 检查模块是否启用
    if (!targetModule.enabled) {
      console.log(`[Proxy] 模块已禁用: ${targetModule.key}`);
      res.status(503).json({ error: `Module ${targetModule.key} is disabled` });
      return;
    }

    // 3. 收集请求体
    let body: Buffer = Buffer.alloc(0);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
    } catch (error) {
      console.error('[Proxy] 读取请求体失败:', error);
      res.status(500).json({ error: 'Proxy error' });
      return;
    }

    // 4. 构建目标 URL（路径透传）
    const targetUrl = targetModule.url;
    const targetPath = originalPath;

    // 5. 发起代理请求
    try {
      const result = await forwardRequest({
        method: req.method,
        targetUrl,
        targetPath,
        headers: {
          ...req.headers,
          host: new URL(targetUrl).host
        },
        body
      });

      // 6. 返回响应
      res.status(result.status);
      
      // 设置内容类型
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
      }
      
      // 对于二进制数据（如图片），使用 Buffer
      if (result.isBinary && result.buffer) {
        res.setHeader('Content-Length', result.buffer.length);
        res.end(result.buffer);
      } else {
        // 对于文本数据，使用字符串
        res.end(result.data);
      }
    } catch (error) {
      console.error(`[Proxy] 转发请求失败:`, error);
      res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
    }
  };
}

/**
 * 转发请求到目标服务
 */
interface ForwardOptions {
  method: string;
  targetUrl: string;
  targetPath: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface ForwardResult {
  status: number;
  data: string;
  buffer?: Buffer;
  contentType?: string;
  isBinary: boolean;
}

function forwardRequest(options: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.targetPath, options.targetUrl);
    
    const proxyOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method,
      headers: options.headers
    };

    console.log(`[Proxy] -> ${options.method} ${url.href}`);

    const proxyReq = http.request(proxyOptions, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] as string;
      const isBinary = contentType && (
        contentType.startsWith('image/') ||
        contentType.startsWith('audio/') ||
        contentType.startsWith('video/') ||
        contentType === 'application/octet-stream'
      );

      if (isBinary) {
        // 二进制数据处理
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        proxyRes.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: proxyRes.statusCode || 500,
            data: '',
            buffer,
            contentType,
            isBinary: true
          });
        });
      } else {
        // 文本数据处理
        let data = '';
        proxyRes.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        proxyRes.on('end', () => {
          resolve({
            status: proxyRes.statusCode || 500,
            data,
            contentType,
            isBinary: false
          });
        });
      }
    });

    proxyReq.on('error', (error) => {
      console.error(`[Proxy] 请求错误:`, error.message);
      reject(error);
    });

    proxyReq.on('timeout', () => {
      console.error(`[Proxy] 请求超时`);
      proxyReq.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body.length > 0) {
      proxyReq.write(options.body);
    }

    proxyReq.end();
  });
}
