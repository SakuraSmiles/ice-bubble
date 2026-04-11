"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_http = require("http");
var import_fs = require("fs");
var import_path = require("path");
var import_url = require("url");
var import_http2 = __toESM(require("http"), 1);
const import_meta = {};
const __dirname = (0, import_path.dirname)((0, import_url.fileURLToPath)(import_meta.url));
const START_PORT = 14e3;
const MAX_PORT = 14010;
function writePortFile(port) {
  const portFile = (0, import_path.join)(__dirname, "../../.server-port");
  try {
    (0, import_fs.writeFileSync)(portFile, String(port));
    console.log(`Server port: ${port}`);
  } catch {
  }
}
const server = (0, import_http.createServer)(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }
  if (req.url === "/__port") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ port: server.address()?.port ?? 14e3 }));
    return;
  }
  if (req.url?.startsWith("/api/")) {
    console.log(`>>> ${req.method} ${req.url}`);
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk.toString());
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const reqUrl2 = req.url || "/";
    const options = {
      hostname: "localhost",
      port: 13e3,
      path: reqUrl2,
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length
      }
    };
    const result = await new Promise((resolve) => {
      const proxyReq = import_http2.default.request(options, (proxyRes) => {
        let data = "";
        proxyRes.on("data", (chunk) => {
          data += chunk.toString();
        });
        proxyRes.on("end", () => {
          resolve({ status: proxyRes.statusCode ?? 500, data });
        });
      });
      proxyReq.on("error", (e) => resolve({ status: 500, data: JSON.stringify({ error: e.message }) }));
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json");
    res.end(result.data);
    return;
  }
  const distPath = (0, import_path.join)(__dirname, "../../dist");
  const reqUrl = req.url || "/";
  const filePath = (0, import_path.join)(distPath, reqUrl === "/" ? "index.html" : reqUrl.replace(/^\//, ""));
  if ((0, import_fs.existsSync)(filePath)) {
    res.statusCode = 200;
    res.end((0, import_fs.readFileSync)(filePath));
  } else {
    res.statusCode = 404;
    res.end("Not found");
  }
});
async function tryListen(port) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Desktop: ${port}`);
      resolve(port);
    });
    server.on("error", () => {
      if (port < MAX_PORT) {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        server.close();
        tryListen(port + 1).then(resolve);
      } else {
        console.error("No ports available");
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
