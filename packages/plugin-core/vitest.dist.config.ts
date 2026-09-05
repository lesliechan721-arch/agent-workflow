import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/dist-contract/**/*.test.ts'],
    maxWorkers: 1,
    minWorkers: 1,
  },
})
