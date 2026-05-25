/**
 * 配置加载器
 * 
 * 加载 OpenCode Collector 的运行配置
 * 配置文件: config/config.json，支持环境变量覆盖
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger.js';

const configLoaderLogger = new Logger('ConfigLoader');

// ==================== 配置接口 ====================

export interface OpenCodeCollectorConfig {
    /** OpenCode SQLite 数据库路径 */
    opencodeDbPath: string;
    /** 轮询间隔（ms） */
    pollIntervalMs: number;
    /** 每轮最大采集消息数 */
    batchSize: number;
    /** HTTP API 端口 */
    httpPort: number;
    /** HTTP API 监听地址 */
    httpHost: string;
    /** 日志级别 */
    logLevel: 'error' | 'warn' | 'info' | 'debug';
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: OpenCodeCollectorConfig = {
    opencodeDbPath: '~/.local/share/opencode/opencode.db',
    pollIntervalMs: 30000,
    batchSize: 500,
    httpPort: 13101,
    httpHost: '0.0.0.0',
    logLevel: 'info',
};

// ==================== 配置加载器 ====================

export class ConfigLoader {
    private config: OpenCodeCollectorConfig;
    private configPath: string;

    constructor(configPath?: string) {
        this.config = { ...DEFAULT_CONFIG };
        this.configPath = configPath || this.findConfigFile();
    }

    /**
     * 查找配置文件
     */
    private findConfigFile(): string {
        const candidates = [
            'config/config.json',
            'config.json',
        ];
        for (const file of candidates) {
            if (fs.existsSync(file)) {
                return file;
            }
        }
        return 'config/config.json';
    }

    /**
     * 加载配置
     */
    async load(): Promise<OpenCodeCollectorConfig> {
        // 1. 从配置文件加载
        if (fs.existsSync(this.configPath)) {
            try {
                const content = fs.readFileSync(this.configPath, 'utf-8');
                const fileConfig = JSON.parse(content);
                this.config = { ...this.config, ...fileConfig };
                configLoaderLogger.info(`配置文件加载成功: ${this.configPath}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                configLoaderLogger.warn(`配置文件解析失败: ${msg}，使用默认配置`);
            }
        } else {
            configLoaderLogger.info(`配置文件不存在: ${this.configPath}，使用默认配置`);
        }

        // 2. 环境变量覆盖
        if (process.env.OPENCODE_DB_PATH) {
            this.config.opencodeDbPath = process.env.OPENCODE_DB_PATH;
        }
        if (process.env.COLLECTOR_PORT) {
            this.config.httpPort = parseInt(process.env.COLLECTOR_PORT, 10);
        }
        if (process.env.POLL_INTERVAL_MS) {
            this.config.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS, 10);
        }
        if (process.env.LOG_LEVEL) {
            this.config.logLevel = process.env.LOG_LEVEL as OpenCodeCollectorConfig['logLevel'];
        }

        // 3. 展开路径
        this.config.opencodeDbPath = this.expandPath(this.config.opencodeDbPath);

        // 4. 应用日志级别
        process.env.LOG_LEVEL = this.config.logLevel;

        return this.config;
    }

    /**
     * 展开路径（~ → 用户主目录）
     */
    private expandPath(p: string): string {
        if (p.startsWith('~')) {
            return path.join(os.homedir(), p.slice(1));
        }
        return path.resolve(p);
    }

    /**
     * 获取配置
     */
    getConfig(): OpenCodeCollectorConfig {
        return this.config;
    }
}

// ==================== 便捷函数 ====================

let configInstance: OpenCodeCollectorConfig | null = null;

export async function loadConfig(configPath?: string): Promise<OpenCodeCollectorConfig> {
    if (!configInstance) {
        const loader = new ConfigLoader(configPath);
        configInstance = await loader.load();
    }
    return configInstance;
}

export function getConfig(): OpenCodeCollectorConfig {
    if (!configInstance) {
        throw new Error('配置未加载，请先调用 loadConfig()');
    }
    return configInstance;
}

export function resetConfig(): void {
    configInstance = null;
}
