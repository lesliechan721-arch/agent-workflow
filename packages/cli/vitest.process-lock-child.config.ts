import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/fixtures/process-lock-order-child.ts'],
    setupFiles: ['tests/setup/test-isolation.ts'],
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 15_000,
  },
});
