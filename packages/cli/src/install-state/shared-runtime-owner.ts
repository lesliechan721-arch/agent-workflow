import fs from 'fs-extra';

import type { PlatformName, SkillTriggerPreference } from '../types.js';
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

export interface SharedSkillTriggerRuntimeOwnerInspection {
  ownerPath: string;
  read: InstallStateReadResult<SharedSkillTriggerRuntimeOwner>;
  digestVerified: boolean;
  ownerRecordRead: InstallStateReadResult<InstallRecordFile> | null;
  ownerRecordMatchesLocation: boolean;
  ownerRecordMatchesPreference: boolean;
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

export interface SharedSkillTriggerRuntimeReplayResult {
  source: 'owner' | 'embeddedDefault';
  preference: SkillTriggerPreference;
  ownerInspection: SharedSkillTriggerRuntimeOwnerInspection;
  warnings: string[];
  materialization: SkillTriggerMaterializationResult;
}

function sameLocation(left: PluginLocation, right: PluginLocation): boolean {
  return left.plugin === right.plugin
    && left.platform === right.platform
    && left.scope === right.scope
    && (left.projectKey ?? null) === (right.projectKey ?? null);
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
  if (!inspection.ownerRecordMatchesPreference) {
    return 'owner record preference 与 owner 文件不一致';
  }
  return 'owner 状态不可验证';
}

async function verifyOwnerRecordDigest(owner: SharedSkillTriggerRuntimeOwner): Promise<boolean> {
  if (!(await fs.pathExists(owner.ownerRecordPath))) {
    return false;
  }
  return sha256Hex(await fs.readFile(owner.ownerRecordPath)) === owner.ownerRecordDigest;
}

async function createMaterializationStage(options: {
  pluginName: string;
  platform: PlatformName;
  preference: SkillTriggerPreference;
  embeddedRoot: string;
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
      ownerRecordMatchesPreference: false,
      usable: false,
    };
  }

  const digestVerified = await verifyOwnerRecordDigest(read.value);
  const ownerRecordRead = await readInstallRecordFileAt(read.value.ownerRecordPath);
  const ownerRecordMatchesLocation = ownerRecordRead.status === 'ok'
    ? sameLocation(locationFromRecord(ownerRecordRead.value), read.value.owner)
    : false;
  const ownerRecordMatchesPreference = ownerRecordRead.status === 'ok'
    ? preferenceFromRecord(ownerRecordRead.value) === read.value.preference
    : false;

  return {
    ownerPath: read.path,
    read,
    digestVerified,
    ownerRecordRead,
    ownerRecordMatchesLocation,
    ownerRecordMatchesPreference,
    usable:
      digestVerified
      && ownerRecordRead.status === 'ok'
      && ownerRecordMatchesLocation
      && ownerRecordMatchesPreference,
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
    const materialization = await createMaterializationStage({
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
    stages.push(await createSharedRuntimeOwnerWriteStage({
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
    const materialization = await createMaterializationStage({
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
  const source = ownerInspection.usable ? 'owner' : 'embeddedDefault';
  const preference = ownerInspection.usable && ownerInspection.read.status === 'ok'
    ? ownerInspection.read.value.preference
    : 'default';
  const warnings: string[] = [];

  if (!ownerInspection.usable && ownerInspection.read.status !== 'missing') {
    warnings.push(
      `[${options.platform}/${options.pluginName}] shared runtime owner 无法验证（${formatOwnerInvalidReason(ownerInspection)}），已回退到 embedded 默认策略；请运行 diagnose / repair，需要转移控制权时请使用单目标写命令并加 --takeover-shared-runtime。`,
    );
  }

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
    source,
    preference,
    ownerInspection,
    warnings,
    materialization,
  };
}
