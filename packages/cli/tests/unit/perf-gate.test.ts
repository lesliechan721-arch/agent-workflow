import { describe, expect, it } from 'vitest';

import {
  assertExpectedPerfSummaries,
  EXPECTED_PERF_SUMMARY_NAMES,
  runPerfGate,
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

  it('runs the fast unit lane directly under the performance gate process owner', async () => {
    const calls: Array<{ label: string; args: string[]; timeoutMs: number }> = [];
    const times = [100, 125];
    const logs: string[] = [];
    await runPerfGate({
      runChild: async (label: string, args: string[], timeoutMs: number) => {
        calls.push({ label, args, timeoutMs });
        return {
          stdout: label === 'performance Vitest'
            ? EXPECTED_PERF_SUMMARY_NAMES.map(summary).join('\n')
            : '',
        };
      },
      now: () => times.shift()!,
      log: (text: string) => logs.push(text),
    });

    expect(calls[1]).toMatchObject({
      label: 'fast unit lane',
      args: [
        '--filter',
        '@lesliechan721/aw',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.fast.config.ts',
      ],
    });
    expect(logs).toEqual([
      'AW_PERF_SUMMARY {"name":"unit-fast-wall","samples":1,"p50Ms":25,"p95Ms":25,"maxMs":25,"budgetMs":30000}',
    ]);
  });
});
