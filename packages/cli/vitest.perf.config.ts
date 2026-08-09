import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/perf/**/*.test.ts',
      'tests/perf/**/*.test.mjs',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
