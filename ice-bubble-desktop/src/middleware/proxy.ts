/**
 * 动态代理中间件
 * 白名单机制：只允许转发到 modules.json 中配置的模块地址
 * 使用 net.Socket 直接连接，绕过系统代理
 */

import net from 'net';
import { Request, Response } from 'express';
import { findModuleByPath } from '../config.server.js';

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

    // 3. 获取请求体
    let body: Buffer = Buffer.alloc(0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (req.body !== undefined && req.body !== null) {
        // req.body is a parsed object from express.json()
        body = Buffer.from(JSON.stringify(req.body));
      }
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

/**
 * 使用 net.Socket 直接发起 HTTP 请求（绕过系统代理）
 */
function forwardRequest(options: ForwardOptions): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.targetPath, options.targetUrl);
    const hostname = url.hostname;
    const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
    const path = url.pathname + url.search;

    console.log(`[Proxy] -> ${options.method} ${hostname}:${port}${path}`);
    const startTs = Date.now();

    console.log(`[Proxy] 开始连接 ${hostname}:${port}...`);
    const socket = net.createConnection({
      host: hostname,
      port: port,
      timeout: 10000
    });

    // 构建 HTTP 请求头
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined && key.toLowerCase() !== 'proxy-connection' && key.toLowerCase() !== 'connection') {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');

    const httpRequest = `${options.method} ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${headerLines}\r\n\r\n`;

    let responseData = '';
    let responseBuffer: Buffer | undefined;
    let headersParsed = false;
    let statusCode = 500;
    let contentType: string | undefined;

    socket.on('connect', () => {
      console.log(`[Proxy] Socket连接成功，耗时: ${Date.now() - startTs}ms`);
      if (options.body.length > 0) {
        socket.write(httpRequest, () => {
          socket.write(options.body);
        });
      } else {
        socket.write(httpRequest);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      if (!headersParsed) {
        // 查找 header 和 body 之间的空行
        const str = chunk.toString('utf8');
        const headerEndIdx = str.indexOf('\r\n\r\n');
        if (headerEndIdx !== -1) {
          headersParsed = true;
          const headerSection = str.substring(0, headerEndIdx);
          const bodyStart = headerEndIdx + 4;
          
          // 解析状态行
          const statusLine = headerSection.split('\r\n')[0];
          const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
          if (match) {
            statusCode = parseInt(match[1], 10);
          }
          
          // 解析响应头
          const headerPairs = headerSection.split('\r\n').slice(1);
          for (const pair of headerPairs) {
            const colonIdx = pair.indexOf(':');
            if (colonIdx !== -1) {
              const key = pair.substring(0, colonIdx).trim().toLowerCase();
              const value = pair.substring(colonIdx + 1).trim();
              if (key === 'content-type') contentType = value;
            }
          }
          
          // 如果还有剩余数据，那就是 body
          if (chunk.length > bodyStart) {
            if (contentType && (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
              responseBuffer = chunk.subarray(bodyStart);
            } else {
              responseData += chunk.toString('utf8', bodyStart);
            }
          }
        } else {
          // 还没收到完整的 headers，继续累积
          responseData += str;
        }
      } else {
        // headers 已解析，后续数据都是 body
        if (contentType && (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
          if (responseBuffer) {
            responseBuffer = Buffer.concat([responseBuffer, chunk]);
          } else {
            responseBuffer = chunk;
          }
        } else {
          responseData += chunk.toString('utf8');
        }
      }
    });

    socket.on('end', () => {
      socket.destroy();  // 确保socket关闭
      resolve({
        status: statusCode,
        data: responseData || '',
        buffer: responseBuffer,
        contentType,
        isBinary: !!responseBuffer
      });
    });

    socket.on('error', (err) => {
      console.error(`[Proxy] 连接错误: ${err.message}`);
      reject(new Error(`连接错误: ${err.message}`));
    });

    socket.on('timeout', () => {
      console.error(`[Proxy] 连接超时`);
      socket.destroy();
      reject(new Error('Request timeout'));
    });


  });
}
