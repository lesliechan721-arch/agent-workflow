import { vitestWorkerOptions } from './scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/integration/authoring-tools.test.ts',
      'tests/dist-contract/**/*.test.ts',
    ],
    setupFiles: ['tests/setup/test-isolation.ts'],
    pool: 'forks',
    fileParallelism: false,
    ...vitestWorkerOptions({ serial: true }),
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
