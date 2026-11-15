import fs from 'fs-extra';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readScopedRecoveryStatus, statusFromObservations, type NativeObservation } from '../../src/recovery/status.js';
import type { AgentId } from '../../src/intent/deployment-preferences.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
import type { ScopeContext } from '../../src/intent/scope-context.js';
import * as portableRecovery from '../../src/portable/recovery.js';
import * as demandService from '../../src/recovery/demand.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const context = { scope: 'user', executionCwd: '/tmp/aw-status', env: {},
  dispose: async () => undefined } as ScopeContext;

function demand(ids: string[], targets: AgentId[]): DemandSnapshot {
  return {
    scope: 'user', intent: { state: 'valid', value: { schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { local: { logicalIdentity: 'local' } }, roots: ids.map((pluginId) => ({ pluginId })) },
      digest: 'sha256:test', rawDigest: 'sha256:test', rawBytes: Buffer.from('{}') },
    preferences: { state: 'valid', value: { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets, exclusions: [] }, digest: 'sha256:test', rawDigest: 'sha256:test', rawBytes: Buffer.from('{}') },
    roots: ids.map((pluginId) => ({ pluginId, sourceId: 'local', sourceState: 'ready' as const,
      blockers: [], plugin: { manifest: { name: pluginId.split('/')[1],
        platforms: ['claude', 'cursor', 'generic'], skills: './skills' } } as never })),
    plugins: [], errors: [],
  };
}

describe('recovery status satisfaction', () => {
  afterEach(() => vi.restoreAllMocks());

  // Test Value Gate: cancellation must escape the status fallback and stop observation of later roots.
  it('propagates Portable inventory cancellation without observing later roots', async () => {
    const snapshot = demand(['local/one', 'local/two'], ['generic']);
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
    const snapshot = demand(['local/one', 'local/two'], ['generic']);
    vi.spyOn(demandService, 'readDemand').mockResolvedValue(snapshot);
    let finish: ((value: portableRecovery.PortablePreparation) => void) | undefined;
    let observedCwd: string | undefined;
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery').mockImplementation(async (options) => {
      observedCwd = options.context.executionCwd;
      return new Promise((resolve) => { finish = resolve; });
    });
    const abort = new AbortController();
    const read = readScopedRecoveryStatus({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
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
      demand: demand(['local/one', 'local/two'], ['claude']), nativeObservations: observations });
    expect(status.allSatisfied).toBe(false);
    expect(status.counts).toEqual({ blocked: 0, unconfirmed: 1, pending: 1, ready: 0 });
    expect(status.ok).toBe(true);
  });

  // Test Value Gate: a live package cannot prove the current complete dynamic set without matching preparation evidence.
  it.each(['satisfied', 'absent'] as const)('keeps dynamic expectations unknown beside a %s package', async (content) => {
    const snapshot = demand(['local/one'], ['cursor']);
    snapshot.roots![0]!.plugin!.manifest.artifacts = { configKeys: [] };
    const status = await statusFromObservations({ scope: 'user', cwd: '/tmp/aw-status', context,
      demand: snapshot, nativeObservations: [{ pluginId: 'local/one', platform: 'cursor', content, blockers: [] }] });
    expect(status.allSatisfied).toBeNull();
    expect(status.inventory![0]!.targetResults[0]).toMatchObject({
      delivery: { kind: 'native', platform: 'cursor' }, content: 'unknown', observation: 'unknown',
      blockers: [expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' })],
    });
  });

  // Test Value Gate: normal status must observe a concrete Agent through its native adapter without executing plugin code.
  it('observes a dynamic Cursor requirement without running its renderer or creating generic output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'dynamic-plugin');
    const bin = path.join(isolation.layout.fixtureCwd, 'bin');
    const marker = path.join(rootDir, 'renderer-ran');
    await fs.ensureDir(rootDir);
    await fs.ensureDir(bin);
    await fs.writeFile(path.join(bin, 'cursor-agent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(rootDir, 'render.mjs'), 'import fs from "node:fs"; fs.writeFileSync("renderer-ran", "ran"); throw new Error("status must not render");\n');
    const snapshot = demand(['local/one'], ['cursor']);
    const plugin = snapshot.roots![0]!.plugin!;
    Object.assign(plugin, { rootDir, sourceId: 'local', pluginId: 'local/one', sourceIdentity: `sha256:${'a'.repeat(64)}` });
    Object.assign(plugin.manifest, { schemaVersion: 4, version: '1.0.0',
      artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } });
    delete plugin.manifest.skills;
    snapshot.plugins = [plugin];
    const invocations: string[][] = [];
    const status = await readScopedRecoveryStatus({ scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: bin }, demandOverride: snapshot, nativeCliRunner: async ({ command, args }) => {
        invocations.push([path.basename(command), ...args]);
        return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      } });
    expect(invocations).toContainEqual(['cursor-agent', '--version']);
    expect(status.inventory![0]!.targetResults[0]).toMatchObject({
      delivery: { kind: 'native', platform: 'cursor' }, content: 'unknown',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' })]),
      deploymentObservations: [expect.objectContaining({
        products: [expect.objectContaining({ product: 'cli', version: '2026.11.05-86047df' })],
        after: expect.objectContaining({ package: 'absent', nativeIdentity: expect.objectContaining({ route: 'cursor-workspace-hook' }) }),
      })],
    });
    expect(await fs.pathExists(marker)).toBe(false);
    expect(await fs.pathExists(path.join(isolation.env.HOME!, '.agents', 'skills'))).toBe(false);
  });

  it.each(['sourceUnavailable', 'sourceActiveUnavailable', 'pluginManifestUnavailable'])(
    'keeps an unobservable delivery unknown for %s', async (code) => {
      const snapshot = demand(['local/one'], ['claude']);
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
      const snapshot = demand(['local/one', 'local/two'], [failure === 'unsupported' ? 'codex' : 'claude']);
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

// Test Value Gate: requesting a status snapshot callback must not activate the retired Native backend.
describe('current observer callbacks', () => {
  it('returns the same scoped current snapshot without starting a legacy Native read', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const snapshot = demand(['local/one'], ['cursor']);
    const callback = vi.fn();
    const runner = vi.fn(async () => { throw new Error('No external read is expected for supplied observations.'); });
    const status = await readScopedRecoveryStatus({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      demandOverride: snapshot, nativeObservations: [{ pluginId: 'local/one', platform: 'cursor', content: 'satisfied', blockers: [] }],
      nativeCliRunner: runner, onNativeStatus: callback });
    expect(status.kind).toBe('aw-recovery-status');
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(status, snapshot);
    expect(runner).not.toHaveBeenCalled();
  });
});
