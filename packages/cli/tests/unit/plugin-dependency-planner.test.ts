import { describe, expect, it } from 'vitest';

import type {
  InstalledScopeInstallSource,
  PluginLocation,
} from '../../src/types.js';
import {
  planPluginDependencyUninstall,
  planPluginDependencyUpgradeAll,
  planPluginDependencyWrites,
  projectPluginDependencyStatus,
  type PluginDependencyPlannerState,
} from '../../src/utils/plugin-dependency-planner.js';
import { serializePluginLocation } from '../../src/utils/plugin-dependency-location.js';
import { createInstallSource } from '../../src/utils/plugin-dependency-graph.js';
import {
  createDependencyPlannerFixture,
  createDependencyPluginLocation,
  createDependencyPluginManifest,
  createPluginDependencyScenarioFixtures,
} from '../support/plugin-dependency-fixtures.js';

function plannerInstallSource(kind: 'explicit' | 'auto'): InstalledScopeInstallSource {
  return createInstallSource(kind === 'auto' ? 'dependency' : 'explicit');
}

function toPlannerState(
  fixture: ReturnType<typeof createDependencyPlannerFixture>,
): PluginDependencyPlannerState {
  return {
    currentCatalogByPlugin: fixture.currentCatalog.manifestsByPlugin,
    installedRecords: fixture.ledger.records.map((record) => ({
      location: record.location,
      resolvedVersion: record.resolvedVersion,
      installSource: plannerInstallSource(record.installSource),
      dependencyEdges: (record.dependencyEdges ?? []).map((edge) => ({
        dependency: edge.dependency,
        declaration: edge.declaration,
      })),
      installOptions: record.installOptions,
      snapshotManifest: record.snapshotManifest,
    })),
    healthRecords: fixture.health.records,
  };
}

function key(location: PluginLocation): string {
  return serializePluginLocation(location);
}

function withProjectSurface(manifest: ReturnType<typeof createDependencyPluginManifest>) {
  return {
    ...manifest,
    skills: './skills',
  };
}

describe('plugin dependency planner', () => {
  it('fails fast when a project target has no current project key', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const parent = fixtures.sameScopeDependencyParent.manifests[0];

    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: fixtures.sameScopeDependencyParent.manifests,
      })),
      targets: [{
        location: {
          plugin: parent.name,
          platform: 'codex',
          scope: 'project',
          projectKey: null,
        },
      }],
    })).toThrow(/project key/);
  });

  it('fails on self dependency, missing catalog dependency, overlap, and cycle before write planning', () => {
    const selfManifest = createDependencyPluginManifest({
      name: 'self-parent',
      dependencies: [{ name: 'self-parent' }],
    });
    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [selfManifest],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: selfManifest.name,
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/不能依赖自身/);

    const missingManifest = createDependencyPluginManifest({
      name: 'missing-parent',
      dependencies: [{ name: 'missing-child' }],
    });
    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [missingManifest],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: missingManifest.name,
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/catalog 中不存在/);

    const overlapFixtures = createPluginDependencyScenarioFixtures();
    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: overlapFixtures.overlappingPlatformConditions.manifests,
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: overlapFixtures.overlappingPlatformConditions.rootPluginNames[0],
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/重叠的平台条件 codex/);

    const cycleFixtures = createPluginDependencyScenarioFixtures();
    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: cycleFixtures.cycleDependency.manifests,
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: cycleFixtures.cycleDependency.rootPluginNames[0],
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/cycle-a -> cycle-b -> cycle-a/);
  });

  it('fails when the current catalog candidate does not satisfy dependency minVersion', () => {
    const parent = createDependencyPluginManifest({
      name: 'min-parent',
      dependencies: [
        {
          name: 'min-child',
          minVersion: '2.0.0',
        },
      ],
    });
    const child = createDependencyPluginManifest({
      name: 'min-child',
      version: '1.5.0',
    });

    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parent, child],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: parent.name,
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/至少需要 2.0.0，但 current catalog 只有 1.5.0/);
  });

  it('treats a too-old installed dependency as unsatisfied when minVersion is declared', () => {
    const parent = createDependencyPluginManifest({
      name: 'min-parent',
      dependencies: [
        {
          name: 'min-child',
          minVersion: '2.0.0',
        },
      ],
    });
    const child = createDependencyPluginManifest({
      name: 'min-child',
      version: '2.1.0',
    });
    const childLocation = createDependencyPluginLocation({
      plugin: child.name,
      platform: 'codex',
      scope: 'user',
    });

    const plan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parent, child],
        ledger: [{
          location: childLocation,
          resolvedVersion: '1.5.0',
        }],
        health: [{
          location: childLocation,
          state: 'healthy',
        }],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: parent.name,
          platform: 'codex',
          scope: 'user',
        }),
      }],
    });

    expect(plan.writeOrder).toEqual([
      childLocation,
      createDependencyPluginLocation({
        plugin: parent.name,
        platform: 'codex',
        scope: 'user',
      }),
    ]);
    expect(plan.edges[0]?.satisfied).toBe(false);
    expect(plan.edges[0]?.declaration.minVersion).toBe('2.0.0');
  });

  it('applies location-aware scope rules for fallback and hard target constraints', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const sameScopeParent = withProjectSurface(fixtures.sameScopeDependencyParent.manifests[0]);
    const sameScopeChild = fixtures.sameScopeDependencyParent.manifests[1];
    const parentProject = createDependencyPluginLocation({
      plugin: sameScopeParent.name,
      platform: 'codex',
      scope: 'project',
    });
    const childUser = createDependencyPluginLocation({
      plugin: sameScopeChild.name,
      platform: 'codex',
      scope: 'user',
    });
    const childProject = createDependencyPluginLocation({
      plugin: sameScopeChild.name,
      platform: 'codex',
      scope: 'project',
    });

    const fallbackPlan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [sameScopeParent, sameScopeChild],
        ledger: [{
          location: childUser,
        }],
        health: [{
          location: childUser,
          state: 'healthy',
        }],
      })),
      targets: [{ location: parentProject }],
    });
    expect(fallbackPlan.edges[0]?.dependency).toEqual(childUser);
    expect(fallbackPlan.writeOrder).toEqual([parentProject]);

    const projectParent = withProjectSurface(fixtures.projectParentDependsOnProjectScope.manifests[0]);
    const projectChild = withProjectSurface(fixtures.projectParentDependsOnProjectScope.manifests[1]);
    const explicitProjectPlan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [projectParent, projectChild],
        ledger: [{
          location: createDependencyPluginLocation({
            plugin: projectChild.name,
            platform: 'codex',
            scope: 'user',
          }),
        }],
        health: [{
          location: createDependencyPluginLocation({
            plugin: projectChild.name,
            platform: 'codex',
            scope: 'user',
          }),
          state: 'healthy',
        }],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: fixtures.projectParentDependsOnProjectScope.rootPluginNames[0],
          platform: 'codex',
          scope: 'project',
        }),
      }],
    });
    expect(explicitProjectPlan.writeOrder).toEqual([
      createDependencyPluginLocation({
        plugin: projectChild.name,
        platform: 'codex',
        scope: 'project',
      }),
      createDependencyPluginLocation({
        plugin: fixtures.projectParentDependsOnProjectScope.rootPluginNames[0],
        platform: 'codex',
        scope: 'project',
      }),
    ]);

    const explicitUserParent = withProjectSurface(fixtures.projectParentDependsOnUserScope.manifests[0]);
    const explicitUserChild = fixtures.projectParentDependsOnUserScope.manifests[1];
    const explicitUserPlan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [explicitUserParent, explicitUserChild],
        ledger: [{
          location: createDependencyPluginLocation({
            plugin: explicitUserChild.name,
            platform: 'codex',
            scope: 'project',
          }),
        }],
        health: [{
          location: createDependencyPluginLocation({
            plugin: explicitUserChild.name,
            platform: 'codex',
            scope: 'project',
          }),
          state: 'healthy',
        }],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: fixtures.projectParentDependsOnUserScope.rootPluginNames[0],
          platform: 'codex',
          scope: 'project',
        }),
      }],
    });
    expect(explicitUserPlan.writeOrder).toEqual([
      createDependencyPluginLocation({
        plugin: explicitUserChild.name,
        platform: 'codex',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: fixtures.projectParentDependsOnUserScope.rootPluginNames[0],
        platform: 'codex',
        scope: 'project',
      }),
    ]);

    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [projectParent, projectChild],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: fixtures.projectParentDependsOnProjectScope.rootPluginNames[0],
          platform: 'codex',
          scope: 'user',
        }),
      }],
    })).toThrow(/不能依赖 project scope/);
  });

  it('filters per-platform dependencies and keeps stable ordering for platform both expansions', () => {
    const parent = createDependencyPluginManifest({
      name: 'workflow-pack',
      dependencies: [
        {
          name: 'codex-dep',
          when: { platforms: ['codex'] },
        },
        {
          name: 'claude-dep',
          when: { platforms: ['claude'] },
        },
      ],
    });
    const codexDep = createDependencyPluginManifest({
      name: 'codex-dep',
      products: ['codex'],
    });
    const claudeDep = createDependencyPluginManifest({
      name: 'claude-dep',
      products: ['claude'],
    });

    const plan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parent, codexDep, claudeDep],
      })),
      targets: [
        {
          location: createDependencyPluginLocation({
            plugin: parent.name,
            platform: 'codex',
            scope: 'user',
          }),
        },
        {
          location: createDependencyPluginLocation({
            plugin: parent.name,
            platform: 'claude',
            scope: 'user',
          }),
        },
      ],
    });

    expect(plan.writeOrder).toEqual([
      createDependencyPluginLocation({
        plugin: 'codex-dep',
        platform: 'codex',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: 'workflow-pack',
        platform: 'codex',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: 'claude-dep',
        platform: 'claude',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: 'workflow-pack',
        platform: 'claude',
        scope: 'user',
      }),
    ]);
    expect(plan.edges.map((edge) => `${edge.dependent.platform}:${edge.declaration.name}`)).toEqual([
      'codex:codex-dep',
      'claude:claude-dep',
    ]);
  });

  it('retains an existing healthy edge and does not migrate to a different healthy location', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const parent = withProjectSurface(fixtures.sameScopeDependencyParent.manifests[0]);
    const child = fixtures.sameScopeDependencyParent.manifests[1];
    const parentProject = createDependencyPluginLocation({
      plugin: parent.name,
      platform: 'codex',
      scope: 'project',
    });
    const childUser = createDependencyPluginLocation({
      plugin: child.name,
      platform: 'codex',
      scope: 'user',
    });
    const childProject = createDependencyPluginLocation({
      plugin: child.name,
      platform: 'codex',
      scope: 'project',
    });

    const plan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parent, child],
        ledger: [
          {
            location: parentProject,
            dependencyEdges: [{
              dependency: childUser,
              declaration: { name: child.name },
            }],
          },
          { location: childUser },
          { location: childProject },
        ],
        health: [
          { location: childUser, state: 'healthy' },
          { location: childProject, state: 'healthy' },
        ],
      })),
      targets: [{ location: parentProject }],
    });

    expect(plan.edges[0]?.dependency).toEqual(childUser);
    expect(plan.edges[0]?.retainedExistingEdge).toBe(true);
    expect(plan.writeOrder).toEqual([parentProject]);
  });

  it('writes a shared dependency only once and keeps one edge per dependent', () => {
    const shared = createDependencyPluginManifest({
      name: 'shared-dep',
    });
    const parentA = createDependencyPluginManifest({
      name: 'parent-a',
      dependencies: [{ name: shared.name }],
    });
    const parentB = createDependencyPluginManifest({
      name: 'parent-b',
      dependencies: [{ name: shared.name }],
    });

    const plan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parentA, parentB, shared],
      })),
      targets: [
        {
          location: createDependencyPluginLocation({
            plugin: parentA.name,
            platform: 'codex',
            scope: 'user',
          }),
        },
        {
          location: createDependencyPluginLocation({
            plugin: parentB.name,
            platform: 'codex',
            scope: 'user',
          }),
        },
      ],
    });

    expect(plan.writeOrder).toEqual([
      createDependencyPluginLocation({
        plugin: shared.name,
        platform: 'codex',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: parentA.name,
        platform: 'codex',
        scope: 'user',
      }),
      createDependencyPluginLocation({
        plugin: parentB.name,
        platform: 'codex',
        scope: 'user',
      }),
    ]);
    expect(plan.edges.filter((edge) => edge.dependency.plugin === shared.name)).toHaveLength(2);
  });

  it('detects inherited install option conflicts for a shared missing dependency', () => {
    const shared = createDependencyPluginManifest({
      name: 'shared-trigger',
    });
    const parentA = createDependencyPluginManifest({
      name: 'trigger-parent-a',
      dependencies: [{
        name: shared.name,
        inheritInstallOptions: true,
      }],
    });
    const parentB = createDependencyPluginManifest({
      name: 'trigger-parent-b',
      dependencies: [{
        name: shared.name,
        inheritInstallOptions: true,
      }],
    });

    expect(() => planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [parentA, parentB, shared],
      })),
      targets: [
        {
          location: createDependencyPluginLocation({
            plugin: parentA.name,
            platform: 'codex',
            scope: 'user',
          }),
          installOptions: {
            skillTriggerPreference: 'manual',
          },
        },
        {
          location: createDependencyPluginLocation({
            plugin: parentB.name,
            platform: 'codex',
            scope: 'user',
          }),
          installOptions: {
            skillTriggerPreference: 'auto',
          },
        },
      ],
    })).toThrow(/冲突的安装选项/);
  });

  it('exposes graph-level preflight inputs for every write node', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const projectParent = withProjectSurface(fixtures.projectParentDependsOnProjectScope.manifests[0]);
    const projectChild = withProjectSurface(fixtures.projectParentDependsOnProjectScope.manifests[1]);
    const plan = planPluginDependencyWrites({
      mode: 'install',
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: [projectParent, projectChild],
      })),
      targets: [{
        location: createDependencyPluginLocation({
          plugin: fixtures.projectParentDependsOnProjectScope.rootPluginNames[0],
          platform: 'codex',
          scope: 'project',
        }),
      }],
    });

    expect(plan.preflight.requiredConfig).toEqual([
      createDependencyPluginLocation({
        plugin: fixtures.projectParentDependsOnProjectScope.rootPluginNames[0],
        platform: 'codex',
        scope: 'project',
      }),
      createDependencyPluginLocation({
        plugin: projectChild.name,
        platform: 'codex',
        scope: 'project',
      }),
    ]);
    expect(plan.preflight.scopeExclusivity).toEqual(plan.preflight.requiredConfig);
    expect(plan.preflight.codexProjectInstallability).toEqual(plan.preflight.requiredConfig);
  });

  it('selects upgrade-all roots from explicit installs, propagates skips, and finds stale auto deps after edge refresh', () => {
    const rootOne = createDependencyPluginManifest({
      name: 'root-one',
    });
    const rootTwo = createDependencyPluginManifest({
      name: 'root-two',
      dependencies: [{ name: 'shared-upgrade' }],
    });
    const shared = createDependencyPluginManifest({
      name: 'shared-upgrade',
    });
    const fixture = createDependencyPlannerFixture({
      currentCatalog: [rootOne, rootTwo, shared],
      ledger: [
        {
          location: createDependencyPluginLocation({
            plugin: rootOne.name,
            platform: 'codex',
            scope: 'user',
          }),
          dependencyEdges: [{
            dependency: createDependencyPluginLocation({
              plugin: 'old-auto-dep',
              platform: 'codex',
              scope: 'user',
            }),
            declaration: { name: 'old-auto-dep' },
          }],
        },
        {
          location: createDependencyPluginLocation({
            plugin: rootTwo.name,
            platform: 'codex',
            scope: 'user',
          }),
          dependencyEdges: [{
            dependency: createDependencyPluginLocation({
              plugin: shared.name,
              platform: 'codex',
              scope: 'user',
            }),
            declaration: { name: shared.name },
          }],
        },
        {
          location: createDependencyPluginLocation({
            plugin: shared.name,
            platform: 'codex',
            scope: 'user',
          }),
          installSource: 'auto',
        },
        {
          location: createDependencyPluginLocation({
            plugin: 'old-auto-dep',
            platform: 'codex',
            scope: 'user',
          }),
          installSource: 'auto',
        },
      ],
      health: [
        {
          location: createDependencyPluginLocation({
            plugin: rootOne.name,
            platform: 'codex',
            scope: 'user',
          }),
          state: 'healthy',
        },
        {
          location: createDependencyPluginLocation({
            plugin: rootTwo.name,
            platform: 'codex',
            scope: 'user',
          }),
          state: 'healthy',
        },
        {
          location: createDependencyPluginLocation({
            plugin: shared.name,
            platform: 'codex',
            scope: 'user',
          }),
          state: 'healthy',
        },
        {
          location: createDependencyPluginLocation({
            plugin: 'old-auto-dep',
            platform: 'codex',
            scope: 'user',
          }),
          state: 'healthy',
        },
      ],
    });

    const plan = planPluginDependencyUpgradeAll({
      state: toPlannerState(fixture),
      platforms: ['codex'],
      scope: 'user',
      initialSkipped: [{
        location: createDependencyPluginLocation({
          plugin: shared.name,
          platform: 'codex',
          scope: 'user',
        }),
        reason: 'repair required',
        code: 'repairRequired',
      }],
    });

    expect(plan.roots.map((location) => location.plugin)).toEqual(['root-one', 'root-two']);
    expect(plan.skipped).toEqual([
      {
        location: createDependencyPluginLocation({
          plugin: rootTwo.name,
          platform: 'codex',
          scope: 'user',
        }),
        reason: '依赖 shared-upgrade 被跳过：repair required',
        code: 'dependencySkipped',
        blockedBy: createDependencyPluginLocation({
          plugin: shared.name,
          platform: 'codex',
          scope: 'user',
        }),
      },
      {
        location: createDependencyPluginLocation({
          plugin: shared.name,
          platform: 'codex',
          scope: 'user',
        }),
        reason: 'repair required',
        code: 'repairRequired',
      },
    ]);
    expect(plan.writeOrder.map((location) => location.plugin)).toEqual(['root-one']);
    expect(plan.autoCleanupCandidates).toEqual([
      createDependencyPluginLocation({
        plugin: 'old-auto-dep',
        platform: 'codex',
        scope: 'user',
      }),
    ]);
  });

  it('does not reintroduce legacy records without explicit retention as upgrade-all roots', () => {
    const explicitRootLocation = createDependencyPluginLocation({
      plugin: 'explicit-root',
      platform: 'codex',
      scope: 'user',
    });
    const legacyRootLocation = createDependencyPluginLocation({
      plugin: 'legacy-root',
      platform: 'codex',
      scope: 'user',
    });

    const plan = planPluginDependencyUpgradeAll({
      state: {
        currentCatalogByPlugin: {
          'explicit-root': createDependencyPluginManifest({ name: 'explicit-root' }),
          'legacy-root': createDependencyPluginManifest({ name: 'legacy-root' }),
        },
        installedRecords: [
          {
            location: explicitRootLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [],
          },
          {
            location: legacyRootLocation,
            dependencyEdges: [],
          },
        ],
        healthRecords: [
          { location: explicitRootLocation, state: 'healthy' },
          { location: legacyRootLocation, state: 'healthy' },
        ],
      },
      platforms: ['codex'],
      scope: 'user',
    });

    expect(plan.roots).toEqual([explicitRootLocation]);
    expect(plan.writeOrder).toEqual([explicitRootLocation]);
    expect(plan.topologicalOrder).toEqual([explicitRootLocation]);
  });

  it('keeps both platform-specific project roots during upgrade-all when Codex and Claude project keys differ', () => {
    const codexProjectKey = '/workspace/repo';
    const claudeProjectKey = '/workspace/repo/packages/cli';
    const codexRootLocation = createDependencyPluginLocation({
      plugin: 'shared-project-root',
      platform: 'codex',
      scope: 'project',
      projectKey: codexProjectKey,
    });
    const claudeRootLocation = createDependencyPluginLocation({
      plugin: 'shared-project-root',
      platform: 'claude',
      scope: 'project',
      projectKey: claudeProjectKey,
    });

    const plan = planPluginDependencyUpgradeAll({
      state: {
        currentCatalogByPlugin: {
          'shared-project-root': withProjectSurface(createDependencyPluginManifest({
            name: 'shared-project-root',
          })),
        },
        installedRecords: [
          {
            location: codexRootLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [],
          },
          {
            location: claudeRootLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [],
          },
        ],
        healthRecords: [
          { location: codexRootLocation, state: 'healthy' },
          { location: claudeRootLocation, state: 'healthy' },
        ],
      },
      platforms: ['codex', 'claude'],
      scope: 'project',
      projectKeysByPlatform: {
        codex: codexProjectKey,
        claude: claudeProjectKey,
      },
    });

    expect(plan.roots).toEqual([claudeRootLocation, codexRootLocation]);
    expect(plan.writeOrder).toEqual([claudeRootLocation, codexRootLocation]);
  });

  it('protects uninstall when dependents remain and keeps unused dependency chains for explicit follow-up cleanup', () => {
    const child = createDependencyPluginManifest({
      name: 'cleanup-child',
      dependencies: [{ name: 'cleanup-grandchild' }],
    });
    const grandchild = createDependencyPluginManifest({
      name: 'cleanup-grandchild',
    });
    const parent = createDependencyPluginManifest({
      name: 'cleanup-parent',
      dependencies: [{ name: child.name }],
    });
    const parentLocation = createDependencyPluginLocation({
      plugin: parent.name,
      platform: 'codex',
      scope: 'user',
    });
    const childLocation = createDependencyPluginLocation({
      plugin: child.name,
      platform: 'codex',
      scope: 'user',
    });
    const grandchildLocation = createDependencyPluginLocation({
      plugin: grandchild.name,
      platform: 'codex',
      scope: 'user',
    });
    const fixture = createDependencyPlannerFixture({
      currentCatalog: [parent, child, grandchild],
      ledger: [
        {
          location: parentLocation,
          dependencyEdges: [{
            dependency: childLocation,
            declaration: { name: child.name },
          }],
        },
        {
          location: childLocation,
          installSource: 'auto',
          dependencyEdges: [{
            dependency: grandchildLocation,
            declaration: { name: grandchild.name },
          }],
        },
        {
          location: grandchildLocation,
          installSource: 'auto',
        },
      ],
      health: [
        { location: parentLocation, state: 'healthy' },
        { location: childLocation, state: 'healthy' },
        { location: grandchildLocation, state: 'healthy' },
      ],
    });

    const blockedPlan = planPluginDependencyUninstall({
      state: toPlannerState(fixture),
      requested: [childLocation],
    });
    expect(blockedPlan.blocked).toEqual([{
      location: childLocation,
      dependents: [parentLocation],
    }]);

    const cleanupPlan = planPluginDependencyUninstall({
      state: toPlannerState(fixture),
      requested: [parentLocation],
    });
    expect(cleanupPlan.blocked).toEqual([]);
    expect(cleanupPlan.autoCleanup).toEqual([]);
    expect(cleanupPlan.uninstallOrder).toEqual([parentLocation]);
  });

  it('allows uninstall when the full dependent set is requested together and preserves explicit keeps', () => {
    const childLocation = createDependencyPluginLocation({
      plugin: 'cleanup-child',
      platform: 'codex',
      scope: 'user',
    });
    const parentLocation = createDependencyPluginLocation({
      plugin: 'cleanup-parent',
      platform: 'codex',
      scope: 'user',
    });

    const allowedPlan = planPluginDependencyUninstall({
      state: {
        currentCatalogByPlugin: {},
        installedRecords: [
          {
            location: parentLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [{
              dependency: childLocation,
              declaration: { name: childLocation.plugin },
            }],
          },
          {
            location: childLocation,
            installSource: plannerInstallSource('auto'),
            dependencyEdges: [],
          },
        ],
        healthRecords: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'healthy' },
        ],
      },
      requested: [parentLocation, childLocation],
    });
    expect(allowedPlan.blocked).toEqual([]);
    expect(allowedPlan.uninstallOrder).toEqual([parentLocation, childLocation]);

    const explicitKeepPlan = planPluginDependencyUninstall({
      state: {
        currentCatalogByPlugin: {},
        installedRecords: [
          {
            location: parentLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [{
              dependency: childLocation,
              declaration: { name: childLocation.plugin },
            }],
          },
          {
            location: childLocation,
            installSource: {
              kind: 'dependency',
              explicitlyRequested: true,
              allowsUnusedCleanup: false,
            },
            dependencyEdges: [],
          },
        ],
        healthRecords: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'healthy' },
        ],
      },
      requested: [parentLocation],
    });
    expect(explicitKeepPlan.autoCleanup).toEqual([]);
    expect(explicitKeepPlan.uninstallOrder).toEqual([parentLocation]);
  });

  it('fails closed for uninstall protection when visible dependency metadata is incomplete', () => {
    const parentLocation = createDependencyPluginLocation({
      plugin: 'cleanup-parent',
      platform: 'codex',
      scope: 'user',
    });
    const childLocation = createDependencyPluginLocation({
      plugin: 'cleanup-child',
      platform: 'codex',
      scope: 'user',
    });

    const incompleteMetadataPlan = planPluginDependencyUninstall({
      state: {
        currentCatalogByPlugin: {},
        installedRecords: [
          {
            location: parentLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [{
              dependency: childLocation,
              declaration: { name: childLocation.plugin },
            }],
          },
          {
            location: childLocation,
            installSource: plannerInstallSource('auto'),
          },
        ],
        healthRecords: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'healthy' },
        ],
      },
      requested: [parentLocation],
    });
    expect(incompleteMetadataPlan.incompleteMetadataLocations).toEqual([childLocation]);
    expect(incompleteMetadataPlan.blocked).toEqual([]);
    expect(incompleteMetadataPlan.uninstallOrder).toEqual([]);
    expect(incompleteMetadataPlan.autoCleanup).toEqual([]);
  });

  it('skips risky auto cleanup when tracking identity is broken', () => {
    const parentLocation = createDependencyPluginLocation({
      plugin: 'cleanup-parent',
      platform: 'codex',
      scope: 'user',
    });
    const childLocation = createDependencyPluginLocation({
      plugin: 'cleanup-child',
      platform: 'codex',
      scope: 'user',
    });

    const trackingBrokenPlan = planPluginDependencyUninstall({
      state: {
        currentCatalogByPlugin: {},
        installedRecords: [
          {
            location: parentLocation,
            installSource: plannerInstallSource('explicit'),
            dependencyEdges: [{
              dependency: childLocation,
              declaration: { name: childLocation.plugin },
            }],
          },
          {
            location: childLocation,
            installSource: plannerInstallSource('auto'),
            dependencyEdges: [],
          },
        ],
        healthRecords: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'trackingBroken' },
        ],
      },
      requested: [parentLocation],
    });
    expect(trackingBrokenPlan.incompleteMetadataLocations).toEqual([]);
    expect(trackingBrokenPlan.autoCleanup).toEqual([]);
  });

  it('projects status from installed snapshots first, falls back to current catalog, and separates catalog drift', () => {
    const fixtures = createPluginDependencyScenarioFixtures();
    const parent = fixtures.sameScopeDependencyParent.manifests[0];
    const child = fixtures.sameScopeDependencyParent.manifests[1];
    const parentLocation = createDependencyPluginLocation({
      plugin: parent.name,
      platform: 'codex',
      scope: 'user',
    });
    const childLocation = createDependencyPluginLocation({
      plugin: child.name,
      platform: 'codex',
      scope: 'user',
    });

    const status = projectPluginDependencyStatus({
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: fixtures.sameScopeDependencyParent.manifests,
        ledger: [
          {
            location: parentLocation,
            snapshotManifest: {
              ...parent,
              dependencies: {
                plugins: [],
              },
            },
          },
          {
            location: childLocation,
            installSource: 'auto',
          },
        ],
        health: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'healthy' },
        ],
      })),
    });

    const parentStatus = status.find((entry) => key(entry.location) === key(parentLocation));
    expect(parentStatus).toMatchObject({
      healthSource: 'installedSnapshot',
      resolved: [],
      satisfied: [],
      missing: [],
      catalogDrift: {
        kind: 'dependenciesChanged',
        snapshotDependencies: [],
        currentDependencies: [child.name],
      },
    });

    const fallbackStatus = projectPluginDependencyStatus({
      state: toPlannerState(createDependencyPlannerFixture({
        currentCatalog: fixtures.sameScopeDependencyParent.manifests,
        ledger: [{
          location: parentLocation,
        }, {
          location: childLocation,
        }],
        health: [
          { location: parentLocation, state: 'healthy' },
          { location: childLocation, state: 'healthy' },
        ],
      })),
    }).find((entry) => key(entry.location) === key(parentLocation));

    expect(fallbackStatus).toMatchObject({
      healthSource: 'installedSnapshot',
      resolved: [],
      satisfied: [],
      missing: [],
      catalogDrift: {
        kind: 'dependenciesChanged',
        snapshotDependencies: [],
        currentDependencies: [child.name],
      },
    });
  });
});
