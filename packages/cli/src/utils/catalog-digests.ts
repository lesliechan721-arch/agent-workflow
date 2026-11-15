import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  catalogFileMode,
  listCatalogBundleFiles as listFilesRecursively,
  readCatalogExecutableFiles,
} from '@lesliechan721/aw-plugin-core';

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

interface CatalogDigestPathRecord {
  path: string;
  kind: 'file' | 'symlink';
  mode: '100644' | '100755' | '120000';
  digest: string;
}

async function resolveCatalogDigestNode(
  filePath: string,
  relativePath = '',
  executableFiles?: ReadonlySet<string>,
): Promise<{
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
    mode: catalogFileMode(relativePath, stat.mode, executableFiles),
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
const AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME = 'aw-plugin-requirements.json';

async function calculateContentPathDigest(
  pluginRoot: string,
  relativePath: string,
  node: Awaited<ReturnType<typeof resolveCatalogDigestNode>>,
): Promise<string> {
  if (!VERSIONED_PLUGIN_MANIFEST_PATHS.has(relativePath)
    && path.posix.basename(relativePath) !== AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME) {
    return calculateArtifactPathDigest(path.join(pluginRoot, relativePath), node);
  }
  const filePath = path.join(pluginRoot, relativePath);
  if (node.kind === 'symlink') {
    return createSha256Digest(await fs.readlink(filePath));
  }
  const manifest = await fs.readJson(filePath) as Record<string, unknown>;
  if (VERSIONED_PLUGIN_MANIFEST_PATHS.has(relativePath)) {
    return createSha256Digest(stableStringify({ ...manifest, version: '<plugin-version>' }));
  }
  const plugin = manifest.plugin && typeof manifest.plugin === 'object' && !Array.isArray(manifest.plugin)
    ? manifest.plugin as Record<string, unknown>
    : {};
  return createSha256Digest(stableStringify({
    ...manifest,
    plugin: { ...plugin, version: '<plugin-version>' },
  }));
}

export function calculateCatalogEntryManifestDigest(
  manifest: Parameters<typeof normalizeManifestDigestInput>[0],
): string {
  return createSha256Digest(normalizeManifestDigestInput(manifest));
}

export async function calculateCatalogEntryArtifactDigest(
  pluginRoot: string,
): Promise<string> {
  const files = await listFilesRecursively(pluginRoot);
  const executableFiles = await readCatalogExecutableFiles(pluginRoot, files);
  const fileEntries = await Promise.all(
    files.map(async (relativePath): Promise<CatalogDigestPathRecord> => {
      const filePath = path.join(pluginRoot, relativePath);
      const node = await resolveCatalogDigestNode(filePath, relativePath, executableFiles);
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
  const executableFiles = await readCatalogExecutableFiles(pluginRoot, files);
  const fileEntries = await Promise.all(
    files.map(async (relativePath): Promise<CatalogDigestPathRecord> => {
      const node = await resolveCatalogDigestNode(path.join(pluginRoot, relativePath), relativePath, executableFiles);
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
