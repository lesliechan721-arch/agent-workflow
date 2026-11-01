import { vitestWorkerOptions } from '../cli/scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/dist-contract/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    ...vitestWorkerOptions({ serial: true }),
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
