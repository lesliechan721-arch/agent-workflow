import { vitestWorkerOptions } from './scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config';

import base from './vitest.config.js';

export default defineConfig({
  resolve: base.resolve,
  test: {
    server: base.test?.server,
    environment: 'node',
    include: ['tests/integration/fixtures/intent-round-trip-child.ts'],
    pool: 'forks',
    ...vitestWorkerOptions({ serial: true }),
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 15_000,
  },
});
