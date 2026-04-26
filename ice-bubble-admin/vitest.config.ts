import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './tests/output',
      reportOnFailure: true,
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '*.config.ts',
        'scripts/',
        'examples/',
      ],
      thresholds: {
        lines: 50,
        functions: 70,
        branches: 60,
        statements: 50,
      },
    },
    reporters: ['default'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/scripts/**', 'tests/manual/**'],
    threads: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
