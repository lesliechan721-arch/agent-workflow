import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPENDENCY_FIXTURE_PROJECT_KEY,
  PLUGIN_DEPENDENCY_P0_TEST_ENTRYPOINTS,
  createDependencyPlannerFixture,
  createDependencyPluginLocation,
  createInstalledSnapshotManifest,
  createPluginDependencyScenarioFixtures,
  detectInstalledSnapshotDependencyDrift,
  serializeDependencyPluginLocation,
} from '../support/plugin-dependency-fixtures.js';

describe('plugin dependency P0 fixtures', () => {
  it('locks the P0 baseline test entrypoints for command surfaces', () => {
    expect(PLUGIN_DEPENDENCY_P0_TEST_ENTRYPOINTS).toEqual({
      install: ['packages/cli/tests/unit/install-command.test.ts'],
      upgrade: ['packages/cli/tests/integration/upgrade-command.test.ts'],
      uninstall: ['packages/cli/tests/unit/uninstall-command.test.ts'],
      status: [
        'packages/cli/tests/integration/plugin-lifecycle-command.test.ts',
        'packages/cli/tests/unit/console-model.test.ts',
      ],
      consoleModel: ['packages/cli/tests/unit/console-model.test.ts'],
      localMarketplace: ['packages/cli/tests/unit/local-marketplace.test.ts'],
    });
  });

  it('provides the dependency scenarios required for P0 planner work', () => {
    const fixtures = createPluginDependencyScenarioFixtures();

    expect(Object.keys(fixtures)).toEqual([
      'noDependencyParent',
      'sameScopeDependencyParent',
      'codexOnlyDependency',
      'claudeOnlyDependency',
      'projectParentDependsOnUserScope',
      'projectParentDependsOnProjectScope',
      'cycleDependency',
      'overlappingPlatformConditions',
    ]);

    expect(fixtures.noDependencyParent.manifests[0].dependencies).toBeUndefined();
    expect(fixtures.sameScopeDependencyParent.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'same-scope-child' },
    ]);
    expect(fixtures.codexOnlyDependency.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'codex-only-child', when: { platforms: ['codex'] } },
    ]);
    expect(fixtures.claudeOnlyDependency.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'claude-only-child', when: { platforms: ['claude'] } },
    ]);
    expect(fixtures.projectParentDependsOnUserScope.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'user-scope-child', target: { scope: 'user' } },
    ]);
    expect(fixtures.projectParentDependsOnProjectScope.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'project-scope-child', target: { scope: 'project' } },
    ]);
    expect(fixtures.cycleDependency.manifests.map((manifest) => manifest.name)).toEqual([
      'cycle-a',
      'cycle-b',
    ]);
    expect(fixtures.overlappingPlatformConditions.manifests[0].dependencies?.plugins).toMatchObject([
      { name: 'overlap-child', when: { platforms: ['codex'] } },
      { name: 'overlap-child', when: { platforms: ['codex', 'claude'] } },
    ]);
  });

  it('builds planner fixtures with installed snapshot manifests and dependency drift', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const parentManifest = fixtures.sameScopeDependencyParent.manifests[0];
    const parentLocation = createDependencyPluginLocation({
      plugin: parentManifest.name,
      platform: 'codex',
      scope: 'project',
    });
    const snapshotManifest = createInstalledSnapshotManifest(parentManifest, {
      dependencies: {
        plugins: [{ name: 'legacy-child' }],
      },
    });

    const plannerFixture = createDependencyPlannerFixture({
      currentCatalog: fixtures.sameScopeDependencyParent.manifests,
      ledger: [{
        location: parentLocation,
        snapshotManifest,
      }],
      health: [{
        location: parentLocation,
        state: 'healthy',
      }],
    });

    const locationKey = serializeDependencyPluginLocation(parentLocation);
    expect(locationKey).toBe(
      `same-scope-parent::codex::project::${DEFAULT_DEPENDENCY_FIXTURE_PROJECT_KEY}`,
    );
    expect(plannerFixture.ledger.recordsByLocation[locationKey]?.snapshotManifest?.dependencies?.plugins).toEqual([
      { name: 'legacy-child' },
    ]);
    expect(plannerFixture.health.recordsByLocation[locationKey]).toMatchObject({
      state: 'healthy',
      visible: true,
      managedByAw: true,
    });
    expect(detectInstalledSnapshotDependencyDrift(plannerFixture)).toEqual([
      {
        locationKey,
        pluginName: 'same-scope-parent',
        kind: 'dependenciesChanged',
        snapshotDependencies: ['legacy-child'],
        currentDependencies: ['same-scope-child'],
      },
    ]);
  });

  it('normalizes user-scope fixture locations to a null project key', () => {
    expect(
      createDependencyPluginLocation({
        plugin: 'user-only-plugin',
        scope: 'user',
        projectKey: '/ignored',
      }),
    ).toEqual({
      plugin: 'user-only-plugin',
      platform: 'codex',
      scope: 'user',
      projectKey: null,
    });
  });
});
