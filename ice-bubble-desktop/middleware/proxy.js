import http from "http";
import https from "https";
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
    const targetUrl = new URL(originalPath, targetModule.url);
    try {
      const isHttps = targetUrl.protocol === "https:";
      const transport = isHttps ? https : http;
      const forwardHeaders = {};
      const hopByHop = /* @__PURE__ */ new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-connection"
      ]);
      for (const [key, value] of Object.entries(req.headers)) {
        if (!hopByHop.has(key.toLowerCase())) {
          forwardHeaders[key] = value;
        }
      }
      forwardHeaders["host"] = targetUrl.host;
      const hasAuth = Object.keys(forwardHeaders).some((k) => k.toLowerCase() === "authorization");
      if (config.authToken && !hasAuth) {
        forwardHeaders["Authorization"] = `Bearer ${config.authToken}`;
      }
      const requestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: forwardHeaders
      };
      const proxyReq = transport.request(requestOptions, (proxyRes) => {
        res.status(proxyRes.statusCode || 200);
        const resHeaders = proxyRes.headers;
        for (const [key, value] of Object.entries(resHeaders)) {
          if (value != null && !hopByHop.has(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }
        proxyRes.pipe(res);
      });
      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
        }
      });
      proxyReq.setTimeout(3e4, () => {
        proxyReq.destroy(new Error("Request timeout"));
      });
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    } catch (error) {
      if (!res.headersSent) {
        res.status(502).json({ error: `Failed to reach ${targetModule.key}` });
      }
    }
  };
}
export {
  createProxyMiddleware
};
