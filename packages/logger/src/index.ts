// @ice-bubble/logger — 统一日志包

export { Logger } from './logger.js';
export { LogLevel } from './levels.js';
export type { LoggerOptions, LoggerConfig } from './config.js';

import { Logger } from './logger.js';
import type { LoggerOptions } from './config.js';

/**
 * 工厂函数：创建命名 Logger 实例。
 * 推荐：模块级使用 `createLogger('module-name')`。
 */
export function createLogger(name: string, opts?: LoggerOptions): Logger {
  return new Logger(name, opts);
}

/**
 * 默认 Logger 单例（服务名取自 npm_package_name 或 fallback 'ice-bubble'）。
 * 适用于简单场景。
 */
export const logger = new Logger('default');
