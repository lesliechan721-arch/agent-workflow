import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { CatalogManifestEntry, PluginManifestSource } from '../types.js';
import {
  normalizeManifestDigestInput,
  readPluginManifest,
} from './manifest.js';
import { calculateFileDigest } from './bundle-integrity.js';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function createSha256Digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }
    files.push(entry.name);
  }

  return files.sort();
}

interface CatalogDigestPathRecord {
  path: string;
  kind: 'file' | 'symlink';
  mode: '100644' | '100755' | '120000';
  digest: string;
}

async function resolveCatalogDigestNode(filePath: string): Promise<{
  kind: CatalogDigestPathRecord['kind'];
  mode: CatalogDigestPathRecord['mode'];
}> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', mode: '120000' };
  }
  if (!stat.isFile()) {
    throw new Error(`Catalog digest path must be a regular file or symlink: ${filePath}.`);
  }
  return {
    kind: 'file',
    mode: (stat.mode & 0o100) === 0 ? '100644' : '100755',
  };
}

async function calculateArtifactPathDigest(
  filePath: string,
  node: Awaited<ReturnType<typeof resolveCatalogDigestNode>>,
): Promise<string> {
  if (node.kind === 'symlink') {
    return createSha256Digest(await fs.readlink(filePath));
  }
  return calculateFileDigest(filePath);
}

const VERSIONED_PLUGIN_MANIFEST_PATHS = new Set([
  '.agents-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
]);

async function calculateContentPathDigest(
  pluginRoot: string,
  relativePath: string,
  node: Awaited<ReturnType<typeof resolveCatalogDigestNode>>,
): Promise<string> {
  if (!VERSIONED_PLUGIN_MANIFEST_PATHS.has(relativePath)) {
    return calculateArtifactPathDigest(path.join(pluginRoot, relativePath), node);
  }
  const filePath = path.join(pluginRoot, relativePath);
  if (node.kind === 'symlink') {
    return createSha256Digest(await fs.readlink(filePath));
  }
  const manifest = await fs.readJson(filePath) as Record<string, unknown>;
  return createSha256Digest(stableStringify({ ...manifest, version: '<plugin-version>' }));
}

export function calculateCatalogEntryManifestDigest(
  manifest: PluginManifestSource | CatalogManifestEntry,
): string {
  return createSha256Digest(normalizeManifestDigestInput(manifest));
}

export async function calculateCatalogEntryArtifactDigest(
  pluginRoot: string,
): Promise<string> {
  const files = await listFilesRecursively(pluginRoot);
  const fileEntries = await Promise.all(
    files.map(async (relativePath): Promise<CatalogDigestPathRecord> => {
      const filePath = path.join(pluginRoot, relativePath);
      const node = await resolveCatalogDigestNode(filePath);
      return {
        path: relativePath,
        kind: node.kind,
        mode: node.mode,
        digest: await calculateArtifactPathDigest(filePath, node),
      };
    }),
  );

  return createSha256Digest(stableStringify(fileEntries));
}

export async function calculateCatalogEntryContentDigest(
  pluginRoot: string,
): Promise<string> {
  const files = await listFilesRecursively(pluginRoot);
  const fileEntries = await Promise.all(
    files.map(async (relativePath): Promise<CatalogDigestPathRecord> => {
      const node = await resolveCatalogDigestNode(path.join(pluginRoot, relativePath));
      return {
        path: relativePath,
        kind: node.kind,
        mode: node.mode,
        digest: await calculateContentPathDigest(pluginRoot, relativePath, node),
      };
    }),
  );

  return createSha256Digest(stableStringify(fileEntries));
}

export async function calculateCatalogEntryDigestsFromRoot(
  pluginRoot: string,
): Promise<{ manifestDigest: string; artifactDigest: string }> {
  const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });

  return {
    manifestDigest: calculateCatalogEntryManifestDigest(plugin.manifest),
    artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
  };
}
