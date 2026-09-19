import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOperationPlan } from '../../src/commands/operation-plan.js';
import type {
  StatusTargetRevision,
  StatusV8Payload,
  StatusV8PluginSummary,
} from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type PluginWriteTaskEvidence,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import {
  buildPluginDetailActions,
  buildPluginUpdateSummary,
  buildTuiViewModel,
} from '../../src/tui/model.js';

afterEach(() => cleanup());

const source = (identity = 'identity:official'): StatusV8Payload['catalog']['sources'][number] => ({
  id: 'official', identity, type: 'git', primary: true,
  requestedRef: 'refs/heads/catalog/latest', resolvedCommit: 'a'.repeat(40),
  catalogVersion: '2.0.0', channel: 'latest', freshness: 'active',
});

const target = (
  platform: 'codex' | 'claude',
  scope: 'user' | 'project',
  state: 'ready' | 'needsSync' = 'ready',
): StatusV8Payload['targets'][number] => {
  const identity = {
    pluginName: 'demo', sourceId: 'official', sourceIdentity: 'identity:official',
    pluginId: 'official/demo', version: '2.0.0', cwd: '/workspace',
  };
  const placement = {
    scope, state,
    components: [{ kind: 'ownership' as const, key: `${platform}-${scope}`, state: state === 'ready' ? 'present' : 'partial' }],
    reasons: [], recoveryActions: [],
  };
  return platform === 'codex'
    ? { ...identity, platform, state, components: [], reasons: [], recoveryActions: [], placements: [placement] }
    : { ...identity, platform, ...placement };
};

const revisions: StatusTargetRevision[] = [{
  pluginId: 'official/demo', platform: 'codex', scope: 'user',
  revision: { state: 'upgradeAvailable', installedVersion: '1.0.0', availableVersion: '2.0.0' },
}, {
  pluginId: 'official/demo', platform: 'claude', scope: 'project',
  revision: { state: 'current', installedVersion: '2.0.0', availableVersion: '2.0.0' },
}];

const summary: StatusV8PluginSummary = {
  pluginName: 'demo', pluginId: 'official/demo', displayName: 'Demo',
  description: '演示用途', version: '2.0.0',
  supportedTargets: { codex: ['user'], claude: ['project'] },
};

function status(
  catalogSource = source(),
  targets: StatusV8Payload['targets'] = [target('codex', 'user'), target('claude', 'project')],
): StatusV8Payload {
  return {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official', configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite', sources: [catalogSource],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets,
    errors: [],
  };
}

function loaded(catalogSource = source()): TuiStatusLoadResult {
  return {
    payload: status(catalogSource), pluginSummaries: [summary], targetRevisions: revisions,
    sourceDetails: [{
      id: 'official', type: 'git', primary: true, autoCheck: true,
      locationSummary: 'https://example.test/catalog.git', refPolicy: 'cliChannel',
      pluginCount: 1, sourceIdentity: catalogSource.identity,
      requestedRef: 'refs/heads/catalog/latest', configDigest: 'sha256:config',
    }],
    catalogGenerations: [{
      sourceId: 'official', sourceType: 'git', state: 'ready',
      active: {
        catalogVersion: '2.0.0', channel: 'latest', requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'a'.repeat(40), storeKey: 'official/active', digestShort: 'aaaaaaaa',
      },
    }],
  };
}

function dependencies(overrides: Partial<TuiControllerDependencies> = {}): TuiControllerDependencies {
  return {
    loadStatus: vi.fn().mockResolvedValue(loaded()),
    captureEvidence: vi.fn().mockResolvedValue({
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    }),
    executeIntent: vi.fn(),
    ...overrides,
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('TUI plugin update evidence', () => {
  it('aggregates every target by canonical plugin ID without replacing health', () => {
    const view = buildTuiViewModel({
      status: status(source(), [target('codex', 'user', 'needsSync'), target('claude', 'project')]),
      pluginSummaries: [summary],
      targetRevisions: revisions,
    });

    expect(view.plugins).toHaveLength(1);
    expect(view.plugins[0]).toMatchObject({
      pluginId: 'official/demo', aggregateStatus: 'needsAttention',
      update: {
        state: 'available',
        targets: expect.arrayContaining([
          expect.objectContaining({
            platform: 'codex', installedVersion: '1.0.0', activeVersion: '2.0.0',
            availableVersion: '2.0.0', eligibility: 'needsRepair',
          }),
          expect.objectContaining({
            platform: 'claude', installedVersion: '2.0.0', activeVersion: '2.0.0',
          }),
        ]),
      },
    });
    expect(view.home).toMatchObject({ pluginUpdateCount: 1, directPluginUpdateCount: 0 });
  });

  it.each([
    ['invalid installed version', 'version-one', '2.0.0', 'unknown'],
    ['downgrade', '3.0.0', '2.0.0', 'blocked'],
    ['build metadata only', '2.0.0+installed', '2.0.0+active', 'currentAgainstCatalog'],
  ] as const)('does not advertise %s as an update', (_name, installedVersion, activeVersion, expected) => {
    const projection = buildPluginUpdateSummary({
      pluginId: 'official/demo', sourceId: 'official', targets: [target('codex', 'user')],
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: { state: 'unknown', installedVersion, availableVersion: activeVersion },
      }],
    });
    expect(projection.state).toBe(expected);
    expect(projection.targets[0]?.availableVersion).toBeUndefined();
  });

  it('keeps a validated candidate after a failed recheck and invalidates it on source identity change', async () => {
    const candidate = {
      sourceConfigFingerprint: 'sha256:source', sourceIdentity: 'identity:official',
      logicalIdentity: 'workspace:official', requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'b'.repeat(40), catalogVersion: '3.0.0', channel: 'latest' as const,
      manifestDigest: `sha256:${'b'.repeat(64)}`, snapshotDigest: `sha256:${'c'.repeat(64)}`,
    };
    const probeCatalogFreshness = vi.fn()
      .mockResolvedValueOnce({
        sourceId: 'official', state: 'updateAvailable' as const, activeVersion: '2.0.0', candidate,
        reusableCandidate: {
          sourceConfigFingerprint: 'sha256:source', activeStoreKey: 'official/active',
          probe: {
            sourceId: 'official', candidate,
            manifest: { requires: { aw: { capabilities: [] } }, entries: [{
              name: 'demo', version: '3.0.0', manifestDigest: `sha256:${'d'.repeat(64)}`,
              contentDigest: `sha256:${'e'.repeat(64)}`,
              requires: { aw: { capabilities: [] } },
            }] },
          },
        },
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sourceId: 'official', state: 'current' as const });
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(loaded())
      .mockResolvedValueOnce(loaded(source('identity:changed')));
    const controller = new TuiController(dependencies({
      loadStatus,
      probeCatalogFreshness,
      now: () => Date.parse('2026-09-07T08:00:00.000Z'),
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenNthCalledWith(
      1, 'official', { fullValidation: false }, expect.any(AbortSignal),
    );
    expect(controller.getPluginOverview('official/demo')?.update).toMatchObject({
      state: 'available', checkedAt: '2026-09-07T08:00:00.000Z',
      targets: expect.arrayContaining([expect.objectContaining({
        platform: 'claude', candidateVersion: '3.0.0', availableVersion: '3.0.0',
        requiresCatalogActivation: true,
      })]),
    });
    expect(buildPluginDetailActions(controller.getPluginOverview('official/demo')!)
      .some((action) => action.id === 'refreshAndSync' && action.availableVersion === '3.0.0')).toBe(false);

    await controller.recheckCatalogSource('official');
    expect(controller.getPluginOverview('official/demo')?.update).toMatchObject({
      state: 'available', lastSuccessful: true, checkedAt: '2026-09-07T08:00:00.000Z',
    });

    await controller.reloadCatalog({ sourceId: 'official' });
    expect(controller.getPluginOverview('official/demo')?.update.targets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        candidateVersion: '3.0.0', requiresCatalogActivation: true,
      })]),
    );
    controller.dispose();
  });

  it('keeps an incompatible candidate visible without counting it as an update', async () => {
    const candidate = {
      sourceConfigFingerprint: 'sha256:source', sourceIdentity: 'identity:official',
      logicalIdentity: 'workspace:official', requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'b'.repeat(40), catalogVersion: '3.0.0', channel: 'latest' as const,
      manifestDigest: `sha256:${'b'.repeat(64)}`, snapshotDigest: `sha256:${'c'.repeat(64)}`,
    };
    const currentRevisions: StatusTargetRevision[] = revisions.map((entry) => ({
      ...entry,
      revision: { state: 'current', installedVersion: '2.0.0', availableVersion: '2.0.0' },
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({ ...loaded(), targetRevisions: currentRevisions }),
      probeCatalogFreshness: vi.fn().mockResolvedValue({
        sourceId: 'official', state: 'updateAvailable' as const, activeVersion: '2.0.0', candidate,
        reusableCandidate: {
          sourceConfigFingerprint: 'sha256:source', activeStoreKey: 'official/active',
          probe: {
            sourceId: 'official', candidate,
            manifest: {
              requires: { aw: { capabilities: ['aw.future.catalog.v1'] } },
              entries: [{
                name: 'demo', version: '3.0.0', manifestDigest: `sha256:${'d'.repeat(64)}`,
                contentDigest: `sha256:${'e'.repeat(64)}`,
                requires: { aw: { capabilities: ['aw.future.unsupported.v1'] } },
              }],
            },
          },
        },
      }),
    }));

    await controller.load();
    await nextTurn();
    const update = controller.getPluginOverview('official/demo')!.update;
    expect(update.state).toBe('blocked');
    expect(update.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'claude', candidateVersion: '3.0.0', eligibility: 'incompatible',
        missingCapabilities: expect.arrayContaining([
          'aw.future.catalog.v1', 'aw.future.unsupported.v1',
        ]),
      }),
    ]));
    expect(update.targets.find((entry) => entry.platform === 'claude')?.availableVersion)
      .toBeUndefined();
    expect(controller.snapshot.viewModel?.home.pluginUpdateCount).toBe(0);
    expect(controller.snapshot.viewModel?.home.directPluginUpdateCount).toBe(0);
    controller.dispose();
  });

  it('shows the canonical update count, platform update badge, detail CTA, and update filter', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'pluginWriteTask') {
        return { catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' } };
      }
      const receiptTarget = {
        pluginName: 'demo', pluginId: 'official/demo', sourceId: 'official',
        platform: 'codex' as const, scope: 'user' as const,
      };
      const preview = {
        platforms: ['codex'], plugins: ['demo'], warnings: [], rebuildResults: [],
        targetResults: [{ target: receiptTarget, action: 'sync' as const, state: 'completed' as const }],
        overallState: 'succeeded' as const,
        receiptTargets: [receiptTarget],
        operationPlan: createOperationPlan({
          intentChanges: [], actions: [], changes: ['official/demo:codex:user'], warnings: [],
          evidence: {
            catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
            intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
          },
        }),
      };
      const evidence: PluginWriteTaskEvidence = {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
        taskPlan: {
          goal: intent.goal,
          requestedTargets: intent.targets,
          executableTargets: intent.targets,
          causes: [],
          blockedTargets: [],
          sources: [{
            sourceId: 'official',
            sourceIdentity: 'identity:official',
            requestedTargets: intent.targets,
            causes: [],
            preview,
            executable: true,
          }],
          targetFingerprint: 'sha256:target',
          planFingerprint: '',
        },
      };
      evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
      return evidence;
    });
    const controllerDependencies = dependencies({ captureEvidence });
    const controller = new TuiController(controllerDependencies);
    const home = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await controller.load();
    await nextTurn();
    expect(home.lastFrame()).toContain('[可更新 1]');
    home.unmount();

    controller.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('[✓ Codex ↑]');
    expect(instance.lastFrame()).toContain('更新 1');
    expect(controller.listPlugins({ mode: 'installed', installFilter: 'updateAvailable' }))
      .toHaveLength(1);
    instance.stdin.write('\t');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('[未安装 0]'));
    instance.stdin.write('f');
    await nextTurn();
    await nextTurn();
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('[可更新 1]'));

    instance.stdin.write('\t');
    await nextTurn();
    instance.stdin.write('\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    }));
    expect(instance.lastFrame()).toContain('更新到 2.0.0');
    instance.unmount();
    const detail = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();
    detail.stdin.write('\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'));
    expect(controller.snapshot.activeReview).toMatchObject({
      operationKind: 'pluginWriteTask', taskGoal: 'update',
    });
    expect(controllerDependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask', goal: 'update', executionPolicy: 'all',
      targets: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        expectedUpdate: {
          installedVersion: '1.0.0', activeVersion: '2.0.0',
          sourceIdentity: 'identity:official', generationKey: 'official/active',
        },
      }],
    }), expect.any(AbortSignal));
    controller.dispose();
  });
});
