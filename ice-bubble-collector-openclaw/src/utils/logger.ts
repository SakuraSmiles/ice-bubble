/**
 * Logger Module
 *
 * 基于 @ice-bubble/logger 统一日志包
 */

export { Logger, LogLevel } from '@ice-bubble/logger';

/**
 * 默认 logger 实例（向后兼容）
 */
import { createLogger } from '@ice-bubble/logger';
export const logger = createLogger('collector-openclaw');

export default logger;
