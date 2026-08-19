import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  ArtifactState,
  ArtifactTarget,
  GeneratedArtifact,
  PlatformName,
  PluginLifecycleEvent,
  PluginManifestSource,
  PluginMeta,
  Scope,
  TrackedHookGroupIdentity,
} from '../types.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprintV2,
} from './bundle-integrity.js';
import {
  acquireActiveMarketplaceLifecycleLeaseAtRoot,
  releaseActiveMarketplaceCoordinationLease,
  resolveActiveMarketplaceRuntimeCoordinationRoot,
  withActiveMarketplaceLifecycleLease,
} from './active-marketplace-runtime-lock.js';
import { PLUGIN_LIFECYCLE_EVENTS } from './plugin-script-contract.js';
import {
  acquireProcessLock,
  type ProcessLockFileSystem,
  type ProcessLockLease,
} from './process-lock.js';
import {
  getClaudeHome,
  getCodexHome,
  resolveAwHome,
  resolveAwHomeCanonical,
  resolveRepoRoot,
} from './state-paths.js';
import { assertTestWritablePath } from './test-path-fence.js';

export const LIFECYCLE_ACTIVE_DIR = 'lifecycle-active';
export const LIFECYCLE_ACTIVE_SCHEMA_VERSION = 2;
export const LIFECYCLE_ACTIVE_METADATA_FILE = 'metadata.json';
const SOURCE_MANIFEST_PATH = path.join('.agents-plugin', 'plugin.json');

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGE_ID_PATTERN = /^stage-[0-9a-f]{24}$/;
const BACKUP_ID_PATTERN = /^backup-[0-9a-f]{24}$/;
const ARTIFACT_KINDS = new Set<GeneratedArtifact['kind']>([
  'instruction',
  'permission',
  'hook',
  'agent',
  'skill',
  'mcpServer',
]);
const ARTIFACT_TARGETS = new Set<ArtifactTarget>([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
  'codex.skill',
  'claude.skill',
]);
const ARTIFACT_STATES = new Set<ArtifactState>(['present', 'disabled']);

export interface LifecycleActiveTargetIdentity {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
  locationKey: string;
}

export interface LifecycleArtifactOwnerIdentity {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
}

export interface LifecycleActiveArtifactDescriptor {
  path: string;
  paths?: string[];
  kind: GeneratedArtifact['kind'];
  platform: PlatformName;
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: ArtifactTarget;
  state?: ArtifactState;
  refreshKeys?: string[];
  roleKey?: string;
  owner: LifecycleArtifactOwnerIdentity;
}

interface LifecycleActiveMetadataPayload {
  schemaVersion: 1 | 2;
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  pluginVersion: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
  sourceManifestDigest: string;
  fingerprintVersion: 2;
  bundleFingerprint: string;
  events: PluginLifecycleEvent[];
  artifacts: LifecycleActiveArtifactDescriptor[];
}

export interface LifecycleActiveMetadata extends LifecycleActiveMetadataPayload {
  metadataIntegrityDigest: string;
}

export interface LifecycleActiveTarget extends LifecycleActiveTargetIdentity {
  awHome: string;
  coordinationRoot: string;
  storeRoot: string;
  targetRoot: string;
  activeRoot: string;
  stagingRoot: string;
  lockPath: string;
  operationLockPath: string;
  artifactOutputRoots: string[];
  pathAliases: Array<{ source: string; canonical: string }>;
}

export interface StagedLifecycleActiveSnapshot {
  status: 'staged';
  target: LifecycleActiveTarget;
  stageId: string;
  stageRoot: string;
  metadata: LifecycleActiveMetadata;
}

export interface LifecycleActiveSnapshotNotRequired {
  status: 'not-required';
  reason: 'no-uninstall-lifecycle';
  target: LifecycleActiveTarget;
}

export type PreparedLifecycleActiveSnapshot =
  | StagedLifecycleActiveSnapshot
  | LifecycleActiveSnapshotNotRequired;

export interface ReadLifecycleActiveSnapshot {
  target: LifecycleActiveTarget;
  activeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  metadata: LifecycleActiveMetadata;
  plugin: PluginMeta;
  artifacts: GeneratedArtifact[];
}

export interface LifecycleActiveScriptInputs {
  currentPlugin: PluginMeta;
  artifacts: GeneratedArtifact[];
}

export type LifecycleActivePluginLoader = (
  bundleRoot: string,
  manifestPath: string,
) => Promise<PluginMeta>;

const preparedContexts = new WeakMap<PreparedLifecycleActiveSnapshot, {
  lock: ProcessLockLease;
  loadPlugin: LifecycleActivePluginLoader;
}>();
const readContexts = new WeakMap<ReadLifecycleActiveSnapshot, ProcessLockLease>();
const releasedReads = new WeakSet<ReadLifecycleActiveSnapshot>();
const finalizedPrepared = new WeakSet<PreparedLifecycleActiveSnapshot>();
let beforePruneStagingRootForTests: (() => Promise<void>) | undefined;
let processLockFileSystemForTests: ProcessLockFileSystem | undefined;

export function setLifecycleActiveBeforePruneForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  beforePruneStagingRootForTests = hook;
}

export function setLifecycleActiveLockFileSystemForTests(
  fileSystem: ProcessLockFileSystem | undefined,
): void {
  processLockFileSystemForTests = fileSystem;
}

export class LifecycleActiveSnapshotError extends Error {
  readonly code = 'invalidLifecycleActiveSnapshot';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LifecycleActiveSnapshotError';
  }
}

function fail(message: string): never {
  throw new LifecycleActiveSnapshotError(message);
}

function isInsidePath(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsidePath(childPath: string, rootPath: string, fieldName: string): void {
  if (!isInsidePath(path.resolve(childPath), path.resolve(rootPath))) {
    fail(`${fieldName} is outside its allowed lifecycle root.`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldName: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      fail(`${fieldName} contains unknown field "${key}".`);
    }
  }
}

function expectRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function expectOptionalString(value: unknown, fieldName: string): string | undefined {
  return value === undefined ? undefined : expectString(value, fieldName);
}

function expectPlatform(value: unknown, fieldName: string): PlatformName {
  if (value !== 'codex' && value !== 'claude') {
    fail(`${fieldName} must be "codex" or "claude".`);
  }
  return value;
}

function expectScope(value: unknown, fieldName: string): Scope {
  if (value !== 'user' && value !== 'project') {
    fail(`${fieldName} must be "user" or "project".`);
  }
  return value;
}

function assertPluginName(pluginName: string): void {
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    fail(`Invalid lifecycle active plugin name "${pluginName}".`);
  }
}

export function createLifecycleProjectLocationKey(projectKey: string): string {
  const readable = path.basename(projectKey)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = crypto.createHash('sha256').update(projectKey).digest('hex').slice(0, 24);
  return `project-${readable || 'root'}-${digest}`;
}

async function resolveCanonicalProjectRoot(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  try {
    return await fs.realpath(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

async function canonicalizePathThroughExistingAncestor(inputPath: string): Promise<string> {
  let current = path.resolve(inputPath);
  const missingSegments: string[] = [];
  while (!await fs.pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(inputPath);
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(await fs.realpath(current), ...missingSegments);
}

function assertWritableStorePath(targetPath: string): string {
  return assertTestWritablePath(
    targetPath,
    'lifecycle active store',
    'Use an isolated AW_HOME or register the lifecycle active root as writable.',
  );
}

export async function resolveLifecycleActiveTarget(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LifecycleActiveTarget> {
  assertPluginName(options.pluginName);
  if (options.sourceId !== undefined) {
    assertPluginName(options.sourceId);
    if (!options.sourceIdentity) fail('sourceIdentity is required for a namespaced lifecycle target.');
  }
  const platform = expectPlatform(options.platform, 'platform');
  const scope = expectScope(options.scope, 'scope');
  const env = options.env ?? process.env;
  const rawAwHome = path.resolve(resolveAwHome(env));
  const awHome = await canonicalizePathThroughExistingAncestor(
    await resolveAwHomeCanonical(env),
  );
  const rawProjectRoot = scope === 'project'
    ? path.resolve(await resolveRepoRoot(options.cwd))
    : null;
  const projectKey = rawProjectRoot ? await resolveCanonicalProjectRoot(options.cwd) : null;
  const rawPlatformHome = path.resolve(platform === 'codex' ? getCodexHome(env) : getClaudeHome(env));
  const platformHome = await canonicalizePathThroughExistingAncestor(rawPlatformHome);
  const locationKey = projectKey ? createLifecycleProjectLocationKey(projectKey) : 'user';
  const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(env);
  const storeRoot = assertWritableStorePath(path.join(awHome, LIFECYCLE_ACTIVE_DIR));
  const targetRoot = assertWritableStorePath(path.join(
    storeRoot,
    ...(options.sourceId ? [options.sourceId] : []),
    platform,
    scope,
    locationKey,
    options.pluginName,
  ));
  const lockParent = assertWritableStorePath(path.join(
    coordinationRoot,
    'lifecycle-locks',
    platform,
    scope,
    locationKey,
  ));
  const lockPath = assertWritableStorePath(path.join(
    lockParent,
    `.${options.sourceId ? `${options.sourceId}.` : ''}${options.pluginName}.lock`,
  ));
  const operationLockPath = assertWritableStorePath(path.join(
    lockParent,
    `.${options.sourceId ? `${options.sourceId}.` : ''}${options.pluginName}.operation.lock`,
  ));
  return {
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginId: `${options.sourceId}/${options.pluginName}`,
    } : {}),
    pluginName: options.pluginName,
    platform,
    scope,
    projectKey,
    locationKey,
    awHome,
    coordinationRoot,
    storeRoot,
    targetRoot,
    activeRoot: path.join(targetRoot, 'active'),
    stagingRoot: path.join(targetRoot, 'staging'),
    lockPath,
    operationLockPath,
    artifactOutputRoots: [awHome, platformHome, ...(projectKey ? [projectKey] : [])],
    pathAliases: [
      { source: rawAwHome, canonical: awHome },
      { source: rawPlatformHome, canonical: platformHome },
      ...(rawProjectRoot && projectKey
        ? [{ source: rawProjectRoot, canonical: projectKey }]
        : []),
    ],
  };
}

async function lstatIfExists(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function assertExistingPathChainHasNoSymlinks(
  rootPath: string,
  targetPath: string,
): Promise<void> {
  assertInsidePath(targetPath, rootPath, 'store path');
  const rootStat = await lstatIfExists(rootPath);
  if (rootStat?.isSymbolicLink()) {
    fail(`Lifecycle active store path contains a symbolic link: ${rootPath}`);
  }
  if (rootStat && !rootStat.isDirectory()) {
    fail(`Lifecycle active store path is not a directory: ${rootPath}`);
  }
  if (!rootStat) {
    return;
  }

  let current = rootPath;
  for (const segment of path.relative(rootPath, targetPath).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      fail(`Lifecycle active store path contains a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      fail(`Lifecycle active store path is not a directory: ${current}`);
    }
  }
}

async function assertExistingDirectoryBoundary(
  target: LifecycleActiveTarget,
  candidatePath: string,
  fieldName: string,
): Promise<void> {
  await assertExistingPathChainHasNoSymlinks(target.awHome, candidatePath);
  const stat = await lstatIfExists(candidatePath);
  if (!stat) {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${fieldName} must be a regular directory.`);
  }
  const [realStoreRoot, realCandidate] = await Promise.all([
    fs.realpath(target.storeRoot),
    fs.realpath(candidatePath),
  ]);
  if (!isInsidePath(realCandidate, realStoreRoot) || realCandidate !== path.resolve(candidatePath)) {
    fail(`${fieldName} escapes the canonical lifecycle active store.`);
  }
}

async function acquireTargetLock(
  target: LifecycleActiveTarget,
  lifecycleLeaseHeld = false,
): Promise<ProcessLockLease> {
  const lifecycleLease = lifecycleLeaseHeld
    ? undefined
    : await acquireActiveMarketplaceLifecycleLeaseAtRoot(target.coordinationRoot);
  const lockParent = path.dirname(target.lockPath);
  let targetLease: ProcessLockLease;
  try {
    await assertExistingPathChainHasNoSymlinks(target.coordinationRoot, lockParent);
    await fs.ensureDir(lockParent);
    await assertExistingPathChainHasNoSymlinks(target.coordinationRoot, lockParent);
    targetLease = await acquireProcessLock({
      lockPath: target.lockPath,
      fileSystem: processLockFileSystemForTests,
    });
  } catch (error) {
    try {
      if (lifecycleLease) await releaseActiveMarketplaceCoordinationLease(lifecycleLease);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Lifecycle target lock acquisition and lifecycle lease release both failed.',
        { cause: error },
      );
    }
    throw error;
  }

  let targetReleased = false;
  let lifecycleReleased = false;
  return {
    lockPath: targetLease.lockPath,
    owner: targetLease.owner,
    release: async () => {
      if (!targetReleased) {
        await targetLease.release();
        targetReleased = true;
      }
      if (lifecycleLease && !lifecycleReleased) {
        await lifecycleLease.release();
        lifecycleReleased = true;
      }
    },
  };
}

export async function acquireLifecycleOperationLock(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessLockLease> {
  const target = await resolveLifecycleActiveTarget(options);
  const lockParent = path.dirname(target.operationLockPath);
  await assertExistingPathChainHasNoSymlinks(target.coordinationRoot, lockParent);
  await fs.ensureDir(lockParent);
  await assertExistingPathChainHasNoSymlinks(target.coordinationRoot, lockParent);
  return acquireProcessLock({
    lockPath: target.operationLockPath,
    fileSystem: processLockFileSystemForTests,
  });
}

async function assertNoSymlinks(rootPath: string): Promise<void> {
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`Lifecycle active snapshot root is not a regular directory: ${rootPath}`);
  }
  for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      fail(`Lifecycle active snapshot contains a symbolic link: ${entryPath}`);
    }
    if (stat.isDirectory()) {
      await assertNoSymlinks(entryPath);
    } else if (!stat.isFile()) {
      fail(`Lifecycle active snapshot contains a special file: ${entryPath}`);
    }
  }
}

function lifecycleEvents(manifest: PluginManifestSource): PluginLifecycleEvent[] {
  return PLUGIN_LIFECYCLE_EVENTS.filter((event) => manifest.scripts?.lifecycle?.[event] !== undefined);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function calculateMetadataIntegrityDigest(payload: LifecycleActiveMetadataPayload): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function assertAbsoluteNormalizedPath(value: string, fieldName: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${fieldName} must be an absolute normalized path.`);
  }
}

function assertArtifactOutputPath(
  value: string,
  outputRoots: readonly string[],
  fieldName: string,
): void {
  assertAbsoluteNormalizedPath(value, fieldName);
  if (!outputRoots.some((root) => isInsidePath(value, root))) {
    fail(`${fieldName} is outside the lifecycle target output roots.`);
  }
}

function canonicalizeArtifactPath(value: string, target: LifecycleActiveTarget): string {
  let aliasedValue = value;
  for (const alias of target.pathAliases) {
    if (isInsidePath(value, alias.source)) {
      aliasedValue = path.join(alias.canonical, path.relative(alias.source, value));
      break;
    }
  }
  let existingAncestor = aliasedValue;
  const missingSegments: string[] = [];
  while (true) {
    try {
      fs.lstatSync(existingAncestor);
      try {
        return path.join(fs.realpathSync(existingAncestor), ...missingSegments);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          fail(`Artifact path crosses a dangling symbolic link: ${existingAncestor}`);
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    missingSegments.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return aliasedValue;
    existingAncestor = parent;
  }
}

function descriptorIdentityKeys(artifact: LifecycleActiveArtifactDescriptor): string[] {
  const keys = [
    artifact.id ? `${artifact.kind}:id:${artifact.id}` : null,
    artifact.artifactKey ? `${artifact.kind}:artifactKey:${artifact.artifactKey}` : null,
    artifact.roleKey ? `${artifact.kind}:roleKey:${artifact.roleKey}` : null,
  ].filter((key): key is string => key !== null);
  return keys.length > 0 ? keys : [`${artifact.kind}:path:${artifact.path}`];
}

function createArtifactDescriptors(
  artifacts: readonly GeneratedArtifact[],
  target: LifecycleActiveTarget,
): LifecycleActiveArtifactDescriptor[] {
  const outputRoots = target.artifactOutputRoots;
  const owner: LifecycleArtifactOwnerIdentity = {
    ...(target.sourceId ? {
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      pluginId: target.pluginId,
    } : {}),
    pluginName: target.pluginName,
    platform: target.platform,
    scope: target.scope,
    projectKey: target.projectKey,
  };
  const identities = new Set<string>();

  return artifacts.map((artifact, index) => {
    if (artifact.platform !== target.platform || !ARTIFACT_KINDS.has(artifact.kind)) {
      fail(`artifacts[${index}] does not match the lifecycle target platform or kind.`);
    }
    const artifactPath = canonicalizeArtifactPath(artifact.path, target);
    assertArtifactOutputPath(artifactPath, outputRoots, `artifacts[${index}].path`);
    const paths = artifact.paths?.map((entryPath, pathIndex) => {
      const canonicalPath = canonicalizeArtifactPath(entryPath, target);
      assertArtifactOutputPath(canonicalPath, outputRoots, `artifacts[${index}].paths[${pathIndex}]`);
      return canonicalPath;
    });
    if (paths && new Set(paths).size !== paths.length) {
      fail(`artifacts[${index}].paths contains duplicates.`);
    }
    for (const [fieldName, value] of [
      ['artifactKey', artifact.artifactKey],
      ['id', artifact.id],
      ['roleKey', artifact.roleKey],
    ] as const) {
      if (value !== undefined && value.length === 0) {
        fail(`artifacts[${index}].${fieldName} must be a non-empty string.`);
      }
    }
    if (artifact.target !== undefined && !ARTIFACT_TARGETS.has(artifact.target)) {
      fail(`artifacts[${index}].target is invalid.`);
    }
    if (artifact.state !== undefined && !ARTIFACT_STATES.has(artifact.state)) {
      fail(`artifacts[${index}].state is invalid.`);
    }
    const descriptor: LifecycleActiveArtifactDescriptor = {
      path: artifactPath,
      ...(paths ? { paths } : {}),
      kind: artifact.kind,
      platform: artifact.platform,
      ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
      ...(artifact.hookGroups ? { hookGroups: artifact.hookGroups.map((group) => ({ ...group })) } : {}),
      ...(artifact.id ? { id: artifact.id } : {}),
      ...(artifact.target ? { target: artifact.target } : {}),
      ...(artifact.state ? { state: artifact.state } : {}),
      ...(artifact.refreshKeys ? { refreshKeys: [...artifact.refreshKeys] } : {}),
      ...(artifact.roleKey ? { roleKey: artifact.roleKey } : {}),
      owner: { ...owner },
    };
    for (const identity of descriptorIdentityKeys(descriptor)) {
      if (identities.has(identity)) {
        fail(`artifacts[${index}] duplicates another lifecycle artifact identity.`);
      }
      identities.add(identity);
    }
    return descriptor;
  });
}

function parseStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(`${fieldName} must be an array.`);
  }
  const parsed = value.map((entry, index) => expectString(entry, `${fieldName}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    fail(`${fieldName} contains duplicates.`);
  }
  return parsed;
}

function parseHookGroups(value: unknown, fieldName: string): TrackedHookGroupIdentity[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(`${fieldName} must be an array.`);
  }
  const identities = new Set<string>();
  return value.map((entry, index) => {
    const group = expectRecord(entry, `${fieldName}[${index}]`);
    assertAllowedKeys(group, ['event', 'matcher', 'command'], `${fieldName}[${index}]`);
    const parsed: TrackedHookGroupIdentity = {
      event: expectString(group.event, `${fieldName}[${index}].event`),
      ...(group.matcher === undefined
        ? {}
        : { matcher: expectString(group.matcher, `${fieldName}[${index}].matcher`) }),
      command: expectString(group.command, `${fieldName}[${index}].command`),
    };
    const identity = `${parsed.event}\0${parsed.matcher ?? ''}\0${parsed.command}`;
    if (identities.has(identity)) {
      fail(`${fieldName} contains duplicate hook group identities.`);
    }
    identities.add(identity);
    return parsed;
  });
}

function parseArtifactDescriptors(
  value: unknown,
  target: LifecycleActiveTarget,
): LifecycleActiveArtifactDescriptor[] {
  if (!Array.isArray(value)) {
    fail('metadata.artifacts must be an array.');
  }
  const outputRoots = target.artifactOutputRoots;
  const identities = new Set<string>();
  return value.map((entry, index) => {
    const fieldName = `metadata.artifacts[${index}]`;
    const artifact = expectRecord(entry, fieldName);
    assertAllowedKeys(artifact, [
      'path', 'paths', 'kind', 'platform', 'artifactKey', 'hookGroups', 'id', 'target',
      'state', 'refreshKeys', 'roleKey', 'owner',
    ], fieldName);
    if (!ARTIFACT_KINDS.has(artifact.kind as GeneratedArtifact['kind'])) {
      fail(`${fieldName}.kind is invalid.`);
    }
    const platform = expectPlatform(artifact.platform, `${fieldName}.platform`);
    if (platform !== target.platform) {
      fail(`${fieldName}.platform does not match the lifecycle target.`);
    }
    const artifactPath = expectString(artifact.path, `${fieldName}.path`);
    const canonicalArtifactPath = canonicalizeArtifactPath(artifactPath, target);
    assertArtifactOutputPath(canonicalArtifactPath, outputRoots, `${fieldName}.path`);
    if (canonicalArtifactPath !== artifactPath) {
      fail(`${fieldName}.path is not canonical or crosses a symbolic link.`);
    }
    const paths = parseStringArray(artifact.paths, `${fieldName}.paths`);
    paths?.forEach((entryPath, pathIndex) => {
      const canonicalPath = canonicalizeArtifactPath(entryPath, target);
      assertArtifactOutputPath(canonicalPath, outputRoots, `${fieldName}.paths[${pathIndex}]`);
      if (canonicalPath !== entryPath) {
        fail(`${fieldName}.paths[${pathIndex}] is not canonical or crosses a symbolic link.`);
      }
    });
    const targetValue = artifact.target === undefined
      ? undefined
      : expectString(artifact.target, `${fieldName}.target`) as ArtifactTarget;
    if (targetValue && !ARTIFACT_TARGETS.has(targetValue)) {
      fail(`${fieldName}.target is invalid.`);
    }
    const state = artifact.state === undefined
      ? undefined
      : expectString(artifact.state, `${fieldName}.state`) as ArtifactState;
    if (state && !ARTIFACT_STATES.has(state)) {
      fail(`${fieldName}.state is invalid.`);
    }
    const owner = expectRecord(artifact.owner, `${fieldName}.owner`);
    assertAllowedKeys(owner, [
      'sourceId', 'sourceIdentity', 'pluginId', 'pluginName', 'platform', 'scope', 'projectKey',
    ], `${fieldName}.owner`);
    const parsedOwner: LifecycleArtifactOwnerIdentity = {
      ...(target.sourceId ? {
        sourceId: expectString(owner.sourceId, `${fieldName}.owner.sourceId`),
        sourceIdentity: expectString(owner.sourceIdentity, `${fieldName}.owner.sourceIdentity`),
        pluginId: expectString(owner.pluginId, `${fieldName}.owner.pluginId`),
      } : {}),
      pluginName: expectString(owner.pluginName, `${fieldName}.owner.pluginName`),
      platform: expectPlatform(owner.platform, `${fieldName}.owner.platform`),
      scope: expectScope(owner.scope, `${fieldName}.owner.scope`),
      projectKey: owner.projectKey === null
        ? null
        : expectString(owner.projectKey, `${fieldName}.owner.projectKey`),
    };
    if (
      parsedOwner.pluginName !== target.pluginName
      || parsedOwner.sourceId !== target.sourceId
      || parsedOwner.sourceIdentity !== target.sourceIdentity
      || parsedOwner.pluginId !== target.pluginId
      || parsedOwner.platform !== target.platform
      || parsedOwner.scope !== target.scope
      || parsedOwner.projectKey !== target.projectKey
    ) {
      fail(`${fieldName}.owner does not match the lifecycle target.`);
    }
    const parsed: LifecycleActiveArtifactDescriptor = {
      path: artifactPath,
      ...(paths ? { paths } : {}),
      kind: artifact.kind as GeneratedArtifact['kind'],
      platform,
      ...(expectOptionalString(artifact.artifactKey, `${fieldName}.artifactKey`)
        ? { artifactKey: artifact.artifactKey as string }
        : {}),
      ...(artifact.hookGroups === undefined
        ? {}
        : { hookGroups: parseHookGroups(artifact.hookGroups, `${fieldName}.hookGroups`)! }),
      ...(expectOptionalString(artifact.id, `${fieldName}.id`) ? { id: artifact.id as string } : {}),
      ...(targetValue ? { target: targetValue } : {}),
      ...(state ? { state } : {}),
      ...(artifact.refreshKeys === undefined
        ? {}
        : { refreshKeys: parseStringArray(artifact.refreshKeys, `${fieldName}.refreshKeys`)! }),
      ...(expectOptionalString(artifact.roleKey, `${fieldName}.roleKey`)
        ? { roleKey: artifact.roleKey as string }
        : {}),
      owner: parsedOwner,
    };
    for (const identity of descriptorIdentityKeys(parsed)) {
      if (identities.has(identity)) {
        fail(`${fieldName} duplicates another lifecycle artifact identity.`);
      }
      identities.add(identity);
    }
    return parsed;
  });
}

function parseMetadata(
  raw: unknown,
  target: LifecycleActiveTarget,
): LifecycleActiveMetadata {
  const value = expectRecord(raw, 'metadata');
  assertAllowedKeys(value, [
    'schemaVersion', 'sourceId', 'sourceIdentity', 'pluginId',
    'pluginName', 'pluginVersion', 'platform', 'scope', 'projectKey',
    'sourceManifestDigest', 'fingerprintVersion', 'bundleFingerprint', 'events', 'artifacts',
    'metadataIntegrityDigest',
  ], 'metadata');
  if (value.schemaVersion !== 1 && value.schemaVersion !== LIFECYCLE_ACTIVE_SCHEMA_VERSION) {
    fail('metadata.schemaVersion is unsupported.');
  }
  if (target.sourceId !== undefined && value.schemaVersion === 1) {
    fail('legacyStateUnsupported: schema 1 lifecycle state is not supported.');
  }
  const sourceId = value.schemaVersion === 2
    ? expectString(value.sourceId, 'metadata.sourceId')
    : undefined;
  const sourceIdentity = value.schemaVersion === 2
    ? expectString(value.sourceIdentity, 'metadata.sourceIdentity')
    : undefined;
  const pluginId = value.schemaVersion === 2
    ? expectString(value.pluginId, 'metadata.pluginId')
    : undefined;
  const pluginName = expectString(value.pluginName, 'metadata.pluginName');
  assertPluginName(pluginName);
  const pluginVersion = expectString(value.pluginVersion, 'metadata.pluginVersion');
  const platform = expectPlatform(value.platform, 'metadata.platform');
  const scope = expectScope(value.scope, 'metadata.scope');
  const projectKey = value.projectKey === null
    ? null
    : expectString(value.projectKey, 'metadata.projectKey');
  if (
    sourceId !== target.sourceId
    || (sourceId !== undefined && sourceIdentity !== target.sourceIdentity)
    || (sourceId !== undefined && pluginId !== target.pluginId)
    ||
    pluginName !== target.pluginName
    || platform !== target.platform
    || scope !== target.scope
    || projectKey !== target.projectKey
  ) {
    if (sourceId === target.sourceId && sourceIdentity !== target.sourceIdentity) {
      fail('sourceChanged: lifecycle source identity does not match the configured source.');
    }
    fail('Lifecycle active metadata target identity does not match the requested target.');
  }
  if (scope === 'user' ? projectKey !== null : projectKey === null) {
    fail('metadata.projectKey does not match metadata.scope.');
  }
  const sourceManifestDigest = expectString(value.sourceManifestDigest, 'metadata.sourceManifestDigest');
  if (value.fingerprintVersion !== 2) {
    fail('metadata.fingerprintVersion must be 2.');
  }
  const bundleFingerprint = expectString(value.bundleFingerprint, 'metadata.bundleFingerprint');
  const metadataIntegrityDigest = expectString(
    value.metadataIntegrityDigest,
    'metadata.metadataIntegrityDigest',
  );
  if (
    !DIGEST_PATTERN.test(sourceManifestDigest)
    || !DIGEST_PATTERN.test(bundleFingerprint)
    || !DIGEST_PATTERN.test(metadataIntegrityDigest)
  ) {
    fail('metadata integrity fields must be SHA-256 digests.');
  }
  if (!Array.isArray(value.events)) {
    fail('metadata.events must be an array.');
  }
  const events = value.events.map((event, index) => {
    if (!(PLUGIN_LIFECYCLE_EVENTS as readonly unknown[]).includes(event)) {
      fail(`metadata.events[${index}] is invalid.`);
    }
    return event as PluginLifecycleEvent;
  });
  const expectedOrder = PLUGIN_LIFECYCLE_EVENTS.filter((event) => events.includes(event));
  if (
    events.length !== new Set(events).size
    || events.some((event, index) => expectedOrder[index] !== event)
    || !events.includes('uninstall')
  ) {
    fail('metadata.events must be unique, ordered lifecycle events that include uninstall.');
  }
  const artifacts = parseArtifactDescriptors(value.artifacts, target);
  const payload: LifecycleActiveMetadataPayload = {
    schemaVersion: value.schemaVersion,
    ...(sourceId ? { sourceId, sourceIdentity, pluginId } : {}),
    pluginName,
    pluginVersion,
    platform,
    scope,
    projectKey,
    sourceManifestDigest,
    fingerprintVersion: 2,
    bundleFingerprint,
    events,
    artifacts,
  };
  if (calculateMetadataIntegrityDigest(payload) !== metadataIntegrityDigest) {
    fail('Lifecycle active metadata integrity digest does not match metadata.');
  }
  return { ...payload, metadataIntegrityDigest };
}

async function validateSnapshotRoot(
  snapshotRoot: string,
  target: LifecycleActiveTarget,
  loadPlugin: LifecycleActivePluginLoader,
): Promise<{
  metadata: LifecycleActiveMetadata;
  bundleRoot: string;
  manifestPath: string;
  plugin: PluginMeta;
}> {
  assertInsidePath(snapshotRoot, target.targetRoot, 'snapshotRoot');
  await assertExistingDirectoryBoundary(target, snapshotRoot, 'snapshotRoot');
  await assertNoSymlinks(snapshotRoot);
  const topLevelEntries = (await fs.readdir(snapshotRoot)).sort();
  if (topLevelEntries.length !== 2
    || topLevelEntries[0] !== 'bundle'
    || topLevelEntries[1] !== LIFECYCLE_ACTIVE_METADATA_FILE) {
    fail('Lifecycle active snapshot must contain only bundle and metadata.json.');
  }
  const resolvedSnapshotRoot = await fs.realpath(snapshotRoot);
  const bundleRoot = path.join(snapshotRoot, 'bundle');
  const metadataPath = path.join(snapshotRoot, LIFECYCLE_ACTIVE_METADATA_FILE);
  const manifestPath = path.join(bundleRoot, SOURCE_MANIFEST_PATH);
  const [resolvedBundleRoot, resolvedMetadataPath, resolvedManifestPath] = await Promise.all([
    fs.realpath(bundleRoot),
    fs.realpath(metadataPath),
    fs.realpath(manifestPath),
  ]);
  if (
    resolvedBundleRoot !== path.join(resolvedSnapshotRoot, 'bundle')
    || resolvedMetadataPath !== path.join(resolvedSnapshotRoot, LIFECYCLE_ACTIVE_METADATA_FILE)
    || resolvedManifestPath !== path.join(resolvedBundleRoot, SOURCE_MANIFEST_PATH)
  ) {
    fail('Lifecycle active snapshot layout escapes its expected path boundaries.');
  }
  let rawMetadata: unknown;
  try {
    rawMetadata = await fs.readJson(resolvedMetadataPath);
  } catch (error) {
    throw new LifecycleActiveSnapshotError('Lifecycle active metadata is not valid JSON.', { cause: error });
  }
  const metadata = parseMetadata(rawMetadata, target);
  const [manifestDigest, bundleFingerprint] = await Promise.all([
    calculateFileDigest(resolvedManifestPath),
    calculatePluginBundleFingerprintV2(resolvedBundleRoot),
  ]);
  if (manifestDigest !== metadata.sourceManifestDigest) {
    fail('Lifecycle active manifest digest does not match metadata.');
  }
  if (bundleFingerprint !== metadata.bundleFingerprint) {
    fail('Lifecycle active bundle fingerprint does not match metadata.');
  }
  let plugin: PluginMeta;
  try {
    plugin = await loadPlugin(resolvedBundleRoot, resolvedManifestPath);
  } catch (error) {
    throw new LifecycleActiveSnapshotError('Lifecycle active plugin manifest is invalid.', { cause: error });
  }
  if (plugin.manifest.name !== metadata.pluginName || plugin.manifest.version !== metadata.pluginVersion) {
    fail('Lifecycle active plugin identity does not match metadata.');
  }
  if (
    await fs.realpath(plugin.rootDir) !== resolvedBundleRoot
    || await fs.realpath(plugin.manifestPath) !== resolvedManifestPath
  ) {
    fail('Lifecycle active plugin loader returned paths outside the snapshot bundle.');
  }
  const declaredEvents = lifecycleEvents(plugin.manifest);
  if (
    declaredEvents.length !== metadata.events.length
    || declaredEvents.some((event, index) => metadata.events[index] !== event)
  ) {
    fail('Lifecycle active plugin events do not match metadata.');
  }
  if (metadata.sourceId) {
    plugin.sourceId = metadata.sourceId;
    plugin.sourceIdentity = metadata.sourceIdentity;
    plugin.pluginId = metadata.pluginId;
  }
  return { metadata, bundleRoot: resolvedBundleRoot, manifestPath: resolvedManifestPath, plugin };
}

async function materializeBundleEntry(options: {
  sourcePath: string;
  destinationPath: string;
  allowedRoots: readonly string[];
  directoryStack: ReadonlySet<string>;
}): Promise<void> {
  const resolvedSource = await fs.realpath(options.sourcePath);
  if (!options.allowedRoots.some((root) => isInsidePath(resolvedSource, root))) {
    fail(`Lifecycle bundle link escapes its allowed closure roots: ${options.sourcePath}`);
  }
  const stat = await fs.stat(resolvedSource);
  if (stat.isDirectory()) {
    if (options.directoryStack.has(resolvedSource)) {
      fail(`Lifecycle bundle contains a directory link cycle: ${options.sourcePath}`);
    }
    const nextStack = new Set(options.directoryStack).add(resolvedSource);
    await fs.ensureDir(options.destinationPath);
    for (const entry of (await fs.readdir(options.sourcePath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await materializeBundleEntry({
        sourcePath: path.join(options.sourcePath, entry.name),
        destinationPath: path.join(options.destinationPath, entry.name),
        allowedRoots: options.allowedRoots,
        directoryStack: nextStack,
      });
    }
    await fs.chmod(options.destinationPath, stat.mode & 0o777);
    return;
  }
  if (stat.isFile()) {
    await fs.ensureDir(path.dirname(options.destinationPath));
    await fs.copyFile(resolvedSource, options.destinationPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(options.destinationPath, stat.mode & 0o777);
    return;
  }
  fail(`Lifecycle bundle contains a special entry: ${options.sourcePath}`);
}

async function materializeLifecycleBundle(options: {
  sourceRoot: string;
  destinationRoot: string;
}): Promise<void> {
  const sourceRoot = await fs.realpath(options.sourceRoot);
  const sourceStat = await fs.stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    fail(`Lifecycle bundle source root is not a directory: ${options.sourceRoot}`);
  }
  await materializeBundleEntry({
    sourcePath: options.sourceRoot,
    destinationPath: options.destinationRoot,
    allowedRoots: [sourceRoot],
    directoryStack: new Set(),
  });
  await assertNoSymlinks(options.destinationRoot);
}

async function pruneEmptyStagingRoot(stagingRoot: string): Promise<void> {
  const entries = await fs.readdir(stagingRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (entries?.length === 0) {
    await beforePruneStagingRootForTests?.();
    await fs.rmdir(stagingRoot);
  }
}

async function recoverTransientBackup(
  target: LifecycleActiveTarget,
  loadPlugin: LifecycleActivePluginLoader,
): Promise<void> {
  const entries = await fs.readdir(target.targetRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [] as string[];
    }
    throw error;
  });
  const backups = entries.filter((entry) => BACKUP_ID_PATTERN.test(entry));
  if (backups.length > 1) {
    fail('Lifecycle active target contains multiple transient backups.');
  }
  const backupPath = backups[0] ? path.join(target.targetRoot, backups[0]) : null;
  if (!backupPath) {
    return;
  }
  await assertExistingDirectoryBoundary(target, backupPath, 'backupRoot');
  if (await fs.pathExists(target.activeRoot)) {
    await fs.remove(backupPath);
    return;
  }
  await validateSnapshotRoot(backupPath, target, loadPlugin);
  await fs.rename(backupPath, target.activeRoot);
}

async function cleanupOrphanStages(target: LifecycleActiveTarget): Promise<void> {
  const stagingStat = await lstatIfExists(target.stagingRoot);
  if (!stagingStat) {
    return;
  }
  await assertExistingDirectoryBoundary(target, target.stagingRoot, 'stagingRoot');
  const entries = await fs.readdir(target.stagingRoot);
  for (const entry of entries) {
    if (!STAGE_ID_PATTERN.test(entry)) {
      fail(`Lifecycle active staging contains an unknown entry: ${entry}`);
    }
    const stageRoot = path.join(target.stagingRoot, entry);
    await assertExistingDirectoryBoundary(target, stageRoot, 'orphanStageRoot');
    await assertNoSymlinks(stageRoot);
    await fs.remove(stageRoot);
  }
  await pruneEmptyStagingRoot(target.stagingRoot);
}

async function cleanupTransientState(
  target: LifecycleActiveTarget,
  loadPlugin: LifecycleActivePluginLoader,
): Promise<void> {
  await assertExistingDirectoryBoundary(target, target.targetRoot, 'targetRoot');
  await recoverTransientBackup(target, loadPlugin);
  await cleanupOrphanStages(target);
}

function attachPreparedLock<T extends PreparedLifecycleActiveSnapshot>(
  prepared: T,
  lock: ProcessLockLease,
  loadPlugin: LifecycleActivePluginLoader,
): T {
  preparedContexts.set(prepared, { lock, loadPlugin });
  return prepared;
}

function requirePreparedContext(prepared: PreparedLifecycleActiveSnapshot): {
  lock: ProcessLockLease;
  loadPlugin: LifecycleActivePluginLoader;
} {
  const context = preparedContexts.get(prepared);
  if (!context) {
    fail('Lifecycle active prepared snapshot no longer owns its target lock.');
  }
  return context;
}

function isRetryableReleaseError(error: unknown): boolean {
  return new Set(['EACCES', 'EBUSY', 'EINTR', 'EIO', 'ENOTEMPTY', 'EPERM']).has(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

async function releaseLeaseWithRetry(lock: ProcessLockLease): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await lock.release();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReleaseError(error)) throw error;
    }
  }
  throw lastError;
}

export async function prepareLifecycleActiveSnapshot(options: {
  sourceId?: string;
  sourceIdentity?: string;
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  artifacts?: readonly GeneratedArtifact[];
  loadPlugin: LifecycleActivePluginLoader;
  env?: NodeJS.ProcessEnv;
  lifecycleLeaseHeld?: boolean;
}): Promise<PreparedLifecycleActiveSnapshot> {
  const env = options.env ?? process.env;
  const target = await resolveLifecycleActiveTarget({
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
    } : {}),
    pluginName: options.plugin.manifest.name,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    env,
  });
  const lock = await acquireTargetLock(target, options.lifecycleLeaseHeld);
  let stageRoot: string | null = null;
  try {
    await cleanupTransientState(target, options.loadPlugin);
    await fs.ensureDir(target.stagingRoot);
    await assertExistingDirectoryBoundary(target, target.stagingRoot, 'stagingRoot');
    const stageId = `stage-${crypto.randomBytes(12).toString('hex')}`;
    stageRoot = path.join(target.stagingRoot, stageId);
    await fs.mkdir(stageRoot);
    const bundleRoot = path.join(stageRoot, 'bundle');
    await materializeLifecycleBundle({
      sourceRoot: options.plugin.rootDir,
      destinationRoot: bundleRoot,
    });
    const stagedManifestPath = path.join(bundleRoot, SOURCE_MANIFEST_PATH);
    const stagedPlugin = await options.loadPlugin(bundleRoot, stagedManifestPath);
    if (
      await fs.realpath(stagedPlugin.rootDir) !== await fs.realpath(bundleRoot)
      || await fs.realpath(stagedPlugin.manifestPath) !== await fs.realpath(stagedManifestPath)
    ) {
      fail('Lifecycle active plugin loader returned paths outside the staged bundle.');
    }
    if (
      stagedPlugin.manifest.name !== options.plugin.manifest.name
      || stagedPlugin.manifest.version !== options.plugin.manifest.version
    ) {
      fail('Lifecycle active source plugin identity changed during staging.');
    }
    if (!stagedPlugin.manifest.scripts?.lifecycle?.uninstall) {
      await fs.remove(stageRoot);
      stageRoot = null;
      await pruneEmptyStagingRoot(target.stagingRoot);
      return attachPreparedLock({
        status: 'not-required',
        reason: 'no-uninstall-lifecycle',
        target,
      }, lock, options.loadPlugin);
    }
    const [sourceManifestDigest, bundleFingerprint] = await Promise.all([
      calculateFileDigest(stagedPlugin.manifestPath),
      calculatePluginBundleFingerprintV2(bundleRoot),
    ]);
    const payload: LifecycleActiveMetadataPayload = {
      schemaVersion: target.sourceId ? LIFECYCLE_ACTIVE_SCHEMA_VERSION : 1,
      ...(target.sourceId ? {
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        pluginId: target.pluginId,
      } : {}),
      pluginName: stagedPlugin.manifest.name,
      pluginVersion: stagedPlugin.manifest.version,
      platform: target.platform,
      scope: target.scope,
      projectKey: target.projectKey,
      sourceManifestDigest,
      fingerprintVersion: 2,
      bundleFingerprint,
      events: lifecycleEvents(stagedPlugin.manifest),
      artifacts: createArtifactDescriptors(options.artifacts ?? [], target),
    };
    const metadata: LifecycleActiveMetadata = {
      ...payload,
      metadataIntegrityDigest: calculateMetadataIntegrityDigest(payload),
    };
    await fs.writeJson(path.join(stageRoot, LIFECYCLE_ACTIVE_METADATA_FILE), metadata, { spaces: 2 });
    const validated = await validateSnapshotRoot(stageRoot, target, options.loadPlugin);
    if (stableStringify(validated.metadata) !== stableStringify(metadata)) {
      fail('Lifecycle active staged metadata changed during validation.');
    }
    return attachPreparedLock(
      { status: 'staged', target, stageId, stageRoot, metadata },
      lock,
      options.loadPlugin,
    );
  } catch (error) {
    if (stageRoot) {
      await fs.remove(stageRoot).catch(() => undefined);
      await pruneEmptyStagingRoot(target.stagingRoot).catch(() => undefined);
    }
    try {
      await releaseLeaseWithRetry(lock);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Lifecycle active prepare failed and its target lock could not be released.',
        { cause: error },
      );
    }
    throw error;
  }
}

function createReadSnapshot(
  target: LifecycleActiveTarget,
  validated: Awaited<ReturnType<typeof validateSnapshotRoot>>,
): ReadLifecycleActiveSnapshot {
  return {
    target,
    activeRoot: target.activeRoot,
    bundleRoot: validated.bundleRoot,
    manifestPath: validated.manifestPath,
    metadata: validated.metadata,
    plugin: validated.plugin,
    artifacts: validated.metadata.artifacts.map(({ owner: _owner, ...artifact }) => ({ ...artifact })),
  };
}

async function restoreBackupAfterFailedPromote(options: {
  target: LifecycleActiveTarget;
  backupPath: string | null;
  installedNewActive: boolean;
}): Promise<void> {
  if (options.installedNewActive) {
    await assertExistingDirectoryBoundary(options.target, options.target.activeRoot, 'activeRoot');
    await fs.remove(options.target.activeRoot);
  }
  if (options.backupPath && await fs.pathExists(options.backupPath)) {
    if (await fs.pathExists(options.target.activeRoot)) {
      fail('Lifecycle active promote cannot restore backup over an unexpected active snapshot.');
    }
    await fs.rename(options.backupPath, options.target.activeRoot);
  }
}

export async function promoteLifecycleActiveSnapshot(
  prepared: PreparedLifecycleActiveSnapshot,
): Promise<ReadLifecycleActiveSnapshot | null> {
  const { lock, loadPlugin } = requirePreparedContext(prepared);
  let backupPath: string | null = null;
  let installedNewActive = false;
  let primaryError: unknown;
  try {
    await assertExistingDirectoryBoundary(prepared.target, prepared.target.targetRoot, 'targetRoot');
    if (prepared.status === 'not-required') {
      await removeLifecycleSnapshotDataLocked(prepared.target);
      return null;
    }
    const expectedStageRoot = path.join(prepared.target.stagingRoot, prepared.stageId);
    if (
      !STAGE_ID_PATTERN.test(prepared.stageId)
      || path.resolve(prepared.stageRoot) !== path.resolve(expectedStageRoot)
    ) {
      fail('Lifecycle active stage identity is invalid.');
    }
    const staged = await validateSnapshotRoot(prepared.stageRoot, prepared.target, loadPlugin);
    if (stableStringify(staged.metadata) !== stableStringify(prepared.metadata)) {
      fail('Lifecycle active stage metadata no longer matches its prepared generation.');
    }
    if (await fs.pathExists(prepared.target.activeRoot)) {
      await validateSnapshotRoot(prepared.target.activeRoot, prepared.target, loadPlugin);
      backupPath = path.join(
        prepared.target.targetRoot,
        `backup-${crypto.randomBytes(12).toString('hex')}`,
      );
      await fs.rename(prepared.target.activeRoot, backupPath);
    }
    await fs.rename(prepared.stageRoot, prepared.target.activeRoot);
    installedNewActive = true;
    const active = await validateSnapshotRoot(prepared.target.activeRoot, prepared.target, loadPlugin);
    if (stableStringify(active.metadata) !== stableStringify(prepared.metadata)) {
      fail('Lifecycle active promoted generation changed during promotion.');
    }
    if (backupPath) {
      await fs.remove(backupPath);
      backupPath = null;
    }
    await pruneEmptyStagingRoot(prepared.target.stagingRoot).catch(() => undefined);
    return createReadSnapshot(prepared.target, active);
  } catch (error) {
    try {
      await restoreBackupAfterFailedPromote({
        target: prepared.target,
        backupPath,
        installedNewActive,
      });
      if (prepared.status === 'staged' && await fs.pathExists(prepared.stageRoot)) {
        await fs.remove(prepared.stageRoot);
      }
      await pruneEmptyStagingRoot(prepared.target.stagingRoot).catch(() => undefined);
    } catch (restoreError) {
      primaryError = new AggregateError(
        [error, restoreError],
        'Lifecycle active promote failed and its previous active generation could not be restored.',
        { cause: error },
      );
      throw primaryError;
    }
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseLeaseWithRetry(lock);
    } catch (releaseError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          'Lifecycle active promote failed and its target lock could not be released.',
          { cause: primaryError },
        );
      }
      throw releaseError;
    }
    finalizedPrepared.add(prepared);
    preparedContexts.delete(prepared);
  }
}

export async function discardLifecycleActiveSnapshot(
  prepared: PreparedLifecycleActiveSnapshot,
): Promise<void> {
  const context = preparedContexts.get(prepared);
  if (!context && finalizedPrepared.has(prepared)) {
    return;
  }
  if (!context) {
    fail('Lifecycle active prepared snapshot no longer owns its target lock.');
  }
  const { lock } = context;
  let primaryError: unknown;
  try {
    if (prepared.status === 'staged') {
      const expectedStageRoot = path.join(prepared.target.stagingRoot, prepared.stageId);
      if (path.resolve(prepared.stageRoot) !== path.resolve(expectedStageRoot)) {
        fail('Lifecycle active discard stage identity is invalid.');
      }
      await assertExistingDirectoryBoundary(prepared.target, prepared.stageRoot, 'stageRoot');
      await fs.remove(prepared.stageRoot);
      await pruneEmptyStagingRoot(prepared.target.stagingRoot);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseLeaseWithRetry(lock);
    } catch (releaseError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          'Lifecycle active discard failed and its target lock could not be released.',
          { cause: primaryError },
        );
      }
      throw releaseError;
    }
    finalizedPrepared.add(prepared);
    preparedContexts.delete(prepared);
  }
}

type ReadLifecycleActiveSnapshotOptions = {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  loadPlugin: LifecycleActivePluginLoader;
  env?: NodeJS.ProcessEnv;
};

async function readLifecycleActiveSnapshotUnlocked(
  options: ReadLifecycleActiveSnapshotOptions,
): Promise<ReadLifecycleActiveSnapshot | null> {
  const target = await resolveLifecycleActiveTarget(options);
  await assertExistingPathChainHasNoSymlinks(target.awHome, target.activeRoot);
  if (!await fs.pathExists(target.activeRoot)) {
    return null;
  }
  try {
    return createReadSnapshot(
      target,
      await validateSnapshotRoot(target.activeRoot, target, options.loadPlugin),
    );
  } catch (error) {
    if (error instanceof LifecycleActiveSnapshotError) {
      throw error;
    }
    throw new LifecycleActiveSnapshotError(
      'Lifecycle active snapshot is corrupt.',
      { cause: error },
    );
  }
}

export async function readLifecycleActiveSnapshot(
  options: ReadLifecycleActiveSnapshotOptions,
): Promise<ReadLifecycleActiveSnapshot | null> {
  return withActiveMarketplaceLifecycleLease(
    options.env,
    () => readLifecycleActiveSnapshotUnlocked(options),
  );
}

// Catalog reference inventory can run while the runtime coordination lease is held.
// Active publication also needs that lease, so inventory must not acquire lifecycle after runtime.
export async function inspectLifecycleActiveSnapshotForInventory(
  options: ReadLifecycleActiveSnapshotOptions,
): Promise<ReadLifecycleActiveSnapshot | null> {
  return readLifecycleActiveSnapshotUnlocked(options);
}

export async function leaseLifecycleActiveSnapshot(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  loadPlugin: LifecycleActivePluginLoader;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadLifecycleActiveSnapshot | null> {
  const target = await resolveLifecycleActiveTarget(options);
  const lock = await acquireTargetLock(target);
  let snapshot: ReadLifecycleActiveSnapshot | null;
  try {
    await assertExistingPathChainHasNoSymlinks(target.awHome, target.activeRoot);
    if (!await fs.pathExists(target.activeRoot)) {
      snapshot = null;
    } else {
      snapshot = createReadSnapshot(
        target,
        await validateSnapshotRoot(target.activeRoot, target, options.loadPlugin),
      );
    }
  } catch (error) {
    const primaryError = error instanceof LifecycleActiveSnapshotError
      ? error
      : new LifecycleActiveSnapshotError('Lifecycle active snapshot is corrupt.', { cause: error });
    try {
      await releaseLeaseWithRetry(lock);
    } catch (releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        'Lifecycle active read failed and its target lock could not be released.',
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (!snapshot) {
    await releaseLeaseWithRetry(lock);
    return null;
  }
  readContexts.set(snapshot, lock);
  return snapshot;
}

export async function releaseLifecycleActiveSnapshot(
  snapshot: ReadLifecycleActiveSnapshot,
): Promise<void> {
  const lock = readContexts.get(snapshot);
  if (!lock && releasedReads.has(snapshot)) return;
  if (!lock) {
    fail('Lifecycle active read snapshot no longer owns its target lock.');
  }
  await releaseLeaseWithRetry(lock);
  readContexts.delete(snapshot);
  releasedReads.add(snapshot);
}

export function restoreLifecycleActiveScriptInputs(
  snapshot: ReadLifecycleActiveSnapshot,
): LifecycleActiveScriptInputs {
  return { currentPlugin: snapshot.plugin, artifacts: snapshot.artifacts };
}

async function removeLifecycleSnapshotDataLocked(target: LifecycleActiveTarget): Promise<void> {
  await assertExistingDirectoryBoundary(target, target.targetRoot, 'targetRoot');
  for (const ownedPath of [target.activeRoot, target.stagingRoot]) {
    const stat = await lstatIfExists(ownedPath);
    if (!stat) {
      continue;
    }
    await assertExistingDirectoryBoundary(target, ownedPath, path.basename(ownedPath));
    await fs.remove(ownedPath);
  }
  const remaining = await fs.readdir(target.targetRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (remaining?.length === 0) {
    await fs.rmdir(target.targetRoot);
  }
}

async function removeTransientBackupsLocked(target: LifecycleActiveTarget): Promise<void> {
  const entries = await fs.readdir(target.targetRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  for (const entry of entries.filter((name) => BACKUP_ID_PATTERN.test(name))) {
    const backupPath = path.join(target.targetRoot, entry);
    await assertExistingDirectoryBoundary(target, backupPath, 'backupRoot');
    await fs.remove(backupPath);
  }
}

export async function removeLifecycleActiveSnapshot(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  lifecycleLeaseHeld?: boolean;
  expectedMetadataIntegrityDigest?: string;
}): Promise<void> {
  const target = await resolveLifecycleActiveTarget(options);
  const lock = await acquireTargetLock(target, options.lifecycleLeaseHeld);
  let primaryError: unknown;
  try {
    if (options.expectedMetadataIntegrityDigest !== undefined) {
      await assertExistingDirectoryBoundary(target, target.activeRoot, 'activeRoot');
      const metadata = await fs.readJson(
        path.join(target.activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE),
      ) as unknown;
      if (metadata === null
        || typeof metadata !== 'object'
        || Array.isArray(metadata)
        || (metadata as Record<string, unknown>).metadataIntegrityDigest
          !== options.expectedMetadataIntegrityDigest) {
        fail('stateInventoryFailed: lifecycle active generation changed before removal.');
      }
    }
    await cleanupOrphanStages(target);
    await removeTransientBackupsLocked(target);
    await removeLifecycleSnapshotDataLocked(target);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseLeaseWithRetry(lock);
    } catch (releaseError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          'Lifecycle active remove failed and its target lock could not be released.',
          { cause: primaryError },
        );
      }
      throw releaseError;
    }
  }
}
