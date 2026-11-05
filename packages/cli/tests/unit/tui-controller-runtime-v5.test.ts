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
  applyPluginConfig: vi.fn(),
  preparePluginConfigApply: vi.fn(),
  disposePluginConfigApply: vi.fn(),
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
  applyPluginConfig: runtimeMocks.applyPluginConfig,
  preparePluginConfigApply: runtimeMocks.preparePluginConfigApply,
  disposePluginConfigApply: runtimeMocks.disposePluginConfigApply,
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
      manifest.platforms = ['codex'];
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

  it('saves shared user targets without starting recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      ...location, interactive: false,
    }));

    const plan = await dependencies.prepareScopedTask!({ kind: 'targets', scope: 'user',
      action: 'set', agents: ['codex'] }, new AbortController().signal);
    await expect(dependencies.executeScopedTask!(plan)).resolves.toEqual({
      kind: 'targets', changed: true, agents: ['codex'],
    });
    expect(await observePreferences({ ...location, scope: 'user' })).toMatchObject({
      state: 'valid', value: { targets: ['codex'] },
    });
    expect(await observePreferences({ ...location, scope: 'project' }))
      .toEqual(await observePreferences({ ...location, scope: 'user' }));
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

  it('keeps user context user-only and includes both scopes in project context', () => {
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
      'claude:user', 'codex:user',
    ]);
    expect(configAffectedStatusTargets(targets, 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['claude:user', 'codex:project', 'codex:user']);
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
    ).map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([]);
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
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:user']);
  });
});


describe('TUI controller runtime scope conflict validation', () => {

  it('loads recognizable saved settings without a current Catalog plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginConfigStore({
      sourceId: 'removed',
      sourceIdentity: OFFLINE_SOURCE_IDENTITY,
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



  it.each(['common', 'codex'] as const)('prepares config review with %s arrays without rereading catalog payloads or reloading status', async (profile) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-config-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'export default async () => undefined;\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      const registry = { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
      } };
      manifest.config = { schemaVersion: 5, fields: {
        mode: { type: 'string', title: 'Mode' },
        ...(profile === 'common' ? { registry } : {}),
      }, ...(profile === 'codex' ? { platforms: { codex: { fields: { registry } } } } : {}) };
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

    // Test Value Gate: resolving array-backed config references must not repeat
    // full snapshot payload reads during a warm Review, including arrays declared only in a platform profile.
    const reads = vi.spyOn(fs, 'readFile');
    let evidence: OperationEvidence;
    try {
      evidence = await dependencies.prepareReviewEvidence!({
        kind: 'configSave',
        pluginId: 'team/demo',
        scope: 'user',
        updates: { mode: 'strict' },
      }, signal, (stage) => { stages.push(stage); });
      expect(reads.mock.calls.filter(([file]) => path.basename(String(file)) === 'SKILL.md')).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
    expect(evidence).toMatchObject({
      config: {
        scope: 'user',
        affectedTargets: [
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
      schemaVersion: 6,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: evidence.source.sourceIdentity },
      pluginName: 'demo',
      common: { mode: 'saved' },
      platforms: {},
    };
    await fs.outputJson(storePath, envelope, { spaces: 2 });
    const beforeReorder = await dependencies.prepareReviewEvidence!({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', updates: { mode: 'strict' },
    }, signal, () => undefined);
    await fs.outputFile(storePath, `${JSON.stringify({
      platforms: envelope.platforms,
      common: envelope.common,
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

  it('uses the shared apply plan for Review, writer targets, and stale rejection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-targets-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex', 'claude', 'generic'];
      manifest.config = { fields: { mode: { type: 'string', default: 'safe' } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: initial.digest, env: isolation.env });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV8.mockResolvedValue({
      payload: { schemaVersion: 8, catalog: { configDigest: configured.digest,
        compositeDigest: 'sha256:composite', primarySourceId: 'team', sources: [] },
        targets: [], errors: [] }, pluginSummaries: [], targetRevisions: [],
    });
    let revision = 1;
    let selected: Array<'codex' | 'generic'> = ['codex', 'generic'];
    const preApplyAuthorization = [{
      pluginId: 'team/dependency', pluginName: 'dependency', sourceId: 'team',
      sourceIdentity: OFFLINE_SOURCE_IDENTITY, platform: 'codex', scope: 'user', relation: 'direct',
    }];
    const planEvidence = () => ({ revision, selected: [...selected], providerStore: `provider-${revision}`,
      preApplyAuthorization });
    runtimeMocks.preparePluginConfigApply.mockImplementation(async () => ({
      plan: { receipt: { requestedTargets: selected.map((agent) => ({
        pluginId: 'team/demo', agent, scope: 'user', delivery: null,
      })), blockers: [], errors: [], targetResults: [] },
      nativeGroups: [], changes: [], warnings: [] },
      evidence: planEvidence(), preApplyAuthorization, commandPackages: [], commandDiscoveryErrors: [],
    }));
    runtimeMocks.applyPluginConfig.mockImplementation(async () => ({
      configWrite: 'notStarted', overallState: 'succeeded', apply: { state: 'succeeded',
        targetResults: selected.map((platform) => ({ target: { pluginName: 'demo', platform, scope: 'user' },
          action: 'sync', state: 'completed' })) },
    }));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.load();
    const request = { kind: 'configSave' as const, pluginId: 'team/demo', context: 'user' as const,
      apply: true, retryApply: true as const, scriptTimeoutMs: 18_000 };
    const review = await controller.buildOperationReview(request);
    expect(review.configImpact?.affectedTargetCount).toBe(2);
    expect(review.changes).toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时', description: '18000 ms',
    }));
    expect(review.changes).toContainEqual(expect.objectContaining({
      title: '运行 team/dependency preApply', description: 'Codex · 所有项目',
    }));
    expect(review.changes.map((change) => change.title)).toEqual(expect.arrayContaining([
      '重新应用 demo · Codex · 所有项目', '重新应用 demo · Generic · 所有项目',
    ]));
    expect(runtimeMocks.disposePluginConfigApply).toHaveBeenCalledOnce();
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    const applyOptions = runtimeMocks.applyPluginConfig.mock.calls[0]![0];
    expect({ scope: applyOptions.scope, context: applyOptions.context,
      expectedEvidence: applyOptions.expectedEvidence, scriptTimeoutMs: applyOptions.rebuildRuntime?.scriptTimeoutMs,
      preApplyAuthorizedTargets: applyOptions.preApplyAuthorizedTargets,
    }).toEqual({ scope: 'user', context: 'user', expectedEvidence: planEvidence(),
      scriptTimeoutMs: 18_000, preApplyAuthorizedTargets: preApplyAuthorization });
    expect('applyTargets' in applyOptions).toBe(false);
    expect(runtimeMocks.applyPluginConfigWrite).not.toHaveBeenCalled();

    const implicitApply = await controller.buildOperationReview({ ...request, apply: false });
    await expect(controller.executeOperation(implicitApply.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfig).toHaveBeenCalledTimes(2);

    const before = await dependencies.captureEvidence(request);
    revision += 1;
    const after = await dependencies.captureEvidence(request);
    expect(after.config?.storeDigest).not.toBe(before.config?.storeDigest);
    const staleReview = await controller.buildOperationReview(request);
    revision += 1;
    selected = ['codex'];
    const stale = await controller.executeOperation(staleReview.reviewToken);
    expect(stale.state).toBe('stale');
    if (stale.state === 'stale') expect(stale.review.configImpact?.affectedTargetCount).toBe(1);
    expect(runtimeMocks.applyPluginConfig).toHaveBeenCalledTimes(2);
    controller.dispose();
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
      { view: 'effective' },
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
      {},
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
      schemaVersion: 6,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: invalidUserAvailability.sourceIdentity },
      pluginName: 'demo',
      common: { mode: 'ready' },
      platforms: {},
    });
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      {},
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
    await expect(dependencies.getConfigPage!(
      'team/demo', { view: 'effective' }, new AbortController().signal,
    )).resolves.toMatchObject({ profile: 'common', context: 'user' });
    await fs.outputFile(storePath, '{user-invalid-again', 'utf8');
    const userError = await dependencies.getConfigPage!(
      'team/demo', { view: 'effective' }, new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(userError).toMatchObject({ evidence: [
      expect.objectContaining({ scope: 'user', code: 'invalidJson' }),
    ] });
    await fs.remove(sourceRoot);
    await fs.remove(path.join(isolation.layout.awHomeDir, 'catalog-store'));
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      {},
      new AbortController().signal,
    )).resolves.toMatchObject({
      exists: true,
      state: 'invalid',
      invalidCode: 'invalidJson',
      sourceIdentityPresent: false,
    });
  });

  it('keeps a schema-invalid platform field editable and projects an invalid lower fallback', async () => {
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
      'team/demo', {}, new AbortController().signal,
    )).sourceIdentity!;
    const storePath = path.join(isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json');
    const envelope = (common: Record<string, unknown>, codex: Record<string, unknown>) => ({
      schemaVersion: 6, sourceId: 'team', pluginName: 'demo',
      binding: { kind: 'source', sourceIdentity: identity }, common, platforms: { codex },
    });
    await fs.outputJson(storePath, envelope({ token: 'lower-secret' }, { mode: 42, token: 'platform-secret' }));

    const page = await dependencies.getConfigPage!(
      'team/demo', { platform: 'codex' }, new AbortController().signal,
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
      fallbackSourceLabel: '公共配置',
    });
    expect(JSON.stringify(page)).not.toContain('lower-secret');
    expect(JSON.stringify(page)).not.toContain('platform-secret');

    await fs.outputJson(storePath, envelope({ mode: 42, token: 'user-secret' }, {}));
    const projectPage = await dependencies.getConfigPage!(
      'team/demo', { platform: 'codex' }, new AbortController().signal,
    );
    const inheritedInvalid = projectPage.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'mode');
    expect(inheritedInvalid).toMatchObject({
      configured: false,
      invalidOverrideOwnedByLayer: false,
      invalidOverrideIssue: '字段“Mode”在公共配置中的值无效。请切换到该设置层修改或删除此字段。',
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
      'offline/demo', {}, signal,
    )).resolves.toMatchObject({ exists: true, targetKind, resettable: true });
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'offline/demo',
      scope: 'user' as const,
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
