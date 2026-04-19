/**
 * 动态代理中间件
 * 白名单机制：只允许转发到 modules.json 中配置的模块地址
 * 使用 net.Socket 直接连接，绕过系统代理
 */

import net from 'net';
import { Request, Response } from 'express';
import { findModuleByPath } from '../config.server.js';

export function createProxyMiddleware() {
  return async (req: Request, res: Response) => {
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

    const targetUrl = targetModule.url;
    const targetPath = originalPath;

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

      res.status(result.status);
      
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
      }
      
      if (result.buffer) {
        console.log(`[Proxy] 返回二进制: ${result.buffer.length} bytes`);
        res.setHeader('Content-Length', result.buffer.length);
        res.end(result.buffer);
      } else {
        console.log(`[Proxy] 返回文本: ${result.data.length} bytes`);
        res.end(result.data);
      }
    } catch (error) {
      console.error(`[Proxy] 转发请求失败:`, error);
      res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
    }
  };
}

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

/**
 * 简单的代理实现：
 * 1. 用 net.Socket 发送 HTTP 请求（带 Connection: close）
 * 2. 收集所有响应数据
 * 3. 服务器关闭连接后返回完整响应
 */
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB

function forwardRequest(options: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    
    const url = new URL(options.targetPath, options.targetUrl);
    const hostname = url.hostname;
    const port = parseInt(url.port || '80', 10);
    const path = url.pathname + url.search;

    console.log(`[Proxy] -> ${options.method} ${hostname}:${port}${path}`);

    const socket = net.connect({
      host: hostname,
      port: port
    }, () => {
      console.log(`[Proxy] 🔌 TCP连接成功`);
      // 30秒超时，防止 target 无响应时永久挂起
      socket.setTimeout(30000);
      
      // 构建请求头，强制关闭连接
      const reqHeaders = { ...options.headers, 'Connection': 'close' };
      const headerLines = Object.entries(reqHeaders)
        .filter(([k]) => k.toLowerCase() !== 'proxy-connection')
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      
      const httpRequest = `${options.method} ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${headerLines}\r\n\r\n`;
      socket.write(httpRequest);
      
      if (options.body.length > 0) {
        socket.write(options.body);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        socket.destroy();
        reject(new Error('Response too large'));
        return;
      }
      chunks.push(chunk);
    });

    socket.on('end', () => {
      const duration = Date.now() - startTime;
      const allData = Buffer.concat(chunks);
      console.log(`[Proxy] 🔌 连接结束, 耗时: ${duration}ms, 总数据: ${allData.length} bytes`);
      
      // 解析 HTTP 响应
      const headerEndIdx = allData.indexOf('\r\n\r\n');
      if (headerEndIdx === -1) {
        reject(new Error('无效的 HTTP 响应'));
        return;
      }
      
      const headerStr = allData.subarray(0, headerEndIdx).toString('utf8');
      const bodyData = allData.subarray(headerEndIdx + 4);
      
      // 解析状态行
      const statusLine = headerStr.split('\r\n')[0];
      const statusMatch = statusLine.match(/HTTP\/1\.\d\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;
      
      // 解析响应头
      let contentType: string | undefined;
      let contentLength: number | undefined;
      
      const headerLines = headerStr.split('\r\n').slice(1);
      for (const line of headerLines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.substring(0, colonIdx).trim().toLowerCase();
          const val = line.substring(colonIdx + 1).trim();
          if (key === 'content-type') contentType = val;
          if (key === 'content-length') contentLength = parseInt(val, 10);
        }
      }
      
      console.log(`[Proxy] 📦 响应: status=${statusCode}, type=${contentType}, length=${contentLength || bodyData.length}`);
      
      // 判断是否是二进制
      const isBinary = !!(contentType && (
        contentType.startsWith('image/') ||
        contentType.startsWith('audio/') ||
        contentType.startsWith('video/') ||
        contentType.includes('octet-stream')
      ));
      
      resolve({
        status: statusCode,
        data: isBinary ? '' : bodyData.toString('utf8'),
        buffer: isBinary ? bodyData : undefined,
        contentType,
        isBinary
      });
    });

    socket.on('error', (err) => {
      console.error(`[Proxy] ❌ Socket错误: ${err.message}`);
      reject(err);
    });

    socket.on('timeout', () => {
      console.error(`[Proxy] ⏰ 连接超时`);
      socket.destroy();
      reject(new Error('Request timeout'));
    });
  });
}
