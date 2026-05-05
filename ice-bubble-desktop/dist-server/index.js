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
let currentServer = null;
async function tryListen(port) {
  return new Promise((resolve) => {
    const newServer = createServer(app);
    currentServer = newServer;
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
