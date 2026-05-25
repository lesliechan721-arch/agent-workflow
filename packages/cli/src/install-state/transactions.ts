import path from 'node:path';

import fs from 'fs-extra';

import { writeJsonFile } from '../utils/json.js';
import { assertTestWritablePath } from '../utils/test-path-fence.js';
import {
  deleteGlobalDependencyIndexRecord,
  upsertGlobalDependencyIndexRecord,
  readDynamicArtifactDiagnosticCacheAt,
  writeNativeTransactionMarker,
} from './facade.js';
import { sha256Hex, stableStringify } from './internal.js';
import {
  getDiagnosticCachePath,
  getGlobalDependencyIndexPath,
  getInstallRecordPath,
  getNativeTransactionMarkerPath,
  getProjectArtifactSharedIdentityPath,
  getSharedSkillTriggerRuntimeOwnerPath,
} from './paths.js';
import {
  validateDynamicArtifactDiagnosticCache,
  validateInstallRecordFile,
  validateNativeTransactionMarker,
  validateProjectArtifactIdentityFile,
  validateSharedSkillTriggerRuntimeOwner,
} from './schema.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  InstallRecordFile,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityFile,
  ProjectArtifactSharedLocator,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';

export interface InstallStateReceiptWarning {
  code: string;
  message: string;
  path?: string;
  error?: string;
}

export interface InstallStateTransactionStage {
  label: string;
  commit(): Promise<void>;
  rollback(): Promise<InstallStateReceiptWarning | void>;
  finalize(): Promise<InstallStateReceiptWarning | void>;
}

export interface InstallStateTransactionPostCommitAction {
  label: string;
  run(): Promise<void>;
  toWarning(error: unknown): InstallStateReceiptWarning;
}

export interface InstallStateTransactionPostCommitResult {
  label: string;
  status: 'ok' | 'warning';
  warning?: InstallStateReceiptWarning;
}

export interface InstallStateTransactionResult {
  committed: true;
  completeSuccess: boolean;
  warnings: InstallStateReceiptWarning[];
  postCommit: InstallStateTransactionPostCommitResult[];
}

export class InstallStateTransactionError extends Error {
  readonly cause: unknown;
  readonly stage: string | null;
  readonly warnings: InstallStateReceiptWarning[];

  constructor(options: {
    message: string;
    cause: unknown;
    stage: string | null;
    warnings: InstallStateReceiptWarning[];
  }) {
    super(options.message);
    this.name = 'InstallStateTransactionError';
    this.cause = options.cause;
    this.stage = options.stage;
    this.warnings = options.warnings;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTempPath(targetPath: string, suffix: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${suffix}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function createWarning(code: string, message: string, pathValue?: string, error?: unknown): InstallStateReceiptWarning {
  return {
    code,
    message,
    ...(pathValue ? { path: pathValue } : {}),
    ...(error !== undefined ? { error: formatError(error) } : {}),
  };
}

async function removePathIfExists(targetPath: string): Promise<void> {
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }
}

function createAtomicJsonWriteStage(options: {
  label: string;
  filePath: string;
  value: unknown;
  validate?: (value: unknown, filePath: string) => void;
  rollbackWarningCode: string;
  finalizeWarningCode: string;
}): Promise<InstallStateTransactionStage> {
  return (async () => {
    const filePath = assertTestWritablePath(
      options.filePath,
      options.label,
      '用 createIsolatedTestEnv() 生成默认测试状态根，或通过 registerWritableStateRoot()/withSafeTestCwd() 登记当前写入目标。',
    );
    options.validate?.(options.value, filePath);
    const stagingPath = createTempPath(filePath, 'aw-staging');
    const backupPath = createTempPath(filePath, 'aw-backup');
    await fs.ensureDir(path.dirname(filePath));
    await writeJsonFile(stagingPath, options.value);

    let committed = false;

    return {
      label: options.label,
      async commit() {
        if (committed) {
          return;
        }
        if (await fs.pathExists(filePath)) {
          await fs.move(filePath, backupPath, { overwrite: true });
        }
        await fs.move(stagingPath, filePath, { overwrite: true });
        committed = true;
      },
      async rollback() {
        try {
          if (committed) {
            if (await fs.pathExists(backupPath)) {
              await removePathIfExists(filePath);
              await fs.move(backupPath, filePath, { overwrite: true });
            } else {
              await removePathIfExists(filePath);
            }
          } else {
            await removePathIfExists(stagingPath);
          }
          return undefined;
        } catch (error) {
          return createWarning(
            options.rollbackWarningCode,
            `${options.label} rollback failed.`,
            filePath,
            error,
          );
        }
      },
      async finalize() {
        try {
          await Promise.all([
            removePathIfExists(stagingPath),
            removePathIfExists(backupPath),
          ]);
          return undefined;
        } catch (error) {
          return createWarning(
            options.finalizeWarningCode,
            `${options.label} finalize failed.`,
            filePath,
            error,
          );
        }
      },
    };
  })();
}

function createAtomicDeleteStage(options: {
  label: string;
  filePath: string;
  rollbackWarningCode: string;
  finalizeWarningCode: string;
}): InstallStateTransactionStage {
  const filePath = assertTestWritablePath(
    options.filePath,
    options.label,
    '用 createIsolatedTestEnv() 生成默认测试状态根，或通过 registerWritableStateRoot()/withSafeTestCwd() 登记当前写入目标。',
  );
  const backupPath = createTempPath(filePath, 'aw-delete-backup');
  let committed = false;
  let deleted = false;

  return {
    label: options.label,
    async commit() {
      if (committed) {
        return;
      }
      if (!(await fs.pathExists(filePath))) {
        committed = true;
        return;
      }
      await fs.ensureDir(path.dirname(filePath));
      await fs.move(filePath, backupPath, { overwrite: true });
      committed = true;
      deleted = true;
    },
    async rollback() {
      try {
        if (committed && deleted && (await fs.pathExists(backupPath))) {
          await fs.move(backupPath, filePath, { overwrite: true });
        }
        return undefined;
      } catch (error) {
        return createWarning(
          options.rollbackWarningCode,
          `${options.label} rollback failed.`,
          filePath,
          error,
        );
      }
    },
    async finalize() {
      try {
        await removePathIfExists(backupPath);
        return undefined;
      } catch (error) {
        return createWarning(
          options.finalizeWarningCode,
          `${options.label} finalize failed.`,
          filePath,
          error,
        );
      }
    },
  };
}

export function createPathDeleteStage(options: {
  label: string;
  filePath: string;
  rollbackWarningCode: string;
  finalizeWarningCode: string;
}): InstallStateTransactionStage {
  return createAtomicDeleteStage(options);
}

export async function runInstallStateTransaction(options: {
  stages: InstallStateTransactionStage[];
  postCommit?: InstallStateTransactionPostCommitAction[];
}): Promise<InstallStateTransactionResult> {
  const warnings: InstallStateReceiptWarning[] = [];
  const postCommit: InstallStateTransactionPostCommitResult[] = [];
  let currentStage: InstallStateTransactionStage | null = null;

  try {
    for (const stage of options.stages) {
      currentStage = stage;
      await stage.commit();
    }
    currentStage = null;
  } catch (error) {
    for (const stage of [...options.stages].reverse()) {
      const warning = await stage.rollback();
      if (warning) {
        warnings.push(warning);
      }
    }
    for (const stage of [...options.stages].reverse()) {
      const warning = await stage.finalize();
      if (warning) {
        warnings.push(warning);
      }
    }
    throw new InstallStateTransactionError({
      message: currentStage
        ? `Install-state transaction failed while committing ${currentStage.label}.`
        : 'Install-state transaction failed.',
      cause: error,
      stage: currentStage?.label ?? null,
      warnings,
    });
  }

  for (const action of options.postCommit ?? []) {
    try {
      await action.run();
      postCommit.push({
        label: action.label,
        status: 'ok',
      });
    } catch (error) {
      const warning = action.toWarning(error);
      warnings.push(warning);
      postCommit.push({
        label: action.label,
        status: 'warning',
        warning,
      });
    }
  }

  for (const stage of [...options.stages].reverse()) {
    const warning = await stage.finalize();
    if (warning) {
      warnings.push(warning);
    }
  }

  return {
    committed: true,
    completeSuccess: warnings.length === 0,
    warnings,
    postCommit,
  };
}

function validateInstallRecordOrThrow(
  value: unknown,
  filePath: string,
  env?: NodeJS.ProcessEnv,
): void {
  const validated = validateInstallRecordFile(value, { expectedPath: filePath, env });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
}

function validateProjectIdentityOrThrow(value: unknown, filePath: string): void {
  const validated = validateProjectArtifactIdentityFile(value, { expectedPath: filePath });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
}

function validateDiagnosticCacheOrThrow(
  value: unknown,
  filePath: string,
  currentRecord?: InstallRecordFile,
): void {
  const validated = validateDynamicArtifactDiagnosticCache(value, {
    expectedRecordId: currentRecord?.recordId,
    currentRecord,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  if (path.basename(filePath, '.json') !== validated.value.recordId) {
    throw new Error(`Dynamic diagnostic cache file name "${path.basename(filePath)}" does not match recordId "${validated.value.recordId}".`);
  }
}

function validateNativeMarkerOrThrow(value: unknown): void {
  const validated = validateNativeTransactionMarker(value);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
}

function validateSharedRuntimeOwnerOrThrow(value: unknown, filePath: string): void {
  const validated = validateSharedSkillTriggerRuntimeOwner(value, { expectedPath: filePath });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
}

async function buildSharedRuntimeOwnerFromRecord(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  updatedAt?: string;
}): Promise<SharedSkillTriggerRuntimeOwner> {
  const location: PluginLocation = {
    plugin: options.recordFile.record.pluginName,
    platform: options.recordFile.record.platform,
    scope: options.recordFile.record.scope,
    ...(options.recordFile.record.scope === 'project'
      ? { projectKey: options.recordFile.record.projectKey }
      : {}),
  };

  return {
    version: 1,
    pluginName: options.recordFile.record.pluginName,
    platform: options.recordFile.record.platform,
    owner: location,
    ownerRecordPath: options.recordPath,
    ownerRecordDigest: sha256Hex(await fs.readFile(options.recordPath)),
    preference: options.recordFile.record.options?.skillTriggerPreference ?? 'default',
    updatedAt: options.updatedAt ?? options.recordFile.record.updatedAt,
  };
}

function diagnosticEntryKey(entry: Pick<DynamicArtifactDiagnosticEntry, 'id' | 'target' | 'artifactKey' | 'roleKey'>): string {
  return stableStringify({
    id: entry.id,
    target: entry.target,
    artifactKey: entry.artifactKey ?? null,
    roleKey: entry.roleKey ?? null,
  });
}

export function mergeDynamicArtifactDiagnosticCache(options: {
  mode: 'accepted' | 'refreshFailed';
  next: DynamicArtifactDiagnosticCache;
  current?: DynamicArtifactDiagnosticCache | null;
}): DynamicArtifactDiagnosticCache {
  if (options.mode === 'accepted' || !options.current) {
    return options.next;
  }

  const acceptedByKey = new Map(
    options.current.artifacts.map((artifact) => [diagnosticEntryKey(artifact), artifact]),
  );

  return {
    ...options.next,
    artifacts: options.next.artifacts.map((artifact) => {
      const previous = acceptedByKey.get(diagnosticEntryKey(artifact));
      if (!previous) {
        return artifact;
      }
      return {
        ...artifact,
        state: previous.state,
        disabledReason: previous.disabledReason,
        configDigest: previous.configDigest,
        contentDigest: previous.contentDigest,
      };
    }),
  };
}

export function createInstallRecordWriteStage(options: {
  filePath: string;
  value: InstallRecordFile;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage>;
export function createInstallRecordWriteStage(options: {
  cwd: string;
  location: PluginLocation;
  value: InstallRecordFile;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage>;
export function createInstallRecordWriteStage(options: {
  filePath?: string;
  cwd?: string;
  location?: PluginLocation;
  value: InstallRecordFile;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage> {
  const filePath = options.filePath ?? getInstallRecordPath(
    options.cwd!,
    options.location!,
    options.env,
    'write',
  );
  return createAtomicJsonWriteStage({
    label: 'install record',
    filePath,
    value: options.value,
    validate: (value, currentFilePath) => validateInstallRecordOrThrow(value, currentFilePath, options.env),
    rollbackWarningCode: 'recordRollbackFailed',
    finalizeWarningCode: 'recordFinalizeFailed',
  });
}

export function createInstallRecordDeleteStage(options: {
  filePath: string;
}): InstallStateTransactionStage;
export function createInstallRecordDeleteStage(options: {
  cwd: string;
  location: PluginLocation;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionStage;
export function createInstallRecordDeleteStage(options: {
  filePath?: string;
  cwd?: string;
  location?: PluginLocation;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionStage {
  const filePath = options.filePath ?? getInstallRecordPath(
    options.cwd!,
    options.location!,
    options.env,
    'write',
  );
  return createAtomicDeleteStage({
    label: 'install record',
    filePath,
    rollbackWarningCode: 'recordRollbackFailed',
    finalizeWarningCode: 'recordFinalizeFailed',
  });
}

export function createProjectArtifactIdentityWriteStage(options: {
  filePath: string;
  value: ProjectArtifactIdentityFile;
}): Promise<InstallStateTransactionStage>;
export function createProjectArtifactIdentityWriteStage(options: {
  repoRoot: string;
  locator: ProjectArtifactSharedLocator;
  value: ProjectArtifactIdentityFile;
}): Promise<InstallStateTransactionStage>;
export function createProjectArtifactIdentityWriteStage(options: {
  filePath?: string;
  repoRoot?: string;
  locator?: ProjectArtifactSharedLocator;
  value: ProjectArtifactIdentityFile;
}): Promise<InstallStateTransactionStage> {
  const filePath = options.filePath ?? getProjectArtifactSharedIdentityPath({
    repoRoot: options.repoRoot!,
    locator: options.locator!,
    access: 'write',
  });
  return createAtomicJsonWriteStage({
    label: 'project artifact identity',
    filePath,
    value: options.value,
    validate: validateProjectIdentityOrThrow,
    rollbackWarningCode: 'projectIdentityRollbackFailed',
    finalizeWarningCode: 'projectIdentityFinalizeFailed',
  });
}

export function createProjectArtifactIdentityDeleteStage(options: {
  filePath: string;
}): InstallStateTransactionStage;
export function createProjectArtifactIdentityDeleteStage(options: {
  repoRoot: string;
  locator: ProjectArtifactSharedLocator;
}): InstallStateTransactionStage;
export function createProjectArtifactIdentityDeleteStage(options: {
  filePath?: string;
  repoRoot?: string;
  locator?: ProjectArtifactSharedLocator;
}): InstallStateTransactionStage {
  const filePath = options.filePath ?? getProjectArtifactSharedIdentityPath({
    repoRoot: options.repoRoot!,
    locator: options.locator!,
    access: 'write',
  });
  return createAtomicDeleteStage({
    label: 'project artifact identity',
    filePath,
    rollbackWarningCode: 'projectIdentityRollbackFailed',
    finalizeWarningCode: 'projectIdentityFinalizeFailed',
  });
}

export async function createDynamicArtifactDiagnosticCacheWriteStage(options: {
  filePath: string;
  value: DynamicArtifactDiagnosticCache;
  currentRecord?: InstallRecordFile;
  currentCache?: DynamicArtifactDiagnosticCache | null;
  mode?: 'accepted' | 'refreshFailed';
}): Promise<InstallStateTransactionStage>;
export async function createDynamicArtifactDiagnosticCacheWriteStage(options: {
  cwd: string;
  location: PluginLocation;
  value: DynamicArtifactDiagnosticCache;
  currentRecord?: InstallRecordFile;
  currentCache?: DynamicArtifactDiagnosticCache | null;
  mode?: 'accepted' | 'refreshFailed';
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage>;
export async function createDynamicArtifactDiagnosticCacheWriteStage(options: {
  filePath?: string;
  cwd?: string;
  location?: PluginLocation;
  value: DynamicArtifactDiagnosticCache;
  currentRecord?: InstallRecordFile;
  currentCache?: DynamicArtifactDiagnosticCache | null;
  mode?: 'accepted' | 'refreshFailed';
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage> {
  const filePath = options.filePath ?? getDiagnosticCachePath(
    options.cwd!,
    options.location!,
    options.env,
    'write',
  );
  let currentCache = options.currentCache;
  if (currentCache === undefined) {
    const current = await readDynamicArtifactDiagnosticCacheAt(filePath, {
      currentRecord: options.currentRecord,
      expectedLocation: options.location,
    });
    currentCache = current.status === 'ok' ? current.value : null;
  }
  const value = mergeDynamicArtifactDiagnosticCache({
    mode: options.mode ?? 'accepted',
    next: options.value,
    current: currentCache,
  });
  const validated = validateDynamicArtifactDiagnosticCache(value, {
    expectedRecordId: options.currentRecord?.recordId,
    expectedLocation: options.location,
    currentRecord: options.currentRecord,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return createAtomicJsonWriteStage({
    label: 'dynamic diagnostic cache',
    filePath,
    value: validated.value,
    validate: (cacheValue, cachePath) => validateDiagnosticCacheOrThrow(cacheValue, cachePath, options.currentRecord),
    rollbackWarningCode: 'diagnosticCacheRollbackFailed',
    finalizeWarningCode: 'diagnosticCacheFinalizeFailed',
  });
}

export function createNativeTransactionMarkerWriteStage(options: {
  value: NativeTransactionMarker;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage> {
  const filePath = getNativeTransactionMarkerPath(options.value.pluginId, options.env);
  return createAtomicJsonWriteStage({
    label: 'native transaction marker',
    filePath,
    value: options.value,
    validate: (value) => validateNativeMarkerOrThrow(value),
    rollbackWarningCode: 'nativeMarkerRollbackFailed',
    finalizeWarningCode: 'nativeMarkerFinalizeFailed',
  });
}

export function createNativeTransactionMarkerDeleteStage(options: {
  pluginNameOrId: string;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionStage {
  return createAtomicDeleteStage({
    label: 'native transaction marker',
    filePath: getNativeTransactionMarkerPath(options.pluginNameOrId, options.env),
    rollbackWarningCode: 'nativeMarkerRollbackFailed',
    finalizeWarningCode: 'nativeMarkerFinalizeFailed',
  });
}

export function createSharedRuntimeOwnerWriteStage(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateTransactionStage> {
  return (async () => {
    const ownerPath = assertTestWritablePath(
      getSharedSkillTriggerRuntimeOwnerPath({
        pluginName: options.recordFile.record.pluginName,
        platform: options.recordFile.record.platform,
        env: options.env,
      }),
      'shared runtime owner',
      '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记 shared runtime owner 目标路径。',
    );
    const stagingPath = createTempPath(ownerPath, 'aw-staging');
    const backupPath = createTempPath(ownerPath, 'aw-backup');
    let committed = false;

    return {
      label: 'shared runtime owner',
      async commit() {
        if (committed) {
          return;
        }
        const value = await buildSharedRuntimeOwnerFromRecord({
          recordFile: options.recordFile,
          recordPath: options.recordPath,
        });
        validateSharedRuntimeOwnerOrThrow(value, ownerPath);
        await fs.ensureDir(path.dirname(ownerPath));
        await writeJsonFile(stagingPath, value);
        if (await fs.pathExists(ownerPath)) {
          await fs.move(ownerPath, backupPath, { overwrite: true });
        }
        await fs.move(stagingPath, ownerPath, { overwrite: true });
        committed = true;
      },
      async rollback() {
        try {
          if (committed) {
            if (await fs.pathExists(backupPath)) {
              await removePathIfExists(ownerPath);
              await fs.move(backupPath, ownerPath, { overwrite: true });
            } else {
              await removePathIfExists(ownerPath);
            }
          } else {
            await removePathIfExists(stagingPath);
          }
          return undefined;
        } catch (error) {
          return createWarning(
            'sharedRuntimeOwnerRollbackFailed',
            'Shared runtime owner rollback failed.',
            ownerPath,
            error,
          );
        }
      },
      async finalize() {
        try {
          await Promise.all([
            removePathIfExists(stagingPath),
            removePathIfExists(backupPath),
          ]);
          return undefined;
        } catch (error) {
          return createWarning(
            'sharedRuntimeOwnerFinalizeFailed',
            'Shared runtime owner finalize failed.',
            ownerPath,
            error,
          );
        }
      },
    };
  })();
}

export function createSharedRuntimeOwnerDeleteStage(options: {
  pluginName: string;
  platform: PluginLocation['platform'];
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionStage;
export function createSharedRuntimeOwnerDeleteStage(options: {
  filePath: string;
}): InstallStateTransactionStage;
export function createSharedRuntimeOwnerDeleteStage(options: {
  pluginName?: string;
  platform?: PluginLocation['platform'];
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}): InstallStateTransactionStage {
  const filePath = options.filePath ?? getSharedSkillTriggerRuntimeOwnerPath({
    pluginName: options.pluginName!,
    platform: options.platform!,
    env: options.env,
  });
  return createAtomicDeleteStage({
    label: 'shared runtime owner',
    filePath,
    rollbackWarningCode: 'sharedRuntimeOwnerRollbackFailed',
    finalizeWarningCode: 'sharedRuntimeOwnerFinalizeFailed',
  });
}

export async function writeNativeTransactionMarkerWithValidation(
  value: NativeTransactionMarker,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  validateNativeMarkerOrThrow(value);
  await writeNativeTransactionMarker(value, env);
}

export function createDeletePathPostCommitAction(options: {
  label: string;
  filePath: string;
  warningCode: string;
  warningMessage: string;
}): InstallStateTransactionPostCommitAction {
  const filePath = assertTestWritablePath(
    options.filePath,
    options.label,
    '用 createIsolatedTestEnv() 生成默认测试状态根，或通过 registerWritableStateRoot()/withSafeTestCwd() 登记当前写入目标。',
  );
  return {
    label: options.label,
    async run() {
      await removePathIfExists(filePath);
    },
    toWarning(error) {
      return createWarning(options.warningCode, options.warningMessage, filePath, error);
    },
  };
}

export function createDiagnosticCacheDeletePostCommitAction(options: {
  filePath: string;
}): InstallStateTransactionPostCommitAction;
export function createDiagnosticCacheDeletePostCommitAction(options: {
  cwd: string;
  location: PluginLocation;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionPostCommitAction;
export function createDiagnosticCacheDeletePostCommitAction(options: {
  filePath?: string;
  cwd?: string;
  location?: PluginLocation;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionPostCommitAction {
  const filePath = options.filePath ?? getDiagnosticCachePath(
    options.cwd!,
    options.location!,
    options.env,
  );
  return createDeletePathPostCommitAction({
    label: 'diagnostic cache delete',
    filePath,
    warningCode: 'diagnosticCacheDeleteFailed',
    warningMessage: 'Install record changed, but dynamic diagnostic cache cleanup failed.',
  });
}

export function createNativeTransactionMarkerDeletePostCommitAction(options: {
  pluginNameOrId: string;
  env?: NodeJS.ProcessEnv;
}): InstallStateTransactionPostCommitAction {
  const filePath = getNativeTransactionMarkerPath(options.pluginNameOrId, options.env);
  return createDeletePathPostCommitAction({
    label: 'native transaction marker delete',
    filePath,
    warningCode: 'nativeMarkerDeleteFailed',
    warningMessage: 'Install record committed, but native transaction marker cleanup failed.',
  });
}

export function createDependencyIndexPruneToken(options: {
  location: PluginLocation;
  recordPath: string;
  indexDigest: string;
}): string {
  return Buffer.from(JSON.stringify({
    location: options.location,
    recordPath: options.recordPath,
    indexDigest: options.indexDigest,
  }), 'utf8').toString('base64url');
}

export function parseDependencyIndexPruneToken(token: string): {
  location: PluginLocation;
  recordPath: string;
  indexDigest: string;
} {
  const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
    location: PluginLocation;
    recordPath: string;
    indexDigest: string;
  };
  return parsed;
}

export async function refreshDependencyIndexForRecord(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<{
  indexPath: string;
  indexDigest: string;
  pruneToken: string;
  value: Awaited<ReturnType<typeof upsertGlobalDependencyIndexRecord>>['value'];
}> {
  const result = await upsertGlobalDependencyIndexRecord({
    recordFile: options.recordFile,
    recordPath: options.recordPath,
    env: options.env,
    now: options.now,
  });
  return {
    indexPath: result.indexPath,
    indexDigest: result.indexDigest,
    pruneToken: createDependencyIndexPruneToken({
      location: result.record.location,
      recordPath: result.record.recordPath,
      indexDigest: result.indexDigest,
    }),
    value: result.value,
  };
}

export async function deleteDependencyIndexRecord(options: {
  location: PluginLocation;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<{
  indexPath: string;
  indexDigest: string;
  pruneToken: string;
  value: Awaited<ReturnType<typeof deleteGlobalDependencyIndexRecord>>['value'];
}> {
  const result = await deleteGlobalDependencyIndexRecord({
    location: options.location,
    recordPath: options.recordPath,
    env: options.env,
    now: options.now,
  });
  return {
    indexPath: result.indexPath,
    indexDigest: result.indexDigest,
    pruneToken: createDependencyIndexPruneToken({
      location: options.location,
      recordPath: options.recordPath,
      indexDigest: result.indexDigest,
    }),
    value: result.value,
  };
}

export interface InstallStateGraphRecordTransactionResult
  extends InstallStateTransactionResult {
  recordOperation: 'upsert' | 'delete';
  recordPath: string;
  dependencyIndex: InstallStateTransactionPostCommitResult;
  additionalPostCommit: InstallStateTransactionPostCommitResult[];
}

export async function runInstallStateGraphRecordTransaction(options:
  | {
    mode: 'upsert';
    stages: InstallStateTransactionStage[];
    recordFile: InstallRecordFile;
    recordPath: string;
    env?: NodeJS.ProcessEnv;
    postCommit?: InstallStateTransactionPostCommitAction[];
  }
  | {
    mode: 'delete';
    stages: InstallStateTransactionStage[];
    location: PluginLocation;
    recordPath: string;
    env?: NodeJS.ProcessEnv;
    postCommit?: InstallStateTransactionPostCommitAction[];
  },
): Promise<InstallStateGraphRecordTransactionResult> {
  const dependencyIndexPostCommit = createDependencyIndexRefreshPostCommitAction(
    options.mode === 'upsert'
      ? {
          mode: 'upsert',
          recordFile: options.recordFile,
          recordPath: options.recordPath,
          env: options.env,
        }
      : {
          mode: 'delete',
          location: options.location,
          recordPath: options.recordPath,
          env: options.env,
        },
  );
  const result = await runInstallStateTransaction({
    stages: options.stages,
    postCommit: [
      ...(options.postCommit ?? []),
      dependencyIndexPostCommit,
    ],
  });
  const dependencyIndex =
    result.postCommit.find((entry) => entry.label === dependencyIndexPostCommit.label);
  if (!dependencyIndex) {
    throw new Error('Missing dependency index post-commit result.');
  }
  return {
    ...result,
    recordOperation: options.mode,
    recordPath: options.recordPath,
    dependencyIndex,
    additionalPostCommit: result.postCommit.filter(
      (entry) => entry !== dependencyIndex,
    ),
  };
}

export function createDependencyIndexRefreshPostCommitAction(options:
  | {
    mode: 'upsert';
    recordFile: InstallRecordFile;
    recordPath: string;
    env?: NodeJS.ProcessEnv;
  }
  | {
    mode: 'delete';
    location: PluginLocation;
    recordPath: string;
    env?: NodeJS.ProcessEnv;
  },
): InstallStateTransactionPostCommitAction {
  return {
    label: 'dependency index refresh',
    async run() {
      if (options.mode === 'upsert') {
        await refreshDependencyIndexForRecord({
          recordFile: options.recordFile,
          recordPath: options.recordPath,
          env: options.env,
        });
        return;
      }
      await deleteDependencyIndexRecord({
        location: options.location,
        recordPath: options.recordPath,
        env: options.env,
      });
    },
    toWarning(error) {
      return createWarning(
        'dependencyIndexRefreshFailed',
        'Install record changed, but dependency index refresh failed.',
        getGlobalDependencyIndexPath(options.env),
        error,
      );
    },
  };
}
