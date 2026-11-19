import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInstallAdmission, limitInstallNativeRunner, mapInstallReads, runInstallTasks,
  type InstallResource } from '../../src/recovery/install-concurrency.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

describe('operation-local install concurrency', () => {
  it('admits disjoint resource paths past a blocked ancestor and drains dependencies in receipt order', async () => {
    const root = getCurrentSourceTestIsolation().env.AW_HOME!;
    const packagePath = path.join(root, 'package');
    await fs.mkdir(packagePath, { recursive: true });
    const alias = path.join(root, 'alias');
    await fs.symlink(packagePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = gate();
    const unrelated = gate();
    const started: string[] = [];
    const write = (value: string): InstallResource => ({ kind: 'path', value });
    const result = runInstallTasks([
      { id: 'owner', resources: [write(packagePath)], run: async () => { started.push('owner'); await owner.wait; return 'one'; } },
      { id: 'dependent', dependencies: ['publish'], resources: [], run: async () => { started.push('dependent'); return 'two'; } },
      { id: 'publish', resources: [write(path.join(alias, 'child'))], run: async () => { started.push('publish'); return 'three'; } },
      { id: 'unrelated', resources: [write(packagePath + '-other')], run: async () => { started.push('unrelated'); unrelated.open(); return 'four'; } },
    ], { limit: 2 });
    await unrelated.wait;
    expect(started).toEqual(['owner', 'unrelated']);
    owner.open();
    expect(await result).toEqual(['one', 'two', 'three', 'four']);
    expect(started).toEqual(['owner', 'unrelated', 'publish', 'dependent']);
  });

  it('shares reads, excludes an opaque script, and invalidates its inputs even when it fails', async () => {
    const admission = createInstallAdmission({ limit: 3 });
    const release = gate();
    const starts: string[] = [];
    const registry = { kind: 'key', value: 'client-registry', access: 'read' } as const;
    const reads = [1, 2].map((number) => admission.run([registry], async () => {
      starts.push(`read${number}`); await release.wait;
    }));
    const script = admission.run([{ kind: 'exclusive' }], async () => { starts.push('script'); throw new Error('hook failed'); });
    const outcome = expect(script).rejects.toThrow('hook failed');
    expect(starts).toEqual(['read1', 'read2']);
    release.open();
    await Promise.all([...reads, outcome]);
    expect(admission.exclusiveGeneration).toBe(1);
    expect(starts).toEqual(['read1', 'read2', 'script']);
  });

  it('rejects an invalid dependency graph before starting any write', async () => {
    const run = vi.fn(async () => 1);
    await expect(runInstallTasks([{ id: 'first', resources: [], run },
      { id: 'cycle', dependencies: ['cycle'], resources: [], run }])).rejects.toThrow('dependencyContractInvalid');
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['processCleanupUnconfirmed', 'pluginProcessCleanupFailed'])('drains a started sibling and preserves %s after interruption', async (code) => {
    const controller = new AbortController();
    const entered = gate();
    const release = gate();
    const started: number[] = [];
    const error = attachSafeOperationError(new Error('cleanup unconfirmed'),
      { code, safeMessage: 'Process cleanup could not be confirmed.' });
    const finish = vi.fn();
    const operation = mapInstallReads([1, 2, 3], async (number) => {
      started.push(number);
      if (number === 1) { await entered.wait; controller.abort(); return; }
      entered.open(); await release.wait; throw error;
    }, { signal: controller.signal, limit: 2 }).finally(finish);
    await entered.wait;
    expect(finish).not.toHaveBeenCalled();
    release.open();
    await expect(operation).rejects.toBe(error);
    expect(started).toEqual([1, 2]);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('stops dispatching dependents when an in-flight task is interrupted', async () => {
    const controller = new AbortController();
    const confirmed = gate();
    const cancelled = vi.fn(async () => 'unexpected');
    const verified = vi.fn(async () => 'verified');
    const operation = runInstallTasks([
      { id: 'ready', resources: [], run: verified },
      { id: 'active', resources: [], dependencies: ['ready'], run: async () => {
        confirmed.open();
        await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
        controller.signal.throwIfAborted();
        return 'unexpected';
      } },
      { id: 'waiting', resources: [], dependencies: ['active'], run: cancelled },
    ], { signal: controller.signal });
    await confirmed.wait;
    controller.abort();
    await expect(operation).rejects.toBe(controller.signal.reason);
    expect(verified).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('shares one actual subprocess budget, cancels a queued invocation, and reuses a slot after a failure', async () => {
    const release = gate();
    const started: string[] = [];
    const limited = limitInstallNativeRunner(async ({ command }) => {
      started.push(command);
      if (command === 'probe') { await release.wait; throw new Error('probe error'); }
      return { exitCode: 0, stdout: command, stderr: '' };
    }, 1);
    expect(limitInstallNativeRunner(limited)).toBe(limited);
    const first = expect(limited({ command: 'probe', args: [] })).rejects.toThrow('probe error');
    const controller = new AbortController();
    const cancelled = expect(limited({ command: 'cancelled', args: [], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const last = limited({ command: 'last', args: [] });
    controller.abort(); await cancelled;
    expect(started).toEqual(['probe']);
    release.open(); await first;
    expect((await last).stdout).toBe('last');
    expect(started).toEqual(['probe', 'last']);
  });
});
