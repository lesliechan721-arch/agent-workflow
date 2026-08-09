import { describe, expect, it } from 'vitest';

import {
  createPerfSummary,
  nearestRankPercentile,
  PERF_SUMMARY_PREFIX,
} from './perf-metrics.js';

describe('performance metrics', () => {
  it('uses the nearest-rank percentile contract and emits stable summary fields', () => {
    const samples = Array.from({ length: 20 }, (_value, index) => index + 1);

    expect(nearestRankPercentile(samples, 50)).toBe(10);
    expect(nearestRankPercentile(samples, 95)).toBe(19);
    expect(createPerfSummary('sample-budget', samples, 25)).toEqual({
      name: 'sample-budget',
      samples: 20,
      p50Ms: 10,
      p95Ms: 19,
      maxMs: 20,
      budgetMs: 25,
    });
    expect(`${PERF_SUMMARY_PREFIX}${JSON.stringify(createPerfSummary('sample-budget', samples, 25))}`)
      .toMatch(/^AW_PERF_SUMMARY \{"name":"sample-budget","samples":20,/u);
  });
});
