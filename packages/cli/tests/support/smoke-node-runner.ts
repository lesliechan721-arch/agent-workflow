import path from 'node:path';

import fs from 'node:fs/promises';

import {
  execFileNativeCliRunner,
  type NativeCliResult,
} from '../../src/utils/native-cli.js';

interface SmokePathIdentity {
  readonly device: number;
  readonly inode: number;
  readonly kind: 'directory' | 'file' | 'other';
}

interface SmokeBoundAncestor {
  readonly absolutePath: string;
  readonly identity: SmokePathIdentity;
}

export interface SmokeParentBinding {
  readonly canonicalPath: string;
  readonly identity: SmokePathIdentity;
  readonly ancestors: readonly SmokeBoundAncestor[];
}

export interface SmokeOwnedPath {
  absolutePath: string;
  parentBinding?: SmokeParentBinding;
  parentRoot?: string;
  basename: string;
}

export type SmokeJsonValidator<T> = (value: unknown) => value is T;

interface SmokeNodeProcessOptions {
  scriptPath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  cleanupOnFailure: SmokeOwnedPath[];
}

interface SmokeSnapshotParentTestHooks {
  afterAncestorLstat?: (ancestorPath: string) => Promise<void> | void;
}

let snapshotParentTestHooks: SmokeSnapshotParentTestHooks | undefined;

export function setSmokeSnapshotParentTestHooksForTests(
  hooks: SmokeSnapshotParentTestHooks | undefined,
): void {
  snapshotParentTestHooks = hooks;
}

function identifyPath(stats: Awaited<ReturnType<typeof fs.lstat>>): SmokePathIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
  };
}

function sameIdentity(left: SmokePathIdentity, right: SmokePathIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.kind === right.kind;
}

async function inspectDirectory(candidatePath: string, label: string): Promise<SmokePathIdentity> {
  const stats = await fs.lstat(candidatePath);
  if (stats.isSymbolicLink()) throw new Error(`${label} refuses a symbolic link: ${candidatePath}`);
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${candidatePath}`);
  return identifyPath(stats);
}

async function assertParentBinding(binding: SmokeParentBinding): Promise<void> {
  for (const ancestor of binding.ancestors) {
    let currentIdentity: SmokePathIdentity;
    try {
      currentIdentity = await inspectDirectory(ancestor.absolutePath, 'Smoke snapshot parent');
    } catch (error) {
      throw new Error(`Smoke snapshot parent binding changed: ${ancestor.absolutePath}`, {
        cause: error,
      });
    }
    if (!sameIdentity(currentIdentity, ancestor.identity)) {
      throw new Error(`Smoke snapshot parent identity changed: ${ancestor.absolutePath}`);
    }
  }
  if (!sameIdentity(binding.identity, binding.ancestors.at(-1)!.identity)) {
    throw new Error(`Smoke snapshot parent binding is inconsistent: ${binding.canonicalPath}`);
  }
}

/**
 * Create and bind a cleanup parent without resolving it again after the binding is returned.
 *
 * Node has no openat-style directory handle API. Each single-component mkdir is therefore
 * bracketed by identity checks of every already bound ancestor. A concurrent replacement can
 * at most receive the newly created empty component; it cannot authorize child startup or cleanup.
 */
export async function prepareSmokeSnapshotParent(parentRoot: string): Promise<SmokeParentBinding> {
  const resolvedParent = path.resolve(parentRoot);
  const filesystemRoot = path.parse(resolvedParent).root;
  const ancestors: SmokeBoundAncestor[] = [];
  const rootIdentity = await inspectDirectory(filesystemRoot, 'Smoke snapshot parent');
  ancestors.push({ absolutePath: filesystemRoot, identity: rootIdentity });
  let currentPath = filesystemRoot;
  const relativeSegments = path.relative(filesystemRoot, resolvedParent)
    .split(path.sep)
    .filter(Boolean);

  for (const segment of relativeSegments) {
    currentPath = path.join(currentPath, segment);
    let identity: SmokePathIdentity;
    try {
      identity = await inspectDirectory(currentPath, 'Smoke snapshot parent');
      await snapshotParentTestHooks?.afterAncestorLstat?.(currentPath);
      await assertParentBinding({
        canonicalPath: ancestors.at(-1)!.absolutePath,
        identity: ancestors.at(-1)!.identity,
        ancestors,
      });
      const recheckedIdentity = await inspectDirectory(currentPath, 'Smoke snapshot parent');
      if (!sameIdentity(identity, recheckedIdentity)) {
        throw new Error(`Smoke snapshot parent identity changed: ${currentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await assertParentBinding({
        canonicalPath: ancestors.at(-1)!.absolutePath,
        identity: ancestors.at(-1)!.identity,
        ancestors,
      });
      try {
        await fs.mkdir(currentPath);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      await assertParentBinding({
        canonicalPath: ancestors.at(-1)!.absolutePath,
        identity: ancestors.at(-1)!.identity,
        ancestors,
      });
      identity = await inspectDirectory(currentPath, 'Smoke snapshot parent');
    }
    ancestors.push({ absolutePath: currentPath, identity });
  }

  const immutableAncestors = Object.freeze(ancestors.map((ancestor) => Object.freeze({
    absolutePath: ancestor.absolutePath,
    identity: Object.freeze({ ...ancestor.identity }),
  })));
  const binding: SmokeParentBinding = Object.freeze({
    canonicalPath: resolvedParent,
    identity: immutableAncestors.at(-1)!.identity,
    ancestors: immutableAncestors,
  });
  await assertParentBinding(binding);
  return binding;
}

interface BoundSmokeOwnedPath {
  absolutePath: string;
  parentBinding: SmokeParentBinding;
  basename: string;
  initialIdentity: SmokePathIdentity | null;
}

function resolveOwnedPathDescriptor(
  owned: SmokeOwnedPath,
  parentBinding: SmokeParentBinding,
): {
  absolutePath: string;
  parentBinding: SmokeParentBinding;
  basename: string;
} {
  const parentRoot = parentBinding.canonicalPath;
  const absolutePath = path.resolve(owned.absolutePath);
  if (
    owned.absolutePath !== absolutePath
    || path.dirname(absolutePath) !== parentRoot
    || path.basename(absolutePath) !== owned.basename
    || absolutePath !== path.join(parentRoot, owned.basename)
  ) {
    throw new Error(`Smoke cleanup path is not an exact owned child: ${owned.absolutePath}`);
  }
  return { absolutePath, parentBinding, basename: owned.basename };
}

async function inspectPath(candidatePath: string): Promise<SmokePathIdentity | null> {
  try {
    const stats = await fs.lstat(candidatePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Smoke cleanup refuses a symbolic link: ${candidatePath}`);
    }
    return identifyPath(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function bindOwnedPath(owned: SmokeOwnedPath): Promise<BoundSmokeOwnedPath> {
  if (!owned.parentBinding && !owned.parentRoot) {
    throw new Error(`Smoke cleanup path has no parent binding: ${owned.absolutePath}`);
  }
  const parentBinding = owned.parentBinding
    ?? await prepareSmokeSnapshotParent(owned.parentRoot!);
  const resolved = resolveOwnedPathDescriptor(owned, parentBinding);
  await assertParentBinding(resolved.parentBinding);
  const initialIdentity = await inspectPath(resolved.absolutePath);
  await assertParentBinding(resolved.parentBinding);
  return { ...resolved, initialIdentity };
}

async function bindOwnedPaths(ownedPaths: SmokeOwnedPath[]): Promise<BoundSmokeOwnedPath[]> {
  const bound: BoundSmokeOwnedPath[] = [];
  for (const ownedPath of ownedPaths) bound.push(await bindOwnedPath(ownedPath));
  return bound;
}

async function assertBoundParent(owned: BoundSmokeOwnedPath): Promise<void> {
  await assertParentBinding(owned.parentBinding);
  const parentRoot = owned.parentBinding.canonicalPath;
  if (
    path.dirname(owned.absolutePath) !== parentRoot
    || path.basename(owned.absolutePath) !== owned.basename
    || owned.absolutePath !== path.join(parentRoot, owned.basename)
  ) {
    throw new Error(`Smoke cleanup path is no longer an exact owned child: ${owned.absolutePath}`);
  }
}

async function cleanupOwnedPath(owned: BoundSmokeOwnedPath): Promise<void> {
  await assertBoundParent(owned);
  const currentIdentity = await inspectPath(owned.absolutePath);
  if (!currentIdentity) return;
  if (owned.initialIdentity && !sameIdentity(currentIdentity, owned.initialIdentity)) {
    throw new Error(`Smoke cleanup owned path identity changed: ${owned.absolutePath}`);
  }
  if (currentIdentity.kind === 'other') {
    throw new Error(`Smoke cleanup owned path has an unsupported node type: ${owned.absolutePath}`);
  }
  await assertBoundParent(owned);
  await fs.rm(owned.absolutePath, { force: true, recursive: true });
}

async function cleanupOwnedPaths(ownedPaths: BoundSmokeOwnedPath[]): Promise<void> {
  const sortedPaths = [...ownedPaths].sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  );
  for (const ownedPath of sortedPaths) await cleanupOwnedPath(ownedPath);
}

async function runBoundSmokeNodeProcess(
  options: SmokeNodeProcessOptions,
  cleanupPaths: BoundSmokeOwnedPath[],
): Promise<NativeCliResult> {
  for (const cleanupPath of cleanupPaths) await assertBoundParent(cleanupPath);
  try {
    return await execFileNativeCliRunner({
      command: process.execPath,
      args: [options.scriptPath, ...options.args],
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    try {
      await cleanupOwnedPaths(cleanupPaths);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Smoke Node process failed and owned path cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runSmokeNodeProcess(
  options: SmokeNodeProcessOptions,
): Promise<NativeCliResult> {
  const cleanupPaths = await bindOwnedPaths(options.cleanupOnFailure);
  return runBoundSmokeNodeProcess(options, cleanupPaths);
}

export async function runSmokeNodeJson<T>(
  options: SmokeNodeProcessOptions,
  validator: SmokeJsonValidator<T>,
): Promise<T> {
  const cleanupPaths = await bindOwnedPaths(options.cleanupOnFailure);
  const result = await runBoundSmokeNodeProcess(options, cleanupPaths);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!validator(parsed)) {
      throw new TypeError('Smoke Node output did not match the expected JSON structure.');
    }
    return parsed;
  } catch (error) {
    try {
      await cleanupOwnedPaths(cleanupPaths);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Smoke Node output was invalid and owned path cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}
