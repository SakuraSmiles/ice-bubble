/**
 * 配置文件加载器
 * 
 * 配置优先级：config/config.json > 默认配置
 * 
 * 注意：
 * - 配置文件是唯一配置源，不支持环境变量
 * - 自动查找 config/ 目录下的配置文件
 * - 支持配置文件路径展开（~、相对路径）
 * - 提供配置验证功能
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger.js';

const configLoaderLogger = new Logger('ConfigLoader');

// ==================== 配置接口定义 ====================

export interface OpenClawGatewayConfig {
  url: string;
  token: string;
  reconnect: {
    enabled: boolean;
    maxAttempts: number;
    delay: number;
  };
}

export interface OpenClawApiConfig {
  url: string;
  token: string;
  timeout: number;
}

export interface OpenClawConfig {
  gateway: OpenClawGatewayConfig;
  api: OpenClawApiConfig;
  dataDir: string;
}

export interface SQLiteConfig {
  enabled: boolean;
  dbPath: string;
  walMode: boolean;
  foreignKeys: boolean;
  pragma: {
    cacheSize: number;
    tempStore: string;
    mmapSize: number;
  };
}

export interface RedisConfig {
  enabled: boolean;
  url: string;
  password: string;
  db: number;
  keyPrefix: string;
}

export interface StorageConfig {
  sqlite: SQLiteConfig;
  redis: RedisConfig;
}

export interface FileCollectionConfig {
  enabled: boolean;
  watchPath: string;
  enableWatch: boolean;
  scanInterval: number;
  maxFileSize: number;
  maxLineLength: number;
  watchPreset: 'local' | 'network' | 'custom';
  watchOptions?: {
    usePolling?: boolean;
    interval?: number;
    binaryInterval?: number;
    awaitWriteFinish?: {
      stabilityThreshold?: number;
      pollInterval?: number;
    };
    [key: string]: unknown;
  };
  incremental: {
    enabled: boolean;
    statePath: string;
  };
  retry: {
    maxAttempts: number;
    delay: number;
    backoffMultiplier: number;
  };
}

export interface WebSocketCollectionConfig {
  enabled: boolean;
  subscriptions: string[];
}

export interface HttpCollectionConfig {
  enabled: boolean;
  syncInterval: number;
  syncTime: string;
}

export interface CollectionConfig {
  mode: 'HYBRID_PRIORITY' | 'WEBSOCKET_ONLY' | 'FILE_ONLY' | 'HTTP_ONLY';
  file: FileCollectionConfig;
  websocket: WebSocketCollectionConfig;
  http: HttpCollectionConfig;
}

export interface ValidatorConfig {
  enabled: boolean;
  strict: boolean;
  customRules: Record<string, unknown>[];
}

export interface DeduplicatorConfig {
  enabled: boolean;
  cacheSize: number;
  ttl: number;
}

export interface BatchWriterConfig {
  enabled: boolean;
  batchSize: number;
  flushInterval: number;
  maxQueueSize: number;
}

export interface ProcessingConfig {
  validator: ValidatorConfig;
  deduplicator: DeduplicatorConfig;
  batchWriter: BatchWriterConfig;
}

export interface ApiConfig {
  enabled: boolean;
  port: number;
  host: string;
  cors: {
    enabled: boolean;
    origins: string[];
  };
  auth: {
    enabled: boolean;
    token: string;
  };
  rateLimit: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
  };
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  format: 'json' | 'text';
  outputs: Array<{
    type: 'console' | 'file';
    path?: string;
    colorize?: boolean;
    maxSize?: number;
    maxFiles?: number;
  }>;
}

export interface MonitoringConfig {
  enabled: boolean;
  metrics: {
    enabled: boolean;
    port: number;
    path: string;
  };
  healthCheck: {
    enabled: boolean;
    path: string;
    interval: number;
  };
}

export interface PerformanceConfig {
  maxMemory: number;
  gcInterval: number;
  eventLoopLag: {
    enabled: boolean;
    threshold: number;
  };
}

export interface BackupConfig {
  enabled: boolean;
  schedule: string;
  retention: number;
  path: string;
}

export interface CollectorConfig {
  openclaw: OpenClawConfig;
  storage: StorageConfig;
  collection: CollectionConfig;
  processing: ProcessingConfig;
  api: ApiConfig;
  logging: LoggingConfig;
  monitoring: MonitoringConfig;
  performance: PerformanceConfig;
  backup: BackupConfig;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: CollectorConfig = {
  openclaw: {
    gateway: {
      url: 'wss://localhost:18789',
      token: '',
      reconnect: {
        enabled: true,
        maxAttempts: 10,
        delay: 5000,
      },
    },
    api: {
      url: 'http://localhost:18789',
      token: '',
      timeout: 30000,
    },
    dataDir: '~/.openclaw',
  },
  storage: {
    sqlite: {
      enabled: true,
      dbPath: './data/collector.db',
      walMode: true,
      foreignKeys: true,
      pragma: {
        cacheSize: -64000,
        tempStore: 'MEMORY',
        mmapSize: 268435456,
      },
    },
    redis: {
      enabled: false,
      url: 'redis://localhost:6379',
      password: '',
      db: 0,
      keyPrefix: 'collector:',
    },
  },
  collection: {
    mode: 'FILE_ONLY',
    file: {
      enabled: true,
      watchPath: '~/.openclaw/agents',
      enableWatch: true,
      scanInterval: 5000,
      maxFileSize: 104857600,
      maxLineLength: 1048576,
      watchPreset: 'local',
      incremental: {
        enabled: true,
        statePath: './data/file-state.json',
      },
      retry: {
        maxAttempts: 3,
        delay: 1000,
        backoffMultiplier: 2,
      },
    },
    websocket: {
      enabled: false,
      subscriptions: ['session.message', 'agent.status', 'tool.call', 'tool.result'],
    },
    http: {
      enabled: false,
      syncInterval: 86400000,
      syncTime: '02:00',
    },
  },
  processing: {
    validator: {
      enabled: true,
      strict: true,
      customRules: [],
    },
    deduplicator: {
      enabled: true,
      cacheSize: 10000,
      ttl: 86400000,
    },
    batchWriter: {
      enabled: true,
      batchSize: 100,
      flushInterval: 5000,
      maxQueueSize: 10000,
    },
  },
  api: {
    enabled: false,
    port: 3000,
    host: '0.0.0.0',
    cors: {
      enabled: true,
      origins: ['*'],
    },
    auth: {
      enabled: false,
      token: '',
    },
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      maxRequests: 100,
    },
  },
  logging: {
    level: 'info',
    format: 'json',
    outputs: [
      {
        type: 'console',
        colorize: true,
      },
      {
        type: 'file',
        path: './logs/collector.log',
        maxSize: 10485760,
        maxFiles: 5,
      },
    ],
  },
  monitoring: {
    enabled: true,
    metrics: {
      enabled: true,
      port: 9090,
      path: '/metrics',
    },
    healthCheck: {
      enabled: true,
      path: '/health',
      interval: 30000,
    },
  },
  performance: {
    maxMemory: 52428800,
    gcInterval: 60000,
    eventLoopLag: {
      enabled: true,
      threshold: 100,
    },
  },
  backup: {
    enabled: true,
    schedule: '0 3 * * *',
    retention: 7,
    path: './backups',
  },
};

// ==================== 配置加载器类 ====================

export class ConfigLoader {
  private config: CollectorConfig;
  private configPath: string;

  constructor(configPath?: string) {
    this.config = { ...DEFAULT_CONFIG };
    this.configPath = configPath || this.findConfigFile();
  }

  /**
   * 查找配置文件
   * 优先级：config/config.json > config/config.yaml > config/config.yml
   */
  private findConfigFile(): string {
    const configDir = 'config';
    const configFiles = ['config.json', 'config.yaml', 'config.yml'];
    
    for (const file of configFiles) {
      const fullPath = path.join(configDir, file);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    
    // 默认使用 config/config.json
    return path.join(configDir, 'config.json');
  }

  /**
   * 加载配置文件
   */
  async load(): Promise<CollectorConfig> {
    // 1. 尝试加载配置文件
    if (fs.existsSync(this.configPath)) {
      const fileConfig = await this.loadConfigFile(this.configPath);
      this.config = this.mergeConfig(this.config, fileConfig);
      configLoaderLogger.info(`配置文件加载成功: ${this.configPath}`);
    } else {
      configLoaderLogger.warn(`配置文件不存在: ${this.configPath}，使用默认配置`);
      configLoaderLogger.warn(`请创建配置文件: cp config/config.example.json config/config.json`);
    }

    // 2. 展开路径（~、相对路径）
    this.expandPaths();

    // 3. 验证配置
    this.validateConfig();

    return this.config;
  }

  /**
   * 加载配置文件（支持 JSON 和 YAML）
   */
  private async loadConfigFile(filePath: string): Promise<Partial<CollectorConfig>> {
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');

    if (ext === '.json') {
      return JSON.parse(content);
    } else if (ext === '.yaml' || ext === '.yml') {
      // 如果需要支持 YAML，需要安装 js-yaml
      // const yaml = require('js-yaml');
      // return yaml.load(content);
      throw new Error('YAML 配置文件支持需要安装 js-yaml: npm install js-yaml');
    } else {
      throw new Error(`不支持的配置文件格式: ${ext}`);
    }
  }

  /**
   * 合并配置（深度合并）
   */
  private mergeConfig(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };

    for (const key in source) {
      const sourceVal = source[key];
      if (
        sourceVal !== null &&
        typeof sourceVal === 'object' &&
        !Array.isArray(sourceVal)
      ) {
        const targetVal =
          target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
            ? (target[key] as Record<string, unknown>)
            : {};
        result[key] = this.mergeConfig(targetVal, sourceVal as Record<string, unknown>);
      } else {
        result[key] = sourceVal;
      }
    }

    return result;
  }

  /**
   * 展开路径（~ → 用户主目录，相对路径 → 绝对路径）
   */
  private expandPaths(): void {
    const expandPath = (p: string): string => {
      if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
      }
      return path.resolve(p);
    };

    // 展开所有路径配置
    this.config.openclaw.dataDir = expandPath(this.config.openclaw.dataDir);
    this.config.collection.file.watchPath = expandPath(this.config.collection.file.watchPath);
    this.config.storage.sqlite.dbPath = expandPath(this.config.storage.sqlite.dbPath);
    
    // 智能推导增量状态文件路径
    // 如果 statePath 未配置或为默认值，则自动从 dbPath 推导
    if (!this.config.collection.file.incremental.statePath || 
        this.config.collection.file.incremental.statePath === './data/file-state.json') {
      const dbDir = path.dirname(this.config.storage.sqlite.dbPath);
      this.config.collection.file.incremental.statePath = path.join(dbDir, 'file-state.json');
      configLoaderLogger.info(`自动推导增量状态文件路径: ${this.config.collection.file.incremental.statePath}`);
    } else {
      this.config.collection.file.incremental.statePath = expandPath(this.config.collection.file.incremental.statePath);
    }
    
    if (this.config.backup.enabled) {
      this.config.backup.path = expandPath(this.config.backup.path);
    }

    // 展开日志文件路径
    this.config.logging.outputs.forEach((output) => {
      if (output.type === 'file' && output.path) {
        output.path = expandPath(output.path);
      }
    });
  }

  /**
   * 验证配置
   */
  private validateConfig(): void {
    // 验证必填字段
    if (!this.config.openclaw.dataDir) {
      throw new Error('配置错误: openclaw.dataDir 不能为空');
    }
    if (!this.config.storage.sqlite.dbPath) {
      throw new Error('配置错误: storage.sqlite.dbPath 不能为空');
    }

    // 验证采集模式
    const validModes = ['HYBRID_PRIORITY', 'WEBSOCKET_ONLY', 'FILE_ONLY', 'HTTP_ONLY'];
    if (!validModes.includes(this.config.collection.mode)) {
      throw new Error(`配置错误: collection.mode 必须是 ${validModes.join(', ')} 之一`);
    }

    // 验证端口号
    if (this.config.api.enabled) {
      if (this.config.api.port < 1 || this.config.api.api.port > 65535) {
        throw new Error('配置错误: api.port 必须在 1-65535 范围内');
      }
    }

    configLoaderLogger.info('配置验证通过');
  }

  /**
   * 获取配置
   */
  getConfig(): CollectorConfig {
    return this.config;
  }

  /**
   * 保存配置到文件
   */
  async save(filePath?: string): Promise<void> {
    const targetPath = filePath || this.configPath;
    const content = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(targetPath, content, 'utf-8');
    configLoaderLogger.info(`配置已保存到: ${targetPath}`);
  }
}

// ==================== 便捷函数 ====================

/**
 * 加载配置（单例模式）
 */
let configInstance: CollectorConfig | null = null;

export async function loadConfig(configPath?: string): Promise<CollectorConfig> {
  if (!configInstance) {
    const loader = new ConfigLoader(configPath);
    configInstance = await loader.load();
  }
  return configInstance;
}

/**
 * 获取配置
 */
export function getConfig(): CollectorConfig {
  if (!configInstance) {
    throw new Error('配置未加载，请先调用 loadConfig()');
  }
  return configInstance;
}

/**
 * 重置配置（用于测试）
 */
export function resetConfig(): void {
  configInstance = null;
}
