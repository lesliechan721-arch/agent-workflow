import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type { RebuildTaskTarget } from '../../src/commands/rebuild-command.js';
import type { StatusV8Payload } from '../../src/commands/status-v6.js';
import {
  createTuiControllerDependencies,
} from '../../src/tui/controller-runtime.js';
import { projectExecutionDiagnostics } from '../../src/tui/diagnostic-projection.js';
import type {
  PluginWriteTaskEvidence,
  PluginWriteTaskExecutionResult,
  PluginWriteTaskIntent,
} from '../../src/tui/controller.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createCatalogStoreKey } from '../../src/utils/catalog-generation-store.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const runtimeMocks = vi.hoisted(() => ({
  statusCommandV8: vi.fn(),
  taskWriteCommand: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: runtimeMocks.statusCommandV8,
}));

vi.mock('../../src/commands/write-commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/write-commands.js')>(),
  taskWriteCommand: runtimeMocks.taskWriteCommand,
}));

async function configureCatalog(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  configDigest: string;
  sourceIdentity: string;
  generationKey: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'task-runtime-source');
  await createDependencyCatalogSnapshotFixture(sourceRoot, [
    { name: 'alpha' },
    { name: 'beta' },
  ]);
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: initial.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({
    sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
  });
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  const active = (await readCatalogGenerationState(isolation.env)).sources.team!.active!;
  return {
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    configDigest: config.digest,
    sourceIdentity: active.sourceIdentity,
    generationKey: createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
  };
}

async function configureMixedCatalog(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  configDigest: string;
  sources: Record<'team' | 'lab', { sourceIdentity: string; generationKey: string }>;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const roots = {
    team: path.join(isolation.layout.fixtureCwd, 'task-runtime-team-source'),
    lab: path.join(isolation.layout.fixtureCwd, 'task-runtime-lab-source'),
  };
  await Promise.all([
    createDependencyCatalogSnapshotFixture(roots.team, [{ name: 'alpha' }]),
    createDependencyCatalogSnapshotFixture(roots.lab, [{ name: 'gamma' }]),
  ]);
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [
        { id: 'team', type: 'path', primary: true, path: roots.team },
        { id: 'lab', type: 'path', primary: false, path: roots.lab },
      ],
    },
    expectedDigest: initial.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'lab', cliVersion: '1.0.0', env: isolation.env });
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  const state = await readCatalogGenerationState(isolation.env);
  const source = (sourceId: 'team' | 'lab') => {
    const active = state.sources[sourceId]!.active!;
    return {
      sourceIdentity: active.sourceIdentity,
      generationKey: createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
    };
  };
  return {
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    configDigest: config.digest,
    sources: { team: source('team'), lab: source('lab') },
  };
}

function status(options: {
  cwd: string;
  configDigest: string;
  sourceIdentity: string;
  installedVersion?: string;
}): Awaited<ReturnType<typeof runtimeMocks.statusCommandV8>> {
  const installedVersion = options.installedVersion ?? '0.9.0';
  const targets: StatusV8Payload['targets'] = [
    {
      pluginName: 'alpha', pluginId: 'team/alpha', sourceId: 'team',
      sourceIdentity: options.sourceIdentity, version: '1.0.0',
      platform: 'codex', cwd: options.cwd, state: 'ready',
      components: [],
      reasons: [], recoveryActions: [],
      placements: [{
        scope: 'user', state: 'ready',
        components: [{ kind: 'ownership', key: 'alpha', state: 'present' }],
        reasons: [], recoveryActions: [],
      }],
    },
    {
      pluginName: 'beta', pluginId: 'team/beta', sourceId: 'team',
      sourceIdentity: options.sourceIdentity, version: '1.0.0',
      platform: 'claude', scope: 'project', cwd: options.cwd, state: 'needsSync',
      components: [{ kind: 'ownership', key: 'beta', state: 'partial' }],
      reasons: [{ code: 'partial', message: 'safe failure', severity: 'blocking' }],
      recoveryActions: [],
    },
  ];
  return {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'team', configDigest: options.configDigest,
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'team', identity: options.sourceIdentity, type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active', catalogVersion: '1.0.0',
        }],
      },
      filters: { plugins: ['team/alpha', 'team/beta'], platform: 'both', cwd: options.cwd },
      targets,
      errors: [],
    },
    pluginSummaries: [
      {
        pluginName: 'alpha', pluginId: 'team/alpha', displayName: 'Alpha',
        description: 'Alpha', version: '1.0.0',
        supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0,
      },
      {
        pluginName: 'beta', pluginId: 'team/beta', displayName: 'Beta',
        description: 'Beta', version: '1.0.0',
        supportedTargets: { codex: [], claude: ['project'] }, configFieldCount: 0,
      },
    ],
    targetRevisions: targets.flatMap((target) =>
      (target.platform === 'codex' ? target.placements : [target]).map((placement) => ({
        pluginId: target.pluginId, platform: target.platform, scope: placement.scope,
        revision: {
          state: 'upgradeAvailable' as const,
          installedVersion,
          availableVersion: '1.0.0',
        },
      }))),
  };
}

function commandResult(targets: readonly RebuildTaskTarget[]) {
  const receiptTargets = targets.map((target) => ({
    pluginName: target.pluginId.split('/')[1]!, pluginId: target.pluginId,
    sourceId: 'team', platform: target.platform, scope: target.scope,
  }));
  return {
    platforms: [...new Set(targets.map((target) => target.platform))],
    plugins: targets.map((target) => target.pluginId),
    warnings: [], rebuildResults: [],
    targetResults: receiptTargets.map((target, index) => ({
      target, action: targets[index]!.method, state: 'completed' as const,
      relation: 'requested' as const,
    })),
    overallState: 'succeeded' as const,
    receiptTargets,
    operationPlan: createOperationPlan({
      intentChanges: [],
      actions: [{
        kind: 'runPreApply', pluginId: 'team/alpha', platform: 'codex',
        scope: 'user', script: 'scripts/preApply.mjs',
      }],
      changes: targets.map((target) => [
        target.pluginId, target.platform, target.scope, target.method,
      ].join(':')),
      warnings: [],
      evidence: {
        catalogDigests: [{ sourceId: 'team', digest: 'sha256:catalog' }],
        intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
      },
    }),
  };
}

function updateIntent(catalog: Awaited<ReturnType<typeof configureCatalog>>): PluginWriteTaskIntent {
  return {
    kind: 'pluginWriteTask', goal: 'update', executionPolicy: 'executableSubset',
    targets: [
      {
        pluginId: 'team/alpha', platform: 'codex', scope: 'user',
        expectedUpdate: {
          installedVersion: '0.9.0', activeVersion: '1.0.0',
          sourceIdentity: catalog.sourceIdentity, generationKey: catalog.generationKey,
        },
      },
      {
        pluginId: 'team/beta', platform: 'claude', scope: 'project',
        expectedUpdate: {
          installedVersion: '0.9.0', activeVersion: '1.0.0',
          sourceIdentity: catalog.sourceIdentity, generationKey: catalog.generationKey,
        },
      },
    ],
  };
}

function sharedDependencyRestoreStatus(options: {
  cwd: string;
  configDigest: string;
  sourceIdentity: string;
}): Awaited<ReturnType<typeof runtimeMocks.statusCommandV8>> {
  const rootTarget = (scope: 'user' | 'project'): StatusV8Payload['targets'][number] => ({
    pluginName: 'alpha', pluginId: 'team/alpha', sourceId: 'team',
    sourceIdentity: options.sourceIdentity, version: '1.0.0',
    platform: 'claude', scope, cwd: options.cwd, state: 'needsSync',
    components: [
      { kind: 'ownership', key: `alpha-${scope}`, state: 'present' },
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: [scope], relation: 'root' },
      },
    ],
    reasons: [{
      code: 'dependencyMissing', message: `team/beta is missing from ${scope}`,
      severity: 'blocking', dependencyPluginId: 'team/beta', dependencyPlatform: 'claude',
      dependencyScope: scope, rootIssueId: `missing-beta-${scope}`,
      rootIssueCode: 'dependencyMissing',
    }],
    recoveryActions: [{ command: 'sync', scope, description: `Sync alpha at ${scope}.` }],
  });
  const dependencyTarget = (scope: 'user' | 'project'): StatusV8Payload['targets'][number] => ({
    pluginName: 'beta', pluginId: 'team/beta', sourceId: 'team',
    sourceIdentity: options.sourceIdentity, version: '1.0.0',
    platform: 'claude', scope, cwd: options.cwd, state: 'absent',
    components: [], reasons: [], recoveryActions: [],
  });
  const targets = [
    rootTarget('user'), rootTarget('project'), dependencyTarget('user'), dependencyTarget('project'),
  ];
  return {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'team', configDigest: options.configDigest,
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'team', identity: options.sourceIdentity, type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active', catalogVersion: '1.0.0',
        }],
      },
      filters: { plugins: ['team/alpha'], platform: 'both', cwd: options.cwd },
      targets,
      errors: [],
    },
    pluginSummaries: [
      {
        pluginName: 'alpha', pluginId: 'team/alpha', displayName: 'Alpha',
        description: 'Alpha', version: '1.0.0',
        supportedTargets: { codex: [], claude: ['user', 'project'] }, configFieldCount: 0,
      },
      {
        pluginName: 'beta', pluginId: 'team/beta', displayName: 'Beta',
        description: 'Beta', version: '1.0.0',
        supportedTargets: { codex: [], claude: ['user', 'project'] }, configFieldCount: 0,
      },
    ],
    targetRevisions: targets.map((target) => ({
      pluginId: target.pluginId, platform: target.platform, scope: target.scope,
      revision: target.pluginId === 'team/alpha'
        ? { state: 'current' as const, installedVersion: '1.0.0', availableVersion: '1.0.0' }
        : { state: 'current' as const, availableVersion: '1.0.0' },
    })),
  };
}

describe('plugin write task runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('previews and executes mixed platform/scope methods once for one source', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd,
      env: catalog.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const intent = { ...updateIntent(catalog), executionPolicy: 'all' as const };

    const evidence = await dependencies.captureEvidence(
      intent, new AbortController().signal,
    ) as PluginWriteTaskEvidence;
    expect(evidence.taskPlan.sources).toHaveLength(1);
    expect(evidence.taskPlan.sources[0]).toMatchObject({
      sourceId: 'team', requestedTargets: intent.targets,
    });
    expect(runtimeMocks.taskWriteCommand).toHaveBeenCalledWith([
      { pluginId: 'team/alpha', platform: 'codex', scope: 'user', method: 'sync' },
      { pluginId: 'team/beta', platform: 'claude', scope: 'project', method: 'reinstall' },
    ], expect.any(Object), expect.objectContaining({ previewOperationPlan: true }));

    const execution = await dependencies.executeIntent(intent, evidence);
    const taskExecution = execution as PluginWriteTaskExecutionResult;
    expect(taskExecution.sourceResults).toHaveLength(1);
    const actualCalls = runtimeMocks.taskWriteCommand.mock.calls.filter((call) =>
      call[2]?.previewOperationPlan !== true);
    expect(actualCalls).toHaveLength(1);
    expect(actualCalls[0]?.[0]).toEqual([
      { pluginId: 'team/alpha', platform: 'codex', scope: 'user', method: 'sync' },
      { pluginId: 'team/beta', platform: 'claude', scope: 'project', method: 'reinstall' },
    ]);
    expect(actualCalls[0]?.[2]).toEqual(expect.objectContaining({
      awHomeMutationToken: expect.any(Object),
      expectedPlanFingerprint: evidence.taskPlan.sources[0]!.preview.operationPlan!.planFingerprint,
      preApplyConfirmed: true,
      preApplyExecutionCache: expect.any(Map),
    }));
  });

  it('rejects a changed installed version during the lock-time evidence check', async () => {
    const catalog = await configureCatalog();
    let installedVersion = '0.9.0';
    runtimeMocks.statusCommandV8.mockImplementation(async () => status({
      ...catalog, installedVersion,
    }));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd,
      env: catalog.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const intent: PluginWriteTaskIntent = {
      kind: 'pluginWriteTask', goal: 'update', executionPolicy: 'all',
      targets: [{
        pluginId: 'team/beta', platform: 'claude', scope: 'project',
        expectedUpdate: {
          installedVersion, activeVersion: '1.0.0',
          sourceIdentity: catalog.sourceIdentity, generationKey: catalog.generationKey,
        },
      }],
    };
    const evidence = await dependencies.captureEvidence(
      intent, new AbortController().signal,
    ) as PluginWriteTaskEvidence;
    installedVersion = '0.9.1';

    await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
    expect(runtimeMocks.taskWriteCommand.mock.calls.filter((call) =>
      call[2]?.previewOperationPlan !== true)).toEqual([]);
  });

  it('carries a transient locked source root cause through the stale boundary', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const intent = updateIntent(catalog);
    const evidence = await dependencies.captureEvidence(
      intent, new AbortController().signal,
    ) as PluginWriteTaskEvidence;
    await fs.remove(path.join(catalog.env.AW_HOME!, 'catalog-store', catalog.generationKey));
    dependencies.beginCatalogSession?.();

    await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
      diagnostics: [
        expect.objectContaining({
          code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/alpha' }),
        }),
        expect.objectContaining({
          code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/beta' }),
        }),
      ],
    });
  });

  it('keeps a source failure that occurs after a successful status read', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    await dependencies.loadStatus(new AbortController().signal);
    await fs.remove(path.join(catalog.env.AW_HOME!, 'catalog-store', catalog.generationKey));
    dependencies.beginCatalogSession?.();

    await expect(dependencies.captureEvidence(
      updateIntent(catalog),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'taskNoExecutableTargets',
      diagnostics: [
        expect.objectContaining({
          code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/alpha' }),
        }),
        expect.objectContaining({
          code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/beta' }),
        }),
      ],
    });
  });

  it('keeps structured target failures when preview returns no operation plan', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => {
      const result = commandResult(targets);
      return {
        ...result,
        operationPlan: undefined,
        overallState: 'failed',
        rebuildResults: [{
          status: 'failed',
          target: { pluginId: 'team/alpha', platform: 'codex', scope: 'user' },
          actions: [{ name: 'preflight.inspect', status: 'failed' }],
          error: {
            phase: 'preflight.inspect',
            message: 'argv --token private-value /Users/private/source',
            operationDiagnostic: {
              code: 'issueVerificationFailed', stage: 'preflight.inspect',
              safeMessage: 'The target inspection could not verify the current target.',
            },
          },
        }],
      };
    });

    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const error = await dependencies.captureEvidence(
      updateIntent(catalog), new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'taskNoExecutableTargets',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'issueVerificationFailed', stage: 'preflight.inspect', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/alpha' }),
        }),
        expect.objectContaining({
          code: 'taskOperationPlanMissing', stage: 'dependencyPlan', sourceId: 'team',
          target: expect.objectContaining({ pluginId: 'team/beta' }),
        }),
      ]),
    });
    const diagnostics = (error as { diagnostics: Array<{ code: string; target?: { pluginId?: string } }> }).diagnostics;
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'issueVerificationFailed'))
      .toEqual([expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/alpha' }) })]);
    expect(JSON.stringify(error)).not.toContain('private-value');
    expect(JSON.stringify(error)).not.toContain('/Users/private');
  });

  it('keeps one failed source diagnostic while executing another source subset', async () => {
    const catalog = await configureMixedCatalog();
    const lab = catalog.sources.lab;
    const labStatus = status({
      cwd: catalog.cwd,
      configDigest: catalog.configDigest,
      sourceIdentity: lab.sourceIdentity,
    });
    labStatus.payload.catalog.primarySourceId = 'team';
    labStatus.payload.catalog.sources = [{
      id: 'lab', identity: lab.sourceIdentity, type: 'path', primary: false,
      requestedRef: 'path', freshness: 'active', catalogVersion: '1.0.0',
    }];
    for (const target of labStatus.payload.targets) {
      target.pluginName = 'gamma';
      target.pluginId = 'lab/gamma';
      target.sourceId = 'lab';
    }
    labStatus.payload.targets = [labStatus.payload.targets[0]!];
    labStatus.pluginSummaries = [{
      pluginName: 'gamma', pluginId: 'lab/gamma', displayName: 'Gamma',
      description: 'Gamma', version: '1.0.0',
      supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0,
    }];
    labStatus.targetRevisions = [{
      pluginId: 'lab/gamma', platform: 'codex', scope: 'user',
      revision: { state: 'upgradeAvailable', installedVersion: '0.9.0', availableVersion: '1.0.0' },
    }];
    runtimeMocks.statusCommandV8.mockResolvedValue(labStatus);
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    await fs.remove(path.join(
      catalog.env.AW_HOME!, 'catalog-store', catalog.sources.team.generationKey,
    ));
    dependencies.beginCatalogSession?.();
    const expected = (sourceId: 'team' | 'lab') => ({
      installedVersion: '0.9.0', activeVersion: '1.0.0',
      sourceIdentity: catalog.sources[sourceId].sourceIdentity,
      generationKey: catalog.sources[sourceId].generationKey,
    });
    const intent: PluginWriteTaskIntent = {
      kind: 'pluginWriteTask', goal: 'update', executionPolicy: 'executableSubset',
      targets: [
        { pluginId: 'team/alpha', platform: 'codex', scope: 'user', expectedUpdate: expected('team') },
        { pluginId: 'lab/gamma', platform: 'codex', scope: 'user', expectedUpdate: expected('lab') },
      ],
    };

    const evidence = await dependencies.captureEvidence(
      intent, new AbortController().signal,
    ) as PluginWriteTaskEvidence;
    expect(evidence.taskPlan.executableTargets.map((target) => target.pluginId)).toEqual(['lab/gamma']);
    expect(evidence.taskPlan.blockedTargets).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        diagnostics: [expect.objectContaining({
          code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
        })],
      }),
    ]);
    const execution = await dependencies.executeIntent(intent, evidence) as PluginWriteTaskExecutionResult;
    expect(execution.sourceResults).toHaveLength(1);
    expect(execution.sourceResults[0]).toMatchObject({ sourceId: 'lab' });
    const projection = projectExecutionDiagnostics(execution, 'mixed-task', [], 'pluginWriteTask');
    expect(projection.diagnostics).toContainEqual(expect.objectContaining({
      code: 'catalogGenerationMetadataInvalid', stage: 'source', sourceId: 'team',
      target: expect.objectContaining({ pluginId: 'team/alpha' }),
    }));
  });

  it('keeps an aborted preparation as cancellation', async () => {
    const catalog = await configureCatalog();
    const abort = new AbortController();
    abort.abort();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));

    await expect(dependencies.captureEvidence(updateIntent(catalog), abort.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('moves a blocked requested plan target out of the executable subset and repreviews', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => {
      const result = commandResult(targets);
      if (targets.length !== 2) return result;
      return {
        ...result,
        dependencyPlan: {
          requestedPluginIds: ['team/alpha', 'team/beta'],
          resolvedPluginIds: ['team/alpha', 'team/beta'], dependencyEdges: [], scopeOverrides: [],
          targets: [
            {
              pluginId: 'team/alpha', pluginName: 'alpha', platform: 'codex',
              relation: 'requested', depth: 0, requiredBy: [], requiredByTargets: [],
              requestedScope: 'user', rootScope: 'user', minimumScope: 'user',
              resolvedScope: 'user', allowedScopes: ['user'], assignmentSource: 'root',
              locked: true, affectsOtherProjects: true, state: 'error', action: 'block',
              errorCode: 'artifactCollision', order: 0,
            },
            {
              pluginId: 'team/beta', pluginName: 'beta', platform: 'claude',
              relation: 'requested', depth: 0, requiredBy: [], requiredByTargets: [],
              requestedScope: 'project', rootScope: 'project', minimumScope: 'project',
              resolvedScope: 'project', allowedScopes: ['project'], assignmentSource: 'root',
              locked: true, affectsOtherProjects: false, state: 'present', action: 'install', order: 1,
            },
          ],
        },
      };
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));

    const evidence = await dependencies.captureEvidence(
      updateIntent(catalog), new AbortController().signal,
    ) as PluginWriteTaskEvidence;

    expect(evidence.taskPlan.executableTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/beta', platform: 'claude', scope: 'project' }),
    ]);
    expect(evidence.taskPlan.blockedTargets).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        reason: 'targetUnavailable', errorCodes: ['artifactCollision'],
      }),
    ]);
    expect(runtimeMocks.taskWriteCommand).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.taskWriteCommand.mock.calls[1]?.[0]).toEqual([
      { pluginId: 'team/beta', platform: 'claude', scope: 'project', method: 'reinstall' },
    ]);
  });

  it('maps a blocked shared dependency only to its connected root', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () => status(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => {
      const result = commandResult(targets);
      if (targets.length !== 2) return result;
      return {
        ...result,
        dependencyPlan: {
          requestedPluginIds: ['team/alpha', 'team/beta'],
          resolvedPluginIds: ['team/alpha', 'team/beta', 'team/shared'],
          dependencyEdges: [{ from: 'team/alpha', to: 'team/shared', platform: 'codex' }],
          scopeOverrides: [],
          targets: [{
            pluginId: 'team/shared', pluginName: 'shared', platform: 'codex',
            relation: 'dependency', depth: 1, requiredBy: ['team/alpha'],
            requiredByTargets: [{ pluginId: 'team/alpha', platform: 'codex', scope: 'user' }],
            rootScope: 'user', minimumScope: 'user', resolvedScope: 'user',
            allowedScopes: ['user'], assignmentSource: 'consumerPromotion', locked: false,
            affectsOtherProjects: true, state: 'error', action: 'block',
            errorCode: 'dependencyNotReady', order: 0,
          }],
        },
      };
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));

    const evidence = await dependencies.captureEvidence(
      updateIntent(catalog), new AbortController().signal,
    ) as PluginWriteTaskEvidence;

    expect(evidence.taskPlan.executableTargets.map((target) => target.pluginId)).toEqual(['team/beta']);
    expect(evidence.taskPlan.blockedTargets).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        errorCodes: ['dependencyNotReady'],
      }),
    ]);
  });

  it('does not restore a user dependency over an older project installation', async () => {
    const catalog = await configureCatalog();
    const current = sharedDependencyRestoreStatus(catalog);
    const projectDependency = current.payload.targets.find((target) =>
      target.pluginId === 'team/beta' && target.scope === 'project')!;
    projectDependency.state = 'ready';
    projectDependency.components = [{ kind: 'ownership', key: 'beta-project', state: 'present' }];
    const projectRevision = current.targetRevisions!.find((target) =>
      target.pluginId === 'team/beta' && target.scope === 'project')!;
    projectRevision.revision = {
      state: 'upgradeAvailable', installedVersion: '0.9.0', availableVersion: '1.0.0',
    };
    runtimeMocks.statusCommandV8.mockResolvedValue(current);
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => commandResult(targets));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));

    await expect(dependencies.captureEvidence({
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: [{ pluginId: 'team/alpha', platform: 'claude', scope: 'user' }],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'taskNoExecutableTargets' });
    expect(runtimeMocks.taskWriteCommand).not.toHaveBeenCalled();
  });

  it('normalizes two missing dependency scopes to one promoted repair target', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV8.mockImplementation(async () =>
      sharedDependencyRestoreStatus(catalog));
    runtimeMocks.taskWriteCommand.mockImplementation(async (targets) => ({
      ...commandResult(targets),
      dependencyPlan: {
        requestedPluginIds: ['team/alpha'],
        resolvedPluginIds: ['team/alpha', 'team/beta'],
        dependencyEdges: [{ from: 'team/alpha', to: 'team/beta', platform: 'claude' }],
        scopeOverrides: [],
        targets: [
          {
            pluginId: 'team/alpha', pluginName: 'alpha', platform: 'claude',
            relation: 'requested', depth: 0, requiredBy: [], requiredByTargets: [],
            requestedScope: 'project', rootScope: 'project', minimumScope: 'project',
            resolvedScope: 'project', allowedScopes: ['project'], assignmentSource: 'root',
            locked: true, affectsOtherProjects: false, state: 'partial', action: 'sync', order: 0,
          },
          {
            pluginId: 'team/alpha', pluginName: 'alpha', platform: 'claude',
            relation: 'requested', depth: 0, requiredBy: [], requiredByTargets: [],
            requestedScope: 'user', rootScope: 'user', minimumScope: 'user',
            resolvedScope: 'user', allowedScopes: ['user'], assignmentSource: 'root',
            locked: true, affectsOtherProjects: true, state: 'partial', action: 'sync', order: 1,
          },
          {
            pluginId: 'team/beta', pluginName: 'beta', platform: 'claude',
            relation: 'dependency', depth: 1, requiredBy: ['team/alpha'],
            requiredByTargets: [
              { pluginId: 'team/alpha', platform: 'claude', scope: 'project' },
              { pluginId: 'team/alpha', platform: 'claude', scope: 'user' },
            ],
            rootScope: 'user', minimumScope: 'project', resolvedScope: 'user',
            allowedScopes: ['project', 'user'], assignmentSource: 'consumerPromotion',
            locked: false, affectsOtherProjects: true, state: 'absent', action: 'install', order: 2,
          },
        ],
      },
    }));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: catalog.cwd, env: catalog.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const intent: PluginWriteTaskIntent = {
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: [
        { pluginId: 'team/alpha', platform: 'claude', scope: 'user' },
        { pluginId: 'team/alpha', platform: 'claude', scope: 'project' },
      ],
    };

    const evidence = await dependencies.captureEvidence(
      intent, new AbortController().signal,
    ) as PluginWriteTaskEvidence;

    expect(runtimeMocks.taskWriteCommand).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.taskWriteCommand.mock.calls[1]?.[1]?.repairTargets).toEqual([{
      pluginId: 'team/beta', platform: 'claude', scope: 'user', method: 'sync',
    }]);
    expect(evidence.taskPlan.causes).toEqual([expect.objectContaining({
      repairTarget: { pluginId: 'team/beta', platform: 'claude', scope: 'user' },
      restoreVersionEvidence: { state: 'absent', activeVersion: '1.0.0' },
      consumers: [
        { pluginId: 'team/alpha', platform: 'claude', scope: 'project' },
        { pluginId: 'team/alpha', platform: 'claude', scope: 'user' },
      ],
    })]);
  });
});
