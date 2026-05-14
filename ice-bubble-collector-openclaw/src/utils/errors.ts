/**
 * 统一错误处理模块
 * 
 * 提供统一的错误类和错误处理机制
 * 
 * 错误分类：
 * 1. CollectorError - 采集器相关错误
 * 2. ValidationError - 数据验证错误
 * 3. StorageError - 存储相关错误
 * 4. ProcessingError - 处理过程错误
 * 5. ConfigurationError - 配置错误
 * 
 * @module Errors
 */

// ==================== 基础错误类 ====================

/**
 * 应用基础错误类
 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: Error,
    public metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    
    // 保持调用栈
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * 转换为 JSON 格式
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      stack: this.stack,
      cause: this.cause ? (this.cause instanceof AppError ? this.cause.toJSON() : {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack
      }) : undefined,
      metadata: this.metadata
    };
  }

  /**
   * 转换为字符串
   */
  toString(): string {
    let str = `${this.name} [${this.code}]: ${this.message}`;
    if (this.cause) {
      str += `\nCaused by: ${this.cause}`;
    }
    if (this.metadata) {
      str += `\nMetadata: ${JSON.stringify(this.metadata, null, 2)}`;
    }
    return str;
  }
}

// ==================== 具体错误类 ====================

/**
 * 采集器错误
 */
export class CollectorError extends AppError {
  constructor(
    code: CollectorErrorCode,
    message: string,
    cause?: Error,
    metadata?: Record<string, unknown>
  ) {
    super(`COLLECTOR_${code}`, message, cause, metadata);
    this.name = 'CollectorError';
  }
}

/**
 * 采集器错误代码
 */
export type CollectorErrorCode = 
  | 'FILE_NOT_FOUND'
  | 'FILE_READ_FAILED'
  | 'FILE_PARSE_FAILED'
  | 'SESSION_KEY_INVALID'
  | 'WATCHER_FAILED'
  | 'SCAN_FAILED'
  | 'CONNECTION_FAILED'
  | 'SUBSCRIPTION_FAILED';

/**
 * 数据验证错误
 */
export class ValidationError extends AppError {
  constructor(
    code: ValidationErrorCode,
    message: string,
    public field?: string,
    public value?: unknown,
    cause?: Error,
    metadata?: Record<string, unknown>
  ) {
    super(`VALIDATION_${code}`, message, cause, metadata);
    this.name = 'ValidationError';
  }
}

/**
 * 验证错误代码
 */
export type ValidationErrorCode =
  | 'INVALID_FORMAT'
  | 'MISSING_REQUIRED'
  | 'TYPE_MISMATCH'
  | 'VALUE_OUT_OF_RANGE'
  | 'DUPLICATE_DETECTED'
  | 'TIMESTAMP_INVALID'
  | 'SESSION_KEY_INVALID'
  | 'MESSAGE_FORMAT_INVALID';

/**
 * 存储错误
 */
export class StorageError extends AppError {
  constructor(
    code: StorageErrorCode,
    message: string,
    public query?: string,
    public params?: unknown[],
    cause?: Error,
    metadata?: Record<string, unknown>
  ) {
    super(`STORAGE_${code}`, message, cause, metadata);
    this.name = 'StorageError';
  }
}

/**
 * 存储错误代码
 */
export type StorageErrorCode =
  | 'CONNECTION_FAILED'
  | 'QUERY_FAILED'
  | 'TRANSACTION_FAILED'
  | 'CONSTRAINT_VIOLATION'
  | 'DUPLICATE_KEY'
  | 'TIMEOUT'
  | 'BUSY'
  | 'READONLY'
  | 'CORRUPT';

/**
 * 处理过程错误
 */
export class ProcessingError extends AppError {
  constructor(
    code: ProcessingErrorCode,
    message: string,
    public processor?: string,
    public input?: unknown,
    cause?: Error,
    metadata?: Record<string, unknown>
  ) {
    super(`PROCESSING_${code}`, message, cause, metadata);
    this.name = 'ProcessingError';
  }
}

/**
 * 处理错误代码
 */
export type ProcessingErrorCode =
  | 'CONVERSION_FAILED'
  | 'DEDUPLICATION_FAILED'
  | 'BATCH_WRITE_FAILED'
  | 'VALIDATION_FAILED'
  | 'TRANSFORMATION_FAILED'
  | 'AGGREGATION_FAILED'
  | 'ENRICHMENT_FAILED';

/**
 * 配置错误
 */
export class ConfigurationError extends AppError {
  constructor(
    code: ConfigurationErrorCode,
    message: string,
    public configPath?: string,
    public configValue?: unknown,
    cause?: Error,
    metadata?: Record<string, unknown>
  ) {
    super(`CONFIG_${code}`, message, cause, metadata);
    this.name = 'ConfigurationError';
  }
}

/**
 * 配置错误代码
 */
export type ConfigurationErrorCode =
  | 'MISSING_REQUIRED'
  | 'INVALID_VALUE'
  | 'TYPE_MISMATCH'
  | 'FILE_NOT_FOUND'
  | 'PARSE_FAILED'
  | 'VALIDATION_FAILED';

// ==================== 错误工厂函数 ====================

/**
 * 错误工厂 - 创建标准化的错误对象
 */
export const Errors = {
  // 采集器错误
  collector: {
    fileNotFound: (filePath: string, cause?: Error) =>
      new CollectorError('FILE_NOT_FOUND', `文件不存在: ${filePath}`, cause, { filePath }),
    
    fileReadFailed: (filePath: string, cause?: Error) =>
      new CollectorError('FILE_READ_FAILED', `读取文件失败: ${filePath}`, cause, { filePath }),
    
    fileParseFailed: (filePath: string, line?: number, cause?: Error) =>
      new CollectorError('FILE_PARSE_FAILED', `解析文件失败: ${filePath}${line ? ` (第${line}行)` : ''}`, cause, { filePath, line }),
    
    sessionKeyInvalid: (sessionKey: string, cause?: Error) =>
      new CollectorError('SESSION_KEY_INVALID', `无效的 Session Key: ${sessionKey}`, cause, { sessionKey }),
    
    watcherFailed: (pattern: string, cause?: Error) =>
      new CollectorError('WATCHER_FAILED', `文件监听失败: ${pattern}`, cause, { pattern }),
  },

  // 验证错误
  validation: {
    invalidFormat: (field: string, value: unknown, expected: string, cause?: Error) =>
      new ValidationError('INVALID_FORMAT', `字段 ${field} 格式无效: ${String(value)} (期望: ${expected})`, field, value, cause),
    
    missingRequired: (field: string, cause?: Error) =>
      new ValidationError('MISSING_REQUIRED', `缺少必填字段: ${field}`, field, undefined, cause),
    
    typeMismatch: (field: string, value: unknown, expected: string, cause?: Error) =>
      new ValidationError('TYPE_MISMATCH', `字段 ${field} 类型不匹配: ${typeof value} (期望: ${expected})`, field, value, cause),
    
    duplicateDetected: (field: string, value: unknown, cause?: Error) =>
      new ValidationError('DUPLICATE_DETECTED', `检测到重复值: ${field}=${String(value)}`, field, value, cause),
    
    timestampInvalid: (timestamp: string, cause?: Error) =>
      new ValidationError('TIMESTAMP_INVALID', `无效的时间戳: ${timestamp}`, 'timestamp', timestamp, cause),
  },

  // 存储错误
  storage: {
    connectionFailed: (dbPath: string, cause?: Error) =>
      new StorageError('CONNECTION_FAILED', `数据库连接失败: ${dbPath}`, undefined, undefined, cause, { dbPath }),
    
    queryFailed: (query: string, params: unknown[], cause?: Error) =>
      new StorageError('QUERY_FAILED', `查询执行失败`, query, params, cause),
    
    transactionFailed: (cause?: Error) =>
      new StorageError('TRANSACTION_FAILED', `事务执行失败`, undefined, undefined, cause),
    
    duplicateKey: (table: string, key: string, value: unknown, cause?: Error) =>
      new StorageError('DUPLICATE_KEY', `重复键冲突: ${table}.${key}=${String(value)}`, undefined, undefined, cause, { table, key, value }),
    
    busy: (timeout: number, cause?: Error) =>
      new StorageError('BUSY', `数据库忙，超时: ${timeout}ms`, undefined, undefined, cause, { timeout }),
  },

  // 处理错误
  processing: {
    conversionFailed: (processor: string, input: unknown, cause?: Error) =>
      new ProcessingError('CONVERSION_FAILED', `数据转换失败: ${processor}`, processor, input, cause),
    
    deduplicationFailed: (processor: string, input: unknown, cause?: Error) =>
      new ProcessingError('DEDUPLICATION_FAILED', `去重处理失败: ${processor}`, processor, input, cause),
    
    batchWriteFailed: (processor: string, batchSize: number, cause?: Error) =>
      new ProcessingError('BATCH_WRITE_FAILED', `批量写入失败: ${processor} (批次大小: ${batchSize})`, processor, { batchSize }, cause),
  },

  // 配置错误
  config: {
    missingRequired: (configPath: string, cause?: Error) =>
      new ConfigurationError('MISSING_REQUIRED', `缺少必需配置: ${configPath}`, configPath, undefined, cause),
    
    invalidValue: (configPath: string, value: unknown, expected: string, cause?: Error) =>
      new ConfigurationError('INVALID_VALUE', `配置值无效: ${configPath}=${String(value)} (期望: ${expected})`, configPath, value, cause),
    
    fileNotFound: (configPath: string, cause?: Error) =>
      new ConfigurationError('FILE_NOT_FOUND', `配置文件不存在: ${configPath}`, configPath, undefined, cause),
  },
};

// ==================== 错误处理工具 ====================

/**
 * 错误处理选项
 */
export interface ErrorHandlingOptions {
  /** 是否记录错误 */
  log?: boolean;
  /** 是否重新抛出错误 */
  rethrow?: boolean;
  /** 默认返回值（如果不重新抛出） */
  defaultValue?: unknown;
  /** 错误转换函数 */
  transform?: (error: Error) => Error;
}

/**
 * 安全执行函数，捕获并处理错误
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  options: ErrorHandlingOptions = {}
): Promise<T | undefined> {
  const { log = true, rethrow = false, defaultValue, transform } = options;
  
  try {
    return await fn();
  } catch (error: unknown) {
    const finalError = transform ? transform(error instanceof Error ? error : new Error(String(error))) : (error instanceof Error ? error : new Error(String(error)));
    
    if (log) {
      console.error('执行失败:', finalError);
    }
    
    if (rethrow) {
      throw finalError;
    }
    
    return defaultValue as T | undefined;
  }
}

/**
 * 检查错误是否属于特定类型
 */
export function isErrorOfType(error: Error, errorClass: new (...args: unknown[]) => Error): boolean {
  return error instanceof errorClass;
}

/**
 * 提取错误链信息
 */
export function extractErrorChain(error: Error): Array<{
  name: string;
  message: string;
  stack?: string;
}> {
  const chain = [];
  let currentError: Error | undefined = error;
  
  while (currentError) {
    chain.push({
      name: currentError.name,
      message: currentError.message,
      stack: currentError.stack
    });
    
    // 检查是否有 cause 属性
    if ('cause' in currentError && currentError.cause instanceof Error) {
      currentError = currentError.cause;
    } else {
      currentError = undefined;
    }
  }
  
  return chain;
}

/**
 * 创建错误包装器
 */
export function wrapError(innerError: Error, wrapperClass: new (...args: unknown[]) => Error, message: string): Error {
  if (wrapperClass.prototype instanceof AppError) {
    return new (wrapperClass as new (...args: unknown[]) => Error)(message, innerError);
  }
  return new wrapperClass(message, innerError);
}