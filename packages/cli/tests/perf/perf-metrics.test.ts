import { describe, expect, it } from 'vitest';

import { nearestRankPercentile } from './perf-metrics.js';

describe('performance metrics', () => {
  it('uses nearest-rank percentiles for quantity budgets', () => {
    const samples = Array.from({ length: 20 }, (_value, index) => index + 1).reverse();

    expect(nearestRankPercentile(samples, 50)).toBe(10);
    expect(nearestRankPercentile(samples, 95)).toBe(19);
  });
});
