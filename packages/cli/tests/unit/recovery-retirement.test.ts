import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  inspect: vi.fn(), execute: vi.fn(), portable: vi.fn(), resetConfig: vi.fn(),
}));
vi.mock('../../src/commands/rebuild-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-command.js')>(),
  inspectRemovedPluginCleanup: backend.inspect,
  executeRemovedPluginOutputCleanup: backend.execute,
}));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: backend.portable,
}));
vi.mock('../../src/utils/plugin-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/plugin-config.js')>(),
  resetPluginConfigStore: backend.resetConfig,
}));

import { executeRetire, prepareRetire, runRetire } from '../../src/recovery/retirement.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function removedEvidence() {
  return { pluginId: 'local/demo', pluginName: 'demo', sourceId: 'local',
    sourceIdentity: 'sha256:source', logicalIdentity: 'sha256:logical', snapshotDigest: 'sha256:snapshot',
    marketplaceRoot: '/tmp/marketplace', nativeOwnershipVerified: false,
    projectionOwnershipVerified: false, claudeNativeCleanupBlocked: false, nativeState: 'absent',
    nativeObservationFingerprint: 'native', marketplaceEvidenceFingerprint: 'market',
    projectionFingerprint: 'projection', projectionPresent: false, activationScopes: [],
    configTargets: [], evidence: [], blockers: [] };
}
function location() {
  const isolation = getCurrentSourceTestIsolation();
  return { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
}

beforeEach(() => {
  backend.inspect.mockReset().mockImplementation(async () => removedEvidence());
  backend.execute.mockReset();
  backend.portable.mockReset().mockResolvedValue({ state: 'absent', targets: [], blockers: [] });
  backend.resetConfig.mockReset();
});

describe('retire strong state and residue', () => {
  it('does not start a noninteractive retirement without Review authorization', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const result = await runRetire({ ...options, selector: 'local/demo' }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewRequired' }),
    ]));
    expect((await observeIntent(options)).value.roots).toEqual([{ pluginId: 'local/demo' }]);
  });

  it('keeps a declared root and override when the healthy Active belongs to another logical source', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:old-source');
    await writePreferences(options, { schemaVersion: 1, kind: 'aw-deployment-preferences', agents: [],
      dependencyScopeOverrides: [{ pluginId: 'local/demo', platform: 'codex', scope: 'user' }] });
    const beforeIntent = await observeIntent(options);
    const beforePreferences = await observePreferences(options);

    const result = await runRetire({ ...options, selector: 'local/demo', targets: ['codex'], yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });

    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'removedPluginIntentSourceMismatch' }),
    ]));
    expect(result).toMatchObject({ ok: false, declarationChanged: false,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false });
    expect(await observeIntent(options)).toEqual(beforeIntent);
    expect(await observePreferences(options)).toEqual(beforePreferences);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('preserves config by default, reports Portable residue, and keeps retry available after root removal', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const configPath = resolvePluginConfigStorePath({ ...options, sourceId: 'local', pluginName: 'demo' });
    await fs.outputFile(configPath, 'saved config bytes');
    backend.portable.mockResolvedValue({ state: 'present', blockers: [], targets: [
      { skill: 'demo', agent: 'cursor', physicalPath: path.join(options.cwd, 'portable-demo') },
    ] });
    const runtime = { inventoryCatalogSourceReferences: async () =>
      ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) };
    const first = await runRetire({ ...options, selector: 'local/demo', targets: ['cursor'], yes: true }, runtime);
    expect(first.declarationChanged).toBe(true);
    expect(first.configChanged).toBe(false);
    expect(first.ok).toBe(false);
    expect(first.remainingTargets).toEqual([expect.objectContaining({ pluginId: 'local/demo', agent: 'cursor' })]);
    expect((await observeIntent(options)).state).toBe('valid');
    expect((await observeIntent(options)).value.roots).toEqual([]);
    expect(await fs.readFile(configPath, 'utf8')).toBe('saved config bytes');
    const second = await runRetire({ ...options, selector: 'local/demo', targets: ['cursor'], yes: true }, runtime);
    expect(second.declarationChanged).toBe(false);
    expect(second.remainingTargets).toEqual(first.remainingTargets);
    backend.portable.mockResolvedValue({ state: 'absent', targets: [], blockers: [] });
    const cleared = await runRetire({ ...options, selector: 'local/demo', targets: ['cursor'] }, runtime);
    expect(cleared).toMatchObject({ ok: true, declarationChanged: false, preferencesChanged: false,
      configChanged: false, outputsMayHaveChanged: false, remainingTargets: [],
      targetResults: [expect.objectContaining({ agent: 'cursor', execution: 'no-op',
        observation: 'missing', content: 'absent', blockers: [] })] });
    expect(await fs.readFile(configPath, 'utf8')).toBe('saved config bytes');
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('reviews only observed strong-state changes before retirement writes', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    await writePreferences(options, { schemaVersion: 1, kind: 'aw-deployment-preferences', agents: [],
      dependencyScopeOverrides: [{ pluginId: 'local/demo', platform: 'codex', scope: 'user' }] });
    backend.inspect.mockImplementation(async () => ({ ...removedEvidence(),
      configTargets: [{ scope: 'user', kind: 'file', fingerprint: 'sha256:config' }] }));
    const runtime = { inventoryCatalogSourceReferences: async () =>
      ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) };
    const plan = await prepareRetire({ ...options, selector: 'local/demo', deleteConfig: true }, runtime);
    expect(plan.plannedImpact).toEqual({ declaration: true, preferences: true, config: true, outputs: false });
    await plan.context.dispose();
    const noRoot = await prepareRetire({ ...options, selector: 'local/demo' }, runtime);
    expect(noRoot.plannedImpact).toEqual({ declaration: true, preferences: true, config: false, outputs: false });
    await noRoot.context.dispose();
  });

  it('stops output cleanup after an optional config deletion fails, keeping prior commits visible', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    await writePreferences(options, { schemaVersion: 1, kind: 'aw-deployment-preferences', agents: [],
      dependencyScopeOverrides: [{ pluginId: 'local/demo', platform: 'codex', scope: 'user' }] });
    backend.resetConfig.mockRejectedValue(new Error('configResetTargetUnsupported: unsafe node'));
    const result = await runRetire({ ...options, selector: 'local/demo', deleteConfig: true, yes: true,
      targets: ['codex'] }, { inventoryCatalogSourceReferences: async () =>
      ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) });
    expect(result).toMatchObject({ ok: false, declarationChanged: true, preferencesChanged: true,
      configChanged: false, outputsMayHaveChanged: false });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'configResetTargetUnsupported' }),
    ]));
    expect(result.intent.roots).toEqual([]);
    expect((await observePreferences(options)).value.dependencyScopeOverrides).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it.each(['codex', 'cursor'] as const)('retires the declared scope when %s observation is unknown and leaves exact output cleanup retryable', async (agent) => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    backend.portable.mockResolvedValue({ state: 'unknown', targets: [], blockers: ['portableObservationFailed'] });
    backend.execute.mockResolvedValue({ overallState: 'succeeded', rebuildResults: [], targetResults: [],
      platforms: [], plugins: [], warnings: [], receiptTargets: [] });
    const result = await runRetire({ ...options, selector: 'local/demo', targets: [agent], yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });
    expect(result.declarationChanged).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.remainingTargets).toEqual([expect.objectContaining({ pluginId: 'local/demo', agent })]);
    expect(result.targetResults[0]?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'portableObservationFailed' }),
    ]));
    expect(backend.execute).toHaveBeenCalledTimes(agent === 'codex' ? 1 : 0);
    expect((await observeIntent(options)).value.roots).toEqual([]);
  });

  it('does not turn retained shared Native content into a verified absence', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    backend.inspect.mockImplementation(async () => ({ ...removedEvidence(), nativeState: 'installed' }));
    backend.execute.mockResolvedValue({ overallState: 'partial', rebuildResults: [],
      targetResults: [{ target: { pluginId: 'local/demo', pluginName: 'demo',
        platform: 'codex', scope: 'user' }, action: 'keep', state: 'completed' }],
      platforms: ['codex'], plugins: ['local/demo'], warnings: [], receiptTargets: [] });

    const result = await runRetire({ ...options, selector: 'local/demo', targets: ['codex'], yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });

    expect(result.targetResults).toEqual([expect.objectContaining({
      agent: 'codex', execution: 'applied', observation: 'unknown', content: 'unknown',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'sharedNativePreserved' })]),
    })]);
  });

  it('attributes a partial Native retirement only to the target that retained output', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    backend.inspect.mockImplementation(async () => ({ ...removedEvidence(), nativeState: 'installed' }));
    backend.execute.mockResolvedValue({ overallState: 'partial',
      rebuildResults: [
        { status: 'succeeded', command: 'cleanup', target: { pluginId: 'local/demo', pluginName: 'demo',
          platform: 'codex', scope: 'user' }, actions: [], cleanupAttempted: true,
          removed: [], absent: [], residual: ['shared-native'], quarantined: [], failures: [] },
        { status: 'succeeded', command: 'cleanup', target: { pluginId: 'local/demo', pluginName: 'demo',
          platform: 'claude', scope: 'user' }, actions: [], cleanupAttempted: true,
          removed: ['claude-output'], absent: [], residual: [], quarantined: [], failures: [] },
      ],
      targetResults: [
        { target: { pluginId: 'local/demo', pluginName: 'demo', platform: 'codex', scope: 'user' },
          action: 'keep', state: 'completed' },
        { target: { pluginId: 'local/demo', pluginName: 'demo', platform: 'claude', scope: 'user' },
          action: 'cleanup', state: 'completed' },
      ],
      platforms: ['codex', 'claude'], plugins: ['local/demo'], warnings: [], receiptTargets: [] });

    const result = await runRetire({ ...options, selector: 'local/demo',
      targets: ['codex', 'claude-code'], yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });

    expect(result.remainingTargets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', agent: 'codex' }),
    ]);
    expect(result.targetResults.find((target) => target.agent === 'codex')?.blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'sharedNativePreserved' })]));
    expect(result.targetResults.find((target) => target.agent === 'claude-code')).toMatchObject({
      execution: 'applied', blockers: [],
    });
  });

  it.each([{ targets: undefined }, { targets: ['cursor'] }])('returns a no-op for a fully absent removed plugin with targets $targets without requiring confirmation', async ({ targets }) => {
    const options = location();
    const result = await runRetire({ ...options, selector: 'local/demo', targets }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });
    expect(result).toMatchObject({ ok: true, declarationChanged: false, preferencesChanged: false,
      configChanged: false, outputsMayHaveChanged: false });
    expect(result.remainingTargets).toEqual([]);
    if (targets) expect(result.targetResults).toEqual([expect.objectContaining({
      agent: 'cursor', execution: 'no-op', observation: 'missing', content: 'absent', blockers: [],
    })]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('keeps declaration authorization separate from an absent Cursor output', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const runtime = { inventoryCatalogSourceReferences: async () =>
      ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) };
    const request = { ...options, selector: 'local/demo', targets: ['cursor'] };
    const cancelled = await runRetire(request, runtime);
    expect(cancelled).toMatchObject({ ok: false, declarationChanged: false,
      blockers: [expect.objectContaining({ code: 'operationReviewRequired' })] });
    expect((await observeIntent(options)).value.roots).toEqual([{ pluginId: 'local/demo' }]);
    const retired = await runRetire({ ...request, yes: true }, runtime);
    expect(retired).toMatchObject({ ok: true, declarationChanged: true, outputsMayHaveChanged: false,
      remainingTargets: [], targetResults: [expect.objectContaining({ agent: 'cursor', execution: 'no-op' })] });
    expect((await observeIntent(options)).value.roots).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('rejects an added User execution cwd marker before retirement writes', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const plan = await prepareRetire({ ...options, selector: 'local/demo', yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });
    await fs.outputFile(path.join(plan.context.executionCwd, '.codex'), 'new local config marker');

    const result = await executeRetire(plan);

    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(result.declarationChanged).toBe(false);
    expect((await observeIntent(options)).value.roots).toEqual([{ pluginId: 'local/demo' }]);
    expect(backend.execute).not.toHaveBeenCalled();
  });
});
