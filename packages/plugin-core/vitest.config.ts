import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    projects: [{
      test: {
        name: 'filesystem-isolated',
        include: ['tests/unit/**/*.test.ts'],
      },
    }],
  },
})
