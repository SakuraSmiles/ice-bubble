/**
 * API 层类型定义
 *
 * 与 collector-openclaw 的 API 类型对齐，确保 Admin CollectorClient 无需区分。
 *
 * @module api/types
 */

// ==================== Admin 接入规范响应 ====================

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

export interface ModuleHealthInfo {
    status: 'healthy' | 'warning' | 'error';
    message?: string;
}

export interface ModuleStatusResponse {
    moduleKey: string;
    moduleType: string;
    version: string;
    status: 'running' | 'stopped' | 'error';
    runtime?: ModuleRuntimeInfo;
    health?: ModuleHealthInfo;
}

// ==================== 统一 API 错误响应 ====================

export interface ApiErrorResponse {
    error: string;
    code: string;
}

// ==================== API Server 配置 ====================

export interface ApiServerConfig {
    enabled: boolean;
    port: number;
    host: string;
    cors?: {
        enabled: boolean;
        origins: string[];
    };
}
