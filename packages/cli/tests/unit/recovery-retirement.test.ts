import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommandDefinition, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

const backend = vi.hoisted(() => ({
  inspect: vi.fn(), preview: vi.fn(), execute: vi.fn(), portable: vi.fn(), resetConfig: vi.fn(),
}));
vi.mock('../../src/commands/rebuild-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-command.js')>(),
  inspectRemovedPluginCleanup: backend.inspect,
  executeRemovedPluginOutputCleanup: (options: Parameters<typeof import('../../src/commands/rebuild-command.js')['executeRemovedPluginOutputCleanup']>[0]) =>
    options.runtime?.previewOperationPlan ? backend.preview(options) : backend.execute(options),
}));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: backend.portable,
}));
vi.mock('../../src/utils/plugin-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/plugin-config.js')>(),
  deletePluginConfigStore: backend.resetConfig,
}));

import { executeRetire, prepareRetire, runRetire } from '../../src/recovery/retirement.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { resolveManagedCommand, syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';

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
  backend.preview.mockReset().mockResolvedValue(undefined);
  backend.portable.mockReset().mockResolvedValue({ state: 'absent', targets: [], blockers: [] });
  backend.resetConfig.mockReset();
});

describe('retire strong state and residue', () => {
  // Test Value Gate: unavailable locked observations must keep the declaration intact.
  it('keeps the declaration when the locked residue recheck is unavailable', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const runtime = { inventoryCatalogSourceReferences: async () =>
      ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) };
    const plan = await prepareRetire({ ...options, selector: 'local/demo', targets: ['cursor'], yes: true }, runtime);
    const failure = new Error('observation unavailable');
    backend.portable.mockRejectedValue(failure);
    expect((await executeRetire(plan, runtime)).blockers).toContainEqual(expect.objectContaining({ code: 'operationReviewStale' }));
    expect((await observeIntent(options)).value.roots).toEqual([{ pluginId: 'local/demo' }]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

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

  it('keeps a declared root and exclusion when the healthy Active belongs to another logical source', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:old-source');
    await writePreferences(options, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [],
      exclusions: [{ plugin: 'local/demo', target: 'codex' }] });
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

  // Test Value Gate: inferred output targets stay frozen in retries; completed config deletion is not requested again.
  it.each([true, false])('retries only remaining targets after config deletion completes (deleted=%s)', async (deleted) => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const physicalPath = path.join(options.env.HOME!, '.agents', 'skills', 'demo');
    backend.inspect.mockImplementation(async () => ({ ...removedEvidence(), nativeState: 'installed' }));
    backend.portable.mockResolvedValue({ state: 'present', blockers: [], targets: [
      { skill: 'demo', agent: 'cursor', physicalPath },
    ] });
    backend.resetConfig.mockResolvedValue({ deleted });
    backend.execute.mockResolvedValue({ overallState: 'succeeded', rebuildResults: [], targetResults: [],
      platforms: [], plugins: [], warnings: [], receiptTargets: [] });
    const result = await runRetire({ ...options, selector: 'local/demo', deleteConfig: true, yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });
    expect(result).toMatchObject({ ok: false, declarationChanged: true, configChanged: deleted });
    expect(result.recoveryActions).toContain('aw plugin remove local/demo --only outputs --scope user --target cursor');
    expect(result.recoveryActions.some((action) => action.includes(physicalPath) && action.includes('AW 不自动删除')))
      .toBe(true);
    expect(result.recoveryActions.join('\n')).not.toContain('--delete-config');
  });

  it('reviews only observed strong-state changes before retirement writes', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    await writePreferences(options, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [],
      exclusions: [{ plugin: 'local/demo', target: 'codex' }] });
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

  // Test Value Gate: a changed Portable residue must stop retirement before any strong configuration write.
  it.each(['appeared', 'removed', 'association-changed'] as const)(
    'rejects Portable residue that %s after Review', async (change) => {
      const options = location();
      await addRoot(options, 'local/demo', 'sha256:logical');
      await writePreferences(options, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['cursor'],
        exclusions: [{ plugin: 'local/demo', target: 'codex' }] });
      backend.inspect.mockImplementation(async () => ({ ...removedEvidence(),
        configTargets: [{ scope: 'user', kind: 'file', fingerprint: 'sha256:config' }] }));
      const absent = { state: 'absent', targets: [], blockers: [] };
      const present = { state: 'present', targets: [{ skill: 'demo', agent: 'cursor',
        physicalPath: path.join(options.cwd, 'portable-demo') }], blockers: [] };
      const changed = change === 'appeared' ? present : change === 'removed' ? absent
        : { ...present, targets: [{ ...present.targets[0]!, physicalPath: path.join(options.cwd, 'other-demo') }] };
      backend.portable.mockResolvedValueOnce(change === 'appeared' ? absent : present)
        .mockResolvedValueOnce(changed);
      const beforeIntent = await observeIntent(options);
      const beforePreferences = await observePreferences(options);
      const plan = await prepareRetire({ ...options, selector: 'local/demo', targets: ['cursor'],
        deleteConfig: true, yes: true }, { inventoryCatalogSourceReferences: async () =>
          ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }) });

      const result = await executeRetire(plan);

      expect(result.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'operationReviewStale' }),
      ]));
      expect(result).toMatchObject({ declarationChanged: false, preferencesChanged: false,
        configChanged: false, outputsMayHaveChanged: false });
      expect(await observeIntent(options)).toEqual(beforeIntent);
      expect(await observePreferences(options)).toEqual(beforePreferences);
      expect(backend.resetConfig).not.toHaveBeenCalled();
      expect(backend.execute).not.toHaveBeenCalled();
    });

  it('stops output cleanup after an optional config deletion fails, keeping prior commits visible', async () => {
    const options = location();
    await addRoot(options, 'local/demo', 'sha256:logical');
    await writePreferences(options, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [],
      exclusions: [{ plugin: 'local/demo', target: 'codex' }] });
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
    expect((await observePreferences(options)).value.exclusions).toEqual([]);
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
      targets: ['codex', 'claude'], yes: true }, {
      inventoryCatalogSourceReferences: async () =>
        ({ inventorySchemaVersion: 1 as const, references: [], errors: [] }),
    });

    expect(result.remainingTargets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', agent: 'codex' }),
    ]);
    expect(result.targetResults.find((target) => target.agent === 'codex')?.blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'sharedNativePreserved' })]));
    expect(result.targetResults.find((target) => target.agent === 'claude')).toMatchObject({
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

// Test Value Gate: retirement must retain an independent installed package, show its exact
// removal action in Review and successful receipts, and preserve producer failure as partial work.
describe('retire managed command results', () => {
  const inventoryCatalogSourceReferences = async () =>
    ({ inventorySchemaVersion: 1 as const, references: [], errors: [] });

  async function installedPackage() {
    const options = location();
    const producer: ProducerIdentity = { sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginName: 'demo', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null };
    const sourceDirectory = path.join(options.cwd, 'retained-command-source');
    await fs.outputFile(path.join(sourceDirectory, 'run.mjs'), 'process.exit(0);\n');
    const installed = await syncManagedCommandPackage({ producer, sourceDirectory,
      sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run',
        runner: 'node', entry: 'run.mjs', args: ['--fixed'] })] }], env: options.env });
    const recoveryAction = `aw command package remove ${installed.id} --yes`;
    const action = { kind: 'retainManagedCommandPackage' as const, pluginId: 'local/demo', scope: 'user' as const,
      producer, packageId: installed.id, commandIds: installed.commandIds,
      availability: 'ready' as const, errors: [], recoveryAction };
    const operationPlan = createOperationPlan({ intentChanges: [], actions: [action], changes: [], warnings: [],
      evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
    const commandResult = { producer, state: 'completed' as const, commandIds: installed.commandIds,
      removedCommandIds: [], errors: [], recoveryActions: [recoveryAction] };
    backend.preview.mockResolvedValue({ operationPlan, commandResults: [commandResult] });
    return { options, installed, action, commandResult, recoveryAction };
  }

  it('shows retained package removal in Review and successful receipt while the command stays usable', async () => {
    const { options, installed, action, commandResult, recoveryAction } = await installedPackage();
    await addRoot(options, 'local/demo', 'sha256:logical');
    backend.execute.mockResolvedValue({ overallState: 'succeeded', rebuildResults: [], targetResults: [],
      platforms: [], plugins: [], warnings: [], receiptTargets: [], commandResults: [commandResult] });
    const plan = await prepareRetire({ ...options, selector: 'local/demo', yes: true },
      { inventoryCatalogSourceReferences });
    expect(plan.operationPlan?.actions).toContainEqual(action);
    expect(plan.changes.join('\n')).toContain('保留命令包 tools');
    expect(plan.changes.join('\n')).toContain('所有项目共用');
    expect(plan.changes.join('\n')).toContain(recoveryAction);

    const result = await executeRetire(plan);

    expect(result).toMatchObject({ ok: true, declarationChanged: true, outputsMayHaveChanged: false,
      commandResults: [commandResult] });
    expect(result.recoveryActions).toEqual([recoveryAction]);
    expect(result.remainingTargets).toEqual([]);
    const command = await resolveManagedCommand(installed.commandIds[0]!, options.env);
    expect(command.view.availability).toBe('ready');
    expect(command.launch.args).toEqual(['--fixed']);
    expect(await fs.readFile(path.join(command.resourceRoot, 'run.mjs'), 'utf8')).toBe('process.exit(0);\n');
  });

  it.each(['partial', 'failed'] as const)('keeps a %s platform producer visible after its cleanup succeeds', async (state) => {
    const { options, commandResult } = await installedPackage();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const recoveryAction = 'aw cleanup local/demo --scope user --target codex --force --yes';
    const failed = { ...commandResult, producer: { ...commandResult.producer,
      kind: 'static-skill' as const, platform: 'codex' as const }, state,
    errors: [{ code: 'commandBindingInvalid', message: 'Command binding is invalid.' }],
    recoveryActions: [recoveryAction] };
    backend.inspect.mockImplementation(async () => ({ ...removedEvidence(), sourceIdentity: failed.producer.sourceIdentity }));
    backend.execute.mockResolvedValue({ overallState: 'partial', rebuildResults: [],
      targetResults: [{ target: { pluginId: 'local/demo', pluginName: 'demo', platform: 'codex', scope: 'user' },
        action: 'cleanup', state: 'completed' }], platforms: ['codex'], plugins: ['local/demo'], warnings: [],
      receiptTargets: [], commandResults: [failed] });

    const result = await runRetire({ ...options, selector: 'local/demo', targets: ['codex'], yes: true },
      { inventoryCatalogSourceReferences });

    expect(result).toMatchObject({ ok: false, declarationChanged: true, commandResults: [failed],
      targetResults: [{ agent: 'codex', execution: 'partial', observation: 'unknown',
        blockers: [expect.objectContaining({ code: 'commandBindingInvalid' })] }],
      remainingTargets: [expect.objectContaining({ pluginId: 'local/demo', agent: 'codex' })] });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'commandBindingInvalid', pluginId: 'local/demo' }));
    expect(result.recoveryActions).toContain(recoveryAction);
    expect(result.recoveryActions).toContain('aw plugin remove local/demo --only outputs --scope user --target codex');
  });

  it.each([
    { state: 'partial', codexFailed: false },
    { state: 'failed', codexFailed: false },
    { state: 'failed', codexFailed: true },
  ] as const)('keeps an unclassified $state package global (Codex cleanup failed=$codexFailed)', async ({ state, codexFailed }) => {
    const { options, commandResult, recoveryAction } = await installedPackage();
    await addRoot(options, 'local/demo', 'sha256:logical');
    const failed = { ...commandResult, state,
      errors: [{ code: 'commandBindingInvalid', message: 'Command binding is invalid.' }] };
    backend.execute.mockResolvedValue({ overallState: 'partial', rebuildResults: [],
      targetResults: (['codex', 'claude'] as const).map((platform) => ({
        target: { pluginId: 'local/demo', pluginName: 'demo', platform, scope: 'user' },
        action: 'cleanup', state: codexFailed && platform === 'codex' ? 'failed' : 'completed',
      })), platforms: ['codex', 'claude'], plugins: ['local/demo'], warnings: [],
      receiptTargets: [], commandResults: [failed] });

    const result = await runRetire({ ...options, selector: 'local/demo', targets: ['codex', 'claude'], yes: true },
      { inventoryCatalogSourceReferences });

    expect(result).toMatchObject({ ok: false, declarationChanged: true,
      commandResults: [failed] });
    expect(result.remainingTargets).toEqual(codexFailed
      ? [expect.objectContaining({ agent: 'codex' })] : []);
    expect(result.targetResults.find((target) => target.agent === 'claude'))
      .toMatchObject({ execution: 'applied', blockers: [] });
    expect(result.targetResults.find((target) => target.agent === 'codex')).toMatchObject(codexFailed
      ? { execution: 'failed', blockers: [expect.objectContaining({ code: 'nativeRetireFailed' })] }
      : { execution: 'applied', blockers: [] });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'commandBindingInvalid', pluginId: 'local/demo' }));
    expect(result.recoveryActions).toContain(recoveryAction);
  });
});
