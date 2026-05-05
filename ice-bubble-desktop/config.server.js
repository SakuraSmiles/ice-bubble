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
