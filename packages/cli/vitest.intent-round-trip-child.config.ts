import { vitestWorkerOptions } from './scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/fixtures/intent-round-trip-child.ts'],
    pool: 'forks',
    ...vitestWorkerOptions({ serial: true }),
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 15_000,
  },
});
