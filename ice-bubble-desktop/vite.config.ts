import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import pkg from './package.json' with { type: 'json' };

const projectRoot = process.cwd();

// 读取模块配置（供 Vite 开发服务器使用）
function loadModulesConfig() {
  const configPath = join(projectRoot, 'config', 'modules.json');
  
  if (!existsSync(configPath)) {
    console.warn('[Vite] 配置文件不存在，使用默认配置');
    return {
      modules: [
        {
          key: 'admin',
          name: 'Admin 管理后台',
          url: 'http://localhost:13000',
          enabled: true
        }
      ]
    };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[Vite] 读取配置文件失败:', error);
    return {
      modules: [
        {
          key: 'admin',
          name: 'Admin 管理后台',
          url: 'http://localhost:13000',
          enabled: true
        }
      ]
    };
  }
}

const modulesConfig = loadModulesConfig();

// 获取 admin 模块的 URL
const adminModule = modulesConfig.modules.find((m: any) => m.key === 'admin');
const adminUrl = adminModule?.url || 'http://localhost:13000';

// Vite 服务器端口
const VITE_PORT = 1420;

// API 代理配置
// 开发模式：所有 /api/* 转发到本地 Express 服务器（端口由 .server-port 文件决定）
// Express 服务器内部使用 config/modules.json 进行动态路由
const adminWsUrl = adminUrl.replace(/^http/, 'ws');

const apiProxy = {
  // 开发模式下 /api 请求代理到 Admin 服务器（直连，无 Express 中间层）
  '/api': {
    target: adminUrl,
    changeOrigin: true,
    timeout: 30000,
    proxyTimeout: 30000,
  },
  // WebSocket 代理：/ws 转发到 Admin 服务器的 WebSocket 端点
  '/ws': {
    target: adminWsUrl,
    ws: true,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    port: VITE_PORT,
    proxy: apiProxy
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    esbuild: {
      drop: ['console']
    }
  },
  // 确保 resolve 能够正确处理模块
  resolve: {
    alias: {
      '@': join(projectRoot, 'src')
    }
  }
});

// 开发环境 API 地址
export const API_BASE = '/api';

// 从配置文件获取的 Admin 服务地址（供前端参考）
export const ADMIN_API_BASE = adminUrl;
