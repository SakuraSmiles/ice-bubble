/**
 * ice-bubble Admin - 模块管理类型定义
 */

// ==================== 模块注册表 ====================

/**
 * 模块注册表
 * 记录系统中所有注册的模块信息
 */
export interface ModuleRegistry {
  id?: number;
  moduleKey: string;      // 如 'collector-openclaw'
  moduleName: string;
  moduleType: string;     // 'collector' | 'api' | 'worker' | 'admin'
  status: ModuleStatus;
  version?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 模块类型枚举
 */
export enum ModuleType {
  COLLECTOR = 'collector',
  API = 'api',
  WORKER = 'worker',
  ADMIN = 'admin',
  DATABASE = 'database',
  CACHE = 'cache',
  MESSAGE_QUEUE = 'message_queue',
  SCHEDULER = 'scheduler'
}

/**
 * 模块状态枚举
 */
export enum ModuleStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  ERROR = 'error',
  STARTING = 'starting',
  STOPPING = 'stopping',
  MAINTENANCE = 'maintenance'
}

// ==================== 模块状态 ====================

/**
 * 模块运行时状态
 * 记录模块的运行指标和性能数据
 */
export interface ModuleRuntimeStatus {
  id?: number;
  moduleKey: string;
  isRunning: boolean;
  startTime?: Date;
  uptimeSeconds: number;
  lastHeartbeat?: Date;
  messagesCollected: number;
  errorsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 模块性能指标
 */
export interface ModuleMetrics {
  cpuUsage?: number;          // CPU 使用率百分比
  memoryUsage?: number;       // 内存使用量 (MB)
  diskUsage?: number;         // 磁盘使用量 (MB)
  networkIn?: number;         // 网络流入 (KB/s)
  networkOut?: number;        // 网络流出 (KB/s)
  requestCount?: number;      // 请求计数
  errorRate?: number;         // 错误率百分比
  responseTime?: number;      // 平均响应时间 (ms)
}

// ==================== 模块健康 ====================

/**
 * 模块健康状态
 * 记录模块的健康检查结果
 */
export interface ModuleHealth {
  id?: number;
  moduleKey: string;
  healthStatus: 'healthy' | 'warning' | 'error';
  checkTime: Date;
  details?: Record<string, unknown>;
  message?: string;
}

/**
 * 健康状态枚举
 */
export enum HealthStatus {
  HEALTHY = 'healthy',
  WARNING = 'warning',
  ERROR = 'error'
}

/**
 * 健康检查详情
 */
export interface HealthCheckDetails {
  component?: string;         // 检查的组件名称
  status: HealthStatus;       // 组件状态
  message?: string;           // 状态描述
  timestamp: Date;            // 检查时间
  metrics?: ModuleMetrics;    // 相关指标
  dependencies?: string[];    // 依赖的模块
}

// ==================== 模块配置 ====================

/**
 * 模块配置
 * 存储模块的配置信息
 */
export interface ModuleConfig {
  id?: number;
  moduleKey: string;
  configKey: string;
  configValue: string;
  configType: 'string' | 'number' | 'boolean' | 'json' | 'array';
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 模块事件 ====================

/**
 * 模块事件
 * 记录模块的重要事件（启动、停止、错误等）
 */
export interface ModuleEvent {
  id?: number;
  moduleKey: string;
  eventType: ModuleEventType;
  eventLevel: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
  createdAt: Date;
}

/**
 * 模块事件类型枚举
 */
export enum ModuleEventType {
  START = 'start',
  STOP = 'stop',
  RESTART = 'restart',
  ERROR = 'error',
  WARNING = 'warning',
  CONFIG_CHANGE = 'config_change',
  HEALTH_CHANGE = 'health_change',
  SCALE_UP = 'scale_up',
  SCALE_DOWN = 'scale_down',
  MAINTENANCE_START = 'maintenance_start',
  MAINTENANCE_END = 'maintenance_end'
}

// ==================== 模块依赖 ====================

/**
 * 模块依赖关系
 * 记录模块之间的依赖关系
 */
export interface ModuleDependency {
  id?: number;
  sourceModuleKey: string;    // 依赖方
  targetModuleKey: string;    // 被依赖方
  dependencyType: 'required' | 'optional' | 'recommended';
  description?: string;
  createdAt: Date;
}

// ==================== 模块版本 ====================

/**
 * 模块版本信息
 * 记录模块的版本历史
 */
export interface ModuleVersion {
  id?: number;
  moduleKey: string;
  version: string;
  changelog?: string;
  releaseDate: Date;
  isCurrent: boolean;
  createdAt: Date;
}

// ==================== 模块统计 ====================

/**
 * 模块统计信息
 * 用于报表和监控
 */
export interface ModuleStatistics {
  moduleKey: string;
  period: 'hourly' | 'daily' | 'weekly' | 'monthly';
  timestamp: Date;
  uptimePercentage: number;     // 正常运行时间百分比
  totalRequests: number;        // 总请求数
  totalErrors: number;          // 总错误数
  avgResponseTime: number;      // 平均响应时间 (ms)
  peakConcurrency: number;      // 峰值并发数
  dataVolume: number;           // 数据量 (MB)
  createdAt: Date;
}

// ==================== 查询参数类型 ====================

/**
 * 模块查询参数
 */
export interface ModuleQueryParams {
  moduleType?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * 模块状态查询参数
 */
export interface ModuleStatusQueryParams {
  moduleKey?: string;
  isRunning?: boolean;
  startTimeFrom?: Date;
  startTimeTo?: Date;
  page?: number;
  limit?: number;
}

/**
 * 模块健康查询参数
 */
export interface ModuleHealthQueryParams {
  moduleKey?: string;
  healthStatus?: string;
  checkTimeFrom?: Date;
  checkTimeTo?: Date;
  page?: number;
  limit?: number;
}

// ==================== 响应类型 ====================

/**
 * 模块列表响应
 */
export interface ModuleListResponse {
  modules: ModuleRegistry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * 模块详情响应
 */
export interface ModuleDetailResponse {
  module: ModuleRegistry;
  runtimeStatus?: ModuleRuntimeStatus;
  health?: ModuleHealth;
  metrics?: ModuleMetrics;
  events?: ModuleEvent[];
  dependencies?: ModuleDependency[];
  configs?: ModuleConfig[];
}

/**
 * 模块健康汇总
 */
export interface ModuleHealthSummary {
  totalModules: number;
  healthy: number;
  warning: number;
  error: number;
  unknown: number;
  lastUpdated: Date;
}

/**
 * 模块性能报告
 */
export interface ModulePerformanceReport {
  moduleKey: string;
  period: string;
  uptimePercentage: number;
  avgResponseTime: number;
  errorRate: number;
  peakConcurrency: number;
  recommendations?: string[];
}