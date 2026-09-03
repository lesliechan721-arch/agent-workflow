import path from 'node:path';
import fs from 'fs-extra';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV7Payload } from '../../src/commands/status-v6.js';
import type { ReconcileOperationPlan } from '../../src/commands/reconcile-operation-plan.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  configAffectedStatusTargets,
  createTuiControllerDependencies,
  statusTargetFingerprint,
} from '../../src/tui/controller-runtime.js';
import {
  TuiConfigInvalidStoreError,
  TuiController,
} from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';

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
  statusCommandV7: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  preflightCatalogSourceMutation: vi.fn(),
  preparePortableInstall: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV7: runtimeMocks.statusCommandV7,
}));

vi.mock('../../src/commands/write-commands.js', () => ({
  cleanupWriteCommand: runtimeMocks.cleanupWriteCommand,
  installWriteCommand: runtimeMocks.installWriteCommand,
  syncWriteCommand: runtimeMocks.installWriteCommand,
  reinstallWriteCommand: runtimeMocks.reinstallWriteCommand,
  uninstallWriteCommand: runtimeMocks.uninstallWriteCommand,
}));

vi.mock('../../src/commands/catalog-source.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/catalog-source.js')>(),
  preflightCatalogSourceMutation: runtimeMocks.preflightCatalogSourceMutation,
}));

vi.mock('../../src/portable/commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/commands.js')>(),
  preparePortableInstall: runtimeMocks.preparePortableInstall,
}));

vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite: runtimeMocks.applyPluginConfigWrite,
  resetPluginConfigWithHelper: runtimeMocks.resetPluginConfigWithHelper,
}));

function target(
  scope: 'user' | 'project',
  state: 'absent' | 'present' | 'partial' | 'error',
): StatusV7Payload['targets'][number] {
  const enabled = state === 'present' || state === 'partial';
  const targetState = state === 'present'
    ? 'ready' as const
    : state === 'partial'
      ? 'needsSync' as const
      : state === 'error' ? 'blocked' as const : 'absent' as const;
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: OFFLINE_SOURCE_IDENTITY,
    version: '1.0.0',
    platform: 'codex',
    scope,
    cwd: '/workspace',
    state: targetState,
    components: [
      {
        kind: 'intent', key: 'desired', state: enabled ? 'desired' : 'absent',
        metadata: { enabled, scopes: enabled ? [scope] : [], relation: enabled ? 'managed' : 'none' },
      },
      { kind: 'ownership', key: 'fixture', state },
      {
        kind: 'activation', key: scope, state: enabled ? 'enabled' : 'disabled',
        metadata: { evidence: 'assumed' },
      },
    ],
    reasons: state === 'error'
      ? [{ code: 'targetError', message: 'safe failure', severity: 'blocking' }]
      : [],
    recoveryActions: [],
  };
}

function bundleUnavailableStatus(
  configDigest = 'sha256:config',
): Awaited<ReturnType<typeof runtimeMocks.statusCommandV7>> {
  const orphan = target('user', 'error');
  orphan.reasons = [{ code: 'bundleUnavailable', message: 'safe failure', severity: 'blocking' }];
  return {
    payload: {
      schemaVersion: 7,
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

describe('TUI config affected targets', () => {
  it('expands user scope conflicts and keeps project layers project-only', () => {
    const targets = [
      target('user', 'present'),
      target('project', 'partial'),
      { ...target('user', 'present'), platform: 'claude' as const },
      { ...target('project', 'error'), platform: 'claude' as const },
    ];

    expect(configAffectedStatusTargets(targets, 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'claude:user', 'codex:project', 'codex:user',
    ]);
    expect(configAffectedStatusTargets(targets, 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });

  it('includes desired missing targets and excludes orphaned actual targets', () => {
    const desiredMissing = target('user', 'absent');
    desiredMissing.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['user'], relation: 'root',
    };
    const orphanedActual = target('project', 'present');
    orphanedActual.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: false, scopes: [], relation: 'none',
    };

    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'user',
    ).map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:user']);
    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'project',
    )).toEqual([]);
  });

  it('expands a collapsed pure-native target into each desired scope', () => {
    const collapsed = target('user', 'present');
    collapsed.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    };

    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'codex:project', 'codex:user',
    ]);
    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });
});

describe('TUI controller runtime scope conflict validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not duplicate forged %s + %s scope-origin legality before core planning', async (userState, projectState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', userState), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const presentScope = userState === 'present' ? 'user' : 'project';

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: presentScope,
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'forged',
        category: 'scopeConflict',
        actionId: presentScope === 'user' ? 'keepProjectScope' : 'keepUserScope',
      },
    }, new AbortController().signal)).resolves.toBeUndefined();

    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });

  it.each(['partial', 'present'] as const)('keeps present + %s scope conflict validation valid', async (projectState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', 'present'), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'project',
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'scope-evidence',
        category: 'scopeConflict',
        actionId: 'keepUserScope',
      },
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('leaves sync target-state legality to core planning', async () => {
    const selected = target('project', 'present');
    selected.state = 'needsSync';
    runtimeMocks.statusCommandV7.mockResolvedValue({ payload: { targets: [selected] } });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'sync' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    selected.state = 'ready';
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    selected.platform = 'claude';
    selected.state = 'needsSync';
    await expect(dependencies.validateIntent!({ ...intent, platform: 'claude' }, new AbortController().signal))
      .resolves.toBeUndefined();
  });

  it('leaves cross-scope native and extension legality to core planning', async () => {
    const selected = target('project', 'present');
    selected.components = [
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['user'], relation: 'root' },
      },
      { kind: 'ownership', key: 'fixture', state: 'present' },
      {
        kind: 'activation', key: 'user', state: 'enabled',
        metadata: { effective: true, evidence: 'observed' },
      },
      {
        kind: 'activation', key: 'project', state: 'disabled',
        metadata: { effective: true, evidence: 'observed' },
      },
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
    ];
    runtimeMocks.statusCommandV7.mockResolvedValue({ payload: { targets: [selected] } });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();

    selected.components = selected.components.filter((component) => component.kind !== 'sharedNative');
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();

    selected.components.push(
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
      { kind: 'extension', key: 'aw', state: 'conflict', metadata: { kinds: ['instruction'] } },
    );
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
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

  it.each([
    ['current', 'present'],
    ['unknown', 'present'],
    ['upgradeAvailable', 'partial'],
  ] as const)('leaves refresh-and-sync legality for revision %s and placement %s to core planning', async (revisionState, placementState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', placementState)] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: revisionState === 'unknown'
          ? { state: 'unknown', availableVersion: '1.0.0' }
          : {
              state: revisionState,
              availableVersion: revisionState === 'current' ? '1.0.0' : '2.0.0',
              installedVersion: '1.0.0',
            },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('accepts refresh-and-sync only for a present placement with upgradeAvailable evidence', async () => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', 'present')] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('prepares config review from loaded session evidence without another status or remote stage', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-config-source');
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
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
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

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      updates: { mode: 'strict' },
    }, signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      config: {
        scope: 'user',
        affectedTargets: [
          { platform: 'codex', scope: 'project' },
          { platform: 'codex', scope: 'user' },
        ],
      },
    });

    expect(runtimeMocks.statusCommandV7).toHaveBeenCalledOnce();
    expect(stages).toEqual(['config', 'evidence']);
    expect(debugLog.mock.calls.map(([event]) => event)
      .filter((event) => event.type.startsWith('review.prepare.'))).toEqual([
      expect.objectContaining({ type: 'review.prepare.config' }),
      expect.objectContaining({ type: 'review.prepare.evidence' }),
    ]);
  });

  it('keeps Review, stale fingerprints, and writer reapply targets on one config affected-target rule', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-targets-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
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
      ...target('project', 'partial'), pluginId: 'team/demo', sourceId: 'team', platform: 'claude' as const,
    };
    const statusResult = (targets: StatusV7Payload['targets']) => ({
      payload: {
        schemaVersion: 7 as const,
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
      targetResults: options.applyTargets.map((entry) => ({ target: entry, action: 'reinstall', state: 'completed' })),
    }));
    const createController = async (targets: StatusV7Payload['targets']) => {
      runtimeMocks.statusCommandV7.mockResolvedValue(statusResult(targets));
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
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', apply: true, updates: { mode: 'user' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'user' }],
    });
    expect(impactTitles(userReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    await expect(both.executeOperation(userReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    both.dispose();

    const projectOnly = await createController([userTarget, projectTarget]);
    const projectReview = await projectOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared', apply: true, updates: { mode: 'project' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'project' }],
    });
    expect(impactTitles(projectReview)).toEqual(['重新应用 Claude Code · 当前项目']);
    await expect(projectOnly.executeOperation(projectReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      applyTargets: [expect.objectContaining({ platform: 'claude', scope: 'project' })],
    }));
    projectOnly.dispose();

    const drifting = await createController([userTarget, projectTarget]);
    const driftReview = await drifting.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', apply: true, updates: { mode: 'stale' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'stale' }],
    });
    const writesBeforeDrift = runtimeMocks.applyPluginConfigWrite.mock.calls.length;
    runtimeMocks.statusCommandV7.mockResolvedValue(statusResult([userTarget]));
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
    await fs.writeJson(storePath, {
      schemaVersion: 3,
      sourceId: 'team',
      sourceIdentity: invalidUserAvailability.sourceIdentity,
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
  });

  it('rejects config Review preparation without a loaded TUI session', async () => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: {
          configDigest: 'sha256:stale-config',
          compositeDigest: 'sha256:stale-composite',
        },
        targets: [],
      },
      pluginSummaries: [],
      targetRevisions: [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'configReset',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
    }, new AbortController().signal, (stage) => { stages.push(stage); }))
      .rejects.toMatchObject({ code: 'operationReviewStale' });

    expect(runtimeMocks.statusCommandV7).not.toHaveBeenCalled();
    expect(stages).toEqual([]);
  });

  it.each([
    ['install', 'absent', undefined],
    ['refreshAndSync', 'present', 'upgradeAvailable'],
    ['reinstall', 'present', undefined],
    ['uninstall', 'present', undefined],
    ['cleanup', 'present', undefined],
  ] as const)('prepares one legal %s Review with one status entry', async (action, state, revisionState) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `runtime-review-${action}-source`);
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
    if (action === 'refreshAndSync') {
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.version = '2.0.0';
      });
    }
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
        },
        targets: [{
          ...target('user', state),
          pluginId: 'team/demo',
          sourceId: 'team',
          sourceIdentity: 'identity:team',
          version: '0.0.0',
          cwd: isolation.layout.fixtureCwd,
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo',
        pluginName: 'demo',
        sourceId: 'team',
        sourceIdentity: 'identity:team',
        dependencyDirectCount: 0,
        dependencyTotalCount: 0,
      }],
      targetRevisions: revisionState ? [{
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'user',
        revision: {
          state: revisionState,
          availableVersion: '0.0.0',
          installedVersion: '0.0.0',
        },
      }] : [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite',
      action,
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'user',
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      source: {
        sourceId: 'team',
        pluginVersion: action === 'refreshAndSync' ? '2.0.0' : '1.0.0',
      },
    });

    expect(runtimeMocks.statusCommandV7).toHaveBeenCalledOnce();
    expect(stages).toEqual([
      ...(action === 'refreshAndSync' ? ['refresh'] : []),
      'status', 'catalog', 'evidence',
    ]);
  });

  it('keeps the old Active and reports a non-blocking warning when refresh fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-refresh-fallback-source');
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
    await fs.remove(path.join(sourceRoot, 'catalog-manifest.json'));
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite' },
        targets: [{
          ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team',
          sourceIdentity: 'identity:team', version: '1.0.0', cwd: isolation.layout.fixtureCwd,
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [{
        pluginId: 'team/demo', platform: 'codex', scope: 'user',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team/demo',
      platform: 'codex', scope: 'user',
    }, new AbortController().signal, () => {})).resolves.toMatchObject({
      source: { sourceId: 'team', pluginVersion: '1.0.0' },
      preparationWarnings: [expect.stringContaining('catalogSourceRefreshFailed: team:')],
    });
  });

  it('passes overrides through Phase3 and persists a user-to-project adjustment without cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'demo', dependencies: ['dependency'] },
      { name: 'dependency' },
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
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    const plan: ReconcileOperationPlan = {
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: 'sha256:placement',
      requestedPluginIds: ['team/demo'],
      resolvedPluginIds: ['team/dependency', 'team/demo'],
      dependencyEdges: [{ from: 'team/demo', to: 'team/dependency', platform: 'codex' }],
      scopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'user' }],
      targets: [
        {
          pluginId: 'team/dependency', pluginName: 'dependency', platform: 'codex',
          relation: 'dependency', depth: 1, requiredBy: ['team/demo'], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'user', allowedScopes: ['project', 'user'],
          assignmentSource: 'userOverride', locked: false, affectsOtherProjects: true,
          state: 'present', action: 'keep', order: 0,
        },
        {
          pluginId: 'team/demo', pluginName: 'demo', platform: 'codex',
          relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
          assignmentSource: 'root', locked: true, affectsOtherProjects: false,
          state: 'absent', action: 'install', order: 1,
        },
      ],
      claimRoots: [{ pluginId: 'team/demo', platform: 'codex' }],
    };
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [
          {
            ...target('project', 'absent'),
            pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
            cwd: isolation.layout.fixtureCwd,
          },
          {
            ...target('user', 'present'),
            pluginName: 'dependency', pluginId: 'team/dependency',
            sourceId: 'team', sourceIdentity: 'identity:team', cwd: isolation.layout.fixtureCwd,
            desired: { enabled: true, scopes: ['user'], relation: 'dependency' },
            actual: { state: 'ready' },
            sharedNative: { pluginId: 'dependency@team', state: 'present', shared: true },
            activation: { user: true, project: true, effective: true, evidence: 'observed' },
          },
        ],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 1, dependencyTotalCount: 1,
      }],
      targetRevisions: [],
    });
    runtimeMocks.installWriteCommand.mockResolvedValue({
      dependencyPlan: plan,
      targetResults: [],
      overallState: 'succeeded',
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'team/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
      dependencyScopeOverrides: [{
        pluginId: 'team/dependency', platform: 'codex' as const, scope: 'user' as const,
      }],
    };

    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence.dependencyPlan).toEqual(plan);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'project',
        dependencyScopeOverrides: intent.dependencyScopeOverrides,
      }),
      expect.objectContaining({ previewOperationPlan: true }),
    );

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'project',
        dependencyScopeOverrides: intent.dependencyScopeOverrides,
      }),
      expect.not.objectContaining({
        expectedPlanFingerprint: expect.anything(),
      }),
    );

    const projectPlan: ReconcileOperationPlan = {
      ...plan,
      dependencyPlanDigest: 'sha256:project-placement',
      scopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'project' }],
      targets: plan.targets.map((entry) => entry.pluginId === 'team/dependency'
        ? {
            ...entry,
            resolvedScope: 'project',
            assignmentSource: 'userOverride',
            affectsOtherProjects: false,
            action: 'keep',
          }
        : entry),
    };
    runtimeMocks.installWriteCommand.mockClear();
    runtimeMocks.installWriteCommand.mockResolvedValue({
      dependencyPlan: projectPlan,
      targetResults: [],
      overallState: 'succeeded',
    });
    const adjustedIntent = {
      ...intent,
      dependencyScopeOverrides: projectPlan.scopeOverrides,
      dependencyPlacementAdjustment: true as const,
    };

    const adjustedEvidence = await dependencies.captureEvidence(
      adjustedIntent,
      new AbortController().signal,
    );
    expect(adjustedEvidence).toMatchObject({
      dependencyPlan: projectPlan,
    });
    await expect(dependencies.executeIntent(adjustedIntent, adjustedEvidence))
      .resolves.toMatchObject({ dependencyPlan: projectPlan, overallState: 'succeeded' });
    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });

  it('executes sync through the reviewed write chain', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-sync-source');
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
    const selected = {
      ...target('project', 'present'),
      pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
      cwd: isolation.layout.fixtureCwd,
      actual: { state: 'needsSync' as const },
    };
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [selected],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.installWriteCommand.mockResolvedValue({
      targetResults: [],
      overallState: 'succeeded',
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'sync' as const,
      pluginId: 'team/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'project' }),
      expect.objectContaining({ previewOperationPlan: true }),
    );
    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'project' }),
      expect.not.objectContaining({ reconcileIntentOnly: expect.anything() }),
    );

    runtimeMocks.installWriteCommand.mockResolvedValue({
      targetResults: [{ errorCode: 'operationPlanStale', state: 'failed' }],
      overallState: 'failed',
    });
    await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
  });

  it('resets config without applying visible targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-reset-source');
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
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
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
      configWrite: 'succeeded', overallState: 'succeeded', targetResults: [],
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
      applyTargets: [],
    }));
  });

  it('lets the core preview own collision rejection during Review preparation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-collision-source');
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
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite' },
        targets: [{
          ...target('user', 'absent'),
          pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
          version: '0.0.0', cwd: isolation.layout.fixtureCwd,
          reasons: [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }],
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal, (stage) => { stages.push(stage); }))
      .resolves.toMatchObject({ catalog: expect.any(Object) });
    expect(stages[0]).toBe('status');
  });

  it.each([
    ['install', 'absent', undefined, true],
    ['refreshAndSync', 'present', 'upgradeAvailable', true],
    ['reinstall', 'partial', undefined, true],
    ['uninstall', 'present', undefined, false],
    ['cleanup', 'partial', undefined, false],
  ] as const)('%s runtime validation delegates the collision boundary for %s', async (
    action,
    state,
    revisionState,
    blocked,
  ) => {
    const collisionTarget = target('user', state);
    collisionTarget.reasons = [{
      code: 'artifactCollision',
      message: 'safe collision',
      severity: 'blocking',
    }];
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [collisionTarget] },
      targetRevisions: revisionState ? [{
        pluginId: 'official/demo',
        platform: 'codex',
        scope: 'user',
        revision: { state: revisionState, availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }] : [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const validation = dependencies.validateIntent!({
      kind: 'pluginWrite', action, pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal);

    void blocked;
    await expect(validation).resolves.toBeUndefined();
  });

  it('uses one source mutation preflight for review validation and evidence', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      sourceIdentity: 'sha256:source',
      references: { references: [], errors: [] },
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
    expect(runtimeMocks.statusCommandV7).not.toHaveBeenCalled();
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
    expect(runtimeMocks.statusCommandV7).not.toHaveBeenCalled();
  });

  it('uses status ownership evidence to run ordinary cleanup when the current Catalog bundle is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    await fs.ensureDir(path.join(skillsRoot, 'demo-owned'));
    await writeSkillOwnerMarker({
      skillRoot: path.join(skillsRoot, 'demo-owned'),
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'official',
        sourceIdentity: OFFLINE_SOURCE_IDENTITY,
        pluginId: 'official/demo',
        plugin: 'demo',
        artifactKey: 'demo-owned',
        platform: 'codex',
        scope: 'user',
      },
    });
    const configSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue(bundleUnavailableStatus(configSnapshot.digest));
    runtimeMocks.cleanupWriteCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['demo'],
      warnings: [],
      rebuildResults: [],
      targetResults: [{
        target: {
          pluginName: 'demo',
          pluginId: 'official/demo',
          sourceId: 'official',
          platform: 'codex',
          scope: 'user',
          cwd: '/workspace',
        },
        action: 'cleanup',
        state: 'completed',
      }],
      overallState: 'succeeded',
      receiptTargets: [],
      codexManagerPreview: { state: 'requires-install' },
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'cleanup' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
      originIssue: {
        issueId: 'target:official/demo:codex:user:error',
        issueKey: 'sourceUnavailable\0official/demo\0\0\0\0\0official\0identity:official\0codex\0user',
        category: 'sourceUnavailable' as const,
        actionId: 'cleanup' as const,
      },
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence).toMatchObject({
      source: { sourceId: 'official', sourceIdentity: OFFLINE_SOURCE_IDENTITY, requestedRef: 'path' },
      offlineCleanup: {
        reason: 'bundleUnavailable',
        pluginId: 'official/demo',
        targetFingerprint: expect.stringMatching(/^sha256:/u),
      },
      codexManager: {
        state: 'requires-install',
        packageName: '@openai/codex',
        version: '0.151.0',
      },
      targetFingerprint: expect.stringMatching(/^sha256:/u),
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.cleanupWriteCommand).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'user', force: false,
        allowManagedCodexInstall: true,
      }),
      expect.objectContaining({
        expectedOfflineCleanupEvidence: expect.objectContaining({
          reason: 'bundleUnavailable',
          pluginId: 'official/demo',
          targetFingerprint: expect.stringMatching(/^sha256:/u),
        }),
        managedCodexAuthorizer: expect.any(Function),
      }),
    );
    const runtime = runtimeMocks.cleanupWriteCommand.mock.calls.at(-1)?.[2];
    await expect(runtime.managedCodexAuthorizer()).resolves.toBe(true);
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });
});
