import path from 'node:path';

import type { PluginLocation } from './types.js';
import type { InstallEvidence, RecordArtifactEvidence } from './evidence.js';
import { createGeneratedArtifactContentDigest } from '../utils/generated-artifacts.js';

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
    | 'nativeEvidenceMissing';
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
      const actualDigest = computeCodexSkillTreeDigest(artifact);
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

    const actualDigest = computeCodexSkillTreeDigest(artifact);
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

export function projectInstallState(
  evidence: InstallEvidence,
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

  return {
    kind,
    issues,
    installRecordPresent,
    projectInstallState: kind,
    catalogDrift: evidence.installRecord.sourceDrift || evidence.projectSharedIdentity.sourceDrift,
    upgradeAvailable: evidence.installRecord.sourceDrift || evidence.projectSharedIdentity.sourceDrift,
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
