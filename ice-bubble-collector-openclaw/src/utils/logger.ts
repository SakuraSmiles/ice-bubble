/**
 * Logger Module
 */

import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level}]: ${message}`;
});

// 创建默认 logger 实例
const baseLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
    transports: [
        new winston.transports.Console({
            format: combine(colorize(), logFormat),
        }),
    ],
});

/** 日志元数据类型 */
type LogMeta = Record<string, unknown>;

/**
 * Logger 类 - 支持模块化日志
 */
export class Logger {
    private module: string;
    private logger: winston.Logger;

    constructor(module: string) {
        this.module = module;
        this.logger = baseLogger.child({ module });
    }

    info(message: string, meta?: LogMeta): void {
        this.logger.info(`[${this.module}] ${message}`, meta);
    }

    warn(message: string, meta?: LogMeta): void {
        this.logger.warn(`[${this.module}] ${message}`, meta);
    }

    error(message: string, error?: Error | unknown, meta?: LogMeta): void {
        const errorMeta = error instanceof Error 
            ? { error: error.message, stack: error.stack, ...meta }
            : { error, ...meta };
        this.logger.error(`[${this.module}] ${message}`, errorMeta);
    }

    debug(message: string, meta?: LogMeta): void {
        this.logger.debug(`[${this.module}] ${message}`, meta);
    }
}

// 导出默认 logger 实例（向后兼容）
export const logger = baseLogger;

export default logger;
