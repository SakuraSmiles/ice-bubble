import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN = 'http://localhost:13000';
const START_PORT = 14000;
const MAX_PORT = 14010;

// 写入端口文件供前端读取
function writePortFile(port: number) {
  const portFile = join(__dirname, '../../.server-port');
  try {
    writeFileSync(portFile, String(port));
    console.log(`Server port: ${port}`);
  } catch {}
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.url === '/__port') {
    // 返回实际端口
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ port: server.address()?.port }));
    return;
  }

  if (req.url?.startsWith('/api/')) {
    console.log(`>>> ${req.method} ${req.url}`);
    const chunks: string[] = [];
    for await (const chunk of req) {
      chunks.push(chunk.toString());
    }
    const body = Buffer.concat(chunks.map(c => Buffer.from(c)));
    
    const reqUrl = req.url || '/';
    const options = {
      hostname: 'localhost',
      port: 13000,
      path: reqUrl,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    };
    
    const result = await new Promise<{status: number; data: string}>((resolve) => {
      const proxyReq = http.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk.toString(); });
        proxyRes.on('end', () => { 
          resolve({ status: proxyRes.statusCode ?? 500, data }); 
        });
      });
      proxyReq.on('error', (e) => resolve({ status: 500, data: JSON.stringify({ error: e.message }) }));
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
    
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(result.data);
    return;
  }

  const distPath = join(__dirname, '../../dist');
  const reqUrl = req.url || '/';
  const filePath = join(distPath, reqUrl === '/' ? 'index.html' : reqUrl.replace(/^\//, ''));
  
  if (existsSync(filePath)) {
    res.statusCode = 200;
    res.end(readFileSync(filePath));
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

// 尝试启动，端口冲突则尝试下一个
async function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Desktop: ${port}`);
      resolve(port);
    });
    server.on('error', (err: any) => {
      if (port < MAX_PORT) {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        server.close();
        tryListen(port + 1).then(resolve);
      } else {
        console.error('No ports available');
        resolve(null);
      }
    });
  });
}

async function start() {
  const port = await tryListen(START_PORT);
  if (port) {
    writePortFile(port);
  }
}

start();
