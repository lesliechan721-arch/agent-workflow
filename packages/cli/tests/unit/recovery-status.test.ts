import { describe, expect, it } from 'vitest';

import { statusFromObservations, type NativeObservation } from '../../src/recovery/status.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
import type { ScopeContext } from '../../src/intent/scope-context.js';

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
        marketplace: { policy: { products: ['CLAUDE'] } } } } as never })),
    plugins: [], errors: [],
  };
}

describe('recovery status satisfaction', () => {
  it('treats a valid empty demand as satisfied and an unselected demand as unknown', async () => {
    const empty = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand([], []), nativeObservations: [] });
    expect(empty.allSatisfied).toBe(true);
    const unselected = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: demand(['local/one'], []), nativeObservations: [] });
    expect(unselected.counts.blocked).toBe(1);
    expect(unselected.allSatisfied).toBeNull();
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
