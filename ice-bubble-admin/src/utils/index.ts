/**
 * ice-bubble Admin - 统一日志导出
 */

import { createLogger } from '@ice-bubble/logger';

// 创建全局日志实例（用于应用级别日志）
export const logger = createLogger('Admin');

// LogLevel 已被各模块直接从 ./logger 导入，此处不再重复导出
