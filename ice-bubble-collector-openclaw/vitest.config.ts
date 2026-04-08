import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // 测试文件根目录
        root: 'tests',
        // 包含的测试文件模式
        include: ['**/*.test.ts'],
        // 排除的目录
        exclude: ['**/test-output/**', '**/scripts/**'],
        globals: true,
        environment: 'node',
        // 添加超时设置
        testTimeout: 10000,
        hookTimeout: 10000,
        // 并行执行
        pool: 'threads',
        poolOptions: {
            threads: {
                singleThread: true, // better-sqlite3 需要单线程
            },
        },
        // 隔离每个测试文件
        isolate: true,
    },
});
