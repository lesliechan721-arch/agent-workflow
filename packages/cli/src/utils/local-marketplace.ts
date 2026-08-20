import path from 'node:path';
import type { Dirent } from 'node:fs';

import fs from 'fs-extra';

import { SKILL_OWNER_MARKER, readSkillOwnerMarker } from './ownership.js';
import { readJsonFile } from './json.js';
import { assertStrictSemVer } from './manifest.js';
import { resolveCliPackageRoot } from './paths.js';
import { sanitizeCatalogSourceErrorMessage } from './catalog-public-error.js';

const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getLocalMarketplacePluginRoot(rootDir: string, pluginName: string): string {
  return path.join(rootDir, 'plugins', pluginName);
}

export function getLocalMarketplaceCodexSkillsRoot(rootDir: string, pluginName: string): string {
  return path.join(getLocalMarketplacePluginRoot(rootDir, pluginName), 'codex', 'skills');
}

export function getLocalMarketplaceCodexSkillRoot(
  rootDir: string,
  pluginName: string,
  skillKey: string,
): string {
  return path.join(getLocalMarketplaceCodexSkillsRoot(rootDir, pluginName), skillKey);
}

export async function readCliPackageInfo(): Promise<{ name: string; version: string }> {
  const packageJson = await readJsonFile<{ name: string; version: string }>(
    path.join(resolveCliPackageRoot(), 'package.json'),
  );
  return {
    name: packageJson.name,
    version: assertStrictSemVer(packageJson.version, 'packages/cli/package.json version'),
  };
}

export interface NamespacedMarketplaceRootConfig {
  schemaVersion: 2;
  sourceId: string;
  sourceIdentity: string;
  marketplaceName: string;
}

export interface StrictNamespacedMarketplaceRoot {
  rootDir: string;
  config: NamespacedMarketplaceRootConfig;
  agentsManifest: Record<string, unknown>;
  claudeManifest: Record<string, unknown> | null;
}

export class MarketplaceRootValidationError extends Error {
  readonly code = 'marketplaceRootInvalid';

  constructor(readonly location: string, message: string, cause?: unknown) {
    super(`marketplaceRootInvalid: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'MarketplaceRootValidationError';
  }
}

function assertMarketplacePathBoundary(trustedRoot: string, candidatePath: string): {
  root: string;
  candidate: string;
} {
  const root = path.resolve(trustedRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MarketplaceRootValidationError(
      candidate,
      'marketplace path escapes its trusted root.',
    );
  }
  return { root, candidate };
}

async function lstatMarketplacePath(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectMarketplacePath(
  trustedRoot: string,
  candidatePath: string,
  finalKind: 'directory' | 'file',
): Promise<fs.Stats | null> {
  const { root, candidate } = assertMarketplacePathBoundary(trustedRoot, candidatePath);
  const paths = [root];
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  let candidateStats: fs.Stats | null = null;
  for (const currentPath of paths) {
    let stats: fs.Stats | null;
    try {
      stats = await lstatMarketplacePath(currentPath);
    } catch (error) {
      throw new MarketplaceRootValidationError(
        currentPath,
        'marketplace path cannot be inspected.',
        error,
      );
    }
    if (!stats) return null;
    const isFinal = currentPath === candidate;
    const valid = isFinal && finalKind === 'file'
      ? stats.isFile() && !stats.isSymbolicLink()
      : stats.isDirectory() && !stats.isSymbolicLink();
    if (!valid) {
      throw new MarketplaceRootValidationError(
        currentPath,
        isFinal && finalKind === 'file'
          ? 'marketplace JSON target must be a regular file.'
          : 'marketplace path must be a regular directory.',
      );
    }
    if (isFinal) candidateStats = stats;
  }
  return candidateStats;
}

async function readStrictOptionalJsonObject(
  trustedRoot: string,
  filePath: string,
): Promise<Record<string, unknown> | null> {
  if (!await inspectMarketplacePath(trustedRoot, filePath, 'file')) return null;
  try {
    const value = await fs.readJson(filePath) as unknown;
    if (!isRecord(value)) {
      throw new MarketplaceRootValidationError(filePath, 'marketplace JSON must contain an object.');
    }
    return value;
  } catch (error) {
    if (error instanceof MarketplaceRootValidationError) throw error;
    throw new MarketplaceRootValidationError(filePath, 'marketplace JSON cannot be read.', error);
  }
}

async function readOptionalJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const value = await fs.readJson(filePath) as unknown;
    if (!isRecord(value)) throw new Error(`Expected a JSON object at ${filePath}.`);
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function readStrictNamespacedMarketplaceRoot(options: {
  trustedMarketplaceRoot?: string;
  rootDir: string;
  sourceId?: string;
  sourceIdentity?: string;
  marketplaceName?: string;
}): Promise<StrictNamespacedMarketplaceRoot | null> {
  const trustedMarketplaceRoot = options.trustedMarketplaceRoot ?? path.dirname(options.rootDir);
  if (!await inspectMarketplacePath(trustedMarketplaceRoot, options.rootDir, 'directory')) return null;
  const configPath = path.join(options.rootDir, 'config.json');
  const config = await readStrictOptionalJsonObject(trustedMarketplaceRoot, configPath);
  if (
    !isRecord(config)
    || config.schemaVersion !== 2
    || typeof config.sourceId !== 'string'
    || config.sourceId.length === 0
    || typeof config.sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(config.sourceIdentity)
    || typeof config.marketplaceName !== 'string'
    || config.marketplaceName.length === 0
    || config.sourceId !== path.basename(options.rootDir)
  ) {
    throw new MarketplaceRootValidationError(
      configPath,
      'marketplace config must contain a canonical schema 2 identity.',
    );
  }
  if (
    (options.sourceId !== undefined && config.sourceId !== options.sourceId)
    || (options.sourceIdentity !== undefined && config.sourceIdentity !== options.sourceIdentity)
    || (options.marketplaceName !== undefined && config.marketplaceName !== options.marketplaceName)
  ) {
    throw new Error(
      `sourceChanged: marketplace root for ${options.sourceId ?? config.sourceId} does not match its schema 2 source identity.`,
    );
  }
  const agentsManifest = await readStrictOptionalJsonObject(
    trustedMarketplaceRoot,
    path.join(options.rootDir, '.agents', 'plugins', 'marketplace.json'),
  );
  if (!agentsManifest || agentsManifest.name !== config.marketplaceName) {
    throw new MarketplaceRootValidationError(
      path.join(options.rootDir, '.agents', 'plugins', 'marketplace.json'),
      'Codex marketplace manifest name does not match config.',
    );
  }
  const claudeManifest = await readStrictOptionalJsonObject(
    trustedMarketplaceRoot,
    path.join(options.rootDir, '.claude-plugin', 'marketplace.json'),
  );
  if (claudeManifest && claudeManifest.name !== config.marketplaceName) {
    throw new MarketplaceRootValidationError(
      path.join(options.rootDir, '.claude-plugin', 'marketplace.json'),
      'Claude marketplace manifest name does not match config.',
    );
  }
  return {
    rootDir: options.rootDir,
    config: config as unknown as NamespacedMarketplaceRootConfig,
    agentsManifest,
    claudeManifest,
  };
}

function normalizePluginRelativeDirectory(value: unknown, fallback: string): string | null {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

async function assertTreeHasNoSymlinks(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Codex Skill overlay cannot contain a symlink: ${entry.name}`);
    if (entry.isDirectory()) await assertTreeHasNoSymlinks(path.join(root, entry.name));
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function readOverlayDirectory(
  directoryPath: string,
  redactedRoots: string[],
): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new Error(`marketplaceOverlayReadFailed: ${sanitizeCatalogSourceErrorMessage(
      error instanceof Error ? error.message : String(error),
      process.env,
      redactedRoots,
    )}`);
  }
}

export async function replayNamespacedCodexSkillOverlays(options: {
  sourceRoot: string;
  stagingRoot: string;
  sourceId: string;
  sourceIdentity: string;
  marketplaceName: string;
}): Promise<void> {
  let existing: StrictNamespacedMarketplaceRoot | null;
  try {
    existing = await readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.dirname(options.sourceRoot),
      rootDir: options.sourceRoot,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      marketplaceName: options.marketplaceName,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('sourceChanged:')) throw error;
    throw new Error(`marketplaceOverlayReadFailed: ${sanitizeCatalogSourceErrorMessage(
      error instanceof Error ? error.message : String(error),
      process.env,
      [options.sourceRoot, options.stagingRoot],
    )}`);
  }
  if (!existing) return;

  const pluginsRoot = path.join(options.sourceRoot, 'plugins');
  const redactedRoots = [options.sourceRoot, options.stagingRoot];
  for (const pluginEntry of await readOverlayDirectory(pluginsRoot, redactedRoots)) {
    if (pluginEntry.isSymbolicLink()) {
      throw new Error(`Codex Skill overlay plugin root cannot be a symlink: ${pluginEntry.name}`);
    }
    if (!pluginEntry.isDirectory()) continue;
    const pluginName = pluginEntry.name;
    const sourcePluginRoot = path.join(pluginsRoot, pluginName);
    const sourcePlatformManifest = await readOptionalJsonObject(
      path.join(sourcePluginRoot, '.codex-plugin', 'plugin.json'),
    );
    const sourceSkillsRelative = normalizePluginRelativeDirectory(
      sourcePlatformManifest?.skills,
      'codex/skills',
    );
    if (!sourceSkillsRelative) continue;
    const sourceSkillsRoot = path.join(sourcePluginRoot, ...sourceSkillsRelative.split('/'));
    const overlays: Array<{ key: string; root: string }> = [];
    for (const entry of await readOverlayDirectory(sourceSkillsRoot, redactedRoots)) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex Skill overlay cannot be a symlink: ${path.join(sourceSkillsRoot, entry.name)}`);
      }
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(sourceSkillsRoot, entry.name);
      if (!await pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))) continue;
      await readSkillOwnerMarker({
        skillRoot,
        allowedRoot: sourceSkillsRoot,
        expectedIdentity: {
          owner: 'agent-workflows',
          sourceId: options.sourceId,
          sourceIdentity: options.sourceIdentity,
          pluginId: `${options.sourceId}/${pluginName}`,
          plugin: pluginName,
          artifactKey: entry.name,
          platform: 'codex',
          scope: 'user',
        },
      });
      overlays.push({ key: entry.name, root: skillRoot });
    }
    if (overlays.length === 0) continue;

    const stagingPluginRoot = path.join(options.stagingRoot, 'plugins', pluginName);
    if (!await pathExists(stagingPluginRoot)) {
      await assertTreeHasNoSymlinks(sourcePluginRoot);
      await fs.copy(sourcePluginRoot, stagingPluginRoot, {
        overwrite: false, errorOnExist: true, dereference: false,
      });
      continue;
    }
    const stagingManifest = await readOptionalJsonObject(
      path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json'),
    );
    const targets = (stagingManifest?.artifacts as { targets?: unknown[] } | undefined)?.targets ?? [];
    const dynamicKeys = new Set(targets.flatMap((target) => {
      if (!isRecord(target)) return [];
      return target.platform === 'codex'
        && target.target === 'codex.skill'
        && Array.isArray(target.scopes)
        && target.scopes.includes('user')
        && typeof target.skillKey === 'string'
        ? [target.skillKey]
        : [];
    }));
    const stagingPlatformManifest = await readOptionalJsonObject(
      path.join(stagingPluginRoot, '.codex-plugin', 'plugin.json'),
    );
    const stagingSkillsRelative = normalizePluginRelativeDirectory(
      stagingPlatformManifest?.skills,
      'codex/skills',
    );
    if (!stagingSkillsRelative) continue;
    const stagingSkillsRoot = path.join(stagingPluginRoot, ...stagingSkillsRelative.split('/'));
    for (const overlay of overlays) {
      const destination = path.join(stagingSkillsRoot, overlay.key);
      if (dynamicKeys.has(overlay.key) || !await pathExists(destination)) {
        await assertTreeHasNoSymlinks(overlay.root);
        await fs.copy(overlay.root, destination, {
          overwrite: true, errorOnExist: false, dereference: false,
        });
      } else {
        await fs.copyFile(
          path.join(overlay.root, SKILL_OWNER_MARKER),
          path.join(destination, SKILL_OWNER_MARKER),
        );
      }
    }
  }
}
