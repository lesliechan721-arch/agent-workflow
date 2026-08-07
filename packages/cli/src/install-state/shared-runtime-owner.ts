import path from 'node:path';

import fs from 'fs-extra';

import type {
  PlatformName,
  PluginLocation as DependencyGraphPluginLocation,
  PluginMeta,
  SkillTriggerPreference,
} from '../types.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveEffectiveSkillTriggerPreferences } from '../utils/plugin-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
import {
  assessSharedSkillTriggerRuntimeSemantics,
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
  resolveSkillTriggerPolicies,
  rollbackMaterializedSkillTriggerPreference,
  type SharedSkillTriggerRuntimeSemanticsAssessment,
  type SkillTriggerMaterializationMode,
  type SkillTriggerMaterializationResult,
  type SkillTriggerMaterializationTarget,
} from '../utils/skill-trigger-preferences.js';
import {
  inspectGlobalDependencyIndex,
  readInstallRecordFileAt,
  readSharedSkillTriggerRuntimeOwner,
} from './facade.js';
import { sha256Hex } from './internal.js';
import { getInstallStatePrivateRoot, getSharedSkillTriggerRuntimeOwnerPath } from './paths.js';
import {
  createSharedRuntimeOwnerDeleteStage,
  createSharedRuntimeOwnerWriteStage,
  type InstallStateReceiptWarning,
  type InstallStateTransactionStage,
} from './transactions.js';
import type {
  InstallRecordFile,
  InstallStateReadResult,
  PluginLocation,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';
import { serializePluginLocation } from '../utils/plugin-dependency-location.js';

export interface SharedSkillTriggerRuntimeOwnerInspection {
  ownerPath: string;
  read: InstallStateReadResult<SharedSkillTriggerRuntimeOwner>;
  digestVerified: boolean;
  ownerRecordRead: InstallStateReadResult<InstallRecordFile> | null;
  ownerRecordMatchesLocation: boolean;
  usable: boolean;
}

export type SharedSkillTriggerRuntimeOwnerAction =
  | 'none'
  | 'claim'
  | 'refresh'
  | 'reassign'
  | 'release';

export interface SharedSkillTriggerRuntimeTakeoverRequired {
  reason: 'foreignOwner' | 'unverifiedOwner' | 'invalidOwnerState';
  message: string;
  currentOwner?: PluginLocation;
}

export type SharedSkillTriggerRuntimeOwnerUpsertPlan =
  | {
    status: 'ok';
    assessment: SharedSkillTriggerRuntimeSemanticsAssessment;
    ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
    ownerAction: Exclude<SharedSkillTriggerRuntimeOwnerAction, 'release'>;
    shouldWriteOwner: boolean;
    shouldMaterializeRuntime: boolean;
  }
  | {
    status: 'takeoverRequired';
    assessment: SharedSkillTriggerRuntimeSemanticsAssessment;
    ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
    takeoverRequired: SharedSkillTriggerRuntimeTakeoverRequired;
  }
  | {
    status: 'takeoverNotAllowed';
    assessment: SharedSkillTriggerRuntimeSemanticsAssessment;
    ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
    takeoverRequired: SharedSkillTriggerRuntimeTakeoverRequired;
  };

export interface SharedSkillTriggerRuntimeRemovalPlan {
  assessment: SharedSkillTriggerRuntimeSemanticsAssessment;
  ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
  ownerAction: 'none' | 'release' | 'reassign';
  shouldDeleteOwner: boolean;
  nextOwner: {
    location: PluginLocation;
    preference: SkillTriggerPreference;
    recordFile: InstallRecordFile;
    recordPath: string;
  } | null;
  shouldWriteOwner: boolean;
  shouldMaterializeRuntime: boolean;
}

export interface SharedSkillTriggerRuntimeStageBundle {
  ownerAction: SharedSkillTriggerRuntimeOwnerAction;
  warnings: string[];
  stages: InstallStateTransactionStage[];
}

export type SharedSkillTriggerRuntimeReplayResult =
  | {
    status: 'replayed';
    source: 'owner';
    preference: SkillTriggerPreference;
    skillTriggerPreferences?: Record<string, SkillTriggerPreference>;
    ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
    warnings: string[];
    materialization: SkillTriggerMaterializationResult;
  }
  | {
    status: 'failClosed';
    failClosedCode:
      | 'ownerStateInvalid'
      | 'ownerUnverified'
      | 'ownerEffectiveConfigInvalid';
    failClosedReason: string;
    ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
    warnings: string[];
  };

function sameLocation(left: PluginLocation, right: PluginLocation): boolean {
  return left.plugin === right.plugin
    && left.platform === right.platform
    && left.scope === right.scope
    && (left.projectKey ?? null) === (right.projectKey ?? null);
}

function toDependencyGraphPluginLocation(location: PluginLocation): DependencyGraphPluginLocation {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.scope === 'project' ? (location.projectKey ?? null) : null,
  };
}

function isPathInside(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readBundlePluginManifestWithDefaultedCompatibility(options: {
  bundleRoot: string;
  manifestPath: string;
}): Promise<PluginMeta> {
  const rawManifest = await fs.readJson(options.manifestPath) as unknown;
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    throw new Error('historical manifest 不是对象');
  }
  const input = rawManifest as Record<string, unknown>;
  const pluginName = typeof input.name === 'string' && input.name.trim().length > 0
    ? input.name
    : path.basename(options.bundleRoot);
  const pluginVersion = typeof input.version === 'string' && input.version.trim().length > 0
    ? input.version
    : '0.0.0';
  const normalizedManifest = {
    ...input,
    name: pluginName,
    version: pluginVersion,
    description: typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description
      : `${pluginName} plugin`,
    compatibility: input.compatibility ?? {
      aw: {
        minVersion: '0.0.0',
      },
    },
    marketplace: input.marketplace && typeof input.marketplace === 'object' && !Array.isArray(input.marketplace)
      ? input.marketplace
      : {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
  };
  return {
    rootDir: options.bundleRoot,
    manifestPath: options.manifestPath,
    manifest: normalizedManifest as PluginMeta['manifest'],
  };
}

export type VerifiedHistoricalBundlePluginResult =
  | {
    status: 'ok';
    plugin: PluginMeta;
    bundleRoot: string;
    manifestPath: string;
  }
  | {
    status: 'invalid';
    reason: string;
  };

export async function loadVerifiedHistoricalBundlePlugin(options: {
  pluginName: string;
  pluginVersion: string;
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  sourceManifestDigest: string;
  bundleFingerprint: string;
}): Promise<VerifiedHistoricalBundlePluginResult> {
  let runtimeRoot: string;
  let bundleRoot: string;
  let manifestPath: string;
  try {
    runtimeRoot = await fs.realpath(options.runtimeRoot);
    bundleRoot = await fs.realpath(options.bundleRoot);
    manifestPath = await fs.realpath(options.manifestPath);
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical bundle 路径不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isPathInside(bundleRoot, runtimeRoot)) {
    return {
      status: 'invalid',
      reason: 'historical bundle root 不在 runtime root 内',
    };
  }
  if (!isPathInside(manifestPath, bundleRoot)) {
    return {
      status: 'invalid',
      reason: 'historical manifest path 不在 bundle root 内',
    };
  }

  try {
    const [manifestDigest, bundleFingerprint, plugin] = await Promise.all([
      calculateFileDigest(manifestPath),
      calculatePluginBundleFingerprint(bundleRoot),
      readBundlePluginManifestWithDefaultedCompatibility({
        bundleRoot,
        manifestPath,
      }),
    ]);
    if (bundleFingerprint !== options.bundleFingerprint) {
      return {
        status: 'invalid',
        reason: 'historical bundle fingerprint 与记录不一致',
      };
    }
    if (
      plugin.manifest.name !== options.pluginName ||
      plugin.manifest.version !== options.pluginVersion ||
      path.resolve(plugin.manifestPath) !== path.resolve(manifestPath)
    ) {
      return {
        status: 'invalid',
        reason: 'historical manifest identity 与记录不一致',
      };
    }
    if (manifestDigest !== options.sourceManifestDigest) {
      // Bundle fingerprint already anchors the full historical bundle. Some
      // legacy records may carry a stale manifest-only digest after bundle
      // normalization, but the stronger bundle-level match is still usable.
    }
    return {
      status: 'ok',
      plugin,
      bundleRoot,
      manifestPath,
    };
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical bundle 内容不可验证：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function locationFromRecord(recordFile: InstallRecordFile): PluginLocation {
  return {
    plugin: recordFile.record.pluginName,
    platform: recordFile.record.platform,
    scope: recordFile.record.scope,
    ...(recordFile.record.scope === 'project'
      ? { projectKey: recordFile.record.projectKey }
      : {}),
  };
}

function preferenceFromRecord(recordFile: InstallRecordFile): SkillTriggerPreference {
  return recordFile.record.options?.skillTriggerPreference ?? 'default';
}

function formatLocation(location: PluginLocation): string {
  return location.scope === 'project'
    ? `${location.platform}/${location.plugin} project:${location.projectKey ?? '(missing-project-key)'}`
    : `${location.platform}/${location.plugin} user`;
}

function formatOwnerInvalidReason(inspection: SharedSkillTriggerRuntimeOwnerInspection): string {
  if (inspection.read.status !== 'ok') {
    return `owner 状态不可读（${inspection.read.code}）`;
  }
  if (!inspection.digestVerified) {
    return 'owner record digest 不匹配';
  }
  if (inspection.ownerRecordRead?.status !== 'ok') {
    return `owner record 不可读（${inspection.ownerRecordRead?.code ?? 'missing'}）`;
  }
  if (!inspection.ownerRecordMatchesLocation) {
    return 'owner record location 与 owner 文件不一致';
  }
  return 'owner 状态不可验证';
}

function buildReplayFailClosedMessage(options: {
  pluginName: string;
  platform: PlatformName;
  detail: string;
  ownerLocation?: PluginLocation;
}): string {
  const ownerLabel = options.ownerLocation
    ? formatLocation(options.ownerLocation)
    : '当前冲突 owner';
  return `[${options.platform}/${options.pluginName}] ${options.detail}；shared runtime replay 已 fail closed。` +
    `请先卸载、cleanup，或调整 ${ownerLabel} 对应的有效安装后重试。`;
}

function participatesInSharedRuntimeOwner(location: PluginLocation): boolean {
  return !(location.platform === 'codex' && location.scope === 'project');
}

function compareOwnerCandidate(
  left: { location: PluginLocation; recordFile: InstallRecordFile; recordPath: string },
  right: { location: PluginLocation; recordFile: InstallRecordFile; recordPath: string },
): number {
  return (
    right.recordFile.record.updatedAt.localeCompare(left.recordFile.record.updatedAt)
    || (left.location.scope === right.location.scope
      ? 0
      : left.location.scope === 'user'
        ? -1
        : 1)
    || serializePluginLocation(toDependencyGraphPluginLocation(left.location)).localeCompare(
      serializePluginLocation(toDependencyGraphPluginLocation(right.location)),
    )
    || left.recordPath.localeCompare(right.recordPath)
  );
}

async function collectOwnerCandidateRecords(options: {
  pluginName: string;
  platform: PlatformName;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ownerInspection?: SharedSkillTriggerRuntimeOwnerInspection;
}): Promise<Array<{
  location: PluginLocation;
  recordFile: InstallRecordFile;
  recordPath: string;
}>> {
  const candidates = new Map<string, {
    location: PluginLocation;
    recordFile: InstallRecordFile;
    recordPath: string;
  }>();
  const addCandidate = (recordFile: InstallRecordFile, recordPath: string): void => {
    const location = locationFromRecord(recordFile);
    if (
      location.plugin !== options.pluginName
      || location.platform !== options.platform
      || !participatesInSharedRuntimeOwner(location)
    ) {
      return;
    }
    const key = `${recordPath}\u0000${recordFile.recordId}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        location,
        recordFile,
        recordPath,
      });
    }
  };

  const inspection = await inspectGlobalDependencyIndex(options.env);
  if (inspection.status === 'ok') {
    for (const [index, reference] of inspection.references.entries()) {
      if (reference.status !== 'verified') {
        continue;
      }
      const record = inspection.value.records[index];
      if (!record || record.location.plugin !== options.pluginName || record.location.platform !== options.platform) {
        continue;
      }
      const read = await readInstallRecordFileAt(record.recordPath, { env: options.env });
      if (read.status === 'ok') {
        addCandidate(read.value, record.recordPath);
      }
    }
  }

  if (options.cwd) {
    const recordRoots: PluginLocation[] = [
      {
        plugin: options.pluginName,
        platform: options.platform,
        scope: 'user',
      },
      {
        plugin: options.pluginName,
        platform: options.platform,
        scope: 'project',
        projectKey: options.cwd,
      },
    ];
    for (const pseudoLocation of recordRoots) {
      const recordsDir = path.join(
        getInstallStatePrivateRoot(options.cwd, pseudoLocation, options.env),
        'records',
      );
      if (!(await fs.pathExists(recordsDir))) {
        continue;
      }
      const entries = (await fs.readdir(recordsDir))
        .filter((entry) => entry.endsWith('.json'))
        .sort();
      for (const entry of entries) {
        const recordPath = path.join(recordsDir, entry);
        const read = await readInstallRecordFileAt(recordPath, { env: options.env });
        if (read.status === 'ok') {
          addCandidate(read.value, recordPath);
        }
      }
    }
  }

  if (
    options.ownerInspection?.usable === true
    && options.ownerInspection.ownerRecordRead?.status === 'ok'
    && options.ownerInspection.read.status === 'ok'
  ) {
    const siblingRecordDir = path.dirname(options.ownerInspection.read.value.ownerRecordPath);
    if (await fs.pathExists(siblingRecordDir)) {
      const entries = (await fs.readdir(siblingRecordDir))
        .filter((entry) => entry.endsWith('.json'))
        .sort();
      for (const entry of entries) {
        const recordPath = path.join(siblingRecordDir, entry);
        const read = await readInstallRecordFileAt(recordPath, { env: options.env });
        if (read.status === 'ok') {
          addCandidate(read.value, recordPath);
        }
      }
    }
    addCandidate(
      options.ownerInspection.ownerRecordRead.value,
      options.ownerInspection.read.value.ownerRecordPath,
    );
  }

  return [...candidates.values()].sort(compareOwnerCandidate);
}

async function selectDerivedOwnerCandidate(options: {
  pluginName: string;
  platform: PlatformName;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ownerInspection?: SharedSkillTriggerRuntimeOwnerInspection;
  excludeLocation?: PluginLocation;
}): Promise<{
  location: PluginLocation;
  preference: SkillTriggerPreference;
  recordFile: InstallRecordFile;
  recordPath: string;
} | null> {
  const candidates = (await collectOwnerCandidateRecords(options))
    .filter((candidate) =>
      !options.excludeLocation || !sameLocation(candidate.location, options.excludeLocation));
  const winner = candidates[0];
  return winner
    ? {
        ...winner,
        preference: preferenceFromRecord(winner.recordFile),
      }
    : null;
}

export async function readDerivedSharedSkillTriggerRuntimeOwner(options: {
  pluginName: string;
  platform: PlatformName;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<PluginLocation | null> {
  const ownerInspection = await inspectSharedSkillTriggerRuntimeOwner({
    pluginName: options.pluginName,
    platform: options.platform,
    env: options.env,
  });
  return (await selectDerivedOwnerCandidate({
    pluginName: options.pluginName,
    platform: options.platform,
    env: options.env,
    cwd: options.cwd,
    ownerInspection,
  }))?.location ?? null;
}

async function verifyOwnerRecordDigest(owner: SharedSkillTriggerRuntimeOwner): Promise<boolean> {
  if (!(await fs.pathExists(owner.ownerRecordPath))) {
    return false;
  }
  return sha256Hex(await fs.readFile(owner.ownerRecordPath)) === owner.ownerRecordDigest;
}

export async function createSharedSkillTriggerRuntimeMaterializationStage(options: {
  pluginName: string;
  platform: PlatformName;
  preference: SkillTriggerPreference;
  skillTriggerPreferences?: Record<string, SkillTriggerPreference>;
  embeddedRoot: string;
  sourcePluginRoot?: string;
  policyPlugin?: PluginMeta;
  target: SkillTriggerMaterializationTarget;
  mode: SkillTriggerMaterializationMode;
}): Promise<{ stage: InstallStateTransactionStage; warnings: string[] }> {
  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.pluginName,
    platform: options.platform,
    resolvedOptions: {
      skillTriggerPreference: options.preference,
      ...(options.skillTriggerPreferences
        ? { skillTriggerPreferences: options.skillTriggerPreferences }
        : {}),
    },
    embeddedRoot: options.embeddedRoot,
    sourcePluginRoot: options.sourcePluginRoot,
    policyPlugin: options.policyPlugin,
    target: options.target,
    mode: options.mode,
  });

  return {
    warnings: materialization.warnings,
    stage: {
      label: 'shared skill trigger runtime',
      async commit() {
        return;
      },
      async rollback(): Promise<InstallStateReceiptWarning | void> {
        try {
          await rollbackMaterializedSkillTriggerPreference(materialization.rollbackHandle);
          return undefined;
        } catch (error) {
          return {
            code: 'sharedRuntimeRollbackFailed',
            message: 'Shared skill trigger runtime rollback failed.',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      async finalize(): Promise<InstallStateReceiptWarning | void> {
        try {
          await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
          return undefined;
        } catch (error) {
          return {
            code: 'sharedRuntimeFinalizeFailed',
            message: 'Shared skill trigger runtime finalize failed.',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  };
}

export async function inspectSharedSkillTriggerRuntimeOwner(options: {
  pluginName: string;
  platform: PlatformName;
  env?: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeOwnerInspection> {
  const read = await readSharedSkillTriggerRuntimeOwner({
    pluginName: options.pluginName,
    platform: options.platform,
    env: options.env,
  });
  if (read.status !== 'ok') {
    return {
      ownerPath: getSharedSkillTriggerRuntimeOwnerPath(options),
      read,
      digestVerified: false,
      ownerRecordRead: null,
      ownerRecordMatchesLocation: false,
      usable: false,
    };
  }

  const digestVerified = await verifyOwnerRecordDigest(read.value);
  const ownerRecordRead = await readInstallRecordFileAt(read.value.ownerRecordPath, { env: options.env });
  const ownerRecordMatchesLocation = ownerRecordRead.status === 'ok'
    ? sameLocation(locationFromRecord(ownerRecordRead.value), read.value.owner)
    : false;

  return {
    ownerPath: read.path,
    read,
    digestVerified,
    ownerRecordRead,
    ownerRecordMatchesLocation,
    usable:
      digestVerified
      && ownerRecordRead.status === 'ok'
      && ownerRecordMatchesLocation,
  };
}

async function createSharedRuntimeOwnerIdentityWriteStage(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage> {
  return createSharedRuntimeOwnerWriteStage(options);
}

export async function preflightSharedSkillTriggerRuntimeOwnerUpsert(options: {
  location: PluginLocation;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  preference: SkillTriggerPreference;
  skillTriggerPreferences?: Record<string, SkillTriggerPreference>;
  command: 'install' | 'repair' | 'upgrade';
  targetCount?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeOwnerUpsertPlan> {
  const ownerInspection = await inspectSharedSkillTriggerRuntimeOwner({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
  });
  const assessment = await assessSharedSkillTriggerRuntimeSemantics({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    locationScope: options.location.scope,
    preference: options.preference,
    skillTriggerPreferences: options.skillTriggerPreferences,
    embeddedRoot: options.embeddedRoot,
    target: options.target,
  });

  if (!assessment.participatesInSharedRuntimeOwner) {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: 'none',
      shouldWriteOwner: false,
      shouldMaterializeRuntime: false,
    };
  }

  const ownerMatchesTarget = ownerInspection.read.status === 'ok'
    && sameLocation(ownerInspection.read.value.owner, options.location);
  const derivedOwner = await selectDerivedOwnerCandidate({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
    cwd: options.location.scope === 'project' ? options.location.projectKey ?? undefined : process.cwd(),
    ownerInspection,
  });
  const derivedOwnerMatchesTarget = derivedOwner !== null
    && sameLocation(derivedOwner.location, options.location);

  if (ownerMatchesTarget && derivedOwnerMatchesTarget) {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: 'refresh',
      shouldWriteOwner: true,
      shouldMaterializeRuntime: assessment.semanticDelta !== 'noChange',
    };
  }

  if (derivedOwnerMatchesTarget) {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: ownerMatchesTarget ? 'refresh' : 'claim',
      shouldWriteOwner: true,
      shouldMaterializeRuntime: assessment.semanticDelta !== 'noChange',
    };
  }

  if (derivedOwner === null) {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: ownerMatchesTarget ? 'refresh' : 'claim',
      shouldWriteOwner: true,
      shouldMaterializeRuntime: assessment.semanticDelta !== 'noChange',
    };
  }

  const takeoverRequired: SharedSkillTriggerRuntimeTakeoverRequired = ownerInspection.read.status === 'ok'
    ? {
      reason: ownerInspection.usable ? 'foreignOwner' : 'unverifiedOwner',
      currentOwner: ownerInspection.read.value.owner,
      message: ownerInspection.usable
        ? `shared runtime 当前由 ${formatLocation(ownerInspection.read.value.owner)} 控制；请先卸载、cleanup，或调整该 owner 对应的有效安装后重试。`
        : `shared runtime 当前 owner 指向 ${formatLocation(ownerInspection.read.value.owner)}，但状态不可验证（${formatOwnerInvalidReason(ownerInspection)}）；请先 cleanup 相关残留或恢复该 owner 对应的有效安装后重试。`,
    }
    : {
      reason: 'invalidOwnerState',
      message: 'shared runtime owner 状态不可读；请先 cleanup 相关残留后重试。',
    };

  return {
    status: (options.targetCount ?? 1) === 1 ? 'takeoverRequired' : 'takeoverNotAllowed',
    assessment,
    ownerInspection,
    takeoverRequired,
  };
}

export async function planSharedSkillTriggerRuntimeOwnerRemoval(options: {
  location: PluginLocation;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeRemovalPlan> {
  const ownerInspection = await inspectSharedSkillTriggerRuntimeOwner({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
  });
  const assessment = await assessSharedSkillTriggerRuntimeSemantics({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    locationScope: options.location.scope,
    preference: 'default',
    embeddedRoot: options.embeddedRoot,
    target: options.target,
  });

  if (!assessment.participatesInSharedRuntimeOwner) {
    return {
      assessment,
      ownerInspection,
      ownerAction: 'none',
      shouldDeleteOwner: false,
      nextOwner: null,
      shouldWriteOwner: false,
      shouldMaterializeRuntime: false,
    };
  }

  const derivedOwner = await selectDerivedOwnerCandidate({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
    cwd: options.cwd ?? (options.location.scope === 'project' ? options.location.projectKey ?? undefined : process.cwd()),
    ownerInspection,
  });
  const ownerMatchesTarget = derivedOwner !== null
    && sameLocation(derivedOwner.location, options.location);

  if (!ownerMatchesTarget) {
    return {
      assessment,
      ownerInspection,
      ownerAction: 'none',
      shouldDeleteOwner: false,
      nextOwner: null,
      shouldWriteOwner: false,
      shouldMaterializeRuntime: false,
    };
  }

  const nextOwner = await selectDerivedOwnerCandidate({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
    cwd: options.cwd ?? (options.location.scope === 'project' ? options.location.projectKey ?? undefined : process.cwd()),
    ownerInspection,
    excludeLocation: options.location,
  });

  return {
    assessment,
    ownerInspection,
    ownerAction: nextOwner ? 'reassign' : 'release',
    shouldDeleteOwner: !nextOwner,
    nextOwner,
    shouldWriteOwner: Boolean(nextOwner),
    shouldMaterializeRuntime: true,
  };
}

export async function createSharedSkillTriggerRuntimeUpsertStages(options: {
  plan: Extract<SharedSkillTriggerRuntimeOwnerUpsertPlan, { status: 'ok' }>;
  recordFile: InstallRecordFile;
  recordPath: string;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  env?: NodeJS.ProcessEnv;
  mode?: SkillTriggerMaterializationMode;
}): Promise<SharedSkillTriggerRuntimeStageBundle> {
  const warnings: string[] = [];
  const stages: InstallStateTransactionStage[] = [];

  if (!options.plan.shouldWriteOwner && !options.plan.shouldMaterializeRuntime) {
    return {
      ownerAction: options.plan.ownerAction,
      warnings,
      stages,
    };
  }

  if (options.plan.shouldMaterializeRuntime) {
    const materialization = await createSharedSkillTriggerRuntimeMaterializationStage({
      pluginName: options.recordFile.record.pluginName,
      platform: options.recordFile.record.platform,
      preference: preferenceFromRecord(options.recordFile),
      skillTriggerPreferences: options.plan.assessment.skillTriggerPreferences,
      embeddedRoot: options.embeddedRoot,
      target: options.target,
      mode: options.mode ?? 'strictExplicit',
    });
    warnings.push(...materialization.warnings);
    stages.push(materialization.stage);
  }

  if (options.plan.shouldWriteOwner) {
    stages.push(await createSharedRuntimeOwnerIdentityWriteStage({
      recordFile: options.recordFile,
      recordPath: options.recordPath,
      env: options.env,
    }));
  }

  return {
    ownerAction: options.plan.ownerAction,
    warnings,
    stages,
  };
}

export async function createSharedSkillTriggerRuntimeRemovalStages(options: {
  plan: SharedSkillTriggerRuntimeRemovalPlan;
  pluginName: string;
  platform: PlatformName;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  env?: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeStageBundle> {
  const warnings: string[] = [];
  const stages: InstallStateTransactionStage[] = [];

  if (
    !options.plan.shouldDeleteOwner
    && !options.plan.shouldWriteOwner
    && !options.plan.shouldMaterializeRuntime
  ) {
    return {
      ownerAction: options.plan.ownerAction,
      warnings,
      stages,
    };
  }

  if (options.plan.shouldMaterializeRuntime) {
    const nextOwnerPlugin = await readPluginManifest(
      path.join(options.embeddedRoot, 'plugins', options.pluginName),
      { mode: 'bundle' },
    );
    const nextOwnerPreferences = options.plan.nextOwner
      ? await resolveEffectiveSkillTriggerPreferences({
          plugin: nextOwnerPlugin,
          platform: options.plan.nextOwner.location.platform,
          scope: options.plan.nextOwner.location.scope,
          cwd: options.plan.nextOwner.location.scope === 'project'
            ? options.plan.nextOwner.location.projectKey ?? process.cwd()
            : process.cwd(),
          env: options.env,
        })
      : {};
    const materialization = await createSharedSkillTriggerRuntimeMaterializationStage({
      pluginName: options.pluginName,
      platform: options.platform,
      preference: options.plan.nextOwner?.preference ?? 'default',
      skillTriggerPreferences: nextOwnerPreferences,
      embeddedRoot: options.embeddedRoot,
      target: options.target,
      mode: 'bestEffortReplay',
    });
    warnings.push(...materialization.warnings);
    stages.push(materialization.stage);
  }

  if (options.plan.shouldWriteOwner && options.plan.nextOwner) {
    stages.push(await createSharedRuntimeOwnerIdentityWriteStage({
      recordFile: options.plan.nextOwner.recordFile,
      recordPath: options.plan.nextOwner.recordPath,
      env: options.env,
    }));
  } else if (options.plan.shouldDeleteOwner) {
    stages.push(createSharedRuntimeOwnerDeleteStage({
      pluginName: options.pluginName,
      platform: options.platform,
      env: options.env,
    }));
  }

  return {
    ownerAction: options.plan.ownerAction,
    warnings,
    stages,
  };
}

export async function replaySharedSkillTriggerRuntimeFromOwner(options: {
  pluginName: string;
  platform: PlatformName;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  env?: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeReplayResult> {
  const ownerInspection = await inspectSharedSkillTriggerRuntimeOwner({
    pluginName: options.pluginName,
    platform: options.platform,
    env: options.env,
  });
  if (!ownerInspection.usable) {
    const failClosedReason = buildReplayFailClosedMessage({
      pluginName: options.pluginName,
      platform: options.platform,
      detail: `shared runtime owner 无法验证（${formatOwnerInvalidReason(ownerInspection)}）`,
    });
    return {
      status: 'failClosed',
      failClosedCode: ownerInspection.read.status === 'ok' ? 'ownerUnverified' : 'ownerStateInvalid',
      failClosedReason,
      ownerInspection,
      warnings: [failClosedReason],
    };
  }

  if (ownerInspection.read.status !== 'ok') {
    throw new Error('Shared runtime owner inspection is marked usable without a readable owner record.');
  }

  const ownerLocation = ownerInspection.read.value.owner;
  if (ownerLocation.scope === 'project' && !ownerLocation.projectKey) {
    const failClosedReason = buildReplayFailClosedMessage({
      pluginName: options.pluginName,
      platform: options.platform,
      detail: 'shared runtime owner 当前 effective SkillTrigger 配置不可解析（owner projectKey 缺失）',
    });
    return {
      status: 'failClosed',
      failClosedCode: 'ownerEffectiveConfigInvalid',
      failClosedReason,
      ownerInspection,
      warnings: [failClosedReason],
    };
  }

  let preference: SkillTriggerPreference;
  let skillTriggerPreferences: Record<string, SkillTriggerPreference> = {};
  try {
    const plugin = await readPluginManifest(
      path.join(options.embeddedRoot, 'plugins', options.pluginName),
      { mode: 'bundle' },
    );
    skillTriggerPreferences = await resolveEffectiveSkillTriggerPreferences({
      plugin,
      platform: ownerLocation.platform,
      scope: ownerLocation.scope,
      cwd: ownerLocation.scope === 'project'
        ? ownerLocation.projectKey ?? process.cwd()
        : process.cwd(),
      env: options.env,
    });
    const policyResolution = await resolveSkillTriggerPolicies({
      embeddedRoot: options.embeddedRoot,
      pluginName: options.pluginName,
      platform: options.platform,
    });
    const effectiveValues = new Set(policyResolution.policies.map((policy) =>
      skillTriggerPreferences[policy.skillName] ?? policy.defaultTrigger));
    const ownerRecordRead = ownerInspection.ownerRecordRead;
    if (!ownerRecordRead || ownerRecordRead.status !== 'ok') {
      throw new Error('owner install record 不可读');
    }
    preference = effectiveValues.size === 1
      ? [...effectiveValues][0]!
      : effectiveValues.size === 0
        ? 'default'
        : preferenceFromRecord(ownerRecordRead.value);
  } catch (error) {
    const failClosedReason = buildReplayFailClosedMessage({
      pluginName: options.pluginName,
      platform: options.platform,
      detail:
        `shared runtime owner 当前 effective SkillTrigger 配置不可解析（${error instanceof Error ? error.message : String(error)}）`,
      ownerLocation,
    });
    return {
      status: 'failClosed',
      failClosedCode: 'ownerEffectiveConfigInvalid',
      failClosedReason,
      ownerInspection,
      warnings: [failClosedReason],
    };
  }

  const warnings: string[] = [];

  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.pluginName,
    platform: options.platform,
    resolvedOptions: {
      skillTriggerPreference: preference,
      skillTriggerPreferences,
    },
    embeddedRoot: options.embeddedRoot,
    target: options.target,
    mode: 'bestEffortReplay',
  });
  warnings.push(...materialization.warnings);

  try {
    await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
  } catch (error) {
    warnings.push(
      `[${options.platform}/${options.pluginName}] shared runtime 备份目录清理失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    status: 'replayed',
    source: 'owner',
    preference,
    skillTriggerPreferences,
    ownerInspection,
    warnings,
    materialization,
  };
}
