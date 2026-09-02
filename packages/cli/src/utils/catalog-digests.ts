import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { CatalogManifestEntry, PluginManifestSource } from '../types.js';
import {
  normalizeManifestDigestInput,
  readPluginManifest,
} from './manifest.js';
import { calculateFileDigest } from './bundle-integrity.js';
import { CODEX_NATIVE_RENDER_RECEIPT_PATH } from './codex-native-render-receipt.js';

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

async function calculateCodexPayloadDigest(
  pluginRoot: string,
  canonicalizeSkills: boolean,
): Promise<string> {
  const files = (await listFilesRecursively(pluginRoot)).filter((relativePath) =>
    relativePath !== CODEX_NATIVE_RENDER_RECEIPT_PATH
    && path.posix.basename(relativePath) !== '.agent-workflows-owner.json');
  const fileEntries = await Promise.all(
    files.map(async (relativePath): Promise<CatalogDigestPathRecord> => {
      const filePath = path.join(pluginRoot, relativePath);
      const node = await resolveCatalogDigestNode(filePath);
      let digest: string;
      if (relativePath === '.codex-plugin/plugin.json' && node.kind === 'file') {
        const manifest = await fs.readJson(filePath) as Record<string, unknown>;
        digest = createSha256Digest(stableStringify({
          ...manifest,
          version: '<plugin-version>',
          ...(canonicalizeSkills ? { skills: '<native-managed>' } : {}),
        }));
      } else {
        digest = await calculateContentPathDigest(pluginRoot, relativePath, node);
      }
      return { path: relativePath, kind: node.kind, mode: node.mode, digest };
    }),
  );
  return createSha256Digest(stableStringify(fileEntries));
}

/**
 * Static shared-native digest. Codex can rewrite the manifest Skill projection,
 * so both plugin version and skills remain canonicalized for compatibility.
 */
export function calculateCodexSharedNativePayloadDigest(pluginRoot: string): Promise<string> {
  return calculateCodexPayloadDigest(pluginRoot, true);
}

/**
 * Receipt-backed dynamic projection digest. The version is transport metadata,
 * but the renderer-produced Skill projection is part of the payload identity.
 */
export function calculateCodexNativeRenderPayloadDigest(pluginRoot: string): Promise<string> {
  return calculateCodexPayloadDigest(pluginRoot, false);
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
