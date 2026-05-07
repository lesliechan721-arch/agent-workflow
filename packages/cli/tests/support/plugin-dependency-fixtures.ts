import type {
  InstalledScopeInstallOptions,
  PlatformName,
  PluginManifestSource,
  Scope,
} from '../../src/types.js';

export const DEFAULT_DEPENDENCY_FIXTURE_PROJECT_KEY = '/workspace/current-project';

export const PLUGIN_DEPENDENCY_P0_TEST_ENTRYPOINTS = {
  install: ['packages/cli/tests/unit/install-command.test.ts'],
  upgrade: ['packages/cli/tests/integration/upgrade-command.test.ts'],
  uninstall: ['packages/cli/tests/unit/uninstall-command.test.ts'],
  status: [
    'packages/cli/tests/integration/plugin-lifecycle-command.test.ts',
    'packages/cli/tests/unit/console-model.test.ts',
  ],
  consoleModel: ['packages/cli/tests/unit/console-model.test.ts'],
  localMarketplace: ['packages/cli/tests/unit/local-marketplace.test.ts'],
} as const;

export interface DependencyFixtureDependency {
  name: string;
  target?: {
    scope?: Scope;
  };
  inheritInstallOptions?: boolean;
  when?: {
    platforms?: PlatformName[];
  };
}

export interface DependencyFixtureManifest extends PluginManifestSource {
  dependencies?: {
    plugins: DependencyFixtureDependency[];
  };
}

export interface DependencyFixtureCatalog {
  manifestsByPlugin: Record<string, DependencyFixtureManifest>;
}

export interface DependencyFixtureLocation {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
}

export interface DependencyFixtureLedgerRecord {
  location: DependencyFixtureLocation;
  resolvedVersion: string;
  installSource: 'explicit' | 'auto';
  dependencyEdges?: Array<{
    dependency: DependencyFixtureLocation;
    declaration: DependencyFixtureDependency;
  }>;
  installOptions?: InstalledScopeInstallOptions;
  snapshotManifest?: DependencyFixtureManifest;
}

export interface DependencyFixtureLedger {
  records: DependencyFixtureLedgerRecord[];
  recordsByLocation: Record<string, DependencyFixtureLedgerRecord>;
}

export type DependencyFixtureHealthState =
  | 'healthy'
  | 'missing'
  | 'degraded'
  | 'external'
  | 'repairRequired';

export interface DependencyFixtureHealthRecord {
  location: DependencyFixtureLocation;
  state: DependencyFixtureHealthState;
  visible: boolean;
  managedByAw: boolean;
}

export interface DependencyFixtureHealth {
  records: DependencyFixtureHealthRecord[];
  recordsByLocation: Record<string, DependencyFixtureHealthRecord>;
}

export interface DependencyPlannerFixture {
  currentCatalog: DependencyFixtureCatalog;
  ledger: DependencyFixtureLedger;
  health: DependencyFixtureHealth;
}

export interface DependencyFixtureDriftRecord {
  locationKey: string;
  pluginName: string;
  kind: 'none' | 'snapshotMissing' | 'currentCatalogMissing' | 'dependenciesChanged';
  snapshotDependencies: string[];
  currentDependencies: string[];
}

export interface DependencyScenarioFixture {
  rootPluginNames: string[];
  manifests: DependencyFixtureManifest[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function marketplaceProducts(platforms: readonly PlatformName[]): string[] {
  const tokens = platforms.map((platform) => platform === 'codex' ? 'CODEX' : 'CLAUDE');
  return Array.from(new Set(tokens));
}

function dependencyNames(manifest?: DependencyFixtureManifest): string[] {
  return (manifest?.dependencies?.plugins ?? []).map((entry) => entry.name);
}

function dependencySignature(manifest?: DependencyFixtureManifest): string {
  const entries = (manifest?.dependencies?.plugins ?? []).map((entry) => ({
    name: entry.name,
    targetScope: entry.target?.scope ?? null,
    inheritInstallOptions: entry.inheritInstallOptions ?? null,
    platforms: [...(entry.when?.platforms ?? [])],
  }));
  return JSON.stringify(entries);
}

export function createDependencyPluginManifest(options: {
  name: string;
  version?: string;
  description?: string;
  products?: PlatformName[];
  dependencies?: DependencyFixtureDependency[];
}): DependencyFixtureManifest {
  const manifest: DependencyFixtureManifest = {
    name: options.name,
    version: options.version ?? '0.1.0',
    description: options.description ?? `${options.name} fixture plugin`,
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: marketplaceProducts(options.products ?? ['codex', 'claude']),
      },
    },
  };

  if (options.dependencies) {
    manifest.dependencies = {
      plugins: clone(options.dependencies),
    };
  }

  return manifest;
}

export function createInstalledSnapshotManifest(
  manifest: DependencyFixtureManifest,
  overrides: Partial<DependencyFixtureManifest> = {},
): DependencyFixtureManifest {
  const snapshot = clone(manifest);
  return {
    ...snapshot,
    ...clone(overrides),
  };
}

export function createDependencyCatalogFixture(
  manifests: DependencyFixtureManifest[],
): DependencyFixtureCatalog {
  return {
    manifestsByPlugin: Object.fromEntries(
      manifests.map((manifest) => [manifest.name, clone(manifest)]),
    ),
  };
}

export function createDependencyPluginLocation(options: {
  plugin: string;
  platform?: PlatformName;
  scope?: Scope;
  projectKey?: string | null;
}): DependencyFixtureLocation {
  const scope = options.scope ?? 'user';
  return {
    plugin: options.plugin,
    platform: options.platform ?? 'codex',
    scope,
    projectKey: scope === 'user'
      ? null
      : (options.projectKey ?? DEFAULT_DEPENDENCY_FIXTURE_PROJECT_KEY),
  };
}

export function serializeDependencyPluginLocation(location: DependencyFixtureLocation): string {
  return [
    location.plugin,
    location.platform,
    location.scope,
    location.projectKey ?? 'user',
  ].join('::');
}

export function createDependencyLedgerFixture(entries: Array<{
  location: DependencyFixtureLocation;
  resolvedVersion?: string;
  installSource?: 'explicit' | 'auto';
  dependencyEdges?: Array<{
    dependency: DependencyFixtureLocation;
    declaration: DependencyFixtureDependency;
  }>;
  installOptions?: InstalledScopeInstallOptions;
  snapshotManifest?: DependencyFixtureManifest;
}>): DependencyFixtureLedger {
  const records = entries.map((entry) => ({
    location: clone(entry.location),
    resolvedVersion: entry.resolvedVersion ?? '0.1.0',
    installSource: entry.installSource ?? 'explicit',
    dependencyEdges: entry.dependencyEdges?.map((edge) => ({
      dependency: clone(edge.dependency),
      declaration: clone(edge.declaration),
    })) ?? [],
    installOptions: entry.installOptions ? clone(entry.installOptions) : undefined,
    snapshotManifest: entry.snapshotManifest ? clone(entry.snapshotManifest) : undefined,
  }));

  return {
    records,
    recordsByLocation: Object.fromEntries(
      records.map((record) => [serializeDependencyPluginLocation(record.location), record]),
    ),
  };
}

export function createDependencyHealthFixture(entries: Array<{
  location: DependencyFixtureLocation;
  state?: DependencyFixtureHealthState;
  visible?: boolean;
  managedByAw?: boolean;
}>): DependencyFixtureHealth {
  const records = entries.map((entry) => ({
    location: clone(entry.location),
    state: entry.state ?? 'healthy',
    visible: entry.visible ?? true,
    managedByAw: entry.managedByAw ?? true,
  }));

  return {
    records,
    recordsByLocation: Object.fromEntries(
      records.map((record) => [serializeDependencyPluginLocation(record.location), record]),
    ),
  };
}

export function createDependencyPlannerFixture(options: {
  currentCatalog?: DependencyFixtureManifest[];
  ledger?: Array<{
    location: DependencyFixtureLocation;
    resolvedVersion?: string;
    installSource?: 'explicit' | 'auto';
    dependencyEdges?: Array<{
      dependency: DependencyFixtureLocation;
      declaration: DependencyFixtureDependency;
    }>;
    installOptions?: InstalledScopeInstallOptions;
    snapshotManifest?: DependencyFixtureManifest;
  }>;
  health?: Array<{
    location: DependencyFixtureLocation;
    state?: DependencyFixtureHealthState;
    visible?: boolean;
    managedByAw?: boolean;
  }>;
} = {}): DependencyPlannerFixture {
  return {
    currentCatalog: createDependencyCatalogFixture(options.currentCatalog ?? []),
    ledger: createDependencyLedgerFixture(options.ledger ?? []),
    health: createDependencyHealthFixture(options.health ?? []),
  };
}

export function detectInstalledSnapshotDependencyDrift(
  fixture: Pick<DependencyPlannerFixture, 'currentCatalog' | 'ledger'>,
): DependencyFixtureDriftRecord[] {
  return fixture.ledger.records
    .map((record) => {
      const currentManifest = fixture.currentCatalog.manifestsByPlugin[record.location.plugin];
      const snapshotManifest = record.snapshotManifest;

      if (!snapshotManifest) {
        return {
          locationKey: serializeDependencyPluginLocation(record.location),
          pluginName: record.location.plugin,
          kind: 'snapshotMissing' as const,
          snapshotDependencies: [],
          currentDependencies: dependencyNames(currentManifest),
        };
      }

      if (!currentManifest) {
        return {
          locationKey: serializeDependencyPluginLocation(record.location),
          pluginName: record.location.plugin,
          kind: 'currentCatalogMissing' as const,
          snapshotDependencies: dependencyNames(snapshotManifest),
          currentDependencies: [],
        };
      }

      const kind = dependencySignature(snapshotManifest) === dependencySignature(currentManifest)
        ? 'none'
        : 'dependenciesChanged';

      return {
        locationKey: serializeDependencyPluginLocation(record.location),
        pluginName: record.location.plugin,
        kind,
        snapshotDependencies: dependencyNames(snapshotManifest),
        currentDependencies: dependencyNames(currentManifest),
      };
    })
    .sort((left, right) => left.locationKey.localeCompare(right.locationKey));
}

export function createPluginDependencyScenarioFixtures(): Record<string, DependencyScenarioFixture> {
  const noDependencyParent = createDependencyPluginManifest({
    name: 'no-deps-parent',
  });
  const sameScopeDependencyChild = createDependencyPluginManifest({
    name: 'same-scope-child',
  });
  const sameScopeDependencyParent = createDependencyPluginManifest({
    name: 'same-scope-parent',
    dependencies: [{ name: sameScopeDependencyChild.name }],
  });

  const codexOnlyDependencyChild = createDependencyPluginManifest({
    name: 'codex-only-child',
  });
  const codexOnlyDependencyParent = createDependencyPluginManifest({
    name: 'codex-only-parent',
    dependencies: [{
      name: codexOnlyDependencyChild.name,
      when: {
        platforms: ['codex'],
      },
    }],
  });

  const claudeOnlyDependencyChild = createDependencyPluginManifest({
    name: 'claude-only-child',
  });
  const claudeOnlyDependencyParent = createDependencyPluginManifest({
    name: 'claude-only-parent',
    dependencies: [{
      name: claudeOnlyDependencyChild.name,
      when: {
        platforms: ['claude'],
      },
    }],
  });

  const userScopeDependencyChild = createDependencyPluginManifest({
    name: 'user-scope-child',
  });
  const projectParentDependsOnUserScope = createDependencyPluginManifest({
    name: 'project-parent-user-dep',
    dependencies: [{
      name: userScopeDependencyChild.name,
      target: {
        scope: 'user',
      },
    }],
  });

  const projectScopeDependencyChild = createDependencyPluginManifest({
    name: 'project-scope-child',
  });
  const projectParentDependsOnProjectScope = createDependencyPluginManifest({
    name: 'project-parent-project-dep',
    dependencies: [{
      name: projectScopeDependencyChild.name,
      target: {
        scope: 'project',
      },
    }],
  });

  const cycleDependencyA = createDependencyPluginManifest({
    name: 'cycle-a',
    dependencies: [{ name: 'cycle-b' }],
  });
  const cycleDependencyB = createDependencyPluginManifest({
    name: 'cycle-b',
    dependencies: [{ name: 'cycle-a' }],
  });

  const overlapDependencyChild = createDependencyPluginManifest({
    name: 'overlap-child',
  });
  const overlappingPlatformConditions = createDependencyPluginManifest({
    name: 'overlap-parent',
    dependencies: [
      {
        name: overlapDependencyChild.name,
        when: {
          platforms: ['codex'],
        },
      },
      {
        name: overlapDependencyChild.name,
        when: {
          platforms: ['codex', 'claude'],
        },
      },
    ],
  });

  return {
    noDependencyParent: {
      rootPluginNames: [noDependencyParent.name],
      manifests: [noDependencyParent],
    },
    sameScopeDependencyParent: {
      rootPluginNames: [sameScopeDependencyParent.name],
      manifests: [sameScopeDependencyParent, sameScopeDependencyChild],
    },
    codexOnlyDependency: {
      rootPluginNames: [codexOnlyDependencyParent.name],
      manifests: [codexOnlyDependencyParent, codexOnlyDependencyChild],
    },
    claudeOnlyDependency: {
      rootPluginNames: [claudeOnlyDependencyParent.name],
      manifests: [claudeOnlyDependencyParent, claudeOnlyDependencyChild],
    },
    projectParentDependsOnUserScope: {
      rootPluginNames: [projectParentDependsOnUserScope.name],
      manifests: [projectParentDependsOnUserScope, userScopeDependencyChild],
    },
    projectParentDependsOnProjectScope: {
      rootPluginNames: [projectParentDependsOnProjectScope.name],
      manifests: [projectParentDependsOnProjectScope, projectScopeDependencyChild],
    },
    cycleDependency: {
      rootPluginNames: [cycleDependencyA.name],
      manifests: [cycleDependencyA, cycleDependencyB],
    },
    overlappingPlatformConditions: {
      rootPluginNames: [overlappingPlatformConditions.name],
      manifests: [overlappingPlatformConditions, overlapDependencyChild],
    },
  };
}
