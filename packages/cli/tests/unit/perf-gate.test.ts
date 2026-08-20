import { describe, expect, it } from 'vitest';

import {
  assertExpectedPerfSummaries,
  EXPECTED_PERF_SUMMARY_NAMES,
} from '../../../../scripts/perf/run-perf-gate.mjs';

function summary(name: string): string {
  return `AW_PERF_SUMMARY ${JSON.stringify({ name, samples: 1 })}`;
}

describe('performance gate summaries', () => {
  it('requires the exact performance budget name set', () => {
    const output = EXPECTED_PERF_SUMMARY_NAMES.map(summary).join('\n');
    expect(() => assertExpectedPerfSummaries(output)).not.toThrow();
    expect(() => assertExpectedPerfSummaries('')).toThrow(/missing=/u);
    expect(() => assertExpectedPerfSummaries(
      EXPECTED_PERF_SUMMARY_NAMES.slice(1).map(summary).join('\n'),
    )).toThrow(/path-source-resolution-warm/u);
    expect(() => assertExpectedPerfSummaries(`${output}\n${summary('unknown-budget')}`))
      .toThrow(/unexpected=unknown-budget/u);
    expect(() => assertExpectedPerfSummaries(`${output}\n${summary(EXPECTED_PERF_SUMMARY_NAMES[0]!)}`))
      .toThrow(/duplicates=path-source-resolution-warm/u);
  });
});
