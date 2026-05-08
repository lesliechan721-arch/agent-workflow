import path from 'node:path';

import fs from 'fs-extra';

import { resolveAwHome } from '../utils/paths.js';
import { readJsonFileIfExists, writeJsonFile } from '../utils/json.js';
import {
  getNativeTransactionMarkerPath,
  getProjectArtifactSharedIdentityPath,
  getSharedSkillTriggerRuntimeOwnerPath,
} from './paths.js';
import {
  validateDynamicArtifactDiagnosticCache,
  validateGlobalDependencyIndex,
  validateInstallRecordFile,
  validateNativeTransactionMarker,
  validateProjectArtifactIdentityFile,
  validateSharedSkillTriggerRuntimeOwner,
} from './schema.js';
import { sha256Hex } from './internal.js';
import { serializePluginLocation } from './ids.js';
import type {
  DynamicArtifactDiagnosticCache,
  GlobalDependencyIndex,
  GlobalDependencyIndexInspection,
  InstallRecordFile,
  InstallRecordInstallSource,
  GlobalDependencyIndexRecord,
  InstallStateReadResult,
  LegacyInstallStateEvidence,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityFile,
  ProjectArtifactSharedLocator,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';
import { getGlobalDependencyIndexPath, getInstallRecordPath, getDiagnosticCachePath } from './paths.js';

function unsupported(pathValue: string, code: string, error: string, legacyEvidence?: LegacyInstallStateEvidence): InstallStateReadResult<never> {
  return {
    status: 'unsupported',
    path: pathValue,
    code,
    error,
    ...(legacyEvidence ? { legacyEvidence } : {}),
  };
}

function invalid(pathValue: string, code: string, error: string): InstallStateReadResult<never> {
  return {
    status: 'invalid',
    path: pathValue,
    code,
    error,
  };
}

function createEmptyGlobalDependencyIndex(now: string): GlobalDependencyIndex {
  return {
    version: 1,
    updatedAt: now,
    records: [],
  };
}

function sameGlobalDependencyIndexRecordIdentity(
  left: GlobalDependencyIndexRecord,
  right: Pick<GlobalDependencyIndexRecord, 'location' | 'recordPath'>,
): boolean {
  return (
    left.recordPath === right.recordPath ||
    serializePluginLocation(left.location) === serializePluginLocation(right.location)
  );
}

async function readGlobalDependencyIndexForWrite(options: {
  env?: NodeJS.ProcessEnv;
  now?: string;
} = {}): Promise<{
  path: string;
  value: GlobalDependencyIndex;
}> {
  const filePath = getGlobalDependencyIndexPath(options.env);
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(filePath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (value === null) {
    return {
      path: filePath,
      value: createEmptyGlobalDependencyIndex(
        options.now ?? new Date().toISOString(),
      ),
    };
  }
  const validated = validateGlobalDependencyIndex(value);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return {
    path: filePath,
    value: validated.value,
  };
}

async function readFileSha256(filePath: string): Promise<string> {
  return sha256Hex(await fs.readFile(filePath));
}

export function createInstallRecordInstallSource(
  kind: 'explicit' | 'dependency',
): InstallRecordInstallSource {
  return kind === 'explicit'
    ? {
        kind: 'explicit',
        explicitlyRequested: true,
      }
    : {
        kind: 'dependency',
        explicitlyRequested: false,
      };
}

export function markInstallRecordInstallSourceExplicitlyRequested(
  installSource: InstallRecordInstallSource | undefined,
): InstallRecordInstallSource {
  return {
    kind: installSource?.kind ?? 'explicit',
    explicitlyRequested: true,
  };
}

export function buildGlobalDependencyIndexRecord(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  recordDigest: string;
  now: string;
}): GlobalDependencyIndexRecord {
  const location: PluginLocation = {
    plugin: options.recordFile.record.pluginName,
    platform: options.recordFile.record.platform,
    scope: options.recordFile.record.scope,
    ...(options.recordFile.record.scope === 'project'
      ? { projectKey: options.recordFile.record.projectKey }
      : {}),
  };
  return {
    location,
    recordPath: options.recordPath,
    recordDigest: options.recordDigest,
    installSource: options.recordFile.record.installSource,
    dependencyEdges: options.recordFile.record.dependencyEdges,
    lastSeenAt: options.now,
  };
}

export async function readInstallRecordFileAt(
  filePath: string,
  options: {
    env?: NodeJS.ProcessEnv;
    awHome?: string;
  } = {},
): Promise<InstallStateReadResult<InstallRecordFile>> {
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(filePath);
  } catch (error) {
    return invalid(filePath, 'invalidJson', error instanceof Error ? error.message : String(error));
  }
  if (value === null) {
    return { status: 'missing', path: filePath, code: 'missing', error: 'Install record file does not exist.' };
  }
  const validated = validateInstallRecordFile(value, {
    expectedPath: filePath,
    env: options.env,
    awHome: options.awHome,
  });
  if (!validated.ok) {
    return validated.code === 'unsupportedLegacyField' || validated.code === 'unsupportedVersion'
      ? unsupported(filePath, validated.code, validated.error)
      : invalid(filePath, validated.code, validated.error);
  }
  return { status: 'ok', path: filePath, value: validated.value };
}

export async function writeInstallRecordFileAt(
  filePath: string,
  value: InstallRecordFile,
  options: {
    env?: NodeJS.ProcessEnv;
    awHome?: string;
  } = {},
): Promise<void> {
  const validated = validateInstallRecordFile(value, {
    expectedPath: filePath,
    env: options.env,
    awHome: options.awHome,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(filePath, validated.value);
}

export async function readInstallRecordForLocation(options: {
  cwd: string;
  location: PluginLocation;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateReadResult<InstallRecordFile>> {
  return readInstallRecordFileAt(
    getInstallRecordPath(options.cwd, options.location, options.env),
    { env: options.env },
  );
}

export async function readDynamicArtifactDiagnosticCacheAt(
  filePath: string,
  options: {
    currentRecord?: InstallRecordFile;
    expectedLocation?: PluginLocation;
  } = {},
): Promise<InstallStateReadResult<DynamicArtifactDiagnosticCache>> {
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(filePath);
  } catch (error) {
    return {
      status: 'unavailable',
      path: filePath,
      code: 'invalidJson',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (value === null) {
    return {
      status: 'unavailable',
      path: filePath,
      code: 'missing',
      error: 'Dynamic diagnostic cache does not exist.',
    };
  }
  const validated = validateDynamicArtifactDiagnosticCache(value, {
    expectedRecordId: options.currentRecord?.recordId,
    expectedLocation: options.expectedLocation ?? (
      options.currentRecord
        ? {
          plugin: options.currentRecord.record.pluginName,
          platform: options.currentRecord.record.platform,
          scope: options.currentRecord.record.scope,
          ...(options.currentRecord.record.scope === 'project'
            ? { projectKey: options.currentRecord.record.projectKey }
            : {}),
        }
        : undefined
    ),
    currentRecord: options.currentRecord,
  });
  if (!validated.ok) {
    return {
      status: 'unavailable',
      path: filePath,
      code: validated.code,
      error: validated.error,
    };
  }
  return { status: 'ok', path: filePath, value: validated.value };
}

export async function readDynamicArtifactDiagnosticCacheForLocation(options: {
  cwd: string;
  location: PluginLocation;
  currentRecord?: InstallRecordFile;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStateReadResult<DynamicArtifactDiagnosticCache>> {
  return readDynamicArtifactDiagnosticCacheAt(
    getDiagnosticCachePath(options.cwd, options.location, options.env),
    {
      currentRecord: options.currentRecord,
      expectedLocation: options.location,
    },
  );
}

export async function writeDynamicArtifactDiagnosticCacheAt(
  filePath: string,
  value: DynamicArtifactDiagnosticCache,
  currentRecord?: InstallRecordFile,
): Promise<void> {
  const validated = validateDynamicArtifactDiagnosticCache(value, {
    expectedRecordId: currentRecord?.recordId,
    currentRecord,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(filePath, validated.value);
}

export async function readProjectArtifactIdentityFileAt(
  filePath: string,
  options: {
    projectKey?: string | null;
    cwd?: string;
    homeDir?: string;
  } = {},
): Promise<InstallStateReadResult<ProjectArtifactIdentityFile>> {
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(filePath);
  } catch (error) {
    return invalid(filePath, 'invalidJson', error instanceof Error ? error.message : String(error));
  }
  if (value === null) {
    return { status: 'missing', path: filePath, code: 'missing', error: 'Project artifact identity file does not exist.' };
  }
  const validated = validateProjectArtifactIdentityFile(value, { ...options, expectedPath: filePath });
  if (!validated.ok) {
    return validated.code === 'unsupportedVersion'
      ? unsupported(filePath, validated.code, validated.error)
      : invalid(filePath, validated.code, validated.error);
  }
  return { status: 'ok', path: filePath, value: validated.value };
}

export async function writeProjectArtifactIdentityFileAt(
  filePath: string,
  value: ProjectArtifactIdentityFile,
): Promise<void> {
  const validated = validateProjectArtifactIdentityFile(value, { expectedPath: filePath });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(filePath, validated.value);
}

export async function readProjectArtifactIdentityForLocator(options: {
  repoRoot: string;
  locator: ProjectArtifactSharedLocator;
  projectKey?: string | null;
  cwd?: string;
  homeDir?: string;
}): Promise<InstallStateReadResult<ProjectArtifactIdentityFile>> {
  return readProjectArtifactIdentityFileAt(
    getProjectArtifactSharedIdentityPath({
      repoRoot: options.repoRoot,
      locator: options.locator,
    }),
    {
      projectKey: options.projectKey,
      cwd: options.cwd,
      homeDir: options.homeDir,
    },
  );
}

export async function inspectGlobalDependencyIndex(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GlobalDependencyIndexInspection> {
  const indexPath = getGlobalDependencyIndexPath(env);
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(indexPath);
  } catch (error) {
    return {
      status: 'corrupted',
      path: indexPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (value === null) {
    return { status: 'missing', path: indexPath };
  }
  const validated = validateGlobalDependencyIndex(value);
  if (!validated.ok) {
    return {
      status: 'corrupted',
      path: indexPath,
      error: validated.error,
    };
  }
  const references = await Promise.all(validated.value.records.map(async (record) => {
    if (!(await fs.pathExists(record.recordPath))) {
      return {
        recordPath: record.recordPath,
        location: record.location,
        status: 'staleCandidate' as const,
        error: 'Referenced record file does not exist.',
      };
    }
    const readResult = await readInstallRecordFileAt(record.recordPath, { env });
    if (readResult.status !== 'ok') {
      return {
        recordPath: record.recordPath,
        location: record.location,
        status: 'unreadableReference' as const,
        error: readResult.error,
      };
    }
    const recordDigest = sha256Hex(await fs.readFile(record.recordPath));
    if (recordDigest !== record.recordDigest) {
      return {
        recordPath: record.recordPath,
        location: record.location,
        status: 'unreadableReference' as const,
        error: 'Referenced record digest does not match the dependency index entry.',
      };
    }
    return {
      recordPath: record.recordPath,
      location: record.location,
      status: 'verified' as const,
    };
  }));

  return {
    status: 'ok',
    path: indexPath,
    value: validated.value,
    references,
  };
}

export async function writeGlobalDependencyIndex(
  value: GlobalDependencyIndex,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const validated = validateGlobalDependencyIndex(value);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(getGlobalDependencyIndexPath(env), validated.value);
}

export async function upsertGlobalDependencyIndexRecord(options: {
  recordFile: InstallRecordFile;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<{
  indexPath: string;
  indexDigest: string;
  record: GlobalDependencyIndexRecord;
  value: GlobalDependencyIndex;
}> {
  const now = options.now ?? new Date().toISOString();
  const { path: indexPath, value: currentIndex } = await readGlobalDependencyIndexForWrite({
    env: options.env,
    now,
  });
  const recordDigest = await readFileSha256(options.recordPath);
  const nextRecord = buildGlobalDependencyIndexRecord({
    recordFile: options.recordFile,
    recordPath: options.recordPath,
    recordDigest,
    now,
  });
  const nextIndex: GlobalDependencyIndex = {
    version: 1,
    updatedAt: now,
    records: currentIndex.records
      .filter((entry) =>
        !sameGlobalDependencyIndexRecordIdentity(entry, nextRecord))
      .concat(nextRecord),
  };
  await writeGlobalDependencyIndex(nextIndex, options.env);
  return {
    indexPath,
    indexDigest: await readFileSha256(indexPath),
    record: nextRecord,
    value: nextIndex,
  };
}

export async function deleteGlobalDependencyIndexRecord(options: {
  location: PluginLocation;
  recordPath: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<{
  indexPath: string;
  indexDigest: string;
  value: GlobalDependencyIndex;
}> {
  const now = options.now ?? new Date().toISOString();
  const { path: indexPath, value: currentIndex } = await readGlobalDependencyIndexForWrite({
    env: options.env,
    now,
  });
  const nextIndex: GlobalDependencyIndex = {
    version: 1,
    updatedAt: now,
    records: currentIndex.records.filter((entry) =>
      !sameGlobalDependencyIndexRecordIdentity(entry, {
        location: options.location,
        recordPath: options.recordPath,
      })),
  };
  await writeGlobalDependencyIndex(nextIndex, options.env);
  return {
    indexPath,
    indexDigest: await readFileSha256(indexPath),
    value: nextIndex,
  };
}

export async function readNativeTransactionMarker(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstallStateReadResult<NativeTransactionMarker>> {
  const markerPath = getNativeTransactionMarkerPath(pluginNameOrId, env);
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(markerPath);
  } catch (error) {
    return invalid(markerPath, 'invalidJson', error instanceof Error ? error.message : String(error));
  }
  if (value === null) {
    return { status: 'missing', path: markerPath, code: 'missing', error: 'Native transaction marker does not exist.' };
  }
  const validated = validateNativeTransactionMarker(value);
  if (!validated.ok) {
    return validated.code === 'unsupportedLegacyFormat'
      ? unsupported(markerPath, validated.code, validated.error, {
        kind: 'codexNativeBreadcrumb',
        path: markerPath,
        reason: validated.error,
      })
      : invalid(markerPath, validated.code, validated.error);
  }
  return { status: 'ok', path: markerPath, value: validated.value };
}

export async function writeNativeTransactionMarker(
  value: NativeTransactionMarker,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const validated = validateNativeTransactionMarker(value);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(getNativeTransactionMarkerPath(value.pluginId, env), validated.value);
}

export async function readSharedSkillTriggerRuntimeOwner(
  options: {
    pluginName: string;
    platform: PluginLocation['platform'];
    env?: NodeJS.ProcessEnv;
  },
): Promise<InstallStateReadResult<SharedSkillTriggerRuntimeOwner>> {
  const ownerPath = getSharedSkillTriggerRuntimeOwnerPath(options);
  let value: unknown;
  try {
    value = await readJsonFileIfExists<unknown>(ownerPath);
  } catch (error) {
    return invalid(ownerPath, 'invalidJson', error instanceof Error ? error.message : String(error));
  }
  if (value === null) {
    return { status: 'missing', path: ownerPath, code: 'missing', error: 'Shared runtime owner file does not exist.' };
  }
  const validated = validateSharedSkillTriggerRuntimeOwner(value, { expectedPath: ownerPath });
  if (!validated.ok) {
    return invalid(ownerPath, validated.code, validated.error);
  }
  return { status: 'ok', path: ownerPath, value: validated.value };
}

export async function writeSharedSkillTriggerRuntimeOwner(
  options: {
    pluginName: string;
    platform: PluginLocation['platform'];
    value: SharedSkillTriggerRuntimeOwner;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const ownerPath = getSharedSkillTriggerRuntimeOwnerPath(options);
  const validated = validateSharedSkillTriggerRuntimeOwner(options.value, { expectedPath: ownerPath });
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await writeJsonFile(ownerPath, validated.value);
}

export async function detectLegacyInstalledLedger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyInstallStateEvidence | null> {
  const ledgerPath = path.join(resolveAwHome(env), 'installed.json');
  if (!(await fs.pathExists(ledgerPath))) {
    return null;
  }
  return {
    kind: 'installedLedger',
    path: ledgerPath,
    reason: 'Legacy installed.json is unsupported and is not migrated into install-state records.',
  };
}

export async function detectLegacyTrackingManifest(
  trackingDir: string,
): Promise<LegacyInstallStateEvidence | null> {
  const trackingPath = path.join(trackingDir, '.agent-workflows-manifest.json');
  if (!(await fs.pathExists(trackingPath))) {
    return null;
  }
  return {
    kind: 'trackingManifest',
    path: trackingPath,
    reason: 'Legacy tracking manifest is unsupported and is not migrated into install-state state files.',
  };
}
