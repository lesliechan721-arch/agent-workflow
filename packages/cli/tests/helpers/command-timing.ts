import path from 'node:path';

import { vi, type TestContext } from 'vitest';

import type { CommandEvent } from '../../src/output/model.js';
import { defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';

// Keep diagnostics local to the timeout-prone tests. Only fixed labels and
// selected timing fields are logged; command values, paths and errors stay out.
export function createCommandTestTiming(test: TestContext) {
  const startedAt = performance.now();
  let sequence = 0;
  let rendererCalls = 0;
  const active = new Map<number, { stage: string; name: string; startedAt: number }>();
  const emit = (event: Record<string, unknown>) => {
    console.log('AW_TEST_TIMING', JSON.stringify({
      pid: process.pid,
      test: test.task.name,
      testId: test.task.id,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...event,
    }));
  };
  const measure = async <T>(
    stage: string,
    name: string,
    operation: (sequence: number) => Promise<T>,
  ): Promise<T> => {
    const id = ++sequence;
    const start = performance.now();
    active.set(id, { stage, name, startedAt: start });
    emit({ stage, name, sequence: id, event: 'start' });
    let outcome = 'succeeded';
    try {
      return await operation(id);
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      active.delete(id);
      emit({ stage, name, sequence: id, event: 'finish', outcome,
        durationMs: Math.round(performance.now() - start) });
    }
  };
  const commandEvent = (commandSequence: number, event: CommandEvent): void => {
    if (!['performance:stage', 'rebuild:action', 'native:start', 'native:success', 'native:error', 'command:result'].includes(event.type)) return;
    const data = event.data as Record<string, unknown> | undefined;
    emit({
      stage: event.type,
      commandSequence,
      name: data?.name ?? data?.operation,
      event: data?.phase ?? event.type.slice(event.type.indexOf(':') + 1),
      durationMs: data?.durationMs,
      exitCode: data?.exitCode,
      plugin: event.source?.plugin,
      platform: event.source?.platform,
      scope: event.source?.scope,
    });
  };
  const runRenderer = defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner);
  const rendererSpy = vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation(
    (invocation, options) => {
      rendererCalls += 1;
      return measure('renderer', path.basename(invocation.args[0] ?? invocation.command),
        () => runRenderer(invocation, options));
    },
  );
  test.onTestFinished(() => {
    rendererSpy.mockRestore();
    for (const [id, pending] of active) {
      emit({ stage: pending.stage, name: pending.name, sequence: id, event: 'unfinished',
        durationMs: Math.round(performance.now() - pending.startedAt) });
    }
  });
  return { measure, commandEvent, get rendererCalls() { return rendererCalls; } };
}
