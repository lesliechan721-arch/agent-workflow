import { describe, expect, it } from 'vitest';

import type {
  InstalledLedger,
  InstalledScopeRecord,
  PluginLocation,
} from '../../src/types.js';
import { createAvailableLedger } from '../../src/utils/local-marketplace.js';
import {
  buildIncomingDependencyIndex,
  clearDependencyEdges,
  createInstallSource,
  createInstalledDependencyEdge,
  createTrackingIdentityIndex,
  findAutoCleanupCandidates,
  locationFromParts,
  markScopeRecordExplicitlyRequested,
  upsertDependencyEdges,
} from '../../src/utils/plugin-dependency-graph.js';
import {
  normalizePluginLocation,
  serializePluginLocation,
  sortPluginLocations,
} from '../../src/utils/plugin-dependency-location.js';

function createScopeRecord(options: {
  installKind?: 'explicit' | 'dependency';
  dependencyEdges?: ReturnType<typeof createInstalledDependencyEdge>[];
} = {}): InstalledScopeRecord<Record<string, unknown>> {
  return {
    managed: true,
    updatedAt: '2026-05-06T00:00:00.000Z',
    resolvedVersion: '0.1.0',
    capabilitySnapshot: {
      managed: true,
    },
    installSource: createInstallSource(options.installKind ?? 'explicit'),
    dependencyEdges: options.dependencyEdges ?? [],
  };
}

function writeScopeRecord(
  ledger: InstalledLedger,
  location: PluginLocation,
  record: InstalledScopeRecord<Record<string, unknown>>,
): void {
  const pluginRecord = ledger.plugins[location.plugin] ?? {
    lastResolvedVersion: record.resolvedVersion,
    platforms: {},
  };
  const platformRecord = pluginRecord.platforms[location.platform] ?? {};

  if (location.scope === 'user') {
    pluginRecord.platforms[location.platform] = {
      ...platformRecord,
      userScope: record,
    };
  } else {
    pluginRecord.platforms[location.platform] = {
      ...platformRecord,
      projectScopes: {
        ...(platformRecord.projectScopes ?? {}),
        [location.projectKey ?? 'missing-project-key']: {
          ...record,
          projectKey: location.projectKey ?? undefined,
        },
      },
    };
  }

  ledger.plugins[location.plugin] = pluginRecord;
}

describe('plugin dependency graph helpers', () => {
  it('normalizes user locations and provides a stable serializer', () => {
    const userLocation = normalizePluginLocation({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
      projectKey: '/ignored-by-user-scope',
    });

    expect(userLocation.projectKey).toBeNull();
    expect(serializePluginLocation(userLocation)).toBe(
      JSON.stringify(['git-commit', 'codex', 'user', null]),
    );
    expect(
      sortPluginLocations([
        locationFromParts({
          plugin: 'workflow-pack',
          platform: 'claude',
          scope: 'user',
        }),
        locationFromParts({
          plugin: 'workflow-pack',
          platform: 'codex',
          scope: 'project',
          projectKey: '/repo',
        }),
        userLocation,
      ]),
    ).toEqual([
      userLocation,
      locationFromParts({
        plugin: 'workflow-pack',
        platform: 'claude',
        scope: 'user',
      }),
      locationFromParts({
        plugin: 'workflow-pack',
        platform: 'codex',
        scope: 'project',
        projectKey: '/repo',
      }),
    ]);
  });

  it('upserts outgoing dependency edges by dependency name without duplicating refs', () => {
    const gitCommitUser = locationFromParts({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    const gitCommitProject = locationFromParts({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'project',
      projectKey: '/repo',
    });

    const record = createScopeRecord({
      dependencyEdges: [
        createInstalledDependencyEdge({
          dependency: gitCommitUser,
          declaration: {
            name: 'git-commit',
          },
        }),
        createInstalledDependencyEdge({
          dependency: locationFromParts({
            plugin: 'slash-review',
            platform: 'codex',
            scope: 'user',
          }),
          declaration: {
            name: 'slash-review',
          },
        }),
      ],
    });

    const nextRecord = upsertDependencyEdges(record, [
      createInstalledDependencyEdge({
        dependency: gitCommitProject,
        declaration: {
          name: 'git-commit',
          target: {
            scope: 'project',
          },
        },
      }),
    ]);

    expect(nextRecord.dependencyEdges).toHaveLength(2);
    expect(nextRecord.dependencyEdges?.map((edge) => edge.declaration.name)).toEqual([
      'git-commit',
      'slash-review',
    ]);
    expect(nextRecord.dependencyEdges?.[0]?.dependency).toEqual(gitCommitProject);
  });

  it('builds incoming dependents from outgoing edges and dedupes duplicate edges', () => {
    const ledger = createAvailableLedger();
    const parentLocation = locationFromParts({
      plugin: 'workflow-pack',
      platform: 'codex',
      scope: 'user',
    });
    const dependencyLocation = locationFromParts({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    const dependencyEdge = createInstalledDependencyEdge({
      dependency: dependencyLocation,
      declaration: {
        name: 'git-commit',
        when: {
          platforms: ['codex'],
        },
      },
    });

    writeScopeRecord(ledger, parentLocation, createScopeRecord({
      dependencyEdges: [dependencyEdge, dependencyEdge],
    }));
    writeScopeRecord(ledger, dependencyLocation, createScopeRecord({
      installKind: 'dependency',
    }));

    const incomingIndex = buildIncomingDependencyIndex(ledger);
    expect(incomingIndex.dependencyMetadataComplete).toBe(true);
    expect(incomingIndex.incomingDependentsByLocation[serializePluginLocation(dependencyLocation)]).toEqual([
      {
        dependent: parentLocation,
        declaration: dependencyEdge.declaration,
      },
    ]);
  });

  it('marks auto-installed records as explicitly retained without erasing origin', () => {
    const record = createScopeRecord({
      installKind: 'dependency',
    });

    expect(markScopeRecordExplicitlyRequested(record).installSource).toEqual({
      kind: 'dependency',
      explicitlyRequested: true,
      allowsUnusedCleanup: false,
    });
  });

  it('finds auto cleanup candidates after outgoing refs are removed', () => {
    const ledger = createAvailableLedger();
    const parentLocation = locationFromParts({
      plugin: 'workflow-pack',
      platform: 'codex',
      scope: 'user',
    });
    const dependencyLocation = locationFromParts({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });

    writeScopeRecord(ledger, parentLocation, createScopeRecord({
      dependencyEdges: [
        createInstalledDependencyEdge({
          dependency: dependencyLocation,
          declaration: {
            name: 'git-commit',
          },
        }),
      ],
    }));
    writeScopeRecord(ledger, dependencyLocation, createScopeRecord({
      installKind: 'dependency',
    }));

    expect(findAutoCleanupCandidates(ledger)).toEqual([]);

    const parentRecord = ledger.plugins['workflow-pack']?.platforms.codex?.userScope;
    if (!parentRecord) {
      throw new Error('expected workflow-pack user scope');
    }
    writeScopeRecord(ledger, parentLocation, clearDependencyEdges(parentRecord));

    expect(findAutoCleanupCandidates(ledger)).toEqual([dependencyLocation]);
    expect(findAutoCleanupCandidates(ledger, {
      trackingIdentityByLocation: createTrackingIdentityIndex([
        {
          location: dependencyLocation,
          valid: false,
        },
      ]),
    })).toEqual([]);
  });

  it('fails closed for auto cleanup when dependency metadata is incomplete or explicitly retained', () => {
    const incompleteLedger = createAvailableLedger();
    const dependencyLocation = locationFromParts({
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });

    incompleteLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-05-06T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              managed: true,
            },
          },
        },
      },
    };
    expect(findAutoCleanupCandidates(incompleteLedger)).toEqual([]);

    const retainedLedger = createAvailableLedger();
    writeScopeRecord(
      retainedLedger,
      dependencyLocation,
      markScopeRecordExplicitlyRequested(createScopeRecord({
        installKind: 'dependency',
      })),
    );
    expect(findAutoCleanupCandidates(retainedLedger)).toEqual([]);
  });
});
