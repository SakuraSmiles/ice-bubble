// Logger 类：统一日志 API

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger as PinoLogger, type DestinationStream } from 'pino';
import type { ILogger, LogData, LogLevel as LogLevelType } from '@ice-bubble/types';
import { levelToString } from './levels.js';
import { resolveConfig, type LoggerConfig, type LoggerOptions } from './config.js';

/**
 * 为文件输出创建可写流，支持按日切换。
 * 使用 appendFile 模式，每次写入前检查日期，日期变化时重新打开文件。
 */
class DailyFileStream implements DestinationStream {
  private _fd: number | null = null;
  private _currentDate = '';
  private readonly _dir: string;
  private readonly _baseName: string;

  constructor(dir: string, baseName: string) {
    this._dir = dir;
    this._baseName = baseName;
  }

  private ensureOpen(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this._fd !== null && this._currentDate === today) return;

    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch { /* ignore */ }
    }

    try {
      fs.mkdirSync(this._dir, { recursive: true });
      const filePath = path.join(this._dir, `${this._baseName}.${today}.log`);
      this._fd = fs.openSync(filePath, 'a');
      this._currentDate = today;
    } catch (e) {
      this._fd = null;
      throw e;
    }
  }

  write(data: string): void {
    this.ensureOpen();
    if (this._fd !== null) {
      fs.writeSync(this._fd, data);
    }
  }

  close(): void {
    try {
      if (this._fd !== null) {
        fs.closeSync(this._fd);
        this._fd = null;
      }
    } catch { /* ignore */ }
  }
}

/**
 * 过滤级别的 stream wrapper — 只写入 >= minLevel 的日志
 */
class LevelFilterStream implements DestinationStream {
  constructor(
    private readonly _dest: DestinationStream,
    private readonly _minLevel: number,
  ) {}

  write(data: string): void {
    try {
      const parsed = JSON.parse(data);
      if (parsed.level >= this._minLevel) {
        this._dest.write(data);
      }
    } catch {
      this._dest.write(data);
    }
  }
}

const _fileStreams: DailyFileStream[] = [];
let _exitRegistered = false;
function registerExitHandler(): void {
  if (_exitRegistered) return;
  _exitRegistered = true;
  process.on('exit', () => {
    for (const s of _fileStreams) s.close();
  });
}

function buildStreams(config: LoggerConfig): DestinationStream | undefined {
  const { console: c, file: f, name } = config;

  if (!c.enabled && !f.enabled) {
    // 静默模式：写入 /dev/null
    return pino.destination({ fd: -1 });
  }

  // 仅控制台 + pretty → 使用 transport，不传 destination
  if (c.enabled && c.pretty && !f.enabled) {
    return undefined; // pino 会使用 transport
  }

  const streams: DestinationStream[] = [];

  if (c.enabled && !c.pretty) {
    streams.push(pino.destination({ sync: false }));
  }

  if (f.enabled) {
    // 常规日志
    const normalStream = new DailyFileStream(f.dir, name);
    _fileStreams.push(normalStream);
    streams.push(normalStream);
    // 错误日志（error >= 50, fatal >= 60）
    const errorStream = new DailyFileStream(f.dir, `${name}-errors`);
    _fileStreams.push(errorStream);
    streams.push(new LevelFilterStream(errorStream, 50));
    registerExitHandler();
  }

  if (streams.length === 1) return streams[0];
  if (streams.length > 1) return pino.multistream(streams);
  return undefined;
}

/**
 * 清理过期日志文件
 */
function cleanOldLogs(dir: string, baseName: string, maxDays: number): void {
  try {
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.startsWith(baseName) || !file.endsWith('.log')) continue;

      // 从文件名提取日期：xxx.YYYY-MM-DD.log
      const dateMatch = file.match(/\.(\d{4}-\d{2}-\d{2})\.log$/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1] + 'T00:00:00.000Z').getTime();
      if (fileDate < cutoff) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    // 清理失败不影响日志功能
  }
}

export class Logger implements ILogger {
  private pino: PinoLogger;
  private moduleName: string;
  private _config: LoggerConfig;

  constructor(name: string, opts?: LoggerOptions) {
    this.moduleName = name;
    this._config = resolveConfig(opts);

    const isPrettyOnly =
      this._config.console.enabled && this._config.console.pretty && !this._config.file.enabled;

    const pinoOpts: pino.LoggerOptions = {
      name: this._config.name,
      level: this._config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        pid: process.pid,
        hostname: os.hostname(),
      },
      formatters: {
        log(object: Record<string, unknown>) {
          const data = (object as any).data as Record<string, unknown> | undefined;
          if (data) {
            const { data: _d, ...rest } = object;
            return { ...data, ...rest };
          }
          return object;
        },
      },
    };

    if (isPrettyOnly) {
      pinoOpts.transport = {
        target: 'pino-pretty',
        options: { colorize: true },
      };
      this.pino = pino(pinoOpts);
    } else {
      const destination = buildStreams(this._config);
      this.pino = pino(pinoOpts, destination);

      // 后台清理旧日志
      if (this._config.file.enabled) {
        setImmediate(() => cleanOldLogs(this._config.file.dir, this._config.name, this._config.file.maxDays));
      }
    }
  }

  private buildMerge(error?: Error | unknown, data?: LogData): Record<string, unknown> {
    const merge: Record<string, unknown> = {};
    if (error instanceof Error) {
      merge.err = error;
    } else if (error !== undefined) {
      merge.err = error;
    }
    if (data) {
      merge.data = data;
    }
    return merge;
  }

  private log(level: string, msg: string, error?: Error | unknown, data?: LogData): void {
    const child = this.pino.child({ module: this.moduleName });
    const merge = this.buildMerge(error, data);
    // pino API: child.level(msg, mergeObject?)
    (child as any)[level](msg, merge);
  }

  trace(msg: string, data?: LogData): void {
    this.log('trace', msg, undefined, data);
  }

  debug(msg: string, data?: LogData): void {
    this.log('debug', msg, undefined, data);
  }

  info(msg: string, data?: LogData): void {
    this.log('info', msg, undefined, data);
  }

  warn(msg: string, data?: LogData): void {
    this.log('warn', msg, undefined, data);
  }

  error(msg: string, error?: Error | unknown, data?: LogData): void {
    this.log('error', msg, error, data);
  }

  fatal(msg: string, error?: Error | unknown, data?: LogData): void {
    this.log('fatal', msg, error, data);
  }

  child(name: string): Logger {
    return new Logger(`${this.moduleName}/${name}`, {
      name: this._config.name,
      level: this._config.level,
      consoleEnabled: this._config.console.enabled,
      pretty: this._config.console.pretty,
      fileEnabled: this._config.file.enabled,
      fileDir: this._config.file.dir,
      fileMaxDays: this._config.file.maxDays,
    });
  }

  setLevel(level: LogLevelType): void {
    this._config.level = level;
    this.pino.level = levelToString(level);
  }

  get level(): LogLevelType {
    return this._config.level;
  }
}
