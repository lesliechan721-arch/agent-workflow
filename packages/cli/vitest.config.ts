import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.ts', 'tests/integration/**/*.ts'],
    setupFiles: ['tests/setup/no-network-catalog.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
