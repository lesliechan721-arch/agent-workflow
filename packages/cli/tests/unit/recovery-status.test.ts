import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRecoveryStatus, statusFromObservations, type NativeObservation } from '../../src/recovery/status.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
import type { ScopeContext } from '../../src/intent/scope-context.js';
import * as portableRecovery from '../../src/portable/recovery.js';
import * as demandService from '../../src/recovery/demand.js';
import { SkillsCliError } from '../../src/portable/skills-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const context = { scope: 'user', executionCwd: '/tmp/aw-status', env: {},
  dispose: async () => undefined } as ScopeContext;

function demand(ids: string[], agents: Array<'codex' | 'claude-code'>): DemandSnapshot {
  return {
    scope: 'user', intent: { state: 'valid', value: { schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { local: { logicalIdentity: 'local' } }, roots: ids.map((pluginId) => ({ pluginId })) },
      digest: 'sha256:test', rawDigest: 'sha256:test', rawBytes: Buffer.from('{}') },
    preferences: { state: 'valid', value: { schemaVersion: 1, kind: 'aw-deployment-preferences',
      agents, dependencyScopeOverrides: [] }, digest: 'sha256:test', rawDigest: 'sha256:test', rawBytes: Buffer.from('{}') },
    roots: ids.map((pluginId) => ({ pluginId, sourceId: 'local', sourceState: 'ready' as const,
      blockers: [], plugin: { manifest: { name: pluginId.split('/')[1],
        marketplace: { policy: { products: ['CLAUDE'] } }, skills: './skills' } } as never })),
    plugins: [], errors: [],
  };
}

describe('recovery status satisfaction', () => {
  afterEach(() => vi.restoreAllMocks());

  // Test Value Gate: status must preserve a cleanup failure even when the observation also cancels its signal.
  it.each([false, true])('propagates Portable cleanup failure with cancellation %s', async (cancelled) => {
    const snapshot = demand(['local/one'], ['claude-code']);
    snapshot.roots![0]!.plugin!.manifest = { name: 'one', marketplace: { policy: { products: ['CODEX'] } },
      distributions: { agentSkills: { sourceDirs: ['./skills'] } } } as never;
    const abort = new AbortController();
    const failure = new SkillsCliError('portableSkillsCliCleanupFailed', 'child exit unconfirmed');
    vi.spyOn(portableRecovery, 'inspectPortableRecovery').mockImplementation(async () => {
      if (cancelled) abort.abort();
      throw failure;
    });
    await expect(statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: snapshot, nativeObservations: [], signal: abort.signal })).rejects.toBe(failure);
  });

  // Test Value Gate: cancellation must escape the status fallback and stop observation of later roots.
  it('propagates Portable inventory cancellation without observing later roots', async () => {
    const snapshot = demand(['local/one', 'local/two'], ['claude-code']);
    for (const root of snapshot.roots!) root.plugin!.manifest = { name: root.plugin!.manifest.name,
      marketplace: { policy: { products: ['CODEX'] } },
      distributions: { agentSkills: { sourceDirs: ['./skills'] } } } as never;
    const abort = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery').mockImplementation(async (options) => {
      observedSignal = options.signal;
      abort.abort();
      throw new DOMException('cancelled', 'AbortError');
    });
    await expect(statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: snapshot, nativeObservations: [], signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(abort.signal);
    expect(inspect).toHaveBeenCalledOnce();
  });

  // Test Value Gate: the operation cwd must remain available until a pending Portable observation ends, including cancellation.
  it('keeps the scoped status context until Portable observation cancellation settles', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const snapshot = demand(['local/one', 'local/two'], ['claude-code']);
    for (const root of snapshot.roots!) root.plugin!.manifest = { name: root.plugin!.manifest.name,
      marketplace: { policy: { products: ['CODEX'] } },
      distributions: { agentSkills: { sourceDirs: ['./skills'] } } } as never;
    vi.spyOn(demandService, 'readDemand').mockResolvedValue(snapshot);
    let finish: ((value: portableRecovery.PortablePreparation) => void) | undefined;
    let observedCwd: string | undefined;
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery').mockImplementation(async (options) => {
      observedCwd = options.context.executionCwd;
      return new Promise((resolve) => { finish = resolve; });
    });
    const abort = new AbortController();
    const read = readRecoveryStatus({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeObservations: [], signal: abort.signal });
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(await fs.pathExists(observedCwd!)).toBe(true);
      abort.abort();
    } finally {
      abort.abort();
      finish!({ targets: [], blockers: [] } as unknown as portableRecovery.PortablePreparation);
      await rejected;
    }
    expect(await fs.pathExists(observedCwd!)).toBe(false);
    expect(inspect).toHaveBeenCalledOnce();
  });
  it('treats a valid empty demand as satisfied and an unselected demand as unknown', async () => {
    const empty = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand([], []), nativeObservations: [] });
    expect(empty.allSatisfied).toBe(true);
    const unselected = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand(['local/one'], []), nativeObservations: [] });
    expect(unselected.counts.blocked).toBe(1);
    expect(unselected.allSatisfied).toBeNull();
  });

  it('reports incomplete Portable coverage when extra installation observation is unavailable', async () => {
    const status = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand([], []), nativeObservations: [], portableCoverage: false });
    expect(status.coverage).toEqual({ native: true, portable: false });
  });

  it('keeps a known missing target false when another target is unknown', async () => {
    const observations: NativeObservation[] = [
      { pluginId: 'local/one', platform: 'claude', content: 'absent', blockers: [] },
      { pluginId: 'local/two', platform: 'claude', content: 'unknown', blockers: [] },
    ];
    const status = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand(['local/one', 'local/two'], ['claude-code']), nativeObservations: observations });
    expect(status.allSatisfied).toBe(false);
    expect(status.counts).toEqual({ blocked: 0, unconfirmed: 1, pending: 1, ready: 0 });
    expect(status.ok).toBe(true);
  });

  it.each(['sourceUnavailable', 'sourceActiveUnavailable', 'pluginManifestUnavailable'])(
    'keeps an unobservable delivery unknown for %s', async (code) => {
      const snapshot = demand(['local/one'], ['claude-code']);
      snapshot.roots![0] = { pluginId: 'local/one', sourceId: 'local', sourceState: 'unavailable',
        blockers: [code] };
      const status = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
        demand: snapshot, nativeObservations: [] });
      expect(status.allSatisfied).toBeNull();
      expect(status.counts).toEqual({ blocked: 1, unconfirmed: 0, pending: 0, ready: 0 });
      expect(status.inventory![0]!.targetResults).toEqual([expect.objectContaining({
        delivery: null, content: 'unknown', observation: 'unknown',
        blockers: [expect.objectContaining({ code })],
      })]);
    });

  it.each(['absent', 'conflict', 'unsupported'] as const)(
    'keeps a definite %s failure false beside an unobservable delivery', async (failure) => {
      const snapshot = demand(['local/one', 'local/two'], [failure === 'unsupported' ? 'codex' : 'claude-code']);
      snapshot.roots![1] = { pluginId: 'local/two', sourceId: 'local', sourceState: 'unavailable',
        blockers: ['sourceActiveUnavailable'] };
      const status = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
        demand: snapshot, nativeObservations: failure === 'unsupported' ? [] : [
          { pluginId: 'local/one', platform: 'claude', content: failure, blockers: [] },
        ] });
      expect(status.allSatisfied).toBe(false);
      if (failure === 'unsupported') expect(status.inventory![0]!.targetResults[0]!.blockers)
        .toEqual([expect.objectContaining({ code: 'deliveryUnsupported' })]);
    });
});
