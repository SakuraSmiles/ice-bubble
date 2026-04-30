/**
 * ice-bubble Admin - Task HTTP 客户端
 *
 * 通过 HTTP API 与 Task 模块（端口 13102）通信，支持静默降级
 *
 * @module data/task-client
 */

import { logger } from '../utils/index.js';

export interface TaskClientConfig {
    /** Task API 基础地址 */
    baseUrl: string; // 默认 http://localhost:13102
}

export interface CreateTaskParams {
    title: string;
    agent_id: string;
    priority?: string;
    description?: string;
    /** 幂等键，传给 Task API */
    id?: string;
}

/**
 * Task HTTP 客户端
 *
 * 与 Task 模块（端口 13102）通信，支持静默降级：
 * - 可用性探测：GET /api/tasks?limit=1，3 秒超时，60 秒缓存
 * - 所有操作不可用时返回 null / false，不抛异常
 */
export class TaskClient {
    private baseUrl: string;
    private available: boolean | null = null; // null = 未探测
    private lastCheck = 0;
    private readonly CHECK_INTERVAL = 60_000;

    constructor(config: TaskClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, ''); // 去除末尾斜杠
    }

    /**
     * 健康探测：GET /api/tasks?limit=1
     *
     * 3 秒超时，60 秒缓存结果，不抛异常
     */
    async isAvailable(): Promise<boolean> {
        const now = Date.now();
        if (this.available !== null && now - this.lastCheck < this.CHECK_INTERVAL) {
            return this.available;
        }

        try {
            const url = `${this.baseUrl}/api/tasks?limit=1`;
            const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
            this.available = response.ok;
            this.lastCheck = now;
            logger.debug(`[TaskClient] 健康探测成功: ${response.ok}`);
            return this.available;
        } catch (err) {
            this.available = false;
            this.lastCheck = now;
            logger.warn(`[TaskClient] 健康探测失败，降级不可用: ${err instanceof Error ? err.message : err}`);
            return false;
        }
    }

    /**
     * 创建任务：POST /api/tasks
     *
     * 5 秒超时，不可用时返回 null，不抛异常
     */
    async createTask(params: CreateTaskParams): Promise<{ id: string } | null> {
        if (!(await this.isAvailable())) {
            logger.warn(`[TaskClient] createTask 跳过，Task API 不可用`);
            return null;
        }

        try {
            const url = `${this.baseUrl}/api/tasks`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                logger.warn(`[TaskClient] createTask 失败: ${response.status} ${response.statusText}`);
                return null;
            }

            const data = (await response.json()) as { id: string };
            logger.debug(`[TaskClient] createTask 成功: ${data.id}`);
            return data;
        } catch (err) {
            this.available = false;
            this.lastCheck = 0;
            logger.warn(`[TaskClient] createTask 异常，降级不可用: ${err instanceof Error ? err.message : err}`);
            return null;
        }
    }

    /**
     * 更新任务状态：PATCH /api/tasks/:id/status
     *
     * 5 秒超时，不可用时返回 false，不抛异常
     */
    async updateTaskStatus(id: string, status: string): Promise<boolean> {
        if (!(await this.isAvailable())) {
            logger.warn(`[TaskClient] updateTaskStatus 跳过，Task API 不可用`);
            return false;
        }

        try {
            const url = `${this.baseUrl}/api/tasks/${encodeURIComponent(id)}/status`;
            const response = await fetch(url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                logger.warn(`[TaskClient] updateTaskStatus 失败: ${response.status} ${response.statusText}`);
                return false;
            }

            logger.debug(`[TaskClient] updateTaskStatus 成功: ${id} -> ${status}`);
            return true;
        } catch (err) {
            this.available = false;
            this.lastCheck = 0;
            logger.warn(`[TaskClient] updateTaskStatus 异常，降级不可用: ${err instanceof Error ? err.message : err}`);
            return false;
        }
    }

    /**
     * 通过 session_id 查找任务（用于完成事件 → 任务关联）
     *
     * 策略：获取 agent 的所有 pending 任务，在 description 中搜索 `||sid:{sessionId}||` 标记
     * 该标记由 createTaskWithSessionId 写入，不会出现在自然文本中。
     */
    async lookupTaskBySessionId(agentId: string, sessionId: string): Promise<string | null> {
        if (!(await this.isAvailable())) {
            logger.warn(`[TaskClient] lookupTaskBySessionId 跳过，Task API 不可用`);
            return null;
        }

        try {
            const sidMarker = `||sid:${sessionId}||`;
            let offset = 0;
            const limit = 100;

            while (true) {
                const url = `${this.baseUrl}/api/tasks?agent_id=${encodeURIComponent(agentId)}&status=pending&limit=${limit}&offset=${offset}`;
                const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

                if (!response.ok) {
                    logger.warn(`[TaskClient] lookupTaskBySessionId 查询失败: ${response.status}`);
                    return null;
                }

                const data = await response.json() as { tasks: Array<{ id: string; description?: string }>; total: number };

                for (const task of data.tasks) {
                    if (task.description?.includes(sidMarker)) {
                        return task.id;
                    }
                }

                offset += limit;
                if (offset >= data.total) break;
            }

            return null;
        } catch (err) {
            this.available = false;
            this.lastCheck = 0;
            logger.warn(`[TaskClient] lookupTaskBySessionId 异常: ${err instanceof Error ? err.message : err}`);
            return null;
        }
    }

    /**
     * 创建任务，并在 description 中嵌入 session_id 标记
     *
     * 标记格式：`||sid:{sessionId}||`，用于完成事件反向查找任务。
     * 标记使用 `||` 分隔符，不会与 Markdown 或自然文本冲突。
     */
    async createTaskWithSessionId(params: CreateTaskParams, sessionId: string): Promise<{ id: string } | null> {
        const sidMarker = `||sid:${sessionId}||`;
        const baseDescription = params.description || '';
        const description = baseDescription.endsWith(sidMarker)
            ? baseDescription
            : (baseDescription ? `${baseDescription}\n${sidMarker}` : sidMarker);

        return this.createTask({ ...params, description });
    }
}
