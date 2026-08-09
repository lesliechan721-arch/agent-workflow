export const PERF_SUMMARY_PREFIX = 'AW_PERF_SUMMARY ';

export interface PerfSummary {
  name: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;
}

export function nearestRankPercentile(
  samples: readonly number[],
  percentile: number,
): number {
  if (samples.length === 0) {
    throw new Error('Cannot calculate a percentile without samples.');
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error(`Percentile must be in (0, 100], received ${percentile}.`);
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index]!;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createPerfSummary(
  name: string,
  samples: readonly number[],
  budgetMs: number,
): PerfSummary {
  return {
    name,
    samples: samples.length,
    p50Ms: roundMilliseconds(nearestRankPercentile(samples, 50)),
    p95Ms: roundMilliseconds(nearestRankPercentile(samples, 95)),
    maxMs: roundMilliseconds(Math.max(...samples)),
    budgetMs,
  };
}

export function printPerfSummary(summary: PerfSummary): void {
  console.log(`${PERF_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
}
