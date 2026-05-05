import { createServer } from "http";
import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { enableHotReload, disableHotReload, reloadConfig, findModuleByKey, getConfig } from "../config.server.js";
import { createProxyMiddleware } from "../middleware/proxy.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const START_PORT = 14e3;
const MAX_PORT = 14010;
function writePortFile(port) {
  const portFile = join(__dirname, "../../.server-port");
  try {
    writeFileSync(portFile, String(port));
  } catch {
  }
}
const app = express();
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
const isDev = process.env.NODE_ENV !== "production";
if (isDev) {
  enableHotReload();
}
app.use("/api", createProxyMiddleware());
app.use(express.static(join(__dirname, "../dist")));
app.get("/{*path}", (_req, res) => {
  const indexPath = join(__dirname, "../dist/index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Not found");
  }
});
function setupWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);
    if (pathname !== "/ws") {
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
    const targetWs = new WebSocket(`${isSecure ? "wss" : "ws"}://${adminUrl.host}${adminUrl.pathname}${adminUrl.search}`, {
      rejectUnauthorized: false
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
let currentServer = null;
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
