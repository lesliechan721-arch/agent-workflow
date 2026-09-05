import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.ts'],
    setupFiles: ['tests/setup/test-isolation.ts', 'tests/setup/test-isolation-smoke.ts'],
    // Smoke cases exercise real build/pack commands that rewrite the repo-level dist outputs.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 120000,
    testTimeout: 120000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
