/**
 * ice-bubble Admin - 日志工具
 *
 * 简单的日志记录器，参考 collector 项目的实现
 */

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

/**
 * 日志条目
 */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  logger: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * 日志记录器
 */
export class Logger {
  private name: string;
  private level: LogLevel;

  constructor(name: string, level: LogLevel = LogLevel.INFO) {
    this.name = name;
    this.level = level;
  }

  /**
   * 记录调试日志
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * 记录信息日志
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * 记录警告日志
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * 记录错误日志
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, data);
  }

  /**
   * 记录日志
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // 检查日志级别
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      logger: this.name,
      message,
      data
    };

    this.writeLog(entry);
  }

  /**
   * 检查是否应该记录该级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(this.level);
    const targetIndex = levels.indexOf(level);
    return targetIndex >= currentIndex;
  }

  /**
   * 写入日志
   */
  private writeLog(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString();
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const loggerStr = `[${entry.logger}]`.padEnd(20);
    const message = entry.data 
      ? `${entry.message} ${JSON.stringify(entry.data)}`
      : entry.message;

    const logLine = `${timestamp} ${levelStr} ${loggerStr} ${message}`;

    // 根据级别输出到不同的流
    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(logLine);
        break;
      case LogLevel.WARN:
        console.warn(logLine);
        break;
      case LogLevel.INFO:
        console.info(logLine);
        break;
      case LogLevel.DEBUG:
        console.debug(logLine);
        break;
    }
  }

  /**
   * 创建子记录器
   */
  child(name: string): Logger {
    return new Logger(`${this.name}:${name}`, this.level);
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

/**
 * 默认日志记录器
 */
export const defaultLogger = new Logger('ice-bubble-admin');