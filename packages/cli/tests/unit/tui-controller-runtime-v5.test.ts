import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';

import { flattenStatusTargets, type StatusV8Payload } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  configAffectedStatusTargets,
  createTuiControllerDependencies,
  statusTargetFingerprint,
} from '../../src/tui/controller-runtime.js';
import {
  TuiConfigInvalidStoreError,
  TuiController,
  type OperationEvidence,
} from '../../src/tui/controller.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  createCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import {
  readCatalogSnapshotLogicalIdentity,
} from '../../src/utils/catalog-generation-store.js';
import {
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const OFFLINE_SOURCE_IDENTITY = `sha256:${'1'.repeat(64)}`;

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const result = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources) {
    await syncCatalogSourceGeneration({
      sourceId: source.id, cliVersion: '1.0.0', env: options.env,
    });
  }
  return result;
}

const runtimeMocks = vi.hoisted(() => ({
  statusCommandV8: vi.fn(),
  preflightCatalogSourceMutation: vi.fn(),
  setPrimaryCatalogSourceCommand: vi.fn(),
  probeCatalogSourceGeneration: vi.fn(),
  activateCatalogSourceGeneration: vi.fn(),
  preparePortableInstall: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  replayConfigRuntimeWrites: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
  resolveConfigPreApplyAuthorization: vi.fn(),
  readRecoveryStatus: vi.fn(),
  prepareRecovery: vi.fn(),
  executeRecovery: vi.fn(),
  prepareRetire: vi.fn(),
  executeRetire: vi.fn(),
}));

vi.mock('../../src/recovery/status.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/recovery/status.js')>(),
  readRecoveryStatus: runtimeMocks.readRecoveryStatus,
}));

vi.mock('../../src/recovery/coordinator.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/recovery/coordinator.js')>(),
  prepareRecovery: runtimeMocks.prepareRecovery,
  executeRecovery: runtimeMocks.executeRecovery,
}));

vi.mock('../../src/recovery/retirement.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/recovery/retirement.js')>(),
  prepareRetire: runtimeMocks.prepareRetire,
  executeRetire: runtimeMocks.executeRetire,
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: runtimeMocks.statusCommandV8,
}));

vi.mock('../../src/commands/catalog-source.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/catalog-source.js')>(),
  preflightCatalogSourceMutation: runtimeMocks.preflightCatalogSourceMutation,
  setPrimaryCatalogSourceCommand: runtimeMocks.setPrimaryCatalogSourceCommand,
}));

vi.mock('../../src/portable/commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/commands.js')>(),
  preparePortableInstall: runtimeMocks.preparePortableInstall,
}));

vi.mock('../../src/utils/catalog-generation-service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/catalog-generation-service.js')>(),
  probeCatalogSourceGeneration: runtimeMocks.probeCatalogSourceGeneration,
  activateCatalogSourceGeneration: runtimeMocks.activateCatalogSourceGeneration,
}));

vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite: runtimeMocks.applyPluginConfigWrite,
  replayConfigRuntimeWrites: runtimeMocks.replayConfigRuntimeWrites,
  resetPluginConfigWithHelper: runtimeMocks.resetPluginConfigWithHelper,
  resolveConfigPreApplyAuthorization: runtimeMocks.resolveConfigPreApplyAuthorization,
}));

function statusPlacement(
  scope: 'user' | 'project',
  state: 'absent' | 'present' | 'partial' | 'error',
){
  const enabled = state === 'present' || state === 'partial';
  const targetState = state === 'present'
    ? 'ready' as const
    : state === 'partial'
      ? 'needsSync' as const
      : state === 'error' ? 'blocked' as const : 'absent' as const;
  return {
    scope,
    state: targetState,
    components: [
      {
        kind: 'intent' as const, key: 'desired', state: enabled ? 'desired' : 'absent',
        metadata: { enabled, scopes: enabled ? [scope] : [], relation: enabled ? 'managed' : 'none' },
      },
      { kind: 'ownership' as const, key: 'fixture', state },
      {
        kind: 'activation' as const, key: scope, state: enabled ? 'enabled' : 'disabled',
        metadata: { evidence: 'assumed' },
      },
    ],
    reasons: state === 'error'
      ? [{ code: 'targetError', message: 'safe failure', severity: 'blocking' as const }]
      : [],
    recoveryActions: [],
  };
}

function target(
  scope: 'user' | 'project',
  state: 'absent' | 'present' | 'partial' | 'error',
): StatusV8Payload['targets'][number] {
  const placement = statusPlacement(scope, state);
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: OFFLINE_SOURCE_IDENTITY,
    version: '1.0.0',
    platform: 'codex',
    cwd: '/workspace',
    state: placement.state,
    components: [],
    reasons: placement.reasons,
    recoveryActions: placement.recoveryActions,
    placements: [placement],
  };
}

function claudeTarget(
  scope: 'user' | 'project',
  state: 'absent' | 'present' | 'partial' | 'error',
): StatusV8Payload['targets'][number] {
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: OFFLINE_SOURCE_IDENTITY,
    version: '1.0.0',
    platform: 'claude',
    cwd: '/workspace',
    ...statusPlacement(scope, state),
  };
}

function bundleUnavailableStatus(
  configDigest = 'sha256:config',
): Awaited<ReturnType<typeof runtimeMocks.statusCommandV8>> {
  const orphan = target('user', 'error');
  orphan.reasons = [{ code: 'bundleUnavailable', message: 'safe failure', severity: 'blocking' }];
  orphan.placements[0]!.reasons = orphan.reasons;
  return {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'official',
        configDigest,
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'official',
          identity: 'identity:official',
          type: 'path',
          primary: true,
          requestedRef: 'path',
          freshness: 'active',
        }],
      },
      filters: { plugins: ['official/demo'], platform: 'codex', cwd: '/workspace' },
      targets: [orphan],
      errors: [],
    },
    pluginSummaries: [],
  };
}

describe('TUI scoped recovery runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects a real project declaration into the shared plugin detail', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-project-detail-source');
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true,
        path: sourceRoot }] },
      expectedDigest: current.digest, env: isolation.env,
    });
    await writeIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env }, { roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    const actual = await vi.importActual<typeof import('../../src/commands/status-v6.js')>(
      '../../src/commands/status-v6.js');
    const result = await actual.statusCommandV8({ cwd: isolation.layout.fixtureCwd,
      env: isolation.env, cliVersion: '1.0.0' });
    const controller = new TuiController({ loadStatus: async () => ({
      payload: result.payload, pluginSummaries: result.pluginSummaries,
      targetRevisions: result.targetRevisions, projectRoot: result.projectRoot,
    }) });
    await controller.load();
    expect(controller.getPluginDetailSubject('local/demo')?.placements).toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'codex', scope: 'project',
        declared: true })]));
    expect(controller.listUserIssues().filter((issue) => issue.pluginId === 'local/demo'
      && issue.scope === 'project').map((issue) => issue.category)).not.toContain('orphaned');
    controller.dispose();
  });

  it('returns one scoped Native observation with recovery facts and keeps public JSON unchanged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));
    const actual = await vi.importActual<typeof import('../../src/recovery/status.js')>('../../src/recovery/status.js');
    runtimeMocks.readRecoveryStatus.mockImplementation(actual.readRecoveryStatus);
    const native = { ...bundleUnavailableStatus(), targetRevisions: [], nativeObservations: [], nativeExtraObserved: [] };
    runtimeMocks.statusCommandV8.mockResolvedValue(native);
    const signal = new AbortController().signal;
    const result = await dependencies.loadScopedStatus!('user', signal);
    expect(result).toMatchObject({ scope: 'user', nativeSnapshot: { payload: native.payload, targetRevisions: [] } });
    expect(runtimeMocks.statusCommandV8).toHaveBeenCalledOnce();
    expect(runtimeMocks.readRecoveryStatus.mock.calls[0]![0].signal).toBe(signal);
    expect(runtimeMocks.statusCommandV8.mock.calls[0]![0].signal).toBe(signal);
    expect(runtimeMocks.statusCommandV8.mock.calls[0]![0].scope).toBe('user');
    expect(runtimeMocks.statusCommandV8.mock.calls[0]![0].cwd).not.toBe(isolation.layout.fixtureCwd);
    const publicStatus = await runtimeMocks.readRecoveryStatus.mock.results[0]!.value;
    expect(JSON.parse(JSON.stringify(publicStatus))).not.toHaveProperty('nativeSnapshot');
    expect(JSON.parse(JSON.stringify(publicStatus))).not.toHaveProperty('payload');
  });

  it('passes one scope through recovery preparation and execution', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    });
    const dependencies = createTuiControllerDependencies(context);
    const prepared = { scope: 'project' };
    const receipt = { scope: 'project', declarationChanged: false, configChanged: false };
    runtimeMocks.prepareRecovery.mockResolvedValue(prepared);
    runtimeMocks.executeRecovery.mockResolvedValue(receipt);

    const plan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'sync', selectors: ['team/demo'],
      targets: ['codex'], exactTargets: [{ pluginId: 'team/demo', agent: 'codex' }],
      scriptTimeoutMs: 12_000,
      dependencyScopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'user' }],
    }, new AbortController().signal);
    expect(runtimeMocks.prepareRecovery).toHaveBeenCalledWith('sync', ['team/demo'],
      expect.objectContaining({ scope: 'project', cwd: context.cwd, env: context.env,
        all: false, targets: ['codex'], exactTargets: [{ pluginId: 'team/demo', agent: 'codex' }],
        scriptTimeoutMs: 12_000,
        dependencyScopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'user' }],
      }), context);
    await expect(dependencies.executeScopedTask!(plan)).resolves.toEqual({ kind: 'recovery', receipt });
    expect(runtimeMocks.executeRecovery).toHaveBeenCalledWith(prepared, { yes: true, runtime: context });
  });

  it('prepares retire for one scope with config deletion off by default', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    });
    const dependencies = createTuiControllerDependencies(context);
    const prepared = { options: { scope: 'user' } };
    const receipt = { scope: 'user', command: 'intent:retire' };
    runtimeMocks.prepareRetire.mockResolvedValue(prepared);
    runtimeMocks.executeRetire.mockResolvedValue(receipt);

    const plan = await dependencies.prepareScopedTask!({ kind: 'retire', scope: 'user',
      selector: 'team/removed' }, new AbortController().signal);
    expect(runtimeMocks.prepareRetire).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user', cwd: context.cwd, env: context.env, selector: 'team/removed', deleteConfig: false,
    }), context);
    await expect(dependencies.executeScopedTask!(plan)).resolves.toEqual({ kind: 'recovery', receipt });
    expect(runtimeMocks.executeRetire).toHaveBeenCalledWith(prepared, { yes: true, runtime: context });
  });

  it('releases a recovery context if preparation completes after cancellation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));
    const abort = new AbortController();
    const dispose = vi.fn();
    runtimeMocks.prepareRecovery.mockImplementation(async () => {
      abort.abort();
      return { context: { dispose } };
    });

    await expect(dependencies.prepareScopedTask!({ kind: 'recovery', scope: 'user',
      selectors: ['team/demo'] }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('removes only the reviewed declaration without changing outputs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));

    const plan = await dependencies.prepareScopedTask!({ kind: 'intent', scope: 'user',
      action: 'remove', selector: 'team/demo' }, new AbortController().signal);
    await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
      kind: 'recovery', receipt: { scope: 'user', declarationChanged: true,
        preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false },
    });
  });

  it('saves user targets without starting recovery or changing project targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      ...location, interactive: false,
    }));
    const projectBefore = await observePreferences({ ...location, scope: 'project' });

    const plan = await dependencies.prepareScopedTask!({ kind: 'targets', scope: 'user',
      action: 'set', agents: ['codex'] }, new AbortController().signal);
    await expect(dependencies.executeScopedTask!(plan)).resolves.toEqual({
      kind: 'targets', changed: true, agents: ['codex'],
    });
    expect(await observePreferences({ ...location, scope: 'user' })).toMatchObject({
      state: 'valid', value: { agents: ['codex'] },
    });
    expect(await observePreferences({ ...location, scope: 'project' })).toEqual(projectBefore);
    expect(runtimeMocks.prepareRecovery).not.toHaveBeenCalled();
  });
});

describe('TUI config affected targets', () => {
  it('reviews every field in a combined source update and the bound script timeout', () => {
    const sourceMutation = {
      action: 'update' as const,
      update: {
        url: 'https://example.test/catalog.git',
        refPolicy: { type: 'explicit' as const, ref: 'catalog/beta' },
        subdir: null,
        autoCheck: false,
      },
    };
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      catalogGeneration: {
        action: 'activate',
        candidate: {
          sourceConfigFingerprint: 'sha256:source-config',
          sourceIdentity: 'sha256:source',
          logicalIdentity: 'workspace',
          requestedRef: 'catalog/beta',
          resolvedCommit: 'a'.repeat(40),
          catalogVersion: '1.0.0',
          channel: 'beta',
          manifestDigest: 'sha256:manifest',
          snapshotDigest: 'sha256:snapshot',
        },
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:after',
        sourceMutation,
      },
    };
    const sourceReview = buildOperationReviewProjection({
      intent: { kind: 'catalogGeneration', action: 'activate', sourceId: 'team', sourceMutation },
      evidence,
    });
    expect(sourceReview.changes.map((change) => [change.title, change.description])).toEqual(
      expect.arrayContaining([
        ['Git URL', '将更新'],
        ['Git ref policy', '固定 ref · catalog/beta'],
        ['插件目录子目录', '根目录'],
        ['自动检查', '关闭'],
      ]),
    );
    const addReview = buildOperationReviewProjection({
      intent: {
        kind: 'catalogGeneration', action: 'activate', sourceId: 'local',
        sourceMutation: {
          action: 'add',
          source: {
            id: 'local', type: 'path', path: '/private/catalog', primary: false, autoCheck: false,
          },
        },
      },
      evidence: {
        ...evidence,
        catalogGeneration: {
          ...evidence.catalogGeneration!,
          sourceMutation: {
            action: 'add',
            source: {
              id: 'local', type: 'path', path: '/private/catalog', primary: false, autoCheck: false,
            },
          },
        },
      },
    });
    expect(addReview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '保存来源配置' }),
      expect.objectContaining({ title: '本地目录', description: '已设置' }),
      expect.objectContaining({ title: '自动检查', description: '关闭' }),
    ]));
    expect(JSON.stringify(addReview)).not.toContain('/private/catalog');

    const timeoutReview = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWrite', action: 'sync', pluginId: 'team/demo',
        platform: 'codex', scope: 'project', scriptTimeoutMs: 12_000,
      },
      evidence: { catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' } },
    });
    expect(timeoutReview.changes).toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时', description: '12000 ms',
    }));
    expect(timeoutReview.equivalentCommand).toContain('--script-timeout 12000');
    expect(timeoutReview.equivalentCommand).toContain('--target codex');
    expect(timeoutReview.equivalentCommand).not.toContain('--platform');
  });

  it('expands user scope conflicts and keeps project layers project-only', () => {
    const codex = target('user', 'present');
    codex.placements.push(statusPlacement('project', 'partial'));
    codex.state = 'needsSync';
    const targets = [
      codex,
      claudeTarget('user', 'present'),
      claudeTarget('project', 'error'),
    ];

    expect(configAffectedStatusTargets(targets, 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'claude:user', 'codex:project', 'codex:user',
    ]);
    expect(configAffectedStatusTargets(targets, 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });

  it('applies config only to verified installed consumers, including an orphaned target', () => {
    const desiredMissing = target('user', 'absent');
    desiredMissing.placements[0]!.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['user'], relation: 'root',
    };
    const orphanedActual = target('project', 'present');
    orphanedActual.placements[0]!.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: false, scopes: [], relation: 'none',
    };

    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'user',
    ).map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'project',
    ).map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });

  it('does not infer a second installed consumer from intent on a collapsed target', () => {
    const collapsed = target('user', 'present');
    collapsed.placements[0]!.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    };

    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'codex:user',
    ]);
    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([]);
  });
});


describe('TUI controller runtime scope conflict validation', () => {

  it('loads recognizable saved settings without a current Catalog plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginConfigStore({
      sourceId: 'removed',
      sourceIdentity: 'identity:removed',
      logicalIdentity: 'workspace:removed',
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: true },
    });
    const brokenPath = resolvePluginConfigStorePath({
      sourceId: 'removed', pluginName: 'broken', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.ensureDir(path.dirname(brokenPath));
    await fs.writeFile(brokenPath, '{broken');
    const catalogConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV8.mockResolvedValue({
      projectRoot: await fs.realpath(isolation.layout.fixtureCwd),
      payload: {
        schemaVersion: 8,
        catalog: {
          primarySourceId: 'official', configDigest: catalogConfig.digest,
          compositeDigest: 'sha256:composite', sources: [],
        },
        filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd },
        targets: [], errors: [],
      },
      pluginSummaries: [], targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));

    await expect(dependencies.loadStatus(new AbortController().signal)).resolves.toMatchObject({
      projectRoot: await fs.realpath(isolation.layout.fixtureCwd),
      configuredSources: [expect.objectContaining({ id: 'official', type: 'git' })],
      configStoreInventory: [
        { pluginId: 'removed/broken', sourceId: 'removed', pluginName: 'broken', scope: 'user' },
        { pluginId: 'removed/demo', sourceId: 'removed', pluginName: 'demo', scope: 'user' },
      ],
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.resolveConfigPreApplyAuthorization.mockResolvedValue({
      targets: [], availableApplyTargets: [], unavailableTargetResults: [],
    });
  });





  it('includes the private revision sidecar in the target review fingerprint', () => {
    const targets = [target('user', 'present')];
    const current = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'current' as const, availableVersion: '1.0.0', installedVersion: '1.0.0' },
    }];
    const upgradeAvailable = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, availableVersion: '2.0.0', installedVersion: '1.0.0' },
    }];

    expect(statusTargetFingerprint(targets, current))
      .not.toBe(statusTargetFingerprint(targets, upgradeAvailable));
  });

  it('includes shared V8 native metadata and shared reasons in the target review fingerprint', () => {
    const codex = target('user', 'present');
    codex.placements.push(statusPlacement('project', 'present'));
    codex.components.push({
      kind: 'sharedNative', key: 'demo@aw-official', state: 'replaceable',
      metadata: { shared: true, reason: 'renderDrift', version: '1.0.0' },
    });
    codex.reasons = [{
      code: 'codexSharedNativeRenderDrift', message: 'shared render drift', severity: 'warning',
    }];

    const baseline = statusTargetFingerprint(flattenStatusTargets([codex]));
    const changedMetadata = structuredClone(codex);
    changedMetadata.components[0] = {
      ...changedMetadata.components[0]!,
      metadata: { shared: true, reason: 'renderDrift', version: '2.0.0' },
    };
    const changedReason = structuredClone(codex);
    changedReason.reasons = [{
      code: 'codexSharedNativeUpdateRequired', message: 'shared update required', severity: 'warning',
    }];

    expect(baseline).not.toBe(statusTargetFingerprint(flattenStatusTargets([changedMetadata])));
    expect(baseline).not.toBe(statusTargetFingerprint(flattenStatusTargets([changedReason])));
  });



  it('prepares config review from loaded session evidence without another status or remote stage', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-config-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'export default async () => undefined;\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV8.mockResolvedValue({
      payload: {
        schemaVersion: 8,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        targets: [
          { ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team' },
          { ...target('project', 'partial'), pluginId: 'team/demo', sourceId: 'team' },
        ],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo',
        pluginName: 'demo',
        sourceId: 'team',
        sourceIdentity: 'ignored-by-test',
        dependencyDirectCount: 0,
        dependencyTotalCount: 0,
      }],
      targetRevisions: [
        { pluginId: 'team/demo', platform: 'codex', scope: 'user', revision: { state: 'current', availableVersion: '1.0.0' } },
        { pluginId: 'team/demo', platform: 'codex', scope: 'project', revision: { state: 'current', availableVersion: '1.0.0' } },
      ],
    });
    let reviewLogCount = 0;
    const debugLog = vi.fn((event: { type: string }) => {
      if (!event.type.startsWith('review.prepare.')) return undefined;
      reviewLogCount += 1;
      if (reviewLogCount === 1) throw new Error('log unavailable');
      return Promise.reject(new Error('async log unavailable'));
    });
    const times = [10, 14, 20, 27, 31, 40];
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      debugLogger: { log: debugLog },
    }), undefined, { now: () => times.shift() ?? 40 });
    const stages: string[] = [];
    const signal = new AbortController().signal;
    await dependencies.loadStatus(signal);

    const evidence = await dependencies.prepareReviewEvidence!({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      updates: { mode: 'strict' },
    }, signal, (stage) => { stages.push(stage); });
    expect(evidence).toMatchObject({
      config: {
        scope: 'user',
        affectedTargets: [
          { platform: 'codex', scope: 'project' },
          { platform: 'codex', scope: 'user' },
        ],
      },
    });

    expect(runtimeMocks.statusCommandV8).toHaveBeenCalledOnce();
    expect(stages).toEqual(['config', 'evidence']);
    expect(debugLog.mock.calls.map(([event]) => event)
      .filter((event) => event.type.startsWith('review.prepare.'))).toEqual([
      expect.objectContaining({ type: 'review.prepare.config' }),
      expect.objectContaining({ type: 'review.prepare.evidence' }),
    ]);

    const storePath = path.join(isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json');
    const envelope = {
      schemaVersion: 5,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: evidence.source.sourceIdentity },
      pluginName: 'demo',
      values: { mode: 'saved' },
    };
    await fs.outputJson(storePath, envelope, { spaces: 2 });
    const beforeReorder = await dependencies.prepareReviewEvidence!({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', updates: { mode: 'strict' },
    }, signal, () => undefined);
    await fs.outputFile(storePath, `${JSON.stringify({
      values: envelope.values,
      pluginName: envelope.pluginName,
      binding: envelope.binding,
      sourceId: envelope.sourceId,
      schemaVersion: envelope.schemaVersion,
    })}\n`);
    const afterReorder = await dependencies.prepareReviewEvidence!({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', updates: { mode: 'strict' },
    }, signal, () => undefined);
    expect(afterReorder.config?.storeDigest).not.toBe(beforeReorder.config?.storeDigest);

    const controller = new TuiController(dependencies);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', apply: true,
      updates: { mode: 'strict' },
      changes: [{ key: 'mode', title: 'Mode', before: 'saved', after: 'strict' }],
    });
    const writesBeforeRawChange = runtimeMocks.applyPluginConfigWrite.mock.calls.length;
    await fs.outputJson(storePath, envelope, { spaces: 2 });
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'stale',
    });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenCalledTimes(writesBeforeRawChange);
    controller.dispose();
  });

  it('keeps Review, stale fingerprints, and writer reapply targets on one config affected-target rule', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-targets-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'export default async () => undefined;\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      manifest.config = { fields: {
        mode: { type: 'string', title: 'Mode' },
        nativeMode: { type: 'string', title: 'Native mode', default: 'safe' },
      } };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      manifest.artifacts = { targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['nativeMode'],
        skillKey: 'native-skill',
      }] };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    const userTarget = { ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team' };
    const projectTarget = {
      ...claudeTarget('project', 'partial'), pluginId: 'team/demo', sourceId: 'team',
    };
    const statusResult = (targets: StatusV8Payload['targets']) => ({
      payload: {
        schemaVersion: 8 as const,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'both' as const, cwd: isolation.layout.fixtureCwd },
        targets,
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.applyPluginConfigWrite.mockImplementation(async (options: {
      applyTargets: Array<{ platform: string; scope: string }>;
    }) => ({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: {
        state: 'succeeded',
        targetResults: options.applyTargets.map((entry) => ({ target: entry, action: 'reinstall', state: 'completed' })),
      },
    }));
    runtimeMocks.resolveConfigPreApplyAuthorization.mockResolvedValue({
      targets: [{
        pluginId: 'team/dependency',
        pluginName: 'dependency',
        sourceId: 'team',
        sourceIdentity: 'identity:team',
        platform: 'codex',
        scope: 'user',
        relation: 'direct',
      }],
      availableApplyTargets: [],
      unavailableTargetResults: [],
    });
    const createController = async (targets: StatusV8Payload['targets']) => {
      runtimeMocks.statusCommandV8.mockResolvedValue(statusResult(targets));
      const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'native 99.0.0', stderr: '' }),
        interactive: false,
      })));
      await controller.load();
      return controller;
    };
    const impactTitles = (review: Awaited<ReturnType<TuiController['buildOperationReview']>>) =>
      review.changes.filter((change) => change.group === 'configImpact').map((change) => change.title);

    const both = await createController([userTarget, projectTarget]);
    const userReview = await both.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: true, scriptTimeoutMs: 18_000, updates: { mode: 'user' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'user' }],
    });
    expect(userReview.changes).toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时', description: '18000 ms',
    }));
    expect(userReview.changes).toContainEqual(expect.objectContaining({
      title: '运行 team/dependency preApply',
      pluginId: 'team/dependency',
      relation: 'direct',
    }));
    expect(impactTitles(userReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    await expect(both.executeOperation(userReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      preApplyConfirmed: true,
      preApplyAuthorizedTargets: [expect.objectContaining({
        pluginId: 'team/dependency', platform: 'codex', scope: 'user',
      })],
      rebuildRuntime: expect.objectContaining({ scriptTimeoutMs: 18_000 }),
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    both.dispose();

    const sourceOnly = await createController([userTarget]);
    const sourceOnlyReview = await sourceOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: true, updates: { nativeMode: 'safe' },
      changes: [{ key: 'nativeMode', title: 'Native mode', before: 'safe', after: 'safe' }],
    });
    expect(impactTitles(sourceOnlyReview)).toEqual(['重新生成 native-skill 动态 Skill']);
    expect(sourceOnlyReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    sourceOnly.dispose();

    await writePluginConfigStore({
      sourceId: 'team',
      logicalIdentity: await readCatalogSnapshotLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { nativeMode: 'legacy-project-value' },
    });
    const legacyProjectOverride = await createController([userTarget, projectTarget]);
    const legacyProjectReview = await legacyProjectOverride.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared',
      apply: true, removeKeys: ['nativeMode'],
      changes: [{
        key: 'nativeMode', title: 'Native mode',
        before: 'legacy-project-value', after: 'safe',
      }],
    });
    expect(impactTitles(legacyProjectReview)).toEqual([
      '有效设置输入不变；无需重新应用',
    ]);
    expect(legacyProjectReview.requiresConfirmation).toBe(false);
    expect(JSON.stringify(legacyProjectReview.changes)).not.toContain('动态 Skill');
    legacyProjectOverride.dispose();

    const saveOnly = await createController([userTarget]);
    const saveOnlyReview = await saveOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: false, scriptTimeoutMs: 19_000, updates: { mode: 'saved' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'saved' }],
    });
    expect(saveOnlyReview.changes).not.toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时',
    }));
    await expect(saveOnly.executeOperation(saveOnlyReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      rebuildRuntime: expect.not.objectContaining({ scriptTimeoutMs: expect.anything() }),
      applyTargets: [],
    }));
    saveOnly.dispose();

    const projectOnly = await createController([userTarget, projectTarget]);
    const projectReview = await projectOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared', apply: true, updates: { mode: 'project' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'project' }],
    });
    expect(impactTitles(projectReview)).toEqual(['重新应用 Claude Code · 当前项目']);
    await expect(projectOnly.executeOperation(projectReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      applyTargets: [expect.objectContaining({ platform: 'claude', scope: 'project' })],
    }));
    projectOnly.dispose();

    runtimeMocks.replayConfigRuntimeWrites.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'succeeded', targetResults: [] },
      otherProjectsMayRequireSync: true,
    });
    const retry = await createController([userTarget, projectTarget]);
    const retryReview = await retry.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      apply: true,
      retryApply: true,
    });
    expect(impactTitles(retryReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    expect(retryReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    await expect(retry.executeOperation(retryReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.replayConfigRuntimeWrites).toHaveBeenCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      preApplyConfirmed: true,
      preApplyAuthorizedTargets: [expect.objectContaining({
        pluginId: 'team/dependency', platform: 'codex', scope: 'user',
      })],
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    retry.dispose();

    const retryWithoutApplyFlag = await createController([userTarget, projectTarget]);
    const retryWithoutApplyReview = await retryWithoutApplyFlag.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      apply: false,
      retryApply: true,
    });
    expect(impactTitles(retryWithoutApplyReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    expect(retryWithoutApplyReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    await expect(retryWithoutApplyFlag.executeOperation(retryWithoutApplyReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.replayConfigRuntimeWrites).toHaveBeenLastCalledWith(expect.objectContaining({
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    retryWithoutApplyFlag.dispose();

    const drifting = await createController([userTarget, projectTarget]);
    const driftReview = await drifting.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', apply: true, updates: { mode: 'stale' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'stale' }],
    });
    const writesBeforeDrift = runtimeMocks.applyPluginConfigWrite.mock.calls.length;
    runtimeMocks.statusCommandV8.mockResolvedValue(statusResult([userTarget]));
    const stale = await drifting.executeOperation(driftReview.reviewToken);
    expect(stale).toMatchObject({ state: 'stale' });
    if (stale.state === 'stale') {
      expect(impactTitles(stale.review)).toEqual(['重新应用 Codex · 所有项目']);
    }
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenCalledTimes(writesBeforeDrift);
    drifting.dispose();
  });

  it('offers deterministic reset evidence for an invalid namespaced store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-invalid-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const storePath = path.join(
      isolation.layout.awHomeDir,
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    await fs.outputFile(storePath, '{invalid', 'utf8');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    const pageError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(pageError).toBeInstanceOf(TuiConfigInvalidStoreError);
    expect(pageError).toMatchObject({
      code: 'invalidConfigStores',
      evidence: [{
        scope: 'user',
        code: 'invalidJson',
        pathSummary: 'AW_HOME/plugin-config/team/demo/config.json',
      }],
    });
    expect(JSON.stringify(pageError)).not.toContain(isolation.layout.awHomeDir);

    const invalidUserAvailability = await dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    );
    expect(invalidUserAvailability).toMatchObject({
      exists: true,
      state: 'invalid',
      invalidCode: 'invalidJson',
      sourceIdentityPresent: true,
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      storeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const resetIntent = {
      kind: 'configReset' as const,
      pluginId: 'team/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const resetEvidence = await dependencies.prepareReviewEvidence!(
      resetIntent,
      new AbortController().signal,
      () => undefined,
    );
    expect(resetEvidence.config).toMatchObject({ impactState: 'unknown' });
    expect(resetEvidence.config).not.toHaveProperty('noEffectiveChange');
    const resetProjection = buildOperationReviewProjection({
      intent: resetIntent,
      evidence: resetEvidence,
    });
    expect(resetProjection.changes).toContainEqual(expect.objectContaining({
      kind: 'warning',
      title: '设置重置后的应用影响未知',
    }));
    expect(JSON.stringify(resetProjection.changes)).not.toContain('当前安装保持不变');
    await fs.writeJson(storePath, {
      schemaVersion: 5,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: invalidUserAvailability.sourceIdentity },
      pluginName: 'demo',
      values: { mode: 'ready' },
    });
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    )).resolves.toMatchObject({ exists: true, state: 'ready' });

    const projectStorePath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    await fs.outputFile(projectStorePath, '{project-invalid', 'utf8');
    const projectError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(projectError).toMatchObject({
      evidence: [{
        scope: 'project',
        code: 'invalidJson',
        pathSummary: '<project>/.agent-workflows/plugin-config/team/demo/config.json',
      }],
    });

    await fs.outputFile(storePath, '{user-invalid-again', 'utf8');
    const bothError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(bothError).toMatchObject({
      evidence: [
        expect.objectContaining({ scope: 'user', code: 'invalidJson' }),
        expect.objectContaining({ scope: 'project', code: 'invalidJson' }),
      ],
    });
    await fs.remove(sourceRoot);
    await fs.remove(path.join(isolation.layout.awHomeDir, 'catalog-store'));
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    )).resolves.toMatchObject({
      exists: true,
      state: 'invalid',
      invalidCode: 'invalidJson',
      sourceIdentityPresent: false,
    });
  });

  it('keeps a schema-invalid project field editable and projects an invalid lower fallback', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-invalid-field-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          mode: { type: 'string', title: 'Mode', default: 'safe' },
          token: {
            type: 'string', title: 'Token', sensitive: true,
            validation: { pattern: '^valid$', maxLength: 20 },
          },
        },
      };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const identity = (await dependencies.getConfigResetAvailability!(
      'team/demo', { scope: 'user' }, new AbortController().signal,
    )).sourceIdentity!;
    const logicalIdentity = await readCatalogSnapshotLogicalIdentity(sourceRoot);
    const envelope = (scope: 'user' | 'project', values: Record<string, unknown>) => ({
      schemaVersion: 5,
      sourceId: 'team',
      binding: scope === 'user'
        ? { kind: 'source', sourceIdentity: identity }
        : { kind: 'catalog', logicalIdentity },
      pluginName: 'demo',
      values,
    });
    await fs.outputJson(path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('user', { token: 'lower-secret' }));
    await fs.outputJson(path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('project', { mode: 42, token: 'project-secret' }));

    const page = await dependencies.getConfigPage!(
      'team/demo', { scope: 'project' }, new AbortController().signal,
    );
    const fields = page.groups.flatMap((group) => group.fields);
    expect(fields.find((field) => field.key === 'mode')).toMatchObject({
      displayValue: '需修正',
      invalidOverrideIssue: '字段“Mode”在本层的值无效。请修改或删除此字段。',
      fallbackDisplayValue: 'safe',
    });
    expect(fields.find((field) => field.key === 'token')).toMatchObject({
      displayValue: '需修正',
      fallbackDisplayValue: '值无效；保存可成功，但应用会被阻止',
      fallbackSourceLabel: '个人默认',
    });
    expect(JSON.stringify(page)).not.toContain('lower-secret');
    expect(JSON.stringify(page)).not.toContain('project-secret');

    await fs.remove(path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json',
    ));
    await fs.outputJson(path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('user', { mode: 42, token: 'user-secret' }));
    const projectPage = await dependencies.getConfigPage!(
      'team/demo', { scope: 'project' }, new AbortController().signal,
    );
    const inheritedInvalid = projectPage.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'mode');
    expect(inheritedInvalid).toMatchObject({
      configured: false,
      invalidOverrideOwnedByLayer: false,
      invalidOverrideIssue: '字段“Mode”在个人默认中的值无效。请切换到该设置层修改或删除此字段。',
    });
    expect(inheritedInvalid).not.toHaveProperty('fallbackDisplayValue');
    expect(JSON.stringify(projectPage)).not.toContain('user-secret');
  });

  it('reviews and executes a real reset without a loaded Catalog session', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const storePath = path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'official', 'demo', 'config.json',
    );
    await fs.outputFile(storePath, '{invalid', 'utf8');
    const actualWrites = await vi.importActual<typeof import('../../src/utils/plugin-config-write.js')>(
      '../../src/utils/plugin-config-write.js',
    );
    runtimeMocks.resetPluginConfigWithHelper.mockImplementation(
      actualWrites.resetPluginConfigWithHelper,
    );
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV8.mockResolvedValue({
      payload: {
        schemaVersion: 8,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:offline-reset',
          sources: [],
        },
        filters: { plugins: [], platform: 'all', cwd: isolation.layout.fixtureCwd },
        targets: [],
        errors: [],
      },
      pluginSummaries: [],
      targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'configReset',
      pluginId: 'official/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    } as const;
    const controller = new TuiController(dependencies);
    const review = await controller.buildOperationReview(intent);
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded',
      summary: { resetDisposition: 'deletedFile' },
    });

    expect(runtimeMocks.statusCommandV8).toHaveBeenCalledOnce();
    await expect(fs.pathExists(storePath)).resolves.toBe(false);
    controller.dispose();
    runtimeMocks.resetPluginConfigWithHelper.mockReset();
  });

  it('allows an offline reset Review when its Catalog source appears later', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'late/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const signal = new AbortController().signal;
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});
    expect(evidence.source).toBeUndefined();

    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'late-reset-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'late', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    runtimeMocks.resetPluginConfigWithHelper.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      configWrite: 'succeeded',
    });
  });

  it.each([
    ['symbolicLink', 'unlinkedSymlink'],
    ['directory', 'quarantinedDirectory'],
  ] as const)('reviews and executes a real %s reset target', async (targetKind, disposition) => {
    const isolation = getCurrentSourceTestIsolation();
    const storePath = path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'offline', 'demo', 'config.json',
    );
    const preservedPath = path.join(isolation.layout.fixtureCwd, `preserved-${targetKind}`);
    if (targetKind === 'symbolicLink') {
      await fs.outputFile(preservedPath, 'preserved', 'utf8');
      await fs.ensureSymlink(preservedPath, storePath);
    } else {
      await fs.outputFile(path.join(storePath, 'preserved.txt'), 'preserved', 'utf8');
    }
    const actualWrites = await vi.importActual<typeof import('../../src/utils/plugin-config-write.js')>(
      '../../src/utils/plugin-config-write.js',
    );
    runtimeMocks.resetPluginConfigWithHelper.mockImplementation(
      actualWrites.resetPluginConfigWithHelper,
    );
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const signal = new AbortController().signal;
    await expect(dependencies.getConfigResetAvailability!(
      'offline/demo', { scope: 'user' }, signal,
    )).resolves.toMatchObject({ exists: true, targetKind, resettable: true });
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'offline/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});
    const result = await dependencies.executeIntent(intent, evidence) as {
      resetDisposition: string;
      quarantineBasename?: string;
    };

    expect(result.resetDisposition).toBe(disposition);
    await expect(fs.pathExists(storePath)).resolves.toBe(false);
    if (targetKind === 'symbolicLink') {
      await expect(fs.readFile(preservedPath, 'utf8')).resolves.toBe('preserved');
    } else {
      expect(result.quarantineBasename).toMatch(/^config\.broken-.*\.json$/u);
      await expect(fs.readFile(path.join(
        path.dirname(storePath), result.quarantineBasename!, 'preserved.txt',
      ), 'utf8')).resolves.toBe('preserved');
    }
    runtimeMocks.resetPluginConfigWithHelper.mockReset();
  });






  it('resets config without schema or applying visible targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-reset-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV8.mockResolvedValue({
      payload: {
        schemaVersion: 8,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [{
          ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team',
          sourceIdentity: 'identity:team', cwd: isolation.layout.fixtureCwd,
        }],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.resetPluginConfigWithHelper.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const signal = new AbortController().signal;
    await dependencies.loadStatus(signal);
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'team/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      configWrite: 'succeeded',
    });
    expect(runtimeMocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining({
      apply: false,
      sourceId: 'team',
      pluginName: 'demo',
    }));
  });



  it('uses one source mutation preflight for review validation and evidence', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      sourceIdentity: 'sha256:source',
      identityChanged: false,
      impactDigest: 'sha256:impact',
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{ category: 'marketplace', sourceId: 'official', marketplaceName: 'aw' }],
        errors: [],
      },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team',
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      sourceWrite: { configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after' },
    });

    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce();
    expect(stages).toEqual(['validate', 'evidence']);
    expect(runtimeMocks.statusCommandV8).not.toHaveBeenCalled();
  });

  it('passes reviewed primary impact to execution and surfaces lock-time stale', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      identityChanged: false,
      impactDigest: 'sha256:impact',
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{ category: 'marketplace', sourceId: 'official', marketplaceName: 'aw' }],
        errors: [],
      },
    });
    runtimeMocks.setPrimaryCatalogSourceCommand.mockRejectedValue(Object.assign(
      new Error('Catalog source impact changed after review.'),
      { code: 'operationReviewStale' },
    ));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = { kind: 'sourceMutation' as const, action: 'setPrimary' as const, sourceId: 'team' };
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );

    await expect(dependencies.executeIntent!(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
    expect(runtimeMocks.setPrimaryCatalogSourceCommand).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'team',
      expectedConfigDigest: 'sha256:before',
      expectedImpactDigest: 'sha256:impact',
      requireImpactConfirmation: true,
      confirmImpact: true,
    }));
  });

  it('reviews activate-then-primary impact and preserves activation when primary evidence becomes stale', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activate-primary');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: {
        schemaVersion: 2,
        sources: [
          ...before.config.sources,
          { id: 'team', type: 'path', path: sourceRoot, primary: false },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    const manifest = await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json'));
    const candidate = {
      sourceId: 'team',
      sourceConfigFingerprint: `sha256:${'1'.repeat(64)}`,
      sourceIdentity: `sha256:${'2'.repeat(64)}`,
      logicalIdentity: 'fixture-workspace',
      requestedRef: 'path',
      resolvedCommit: 'path',
      catalogVersion: '1.0.0',
      channel: 'latest' as const,
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      snapshotDigest: `sha256:${'4'.repeat(64)}`,
    };
    runtimeMocks.probeCatalogSourceGeneration.mockResolvedValue({
      sourceId: 'team', candidate, manifest,
    });
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: config.digest,
      proposedConfigDigest: `sha256:${'5'.repeat(64)}`,
      identityChanged: false,
      impactDigest: `sha256:${'6'.repeat(64)}`,
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{
          category: 'config', sourceId: 'official', pluginId: 'official/demo', scope: 'user',
        }],
        errors: [],
      },
    });
    const generation = {
      catalogGenerationSchemaVersion: 1 as const,
      sourceId: 'team', mode: 'sync' as const, outcome: 'activated' as const,
      activeChanged: true, resolution: candidate,
      lastSync: { syncedAt: '2026-01-01T00:00:00.000Z', mode: 'sync' as const, state: 'succeeded' as const, resolvedCommit: 'path' },
    };
    runtimeMocks.activateCatalogSourceGeneration.mockResolvedValue(generation);
    runtimeMocks.setPrimaryCatalogSourceCommand.mockRejectedValue(Object.assign(
      new Error('primary impact changed'), { code: 'operationReviewStale' },
    ));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'catalogGeneration' as const,
      action: 'activate' as const,
      sourceId: 'team',
      setPrimaryAfterActivation: true,
    };
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );

    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledWith(expect.objectContaining({
      request: { action: 'setPrimary', sourceId: 'team' },
    }));
    expect(evidence.catalogGeneration).toMatchObject({
      primaryConfigDigest: config.digest,
      primaryImpactDigest: `sha256:${'6'.repeat(64)}`,
      primaryImpact: {
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        affectedReferences: [expect.objectContaining({ pluginId: 'official/demo' })],
      },
    });
    await expect(dependencies.executeIntent!(intent, evidence)).resolves.toMatchObject({
      status: 'partial',
      partialReason: 'primary',
      activeAvailable: true,
      generation,
      errorCode: 'operationReviewStale',
    });
    expect(runtimeMocks.setPrimaryCatalogSourceCommand).toHaveBeenCalledWith(expect.objectContaining({
      expectedConfigDigest: config.digest,
      expectedImpactDigest: `sha256:${'6'.repeat(64)}`,
      requireImpactConfirmation: true,
      confirmImpact: true,
    }));
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'official')).toMatchObject({ primary: true });
  });

  it('stops a managed source mutation when public preflight rejects it', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockRejectedValue(Object.assign(
      new Error('Catalog source "workspace-dev" is managed by a Catalog Workspace.'),
      { code: 'managedSourceProtected' },
    ));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'remove',
      sourceId: 'workspace-dev',
    }, new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: 'managedSourceProtected',
    });
    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce();
  });

  it('does not return source evidence after cancellation during an unsupported preflight boundary', async () => {
    let resolvePreflight!: (value: {
      configDigest: string;
      proposedConfigDigest: string;
      references: { references: never[]; errors: never[] };
    }) => void;
    runtimeMocks.preflightCatalogSourceMutation.mockReturnValue(new Promise((resolve) => {
      resolvePreflight = resolve;
    }));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const abort = new AbortController();
    const stages: string[] = [];
    const preparation = dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team',
    }, abort.signal, (stage) => { stages.push(stage); });
    await vi.waitFor(() => expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce());

    abort.abort();
    resolvePreflight({
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      references: { references: [], errors: [] },
    });

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages).toEqual(['validate']);
  });

  it('uses one portable prepare call for review evidence', async () => {
    runtimeMocks.preparePortableInstall.mockResolvedValue({
      configDigest: 'sha256:config',
      evidenceDigest: 'sha256:portable',
      selected: [],
      dependencyContributions: [],
      conflicts: [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'portableInstall',
      pluginId: 'team/demo',
      scope: 'user',
      selectedSkills: [],
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      portable: { evidenceDigest: 'sha256:portable' },
    });

    expect(runtimeMocks.preparePortableInstall).toHaveBeenCalledOnce();
    expect(stages).toEqual(['portable', 'evidence']);
    expect(runtimeMocks.statusCommandV8).not.toHaveBeenCalled();
  });


});
