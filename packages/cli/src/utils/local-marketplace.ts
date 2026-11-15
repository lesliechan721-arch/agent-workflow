import path from 'node:path';

import fs from 'fs-extra';

import type { MarketplaceManifest, PlatformName } from '../types.js';
import { readJsonFile } from './json.js';
import { assertStrictSemVer } from './manifest.js';
import { resolveCliPackageRoot } from './paths.js';
import { canonicalizePathThroughExistingAncestor } from './state-paths.js';
import { normalizeMarketplaceProductToken } from './platform-support.js';

const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function getNamespacedMarketplaceName(sourceId: string): string {
  return `aw-${sourceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectMarketplaceManifestForPlatform(
  manifest: MarketplaceManifest,
  platform: PlatformName,
): MarketplaceManifest {
  const product = platform === 'codex' ? 'CODEX' : 'CLAUDE';
  return {
    ...manifest,
    plugins: manifest.plugins.flatMap((plugin) => {
      const products = plugin.policy.products;
      const supported = products === undefined
        || products.length === 0
        || products.some((entry) => normalizeMarketplaceProductToken(entry) === product);
      return supported ? [{
        ...plugin,
        policy: { ...plugin.policy, products: [product] },
      }] : [];
    }),
  };
}

export function getLocalMarketplacePluginRoot(rootDir: string, pluginName: string): string {
  return path.join(rootDir, 'plugins', pluginName);
}

export async function assertSafeNamespacedMarketplacePluginRoot(
  rootDir: string,
  pluginName: string,
): Promise<string> {
  const pluginsRoot = path.join(rootDir, 'plugins');
  const pluginRoot = getLocalMarketplacePluginRoot(rootDir, pluginName);
  const pluginsStats = await lstatMarketplacePath(pluginsRoot);
  if (pluginsStats && (!pluginsStats.isDirectory() || pluginsStats.isSymbolicLink())) {
    throw new MarketplaceRootValidationError(
      pluginsRoot, 'marketplace plugins ancestor must be a regular directory.', 'unsafe',
    );
  }
  const pluginStats = pluginsStats ? await lstatMarketplacePath(pluginRoot) : null;
  if (pluginStats && (!pluginStats.isDirectory() || pluginStats.isSymbolicLink())) {
    throw new MarketplaceRootValidationError(
      pluginRoot, 'marketplace plugin projection must be a regular directory.', 'unsafe',
    );
  }
  const physicalRoot = await fs.realpath(rootDir);
  for (const candidate of [pluginsStats ? pluginsRoot : null, pluginStats ? pluginRoot : null]) {
    if (!candidate) continue;
    const relative = path.relative(physicalRoot, await fs.realpath(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new MarketplaceRootValidationError(
        candidate, 'marketplace plugin path escapes its physical root.', 'unsafe',
      );
    }
  }
  return pluginRoot;
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
  logicalIdentity?: string;
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

  constructor(
    readonly location: string,
    message: string,
    readonly reason: 'invalid' | 'unsafe' | 'unreadable',
    cause?: unknown,
  ) {
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
      'unsafe',
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
  let rootStats: fs.Stats | null;
  let candidateStats: fs.Stats | null;
  try {
    [rootStats, candidateStats] = await Promise.all([
      lstatMarketplacePath(root),
      lstatMarketplacePath(candidate),
    ]);
  } catch (error) {
    throw new MarketplaceRootValidationError(
      candidate, 'marketplace path cannot be inspected.', 'unreadable', error,
    );
  }
  if (!rootStats) return null;
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new MarketplaceRootValidationError(
      root, 'marketplace root must be a regular directory.', 'unsafe',
    );
  }
  let physicalRoot: string;
  let physicalCandidate: string;
  try {
    [physicalRoot, physicalCandidate] = await Promise.all([
      canonicalizePathThroughExistingAncestor(root),
      canonicalizePathThroughExistingAncestor(candidate),
    ]);
  } catch (error) {
    throw new MarketplaceRootValidationError(
      candidate, 'marketplace path cannot be resolved.', 'unreadable', error,
    );
  }
  try {
    assertMarketplacePathBoundary(physicalRoot, physicalCandidate);
  } catch {
    throw new MarketplaceRootValidationError(
      candidate, 'marketplace physical path escapes its trusted root.', 'unsafe',
    );
  }
  if (!candidateStats) return null;
  const valid = finalKind === 'file'
    ? candidateStats.isFile() && !candidateStats.isSymbolicLink()
    : candidateStats.isDirectory() && !candidateStats.isSymbolicLink();
  if (!valid) {
    throw new MarketplaceRootValidationError(
      candidate,
      finalKind === 'file'
        ? 'marketplace JSON target must be a regular file.'
        : 'marketplace path must be a regular directory.',
      'unsafe',
    );
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
      throw new MarketplaceRootValidationError(
        filePath, 'marketplace JSON must contain an object.', 'invalid',
      );
    }
    return value;
  } catch (error) {
    if (error instanceof MarketplaceRootValidationError) throw error;
    throw new MarketplaceRootValidationError(
      filePath,
      'marketplace JSON cannot be read.',
      error instanceof SyntaxError ? 'invalid' : 'unreadable',
      error,
    );
  }
}

interface NamespacedMarketplaceReadOptions {
  trustedMarketplaceRoot?: string;
  rootDir: string;
  sourceId?: string;
  sourceIdentity?: string;
  marketplaceName?: string;
}
export interface StrictPlatformMarketplaceRoot {
  rootDir: string;
  config: NamespacedMarketplaceRootConfig;
  platform: 'codex' | 'claude' | 'copilot';
  manifest: Record<string, unknown>;
}
export function readStrictNamespacedMarketplaceRoot(options: NamespacedMarketplaceReadOptions & {
  platform: StrictPlatformMarketplaceRoot['platform'];
}): Promise<StrictPlatformMarketplaceRoot | null>;
export function readStrictNamespacedMarketplaceRoot(options: NamespacedMarketplaceReadOptions): Promise<StrictNamespacedMarketplaceRoot | null>;
export async function readStrictNamespacedMarketplaceRoot(options: NamespacedMarketplaceReadOptions & {
  platform?: StrictPlatformMarketplaceRoot['platform'];
}): Promise<StrictNamespacedMarketplaceRoot | StrictPlatformMarketplaceRoot | null> {
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
    || (config.logicalIdentity !== undefined
      && (typeof config.logicalIdentity !== 'string' || config.logicalIdentity.trim() === ''))
    || typeof config.marketplaceName !== 'string'
    || config.marketplaceName.length === 0
    || config.sourceId !== path.basename(options.rootDir)
  ) {
    throw new MarketplaceRootValidationError(
      configPath,
      'marketplace config must contain a canonical schema 2 identity.',
      'invalid',
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
  if (options.platform) {
    const relative = options.platform === 'codex' ? ['.agents', 'plugins', 'marketplace.json']
      : options.platform === 'claude' ? ['.claude-plugin', 'marketplace.json'] : ['.github', 'plugin', 'marketplace.json'];
    const manifestPath = path.join(options.rootDir, ...relative);
    const manifest = await readStrictOptionalJsonObject(trustedMarketplaceRoot, manifestPath);
    if (!manifest || manifest.name !== config.marketplaceName || !Array.isArray(manifest.plugins)) {
      throw new MarketplaceRootValidationError(manifestPath, 'The platform marketplace manifest does not match its source identity.', 'invalid');
    }
    return { rootDir: options.rootDir, config: config as unknown as NamespacedMarketplaceRootConfig,
      platform: options.platform, manifest };
  }
  const agentsManifest = await readStrictOptionalJsonObject(
    trustedMarketplaceRoot,
    path.join(options.rootDir, '.agents', 'plugins', 'marketplace.json'),
  );
  if (!agentsManifest || agentsManifest.name !== config.marketplaceName) {
    throw new MarketplaceRootValidationError(
      path.join(options.rootDir, '.agents', 'plugins', 'marketplace.json'),
      'Codex marketplace manifest name does not match config.',
      'invalid',
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
      'invalid',
    );
  }
  return {
    rootDir: options.rootDir,
    config: config as unknown as NamespacedMarketplaceRootConfig,
    agentsManifest,
    claudeManifest,
  };
}
