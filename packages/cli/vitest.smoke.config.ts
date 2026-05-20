import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.ts'],
    setupFiles: ['tests/setup/test-isolation.ts', 'tests/setup/test-isolation-smoke.ts'],
    hookTimeout: 120000,
    testTimeout: 120000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
