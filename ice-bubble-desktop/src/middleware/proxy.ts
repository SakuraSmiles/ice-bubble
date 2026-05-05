/**
 * 动态代理中间件
 * 白名单机制：只允许转发到 modules.json 中配置的模块地址
 * 使用 http/https 原生模块，支持 HTTPS 和 SSE 流式转发
 */

import http from 'http';
import https from 'https';
import { Request, Response } from 'express';
import { findModuleByPath, getConfig } from '../config.server.js';

export function createProxyMiddleware() {
  return async (req: Request, res: Response) => {
    // Token 鉴权
    const config = getConfig();
    if (config.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: '未提供认证令牌', code: 'UNAUTHORIZED' });
        return;
      }
      const providedToken = authHeader.slice(7);
      if (providedToken !== config.authToken) {
        res.status(401).json({ error: '认证令牌无效', code: 'INVALID_TOKEN' });
        return;
      }
    }

    const originalPath = req.originalUrl || req.url;
    console.log(`[Proxy] ${req.method} ${originalPath}`);

    const targetModule = findModuleByPath(originalPath);

    if (!targetModule) {
      res.status(404).json({ error: 'Module not configured' });
      return;
    }

    if (!targetModule.enabled) {
      res.status(503).json({ error: `Module ${targetModule.key} is disabled` });
      return;
    }

    let body: Buffer = Buffer.alloc(0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (req.body !== undefined && req.body !== null) {
        body = Buffer.from(JSON.stringify(req.body));
      }
    }

    const targetUrl = new URL(originalPath, targetModule.url);

    try {
      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      // 构建转发 headers，过滤 hop-by-hop 头
      const forwardHeaders: Record<string, string | string[] | undefined> = {};
      const hopByHop = new Set([
        'connection', 'keep-alive', 'transfer-encoding',
        'te', 'trailer', 'upgrade', 'proxy-connection',
      ]);
      for (const [key, value] of Object.entries(req.headers)) {
        if (!hopByHop.has(key.toLowerCase())) {
          forwardHeaders[key] = value;
        }
      }
      forwardHeaders['host'] = targetUrl.host;

      // If modules.json has authToken configured and the incoming request
      // didn't already provide an Authorization header, inject our token.
      if (config.authToken && !forwardHeaders['authorization'] && !forwardHeaders['Authorization']) {
        forwardHeaders['Authorization'] = `Bearer ${config.authToken}`;
      }

      const requestOptions: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: forwardHeaders,
      };

      // 30 秒超时
      const proxyReq = transport.request(requestOptions, (proxyRes) => {
        // 转发状态码和 headers
        res.status(proxyRes.statusCode || 200);

        const resHeaders = proxyRes.headers;
        for (const [key, value] of Object.entries(resHeaders)) {
          if (value != null && !hopByHop.has(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }

        // 流式转发 body（支持 SSE 长连接）
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error(`[Proxy] ❌ 请求失败: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
        }
      });

      proxyReq.setTimeout(30000, () => {
        console.error(`[Proxy] ⏰ 请求超时`);
        proxyReq.destroy(new Error('Request timeout'));
      });

      // 发送请求体
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    } catch (error) {
      console.error(`[Proxy] 转发请求失败:`, error);
      if (!res.headersSent) {
        res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
      }
    }
  };
}
