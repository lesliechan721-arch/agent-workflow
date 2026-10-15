import { vitestWorkerOptions } from './scripts/test-workers.mjs';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    ...vitestWorkerOptions({ serial: true }),
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
