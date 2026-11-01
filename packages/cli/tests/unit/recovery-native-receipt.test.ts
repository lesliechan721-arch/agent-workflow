import path from 'node:path';
import fs from 'fs-extra';

import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/commands/rebuild-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-command.js')>(),
  runRebuildCommand: native.run,
}));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: vi.fn(async () => ({ state: 'absent', targets: [], blockers: [] })),
}));

import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import type { CommandProducerResult, PlatformName, Scope } from '../../src/types.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped Native recovery receipt', () => {
  // Test Value Gate: command failures must not become successful recovery after platform writes succeed.
  it.each([
    { state: 'completed' as const, producerPlugin: 'demo' },
    { state: 'failed' as const, producerPlugin: 'demo' },
    { state: 'failed' as const, producerPlugin: 'dependency' },
  ])('includes $state command results from $producerPlugin in scoped recovery', async ({ state, producerPlugin }) => {
    const isolation = getCurrentSourceTestIsolation();
    const target = { pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0',
      platform: 'claude' as const, scope: 'user' as const, cwd: isolation.layout.fixtureCwd };
    const producer: CommandProducerResult = {
      producer: { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginName: producerPlugin,
        kind: 'static-skill', key: 'tools', platform: 'claude', scope: 'user', projectRoot: null },
      state, commandIds: [], removedCommandIds: [],
      errors: state === 'failed' ? [{ code: 'commandBindingInvalid', message: 'Command binding failed.' }] : [],
      recoveryActions: state === 'failed'
        ? [`aw reinstall team/${producerPlugin} --target claude-code --scope user --yes`] : [],
    };
    native.run.mockImplementation(async (options: { runtime?: { previewOperationPlan?: boolean } }): Promise<RebuildCommandResult> => ({
      platforms: ['claude'], plugins: ['team/demo'], warnings: [],
      overallState: state === 'failed' && !options.runtime?.previewOperationPlan ? 'partial' : 'succeeded',
      targetResults: [{ target, action: 'cleanup', state: 'completed' },
        ...(producerPlugin === 'dependency' ? [{ target: { ...target, pluginId: 'team/dependency', pluginName: 'dependency' },
          action: 'cleanup' as const, state: 'completed' as const, requiredBy: ['team/demo'], relation: 'dependency' as const }] : [])],
      rebuildResults: [],
      ...(options.runtime?.previewOperationPlan ? {} : { commandResults: [producer] }),
      operationPlan: createOperationPlan({ intentChanges: [],
        actions: [{ kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform,
          scope: target.scope, path: path.join(isolation.layout.fixtureCwd, 'owned-output'), ownerFingerprint: 'sha256:fixture' }],
        changes: [], warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
    }));
    const receipt = await runRecovery('cleanup', ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(state === 'completed');
    expect(receipt.commandResults).toEqual([producer]);
    if (producer.recoveryActions.length) expect(receipt.recoveryActions).toContain(producer.recoveryActions[0]);
    expect(receipt.targetResults[0]).toMatchObject(state === 'completed'
      ? { execution: 'applied', blockers: [] }
      : { execution: 'partial', blockers: [{ code: 'commandBindingInvalid' }] });
    expect(receipt.remainingTargets).toHaveLength(state === 'completed' ? 0 : 1);
  });

  // Test Value Gate: a shared AW package affects only declared Native platforms, including a User dependency of a Project root.
  it.each([
    { relation: 'root', platforms: ['codex'], scope: 'user', mismatch: undefined },
    { relation: 'root', platforms: ['codex', 'claude'], scope: 'user', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex'], scope: 'project', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex', 'claude'], scope: 'project', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex', 'claude'], scope: 'project', mismatch: 'sourceIdentity' },
    { relation: 'root', platforms: ['codex', 'claude'], scope: 'user', mismatch: 'scope' },
  ] as const)('attributes $relation package failure to $platforms in $scope (mismatch=$mismatch)', async ({ relation, platforms, scope, mismatch }) => {
    const isolation = getCurrentSourceTestIsolation();
    if (scope === 'project') await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const pluginName = relation === 'root' ? 'demo' : 'dependency';
    const pluginRoot = path.join(isolation.layout.fixtureCwd, pluginName);
    const sourceIdentity = `sha256:${'1'.repeat(64)}`;
    await fs.outputFile(path.join(pluginRoot, 'tools', 'run.mjs'), 'process.exit(0);\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: pluginName, version: '1.0.0', description: 'Package receipt fixture.',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms, sourceDir: './tools' }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static',
          entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'team', sourceIdentity,
      pluginId: `team/${pluginName}` };
    const producer: CommandProducerResult = {
      producer: { sourceId: 'team', sourceIdentity: mismatch === 'sourceIdentity'
        ? `sha256:${'2'.repeat(64)}` : sourceIdentity, pluginName, kind: 'package', key: 'tools',
      platform: null, scope: mismatch === 'scope' ? 'project' : 'user',
      projectRoot: mismatch === 'scope' ? await fs.realpath(isolation.layout.fixtureCwd) : null },
      state: 'failed', commandIds: [], removedCommandIds: [],
      errors: [{ code: 'commandResourceInvalid', message: 'Package publication failed.' }],
      recoveryActions: [`aw command package sync team/${pluginName} tools --scope user --yes`],
    };
    native.run.mockImplementation(async (options: { runtime: { previewOperationPlan?: boolean;
      executionInput: { selectedTargets: Array<{ platform: PlatformName }> } } }): Promise<RebuildCommandResult> => {
      const selectedPlatforms = options.runtime.executionInput.selectedTargets.map((target) => target.platform);
      const targets = selectedPlatforms.map((platform) => ({ pluginId: 'team/demo', pluginName: 'demo',
        pluginVersion: '1.0.0', platform, scope, cwd: isolation.layout.fixtureCwd }));
      return {
        platforms: selectedPlatforms, plugins: ['team/demo'], warnings: [], rebuildResults: [],
        overallState: options.runtime.previewOperationPlan ? 'succeeded' : 'partial',
        targetResults: targets.map((target) => ({ target, action: 'cleanup', state: 'completed' })),
        ...(relation === 'dependency' ? { dependencyPlan: {
          requestedPluginIds: ['team/demo'], resolvedPluginIds: ['team/demo', 'team/dependency'],
          dependencyEdges: selectedPlatforms.map((platform) => ({ from: 'team/demo', to: 'team/dependency', platform })),
          scopeOverrides: [], targets: selectedPlatforms.map((platform) => ({
            pluginId: 'team/dependency', pluginName: 'dependency', platform, relation: 'dependency' as const,
            depth: 1, requiredBy: ['team/demo'], rootScope: scope, minimumScope: 'user' as const,
            resolvedScope: 'user' as const, allowedScopes: ['user' as const], assignmentSource: 'platformRequirement' as const,
            locked: false, affectsOtherProjects: true, state: 'present' as const, action: 'keep' as const, order: 0,
          })),
        } } : {}),
        ...(options.runtime.previewOperationPlan ? {} : { commandResults: [producer] }),
        operationPlan: createOperationPlan({ intentChanges: [], actions: targets.map((target) => ({
          kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform, scope,
          path: path.join(isolation.layout.fixtureCwd, target.platform), ownerFingerprint: 'sha256:fixture',
        })), changes: [], warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
      };
    });
    const plan = await prepareRecovery('cleanup', ['team/demo'], {
      scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex', 'claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    // The receipt unit supplies the already-read manifest; native execution is the mocked boundary.
    plan.demand.plugins = [plugin];
    const receipt = await executeRecovery(plan);
    expect(receipt.ok).toBe(false);
    expect(receipt.commandResults).toEqual([producer]);
    expect(receipt.recoveryActions).toContain(producer.recoveryActions[0]);
    const affected = mismatch ? [] : platforms.map((platform) => platform === 'claude' ? 'claude-code' : platform);
    expect(receipt.remainingTargets.map((target) => target.agent).sort()).toEqual([...affected].sort());
    for (const target of receipt.targetResults) {
      expect(target).toMatchObject(affected.includes(target.agent as 'codex' | 'claude-code')
        ? { execution: 'partial', blockers: [{ code: 'commandResourceInvalid' }] }
        : { execution: 'applied', blockers: [] });
    }
  });

  it('keeps an unclassified package failure global while preserving an explicit Codex failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const producer: CommandProducerResult = {
      producer: { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginName: 'demo',
        kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null },
      state: 'failed', commandIds: [], removedCommandIds: [],
      errors: [{ code: 'commandResourceInvalid', message: 'Package publication failed.' }],
      recoveryActions: ['aw command package sync team/demo tools --scope user --yes'],
    };
    native.run.mockImplementation(async (options: { runtime: { previewOperationPlan?: boolean;
      executionInput: { selectedTargets: Array<{ platform: PlatformName }> } } }): Promise<RebuildCommandResult> => {
      const targets = options.runtime.executionInput.selectedTargets.map(({ platform }) => ({
        pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0', platform,
        scope: 'user' as Scope, cwd: isolation.layout.fixtureCwd,
      }));
      return { platforms: targets.map((target) => target.platform), plugins: ['team/demo'], warnings: [],
        overallState: options.runtime.previewOperationPlan ? 'succeeded' : 'partial', rebuildResults: [],
        targetResults: targets.map((target) => ({ target, action: 'cleanup',
          ...(target.platform === 'codex' && !options.runtime.previewOperationPlan
            ? { state: 'failed' as const, errorCode: 'commandPackagePublishFailed' }
            : { state: 'completed' as const }) })),
        ...(options.runtime.previewOperationPlan ? {} : { commandResults: [producer] }),
        operationPlan: createOperationPlan({ intentChanges: [], actions: targets.map((target) => ({
          kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform, scope: target.scope,
          path: path.join(isolation.layout.fixtureCwd, target.platform), ownerFingerprint: 'sha256:fixture',
        })), changes: [], warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
      };
    });
    const receipt = await runRecovery('cleanup', ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex', 'claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.commandResults).toEqual([producer]);
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({ agent: 'codex' })]);
    expect(receipt.targetResults.find((target) => target.agent === 'claude-code'))
      .toMatchObject({ execution: 'applied', blockers: [] });
  });

  // Test Value Gate: successful Codex work must not turn a wholly failed Claude target into partial success.
  it('reports a failed platform separately from a completed platform in one Native group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    native.run.mockImplementation(async (options: { runtime: { previewOperationPlan?: boolean;
      executionInput: { selectedTargets: Array<{ platform: PlatformName }> } } }): Promise<RebuildCommandResult> => {
      const targets = options.runtime.executionInput.selectedTargets.map(({ platform }) => ({
        pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0', platform,
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      }));
      return { platforms: targets.map((target) => target.platform), plugins: ['team/demo'], warnings: [],
        overallState: options.runtime.previewOperationPlan ? 'succeeded' : 'partial', rebuildResults: [],
        targetResults: targets.map((target) => ({ target, action: 'cleanup',
          ...(target.platform === 'claude' && !options.runtime.previewOperationPlan
            ? { state: 'failed' as const, errorCode: 'writeFailed' }
            : { state: 'completed' as const }) })),
        operationPlan: createOperationPlan({ intentChanges: [], actions: targets.map((target) => ({
          kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform, scope: target.scope,
          path: path.join(isolation.layout.fixtureCwd, target.platform), ownerFingerprint: 'sha256:fixture',
        })), changes: [], warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
      };
    });
    const receipt = await runRecovery('cleanup', ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex', 'claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({ agent: 'claude-code' })]);
    expect(receipt.targetResults.find((target) => target.agent === 'codex'))
      .toMatchObject({ execution: 'applied', blockers: [] });
    expect(receipt.targetResults.find((target) => target.agent === 'claude-code'))
      .toMatchObject({ execution: 'failed', blockers: [{ code: 'writeFailed' }] });
  });

  it.each([
    { command: 'cleanup' as const, shared: false, content: 'absent', observation: 'missing' },
    { command: 'uninstall' as const, shared: false, content: 'absent', observation: 'missing' },
    { command: 'cleanup' as const, shared: true, content: 'unknown', observation: 'unknown' },
  ])('keeps $command execution separate from observed content with shared=$shared', async ({ command, shared, content, observation }) => {
    const isolation = getCurrentSourceTestIsolation();
    const target = { pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0',
      platform: 'claude' as const, scope: 'user' as const, cwd: isolation.layout.fixtureCwd };
    const outputPath = path.join(isolation.layout.fixtureCwd, '.claude', 'owned-output');
    native.run.mockImplementation(async (): Promise<RebuildCommandResult> => ({
      platforms: ['claude'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded',
      receiptTargets: [{ pluginId: target.pluginId, pluginName: target.pluginName,
        platform: target.platform, scope: target.scope }],
      targetResults: [{ target, action: command, state: 'completed' }],
      rebuildResults: [{ status: 'succeeded', command, target,
        actions: [{ name: 'cleanup.owned', status: 'succeeded' }], cleanupAttempted: true,
        removed: ['owned-output'], absent: [], residual: [], quarantined: [], failures: [] }],
      nativeFootprints: [{ path: outputPath,
        pluginId: target.pluginId, platform: target.platform, scope: target.scope, shared }],
      operationPlan: createOperationPlan({
        intentChanges: [],
        actions: [{ kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform,
          scope: target.scope, path: outputPath, ownerFingerprint: 'sha256:fixture' }],
        changes: [`${target.pluginId}:${target.platform}:${target.scope}:removeOwnedOutput:${outputPath}`],
        warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] },
      }),
    }));

    const receipt = await runRecovery(command, ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }) });

    expect(receipt.ok).toBe(true);
    expect(receipt.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/demo', agent: 'claude-code', execution: 'applied', content, observation,
    })]);
  });
});
