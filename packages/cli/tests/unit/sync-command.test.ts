import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalogMocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('../../src/utils/catalog-generation-service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/catalog-generation-service.js')>(),
  syncCatalogSourceGeneration: catalogMocks.refresh,
}));

vi.mock('../../src/commands/write-commands.js', () => ({
  syncWriteCommand: vi.fn(async () => ({
    platforms: ['codex'],
    plugins: ['demo'],
    warnings: [],
    rebuildResults: [],
    targetResults: [],
    overallState: 'succeeded',
    receiptTargets: [],
  })),
}));

import {
  resolveSyncIntentSelection,
  syncCommand,
} from '../../src/commands/sync-command.js';
import { syncWriteCommand } from '../../src/commands/write-commands.js';
import { buildRebuildReceiptJson } from '../../src/output/command-receipt.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
} from '../../src/utils/plugin-intent-state.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mockedReconcile = vi.mocked(syncWriteCommand);

describe('public Codex sync command', () => {
  beforeEach(() => {
    mockedReconcile.mockClear();
    catalogMocks.refresh.mockReset();
    catalogMocks.refresh.mockResolvedValue({});
  });

  it('freezes intent roots and groups shared source roots once per actual platform', () => {
    const selection = resolveSyncIntentSelection({
      roots: [
        { pluginId: 'first/codex-only', platforms: ['codex'] },
        { pluginId: 'first/dual', platforms: ['codex', 'claude'] },
        { pluginId: 'second/other', platforms: ['claude'] },
      ],
      selectors: [],
      all: true,
      platform: 'both',
    });

    expect(selection).toEqual({
      requestedPluginIds: ['first/codex-only', 'first/dual', 'second/other'],
      groups: [
        {
          sourceId: 'first', platform: 'codex',
          pluginIds: ['first/codex-only', 'first/dual'],
        },
        { sourceId: 'first', platform: 'claude', pluginIds: ['first/dual'] },
        { sourceId: 'second', platform: 'claude', pluginIds: ['second/other'] },
      ],
    });
  });

  it('rejects selectors with --all and non-interactive missing selection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const base = {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex' as const,
      scope: 'project' as const,
      interactive: false,
    };
    await expect(syncCommand(['official/demo'], { ...base, all: true }))
      .rejects.toMatchObject({ code: 'syncSelectorConflict' });
    await expect(syncCommand([], base))
      .rejects.toMatchObject({ code: 'syncSelectionRequired' });
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it('uses the existing prompt and reconciles selected desired roots without changing them', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = createEmptyPluginIntentState();
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'official/demo',
      platforms: ['codex'],
    });
    intent = {
      ...intent,
      dependencyScopeOverrides: [{
        pluginId: 'official/leaf',
        platform: 'codex',
        scope: 'user',
      }],
    };
    await writeIntentFixture({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }, intent);
    const multiSelect = vi.fn(async () => ({
      cancelled: false as const,
      value: ['official/demo'],
    }));

    await expect(syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: true,
      prompt: { multiSelect },
      yes: true,
    })).resolves.toMatchObject({ overallState: 'succeeded' });

    expect(multiSelect).toHaveBeenCalledOnce();
    expect(mockedReconcile).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({
        platform: 'codex',
        scope: 'project',
        yes: true,
      }),
      expect.objectContaining({
        directCli: true,
      }),
    );
    expect(mockedReconcile.mock.calls[0]?.[1]).not.toHaveProperty('dependencyScopeOverrides');
  });

  it('recovers a new clone from shared project intent with --all', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const intent = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'official/demo',
      platforms: ['codex'],
    });
    await writeIntentFixture({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }, intent);

    await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
    });

    expect(mockedReconcile).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'project' }),
      expect.objectContaining({ directCli: true }),
    );
    await expect(readIntentFixture({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toEqual(intent);
  });

  it('refreshes only selected root sources and keeps reconciling with the old Active on failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'first/demo', platforms: ['codex'],
    });
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'second/other', platforms: ['codex'],
    });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intent);
    catalogMocks.refresh.mockRejectedValueOnce(new Error('offline'));

    const result = await syncCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      refresh: true,
      cliVersion: '1.0.0',
      interactive: false,
    });

    expect(catalogMocks.refresh).toHaveBeenCalledOnce();
    expect(catalogMocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'first' }));
    expect(result.warnings).toEqual([expect.stringContaining('catalogSourceRefreshFailed: first')]);
    expect(mockedReconcile).toHaveBeenCalledWith(
      ['first/demo'],
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('isolates a source without Active while continuing unrelated refreshed sources', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'first/demo', platforms: ['codex'],
    });
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'second/other', platforms: ['codex'],
    });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intent);
    mockedReconcile.mockRejectedValueOnce(new Error('catalogSourceActiveMissing: first'))
      .mockImplementationOnce(async () => ({
      platforms: ['codex'], plugins: ['other'], warnings: [], rebuildResults: [],
      targetResults: [], overallState: 'succeeded', receiptTargets: [],
      }));

    const result = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      refresh: true,
      cliVersion: '1.0.0',
      interactive: false,
    });

    expect(catalogMocks.refresh).toHaveBeenCalledTimes(2);
    expect(mockedReconcile.mock.calls.map((call) => call[0])).toEqual([
      ['first/demo'],
      ['second/other'],
    ]);
    expect(result.plugins).toEqual(['other']);
    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'first/demo' }),
      state: 'failed',
      message: expect.stringContaining('catalogSourceActiveMissing'),
    }));
  });

  it('refreshes one source once and dispatches both platforms from each root intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'team/codex-only', platforms: ['codex'],
    });
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'team/dual', platforms: ['codex', 'claude'],
    });
    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intent);

    await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'both',
      scope: 'user',
      all: true,
      refresh: true,
      cliVersion: '1.0.0',
      interactive: false,
    });

    expect(catalogMocks.refresh).toHaveBeenCalledOnce();
    expect(catalogMocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'team' }));
    expect(mockedReconcile.mock.calls.map((call) => [call[0], call[1].platform])).toEqual([
      [['team/codex-only', 'team/dual'], 'codex'],
      [['team/dual'], 'claude'],
    ]);
  });

  it('merges dependency plans from source and platform groups into the public receipt', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'first/root', platforms: ['codex'],
    });
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'second/root', platforms: ['claude'],
    });
    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intent);
    mockedReconcile.mockImplementation(async (selectors, options) => {
      const rootId = selectors[0]!;
      const sourceId = rootId.split('/')[0]!;
      const dependencyId = `${sourceId}/leaf`;
      const platform = options.platform === 'both' ? 'codex' : options.platform;
      const dependencyScope = sourceId === 'first' ? 'user' : 'project';
      const targets = [
        {
          pluginId: dependencyId,
          pluginName: 'leaf',
          platform,
          resolvedScope: dependencyScope,
          relation: 'dependency' as const,
          requiredBy: [rootId],
          state: 'absent' as const,
          action: 'install' as const,
          order: 0,
          depth: 1,
          rootScope: 'project' as const,
          minimumScope: 'project' as const,
          allowedScopes: ['project', 'user'] as const,
          assignmentSource: sourceId === 'first' ? 'userOverride' as const : 'default' as const,
          locked: sourceId === 'first',
          ...(sourceId === 'first' ? { lockReason: 'dependencyScopeOverride' } : {}),
          affectsOtherProjects: sourceId === 'first',
        },
        {
          pluginId: rootId,
          pluginName: 'root',
          platform,
          resolvedScope: 'project' as const,
          relation: 'requested' as const,
          requiredBy: [],
          state: 'present' as const,
          action: 'keep' as const,
          order: 1,
          depth: 0,
          rootScope: 'project' as const,
          minimumScope: 'project' as const,
          allowedScopes: ['project', 'user'] as const,
          assignmentSource: 'root' as const,
          locked: true,
          lockReason: 'requestedRootScope',
          affectsOtherProjects: false,
        },
      ];
      return {
        platforms: [platform],
        plugins: [dependencyId, rootId],
        warnings: [],
        rebuildResults: targets.map((target) => ({
          status: 'succeeded' as const,
          command: 'sync' as const,
          target: {
            pluginName: target.pluginName,
            pluginId: target.pluginId,
            sourceId,
            pluginVersion: '1.0.0',
            platform,
            scope: target.resolvedScope,
            cwd: isolation.layout.fixtureCwd,
          },
          actions: [],
          cleanupAttempted: false,
          removed: [],
          absent: [],
          residual: [],
          quarantined: [],
          failures: [],
        })),
        targetResults: targets.map((target) => ({
          target: {
            pluginName: target.pluginName,
            pluginId: target.pluginId,
            sourceId,
            platform,
            scope: target.resolvedScope,
          },
          action: target.action,
          state: 'completed' as const,
          message: 'done',
        })),
        overallState: 'succeeded' as const,
        receiptTargets: [],
        dependencyPlan: {
          requestedPluginIds: [rootId],
          resolvedPluginIds: [dependencyId, rootId],
          dependencyEdges: [{ from: rootId, to: dependencyId, platform }],
          scopeOverrides: sourceId === 'first'
            ? [{ pluginId: dependencyId, platform, scope: 'user' as const }]
            : [],
          targets,
        },
      };
    });

    const result = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'both',
      scope: 'user',
      all: true,
      interactive: false,
    });
    const receipt = buildRebuildReceiptJson('sync', result);

    expect(mockedReconcile.mock.calls.map((call) => [call[0], call[1].platform])).toEqual([
      [['first/root'], 'codex'],
      [['second/root'], 'claude'],
    ]);
    expect(result.dependencyPlan).toMatchObject({
      requestedPluginIds: ['first/root', 'second/root'],
      resolvedPluginIds: ['first/leaf', 'first/root', 'second/leaf', 'second/root'],
      dependencyEdges: [
        { from: 'second/root', to: 'second/leaf', platform: 'claude' },
        { from: 'first/root', to: 'first/leaf', platform: 'codex' },
      ],
      scopeOverrides: [{ pluginId: 'first/leaf', platform: 'codex', scope: 'user' }],
      targets: expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'first/leaf', relation: 'dependency', requiredBy: ['first/root'],
          action: 'install', state: 'absent',
        }),
        expect.objectContaining({
          pluginId: 'second/leaf', relation: 'dependency', requiredBy: ['second/root'],
          action: 'install', state: 'absent',
        }),
      ]),
    });
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 6,
      overallState: 'succeeded',
      requestedPluginIds: ['first/root', 'second/root'],
      resolvedPluginIds: ['first/leaf', 'first/root', 'second/leaf', 'second/root'],
      dependencyEdges: [
        { from: 'second/root', to: 'second/leaf', platform: 'claude' },
        { from: 'first/root', to: 'first/leaf', platform: 'codex' },
      ],
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'first/leaf' }),
          relation: 'dependency', requiredBy: ['first/root'],
        }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'second/leaf' }),
          relation: 'dependency', requiredBy: ['second/root'],
        }),
      ]),
    });
  });

});
