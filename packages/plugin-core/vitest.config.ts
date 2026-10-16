import { vitestWorkerOptions } from '../cli/scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    ...vitestWorkerOptions(),
    projects: [{
      test: {
        name: 'filesystem-isolated',
        include: ['tests/unit/**/*.test.ts'],
      },
    }],
  },
})
