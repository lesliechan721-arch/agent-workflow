import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function assertDescendant(allowedRoot: string, candidatePath: string, label: string): {
  root: string;
  candidate: string;
} {
  const root = path.resolve(allowedRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its allowed root: ${candidate}`);
  }
  return { root, candidate };
}

async function lstatIfExists(targetPath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertExistingDirectoryChain(
  allowedRoot: string,
  targetPath: string,
  label: string,
): Promise<void> {
  const root = path.resolve(allowedRoot);
  const target = path.resolve(targetPath);
  let current = root;
  for (const segment of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stats = await lstatIfExists(current);
    if (!stats) continue;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} ancestor must be a real directory: ${current}`);
    }
  }
}

export async function assertSafeFileMutationPath(options: {
  filePath: string;
  allowedRoot: string;
  label: string;
  createParent?: boolean;
}): Promise<void> {
  const { root, candidate } = assertDescendant(options.allowedRoot, options.filePath, options.label);
  await assertExistingDirectoryChain(root, path.dirname(candidate), options.label);
  if (options.createParent) {
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await assertExistingDirectoryChain(root, path.dirname(candidate), options.label);
  }
  const target = await lstatIfExists(candidate);
  if (target?.isSymbolicLink()) {
    throw new Error(`${options.label} path cannot contain a symbolic link: ${candidate}`);
  }
  if (target && !target.isFile()) {
    throw new Error(`${options.label} target must be a regular file: ${candidate}`);
  }
}

export async function assertRealFileParentWithinRoot(options: {
  filePath: string;
  allowedRoot: string;
  label: string;
}): Promise<void> {
  const { root, candidate } = assertDescendant(options.allowedRoot, options.filePath, options.label);
  const rootRealPath = await fs.realpath(root);
  const parentRealPath = await fs.realpath(path.dirname(candidate));
  const relative = path.relative(rootRealPath, parentRealPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${options.label} parent realpath escapes its allowed root.`);
  }
}

export async function atomicReplaceSafeFile(options: {
  filePath: string;
  allowedRoot: string;
  content: string;
  mode?: number;
  label: string;
  temporaryTag?: string;
  beforeRename?: (targetPath: string, temporaryPath: string) => Promise<void> | void;
  afterRename?: (targetPath: string) => Promise<void> | void;
}): Promise<void> {
  await assertSafeFileMutationPath({
    filePath: options.filePath,
    allowedRoot: options.allowedRoot,
    label: options.label,
    createParent: true,
  });
  const target = await lstatIfExists(options.filePath);
  const temporaryPath = path.join(
    path.dirname(path.resolve(options.filePath)),
    `.${path.basename(options.filePath)}.${options.temporaryTag ?? 'tmp'}-${process.pid}-${crypto.randomUUID()}`,
  );
  assertDescendant(options.allowedRoot, temporaryPath, options.label);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      temporaryPath,
      'wx',
      options.mode ?? (target ? Number(target.mode) & 0o777 : 0o600),
    );
    await handle.writeFile(options.content, 'utf8');
    await handle.close();
    handle = undefined;
    await options.beforeRename?.(options.filePath, temporaryPath);
    await assertSafeFileMutationPath({
      filePath: options.filePath,
      allowedRoot: options.allowedRoot,
      label: options.label,
    });
    await fs.rename(temporaryPath, options.filePath);
    await options.afterRename?.(options.filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    try {
      await assertSafeFileMutationPath({
        filePath: temporaryPath,
        allowedRoot: options.allowedRoot,
        label: options.label,
      });
      await assertRealFileParentWithinRoot({
        filePath: temporaryPath,
        allowedRoot: options.allowedRoot,
        label: options.label,
      });
      await fs.rm(temporaryPath, { force: true });
    } catch {
      // A failed revalidation leaves a weak temporary file instead of following a replaced path.
    }
  }
}
