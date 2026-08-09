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
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
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

async function calculateArtifactPathDigest(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    return createSha256Digest(`symlink:${await fs.readlink(filePath)}`);
  }

  return calculateFileDigest(filePath);
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
    files.map(async (relativePath) => ({
      path: relativePath,
      digest: await calculateArtifactPathDigest(path.join(pluginRoot, relativePath)),
    })),
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
