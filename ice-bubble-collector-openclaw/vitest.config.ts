import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // 测试环境
    environment: 'node',
    
    // 全局变量
    globals: true,
    
    // 测试覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './tests/output',
      reportOnFailure: true,
      
      // 覆盖率报告文件命名规范
      // - coverage-final.json (JSON 格式)
      // - lcov.info (LCOV 格式)
      // - index.html (HTML 格式)
      
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '*.config.ts',
        'scripts/',
        'examples/',
      ],
      
      // 覆盖率阈值
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
    
    // 测试报告配置
    reporters: ['default'],
    
    // 测试文件匹配模式
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/scripts/**', 'tests/manual/**'],
    
    // 并行执行
    threads: true,
    
    // 超时配置
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  
  // 路径别名
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
