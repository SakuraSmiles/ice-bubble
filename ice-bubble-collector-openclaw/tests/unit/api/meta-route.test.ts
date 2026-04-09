/**
 * Meta Route 单元测试
 *
 * 测试 src/api/routes/meta.ts 的 /api/meta/status 路由：
 * 1. 正常状态响应格式完全符合 admin 规范
 * 2. moduleKey = "collector-openclaw"
 * 3. moduleType = "collector"
 * 4. status = "running" 时 runtime 字段完整
 * 5. health.status = "healthy" 当无错误时
 * 6. health.status = "warning" 当有少量错误时
 * 7. health.status = "error" 当错误过多时
 * 8. messagesCollected 从 collector 获取正确值
 * 9. errorsCount 从 collector 获取正确值
 * 10. uptimeSeconds 计算合理（正数）
 * 11. collector 为 null/undefined 时的降级处理
 * 12. 响应时间在合理范围内（<100ms）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApiServer } from '../../../src/api/server';
import type { FileCollector } from '../../../src/collectors/FileCollector';
import type { ApiServerConfig, ModuleStatusResponse } from '../../../src/api/types';

// ==================== 辅助函数 ====================

/** 创建指定统计数据的 mock FileCollector */
function createMockCollectorWithStats(stats: {
    totalEvents: number;
    successEvents: number;
    failedEvents: number;
    totalFiles?: number;
    processedFiles?: number;
}): FileCollector {
    return {
        getStats: () => ({
            totalFiles: stats.totalFiles ?? 0,
            processedFiles: stats.processedFiles ?? 0,
            skippedFiles: 0,
            totalEvents: stats.totalEvents,
            successEvents: stats.successEvents,
            failedEvents: stats.failedEvents,
            retriedEvents: 0,
        }),
        on: () => ({} as any),
        off: () => ({} as any),
        emit: () => true,
        removeAllListeners: () => ({} as any),
        listenerCount: () => 0,
        start: async () => {},
        stop: async () => {},
    } as unknown as FileCollector;
}

/** 创建一个 getStats 会抛异常的 mock（模拟 collector 为 null/undefined 等异常情况） */
function createFailingMockCollector(): FileCollector {
    return {
        getStats: () => {
            throw new Error('Collector not initialized');
        },
        on: () => ({} as any),
        off: () => ({} as any),
        emit: () => true,
        removeAllListeners: () => ({} as any),
        listenerCount: () => 0,
        start: async () => {},
        stop: async () => {},
    } as unknown as FileCollector;
}

const testConfig: ApiServerConfig = {
    enabled: true,
    port: 0,
    host: '127.0.0.1',
};

describe('Meta Route - GET /api/meta/status', () => {

    // ---- 测试 1: 正常状态响应格式完全符合 admin 规范 ----

    it('响应应包含 admin 规范要求的所有顶级字段', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 100,
            successEvents: 95,
            failedEvents: 5,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.status).toBe(200);

        const body: ModuleStatusResponse = res.body;

        // 验证所有必需字段存在
        expect(body).toHaveProperty('moduleKey');
        expect(body).toHaveProperty('moduleType');
        expect(body).toHaveProperty('version');
        expect(body).toHaveProperty('status');
        expect(body).toHaveProperty('runtime');
        expect(body).toHaveProperty('health');

        // 验证 runtime 内部字段
        expect(body.runtime).toHaveProperty('startTime');
        expect(body.runtime).toHaveProperty('uptimeSeconds');
        expect(body.runtime).toHaveProperty('messagesCollected');
        expect(body.runtime).toHaveProperty('errorsCount');

        // 验证 health 内部字段
        expect(body.health).toHaveProperty('status');
        expect(body.health).toHaveProperty('message');
    });

    // ---- 测试 2: moduleKey = "collector-openclaw" ----

    it('moduleKey 应为 "collector-openclaw"', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.moduleKey).toBe('collector-openclaw');
    });

    // ---- 测试 3: moduleType = "collector" ----

    it('moduleType 应为 "collector"', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.moduleType).toBe('collector');
    });

    // ---- 测试 4: status = "running" 时 runtime 字段完整 ----

    it('status 应为 "running"', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.status).toBe('running');
    });

    it('runtime.startTime 应为有效的 ISO 字符串', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        const startTime = res.body.runtime.startTime;
        // 验证 ISO 格式：能被 Date.parse 解析
        const parsed = Date.parse(startTime);
        expect(isNaN(parsed)).toBe(false);
        // 应该是 ISO 8601 格式
        expect(startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('runtime 字段类型应全部正确', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 50,
            successEvents: 45,
            failedEvents: 5,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        const { runtime } = res.body;
        expect(typeof runtime.startTime).toBe('string');
        expect(typeof runtime.uptimeSeconds).toBe('number');
        expect(typeof runtime.messagesCollected).toBe('number');
        expect(typeof runtime.errorsCount).toBe('number');
    });

    // ---- 测试 5: health.status = "healthy" 当无错误时 ----

    it('health.status 应为 "healthy" 当无错误时', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 100,
            successEvents: 100,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('healthy');
    });

    it('健康状态 healthy 的 message 应为 "正常"', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 50,
            successEvents: 50,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.message).toBe('正常');
    });

    it('totalEvents=0 时也应返回 healthy', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 0,
            successEvents: 0,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('healthy');
    });

    // ---- 测试 6: health.status = "warning" 当有少量错误时 ----

    it('health.status 应为 "warning" 当错误率 >1% 且 <=10%', async () => {
        // 错误率 5% -> warning
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 200,
            successEvents: 190,
            failedEvents: 10, // 5% error rate
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('warning');
        expect(res.body.health.message).toContain('少量错误');
    });

    it('边界: 错误率刚好超过 1% 时应为 warning', async () => {
        // 101 个事件，2 个失败 → 1.98% → warning
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 101,
            successEvents: 99,
            failedEvents: 2,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('warning');
    });

    // ---- 测试 7: health.status = "error" 当错误过多时 ----

    it('health.status 应为 "error" 当错误率 >10%', async () => {
        // 错误率 20% -> error
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 100,
            successEvents: 80,
            failedEvents: 20,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('error');
        expect(res.body.health.message).toContain('错误率偏高');
    });

    it('边界: 错误率刚好超过 10% 时应为 error', async () => {
        // 11 个事件，2 个失败 → 18.18% → error
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 11,
            successEvents: 9,
            failedEvents: 2,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.health.status).toBe('error');
    });

    // ---- 测试 8: messagesCollected 从 collector 获取正确值 ----

    it('messagesCollected 应等于 successEvents', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 500,
            successEvents: 450,
            failedEvents: 50,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.runtime.messagesCollected).toBe(450);
    });

    it('messagesCollected 在无成功事件时应为 0', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 5,
            successEvents: 0,
            failedEvents: 5,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.runtime.messagesCollected).toBe(0);
    });

    // ---- 测试 9: errorsCount 从 collector 获取正确值 ----

    it('errorsCount 应等于 failedEvents', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 200,
            successEvents: 195,
            failedEvents: 5,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.runtime.errorsCount).toBe(5);
    });

    it('errorsCount 在无失败事件时应为 0', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 100,
            successEvents: 100,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.runtime.errorsCount).toBe(0);
    });

    // ---- 测试 10: uptimeSeconds 计算合理（正数）----

    it('uptimeSeconds 应为正数或零', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(res.body.runtime.uptimeSeconds)).toBe(true);
    });

    it('连续请求的 uptimeSeconds 应递增', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 10,
            successEvents: 10,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);

        const res1 = await request(app).get('/api/meta/status');
        // 等待一小段时间确保 uptime 变化
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const res2 = await request(app).get('/api/meta/status');

        expect(res2.body.runtime.uptimeSeconds).toBeGreaterThanOrEqual(
            res1.body.runtime.uptimeSeconds
        );
    });

    // ---- 测试 11: collector 异常时的降级处理 ----

    it('当 collector.getStats() 抛异常时应返回 500', async () => {
        const failingCollector = createFailingMockCollector();

        const app = await createApiServer(testConfig, failingCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.status).toBe(500);
        expect(res.body).toHaveProperty('error');
        expect(res.body.code).toBe('STATUS_FETCH_FAILED');
    });

    it('异常时的错误消息应为 "获取模块状态失败"', async () => {
        const failingCollector = createFailingMockCollector();

        const app = await createApiServer(testConfig, failingCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.error).toBe('获取模块状态失败');
    });

    // ---- 测试 12: 响应时间在合理范围内（<100ms）----

    it('响应时间应在 100ms 以内', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 1000,
            successEvents: 999,
            failedEvents: 1,
        });

        const app = await createApiServer(testConfig, mockCollector);

        const start = performance.now();
        await request(app).get('/api/meta/status');
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
    });
});

describe('Meta Route - version 固定值验证', () => {
    it('version 应为 "1.0.0"', async () => {
        const mockCollector = createMockCollectorWithStats({
            totalEvents: 1,
            successEvents: 1,
            failedEvents: 0,
        });

        const app = await createApiServer(testConfig, mockCollector);
        const res = await request(app).get('/api/meta/status');

        expect(res.body.version).toBe('1.0.0');
    });
});
