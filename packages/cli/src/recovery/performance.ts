import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';

/** Debug events contain stage labels and durations, never recovery inputs. */
export async function recordRecoveryPerformanceStage(
  runtime: RebuildCommandRuntime,
  name: string,
  phase: 'start' | 'success' | 'failure',
  startedAt: number,
): Promise<void> {
  await Promise.resolve().then(() => runtime.debugLogger?.log({
    type: 'performance:stage',
    level: 'debug',
    target: 'debugLog',
    message: 'Recovery performance stage.',
    data: { name, phase, durationMs: Math.round(performance.now() - startedAt) },
  })).catch(() => undefined);
}

export async function measureRecoveryPerformanceStage<T>(
  runtime: RebuildCommandRuntime,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  await recordRecoveryPerformanceStage(runtime, name, 'start', startedAt);
  let phase: 'success' | 'failure' = 'success';
  try {
    return await operation();
  } catch (error) {
    phase = 'failure';
    throw error;
  } finally {
    await recordRecoveryPerformanceStage(runtime, name, phase, startedAt);
  }
}
