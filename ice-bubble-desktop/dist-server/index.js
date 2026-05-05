// src/server/index.ts
import { createServer } from "http";
import { writeFileSync, existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2, dirname } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

// src/config.server.ts
import { readFileSync, existsSync, watchFile, unwatchFile } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
function getProjectRoot() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname2 = join(__filename, "..");
  if (typeof process !== "undefined" && process.env.ICE_RESOURCE_DIR) {
    const envDir = process.env.ICE_RESOURCE_DIR;
    if (existsSync(join(envDir, "modules.json"))) {
      return envDir;
    }
  }
  const tauriConfigDir = join(__dirname2, "..", "config");
  if (existsSync(join(tauriConfigDir, "modules.json"))) {
    return tauriConfigDir;
  }
  const localConfigDir = join(__dirname2, "config");
  if (existsSync(join(localConfigDir, "modules.json"))) {
    return localConfigDir;
  }
  if (typeof process !== "undefined" && process.cwd) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, "config", "modules.json"))) {
      return join(cwd, "config");
    }
  }
  const fallback = join(__dirname2, "..", "..", "config");
  if (existsSync(join(fallback, "modules.json"))) {
    return fallback;
  }
  return join(process.cwd(), "config");
}
var DEFAULT_CONFIG = {
  modules: [
    {
      key: "admin",
      name: "Admin \u7BA1\u7406\u540E\u53F0",
      url: "http://localhost:13000",
      enabled: true
    }
  ]
};
function getConfigPath() {
  return join(getProjectRoot(), "modules.json");
}
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    if (!config.modules || !Array.isArray(config.modules)) {
      return DEFAULT_CONFIG;
    }
    return config;
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}
var currentConfig = loadConfig();
var watchEnabled = false;
function getConfig() {
  return currentConfig;
}
function reloadConfig() {
  currentConfig = loadConfig();
  return currentConfig;
}
function enableHotReload() {
  if (watchEnabled) return;
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return;
  }
  watchFile(configPath, { interval: 1e3 }, () => {
    reloadConfig();
  });
  watchEnabled = true;
}
function disableHotReload() {
  if (!watchEnabled) return;
  const configPath = getConfigPath();
  try {
    unwatchFile(configPath);
    watchEnabled = false;
  } catch {
  }
}
function findModuleByPath(path) {
  const config = getConfig();
  if (path.startsWith("/api/")) {
    const adminModule = config.modules.find((m) => m.key === "admin");
    return adminModule || null;
  }
  return null;
}
function findModuleByKey(key) {
  const config = getConfig();
  return config.modules.find((m) => m.key === key) || null;
}

// src/middleware/proxy.ts
import http from "http";
import https from "https";
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

// src/server/index.ts
var __dirname = dirname(fileURLToPath2(import.meta.url));
var distDir = process.env.ICE_DIST_DIR ? join2(process.env.ICE_DIST_DIR) : join2(__dirname, "..", "dist");
var START_PORT = 14e3;
var MAX_PORT = 14010;
function getPortFilePath() {
  const cwd = process.cwd();
  const cwdPort = join2(cwd, "server", ".server-port");
  try {
    const dir = dirname(cwdPort);
    if (existsSync2(dir)) return cwdPort;
  } catch {
  }
  return join2(__dirname, ".server-port");
}
function writePortFile(port) {
  const portFile = getPortFilePath();
  try {
    writeFileSync(portFile, String(port));
  } catch {
  }
}
var app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
app.use((req, res, next) => {
  const isDev2 = process.env.NODE_ENV !== "production";
  const config = reloadConfig();
  let allowedOrigins;
  if (isDev2) {
    allowedOrigins = ["http://localhost:1420", "http://localhost:14000"];
  } else if (config.cors?.origins && config.cors.origins.length > 0) {
    allowedOrigins = config.cors.origins;
  } else {
    allowedOrigins = ["*"];
  }
  const origin = req.header("origin");
  if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.options("/{*path}", (_req, res) => {
  res.status(200).end();
});
app.get("/__port", (_req, res) => {
  res.json({ port: currentServer?.address()?.port ?? START_PORT });
});
var isDev = process.env.NODE_ENV !== "production";
if (isDev) {
  enableHotReload();
}
app.get("/api/desktop/config", (_req, res) => {
  try {
    const config = getConfig();
    res.json({
      configured: !!config.authToken,
      adminUrl: config.modules.find((m) => m.key === "admin")?.url || ""
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/desktop/config", async (req, res) => {
  const { url, token } = req.body || {};
  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  try {
    const testUrl = new URL("/api/stats", url);
    const isHttps = testUrl.protocol === "https:";
    const transport = isHttps ? await import("https") : await import("http");
    await new Promise((resolve, reject) => {
      const req2 = transport.request(testUrl, { timeout: 5e3 }, (proxyRes) => {
        let data = "";
        proxyRes.on("data", (chunk) => data += chunk);
        proxyRes.on("end", () => {
          if (proxyRes.statusCode && proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
            resolve();
          } else {
            reject(new Error(`HTTP ${proxyRes.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req2.on("error", reject);
      req2.on("timeout", () => {
        req2.destroy();
        reject(new Error("Connection timeout"));
      });
      req2.end();
    });
  } catch (e) {
    res.status(502).json({ error: `Connection failed: ${e.message}` });
    return;
  }
  try {
    const configPath = getConfigPath();
    let config = { modules: [{ key: "admin", name: "Admin \u7BA1\u7406\u540E\u53F0", url, enabled: true }] };
    if (existsSync2(configPath)) {
      const raw = readFileSync2(configPath, "utf-8");
      config = JSON.parse(raw);
      const admin = config.modules?.find((m) => m.key === "admin");
      if (admin) admin.url = url;
    }
    if (token) config.authToken = token;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    res.json({ success: true, url });
  } catch (e) {
    res.status(500).json({ error: `Save failed: ${e.message}` });
  }
});
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/desktop/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});
app.use("/api", createProxyMiddleware());
app.use(express.static(distDir));
app.get("/{*path}", (_req, res) => {
  const indexPath = join2(distDir, "index.html");
  if (existsSync2(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Not found");
  }
});
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const { hostname } = originUrl;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return true;
    }
    if (host) {
      const originHost = originUrl.host;
      if (originHost === host) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
function setupWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const config = getConfig();
    if (config.authToken) {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (!token || token !== config.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const adminModule = findModuleByKey("admin");
    if (!adminModule || !adminModule.enabled) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const adminUrl = new URL("/ws", adminModule.url);
    const isSecure = adminUrl.protocol === "wss:";
    const rejectUnauthorized = config.rejectUnauthorized ?? true;
    const targetWs = new WebSocket(`${isSecure ? "wss" : "ws"}://${adminUrl.host}${adminUrl.pathname}${adminUrl.search}`, {
      rejectUnauthorized
    });
    targetWs.on("open", () => {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        clientWs.on("message", (data, isBinary) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(data, { binary: isBinary });
          }
        });
        targetWs.on("message", (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });
        clientWs.on("close", (code, reason) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.close(code, reason);
          }
        });
        targetWs.on("close", (code, reason) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
          }
        });
        clientWs.on("error", (err) => {
          targetWs.terminate();
        });
        targetWs.on("error", (err) => {
          clientWs.terminate();
        });
      });
    });
    targetWs.on("error", (err) => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
  });
}
var currentServer = null;
async function tryListen(port) {
  return new Promise((resolve) => {
    const newServer = createServer(app);
    currentServer = newServer;
    setupWebSocketProxy(newServer);
    newServer.listen(port, () => {
      resolve(port);
    });
    newServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        newServer.close(() => {
          if (port < MAX_PORT) {
            tryListen(port + 1).then(resolve);
          } else {
            process.exit(1);
          }
        });
      } else {
        resolve(null);
      }
    });
  });
}
function gracefulShutdown() {
  disableHotReload();
  if (currentServer) {
    currentServer.close(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
async function start() {
  const port = await tryListen(START_PORT);
  if (port) {
    writePortFile(port);
  }
}
start();
export {
  app
};
