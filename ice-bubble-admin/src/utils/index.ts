/**
 * ice-bubble Admin - 统一日志导出
 */

import { Logger, LogLevel } from './logger.js';

// 导出 Logger 类和日志级别
export { Logger, LogLevel };

// 创建全局日志实例（用于应用级别日志）
export const logger = new Logger('Admin', LogLevel.INFO);
