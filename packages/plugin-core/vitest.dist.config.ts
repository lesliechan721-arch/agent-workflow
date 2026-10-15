import { vitestWorkerOptions } from '../cli/scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/dist-contract/**/*.test.ts'],
    ...vitestWorkerOptions({ serial: true }),
  },
})
