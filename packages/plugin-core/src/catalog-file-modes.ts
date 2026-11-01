import path from 'node:path';

import fs from 'fs-extra';

export const CATALOG_EXECUTABLE_FILES_PATH = '.agents-plugin/aw-executable-files.json';

export async function listCatalogBundleFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await listCatalogBundleFiles(root, child));
    else result.push(child);
  }
  return result.sort();
}

export async function writeCatalogExecutableFiles(pluginRoot: string): Promise<void> {
  const metadataPath = path.join(pluginRoot, CATALOG_EXECUTABLE_FILES_PATH);
  const existing = await fs.lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && !existing.isFile()) {
    throw new Error('Catalog executable file metadata must be a regular file.');
  }
  const executableFiles: string[] = [];
  for (const relative of await listCatalogBundleFiles(pluginRoot)) {
    if (relative === CATALOG_EXECUTABLE_FILES_PATH) continue;
    const stat = await fs.lstat(path.join(pluginRoot, relative));
    if (stat.isFile() && (stat.mode & 0o100) !== 0) executableFiles.push(relative);
  }
  if (executableFiles.length === 0) {
    if (existing) await fs.unlink(metadataPath);
    return;
  }
  await fs.outputFile(metadataPath, `${JSON.stringify(executableFiles, null, 2)}\n`);
  await fs.chmod(metadataPath, 0o644);
}

export async function readCatalogExecutableFiles(
  pluginRoot: string,
  files: readonly string[],
): Promise<ReadonlySet<string> | undefined> {
  if (!files.includes(CATALOG_EXECUTABLE_FILES_PATH)) return undefined;
  const metadataPath = path.join(pluginRoot, CATALOG_EXECUTABLE_FILES_PATH);
  if (!(await fs.lstat(metadataPath)).isFile()) {
    throw new Error('Catalog executable file metadata must be a regular file.');
  }
  const input: unknown = await fs.readJson(metadataPath);
  const inventory = new Set(files);
  if (!Array.isArray(input) || input.some((relative: unknown, index: number) =>
    typeof relative !== 'string'
    || /[\\:\u0000-\u001f]/u.test(relative)
    || relative === CATALOG_EXECUTABLE_FILES_PATH
    || !inventory.has(relative)
    || (index > 0 && input[index - 1] >= relative))) {
    throw new Error('Invalid Catalog executable file metadata.');
  }
  return new Set(input as string[]);
}

export function catalogFileMode(
  relativePath: string,
  mode: number,
  executableFiles?: ReadonlySet<string>,
): '100644' | '100755' {
  // Windows does not retain Unix execute bits. The inventory is itself bound
  // by the Catalog digests; Unix still verifies the actual file permissions.
  const executable = process.platform === 'win32' && executableFiles !== undefined
    ? executableFiles.has(relativePath)
    : (mode & 0o100) !== 0;
  return executable ? '100755' : '100644';
}
