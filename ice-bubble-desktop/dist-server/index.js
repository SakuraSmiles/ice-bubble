import { createServer } from "http";
import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { enableHotReload, disableHotReload, reloadConfig } from "../config.server.js";
import { createProxyMiddleware } from "../middleware/proxy.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const START_PORT = 14e3;
const MAX_PORT = 14010;
function writePortFile(port) {
  const portFile = join(__dirname, "../../.server-port");
  try {
    writeFileSync(portFile, String(port));
    console.log(`[Server] \u7AEF\u53E3: ${port}`);
  } catch {
  }
}
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
app.use(express.static(join(__dirname, "../../dist")));
app.get("/{*path}", (_req, res) => {
  const indexPath = join(__dirname, "../../dist/index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Not found");
  }
});
let currentServer = null;
async function tryListen(port) {
  return new Promise((resolve) => {
    const newServer = createServer(app);
    currentServer = newServer;
    newServer.listen(port, () => {
      console.log(`[Server] Desktop \u542F\u52A8: http://localhost:${port}`);
      resolve(port);
    });
    newServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        newServer.close(() => {
          if (port < MAX_PORT) {
            console.log(`[Server] \u7AEF\u53E3 ${port} \u5DF2\u88AB\u5360\u7528\uFF0C\u5C1D\u8BD5 ${port + 1}...`);
            tryListen(port + 1).then(resolve);
          } else {
            console.error("[Server] \u6CA1\u6709\u53EF\u7528\u7684\u7AEF\u53E3 (14000-14010 \u5747\u88AB\u5360\u7528)");
            console.error("[Server] \u8BF7\u5173\u95ED\u5360\u7528\u8FD9\u4E9B\u7AEF\u53E3\u7684\u8FDB\u7A0B\u540E\u91CD\u8BD5");
            process.exit(1);
          }
        });
      } else {
        console.error("[Server] \u542F\u52A8\u9519\u8BEF:", err);
        resolve(null);
      }
    });
  });
}
function gracefulShutdown() {
  console.log("[Server] \u6B63\u5728\u5173\u95ED...");
  disableHotReload();
  if (currentServer) {
    currentServer.close(() => {
      console.log("[Server] \u5DF2\u5173\u95ED");
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
async function start() {
  console.log("[Server] \u542F\u52A8\u4E2D...");
  console.log("[Config] \u5F53\u524D\u914D\u7F6E:", JSON.stringify(reloadConfig(), null, 2));
  const port = await tryListen(START_PORT);
  if (port) {
    writePortFile(port);
    console.log("[Server] \u51C6\u5907\u5C31\u7EEA");
  }
}
start();
export {
  app
};
