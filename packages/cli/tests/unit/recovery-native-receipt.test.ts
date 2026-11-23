import path from 'node:path';
import fs from 'fs-extra';

import { describe, expect, it, vi } from 'vitest';
import { getCommandPackageId, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/commands/rebuild-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-command.js')>(),
  runRebuildCommand: native.run,
}));

import { executeRecovery, prepareRecovery, prepareScopedRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import type { CommandProducerResult, PlatformName, Scope } from '../../src/types.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { nativeToolFixture } from '../helpers/native-tools.js';

const sourceIdentity = `sha256:${'1'.repeat(64)}`;

function commandResult(producer: ProducerIdentity, state: 'completed' | 'failed'): CommandProducerResult {
  const selector = `${producer.sourceId}/${producer.pluginName}`;
  return {
    producer, packageId: getCommandPackageId(producer), selector, state,
    action: state === 'completed' ? 'updated' : 'unchanged',
    availability: state === 'completed' ? 'ready' : 'unavailable',
    subcommands: state === 'completed' ? ['run'] : [], hasFallback: false,
    errors: state === 'failed' ? [{ code: 'commandResourceInvalid', message: 'Package publication failed.' }] : [],
    recoveryActions: state === 'failed' ? [`aw command package sync ${selector} --yes`] : [],
  };
}

describe('scoped Native recovery receipt', () => {
  // A frozen native tool authority change requires approval even when no filesystem actions are listed.
  it('requires authorization for a shared package native tool change before execution', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const target = { pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0', platform: 'claude' as const,
      scope: 'user' as const, cwd: isolation.layout.fixtureCwd };
    const change = { producer: { sourceId: 'team', sourceIdentity, pluginName: 'demo' },
      before: nativeToolFixture().closure, after: null };
    let executions = 0;
    native.run.mockImplementation(async (options: { runtime?: { previewOperationPlan?: boolean } }): Promise<RebuildCommandResult> => {
      if (!options.runtime?.previewOperationPlan) executions += 1;
      return { platforms: ['claude'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded', rebuildResults: [],
        targetResults: [{ target, action: 'cleanup', state: 'completed' }],
        operationPlan: createOperationPlan({ nativeToolChanges: [change], actions: [], intentChanges: [], changes: [], warnings: [],
          evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
      };
    });
    const receipt = await runRecovery('cleanup', ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', targets: ['claude'], yes: false,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.nativeToolChanges).toEqual([change]);
    expect(receipt.blockers).toContainEqual(expect.objectContaining({ code: 'nativeToolAuthorizationRequired' }));
    expect(executions).toBe(0);
  });
  // Test Value Gate: a shared AW package affects only declared Native platforms, including a User dependency of a Project root.
  it.each([
    { relation: 'root', platforms: ['codex'], scope: 'user', mismatch: undefined },
    { relation: 'root', platforms: ['codex', 'claude'], scope: 'user', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex'], scope: 'project', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex', 'claude'], scope: 'project', mismatch: undefined },
    { relation: 'dependency', platforms: ['codex', 'claude'], scope: 'project', mismatch: 'sourceIdentity' },
  ] as const)('attributes $relation package failure to $platforms in $scope (mismatch=$mismatch)', async ({ relation, platforms, scope, mismatch }) => {
    const isolation = getCurrentSourceTestIsolation();
    if (scope === 'project') await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const pluginName = relation === 'root' ? 'demo' : 'dependency';
    const pluginRoot = path.join(isolation.layout.fixtureCwd, pluginName);
    await fs.outputFile(path.join(pluginRoot, 'tools', 'run.mjs'), 'process.exit(0);\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: pluginName, version: '1.0.0', description: 'Package receipt fixture.',
      platforms: ['codex', 'claude'], requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
      marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      command: { sourceDir: './tools', platforms, mode: 'static',
        routes: { subcommands: [{ name: 'run', runner: 'node', entry: 'run.mjs' }] } },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'team', sourceIdentity,
      pluginId: `team/${pluginName}` };
    const producer = commandResult({ sourceId: 'team', sourceIdentity: mismatch
      ? `sha256:${'2'.repeat(64)}` : sourceIdentity, pluginName }, 'failed');
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
      cliVersion: '1.0.0', targets: ['codex', 'claude'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    // The receipt unit supplies the already-read manifest; native execution is the mocked boundary.
    plan.demand.plugins = [plugin];
    const receipt = await executeRecovery(plan);
    expect(receipt.ok).toBe(false);
    expect(receipt.commandResults).toEqual([producer]);
    expect(receipt.recoveryActions).toContain(producer.recoveryActions[0]);
    const affected: readonly string[] = mismatch ? [] : platforms;
    expect(receipt.remainingTargets.map((target) => target.agent).sort()).toEqual([...affected].sort());
    for (const target of receipt.targetResults) {
      expect(target).toMatchObject(affected.includes(target.agent as 'codex' | 'claude')
        ? { execution: 'partial', blockers: [{ code: 'commandResourceInvalid' }] }
        : { execution: 'applied', blockers: [] });
    }
  });

  it('keeps an unclassified package failure global while preserving an explicit Codex failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const producer = commandResult({ sourceId: 'team', sourceIdentity, pluginName: 'demo' }, 'failed');
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
      cliVersion: '1.0.0', targets: ['codex', 'claude'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.commandResults).toEqual([producer]);
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({ agent: 'codex' })]);
    expect(receipt.targetResults.find((target) => target.agent === 'claude'))
      .toMatchObject({ execution: 'applied', blockers: [] });
  });

  // A failed Native deployment must preserve successful publication of the shared package.
  it('keeps a completed package result when the Claude deployment fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const result = commandResult({ sourceId: 'team', sourceIdentity, pluginName: 'demo' }, 'completed');
    native.run.mockImplementation(async (options: { runtime: { previewOperationPlan?: boolean;
      executionInput: { selectedTargets: Array<{ platform: PlatformName }> } } }): Promise<RebuildCommandResult> => {
      const targets = options.runtime.executionInput.selectedTargets.map(({ platform }) => ({
        sourceId: 'team', sourceIdentity, pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0', platform,
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      }));
      return { platforms: targets.map((target) => target.platform), plugins: ['team/demo'], warnings: [], rebuildResults: [],
        overallState: options.runtime.previewOperationPlan ? 'succeeded' : 'partial',
        targetResults: targets.map((target) => ({ target, action: 'cleanup',
          ...(target.platform === 'claude' && !options.runtime.previewOperationPlan
            ? { state: 'failed' as const, errorCode: 'platformPackageMissing' }
            : { state: 'completed' as const }) })),
        ...(options.runtime.previewOperationPlan ? {} : { commandResults: [result] }),
        operationPlan: createOperationPlan({ intentChanges: [], changes: [], warnings: [], actions: targets.map((target) => ({
          kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform, scope: target.scope,
          path: path.join(isolation.layout.fixtureCwd, target.platform), ownerFingerprint: 'sha256:fixture',
        })), evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
      };
    });
    const receipt = await runRecovery('cleanup', ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', targets: ['codex', 'claude'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.commandResults).toEqual([result]);
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({ agent: 'claude' })]);
    expect(receipt.targetResults.find((target) => target.agent === 'codex')).toMatchObject({ execution: 'applied', blockers: [] });
    expect(receipt.targetResults.find((target) => target.agent === 'claude')).toMatchObject({ execution: 'failed', blockers: [{ code: 'platformPackageMissing' }] });
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
      cliVersion: '1.0.0', targets: ['codex', 'claude'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'fixture 99.0.0', stderr: '' }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({ agent: 'claude' })]);
    expect(receipt.targetResults.find((target) => target.agent === 'codex'))
      .toMatchObject({ execution: 'applied', blockers: [] });
    expect(receipt.targetResults.find((target) => target.agent === 'claude'))
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

    const plan = await prepareScopedRecovery(command, ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['claude'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }) });
    const receipt = await executeRecovery(plan);

    expect(receipt.ok).toBe(true);
    expect(receipt.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/demo', agent: 'claude', execution: 'applied', content, observation,
    })]);
  });
});

// Test Value Gate: an excluded installed product must survive the frozen-plan to recovery boundary,
// including successful usable products, failed execution, and a preview with no deployment binding.
describe('excluded Native product recovery receipt', () => {
  it.each(['succeeded', 'failed'] as const)('keeps an unsupported App beside a %s usable CLI', async (state) => {
    const isolation = getCurrentSourceTestIsolation();
    const identity = { pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0', platform: 'codex' as const,
      scope: 'user' as const, cwd: isolation.layout.fixtureCwd };
    const excluded = { pluginId: 'team/demo', platform: 'codex' as const, scope: { kind: 'user' as const }, productId: 'unsupported-app',
      product: { id: 'unsupported-app', product: 'app' as const, version: '0.151.0', availability: 'unsupported' as const,
        reasonCodes: ['clientVersionUnsupported'], entry: null }, reasonCode: 'clientVersionUnsupported', execution: 'not-run' as const,
      recoveryActions: ['aw target list'] };
    native.run.mockImplementation(async (options: { runtime?: { previewOperationPlan?: boolean } }): Promise<RebuildCommandResult> => {
      const preview = options.runtime?.previewOperationPlan === true;
      return { platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: preview ? 'succeeded' : state,
        targetResults: [{ target: identity, action: 'cleanup', state: preview || state === 'succeeded' ? 'completed' : 'failed',
          ...(!preview && state === 'failed' ? { errorCode: 'nativeCleanupFailed' } : {}) }],
        rebuildResults: preview ? [] : [{ target: identity, command: 'cleanup', actions: [], cleanupAttempted: false,
          removed: [], absent: [], residual: [], quarantined: [], failures: [], deploymentExclusions: [excluded],
          ...(state === 'succeeded' ? { status: 'succeeded' as const } : { status: 'failed' as const,
            error: { phase: 'preflight' as const, message: 'nativeCleanupFailed' } }) }],
        ...(preview ? { operationPlan: createOperationPlan({ deploymentExclusions: [excluded], actions: [], intentChanges: [], changes: [], warnings: [],
          evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }) } : {}),
      };
    });
    const plan = await prepareScopedRecovery('cleanup', ['team/demo'], { scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: isolation.env, cliVersion: '1.0.0', targets: ['codex'], yes: true },
    { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }) });
    try {
      expect(plan.receipt.targetResults[0]!.deploymentExclusions).toEqual([excluded]);
      const result = await executeRecovery(plan, { yes: true });
      expect(result.targetResults[0]!.deploymentExclusions).toEqual([excluded]);
      expect(result.targetResults[0]!.execution).toBe(state === 'succeeded' ? 'applied' : 'failed');
    } finally { await plan.context.dispose(); }
  });
});
