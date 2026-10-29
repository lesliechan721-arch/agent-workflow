import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  getCommandPackageId,
  getPluginCommandId,
  isManagedCommandId,
  normalizeCommandIdentity,
  normalizeCommandLaunch,
  normalizeInstalledCommandProducer as normalizeCoreProducer,
  normalizeUserCommandDefinition,
  normalizeProducerIdentity,
  COMMAND_PRODUCER_RECORD_FILE,
  type CommandIdentity,
  type CommandLaunch,
  type ProducerIdentity,
  type InstalledCommandProducer,
  type UserCommandDefinition,
} from '@lesliechan721/aw-plugin-core/manifest';

import { verifyManagedCommandArtifactEvidence } from './managed-command-evidence.js';
import { atomicReplaceSafeFile } from './safe-fs.js';
import {
  canonicalizePathThroughExistingAncestor,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

export const COMMAND_PRODUCER_RECORD = COMMAND_PRODUCER_RECORD_FILE;
export type { InstalledCommandProducer, UserCommandDefinition };
const USER_ID = /^cmdu_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_ID = /^pkg_[0-9a-f]{64}$/u;

export interface ManagedCommandDiagnostic { code: string; message: string; subject?: string }
export class ManagedCommandError extends Error {
  constructor(public readonly code: string, message: string, public readonly argumentError = false) {
    super(message);
  }
}
export type InstalledCommandSet = InstalledCommandProducer['sets'][number];
export interface ManagedCommandBinding {
  schemaVersion: 1;
  id: string;
  identity: CommandIdentity;
  resourceRoot: string;
}
export interface ManagedCommandView {
  id: string;
  name: string;
  owner: { kind: 'user' } | { kind: 'plugin'; producer: ProducerIdentity };
  availability: 'ready' | 'unavailable';
  resourceRoot: string | null;
  launch: CommandLaunch | null;
  errors: ManagedCommandDiagnostic[];
  recoveryActions: string[];
}
export interface ManagedCommandPackageView {
  id: string;
  producer: ProducerIdentity;
  resourceRoot: string;
  availability: 'ready' | 'empty' | 'unavailable';
  sets: Array<{ set: string; state: 'present' | 'disabled'; commandIds: string[] }>;
  errors: ManagedCommandDiagnostic[];
  recoveryActions: string[];
}

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
export function assertUserCommandId(id: string): void {
  if (/^cmdp_[0-9a-f]{64}$/u.test(id)) fail('commandOwnerMismatch', 'Plugin commands must be maintained with their producer sync, reinstall, or package remove command.');
  if (!USER_ID.test(id)) throw new ManagedCommandError('invalidArguments', 'A canonical user command ID is required.', true);
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
export async function validateManagedCommandResource(resourceRoot: string, launch?: CommandLaunch): Promise<void> {
  const root = path.resolve(resourceRoot);
  await safePath(path.dirname(root), root);
  async function visit(directory: string): Promise<void> {
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('commandResourceInvalid', 'The command resource root must be a regular directory.');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        fail('commandResourceInvalid', 'Command resources cannot contain links, special nodes, or .git directories.');
      }
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  if (!launch) return;
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

export function normalizeInstalledCommandProducer(value: unknown): InstalledCommandProducer {
  try {
    const record = normalizeCoreProducer(value);
    if (!equal(value, record)) fail('commandBindingInvalid', 'The installed producer must contain all normalized fields.');
    return record;
  } catch { fail('commandBindingInvalid', 'The installed command producer record is invalid.'); }
}
export async function readInstalledCommandProducer(resourceRoot: string): Promise<InstalledCommandProducer> {
  return normalizeInstalledCommandProducer(await readJson(resourceRoot, path.join(resourceRoot, COMMAND_PRODUCER_RECORD), 'commandBindingInvalid'));
}
export async function writeInstalledCommandProducer(resourceRoot: string, record: InstalledCommandProducer): Promise<void> {
  await writeJson(resourceRoot, path.join(resourceRoot, COMMAND_PRODUCER_RECORD), normalizeInstalledCommandProducer(record));
}
async function readBinding(root: string, id: string): Promise<ManagedCommandBinding> {
  const value = object(await readJson(root, path.join(root, 'bindings', `${id}.json`), 'commandBindingInvalid'), ['schemaVersion', 'id', 'identity', 'resourceRoot'], 'commandBindingInvalid');
  let identity: CommandIdentity;
  try { identity = normalizeCommandIdentity(value.identity); } catch { fail('commandBindingInvalid', 'The command binding identity is invalid.'); }
  if (value.schemaVersion !== 1 || value.id !== id || getPluginCommandId(identity) !== id || typeof value.resourceRoot !== 'string' || !path.isAbsolute(value.resourceRoot)) fail('commandIdentityConflict', 'The command binding does not match its identity.');
  return { schemaVersion: 1, id, identity, resourceRoot: value.resourceRoot };
}
async function entriesAt(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function revokeManagedCommandBindings(producer: ProducerIdentity, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const root = await managedCommandRoot(env);
  const removed: string[] = [];
  await safePath(root, path.join(root, 'bindings'));
  for (const file of await entriesAt(path.join(root, 'bindings'))) {
    if (!/^cmdp_[0-9a-f]{64}\.json$/u.test(file)) continue;
    const id = file.slice(0, -5);
    try {
      const binding = await readBinding(root, id);
      if (!equal(binding.identity.producer, producer)) continue;
      await fs.unlink(path.join(root, 'bindings', file));
      removed.push(id);
    } catch { /* Corrupt indexes cannot authorize removal of other producers. */ }
  }
  return removed;
}
export async function publishManagedCommandBindings(options: {
  producer: ProducerIdentity; resourceRoot: string; sets: InstalledCommandSet[]; env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const record = normalizeInstalledCommandProducer({ schemaVersion: 1, producer: options.producer, sets: options.sets });
  const root = await managedCommandRoot(options.env);
  const resourceRoot = path.resolve(options.resourceRoot);
  for (const set of record.sets) for (const entry of set.entries) await validateManagedCommandResource(resourceRoot, entry);
  const ids: string[] = [];
  const candidates: ManagedCommandBinding[] = [];
  for (const set of record.sets) for (const entry of set.entries) {
    const identity: CommandIdentity = { schemaVersion: 1, producer: record.producer, set: set.set, key: entry.key, variant: entry.variant };
    const id = getPluginCommandId(identity);
    const existingPath = path.join(root, 'bindings', `${id}.json`);
    if (await fs.lstat(existingPath).catch(() => null)) {
      const existing = await readBinding(root, id);
      if (!equal(existing.identity, identity)) fail('commandIdentityConflict', 'The command ID already belongs to another identity.');
    }
    candidates.push({ schemaVersion: 1, id, identity, resourceRoot });
    ids.push(id);
  }
  await writeInstalledCommandProducer(resourceRoot, record);
  await revokeManagedCommandBindings(record.producer, options.env);
  for (const binding of candidates) await writeJson(root, path.join(root, 'bindings', `${binding.id}.json`), binding);
  return ids;
}

export async function readManagedCommandPackageOwner(id: string, env: NodeJS.ProcessEnv = process.env): Promise<{ producer: ProducerIdentity; resourceRoot: string }> {
  if (!PACKAGE_ID.test(id)) throw new ManagedCommandError('invalidArguments', 'A canonical package ID is required.', true);
  const root = await managedCommandRoot(env);
  const packageRoot = path.join(root, 'packages', id);
  const owner = object(await readJson(root, path.join(packageRoot, 'owner.json'), 'commandOwnerMismatch'), ['schemaVersion', 'owner', 'kind', 'producer'], 'commandOwnerMismatch');
  let producer: ProducerIdentity;
  try { producer = normalizeProducerIdentity(owner.producer); } catch { fail('commandOwnerMismatch', 'The package owner identity is invalid.'); }
  if (owner.schemaVersion !== 1 || owner.owner !== 'agent-workflows' || owner.kind !== 'plugin-command-package' || producer.kind !== 'package' || getCommandPackageId(producer) !== id) fail('commandOwnerMismatch', 'The package owner marker does not match its directory.');
  return { producer, resourceRoot: path.join(packageRoot, 'resource') };
}
export async function removeManagedCommandPackage(id: string, env: NodeJS.ProcessEnv = process.env): Promise<{ producer: ProducerIdentity; removedCommandIds: string[] }> {
  const { producer } = await readManagedCommandPackageOwner(id, env);
  const root = await managedCommandRoot(env);
  const removedCommandIds = await revokeManagedCommandBindings(producer, env);
  await fs.rm(path.join(root, 'packages', id), { recursive: true, force: true });
  return { producer, removedCommandIds };
}
export async function syncManagedCommandPackage(options: {
  producer: ProducerIdentity; sourceDirectory: string; sets: InstalledCommandSet[]; env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; resourceRoot: string; commandIds: string[]; removedCommandIds: string[] }> {
  const producer = normalizeProducerIdentity(options.producer);
  if (producer.kind !== 'package') fail('commandOwnerMismatch', 'A package producer is required.');
  const root = await managedCommandRoot(options.env);
  const id = getCommandPackageId(producer);
  const packagesRoot = path.join(root, 'packages');
  await ensureRegularDirectoryPath(packagesRoot, 'Managed command packages');
  const packageRoot = path.join(packagesRoot, id);
  const staging = path.join(packagesRoot, `.${id}.${crypto.randomUUID()}.tmp`);
  if (await fs.lstat(packageRoot).catch(() => null)) await readManagedCommandPackageOwner(id, options.env);
  await ensureRegularDirectoryPath(staging, 'Managed command package staging');
  try {
    const resourceRoot = path.join(staging, 'resource');
    await copyManagedCommandDirectory(options.sourceDirectory, resourceRoot, options.env);
    const record = normalizeInstalledCommandProducer({ schemaVersion: 1, producer, sets: options.sets });
    for (const set of record.sets) for (const entry of set.entries) await validateManagedCommandResource(resourceRoot, entry);
    await writeInstalledCommandProducer(resourceRoot, record);
    await writeJson(root, path.join(staging, 'owner.json'), { schemaVersion: 1, owner: 'agent-workflows', kind: 'plugin-command-package', producer });
    const removed = await revokeManagedCommandBindings(producer, options.env);
    if (await fs.lstat(packageRoot).catch(() => null)) {
      await readManagedCommandPackageOwner(id, options.env);
      await fs.rm(packageRoot, { recursive: true, force: true });
    }
    await fs.rename(staging, packageRoot);
    const installedRoot = path.join(packageRoot, 'resource');
    const commandIds = await publishManagedCommandBindings({ producer, resourceRoot: installedRoot, sets: record.sets, env: options.env });
    return { id, resourceRoot: installedRoot, commandIds, removedCommandIds: removed.filter((commandId) => !commandIds.includes(commandId)) };
  } finally {
    await safePath(root, staging);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function assertManagedCommandProducerOwnership(producer: ProducerIdentity, resourceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (producer.kind === 'package') {
    const owned = await readManagedCommandPackageOwner(getCommandPackageId(producer), env);
    if (!equal(owned.producer, producer) || owned.resourceRoot !== resourceRoot) fail('commandOwnerMismatch', 'The command package root does not match its owner.');
    return;
  }
  try { await verifyManagedCommandArtifactEvidence({ producer, resourceRoot, env }); }
  catch { fail('commandOwnerMismatch', 'The command producer has no matching live ownership or native receipt evidence.'); }
}
export async function resolveManagedCommand(id: string, env: NodeJS.ProcessEnv = process.env): Promise<{ view: ManagedCommandView; launch: CommandLaunch; resourceRoot: string }> {
  if (!isManagedCommandId(id)) throw new ManagedCommandError('invalidArguments', 'A canonical managed command ID is required.', true);
  const root = await managedCommandRoot(env);
  if (USER_ID.test(id)) {
    if (!(await fs.lstat(path.join(root, 'users', id)).catch(() => null))) fail('commandNotFound', 'The command ID is not installed.');
    const definition = await readUserCommandDefinition(id, env);
    const resourceRoot = path.join(root, 'users', id, 'packages', definition.packageRevision);
    await safePath(root, resourceRoot);
    await validateManagedCommandResource(resourceRoot, definition.launch);
    return { resourceRoot, launch: definition.launch, view: { id, name: definition.name, owner: { kind: 'user' }, availability: 'ready', resourceRoot, launch: definition.launch, errors: [], recoveryActions: [] } };
  }
  if (!(await fs.lstat(path.join(root, 'bindings', `${id}.json`)).catch(() => null))) fail('commandNotFound', 'The command binding is missing. Use sync, reinstall, or package sync.');
  const binding = await readBinding(root, id);
  await assertManagedCommandProducerOwnership(binding.identity.producer, binding.resourceRoot, env);
  const record = await readInstalledCommandProducer(binding.resourceRoot);
  if (!equal(record.producer, binding.identity.producer)) fail('commandIdentityConflict', 'The installed producer does not match the command binding.');
  const set = record.sets.find((candidate) => candidate.set === binding.identity.set && candidate.state === 'present');
  const entry = set?.entries.find((candidate) => candidate.key === binding.identity.key && candidate.variant === binding.identity.variant);
  if (!entry) fail('commandBindingInvalid', 'The command is absent or disabled in the installed producer.');
  const { key: _key, variant: _variant, ...launch } = entry;
  await validateManagedCommandResource(binding.resourceRoot, launch);
  return { resourceRoot: binding.resourceRoot, launch, view: { id, name: `${binding.identity.set}/${entry.key}/${entry.variant}`, owner: { kind: 'plugin', producer: record.producer }, availability: 'ready', resourceRoot: binding.resourceRoot, launch, errors: [], recoveryActions: [] } };
}
export async function inspectManagedCommand(id: string, env: NodeJS.ProcessEnv = process.env): Promise<ManagedCommandView> {
  try { return (await resolveManagedCommand(id, env)).view; }
  catch (error) {
    if (error instanceof ManagedCommandError && (error.code === 'commandNotFound' || error.argumentError)) throw error;
    const root = await managedCommandRoot(env);
    let owner: ManagedCommandView['owner'];
    let name = id;
    let resourceRoot: string | null = null;
    let launch: CommandLaunch | null = null;
    if (USER_ID.test(id)) {
      await assertUserOwner(root, id);
      owner = { kind: 'user' };
      try {
        const definition = await readUserCommandDefinition(id, env);
        name = definition.name;
        launch = definition.launch;
        resourceRoot = path.join(root, 'users', id, 'packages', definition.packageRevision);
      } catch { /* Owner evidence still permits a diagnostic view and safe removal. */ }
    } else {
      const binding = await readBinding(root, id);
      owner = { kind: 'plugin', producer: binding.identity.producer };
      name = `${binding.identity.set}/${binding.identity.key}/${binding.identity.variant}`;
      resourceRoot = binding.resourceRoot;
    }
    return { id, name, owner, availability: 'unavailable', resourceRoot, launch, errors: [managedCommandDiagnostic(error)], recoveryActions: [owner.kind === 'user' ? `aw command remove ${id} --force --yes` : 'Run producer sync, reinstall, or package sync.'] };
  }
}
export async function listManagedCommandPackages(env: NodeJS.ProcessEnv = process.env): Promise<{ packages: ManagedCommandPackageView[]; errors: ManagedCommandDiagnostic[] }> {
  const root = await managedCommandRoot(env);
  const packages: ManagedCommandPackageView[] = [];
  const errors: ManagedCommandDiagnostic[] = [];
  await safePath(root, path.join(root, 'packages'));
  for (const id of (await entriesAt(path.join(root, 'packages'))).sort()) {
    if (!PACKAGE_ID.test(id)) {
      if (!id.startsWith('.')) errors.push({ code: 'commandOwnerMismatch', message: 'An unrecognized command package was retained.', subject: `commands/packages/${id}` });
      continue;
    }
    try {
      const { producer, resourceRoot } = await readManagedCommandPackageOwner(id, env);
      const view: ManagedCommandPackageView = { id, producer, resourceRoot, availability: 'unavailable', sets: [], errors: [], recoveryActions: [] };
      try {
        const record = await readInstalledCommandProducer(resourceRoot);
        if (!equal(record.producer, producer)) fail('commandIdentityConflict', 'The package content and owner identities differ.');
        await validateManagedCommandResource(resourceRoot);
        view.sets = record.sets.map((set) => ({ set: set.set, state: set.state, commandIds: set.entries.map((entry) => getPluginCommandId({ schemaVersion: 1, producer, set: set.set, key: entry.key, variant: entry.variant })) }));
        for (const set of view.sets) for (const commandId of set.commandIds) await resolveManagedCommand(commandId, env);
        view.availability = view.sets.some((set) => set.commandIds.length) ? 'ready' : 'empty';
      } catch (error) {
        view.errors.push(managedCommandDiagnostic(error));
        view.recoveryActions.push(`aw command package remove ${id} --force --yes`, 'Run package sync.');
      }
      packages.push(view);
    } catch (error) { errors.push(managedCommandDiagnostic(error, `commands/packages/${id}`)); }
  }
  return { packages, errors };
}
export async function listManagedCommands(env: NodeJS.ProcessEnv = process.env): Promise<{ commands: ManagedCommandView[]; packages: ManagedCommandPackageView[]; errors: ManagedCommandDiagnostic[] }> {
  const root = await managedCommandRoot(env);
  const commands: ManagedCommandView[] = [];
  const errors: ManagedCommandDiagnostic[] = [];
  for (const kind of ['users', 'bindings']) {
    await safePath(root, path.join(root, kind));
    for (const file of (await entriesAt(path.join(root, kind))).sort()) {
      const id = kind === 'bindings' ? file.replace(/\.json$/u, '') : file;
      if (!(kind === 'users' ? USER_ID.test(id) : /^cmdp_[0-9a-f]{64}\.json$/u.test(file))) {
        errors.push({ code: 'commandBindingInvalid', message: 'An unrecognized command record was retained.', subject: `commands/${kind}/${file}` });
        continue;
      }
      try { commands.push(await inspectManagedCommand(id, env)); }
      catch (error) { errors.push(managedCommandDiagnostic(error, `commands/${kind}/${file}`)); }
    }
  }
  const packageResult = await listManagedCommandPackages(env);
  return { commands, packages: packageResult.packages, errors: [...errors, ...packageResult.errors] };
}
