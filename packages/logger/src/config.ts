// 配置加载：环境变量驱动

import type { LogLevel } from './levels.js';

export interface LoggerConfig {
  /** 服务名，用于日志标识 */
  name: string;
  /** 日志级别（默认 info） */
  level: LogLevel;
  /** 控制台输出 */
  console: {
    enabled: boolean;
    pretty: boolean;
  };
  /** 文件输出 */
  file: {
    enabled: boolean;
    dir: string;
    maxDays: number;
  };
}

export interface LoggerOptions {
  /** 服务名（必须） */
  name?: string;
  /** 日志级别 */
  level?: LogLevel;
  /** 是否启用控制台输出 */
  consoleEnabled?: boolean;
  /** 是否启用 pretty 输出 */
  pretty?: boolean;
  /** 是否启用文件输出 */
  fileEnabled?: boolean;
  /** 日志文件目录 */
  fileDir?: string;
  /** 文件保留天数 */
  fileMaxDays?: number;
}

const isProduction = process.env.NODE_ENV === 'production';

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  return val === '1' || val.toLowerCase() === 'true';
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function resolveConfig(opts: LoggerOptions = {}): LoggerConfig {
  const level: LogLevel =
    (opts.level as LogLevel) ||
    (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) ||
    'info';

  return {
    name: opts.name || process.env.npm_package_name || 'ice-bubble',
    level,
    console: {
      enabled: opts.consoleEnabled ?? parseBoolean(process.env.LOG_CONSOLE_ENABLED, true),
      pretty: opts.pretty ?? parseBoolean(process.env.LOG_PRETTY, !isProduction),
    },
    file: {
      enabled: opts.fileEnabled ?? parseBoolean(process.env.LOG_FILE_ENABLED, true),
      dir: opts.fileDir || process.env.LOG_FILE_DIR || './logs',
      maxDays: opts.fileMaxDays ?? parseNumber(process.env.LOG_FILE_MAX_DAYS, 14),
    },
  };
}
