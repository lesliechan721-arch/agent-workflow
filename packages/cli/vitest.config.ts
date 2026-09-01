import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{ts,tsx}', 'tests/integration/**/*.{ts,tsx}'],
    exclude: ['tests/integration/fixtures/**', '**/*.test-helper.ts'],
    setupFiles: ['tests/setup/test-isolation.ts'],
    maxWorkers: 3,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
