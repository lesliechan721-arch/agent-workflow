import path from 'node:path';

import type { PluginLocation } from './types.js';
import type { InstallEvidence, RecordArtifactEvidence } from './evidence.js';
import { parseCodexConfig } from '../utils/codex-config.js';
import { createDynamicSkillTreeContentDigest } from '../utils/dynamic-skill-tree.js';
import { createGeneratedArtifactContentDigest } from '../utils/generated-artifacts.js';
import { compareStrictSemVerFields } from '../utils/manifest.js';

export type ProjectInstallStateKind =
  | 'installed'
  | 'cleanupRequired'
  | 'external'
  | 'notInstalled';

export type ProjectInstallStateReasonCode =
  | 'foreignExternalEvidence'
  | 'claimableProjectArtifacts'
  | 'invalidInstallRecord'
  | 'nativeTransactionPresent'
  | 'awOwnedResiduePresent'
  | 'historicalRuntimeResidue'
  | 'dependencyIndexReferenceResidue'
  | 'sharedRuntimeOwnerResidue';

export interface ProjectInstallStateReason {
  code: ProjectInstallStateReasonCode;
  detail?: string;
  path?: string;
}

export interface ProjectInstallStateDiagnostic {
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
    | 'dynamicDiagnosticUnavailable'
    | 'dependencyIndexCoverageUntrusted'
    | 'sharedRuntimeOwnerResidue'
    | 'nativeEvidenceMissing'
    | 'catalogVersionMismatch'
    | 'catalogVersionNonCompliant'
    | ProjectInstallStateReasonCode;
  artifactPath?: string;
  dependency?: PluginLocation;
  detail?: string;
  path?: string;
}

// Transitional alias while phase 2+ callers migrate to diagnostics.
export type ProjectInstallIssue = ProjectInstallStateDiagnostic;

export interface ProjectInstallStateProjection {
  kind: ProjectInstallStateKind;
  reasons: ProjectInstallStateReason[];
  reasonCodes: ProjectInstallStateReasonCode[];
  diagnostics: ProjectInstallStateDiagnostic[];
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
  cleanupAvailable: boolean;
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
  issues: ProjectInstallStateDiagnostic[],
  code: ProjectInstallStateDiagnostic['code'],
  artifact: RecordArtifactEvidence,
  detail?: string,
): void {
  issues.push({
    code,
    artifactPath: artifact.files[0]?.path,
    ...(detail ? { detail } : {}),
  });
}

function computeDynamicSkillTreeDigest(
  artifact: RecordArtifactEvidence,
): string | null {
  if (artifact.artifact.target !== 'codex.skill' && artifact.artifact.target !== 'claude.skill') {
    return artifact.files[0]?.contentDigest ?? null;
  }

  const rootPath = artifact.artifact.path;
  const treeErrors = artifact.files
    .filter((file) => file.treeError)
    .map((file) => ({
      path: path.relative(rootPath, file.path).split(path.sep).join('/') || '.',
      error: file.treeError,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (treeErrors.length > 0) {
    return createDynamicSkillTreeContentDigest({
      skillKey: artifact.artifact.artifactKey ?? path.basename(rootPath),
      files: {
        '__aw_invalid_skill_tree__': Buffer.from(JSON.stringify(treeErrors), 'utf8'),
      },
    });
  }
  const files = artifact.files
    .filter((file) => file.path !== rootPath && file.exists && file.rawBytes !== null)
    .map((file) => [
      path.relative(rootPath, file.path).split(path.sep).join('/'),
      file.rawBytes!,
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  if (files.length === 0) {
    return artifact.artifact.state === 'present'
      ? createDynamicSkillTreeContentDigest({
          skillKey: artifact.artifact.artifactKey ?? path.basename(rootPath),
          files: {},
        })
      : null;
  }

  return createDynamicSkillTreeContentDigest({
    skillKey: artifact.artifact.artifactKey ?? path.basename(rootPath),
    files: Object.fromEntries(files),
  });
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
    return computeDynamicSkillTreeDigest(artifact);
  }
  if (artifact.artifact.target === 'claude.skill') {
    return computeDynamicSkillTreeDigest(artifact);
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

    const actualDigest = artifact.artifact.target === 'codex.skill' || artifact.artifact.target === 'claude.skill'
      ? computeDynamicSkillTreeDigest(artifact)
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

function collectInstalledDiagnostics(evidence: InstallEvidence): ProjectInstallStateDiagnostic[] {
  const diagnostics = collectRecordIssues(evidence);

  if (!evidence.dynamicDiagnostic.available && evidence.dynamicDiagnostic.unavailableReason) {
    diagnostics.push({
      code: 'dynamicDiagnosticUnavailable',
      detail: evidence.dynamicDiagnostic.unavailableReason,
      path: evidence.dynamicDiagnostic.read?.path,
    });
  }

  if (!evidence.dependencyIndex.projection.coverage.coverageTrusted) {
    diagnostics.push({
      code: 'dependencyIndexCoverageUntrusted',
      detail: evidence.dependencyIndex.projection.coverage.reasons.join(','),
      path: evidence.dependencyIndex.inspection.path,
    });
  }

  if (
    evidence.sharedRuntimeOwner.read.status === 'ok'
    && !evidence.sharedRuntimeOwner.ownerMatchesTarget
  ) {
    diagnostics.push({
      code: 'sharedRuntimeOwnerResidue',
      detail: evidence.sharedRuntimeOwner.read.value.ownerRecordPath,
      path: evidence.sharedRuntimeOwner.read.path,
    });
  }

  return diagnostics;
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

function pushReason(
  reasons: ProjectInstallStateReason[],
  code: ProjectInstallStateReasonCode,
  detail?: string,
  path?: string,
): void {
  reasons.push({
    code,
    ...(detail ? { detail } : {}),
    ...(path ? { path } : {}),
  });
}

function pushDiagnosticFromReason(
  diagnostics: ProjectInstallStateDiagnostic[],
  code: ProjectInstallStateReasonCode,
  detail?: string,
  path?: string,
): void {
  diagnostics.push({
    code,
    ...(detail ? { detail } : {}),
    ...(path ? { path } : {}),
  });
}

export function projectInstallState(
  evidence: InstallEvidence,
  options: {
    catalogLatestBlockedByCli?: boolean;
  } = {},
): ProjectInstallStateProjection {
  const installRecordPresent = evidence.installRecord.present;
  const diagnostics: ProjectInstallStateDiagnostic[] = [];
  const reasons: ProjectInstallStateReason[] = [];

  let kind: ProjectInstallStateKind = 'notInstalled';

  if (installRecordPresent) {
    kind = 'installed';
    diagnostics.push(...collectInstalledDiagnostics(evidence));
    diagnostics.push(...collectCatalogVersionIssues(evidence));
  } else {
    if (evidence.platform.codexNative?.anyNativeEvidence) {
      kind = 'external';
      pushReason(
        reasons,
        'foreignExternalEvidence',
        evidence.platform.codexNative.pluginId,
        evidence.platform.codexNative.configPath,
      );
    }

    if (evidence.installRecord.read.status !== 'missing') {
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(
          reasons,
          'invalidInstallRecord',
          'code' in evidence.installRecord.read ? evidence.installRecord.read.code : evidence.installRecord.read.status,
          evidence.installRecord.read.path,
        );
      } else {
        pushDiagnosticFromReason(
          diagnostics,
          'invalidInstallRecord',
          'code' in evidence.installRecord.read ? evidence.installRecord.read.code : evidence.installRecord.read.status,
          evidence.installRecord.read.path,
        );
      }
    }

    const nativeTransactionResidual =
      evidence.nativeTransaction.present
      || evidence.nativeTransaction.read.status !== 'missing';
    if (nativeTransactionResidual) {
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(
          reasons,
          'nativeTransactionPresent',
          evidence.nativeTransaction.read.status === 'ok'
            ? evidence.nativeTransaction.classification
            : evidence.nativeTransaction.read.code,
          evidence.nativeTransaction.read.path,
        );
      } else {
        pushDiagnosticFromReason(
          diagnostics,
          'nativeTransactionPresent',
          evidence.nativeTransaction.read.status === 'ok'
            ? evidence.nativeTransaction.classification
            : evidence.nativeTransaction.read.code,
          evidence.nativeTransaction.read.path,
        );
      }
    }

    const awOwnedResiduePresent =
      (
        evidence.dynamicDiagnostic.read !== null
        && evidence.dynamicDiagnostic.unavailableReason !== 'missing'
      )
      || (
        evidence.projectSharedIdentity.read !== null
        && evidence.projectSharedIdentity.read.status !== 'missing'
        && !evidence.adoptable.possible
      )
      || (
        evidence.residualEvidence.repoVisibleArtifactPresent
        && !evidence.adoptable.possible
      )
      || evidence.residualEvidence.privateStatePresent;
    if (awOwnedResiduePresent) {
      const residuePath = evidence.dynamicDiagnostic.read?.path ?? evidence.projectSharedIdentity.read?.path ?? undefined;
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(reasons, 'awOwnedResiduePresent', undefined, residuePath);
      } else {
        pushDiagnosticFromReason(diagnostics, 'awOwnedResiduePresent', undefined, residuePath);
      }
    }

    if (evidence.historicalLifecycle.residuePresent) {
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(
          reasons,
          'historicalRuntimeResidue',
          evidence.historicalLifecycle.path ?? undefined,
          evidence.historicalLifecycle.path ?? undefined,
        );
      } else {
        pushDiagnosticFromReason(
          diagnostics,
          'historicalRuntimeResidue',
          evidence.historicalLifecycle.path ?? undefined,
          evidence.historicalLifecycle.path ?? undefined,
        );
      }
    }

    if (evidence.dependencyIndex.projection.currentLocationReferenceResidue) {
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(
          reasons,
          'dependencyIndexReferenceResidue',
          evidence.dependencyIndex.projection.currentLocationReferenceStatuses.join(','),
          evidence.dependencyIndex.inspection.path,
        );
      } else {
        pushDiagnosticFromReason(
          diagnostics,
          'dependencyIndexReferenceResidue',
          evidence.dependencyIndex.projection.currentLocationReferenceStatuses.join(','),
          evidence.dependencyIndex.inspection.path,
        );
      }
    }

    const sharedOwnerResidual = evidence.sharedRuntimeOwner.read.status !== 'missing'
      && (
        evidence.residualEvidence.sharedOwnerPresent
        || evidence.sharedRuntimeOwner.read.status !== 'ok'
      );
    if (sharedOwnerResidual) {
      const detail = evidence.sharedRuntimeOwner.read.status === 'ok'
        ? evidence.sharedRuntimeOwner.read.value.ownerRecordPath
        : evidence.sharedRuntimeOwner.read.code;
      if (kind !== 'external') {
        kind = 'cleanupRequired';
        pushReason(
          reasons,
          'sharedRuntimeOwnerResidue',
          detail,
          evidence.sharedRuntimeOwner.read.path,
        );
      } else {
        pushDiagnosticFromReason(
          diagnostics,
          'sharedRuntimeOwnerResidue',
          detail,
          evidence.sharedRuntimeOwner.read.path,
        );
      }
    }

    if (kind === 'notInstalled' && evidence.adoptable.possible) {
      kind = 'external';
      pushReason(
        reasons,
        'claimableProjectArtifacts',
        evidence.adoptable.source,
        evidence.projectSharedIdentity.read?.status === 'ok'
          ? evidence.projectSharedIdentity.read.path
          : undefined,
      );
    }

    if (kind === 'external' && evidence.platform.codexNative?.anyNativeEvidence) {
      if (evidence.installRecord.read.status !== 'missing') {
        pushDiagnosticFromReason(
          diagnostics,
          'invalidInstallRecord',
          'code' in evidence.installRecord.read ? evidence.installRecord.read.code : evidence.installRecord.read.status,
          evidence.installRecord.read.path,
        );
      }
      if (evidence.nativeTransaction.present) {
        pushDiagnosticFromReason(
          diagnostics,
          'nativeTransactionPresent',
          evidence.nativeTransaction.classification,
          evidence.nativeTransaction.read.path,
        );
      } else if (
        evidence.nativeTransaction.read.status !== 'missing' &&
        evidence.nativeTransaction.read.status !== 'ok'
      ) {
        pushDiagnosticFromReason(
          diagnostics,
          'nativeTransactionPresent',
          evidence.nativeTransaction.read.code,
          evidence.nativeTransaction.read.path,
        );
      }
      if (awOwnedResiduePresent) {
        pushDiagnosticFromReason(
          diagnostics,
          'awOwnedResiduePresent',
          undefined,
          evidence.dynamicDiagnostic.read?.path ?? evidence.projectSharedIdentity.read?.path ?? undefined,
        );
      }
      if (evidence.historicalLifecycle.residuePresent) {
        pushDiagnosticFromReason(
          diagnostics,
          'historicalRuntimeResidue',
          evidence.historicalLifecycle.path ?? undefined,
          evidence.historicalLifecycle.path ?? undefined,
        );
      }
      if (evidence.dependencyIndex.projection.currentLocationReferenceResidue) {
        pushDiagnosticFromReason(
          diagnostics,
          'dependencyIndexReferenceResidue',
          evidence.dependencyIndex.projection.currentLocationReferenceStatuses.join(','),
          evidence.dependencyIndex.inspection.path,
        );
      }
      if (sharedOwnerResidual) {
        pushDiagnosticFromReason(
          diagnostics,
          'sharedRuntimeOwnerResidue',
          evidence.sharedRuntimeOwner.read.status === 'ok'
            ? evidence.sharedRuntimeOwner.read.value.ownerRecordPath
            : evidence.sharedRuntimeOwner.read.code,
          evidence.sharedRuntimeOwner.read.path,
        );
      }
    }
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
    reasons,
    reasonCodes: [...new Set(reasons.map((reason) => reason.code))],
    diagnostics,
    issues: diagnostics,
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
    cleanupAvailable:
      (
        kind === 'cleanupRequired'
        && !hasVerifiedDependents(evidence)
      ) ||
      canExposeCodexUserNativeResidueCleanup(evidence),
    nativeTransactionPresent: evidence.nativeTransaction.present,
    nativeTransactionKind: evidence.nativeTransaction.classification,
  };
}
