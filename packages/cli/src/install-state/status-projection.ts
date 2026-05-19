import path from 'node:path';

import type { PluginLocation } from './types.js';
import type { InstallEvidence, RecordArtifactEvidence } from './evidence.js';
import { parseCodexConfig } from '../utils/codex-config.js';
import { createGeneratedArtifactContentDigest } from '../utils/generated-artifacts.js';
import { compareStrictSemVerFields } from '../utils/manifest.js';

export type ProjectInstallStateKind =
  | 'installed'
  | 'needsRepair'
  | 'adoptable'
  | 'residual'
  | 'externallyManaged'
  | 'notInstalled';

export interface ProjectInstallIssue {
  code:
    | 'installRecordInvalid'
    | 'nativeTransactionPresent'
    | 'artifactMissing'
    | 'staticContentDrift'
    | 'dynamicContentDrift'
    | 'dynamicConfigStale'
    | 'dynamicRefreshFailed'
    | 'historicalLifecycleUnavailable'
    | 'dependencyMissing'
    | 'projectSharedIdentityUnavailable'
    | 'nativeEvidenceMissing'
    | 'catalogVersionMismatch'
    | 'catalogVersionNonCompliant';
  artifactPath?: string;
  dependency?: PluginLocation;
  detail?: string;
}

export interface ProjectInstallStateProjection {
  kind: ProjectInstallStateKind;
  issues: ProjectInstallIssue[];
  installRecordPresent: boolean;
  projectInstallState: ProjectInstallStateKind;
  catalogDrift: boolean;
  catalogLatestBlockedByCli: boolean;
  upgradeAvailable: boolean;
  dynamicDiagnosticUnavailable: boolean;
  dependencyIndexTrusted: boolean;
  dependencyIndexCoverageTrusted: boolean;
  dependencyIndexCoverageReasons: string[];
  dependencyIndexVerifiedLocations: PluginLocation[];
  dependencyIndexRevisitProjectLocations: PluginLocation[];
  dependencyIndexRecoverySuggestion: string | null;
  dependents: PluginLocation[];
  autoInstalled: boolean;
  unusedDependencyHint: boolean;
  repairAvailable: boolean;
  cleanupAvailable: boolean;
  adoptExistingAvailable: boolean;
  sharedRuntimeOwnerPresent: boolean;
  sharedRuntimeNeedsTakeover: boolean;
  nativeTransactionPresent: boolean;
  nativeTransactionKind: InstallEvidence['nativeTransaction']['classification'];
}

export function isCodexUserConfigOnlyResidueCleanupCandidate(
  evidence: InstallEvidence,
): boolean {
  const codexNative = evidence.platform.codexNative;
  return (
    isCodexUserNativeResidueCleanupCandidate(evidence) &&
    codexNative !== null &&
    codexNative.configEntryPresent &&
    codexNative.pluginEnabled === true &&
    !codexNative.installedManifestPresent &&
    !codexNative.activeCachePresent
  );
}

export function isCodexUserNativeResidueCleanupCandidate(
  evidence: InstallEvidence,
): boolean {
  const codexNative = evidence.platform.codexNative;
  return (
    evidence.location.platform === 'codex' &&
    evidence.location.scope === 'user' &&
    !evidence.installRecord.present &&
    !evidence.nativeTransaction.present &&
    codexNative !== null &&
    codexNative.pluginEnabled === true &&
    !evidence.residualEvidence.privateStatePresent &&
    !evidence.residualEvidence.repoVisibleArtifactPresent &&
    !evidence.residualEvidence.sharedIdentityPresent &&
    !evidence.residualEvidence.historicalLifecyclePresent &&
    !evidence.residualEvidence.nativeMarkerPresent &&
    !evidence.residualEvidence.sharedOwnerPresent
  );
}

function canExposeCodexUserNativeResidueCleanup(
  evidence: InstallEvidence,
): boolean {
  if (!isCodexUserNativeResidueCleanupCandidate(evidence)) {
    return false;
  }

  return !hasVerifiedDependents(evidence);
}

function hasVerifiedDependents(evidence: InstallEvidence): boolean {
  return evidence.dependencyIndex.projection.dependents.length > 0;
}

function addArtifactIssue(
  issues: ProjectInstallIssue[],
  code: ProjectInstallIssue['code'],
  artifact: RecordArtifactEvidence,
  detail?: string,
): void {
  issues.push({
    code,
    artifactPath: artifact.files[0]?.path,
    ...(detail ? { detail } : {}),
  });
}

function computeCodexSkillTreeDigest(
  artifact: RecordArtifactEvidence,
): string | null {
  if (artifact.artifact.target !== 'codex.skill') {
    return artifact.files[0]?.contentDigest ?? null;
  }

  const rootPath = artifact.artifact.path;
  const files = artifact.files
    .filter((file) => file.path !== rootPath && file.exists && file.rawContent !== null)
    .map((file) => [
      path.relative(rootPath, file.path).split(path.sep).join('/'),
      file.rawContent,
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  if (files.length === 0) {
    return null;
  }

  return createGeneratedArtifactContentDigest(Object.fromEntries(files));
}

function findRawArtifactFile(
  artifact: RecordArtifactEvidence,
  filePath: string,
): RecordArtifactEvidence['files'][number] | null {
  const normalizedPath = path.normalize(filePath);
  return artifact.files.find((file) => path.normalize(file.path) === normalizedPath) ?? null;
}

function createCodexAgentRoleDriftDigest(options: {
  roleKey: string;
  reason: string;
  roleLayerExists: boolean;
  registrationExists: boolean;
  registrationConfigFile?: string;
}): string {
  return createGeneratedArtifactContentDigest({
    target: 'codex.agentRole',
    state: 'drifted',
    roleKey: options.roleKey,
    reason: options.reason,
    roleLayerExists: options.roleLayerExists,
    registrationExists: options.registrationExists,
    registrationConfigFile: options.registrationConfigFile ?? null,
  });
}

function computeCodexAgentRoleDigest(
  artifact: RecordArtifactEvidence,
): string | null {
  const roleKey = artifact.artifact.roleKey?.trim() || artifact.artifact.artifactKey?.trim();
  if (!roleKey) {
    return null;
  }

  const roleFile = findRawArtifactFile(artifact, artifact.artifact.path);
  const configFile = artifact.files.find((file) =>
    path.normalize(file.path) !== path.normalize(artifact.artifact.path) &&
    path.basename(file.path) === 'config.toml'
  );
  let registration: ReturnType<typeof parseCodexConfig>['agents'][string] | undefined;
  let registrationParseFailed = false;
  if (configFile?.rawContent !== null && configFile?.rawContent !== undefined) {
    try {
      registration = parseCodexConfig(configFile.rawContent).agents[roleKey];
    } catch {
      registrationParseFailed = true;
    }
  }

  if (artifact.artifact.state === 'disabled') {
    const roleLayerStillExists = Boolean(roleFile?.exists);
    const registrationStillExists = registration !== undefined;
    if (!roleLayerStillExists && !registrationStillExists && !registrationParseFailed) {
      return null;
    }
    return createCodexAgentRoleDriftDigest({
      roleKey,
      reason: registrationParseFailed ? 'cleanupRegistrationUnreadable' : 'disabledCleanupIncomplete',
      roleLayerExists: roleLayerStillExists,
      registrationExists: registrationStillExists,
      registrationConfigFile: registration?.configFile,
    });
  }

  if (
    roleFile?.rawContent === null ||
    roleFile?.rawContent === undefined ||
    configFile?.rawContent === null ||
    configFile?.rawContent === undefined
  ) {
    return null;
  }

  if (registrationParseFailed || !registration) {
    return createCodexAgentRoleDriftDigest({
      roleKey,
      reason: registrationParseFailed ? 'registrationUnreadable' : 'registrationMissing',
      roleLayerExists: Boolean(roleFile.exists),
      registrationExists: Boolean(registration),
    });
  }

  const registeredRoleLayerPath = registration.configFile
    ? path.normalize(path.resolve(path.dirname(configFile.path), registration.configFile))
    : null;
  const expectedRoleLayerPath = path.normalize(artifact.artifact.path);
  if (registeredRoleLayerPath !== expectedRoleLayerPath) {
    return createCodexAgentRoleDriftDigest({
      roleKey,
      reason: registeredRoleLayerPath ? 'registrationRetargeted' : 'registrationConfigFileMissing',
      roleLayerExists: Boolean(roleFile.exists),
      registrationExists: true,
      registrationConfigFile: registration.configFile,
    });
  }

  return createGeneratedArtifactContentDigest({
    target: artifact.artifact.target,
    state: 'present',
    roleKey,
    registration: {
      description: registration.description?.trim(),
    },
    roleFile: roleFile.rawContent,
  });
}

function computeDynamicArtifactDigest(
  artifact: RecordArtifactEvidence,
): string | null {
  if (artifact.artifact.target === 'codex.skill') {
    return computeCodexSkillTreeDigest(artifact);
  }
  if (artifact.artifact.target === 'codex.agentRole') {
    return computeCodexAgentRoleDigest(artifact);
  }
  return artifact.files[0]?.contentDigest ?? null;
}

function collectRecordIssues(evidence: InstallEvidence): ProjectInstallIssue[] {
  const issues: ProjectInstallIssue[] = [];

  if (evidence.nativeTransaction.present) {
    issues.push({
      code: 'nativeTransactionPresent',
      detail: evidence.nativeTransaction.classification,
    });
  }

  if (
    evidence.location.scope === 'project'
    && evidence.projectSharedIdentity.attempted
    && evidence.projectSharedIdentity.read
    && evidence.projectSharedIdentity.read.status !== 'ok'
  ) {
    issues.push({
      code: 'projectSharedIdentityUnavailable',
      detail: evidence.projectSharedIdentity.read.code,
    });
  }

  for (const artifact of evidence.installRecord.artifacts) {
    const isDynamicArtifact = artifact.artifact.id !== undefined && artifact.artifact.target !== undefined;
    const removedFromCurrentDynamicPlan = Boolean(
      isDynamicArtifact &&
      evidence.currentCatalog.provided &&
      evidence.installRecord.sameBundleAsCatalog === true &&
      !artifact.matchedCurrentDynamicArtifact,
    );
    if (removedFromCurrentDynamicPlan) {
      continue;
    }

    const disabledByDynamicEntry = artifact.matchedDynamicEntry?.state === 'disabled';
    const missingFiles = artifact.files.filter((file) => !file.exists);
    if (!disabledByDynamicEntry && missingFiles.length > 0) {
      addArtifactIssue(issues, 'artifactMissing', artifact);
      continue;
    }

    if (artifact.matchedDynamicEntry) {
      const acceptedDigest = artifact.matchedDynamicEntry.contentDigest;
      const actualDigest = computeDynamicArtifactDigest(artifact);
      if (acceptedDigest && actualDigest && acceptedDigest !== actualDigest) {
        addArtifactIssue(issues, 'dynamicContentDrift', artifact);
      }

      if (
        evidence.location.scope === 'project'
        && evidence.dynamicDiagnostic.available
        && evidence.dynamicDiagnostic.entries.some((entry) =>
          entry.matchedRecordArtifact?.artifact.path === artifact.artifact.path
          && entry.entry.configDigest
          && evidence.currentCatalog.provided
        )
      ) {
        const matchedEntry = evidence.dynamicDiagnostic.entries.find((entry) =>
          entry.matchedRecordArtifact?.artifact.path === artifact.artifact.path,
        )?.entry;
        const projectSharedRenderConfigDigest = evidence.currentCatalog.dynamicArtifacts.find((entry) =>
          entry.id === matchedEntry?.id
          && entry.target === matchedEntry?.target,
        )?.configDigest;
        if (
          matchedEntry?.configDigest
          && projectSharedRenderConfigDigest
          && matchedEntry.configDigest !== projectSharedRenderConfigDigest
        ) {
          addArtifactIssue(issues, 'dynamicConfigStale', artifact);
        }
      }

      if (artifact.matchedDynamicEntry.lastRefresh?.status === 'failed') {
        addArtifactIssue(
          issues,
          'dynamicRefreshFailed',
          artifact,
          artifact.matchedDynamicEntry.lastRefresh.error,
        );
      }
      continue;
    }

    const actualDigest = artifact.artifact.target === 'codex.skill'
      ? computeCodexSkillTreeDigest(artifact)
      : artifact.files[0]?.contentDigest ?? null;
    const staticDigest =
      (evidence.installRecord.sameBundleAsCatalog
        ? artifact.matchedCatalogArtifact?.contentDigest
        : null)
      ?? artifact.matchedIdentityArtifact?.artifact.contentDigest
      ?? null;
    if (staticDigest && actualDigest && staticDigest !== actualDigest) {
      addArtifactIssue(issues, 'staticContentDrift', artifact);
    }
  }

  if (evidence.historicalLifecycle.expected && !evidence.historicalLifecycle.healthy) {
    issues.push({
      code: 'historicalLifecycleUnavailable',
      detail: evidence.historicalLifecycle.path ?? undefined,
    });
  }

  for (const dependency of evidence.dependencyIndex.projection.dependencyHealth) {
    if (dependency.status !== 'ok') {
      issues.push({
        code: 'dependencyMissing',
        dependency: dependency.dependency,
        detail: dependency.status,
      });
    }
  }

  if (
    evidence.platform.codexNative
    && evidence.installRecord.present
    && evidence.installRecord.read.status === 'ok'
    && evidence.installRecord.read.value.record.native?.installedByAw
    && !evidence.platform.codexNative.minimumSatisfied
  ) {
    issues.push({
      code: 'nativeEvidenceMissing',
      detail: evidence.platform.codexNative.pluginId,
    });
  }

  return issues;
}

function collectCatalogVersionIssues(evidence: InstallEvidence): ProjectInstallIssue[] {
  const currentCatalogSource = evidence.currentCatalog.source;
  if (!evidence.installRecord.present || !currentCatalogSource) {
    return [];
  }

  const installedSource = evidence.installRecord.read.status === 'ok'
    ? evidence.installRecord.read.value.record.source
    : null;
  const installedVersion = installedSource?.pluginVersion ?? null;
  if (!installedVersion) {
    return [];
  }

  const sameArtifactIdentity =
    installedSource?.manifestDigest === currentCatalogSource.manifestDigest &&
    installedSource?.bundleFingerprint === currentCatalogSource.bundleFingerprint;
  if (sameArtifactIdentity) {
    // Older records can carry stale version metadata while still pointing at the same accepted artifact.
    return [];
  }

  const comparison = compareStrictSemVerFields({
    left: {
      value: currentCatalogSource.pluginVersion,
      fieldPath: 'current catalog source.pluginVersion',
    },
    right: {
      value: installedVersion,
      fieldPath: 'install record source.pluginVersion',
    },
  });
  if (comparison.kind === 'invalid') {
    return [{
      code: 'catalogVersionNonCompliant',
      detail: comparison.issues.map((issue) => issue.message).join(' '),
    }];
  }

  if (comparison.relation < 0) {
    return [{
      code: 'catalogVersionMismatch',
      detail: `current catalog version ${comparison.left.raw} is lower than installed version ${comparison.right.raw}.`,
    }];
  }

  return [];
}

export function projectInstallState(
  evidence: InstallEvidence,
  options: {
    catalogLatestBlockedByCli?: boolean;
  } = {},
): ProjectInstallStateProjection {
  const installRecordPresent = evidence.installRecord.present;
  const issues: ProjectInstallIssue[] = [];

  if (!installRecordPresent && evidence.installRecord.read.status !== 'missing') {
    issues.push({
      code: 'installRecordInvalid',
      detail: 'code' in evidence.installRecord.read ? evidence.installRecord.read.code : evidence.installRecord.read.status,
    });
  }

  const recordIssues = installRecordPresent ? collectRecordIssues(evidence) : [];
  issues.push(...recordIssues);
  issues.push(...collectCatalogVersionIssues(evidence));

  let kind: ProjectInstallStateKind;
  if (installRecordPresent) {
    kind = issues.length > 0 ? 'needsRepair' : 'installed';
  } else if (issues.length > 0) {
    kind = 'needsRepair';
  } else if (evidence.adoptable.possible) {
    kind = 'adoptable';
  } else if (
    evidence.residualEvidence.privateStatePresent
    || evidence.residualEvidence.repoVisibleArtifactPresent
    || evidence.residualEvidence.sharedIdentityPresent
    || evidence.residualEvidence.historicalLifecyclePresent
    || evidence.residualEvidence.nativeMarkerPresent
    || evidence.residualEvidence.sharedOwnerPresent
  ) {
    kind = 'residual';
  } else if (evidence.platform.codexNative?.anyNativeEvidence) {
    kind = 'externallyManaged';
  } else {
    kind = 'notInstalled';
  }

  const currentCatalogSource = evidence.currentCatalog.source;
  const installedVersion = evidence.installRecord.read.status === 'ok'
    ? evidence.installRecord.read.value.record.source.pluginVersion
    : null;
  const currentVersionComparison =
    currentCatalogSource && installedVersion
      ? (() => {
          const comparison = compareStrictSemVerFields({
            left: {
              value: currentCatalogSource.pluginVersion,
              fieldPath: 'current catalog source.pluginVersion',
            },
            right: {
              value: installedVersion,
              fieldPath: 'install record source.pluginVersion',
            },
          });
          return comparison.kind === 'ordered' ? comparison.relation : null;
        })()
      : null;

  return {
    kind,
    issues,
    installRecordPresent,
    projectInstallState: kind,
    catalogDrift: evidence.installRecord.sourceDrift || evidence.projectSharedIdentity.sourceDrift,
    catalogLatestBlockedByCli: options.catalogLatestBlockedByCli === true,
    upgradeAvailable:
      options.catalogLatestBlockedByCli !== true &&
      currentVersionComparison !== null &&
      currentVersionComparison > 0,
    dynamicDiagnosticUnavailable: evidence.dynamicDiagnostic.dynamicDiagnosticUnavailable,
    dependencyIndexTrusted: evidence.dependencyIndex.projection.coverage.trusted,
    dependencyIndexCoverageTrusted: evidence.dependencyIndex.projection.coverage.coverageTrusted,
    dependencyIndexCoverageReasons: evidence.dependencyIndex.projection.coverage.reasons,
    dependencyIndexVerifiedLocations: evidence.dependencyIndex.projection.coverage.verifiedLocations,
    dependencyIndexRevisitProjectLocations: evidence.dependencyIndex.projection.coverage.revisitProjectLocations,
    dependencyIndexRecoverySuggestion: evidence.dependencyIndex.projection.coverage.recoverySuggestion,
    dependents: evidence.dependencyIndex.projection.dependents,
    autoInstalled: evidence.dependencyIndex.projection.autoInstalled,
    unusedDependencyHint: evidence.dependencyIndex.projection.unusedDependencyHint,
    repairAvailable: installRecordPresent || evidence.nativeTransaction.present,
    cleanupAvailable:
      (
        (kind === 'needsRepair' || kind === 'residual')
        && !hasVerifiedDependents(evidence)
      ) ||
      canExposeCodexUserNativeResidueCleanup(evidence),
    adoptExistingAvailable: kind === 'adoptable',
    sharedRuntimeOwnerPresent: evidence.sharedRuntimeOwner.read.status === 'ok',
    sharedRuntimeNeedsTakeover: evidence.sharedRuntimeOwner.needsTakeover,
    nativeTransactionPresent: evidence.nativeTransaction.present,
    nativeTransactionKind: evidence.nativeTransaction.classification,
  };
}
