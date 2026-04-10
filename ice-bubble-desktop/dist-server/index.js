import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 14000;
const ADMIN = 'http://localhost:13000';
const server = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }
    // API proxy
    if (req.url?.startsWith('/api/')) {
        const target = `${ADMIN}${req.url}`;
        console.log(`>>> ${req.method} ${req.url}`);
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        console.log(`>>> body: ${body.toString()}`);
        const options = {
            hostname: 'localhost',
            port: 13000,
            path: req.url,
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length
            }
        };
        const result = await new Promise((resolve) => {
            const proxyReq = http.request(options, (proxyRes) => {
                let data = '';
                proxyRes.on('data', chunk => data += chunk);
                proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, data }));
            });
            proxyReq.on('error', e => resolve({ status: 500, data: JSON.stringify({ error: e.message }) }));
            if (body.length > 0)
                proxyReq.write(body);
            proxyReq.end();
        });
        console.log(`<<< ${result.status}`);
        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(result.data);
        return;
    }
    // Static
    const distPath = join(__dirname, '../../dist');
    const filePath = join(distPath, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
    if (existsSync(filePath)) {
        res.statusCode = 200;
        res.end(readFileSync(filePath));
    }
    else {
        res.statusCode = 404;
        res.end('Not found');
    }
});
server.listen(PORT, () => console.log(`Topdesk: ${PORT}`));
