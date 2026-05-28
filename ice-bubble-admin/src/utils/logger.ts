/**
 * ice-bubble Admin - 日志工具
 *
 * Re-export @ice-bubble/logger，保持向后兼容的导出名称。
 */

import { createLogger, Logger as BaseLogger, LogLevel } from '@ice-bubble/logger';

const logger = createLogger('ice-bubble-admin');

// 保持向后兼容的导出
export { BaseLogger as Logger, LogLevel };
export { logger as defaultLogger };
export default logger;
