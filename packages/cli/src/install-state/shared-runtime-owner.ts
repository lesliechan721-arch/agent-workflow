import path from 'node:path';

import fs from 'fs-extra';

import type { PlatformName, PluginMeta, SkillTriggerPreference } from '../types.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveUniformSkillTriggerPreference } from '../utils/plugin-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
import {
  assessSharedSkillTriggerRuntimeSemantics,
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
  rollbackMaterializedSkillTriggerPreference,
  type SharedSkillTriggerRuntimeSemanticsAssessment,
  type SkillTriggerMaterializationMode,
  type SkillTriggerMaterializationResult,
  type SkillTriggerMaterializationTarget,
} from '../utils/skill-trigger-preferences.js';
import {
  readInstallRecordFileAt,
  readSharedSkillTriggerRuntimeOwner,
} from './facade.js';
import { sha256Hex } from './internal.js';
import { getSharedSkillTriggerRuntimeOwnerPath } from './paths.js';
import {
  createSharedRuntimeOwnerDeleteStage,
  type InstallStateReceiptWarning,
  type InstallStateTransactionStage,
} from './transactions.js';
import type {
  InstallRecordFile,
  InstallStateReadResult,
  PluginLocation,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';

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
  | 'takeover'
  | 'release';

export interface SharedSkillTriggerRuntimeTakeoverRequired {
  reason: 'foreignOwner' | 'unverifiedOwner' | 'invalidOwnerState';
  takeoverAllowed: boolean;
  suggestedFlag: '--takeover-shared-runtime' | null;
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
  ownerAction: 'none' | 'release';
  shouldDeleteOwner: boolean;
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

function formatReplayRepairGuidance(ownerLocation?: PluginLocation): string {
  if (!ownerLocation) {
    return '对应目标的 `aw repair`';
  }

  return `\`aw repair ${ownerLocation.plugin} --platform ${ownerLocation.platform} --scope ${ownerLocation.scope}\``;
}

function buildReplayFailClosedMessage(options: {
  pluginName: string;
  platform: PlatformName;
  detail: string;
  ownerLocation?: PluginLocation;
}): string {
  return `[${options.platform}/${options.pluginName}] ${options.detail}；shared runtime replay 已 fail closed。` +
    `请先运行 ${formatReplayRepairGuidance(options.ownerLocation)}，如需改写，请重跑单目标写命令并加 \`--takeover-shared-runtime\`。`;
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
  const ownerPath = getSharedSkillTriggerRuntimeOwnerPath({
    pluginName: options.recordFile.record.pluginName,
    platform: options.recordFile.record.platform,
    env: options.env,
  });
  const stagingPath = `${ownerPath}.aw-staging`;
  const backupPath = `${ownerPath}.aw-backup`;
  let committed = false;

  return {
    label: 'shared runtime owner',
    async commit() {
      if (committed) {
        return;
      }
      const value: SharedSkillTriggerRuntimeOwner = {
        version: 1,
        pluginName: options.recordFile.record.pluginName,
        platform: options.recordFile.record.platform,
        owner: locationFromRecord(options.recordFile),
        ownerRecordPath: options.recordPath,
        ownerRecordDigest: sha256Hex(await fs.readFile(options.recordPath)),
        updatedAt: options.recordFile.record.updatedAt,
      };
      await fs.ensureDir(path.dirname(ownerPath));
      await fs.writeJson(stagingPath, value, { spaces: 2 });
      if (await fs.pathExists(ownerPath)) {
        await fs.move(ownerPath, backupPath, { overwrite: true });
      }
      await fs.move(stagingPath, ownerPath, { overwrite: true });
      committed = true;
    },
    async rollback(): Promise<InstallStateReceiptWarning | void> {
      try {
        if (committed) {
          if (await fs.pathExists(backupPath)) {
            await fs.remove(ownerPath).catch(() => undefined);
            await fs.move(backupPath, ownerPath, { overwrite: true });
          } else {
            await fs.remove(ownerPath).catch(() => undefined);
          }
        } else {
          await fs.remove(stagingPath).catch(() => undefined);
        }
        return undefined;
      } catch (error) {
        return {
          code: 'sharedRuntimeOwnerRollbackFailed',
          message: 'Shared runtime owner rollback failed.',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async finalize(): Promise<InstallStateReceiptWarning | void> {
      try {
        await Promise.all([
          fs.remove(stagingPath).catch(() => undefined),
          fs.remove(backupPath).catch(() => undefined),
        ]);
        return undefined;
      } catch (error) {
        return {
          code: 'sharedRuntimeOwnerFinalizeFailed',
          message: 'Shared runtime owner finalize failed.',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export async function preflightSharedSkillTriggerRuntimeOwnerUpsert(options: {
  location: PluginLocation;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  preference: SkillTriggerPreference;
  command: 'install' | 'repair' | 'upgrade';
  takeoverSharedRuntime?: boolean;
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

  const takeoverAllowed = (options.targetCount ?? 1) === 1;
  const ownerMatchesTarget = ownerInspection.read.status === 'ok'
    && sameLocation(ownerInspection.read.value.owner, options.location);

  if (ownerInspection.read.status === 'missing') {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: 'claim',
      shouldWriteOwner: true,
      shouldMaterializeRuntime: assessment.semanticDelta !== 'noChange',
    };
  }

  if (ownerMatchesTarget) {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: 'refresh',
      shouldWriteOwner: true,
      shouldMaterializeRuntime: assessment.semanticDelta !== 'noChange',
    };
  }

  if (assessment.semanticDelta === 'noChange') {
    return {
      status: 'ok',
      assessment,
      ownerInspection,
      ownerAction: 'none',
      shouldWriteOwner: false,
      shouldMaterializeRuntime: false,
    };
  }

  const takeoverRequired: SharedSkillTriggerRuntimeTakeoverRequired = ownerInspection.read.status === 'ok'
    ? {
      reason: ownerInspection.usable ? 'foreignOwner' : 'unverifiedOwner',
      takeoverAllowed,
      suggestedFlag: takeoverAllowed ? '--takeover-shared-runtime' : null,
      currentOwner: ownerInspection.read.value.owner,
      message: ownerInspection.usable
        ? `shared runtime 当前由 ${formatLocation(ownerInspection.read.value.owner)} 控制；如需改写，请重跑同一条命令并加 --takeover-shared-runtime。`
        : `shared runtime 当前 owner 指向 ${formatLocation(ownerInspection.read.value.owner)}，但状态不可验证（${formatOwnerInvalidReason(ownerInspection)}）；如需改写，请使用单目标命令并显式加 --takeover-shared-runtime。`,
    }
    : {
      reason: 'invalidOwnerState',
      takeoverAllowed,
      suggestedFlag: takeoverAllowed ? '--takeover-shared-runtime' : null,
      message: `shared runtime owner 状态不可读；如需改写，请使用单目标命令并显式加 --takeover-shared-runtime。`,
    };

  if (!options.takeoverSharedRuntime) {
    return {
      status: 'takeoverRequired',
      assessment,
      ownerInspection,
      takeoverRequired,
    };
  }

  if (!takeoverAllowed) {
    return {
      status: 'takeoverNotAllowed',
      assessment,
      ownerInspection,
      takeoverRequired: {
        ...takeoverRequired,
        suggestedFlag: null,
        message: '批量 upgrade 不能接管 shared runtime；请改用单目标 install / repair / explicit upgrade 并加 --takeover-shared-runtime。',
      },
    };
  }

  return {
    status: 'ok',
    assessment,
    ownerInspection,
    ownerAction: 'takeover',
    shouldWriteOwner: true,
    shouldMaterializeRuntime: true,
  };
}

export async function planSharedSkillTriggerRuntimeOwnerRemoval(options: {
  location: PluginLocation;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
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
      shouldMaterializeRuntime: false,
    };
  }

  const ownerMatchesTarget = ownerInspection.read.status === 'ok'
    && sameLocation(ownerInspection.read.value.owner, options.location);

  if (!ownerMatchesTarget) {
    return {
      assessment,
      ownerInspection,
      ownerAction: 'none',
      shouldDeleteOwner: false,
      shouldMaterializeRuntime: false,
    };
  }

  return {
    assessment,
    ownerInspection,
    ownerAction: 'release',
    shouldDeleteOwner: true,
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

  if (!options.plan.shouldDeleteOwner && !options.plan.shouldMaterializeRuntime) {
    return {
      ownerAction: options.plan.ownerAction,
      warnings,
      stages,
    };
  }

  if (options.plan.shouldMaterializeRuntime) {
    const materialization = await createSharedSkillTriggerRuntimeMaterializationStage({
      pluginName: options.pluginName,
      platform: options.platform,
      preference: 'default',
      embeddedRoot: options.embeddedRoot,
      target: options.target,
      mode: 'bestEffortReplay',
    });
    warnings.push(...materialization.warnings);
    stages.push(materialization.stage);
  }

  if (options.plan.shouldDeleteOwner) {
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
  try {
    const plugin = await readPluginManifest(
      path.join(options.embeddedRoot, 'plugins', options.pluginName),
      { mode: 'bundle' },
    );
    preference = await resolveUniformSkillTriggerPreference({
      plugin,
      platform: ownerLocation.platform,
      scope: ownerLocation.scope,
      cwd: ownerLocation.scope === 'project'
        ? ownerLocation.projectKey ?? process.cwd()
        : process.cwd(),
      env: options.env,
    });
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
    ownerInspection,
    warnings,
    materialization,
  };
}
