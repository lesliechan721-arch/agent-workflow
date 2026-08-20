import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import fs from 'fs-extra';

import { CURRENT_CATALOG_MANIFEST_FILE } from '../constants.js';
import type { CatalogManifestV3 } from '../types.js';
import { calculateFileDigest } from './bundle-integrity.js';
import {
  createCatalogManifestV3Entry,
  validateCatalogManifestV3,
} from './catalog-manifest-v3.js';
import { readPluginManifest } from './manifest.js';

const REQUIRED_ROOT_ENTRIES = new Set([
  CURRENT_CATALOG_MANIFEST_FILE,
  '.agents',
  '.claude-plugin',
  'plugins',
]);
const OPTIONAL_ROOT_ENTRY = 'plugin-release-ledger.json';

export interface CatalogSnapshotValidation {
  rootDir: string;
  manifest: CatalogManifestV3;
  manifestDigest: string;
  snapshotDigest: string;
}

function createDigest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isAbsentSnapshotRoot(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isOperationalSnapshotError(error: unknown): boolean {
  return new Set(['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EPERM']).has(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

async function lstatSnapshotRoot(rootDir: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(rootDir);
  } catch (error) {
    if (isAbsentSnapshotRoot(error)) return null;
    throw error;
  }
}

async function realpathSnapshotRoot(rootDir: string): Promise<string | null> {
  try {
    return await fs.realpath(rootDir);
  } catch (error) {
    if (isAbsentSnapshotRoot(error)) return null;
    throw error;
  }
}

async function assertSafeSymlink(rootDir: string, linkPath: string): Promise<void> {
  const target = await fs.readlink(linkPath);
  if (path.isAbsolute(target)) {
    throw new Error(`Unsafe catalog snapshot symlink "${path.relative(rootDir, linkPath)}": absolute targets are not allowed.`);
  }
  const unresolvedTarget = path.resolve(path.dirname(linkPath), target);
  if (!isInside(rootDir, unresolvedTarget)) {
    throw new Error(`Unsafe catalog snapshot symlink "${path.relative(rootDir, linkPath)}": target escapes the snapshot.`);
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = await fs.realpath(linkPath);
  } catch (error) {
    if (isOperationalSnapshotError(error)) throw error;
    throw new Error(
      `Unsafe catalog snapshot symlink "${path.relative(rootDir, linkPath)}": target is missing or cyclic.`,
      { cause: error },
    );
  }
  if (!isInside(rootDir, resolvedTarget)) {
    throw new Error(`Unsafe catalog snapshot symlink "${path.relative(rootDir, linkPath)}": target escapes the snapshot.`);
  }
}

interface SnapshotDigestEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  mode: '040000' | '100644' | '100755' | '120000';
  digest?: string;
  target?: string;
}

async function collectSnapshotEntries(
  rootDir: string,
  currentDir: string,
): Promise<SnapshotDigestEntry[]> {
  const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
  const result: SnapshotDigestEntry[] = [];
  for (const entry of dirEntries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (currentDir === rootDir && entry.name === OPTIONAL_ROOT_ENTRY) continue;
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      await assertSafeSymlink(rootDir, absolutePath);
      result.push({
        path: relativePath,
        type: 'symlink',
        mode: '120000',
        target: await fs.readlink(absolutePath),
      });
      continue;
    }
    if (stat.isDirectory()) {
      const children = await collectSnapshotEntries(rootDir, absolutePath);
      if (children.length === 0) {
        throw new Error(
          `Invalid catalog snapshot empty directory "${relativePath}": Git cannot represent empty directories.`,
        );
      }
      result.push({ path: relativePath, type: 'directory', mode: '040000' });
      result.push(...children);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Invalid catalog snapshot entry "${relativePath}": expected a file, directory, or symlink.`);
    }
    result.push({
      path: relativePath,
      type: 'file',
      mode: (stat.mode & 0o100) === 0 ? '100644' : '100755',
      digest: await calculateFileDigest(absolutePath),
    });
  }
  return result;
}

async function validateRootLayout(rootDir: string): Promise<void> {
  const rootStat = await lstatSnapshotRoot(rootDir);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Invalid catalog snapshot root: expected a regular directory.');
  }
  const entries = await fs.readdir(rootDir);
  const unexpected = entries.filter((entry) =>
    !REQUIRED_ROOT_ENTRIES.has(entry) && entry !== OPTIONAL_ROOT_ENTRY);
  const missing = [...REQUIRED_ROOT_ENTRIES].filter((entry) => !entries.includes(entry));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Invalid catalog snapshot root layout: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}].`,
    );
  }
  for (const directory of ['.agents', '.claude-plugin', 'plugins']) {
    const stat = await fs.lstat(path.join(rootDir, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Invalid catalog snapshot root layout: "${directory}" must be a regular directory.`);
    }
  }
  for (const fileName of [CURRENT_CATALOG_MANIFEST_FILE, ...(entries.includes(OPTIONAL_ROOT_ENTRY)
    ? [OPTIONAL_ROOT_ENTRY]
    : [])]) {
    const stat = await fs.lstat(path.join(rootDir, fileName));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Invalid catalog snapshot root layout: "${fileName}" must be a regular file.`);
    }
  }
}

export async function validateCatalogSnapshot(rootDir: string): Promise<CatalogSnapshotValidation> {
  const requestedRoot = path.resolve(rootDir);
  const requestedStat = await lstatSnapshotRoot(requestedRoot);
  if (!requestedStat?.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error('Invalid catalog snapshot root: expected a regular directory.');
  }
  const resolvedRoot = await realpathSnapshotRoot(requestedRoot);
  if (resolvedRoot === null) {
    throw new Error('Invalid catalog snapshot root: expected a regular directory.');
  }
  await validateRootLayout(resolvedRoot);
  const snapshotEntries = await collectSnapshotEntries(resolvedRoot, resolvedRoot);
  const manifestPath = path.join(resolvedRoot, CURRENT_CATALOG_MANIFEST_FILE);
  const manifest = validateCatalogManifestV3(await fs.readJson(manifestPath));
  const pluginEntries = await fs.readdir(path.join(resolvedRoot, 'plugins'));
  const manifestPluginNames = [...manifest.entries.map((entry) => entry.name)].sort();
  if (pluginEntries.sort().join('\0') !== manifestPluginNames.join('\0')) {
    throw new Error('Invalid catalog snapshot plugin inventory: plugins/ must exactly match manifest entries.');
  }

  for (const entry of manifest.entries) {
    const pluginRoot = path.join(resolvedRoot, 'plugins', entry.name);
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const expected = await createCatalogManifestV3Entry(plugin, pluginRoot);
    for (const field of [
      'name',
      'version',
      'description',
      'interface',
      'category',
      'tags',
      'strict',
      'policy',
      'compatibility',
      'source',
      'artifactDigest',
      'manifestDigest',
      'contentDigest',
    ] as const) {
      if (!isDeepStrictEqual(entry[field], expected[field])) {
        throw new Error(
          `Catalog entry ${field} for "${entry.name}" does not match its plugin manifest projection.`,
        );
      }
    }
  }

  return {
    rootDir: resolvedRoot,
    manifest,
    manifestDigest: await calculateFileDigest(manifestPath),
    snapshotDigest: createDigest(JSON.stringify(snapshotEntries)),
  };
}
