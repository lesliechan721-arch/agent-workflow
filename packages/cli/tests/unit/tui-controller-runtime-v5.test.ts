import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV5Payload } from '../../src/commands/status-v5.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  createTuiControllerDependencies,
  statusTargetFingerprint,
} from '../../src/tui/controller-runtime.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';

const runtimeMocks = vi.hoisted(() => ({
  statusCommandV5: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
  preflightCatalogSourceMutation: vi.fn(),
  preparePortableInstall: vi.fn(),
}));

vi.mock('../../src/commands/status-v5.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v5.js')>(),
  statusCommandV5: runtimeMocks.statusCommandV5,
}));

vi.mock('../../src/commands/write-commands.js', () => ({
  cleanupWriteCommand: runtimeMocks.cleanupWriteCommand,
  installWriteCommand: runtimeMocks.installWriteCommand,
  reinstallWriteCommand: runtimeMocks.reinstallWriteCommand,
  uninstallWriteCommand: runtimeMocks.uninstallWriteCommand,
  upgradeWriteCommand: runtimeMocks.upgradeWriteCommand,
}));

vi.mock('../../src/commands/catalog-source.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/catalog-source.js')>(),
  preflightCatalogSourceMutation: runtimeMocks.preflightCatalogSourceMutation,
}));

vi.mock('../../src/portable/commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/commands.js')>(),
  preparePortableInstall: runtimeMocks.preparePortableInstall,
}));

function target(
  scope: 'user' | 'project',
  state: 'present' | 'partial' | 'error',
): StatusV5Payload['targets'][number] {
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    version: '1.0.0',
    platform: 'codex',
    scope,
    cwd: '/workspace',
    state,
    components: [],
    errors: state === 'error' ? [{ code: 'targetError', message: 'safe failure' }] : [],
  };
}

function bundleUnavailableStatus(
  configDigest = 'sha256:config',
): Awaited<ReturnType<typeof runtimeMocks.statusCommandV5>> {
  const orphan = target('user', 'error');
  orphan.errors = [{ code: 'bundleUnavailable', message: 'safe failure' }];
  return {
    payload: {
      schemaVersion: 5,
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
          freshness: 'path',
        }],
      },
      filters: { plugins: ['official/demo'], platform: 'codex', cwd: '/workspace' },
      targets: [orphan],
      errors: [],
    },
    pluginSummaries: [],
  };
}

describe('TUI controller runtime scope conflict validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('fails closed for forged %s + %s scope origin before any write', async (userState, projectState) => {
    runtimeMocks.statusCommandV5.mockResolvedValue({
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
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'operationReviewStale' });

    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.upgradeWriteCommand).not.toHaveBeenCalled();
  });

  it.each(['partial', 'present'] as const)('keeps present + %s scope conflict validation valid', async (projectState) => {
    runtimeMocks.statusCommandV5.mockResolvedValue({
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
  ] as const)('rejects upgrade when revision is %s and placement is %s', async (revisionState, placementState) => {
    runtimeMocks.statusCommandV5.mockResolvedValue({
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
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'targetStateChanged' });
  });

  it('accepts upgrade only for a present placement with upgradeAvailable evidence', async () => {
    runtimeMocks.statusCommandV5.mockResolvedValue({
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
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('prepares config review with one status read, ordered real stages, and safe duration logging', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV5.mockResolvedValue({
      payload: {
        schemaVersion: 5,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        targets: [],
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
      targetRevisions: [],
    });
    const debugLog = vi.fn()
      .mockImplementationOnce(() => { throw new Error('log unavailable'); })
      .mockRejectedValueOnce(new Error('async log unavailable'));
    const times = [10, 14, 20, 27, 31, 40];
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      debugLogger: { log: debugLog },
    }), undefined, { now: () => times.shift() ?? 40 });
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      config: { scope: 'user', projectLayer: 'shared' },
    });

    expect(runtimeMocks.statusCommandV5).toHaveBeenCalledOnce();
    expect(stages).toEqual(['status', 'catalog', 'config', 'evidence']);
    expect(debugLog.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: 'review.prepare.status', data: { durationMs: 4 } }),
      expect.objectContaining({ type: 'review.prepare.catalog', data: { durationMs: 7 } }),
      expect.objectContaining({ type: 'review.prepare.config', data: { durationMs: 9 } }),
      expect.objectContaining({ type: 'review.prepare.evidence', data: { durationMs: 0 } }),
    ]);
  });

  it('rejects a Review that would combine status and Catalog config generations', async () => {
    runtimeMocks.statusCommandV5.mockResolvedValue({
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

    expect(runtimeMocks.statusCommandV5).toHaveBeenCalledOnce();
    expect(stages).toEqual(['status']);
  });

  it.each([
    ['install', 'absent', undefined],
    ['upgrade', 'present', 'upgradeAvailable'],
    ['reinstall', 'present', undefined],
    ['uninstall', 'present', undefined],
    ['cleanup', 'present', undefined],
  ] as const)('prepares one legal %s Review with one status entry', async (action, state, revisionState) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `runtime-review-${action}-source`);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV5.mockResolvedValue({
      payload: {
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
        },
        targets: [{
          pluginName: 'demo',
          pluginId: 'team/demo',
          sourceId: 'team',
          sourceIdentity: 'identity:team',
          version: '0.0.0',
          platform: 'codex',
          scope: 'user',
          cwd: isolation.layout.fixtureCwd,
          state,
          components: [],
          errors: [],
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
      source: { sourceId: 'team' },
    });

    expect(runtimeMocks.statusCommandV5).toHaveBeenCalledOnce();
    expect(stages).toEqual(['status', 'catalog', 'evidence']);
  });

  it('rejects an absent collision before install Review preparation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV5.mockResolvedValue({
      payload: {
        catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite' },
        targets: [{
          pluginName: 'demo', pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
          version: '0.0.0', platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
          state: 'absent', components: [],
          errors: [{ code: 'artifactCollision', message: 'safe collision' }],
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
      .rejects.toMatchObject({ code: 'artifactCollision' });
    expect(stages).toEqual(['status']);
  });

  it('uses one source mutation preflight for review validation and evidence', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      configDigest: 'sha256:before',
      candidateDigest: 'sha256:after',
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
      sourceWrite: { configDigest: 'sha256:before', candidateDigest: 'sha256:after' },
    });

    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce();
    expect(stages).toEqual(['validate', 'evidence']);
    expect(runtimeMocks.statusCommandV5).not.toHaveBeenCalled();
  });

  it('does not return source evidence after cancellation during an unsupported preflight boundary', async () => {
    let resolvePreflight!: (value: {
      configDigest: string;
      candidateDigest: string;
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
      candidateDigest: 'sha256:after',
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
    expect(runtimeMocks.statusCommandV5).not.toHaveBeenCalled();
  });

  it('uses status ownership evidence to run ordinary cleanup when the current Catalog bundle is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const configSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV5.mockResolvedValue(bundleUnavailableStatus(configSnapshot.digest));
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
      nativePlugins: {},
      repoManagedArtifacts: [],
      receiptTargets: [],
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
      source: { sourceId: 'official', sourceIdentity: 'identity:official', requestedRef: 'path' },
      targetFingerprint: expect.stringMatching(/^sha256:/u),
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.cleanupWriteCommand).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'user', force: false }),
      expect.objectContaining({ reviewPreflight: expect.any(Function) }),
    );
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });
});
