import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 14000;

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.url?.startsWith('/api/')) {
    console.log(`>>> ${req.method} ${req.url}`);
    
    const chunks: string[] = [];
    for await (const chunk of req) {
      chunks.push(chunk.toString());
    }
    const body = Buffer.concat(chunks.map(c => Buffer.from(c)));
    console.log(`>>> body: ${body.toString()}`);
    
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
          const status = proxyRes.statusCode;
          resolve({ status: status != null ? status : 500, data }); 
        });
      });
      proxyReq.on('error', (e) => resolve({ status: 500, data: JSON.stringify({ error: e.message }) }));
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
    
    console.log(`<<< ${result.status}`);
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

server.listen(PORT, () => console.log(`Desktop: ${PORT}`));