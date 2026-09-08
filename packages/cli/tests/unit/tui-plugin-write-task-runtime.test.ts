import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type { RebuildTaskTarget } from '../../src/commands/rebuild-command.js';
import type { StatusV7Payload } from '../../src/commands/status-v6.js';
import {
  createTuiControllerDependencies,
} from '../../src/tui/controller-runtime.js';
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
  statusCommandV7: vi.fn(),
  taskWriteCommand: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV7: runtimeMocks.statusCommandV7,
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

function status(options: {
  cwd: string;
  configDigest: string;
  sourceIdentity: string;
  installedVersion?: string;
}): Awaited<ReturnType<typeof runtimeMocks.statusCommandV7>> {
  const installedVersion = options.installedVersion ?? '0.9.0';
  const targets: StatusV7Payload['targets'] = [
    {
      pluginName: 'alpha', pluginId: 'team/alpha', sourceId: 'team',
      sourceIdentity: options.sourceIdentity, version: '1.0.0',
      platform: 'codex', scope: 'user', cwd: options.cwd, state: 'ready',
      components: [{ kind: 'ownership', key: 'alpha', state: 'present' }],
      reasons: [], recoveryActions: [],
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
      schemaVersion: 7,
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
    targetRevisions: targets.map((target) => ({
      pluginId: target.pluginId, platform: target.platform, scope: target.scope,
      revision: {
        state: 'upgradeAvailable' as const,
        installedVersion,
        availableVersion: '1.0.0',
      },
    })),
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
}): Awaited<ReturnType<typeof runtimeMocks.statusCommandV7>> {
  const rootTarget = (scope: 'user' | 'project'): StatusV7Payload['targets'][number] => ({
    pluginName: 'alpha', pluginId: 'team/alpha', sourceId: 'team',
    sourceIdentity: options.sourceIdentity, version: '1.0.0',
    platform: 'claude', scope, cwd: options.cwd, state: 'needsSync',
    components: [{ kind: 'ownership', key: `alpha-${scope}`, state: 'present' }],
    reasons: [{
      code: 'dependencyMissing', message: `team/beta is missing from ${scope}`,
      severity: 'blocking', dependencyPluginId: 'team/beta', dependencyPlatform: 'claude',
      dependencyScope: scope, rootIssueId: `missing-beta-${scope}`,
      rootIssueCode: 'dependencyMissing',
    }],
    recoveryActions: [],
  });
  const dependencyTarget = (scope: 'user' | 'project'): StatusV7Payload['targets'][number] => ({
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
      schemaVersion: 7,
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
    runtimeMocks.statusCommandV7.mockImplementation(async () => status(catalog));
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
    runtimeMocks.statusCommandV7.mockImplementation(async () => status({
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

  it('moves a blocked requested plan target out of the executable subset and repreviews', async () => {
    const catalog = await configureCatalog();
    runtimeMocks.statusCommandV7.mockImplementation(async () => status(catalog));
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
    runtimeMocks.statusCommandV7.mockImplementation(async () => status(catalog));
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
    runtimeMocks.statusCommandV7.mockResolvedValue(current);
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
    runtimeMocks.statusCommandV7.mockImplementation(async () =>
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
