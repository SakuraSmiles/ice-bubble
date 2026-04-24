import { readFileSync, existsSync, watchFile, unwatchFile } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
function getProjectRoot() {
  if (typeof process !== "undefined" && process.cwd) {
    return process.cwd();
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = join(__filename, "..", "..");
  return __dirname;
}
const DEFAULT_CONFIG = {
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
  const root = getProjectRoot();
  return join(root, "config", "modules.json");
}
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    console.log("[Config] \u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u914D\u7F6E");
    return DEFAULT_CONFIG;
  }
  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    if (!config.modules || !Array.isArray(config.modules)) {
      console.warn("[Config] \u914D\u7F6E\u683C\u5F0F\u9519\u8BEF\uFF0C\u4F7F\u7528\u9ED8\u8BA4\u914D\u7F6E");
      return DEFAULT_CONFIG;
    }
    console.log(`[Config] \u5DF2\u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6: ${configPath}`);
    return config;
  } catch (error) {
    console.error("[Config] \u8BFB\u53D6\u914D\u7F6E\u6587\u4EF6\u5931\u8D25:", error);
    return DEFAULT_CONFIG;
  }
}
let currentConfig = loadConfig();
let watchEnabled = false;
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
    console.log("[Config] \u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8DF3\u8FC7\u70ED\u66F4\u65B0\u76D1\u542C");
    return;
  }
  watchFile(configPath, { interval: 1e3 }, () => {
    console.log("[Config] \u68C0\u6D4B\u5230\u914D\u7F6E\u6587\u4EF6\u53D8\u5316\uFF0C\u91CD\u65B0\u52A0\u8F7D...");
    reloadConfig();
  });
  watchEnabled = true;
  console.log("[Config] \u5DF2\u542F\u7528\u914D\u7F6E\u6587\u4EF6\u70ED\u66F4\u65B0");
}
function disableHotReload() {
  if (!watchEnabled) return;
  const configPath = getConfigPath();
  try {
    unwatchFile(configPath);
    watchEnabled = false;
    console.log("[Config] \u5DF2\u7981\u7528\u914D\u7F6E\u6587\u4EF6\u70ED\u66F4\u65B0");
  } catch {
  }
}
function findModuleByPath(path) {
  const config = getConfig();
  if (path.startsWith("/api/tasks") || /\/api\/agents\/[^/]+\/tasks/.test(path)) {
    const taskModule = config.modules.find((m) => m.key === "task");
    return taskModule || null;
  }
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
export {
  disableHotReload,
  enableHotReload,
  findModuleByKey,
  findModuleByPath,
  getConfig,
  getConfigPath,
  loadConfig,
  reloadConfig
};
