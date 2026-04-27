import net from "net";
import { findModuleByPath, getConfig } from "../config.server.js";
function createProxyMiddleware() {
  return async (req, res) => {
    const config = getConfig();
    if (config.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "\u672A\u63D0\u4F9B\u8BA4\u8BC1\u4EE4\u724C", code: "UNAUTHORIZED" });
        return;
      }
      const providedToken = authHeader.slice(7);
      if (providedToken !== config.authToken) {
        res.status(401).json({ error: "\u8BA4\u8BC1\u4EE4\u724C\u65E0\u6548", code: "INVALID_TOKEN" });
        return;
      }
    }
    const originalPath = req.originalUrl || req.url;
    console.log(`[Proxy] ${req.method} ${originalPath}`);
    const targetModule = findModuleByPath(originalPath);
    if (!targetModule) {
      res.status(404).json({ error: "Module not configured" });
      return;
    }
    if (!targetModule.enabled) {
      res.status(503).json({ error: `Module ${targetModule.key} is disabled` });
      return;
    }
    let body = Buffer.alloc(0);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (req.body !== void 0 && req.body !== null) {
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
        res.setHeader("Content-Type", result.contentType);
      }
      if (result.buffer) {
        console.log(`[Proxy] \u8FD4\u56DE\u4E8C\u8FDB\u5236: ${result.buffer.length} bytes`);
        res.setHeader("Content-Length", result.buffer.length);
        res.end(result.buffer);
      } else {
        console.log(`[Proxy] \u8FD4\u56DE\u6587\u672C: ${result.data.length} bytes`);
        res.end(result.data);
      }
    } catch (error) {
      console.error(`[Proxy] \u8F6C\u53D1\u8BF7\u6C42\u5931\u8D25:`, error);
      res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
    }
  };
}
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024;
function forwardRequest(options) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const chunks = [];
    let totalSize = 0;
    const url = new URL(options.targetPath, options.targetUrl);
    const hostname = url.hostname;
    const port = parseInt(url.port || "80", 10);
    const path = url.pathname + url.search;
    console.log(`[Proxy] -> ${options.method} ${hostname}:${port}${path}`);
    const socket = net.connect({
      host: hostname,
      port
    }, () => {
      console.log(`[Proxy] \u{1F50C} TCP\u8FDE\u63A5\u6210\u529F`);
      socket.setTimeout(3e4);
      const reqHeaders = { ...options.headers, "Connection": "close" };
      const headerLines = Object.entries(reqHeaders).filter(([k]) => k.toLowerCase() !== "proxy-connection").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n");
      const httpRequest = `${options.method} ${path} HTTP/1.1\r
Host: ${hostname}:${port}\r
${headerLines}\r
\r
`;
      socket.write(httpRequest);
      if (options.body.length > 0) {
        socket.write(options.body);
      }
    });
    socket.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        socket.destroy();
        reject(new Error("Response too large"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      const duration = Date.now() - startTime;
      const allData = Buffer.concat(chunks);
      console.log(`[Proxy] \u{1F50C} \u8FDE\u63A5\u7ED3\u675F, \u8017\u65F6: ${duration}ms, \u603B\u6570\u636E: ${allData.length} bytes`);
      const headerEndIdx = allData.indexOf("\r\n\r\n");
      if (headerEndIdx === -1) {
        reject(new Error("\u65E0\u6548\u7684 HTTP \u54CD\u5E94"));
        return;
      }
      const headerStr = allData.subarray(0, headerEndIdx).toString("utf8");
      const bodyData = allData.subarray(headerEndIdx + 4);
      const statusLine = headerStr.split("\r\n")[0];
      const statusMatch = statusLine.match(/HTTP\/1\.\d\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;
      let contentType;
      let contentLength;
      const headerLines = headerStr.split("\r\n").slice(1);
      for (const line of headerLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          const key = line.substring(0, colonIdx).trim().toLowerCase();
          const val = line.substring(colonIdx + 1).trim();
          if (key === "content-type") contentType = val;
          if (key === "content-length") contentLength = parseInt(val, 10);
        }
      }
      console.log(`[Proxy] \u{1F4E6} \u54CD\u5E94: status=${statusCode}, type=${contentType}, length=${contentLength || bodyData.length}`);
      const isBinary = !!(contentType && (contentType.startsWith("image/") || contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType.includes("octet-stream")));
      resolve({
        status: statusCode,
        data: isBinary ? "" : bodyData.toString("utf8"),
        buffer: isBinary ? bodyData : void 0,
        contentType,
        isBinary
      });
    });
    socket.on("error", (err) => {
      console.error(`[Proxy] \u274C Socket\u9519\u8BEF: ${err.message}`);
      reject(err);
    });
    socket.on("timeout", () => {
      console.error(`[Proxy] \u23F0 \u8FDE\u63A5\u8D85\u65F6`);
      socket.destroy();
      reject(new Error("Request timeout"));
    });
  });
}
export {
  createProxyMiddleware
};
