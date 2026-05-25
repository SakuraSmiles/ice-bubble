/**
 * config-loader.ts 单元测试
 *
 * 测试内容：
 * 1. 默认配置值
 * 2. 路径展开（~ → 用户主目录）
 * 3. 环境变量覆盖
 * 4. 配置文件加载
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader, resetConfig } from '../../src/utils/config-loader.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// 保存原始环境变量
const originalEnv = { ...process.env };

describe('ConfigLoader', () => {
  beforeEach(() => {
    resetConfig();
    // 清理可能的环境变量
    delete process.env.OPENCODE_DB_PATH;
    delete process.env.COLLECTOR_PORT;
    delete process.env.POLL_INTERVAL_MS;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    // 恢复环境变量
    process.env = { ...originalEnv };
  });

  // ==================== 默认配置测试 ====================

  describe('default config', () => {
    it('应该提供正确的默认配置值', async () => {
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.pollIntervalMs).toBe(30000);
      expect(config.batchSize).toBe(500);
      expect(config.httpPort).toBe(13101);
      expect(config.httpHost).toBe('0.0.0.0');
      expect(config.logLevel).toBe('info');
    });

    it('默认 dbPath 展开后应包含 .local/share/opencode/opencode.db', async () => {
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.opencodeDbPath).toContain('.local/share/opencode/opencode.db');
      expect(config.opencodeDbPath).not.toContain('~');
    });
  });

  // ==================== 路径展开测试 ====================

  describe('path expansion', () => {
    it('应该将 ~ 展开为用户主目录', async () => {
      process.env.OPENCODE_DB_PATH = '~/custom/path/opencode.db';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.opencodeDbPath).toBe(path.join(os.homedir(), '/custom/path/opencode.db'));
      expect(config.opencodeDbPath).not.toContain('~');
    });

    it('应该正确处理绝对路径', async () => {
      process.env.OPENCODE_DB_PATH = '/absolute/path/opencode.db';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.opencodeDbPath).toBe('/absolute/path/opencode.db');
    });
  });

  // ==================== 环境变量覆盖测试 ====================

  describe('env override', () => {
    it('OPENCODE_DB_PATH 应覆盖 dbPath', async () => {
      process.env.OPENCODE_DB_PATH = '/tmp/test-opencode.db';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.opencodeDbPath).toBe('/tmp/test-opencode.db');
    });

    it('COLLECTOR_PORT 应覆盖 httpPort', async () => {
      process.env.COLLECTOR_PORT = '9999';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.httpPort).toBe(9999);
    });

    it('POLL_INTERVAL_MS 应覆盖 pollIntervalMs', async () => {
      process.env.POLL_INTERVAL_MS = '5000';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.pollIntervalMs).toBe(5000);
    });

    it('LOG_LEVEL 应覆盖 logLevel', async () => {
      process.env.LOG_LEVEL = 'debug';
      const loader = new ConfigLoader('/nonexistent/config.json');
      const config = await loader.load();

      expect(config.logLevel).toBe('debug');
    });
  });

  // ==================== 配置文件加载测试 ====================

  describe('config file loading', () => {
    const tmpDir = path.join(os.tmpdir(), 'opencode-collector-test-' + Date.now());

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('应该从配置文件加载自定义值', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        httpPort: 8080,
        logLevel: 'debug',
        batchSize: 100,
      }));

      const loader = new ConfigLoader(configPath);
      const config = await loader.load();

      expect(config.httpPort).toBe(8080);
      expect(config.logLevel).toBe('debug');
      expect(config.batchSize).toBe(100);
      // 未覆盖的应保持默认
      expect(config.pollIntervalMs).toBe(30000);
    });

    it('应该在配置文件不存在时使用默认配置', async () => {
      const loader = new ConfigLoader(path.join(tmpDir, 'nonexistent.json'));
      const config = await loader.load();

      expect(config.httpPort).toBe(13101);
    });

    it('应该在配置文件格式错误时使用默认配置', async () => {
      const configPath = path.join(tmpDir, 'bad-config.json');
      fs.writeFileSync(configPath, 'not valid json{');

      const loader = new ConfigLoader(configPath);
      const config = await loader.load();

      expect(config.httpPort).toBe(13101);
    });

    it('环境变量应该覆盖配置文件', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ httpPort: 8080 }));

      process.env.COLLECTOR_PORT = '7070';

      const loader = new ConfigLoader(configPath);
      const config = await loader.load();

      // 环境变量 7070 应覆盖配置文件的 8080
      expect(config.httpPort).toBe(7070);
    });
  });
});
