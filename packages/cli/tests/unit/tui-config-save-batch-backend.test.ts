import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type { PluginMeta } from '../../src/types.js';
import {
  createTuiControllerDependencies,
} from '../../src/tui/controller-runtime.js';
import type { OperationIntent } from '../../src/tui/controller.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import {
  readPluginConfigStore,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mocks = vi.hoisted(() => ({
  statusCommandV8: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  replayConfigRuntimeWrites: vi.fn(),
  resolveConfigPreApplyAuthorization: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: async (...args: unknown[]) => ({
    projectIntentObservation: { state: 'absent' as const },
    ...await mocks.statusCommandV8(...args),
  }),
}));

vi.mock('../../src/utils/plugin-config-write.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/plugin-config-write.js')>(),
  applyPluginConfigWrite: mocks.applyPluginConfigWrite,
  replayConfigRuntimeWrites: mocks.replayConfigRuntimeWrites,
  resolveConfigPreApplyAuthorization: mocks.resolveConfigPreApplyAuthorization,
}));

function placement(scope: 'project' | 'user') {
  return {
    scope,
    state: 'ready' as const,
    components: [{
      kind: 'intent' as const,
      key: 'desired',
      state: 'desired' as const,
      metadata: { enabled: true, scopes: [scope], relation: 'managed' as const },
    }, {
      kind: 'ownership' as const,
      key: 'fixture',
      state: 'present' as const,
    }, {
      kind: 'activation' as const,
      key: scope,
      state: 'enabled' as const,
      metadata: { evidence: 'assumed' as const },
    }],
    reasons: [],
    recoveryActions: [],
  };
}

function statusTarget(scopes: Array<'project' | 'user'>): StatusV8Payload['targets'][number] {
  return {
    pluginName: 'demo',
    pluginId: 'team/demo',
    sourceId: 'team',
    sourceIdentity: `sha256:${'1'.repeat(64)}`,
    version: '1.0.0',
    platform: 'codex',
    cwd: '/fixture',
    state: 'ready',
    components: [],
    reasons: [],
    recoveryActions: [],
    placements: scopes.map(placement),
  };
}

async function setupBackend() {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-batch-source');
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
    manifest.config = { fields: {
      mode: { type: 'string', title: 'Mode' },
      rules: {
        type: 'object',
        title: 'Rules',
        properties: {
          level: { type: 'string', title: 'Level' },
          token: { type: 'string', title: 'Token' },
        },
      },
    } };
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
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
  const makeStatus = (scopes: Array<'project' | 'user'>) => ({
    payload: {
      schemaVersion: 8 as const,
      catalog: {
        configDigest: configured.digest,
        compositeDigest: 'sha256:composite',
        primarySourceId: 'team',
        sources: [],
      },
      filters: { plugins: ['team/demo'], platform: 'codex' as const, cwd: isolation.layout.fixtureCwd },
      targets: [statusTarget(scopes)],
      errors: [],
    },
    pluginSummaries: [{
      pluginId: 'team/demo',
      pluginName: 'demo',
      sourceId: 'team',
      sourceIdentity: 'identity:team',
      dependencyDirectCount: 0,
      dependencyTotalCount: 0,
    }],
    targetRevisions: [],
  });
  mocks.statusCommandV8.mockResolvedValue(makeStatus(['project', 'user']));
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    interactive: false,
  }));
  await dependencies.loadStatus(new AbortController().signal);
  return { dependencies, makeStatus, isolation };
}

function batchIntent(apply = true): Extract<OperationIntent, { kind: 'configSaveBatch' }> {
  return {
    kind: 'configSaveBatch',
    pluginId: 'team/demo',
    apply,
    groups: [{
      scope: 'project',
      updates: { rules: { level: 'strict', token: 'project-secret' } },
      privateKeys: ['rules'],
      changes: [{
        key: 'rules', title: 'Rules', before: '旧对象', after: '新对象',
        children: [
          { property: 'level', before: 'balanced', after: 'strict' },
          { property: 'token', before: '已设置', after: '将更新', private: true },
        ],
      }],
    }, {
      scope: 'user',
      updates: { mode: 'safe' },
      changes: [{ key: 'mode', title: 'Mode', before: 'fast', after: 'safe' }],
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConfigPreApplyAuthorization.mockResolvedValue({
    targets: [], availableApplyTargets: [], unavailableTargetResults: [],
  });
  mocks.applyPluginConfigWrite.mockResolvedValue({
    configWrite: 'succeeded',
    overallState: 'succeeded',
    apply: { state: 'succeeded', targetResults: [] },
    otherProjectsMayRequireSync: false,
  });
  mocks.replayConfigRuntimeWrites.mockResolvedValue({
    configWrite: 'succeeded',
    overallState: 'succeeded',
    apply: { state: 'succeeded', targetResults: [] },
    otherProjectsMayRequireSync: false,
  });
});

describe('TUI multi-scope config save backend', () => {
  it('prepares one redacted review and preserves a successful project write when user fails', async () => {
    const { dependencies } = await setupBackend();
    const intent = batchIntent();
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );
    expect(evidence.configBatch?.groups.map((group) => group.scope)).toEqual(['project', 'user']);
    const review = buildOperationReviewProjection({ intent, evidence });
    expect(review.changes).toContainEqual(expect.objectContaining({
      title: '当前项目 · Rules',
      description: expect.stringContaining('level: balanced → strict'),
    }));
    expect(JSON.stringify(review)).not.toContain('project-secret');

    mocks.applyPluginConfigWrite
      .mockResolvedValueOnce({
        configWrite: 'succeeded', overallState: 'succeeded',
        apply: { state: 'succeeded', targetResults: [] },
        otherProjectsMayRequireSync: false,
      })
      .mockRejectedValueOnce(Object.assign(new Error('write failed'), {
        code: 'configWriteFailed', configWrite: 'failed',
      }));
    await expect(dependencies.executeIntent(intent, evidence)).resolves.toEqual({
      status: 'partial',
      groups: [
        expect.objectContaining({
          scope: 'project', status: 'succeeded', configSaved: true, applyStatus: 'succeeded',
        }),
        expect.objectContaining({
          scope: 'user', status: 'failed', configSaved: false, errorCode: 'configWriteFailed',
        }),
      ],
    });
    expect(mocks.applyPluginConfigWrite.mock.calls.map(([options]) => options.scope))
      .toEqual(['project', 'user']);
  });

  it('blocks stale target evidence before the first config write', async () => {
    const { dependencies, makeStatus } = await setupBackend();
    const intent = batchIntent(false);
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );
    mocks.statusCommandV8.mockResolvedValue(makeStatus(['user']));

    await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
  });

  it('marks apply failure as saved and retries only runtime writes for that scope', async () => {
    const { dependencies } = await setupBackend();
    const intent = batchIntent();
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );
    mocks.applyPluginConfigWrite
      .mockResolvedValueOnce({
        configWrite: 'succeeded', overallState: 'partial',
        apply: {
          state: 'partial',
          targetResults: [{ errorCode: 'runtimeApplyFailed' }],
        },
        otherProjectsMayRequireSync: false,
      })
      .mockResolvedValueOnce({
        configWrite: 'succeeded', overallState: 'succeeded',
        apply: { state: 'succeeded', targetResults: [] },
        otherProjectsMayRequireSync: false,
      });
    const result = await dependencies.executeIntent(intent, evidence);
    expect(result).toMatchObject({
      status: 'partial',
      groups: [{
        scope: 'project', status: 'failed', configSaved: true,
        applyStatus: 'failed', errorCode: 'runtimeApplyFailed',
      }, {
        scope: 'user', status: 'succeeded', configSaved: true,
      }],
    });

    const retryIntent: Extract<OperationIntent, { kind: 'configSave' }> = {
      kind: 'configSave', pluginId: 'team/demo', scope: 'project',
      apply: true, retryApply: true, updates: {}, removeKeys: [],
    };
    const retryEvidence = await dependencies.prepareReviewEvidence!(
      retryIntent,
      new AbortController().signal,
      () => undefined,
    );
    await dependencies.executeIntent(retryIntent, retryEvidence);
    expect(mocks.replayConfigRuntimeWrites).toHaveBeenCalledOnce();
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledTimes(2);
  });

  it('keeps the saved project layer and refuses to overwrite a user layer changed after it', async () => {
    const { dependencies, isolation } = await setupBackend();
    const intent = batchIntent(false);
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );
    mocks.applyPluginConfigWrite.mockImplementationOnce(async (options: {
      plugin: PluginMeta;
      pluginName: string;
      scope: 'project';
    }) => {
      const identity = {
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
        logicalIdentity: options.plugin.catalogLogicalIdentity,
        pluginName: options.pluginName,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      await writePluginConfigStore({
        ...identity,
        scope: 'project',
        values: { rules: { level: 'strict', token: 'project-secret' } },
      });
      await writePluginConfigStore({
        ...identity,
        scope: 'user',
        values: { mode: 'external-change' },
      });
      return {
        configWrite: 'succeeded' as const,
        overallState: 'succeeded' as const,
        apply: { state: 'skipped' as const, reason: 'notRequested', targetResults: [] },
        otherProjectsMayRequireSync: false,
      };
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      status: 'partial',
      groups: [{
        scope: 'project', status: 'succeeded', configSaved: true,
      }, {
        scope: 'user', status: 'failed', configSaved: false,
        errorCode: 'operationReviewStale',
      }],
    });
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledOnce();
    const source = evidence.source!;
    const identity = {
      sourceId: source.sourceId,
      sourceIdentity: source.sourceIdentity,
      ...('logicalIdentity' in source ? { logicalIdentity: source.logicalIdentity } : {}),
      pluginName: 'demo',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const project = await readPluginConfigStore({
      ...identity, scope: 'project',
    });
    const user = await readPluginConfigStore({
      ...identity, scope: 'user',
    });
    expect(project.values).toEqual({ rules: { level: 'strict', token: 'project-secret' } });
    expect(user.values).toEqual({ mode: 'external-change' });
  });
});
