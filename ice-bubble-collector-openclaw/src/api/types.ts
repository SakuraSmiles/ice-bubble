/**
 * API 层类型定义
 *
 * 符合 ice-bubble-admin 模块接入规范（docs/integration.md）
 * 仅暴露给 BIZ LAYER (admin) 使用，不直接面向 topdesk
 *
 * @module api/types
 */

// ==================== Admin 接入规范响应 ====================

/**
 * 运行时信息
 */
export interface ModuleRuntimeInfo {
    /** 启动时间 ISO8601 */
    startTime: string;
    /** 运行秒数 */
    uptimeSeconds: number;
    /** 采集消息总数 */
    messagesCollected: number;
    /** 错误次数 */
    errorsCount: number;
}

/**
 * 健康状态
 */
export interface ModuleHealthInfo {
    /** 健康等级 */
    status: 'healthy' | 'warning' | 'error';
    /** 健康描述 */
    message?: string;
}

/**
 * GET /api/meta/status 响应
 *
 * 符合 admin integration.md 规范的字段定义
 */
export interface ModuleStatusResponse {
    /** 模块唯一标识 */
    moduleKey: string;
    /** 模块类型 */
    moduleType: string;
    /** 模块版本 */
    version: string;
    /** 运行状态 */
    status: 'running' | 'stopped' | 'error';
    /** 运行时信息（可选） */
    runtime?: ModuleRuntimeInfo;
    /** 健康信息（可选） */
    health?: ModuleHealthInfo;
}

// ==================== 统一 API 错误响应 ====================

export interface ApiErrorResponse {
    error: string;
    code: string;
}

// ==================== API Server 配置 ====================

export interface ApiServerConfig {
    /** 是否启动 HTTP 服务 */
    enabled: boolean;
    /** 监听端口 */
    port: number;
    /** 监听地址 */
    host: string;
    /** 认证配置 */
    auth?: {
        enabled: boolean;
        token: string;
    };
    /** 限流配置 */
    rateLimit?: {
        enabled: boolean;
        windowMs: number;
        maxRequests: number;
    };
}
