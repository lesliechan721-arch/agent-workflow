import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  getCommandPackageId,
  isCommandPackageId as isCoreCommandPackageId,
  isUserCommandId as isCoreUserCommandId,
  normalizeCommandSelector,
  parseCommandInvocationSelector,
  normalizeCommandLaunch,
  normalizeInstalledCommandProducer as normalizeCoreProducer,
  normalizeUserCommandDefinition,
  normalizeProducerIdentity,
  COMMAND_PRODUCER_RECORD_FILE,
  validateNativeToolClosureFiles,
  type NativeToolClosure,
  type CommandRoutes,
  type PlatformName,
  type CommandLaunch,
  type ProducerIdentity,
  type InstalledCommandProducer,
  type UserCommandDefinition,
} from '@lesliechan721/aw-plugin-core/manifest';

import { calculateFileDigest } from './bundle-integrity.js';
import { calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import { readCatalogSourcesConfig, resolveCatalogSourcesConfigPath } from './catalog-sources.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { calculateManagedCommandResourceDigest } from './managed-command-closure.js';
import { ManagedCommandError } from './managed-command-errors.js';
import {
  COMMAND_RUNTIME_CONFIG_DIRECTORY,
  validateManagedCommandRuntimeConfigFiles,
  type CommandRuntimeConfigContext,
} from './managed-command-snapshots.js';
import { atomicReplaceSafeFile } from './safe-fs.js';
import {
  canonicalizePathThroughExistingAncestor,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

export const COMMAND_PRODUCER_RECORD = COMMAND_PRODUCER_RECORD_FILE;
export { ManagedCommandError };
export type { InstalledCommandProducer, UserCommandDefinition };
const REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ManagedCommandDiagnostic { code: string; message: string; subject?: string }
interface ManagedCommandViewBase {
  availability: 'ready' | 'empty' | 'unavailable';
  resourceRoot: string | null;
  errors: ManagedCommandDiagnostic[];
  recoveryActions: string[];
}
export interface UserCommandView extends ManagedCommandViewBase {
  id: string;
  name: string;
  owner: { kind: 'user' };
  availability: 'ready' | 'unavailable';
  launch: CommandLaunch | null;
}
export interface ManagedCommandPackageView extends ManagedCommandViewBase {
  selector: string;
  packageId: string;
  owner: { kind: 'plugin'; producer: ProducerIdentity };
  pluginVersion: string | null;
  sourceContentDigest: string | null;
  routes: CommandRoutes | null;
  subcommands: string[];
  hasFallback: boolean;
  runtimeConfigPlatforms: PlatformName[];
  requiresPlatformContext: boolean | null;
  nativeTools: NativeToolClosure | null;
}
export type ManagedCommandView = UserCommandView | ManagedCommandPackageView;

function fail(code: string, message: string): never { throw new ManagedCommandError(code, message); }
function object(value: unknown, keys: string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) fail(code, 'The managed command record has an invalid shape.');
  return value as Record<string, unknown>;
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
export function managedCommandDiagnostic(error: unknown, subject?: string): ManagedCommandDiagnostic {
  return {
    code: error instanceof ManagedCommandError ? error.code : 'commandResourceInvalid',
    message: error instanceof ManagedCommandError ? error.message : 'The managed command resource could not be read or written.',
    ...(subject ? { subject } : {}),
  };
}
export async function managedCommandRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return path.join(await canonicalizePathThroughExistingAncestor(resolveAwHome(env)), 'commands');
}
async function safePath(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('commandResourceInvalid', 'The managed command path escapes its allowed root.');
  let current = path.resolve(root);
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || (current !== path.resolve(target) && stat && !stat.isDirectory())) fail('commandResourceInvalid', 'The managed command path is not a regular owned path.');
  }
}
async function readJson(root: string, target: string, code: string): Promise<unknown> {
  await safePath(root, target);
  try {
    if (!(await fs.lstat(target)).isFile()) fail(code, 'The managed command record must be a regular file.');
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error instanceof ManagedCommandError) throw error;
    fail(code, 'The managed command record is missing or invalid.');
  }
}
async function writeJson(root: string, target: string, value: unknown): Promise<void> {
  await ensureRegularDirectoryPath(root, 'Managed commands root');
  await atomicReplaceSafeFile({ allowedRoot: root, filePath: target, content: `${JSON.stringify(value, null, 2)}\n`, label: 'Managed command record' });
}
export function isUserCommandId(selector: string): boolean { return isCoreUserCommandId(selector); }
export function isManagedCommandPackageId(selector: string): boolean { return isCoreCommandPackageId(selector); }
export function parsePluginCommandSelector(selector: string): Pick<ProducerIdentity, 'sourceId' | 'pluginName'> {
  try { return normalizeCommandSelector(selector); }
  catch { throw new ManagedCommandError('invalidArguments', 'A canonical source/plugin selector is required.', true); }
}
export function assertUserCommandId(id: string): void {
  if (id.includes('/')) {
    parsePluginCommandSelector(id);
    fail('commandOwnerMismatch', 'Plugin commands must be maintained with plugin sync or command package sync/remove.');
  }
  if (!isUserCommandId(id)) throw new ManagedCommandError('invalidArguments', 'A canonical user command ID is required.', true);
}
export function validateManagedCommandName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 128
    || /[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new ManagedCommandError('invalidArguments', 'The command name must contain 1–128 characters and no control characters.', true);
  }
  return value;
}
export function parseManagedCommandLaunch(value: unknown): CommandLaunch {
  try { return normalizeCommandLaunch(value); }
  catch { fail('commandDefinitionInvalid', 'The managed command launch definition is invalid.'); }
}
async function assertUserOwner(root: string, id: string): Promise<string> {
  assertUserCommandId(id);
  const userRoot = path.join(root, 'users', id);
  await safePath(root, userRoot);
  if (!(await fs.lstat(userRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }))) fail('commandNotFound', 'The user command ID is not installed.');
  const owner = object(await readJson(root, path.join(userRoot, 'owner.json'), 'commandOwnerMismatch'), ['schemaVersion', 'owner', 'kind', 'id'], 'commandOwnerMismatch');
  if (owner.schemaVersion !== 1 || owner.owner !== 'agent-workflows' || owner.kind !== 'user-command' || owner.id !== id) {
    fail('commandOwnerMismatch', 'The user command owner marker does not match this directory.');
  }
  return userRoot;
}
export async function readUserCommandDefinition(id: string, env: NodeJS.ProcessEnv = process.env): Promise<UserCommandDefinition> {
  const root = await managedCommandRoot(env);
  const userRoot = await assertUserOwner(root, id);
  const value = await readJson(root, path.join(userRoot, 'definition.json'), 'commandDefinitionInvalid');
  try {
    const definition = normalizeUserCommandDefinition(value);
    if (definition.id !== id || !equal(value, definition)) fail('commandDefinitionInvalid', 'The stored user command definition is not complete or does not match its directory.');
    return definition;
  } catch { fail('commandDefinitionInvalid', 'The stored user command definition is invalid.'); }
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function validateManagedCommandResource(
  resourceRoot: string, launch?: CommandLaunch, options: { skipRuntimeConfigSnapshots?: boolean } = {},
): Promise<void> {
  const root = path.resolve(resourceRoot);
  const runtimeConfigDirectory = path.join(root, COMMAND_RUNTIME_CONFIG_DIRECTORY);
  await safePath(path.dirname(root), root);
  async function visit(directory: string): Promise<void> {
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('commandResourceInvalid', 'The command resource root must be a regular directory.');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') fail('commandResourceInvalid', 'The command resource changed before it could be read.');
      throw error;
    });
    for (const entry of entries) {
      const location = path.join(directory, entry.name);
      // Run verifies the selected snapshot separately. Damage to another platform cannot stop it.
      if (options.skipRuntimeConfigSnapshots && location === runtimeConfigDirectory) continue;
      if (entry.name === '.git' || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        fail('commandResourceInvalid', 'Command resources cannot contain links, special nodes, or .git directories.');
      }
      if (entry.isDirectory()) await visit(location);
    }
  }
  await visit(root);
  if (launch) await validateCommandLaunchFile(root, launch);
}

async function validateCommandLaunchFile(root: string, launch: CommandLaunch): Promise<void> {
  const entry = path.resolve(root, launch.entry);
  if (!contains(root, entry) || entry === root) fail('commandResourceInvalid', 'The command entry escapes its resource root.');
  await safePath(root, entry);
  const stat = await fs.lstat(entry).catch(() => null);
  if (!stat?.isFile()) fail('commandResourceInvalid', 'The command entry is missing or is not a regular file.');
  try { await fs.access(entry, fs.constants.R_OK); }
  catch { fail('commandResourceInvalid', 'The command entry cannot be read.'); }
  if (launch.runner === 'executable') {
    if (process.platform === 'win32') {
      if (path.extname(entry).toLowerCase() !== '.exe') fail('commandRunnerUnsupported', 'Windows commands require a directly runnable native .exe entry.');
      const handle = await fs.open(entry, 'r');
      try {
        const magic = Buffer.alloc(2);
        await handle.read(magic, 0, 2, 0);
        if (magic.toString('ascii') !== 'MZ') fail('commandRunnerUnsupported', 'The command entry is not a native Windows executable.');
      } finally { await handle.close(); }
    } else if ((stat.mode & 0o111) === 0) fail('commandRunnerUnsupported', 'The command executable has no execute permission.');
  }
}
export async function copyManagedCommandDirectory(sourceDirectory: string, destination: string, env: NodeJS.ProcessEnv = process.env, options: { trustedPluginSource?: boolean } = {}): Promise<void> {
  const source = path.resolve(sourceDirectory);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('commandResourceInvalid', 'The command source must be a regular directory.');
  const canonicalSource = await fs.realpath(source);
  const awHome = await canonicalizePathThroughExistingAncestor(resolveAwHome(env));
  const canonicalDestination = await canonicalizePathThroughExistingAncestor(destination);
  if (contains(canonicalSource, awHome) || (!options.trustedPluginSource && contains(awHome, canonicalSource))
    || contains(canonicalSource, canonicalDestination) || contains(canonicalDestination, canonicalSource)) {
    fail('commandResourceInvalid', 'The command source overlaps AW_HOME or the installation target.');
  }
  await validateManagedCommandResource(canonicalSource);
  await fs.mkdir(destination, { recursive: true });
  async function copy(sourceRoot: string, targetRoot: string): Promise<void> {
    for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
      const sourcePath = path.join(sourceRoot, entry.name);
      const targetPath = path.join(targetRoot, entry.name);
      const sourceStat = await fs.lstat(sourcePath);
      if (entry.name === '.git' || entry.name === COMMAND_PRODUCER_RECORD || entry.name === '.agent-workflows-owner.json' || sourceStat.isSymbolicLink()) fail('commandResourceInvalid', 'The command source contains a reserved path or a link.');
      if (sourceStat.isDirectory()) {
        await fs.mkdir(targetPath);
        await copy(sourcePath, targetPath);
      } else if (sourceStat.isFile()) {
        await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        await fs.chmod(targetPath, sourceStat.mode & 0o777);
      } else fail('commandResourceInvalid', 'The command source contains a special node.');
    }
  }
  await copy(canonicalSource, destination);
  await validateManagedCommandResource(destination);
}

export async function installUserCommand(options: {
  sourceDirectory: string; name: string; launch: CommandLaunch; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const root = await managedCommandRoot(options.env);
  const id = `cmdu_${crypto.randomUUID()}`;
  const userRoot = path.join(root, 'users', id);
  const revision = crypto.randomUUID();
  const name = validateManagedCommandName(options.name);
  const launch = parseManagedCommandLaunch(options.launch);
  await ensureRegularDirectoryPath(userRoot, 'User command root');
  await writeJson(root, path.join(userRoot, 'owner.json'), { schemaVersion: 1, owner: 'agent-workflows', kind: 'user-command', id });
  try {
    const resourceRoot = path.join(userRoot, 'packages', revision);
    await copyManagedCommandDirectory(options.sourceDirectory, resourceRoot, options.env);
    await validateManagedCommandResource(resourceRoot, launch);
    await writeJson(root, path.join(userRoot, 'definition.json'), { schemaVersion: 1, id, name, packageRevision: revision, launch });
    return id;
  } catch (error) {
    await safePath(root, userRoot);
    await fs.rm(userRoot, { recursive: true, force: true });
    throw error;
  }
}
export async function updateUserCommand(options: {
  id: string; sourceDirectory: string; name?: string; launch?: Partial<CommandLaunch>; env?: NodeJS.ProcessEnv;
}): Promise<{ errors: ManagedCommandDiagnostic[]; recoveryActions: string[] }> {
  const old = await readUserCommandDefinition(options.id, options.env);
  const root = await managedCommandRoot(options.env);
  const userRoot = await assertUserOwner(root, options.id);
  const revision = crypto.randomUUID();
  const resourceRoot = path.join(userRoot, 'packages', revision);
  const launch = parseManagedCommandLaunch({ ...old.launch, ...options.launch });
  const name = options.name === undefined ? old.name : validateManagedCommandName(options.name);
  try {
    await copyManagedCommandDirectory(options.sourceDirectory, resourceRoot, options.env);
    await validateManagedCommandResource(resourceRoot, launch);
    await writeJson(root, path.join(userRoot, 'definition.json'), { ...old, name, launch, packageRevision: revision });
  } catch (error) {
    await safePath(root, resourceRoot);
    await fs.rm(resourceRoot, { recursive: true, force: true });
    throw error;
  }
  const oldRoot = path.join(userRoot, 'packages', old.packageRevision);
  try {
    await safePath(root, oldRoot);
    await fs.rm(oldRoot, { recursive: true, force: true });
    return { errors: [], recoveryActions: [] };
  } catch {
    return {
      errors: [{ code: 'commandResourceInvalid', message: 'The new command revision is active, but the old revision could not be removed.' }],
      recoveryActions: [`aw command remove ${options.id} --force --yes`],
    };
  }
}
export async function removeUserCommand(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = await managedCommandRoot(env);
  const userRoot = await assertUserOwner(root, id);
  await fs.rm(userRoot, { recursive: true, force: true });
}

async function lstatIfExists(target: string): Promise<Stats | null> {
  try { return await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function entriesAt(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function readConfiguredSources(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  try {
    const sourceFile = resolveCatalogSourcesConfigPath(env);
    const stat = await lstatIfExists(sourceFile);
    if (stat && !stat.isFile()) fail('catalogSourcesConfigInvalid', 'Catalog sources config must be a regular file.');
    const { sources } = await readCatalogSourcesConfig(env);
    const identities = await Promise.all(sources.map(async (source) => [source.id, await calculateCatalogSourceIdentity(source)] as const));
    return new Map(identities);
  } catch (error) {
    if (error instanceof CatalogGenerationError) fail(error.code, error.message);
    fail('catalogSourcesConfigInvalid', 'Catalog sources config is unreadable or invalid. Repair catalog-sources.json, then run aw source sync.');
  }
}

async function resolvePluginCommandProducer(selector: string, env: NodeJS.ProcessEnv): Promise<ProducerIdentity> {
  const { sourceId, pluginName } = parsePluginCommandSelector(selector);
  const sourceIdentity = (await readConfiguredSources(env)).get(sourceId);
  if (sourceIdentity === undefined) fail('commandNotFound', 'The command source is no longer configured. Run aw command list to find packages by ID.');
  return { sourceId, sourceIdentity, pluginName };
}

export async function resolveManagedCommandPackageId(selector: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const producer = await resolvePluginCommandProducer(selector, env);
  const id = getCommandPackageId(producer);
  await assertExpectedPackage(await managedCommandRoot(env), id, producer);
  return id;
}

export function normalizeInstalledCommandProducer(value: unknown): InstalledCommandProducer {
  try {
    const record = normalizeCoreProducer(value);
    if (!equal(value, record)) fail('commandBindingInvalid', 'The installed producer must contain all normalized fields.');
    return record;
  } catch { fail('commandBindingInvalid', 'The installed command producer record is invalid. Run aw command package sync.'); }
}

export async function readInstalledCommandProducer(resourceRoot: string): Promise<InstalledCommandProducer> {
  return normalizeInstalledCommandProducer(await readJson(resourceRoot, path.join(resourceRoot, COMMAND_PRODUCER_RECORD), 'commandBindingInvalid'));
}

interface PackageOwner {
  producer: ProducerIdentity;
  packageRoot: string;
}

async function readPackageOwner(root: string, id: string): Promise<PackageOwner> {
  if (!isManagedCommandPackageId(id)) throw new ManagedCommandError('invalidArguments', 'A canonical package ID is required.', true);
  const packageRoot = path.join(root, 'packages', id);
  await safePath(root, packageRoot);
  const stat = await lstatIfExists(packageRoot);
  if (!stat) fail('commandNotFound', 'The command package is not installed. Run aw command package sync.');
  if (!stat.isDirectory()) fail('commandOwnerMismatch', 'The command package root must be a regular directory.');
  const owner = object(await readJson(root, path.join(packageRoot, 'owner.json'), 'commandOwnerMismatch'), ['schemaVersion', 'owner', 'kind', 'producer'], 'commandOwnerMismatch');
  let producer: ProducerIdentity;
  try { producer = normalizeProducerIdentity(owner.producer); } catch { fail('commandOwnerMismatch', 'The package owner identity is invalid.'); }
  if (owner.schemaVersion !== 2 || owner.owner !== 'agent-workflows' || owner.kind !== 'plugin-command-package'
    || !equal(owner.producer, producer) || getCommandPackageId(producer) !== id) {
    fail('commandOwnerMismatch', 'The command package owner marker does not match its directory.');
  }
  return { producer, packageRoot };
}

export async function readManagedCommandPackageOwner(id: string, env: NodeJS.ProcessEnv = process.env): Promise<PackageOwner> {
  return readPackageOwner(await managedCommandRoot(env), id);
}

async function readCurrentRevision(packageRoot: string): Promise<string> {
  const current = object(await readJson(packageRoot, path.join(packageRoot, 'current.json'), 'commandBindingInvalid'), ['schemaVersion', 'revision'], 'commandBindingInvalid');
  if (current.schemaVersion !== 2 || typeof current.revision !== 'string' || !REVISION_ID.test(current.revision)) {
    fail('commandBindingInvalid', 'The current command package revision is invalid. Run aw command package sync.');
  }
  return current.revision;
}

interface PinnedPackage {
  resourceRoot: string;
  record: InstalledCommandProducer;
}

async function currentResourceRoot(owner: PackageOwner): Promise<string> {
  const revision = await readCurrentRevision(owner.packageRoot);
  return path.join(owner.packageRoot, 'revisions', revision);
}

async function readPinnedPackage(owner: PackageOwner, resourceRoot: string): Promise<PinnedPackage> {
  await safePath(owner.packageRoot, resourceRoot);
  const record = await readInstalledCommandProducer(resourceRoot);
  if (!equal(owner.producer, record.producer)) fail('commandIdentityConflict', 'The command package revision does not match its owner.');
  return { resourceRoot, record };
}

async function validateInstalledNativeTools({ resourceRoot, record }: PinnedPackage): Promise<void> {
  if (record.nativeTools) {
    try { await validateNativeToolClosureFiles(resourceRoot, record.nativeTools); }
    catch { fail('commandBindingInvalid', 'The installed native tool closure does not match its files. Run aw command package sync.'); }
  }
}

async function validatePackageResources({ resourceRoot, record }: PinnedPackage): Promise<void> {
  await validateManagedCommandResource(resourceRoot);
  for (const launch of record.routes.subcommands) await validateCommandLaunchFile(resourceRoot, launch);
  if (record.routes.fallback) await validateCommandLaunchFile(resourceRoot, record.routes.fallback);
  await validateInstalledNativeTools({ resourceRoot, record });
  await validateManagedCommandRuntimeConfigFiles(resourceRoot, record);
}

function assertExpectedProducer(expected: ProducerIdentity, actual: ProducerIdentity): void {
  if (!equal(expected, actual)) fail('commandIdentityConflict', 'The command package belongs to a different source or plugin.');
}

export async function readManagedCommandPackage(
  producer: ProducerIdentity, env: NodeJS.ProcessEnv = process.env, options: { validateFiles?: boolean } = {},
): Promise<PinnedPackage | undefined> {
  const id = getCommandPackageId(producer);
  let owner: PackageOwner;
  try { owner = await readManagedCommandPackageOwner(id, env); }
  catch (error) { if (error instanceof ManagedCommandError && error.code === 'commandNotFound') return undefined; throw error; }
  assertExpectedProducer(producer, owner.producer);
  const pinned = await readPinnedPackage(owner, await currentResourceRoot(owner));
  if (options.validateFiles !== false) await validatePackageResources(pinned);
  return pinned;
}

function packageView(owner: PackageOwner, packageId: string, record?: InstalledCommandProducer, resourceRoot: string | null = null): ManagedCommandPackageView {
  const selector = `${owner.producer.sourceId}/${owner.producer.pluginName}`;
  const routes = record?.routes ?? null;
  return {
    selector, packageId, owner: { kind: 'plugin', producer: owner.producer },
    pluginVersion: record?.pluginVersion ?? null,
    sourceContentDigest: record?.sourceContentDigest ?? null,
    availability: routes ? (routes.subcommands.length || routes.fallback ? 'ready' : 'empty') : 'unavailable',
    resourceRoot,
    routes,
    subcommands: routes?.subcommands.map((entry) => entry.name) ?? [],
    hasFallback: routes?.fallback !== undefined,
    runtimeConfigPlatforms: record?.runtimeConfigPlatforms ?? [],
    requiresPlatformContext: record ? Boolean(record.runtimeConfigKeys?.length) : null,
    nativeTools: record?.nativeTools ?? null,
    errors: [],
    recoveryActions: [],
  };
}

async function inspectOwnedPackage(owner: PackageOwner, id: string): Promise<ManagedCommandPackageView> {
  let pinned: PinnedPackage | undefined;
  let resourceRoot: string | null = null;
  try {
    resourceRoot = await currentResourceRoot(owner);
    pinned = await readPinnedPackage(owner, resourceRoot);
    await validatePackageResources(pinned);
    return packageView(owner, id, pinned.record, resourceRoot);
  } catch (error) {
    const view = packageView(owner, id, pinned?.record, resourceRoot);
    view.availability = 'unavailable';
    view.requiresPlatformContext = null;
    view.errors.push(managedCommandDiagnostic(error));
    view.recoveryActions.push(`aw command package sync ${view.selector}`, `aw command package remove ${id} --force --yes`);
    return view;
  }
}

export async function readManagedCommandPackageView(id: string, env: NodeJS.ProcessEnv = process.env): Promise<ManagedCommandPackageView> {
  return inspectOwnedPackage(await readManagedCommandPackageOwner(id, env), id);
}

export interface ManagedCommandPackageEvidence {
  packageDigest: string;
}

// Hash only the live pointer and its revision. Unreachable staging and old revisions are not publication evidence.
export async function captureManagedCommandPackageEvidence(
  view: ManagedCommandPackageView, env: NodeJS.ProcessEnv = process.env, options: { force?: boolean } = {},
): Promise<ManagedCommandPackageEvidence> {
  const owner = await readManagedCommandPackageOwner(view.packageId, env);
  assertExpectedProducer(view.owner.producer, owner.producer);
  return capturePackageEvidence(owner, { reviewedRoot: view.resourceRoot, force: options.force });
}

async function capturePackageEvidence(owner: PackageOwner, options: { reviewedRoot?: string | null; force?: boolean } = {}): Promise<ManagedCommandPackageEvidence> {
  const { packageRoot } = owner;
  async function observedResourceRoot(): Promise<string | null> {
    try { return await currentResourceRoot(owner); }
    catch (error) { if (error instanceof ManagedCommandError) return null; throw error; }
  }
  const resourceRoot = await observedResourceRoot();
  if (options.reviewedRoot !== undefined && resourceRoot !== options.reviewedRoot) fail('operationReviewStale', 'The reviewed command package revision changed. Run the operation again.');
  const hash = crypto.createHash('sha256');
  const add = (fields: unknown[]) => hash.update(JSON.stringify(fields)).update('\n');
  const modeMask = process.platform === 'win32' ? 0o200 : 0o777;
  async function visit(file: string, descend: boolean): Promise<void> {
    const relative = path.relative(packageRoot, file).split(path.sep).join('/');
    const stat = await lstatIfExists(file);
    if (!stat) add(['missing', relative]);
    else if (stat.isSymbolicLink()) add(['symlink', relative, await fs.readlink(file)]);
    else if (stat.isDirectory()) {
      add(['directory', relative, stat.mode & modeMask, ...(descend ? [] : [stat.dev, stat.ino])]);
      if (descend) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), true);
    } else if (stat.isFile()) {
      try { add(['file', relative, stat.mode & modeMask, await calculateFileDigest(file)]); }
      catch (error) {
        if (!options.force || relative !== 'current.json') throw error;
        // The owner still authorizes deletion if the weak pointer itself is unreadable.
        add(['unreadable', relative, stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
      }
    } else add(['special', relative, stat.mode, stat.ino]);
  }
  add([options.force ? 'owner-and-pointer' : 'revision']);
  await visit(packageRoot, false);
  await visit(path.join(packageRoot, 'owner.json'), false);
  await visit(path.join(packageRoot, 'current.json'), false);
  if (resourceRoot && !options.force) {
    const revisions = path.dirname(resourceRoot);
    const stat = await lstatIfExists(revisions);
    await visit(stat?.isDirectory() ? resourceRoot : revisions, true);
  }
  if (await observedResourceRoot() !== resourceRoot) fail('operationReviewStale', 'The reviewed command package revision changed. Run the operation again.');
  return { packageDigest: `sha256:${hash.digest('hex')}` };
}

async function assertExpectedPackage(
  root: string, id: string, producer: ProducerIdentity, expected?: ManagedCommandPackageEvidence | null, force = false,
): Promise<PackageOwner | undefined> {
  let owner: PackageOwner | undefined;
  try { owner = await readPackageOwner(root, id); }
  catch (error) { if (!(error instanceof ManagedCommandError) || error.code !== 'commandNotFound') throw error; }
  if (owner) assertExpectedProducer(producer, owner.producer);
  if (expected === undefined) return owner;
  const current = owner ? await capturePackageEvidence(owner, { force }) : null;
  if (!equal(current, expected)) fail('operationReviewStale', 'The reviewed command package changed before publication or removal.');
  return owner;
}

/** Called with the AW_HOME mutation lock held. */
export async function removeManagedCommandPackage(
  id: string, env: NodeJS.ProcessEnv = process.env, options: { force?: boolean; expectedPackage?: ManagedCommandPackageEvidence } = {},
): Promise<{ producer: ProducerIdentity }> {
  const root = await managedCommandRoot(env);
  const owner = await readPackageOwner(root, id);
  const verified = await assertExpectedPackage(root, id, owner.producer, options.expectedPackage, options.force);
  if (!verified) fail('commandNotFound', 'The command package is no longer installed.');
  if (!options.force && (await inspectOwnedPackage(verified, id)).availability === 'unavailable') {
    fail('commandPackageUnavailable', 'The command package is damaged. Review and repeat package remove with --force.');
  }
  // Keep independent ownership evidence until all potentially busy revisions are gone.
  try {
    for (const name of await fs.readdir(verified.packageRoot)) {
      if (name !== 'owner.json') await fs.rm(path.join(verified.packageRoot, name), { recursive: true, force: true });
    }
    await fs.unlink(path.join(verified.packageRoot, 'owner.json'));
    await fs.rmdir(verified.packageRoot);
  } catch {
    fail('commandPackageRemovalFailed', `Could not finish removing the command package. Release its files and retry aw command package remove ${id} --force --yes.`);
  }
  return { producer: verified.producer };
}

/** Called with the AW_HOME mutation lock held. */
export async function syncManagedCommandPackage(options: {
  producer: ProducerIdentity;
  record: InstalledCommandProducer;
  sourceDirectory: string;
  env?: NodeJS.ProcessEnv;
  expectedPackage?: ManagedCommandPackageEvidence | null;
  expectedResourceDigest?: string;
}): Promise<{ id: string; resourceRoot: string; errors: ManagedCommandDiagnostic[]; recoveryActions: string[] }> {
  const env = options.env ?? process.env;
  const root = await managedCommandRoot(env);
  const producer = normalizeProducerIdentity(options.producer);
  const record = normalizeInstalledCommandProducer(options.record);
  assertExpectedProducer(producer, record.producer);
  const id = getCommandPackageId(producer);
  const packageRoot = path.join(root, 'packages', id);
  await ensureRegularDirectoryPath(path.dirname(packageRoot), 'Managed command packages');
  const revision = crypto.randomUUID();
  const staging = await fs.mkdtemp(path.join(path.dirname(packageRoot), `.${id}.`));
  const stagedRevision = path.join(staging, 'revisions', revision);
  const resourceRoot = path.join(packageRoot, 'revisions', revision);
  let unpublishedRevision: string | undefined;
  try {
    await copyManagedCommandDirectory(options.sourceDirectory, stagedRevision, env, { trustedPluginSource: true });
    if (options.expectedResourceDigest !== undefined
      && await calculateManagedCommandResourceDigest(stagedRevision) !== options.expectedResourceDigest) {
      fail('operationReviewStale', 'The prepared command package files changed after review. Run the operation again.');
    }
    await writeJson(stagedRevision, path.join(stagedRevision, COMMAND_PRODUCER_RECORD), record);
    await validatePackageResources({ resourceRoot: stagedRevision, record });
    const pointer = { schemaVersion: 2, revision };
    const owner = await assertExpectedPackage(root, id, producer, options.expectedPackage);
    if (owner) {
      await ensureRegularDirectoryPath(path.dirname(resourceRoot), 'Managed command revisions');
      await fs.rename(stagedRevision, resourceRoot);
      unpublishedRevision = resourceRoot;
      // Readers pin this pointer once. Earlier revisions can be removed only after the switch.
      await writeJson(packageRoot, path.join(packageRoot, 'current.json'), pointer);
      unpublishedRevision = undefined;
    } else {
      await writeJson(staging, path.join(staging, 'owner.json'), { schemaVersion: 2, owner: 'agent-workflows', kind: 'plugin-command-package', producer });
      await writeJson(staging, path.join(staging, 'current.json'), pointer);
      if (await lstatIfExists(packageRoot)) fail('operationReviewStale', 'The command package directory appeared before publication. Run the operation again.');
      await fs.rename(staging, packageRoot);
    }
  } finally {
    for (const directory of [staging, ...(unpublishedRevision ? [unpublishedRevision] : [])]) {
      try {
        await safePath(root, directory);
        await fs.rm(directory, { recursive: true, force: true });
      } catch { /* Best effort for a private, unpublished directory. */ }
    }
  }

  const errors: ManagedCommandDiagnostic[] = [];
  try {
    for (const name of await entriesAt(path.dirname(resourceRoot))) {
      if (name === revision || !REVISION_ID.test(name)) continue;
      const oldRoot = path.join(path.dirname(resourceRoot), name);
      try {
        await safePath(root, oldRoot);
        if ((await lstatIfExists(oldRoot))?.isDirectory()) await fs.rm(oldRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(managedCommandDiagnostic(error, name));
      }
    }
  } catch (error) {
    errors.push(managedCommandDiagnostic(error));
  }
  return { id, resourceRoot, errors, recoveryActions: errors.length ? [`aw command package sync ${producer.sourceId}/${producer.pluginName}`] : [] };
}

async function resolveUserCommand(id: string, env: NodeJS.ProcessEnv): Promise<{ view: UserCommandView; resourceRoot: string; launch: CommandLaunch }> {
  const root = await managedCommandRoot(env);
  const definition = await readUserCommandDefinition(id, env);
  const resourceRoot = path.join(root, 'users', id, 'packages', definition.packageRevision);
  await safePath(root, resourceRoot);
  await validateManagedCommandResource(resourceRoot, definition.launch);
  return { resourceRoot, launch: definition.launch, view: { id, name: definition.name, owner: { kind: 'user' }, availability: 'ready', resourceRoot, launch: definition.launch, errors: [], recoveryActions: [] } };
}

async function inspectUserCommand(id: string, env: NodeJS.ProcessEnv): Promise<UserCommandView> {
  try { return (await resolveUserCommand(id, env)).view; }
  catch (error) {
    if (error instanceof ManagedCommandError && (error.code === 'commandNotFound' || error.argumentError)) throw error;
    const root = await managedCommandRoot(env);
    const userRoot = await assertUserOwner(root, id);
    let name = id;
    let resourceRoot: string | null = null;
    let launch: CommandLaunch | null = null;
    try {
      const definition = await readUserCommandDefinition(id, env);
      name = definition.name;
      launch = definition.launch;
      resourceRoot = path.join(userRoot, 'packages', definition.packageRevision);
    } catch { /* Owner evidence still permits a diagnostic view and safe removal. */ }
    return { id, name, owner: { kind: 'user' }, availability: 'unavailable', resourceRoot, launch, errors: [managedCommandDiagnostic(error)], recoveryActions: [`aw command remove ${id} --force --yes`] };
  }
}

async function lookupNamedPackage(selector: string, env: NodeJS.ProcessEnv): Promise<{ packageId: string; owner: PackageOwner }> {
  const producer = await resolvePluginCommandProducer(selector, env);
  const packageId = getCommandPackageId(producer);
  const owner = await readManagedCommandPackageOwner(packageId, env);
  assertExpectedProducer(producer, owner.producer);
  return { packageId, owner };
}

export async function resolveManagedCommand(
  selector: string, env: NodeJS.ProcessEnv = process.env, options: { args: string[]; noFallback?: boolean } = { args: [] },
): Promise<{
  view: ManagedCommandView;
  launch: CommandLaunch;
  resourceRoot: string;
  producer?: InstalledCommandProducer;
  runtimeConfigContext?: CommandRuntimeConfigContext;
  args: string[];
}> {
  if (isUserCommandId(selector)) {
    if (options.noFallback) throw new ManagedCommandError('invalidArguments', '--no-fallback requires a plugin command and a subcommand argument.', true);
    return { ...await resolveUserCommand(selector, env), args: options.args };
  }
  if (options.noFallback && options.args.length === 0) {
    throw new ManagedCommandError('invalidArguments', '--no-fallback requires a subcommand argument.', true);
  }
  let invocation: ReturnType<typeof parseCommandInvocationSelector>;
  try { invocation = parseCommandInvocationSelector(selector); }
  catch { throw new ManagedCommandError('invalidArguments', 'A canonical source/plugin or source/plugin/platform selector is required.', true); }
  const { packageSelector, platform } = invocation;
  const { packageId, owner } = await lookupNamedPackage(packageSelector, env);
  let pinned: PinnedPackage;
  try { pinned = await readPinnedPackage(owner, await currentResourceRoot(owner)); }
  catch (error) {
    if (error instanceof ManagedCommandError && error.code === 'commandIdentityConflict') throw error;
    fail('commandUnavailable', 'The installed command package revision is missing or invalid. Run aw command package sync or aw plugin sync.');
  }
  const { resourceRoot, record } = pinned;
  if (record.runtimeConfigKeys?.length) {
    if (!platform) {
      const published = record.runtimeConfigPlatforms.join(', ') || '(none)';
      throw new ManagedCommandError('commandPlatformRequired',
        `The command requires a source/plugin/platform selector. Published runtime config platforms: ${published}.`, true);
    }
  } else if (platform) {
    throw new ManagedCommandError('commandPlatformUnexpected', 'This command does not accept a platform in its selector.', true);
  }
  const subcommand = record.routes.subcommands.find((entry) => entry.name === options.args[0]);
  const fallback = options.noFallback ? undefined : record.routes.fallback;
  let launch: CommandLaunch;
  if (subcommand) {
    const { name: _name, ...selected } = subcommand;
    launch = selected;
  } else if (fallback) {
    launch = fallback;
  } else {
    const names = record.routes.subcommands.map((entry) => entry.name);
    const hint = names.length ? `Available subcommands: ${names.join(', ')}.` : 'There are no enabled subcommands.';
    throw new ManagedCommandError('commandRouteNotFound', `No command route matched ${selector}. ${hint}`, true);
  }
  if (platform) await validateManagedCommandRuntimeConfigFiles(resourceRoot, record, platform);
  await validateManagedCommandResource(resourceRoot, launch, { skipRuntimeConfigSnapshots: platform !== undefined });
  await validateInstalledNativeTools(pinned);
  return {
    view: packageView(owner, packageId, record, resourceRoot), launch, resourceRoot, producer: record,
    ...(platform ? { runtimeConfigContext: { schemaVersion: 1, platform, packageId, revision: path.basename(resourceRoot) } } : {}),
    args: subcommand ? options.args.slice(1) : options.args,
  };
}

export async function inspectManagedCommand(selector: string, env: NodeJS.ProcessEnv = process.env): Promise<ManagedCommandView> {
  if (isUserCommandId(selector)) return inspectUserCommand(selector, env);
  const { packageId, owner } = await lookupNamedPackage(selector, env);
  return inspectOwnedPackage(owner, packageId);
}

export async function listManagedCommandPackages(env: NodeJS.ProcessEnv = process.env): Promise<{
  packages: ManagedCommandPackageView[]; orphanedPackages: ManagedCommandPackageView[]; errors: ManagedCommandDiagnostic[];
}> {
  const root = await managedCommandRoot(env);
  const packages: ManagedCommandPackageView[] = [];
  const orphanedPackages: ManagedCommandPackageView[] = [];
  const errors: ManagedCommandDiagnostic[] = [];
  const directory = path.join(root, 'packages');
  await safePath(root, directory);
  const ids = (await entriesAt(directory)).sort();
  let sources: Map<string, string> | undefined;
  let sourceError: ManagedCommandDiagnostic | undefined;
  if (ids.some(isManagedCommandPackageId)) {
    try { sources = await readConfiguredSources(env); }
    catch (error) { sourceError = managedCommandDiagnostic(error); errors.push(sourceError); }
  }
  for (const id of ids) {
    if (!isManagedCommandPackageId(id)) {
      if (!id.startsWith('.')) errors.push({ code: 'commandOwnerMismatch', message: 'An unrecognized command package was retained.', subject: `commands/packages/${id}` });
      continue;
    }
    try {
      const owner = await readPackageOwner(root, id);
      const view = await inspectOwnedPackage(owner, id);
      if (sources?.get(owner.producer.sourceId) === owner.producer.sourceIdentity) {
        packages.push(view);
      } else {
        const wasDamaged = view.availability === 'unavailable';
        view.availability = 'unavailable';
        view.requiresPlatformContext = null;
        view.errors.push(sourceError ?? { code: 'commandNotFound', message: 'This command package belongs to a source that was removed or changed.' });
        view.recoveryActions = [`aw command package remove ${id}${wasDamaged ? ' --force' : ''} --yes`];
        orphanedPackages.push(view);
      }
    } catch (error) { errors.push(managedCommandDiagnostic(error, `commands/packages/${id}`)); }
  }
  return { packages, orphanedPackages, errors };
}

export async function listManagedCommands(env: NodeJS.ProcessEnv = process.env): Promise<{
  commands: UserCommandView[]; packages: ManagedCommandPackageView[]; orphanedPackages: ManagedCommandPackageView[]; errors: ManagedCommandDiagnostic[];
}> {
  const root = await managedCommandRoot(env);
  const commands: UserCommandView[] = [];
  const errors: ManagedCommandDiagnostic[] = [];
  const usersRoot = path.join(root, 'users');
  await safePath(root, usersRoot);
  for (const id of (await entriesAt(usersRoot)).sort()) {
    if (!isUserCommandId(id)) {
      errors.push({ code: 'commandBindingInvalid', message: 'An unrecognized command record was retained.', subject: `commands/users/${id}` });
      continue;
    }
    try { commands.push(await inspectUserCommand(id, env)); }
    catch (error) { errors.push(managedCommandDiagnostic(error, `commands/users/${id}`)); }
  }
  const packages = await listManagedCommandPackages(env);
  return { ...packages, commands, errors: [...errors, ...packages.errors] };
}
