import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.ts'],
    testTimeout: 30000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
