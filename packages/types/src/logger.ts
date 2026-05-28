/**
 * 日志级别
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * 日志数据载荷（值必须可 JSON 序列化）
 */
export type LogData = Record<string, unknown>;

/**
 * Logger 接口（各模块依赖此接口，而非具体实现）
 */
export interface ILogger {
  trace(msg: string, data?: LogData): void;
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, error?: Error | unknown, data?: LogData): void;
  fatal(msg: string, error?: Error | unknown, data?: LogData): void;
  child(name: string): ILogger;
}
