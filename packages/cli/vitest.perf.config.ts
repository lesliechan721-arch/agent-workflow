import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    projects: [
      {
        test: {
          name: 'process-lifecycle',
          environment: 'node',
          include: [
            'tests/perf/process-tree.test.mjs',
            'tests/perf/run-vitest-wrapper.test.mjs',
          ],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          hookTimeout: 120_000,
          testTimeout: 120_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'performance',
          environment: 'node',
          include: [
            'tests/perf/perf-metrics.test.ts',
            'tests/perf/performance-budget.test.ts',
          ],
          hookTimeout: 120_000,
          testTimeout: 120_000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
