import type {
  InstalledDependencyEdge,
  InstalledDependencyEdgeDeclaration,
  InstalledLedger,
  InstalledScopeInstallSource,
  InstalledScopeRecord,
  PlatformName,
  PluginLocation,
  Scope,
} from '../types.js';
import {
  comparePluginLocations,
  normalizePluginLocation,
  serializePluginLocation,
} from './plugin-dependency-location.js';

export interface IncomingDependencyReference {
  dependent: PluginLocation;
  declaration: InstalledDependencyEdgeDeclaration;
}

export interface IncomingDependencyIndex {
  dependencyMetadataComplete: boolean;
  incomingDependentsByLocation: Record<string, IncomingDependencyReference[]>;
}

export interface AutoCleanupCandidateOptions {
  incomingIndex?: IncomingDependencyIndex;
  trackingIdentityByLocation?: Record<string, boolean>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePlatforms(platforms: readonly PlatformName[] | undefined): PlatformName[] | undefined {
  if (!platforms || platforms.length === 0) {
    return undefined;
  }

  return [...new Set(platforms)].sort();
}

function normalizeDeclaration(
  declaration: InstalledDependencyEdgeDeclaration,
): InstalledDependencyEdgeDeclaration {
  return {
    name: declaration.name,
    target: declaration.target?.scope
      ? { scope: declaration.target.scope }
      : undefined,
    inheritInstallOptions: declaration.inheritInstallOptions === true ? true : undefined,
    when: normalizePlatforms(declaration.when?.platforms)
      ? { platforms: normalizePlatforms(declaration.when?.platforms) }
      : undefined,
  };
}

function compareDeclarations(
  left: InstalledDependencyEdgeDeclaration,
  right: InstalledDependencyEdgeDeclaration,
): number {
  return (
    compareStrings(left.name, right.name) ||
    compareStrings(left.target?.scope ?? '', right.target?.scope ?? '') ||
    compareStrings(
      left.inheritInstallOptions === true ? 'true' : '',
      right.inheritInstallOptions === true ? 'true' : '',
    ) ||
    compareStrings(
      JSON.stringify(left.when?.platforms ?? []),
      JSON.stringify(right.when?.platforms ?? []),
    )
  );
}

function compareDependencyEdges(left: InstalledDependencyEdge, right: InstalledDependencyEdge): number {
  return (
    compareDeclarations(left.declaration, right.declaration) ||
    comparePluginLocations(left.dependency, right.dependency)
  );
}

function cloneScopeRecord<TCapabilitySnapshot>(
  record: InstalledScopeRecord<TCapabilitySnapshot>,
): InstalledScopeRecord<TCapabilitySnapshot> {
  return {
    ...record,
    installSource: record.installSource
      ? { ...record.installSource }
      : undefined,
    dependencyEdges: record.dependencyEdges
      ? record.dependencyEdges.map((edge) => ({
        dependency: normalizePluginLocation(edge.dependency),
        declaration: normalizeDeclaration(edge.declaration),
      }))
      : undefined,
  };
}

export function createInstallSource(kind: 'explicit' | 'dependency'): InstalledScopeInstallSource {
  if (kind === 'explicit') {
    return {
      kind,
      explicitlyRequested: true,
      allowsUnusedCleanup: false,
    };
  }

  return {
    kind,
    explicitlyRequested: false,
    allowsUnusedCleanup: true,
  };
}

export function markInstallSourceExplicit(
  installSource: InstalledScopeInstallSource | undefined,
): InstalledScopeInstallSource {
  return {
    kind: installSource?.kind ?? 'explicit',
    explicitlyRequested: true,
    allowsUnusedCleanup: false,
  };
}

export function markScopeRecordExplicitlyRequested<TCapabilitySnapshot>(
  record: InstalledScopeRecord<TCapabilitySnapshot>,
): InstalledScopeRecord<TCapabilitySnapshot> {
  const nextRecord = cloneScopeRecord(record);
  nextRecord.installSource = markInstallSourceExplicit(record.installSource);
  return nextRecord;
}

export function createInstalledDependencyEdge(options: {
  dependency: PluginLocation;
  declaration: InstalledDependencyEdgeDeclaration;
}): InstalledDependencyEdge {
  return {
    dependency: normalizePluginLocation(options.dependency),
    declaration: normalizeDeclaration(options.declaration),
  };
}

export function upsertDependencyEdges<TCapabilitySnapshot>(
  record: InstalledScopeRecord<TCapabilitySnapshot>,
  edges: readonly InstalledDependencyEdge[],
): InstalledScopeRecord<TCapabilitySnapshot> {
  const nextRecord = cloneScopeRecord(record);
  const nextByDeclarationName = new Map<string, InstalledDependencyEdge>();

  for (const edge of nextRecord.dependencyEdges ?? []) {
    nextByDeclarationName.set(edge.declaration.name, createInstalledDependencyEdge(edge));
  }

  for (const edge of edges) {
    const normalizedEdge = createInstalledDependencyEdge(edge);
    nextByDeclarationName.set(normalizedEdge.declaration.name, normalizedEdge);
  }

  nextRecord.dependencyEdges = [...nextByDeclarationName.values()].sort(compareDependencyEdges);
  return nextRecord;
}

export function clearDependencyEdges<TCapabilitySnapshot>(
  record: InstalledScopeRecord<TCapabilitySnapshot>,
): InstalledScopeRecord<TCapabilitySnapshot> {
  const nextRecord = cloneScopeRecord(record);
  nextRecord.dependencyEdges = [];
  return nextRecord;
}

export function removeDependencyEdgesByName<TCapabilitySnapshot>(
  record: InstalledScopeRecord<TCapabilitySnapshot>,
  dependencyNames: readonly string[],
): InstalledScopeRecord<TCapabilitySnapshot> {
  const names = new Set(dependencyNames);
  const nextRecord = cloneScopeRecord(record);
  nextRecord.dependencyEdges = (nextRecord.dependencyEdges ?? [])
    .filter((edge) => !names.has(edge.declaration.name))
    .sort(compareDependencyEdges);
  return nextRecord;
}

export function iterateInstalledScopeRecords(
  ledger: InstalledLedger,
): Array<{ location: PluginLocation; record: InstalledScopeRecord<unknown> }> {
  const entries: Array<{ location: PluginLocation; record: InstalledScopeRecord<unknown> }> = [];

  for (const [pluginName, pluginRecord] of Object.entries(ledger.plugins)) {
    for (const platform of ['codex', 'claude'] as const satisfies readonly PlatformName[]) {
      const platformRecord = pluginRecord.platforms[platform];
      if (!platformRecord) {
        continue;
      }

      if (platformRecord.userScope) {
        entries.push({
          location: normalizePluginLocation({
            plugin: pluginName,
            platform,
            scope: 'user',
            projectKey: null,
          }),
          record: platformRecord.userScope,
        });
      }

      for (const [projectKey, projectScopeRecord] of Object.entries(platformRecord.projectScopes ?? {})) {
        entries.push({
          location: normalizePluginLocation({
            plugin: pluginName,
            platform,
            scope: 'project',
            projectKey: projectScopeRecord.projectKey ?? projectKey,
          }),
          record: projectScopeRecord,
        });
      }
    }
  }

  return entries.sort((left, right) => comparePluginLocations(left.location, right.location));
}

export function hasCompleteDependencyMetadata(
  ledger: InstalledLedger,
): boolean {
  for (const { record } of iterateInstalledScopeRecords(ledger)) {
    if (!record.installSource || !record.dependencyEdges) {
      return false;
    }
  }

  return true;
}

export function buildIncomingDependencyIndex(ledger: InstalledLedger): IncomingDependencyIndex {
  const incomingBuckets = new Map<string, Map<string, IncomingDependencyReference>>();
  const dependencyMetadataComplete = hasCompleteDependencyMetadata(ledger);

  for (const { location, record } of iterateInstalledScopeRecords(ledger)) {
    const dependentLocation = normalizePluginLocation(location);
    const dependentKey = serializePluginLocation(dependentLocation);

    for (const edge of record.dependencyEdges ?? []) {
      const normalizedEdge = createInstalledDependencyEdge(edge);
      const dependencyKey = serializePluginLocation(normalizedEdge.dependency);
      const bucket = incomingBuckets.get(dependencyKey) ?? new Map<string, IncomingDependencyReference>();
      const bucketEntryKey = `${dependentKey}\u0000${normalizedEdge.declaration.name}`;
      bucket.set(bucketEntryKey, {
        dependent: dependentLocation,
        declaration: normalizedEdge.declaration,
      });
      incomingBuckets.set(dependencyKey, bucket);
    }
  }

  const incomingDependentsByLocation = Object.fromEntries(
    [...incomingBuckets.entries()]
      .sort(([leftKey], [rightKey]) => compareStrings(leftKey, rightKey))
      .map(([locationKey, bucket]) => [
        locationKey,
        [...bucket.values()].sort((left, right) => (
          comparePluginLocations(left.dependent, right.dependent) ||
          compareDeclarations(left.declaration, right.declaration)
        )),
      ]),
  );

  return {
    dependencyMetadataComplete,
    incomingDependentsByLocation,
  };
}

export function canAutoCleanupScopeRecord<TCapabilitySnapshot>(options: {
  ledger: InstalledLedger;
  location: PluginLocation;
  record: InstalledScopeRecord<TCapabilitySnapshot>;
  incomingIndex?: IncomingDependencyIndex;
  trackingIdentityValid?: boolean;
}): boolean {
  if (options.ledger.ledgerState.status !== 'available') {
    return false;
  }

  if (options.trackingIdentityValid === false) {
    return false;
  }

  const incomingIndex = options.incomingIndex ?? buildIncomingDependencyIndex(options.ledger);
  if (!incomingIndex.dependencyMetadataComplete) {
    return false;
  }

  const installSource = options.record.installSource;
  if (
    !installSource ||
    installSource.kind !== 'dependency' ||
    installSource.explicitlyRequested !== false ||
    installSource.allowsUnusedCleanup !== true
  ) {
    return false;
  }

  const key = serializePluginLocation(options.location);
  return (incomingIndex.incomingDependentsByLocation[key] ?? []).length === 0;
}

export function findAutoCleanupCandidates(
  ledger: InstalledLedger,
  options: AutoCleanupCandidateOptions = {},
): PluginLocation[] {
  const incomingIndex = options.incomingIndex ?? buildIncomingDependencyIndex(ledger);
  if (ledger.ledgerState.status !== 'available' || !incomingIndex.dependencyMetadataComplete) {
    return [];
  }

  const candidates: PluginLocation[] = [];

  for (const { location, record } of iterateInstalledScopeRecords(ledger)) {
    const trackingIdentityValid = options.trackingIdentityByLocation?.[serializePluginLocation(location)];
    if (!canAutoCleanupScopeRecord({
      ledger,
      location,
      record,
      incomingIndex,
      trackingIdentityValid,
    })) {
      continue;
    }

    candidates.push(normalizePluginLocation(location));
  }

  return candidates.sort(comparePluginLocations);
}

export function createTrackingIdentityIndex(
  entries: Array<{ location: PluginLocation; valid: boolean }>,
): Record<string, boolean> {
  return Object.fromEntries(
    entries.map((entry) => [serializePluginLocation(entry.location), entry.valid]),
  );
}

export function locationFromParts(options: {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string | null;
}): PluginLocation {
  return normalizePluginLocation({
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    projectKey: options.scope === 'user' ? null : (options.projectKey ?? null),
  });
}
