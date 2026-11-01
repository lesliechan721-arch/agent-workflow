import path from 'node:path';
import type { Dirent } from 'node:fs';

import fs from 'fs-extra';
import { normalizeInstalledCommandProducer, validateCommandEntryFiles } from '@lesliechan721/aw-plugin-core/manifest';

import type { MarketplaceManifest, PlatformName } from '../types.js';
import { readSkillOwnerMarker } from './ownership.js';
import { readJsonFile } from './json.js';
import { assertStrictSemVer } from './manifest.js';
import { resolveCliPackageRoot } from './paths.js';
import { canonicalizePathThroughExistingAncestor } from './state-paths.js';
import { sanitizeCatalogSourceErrorMessage } from './catalog-public-error.js';
import { normalizeMarketplaceProductToken } from './platform-support.js';
import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  parseCodexNativeRenderReceipt,
  serializeCodexNativeRenderReceipt,
  type CodexNativeRenderReceipt,
} from './codex-native-render-receipt.js';
import { calculateCodexNativeRenderPayloadDigest } from './catalog-digests.js';
import { createCodexSkillStagingTreeContentDigest } from './codex-skill-staging.js';
import { readDynamicSkillTree } from './dynamic-skill-tree.js';

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

function normalizePluginRelativeDirectory(value: unknown, fallback: string): string | null {
  const raw = typeof value === 'string' ? value : fallback;
  const normalizedSeparators = raw.replace(/\\/gu, '/');
  const normalized = path.posix.normalize(normalizedSeparators.replace(/^\.\//, ''));
  if (!normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalizedSeparators)
    || path.win32.isAbsolute(raw)) {
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

class CodexNativeProjectionNotReusableError extends Error {}

function nativeCodexTargets(manifest: Record<string, unknown>): Array<{ id: string; skillKey: string }> {
  const targets = (manifest.artifacts as { targets?: unknown[] } | undefined)?.targets ?? [];
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target) => {
    if (!isRecord(target)
      || target.platform !== 'codex'
      || target.target !== 'codex.skill'
      || !isRecord(target.delivery)
      || target.delivery.mode !== 'codex-native'
      || typeof target.id !== 'string'
      || typeof target.skillKey !== 'string') return [];
    return [{ id: target.id, skillKey: target.skillKey }];
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

async function assertRegularProjectionTree(root: string, rejectOwnerMarker = false): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`codexNativeProjectionUnsafe: projection contains an unsafe node: ${entry.name}`);
    }
    if (rejectOwnerMarker && entry.name === '.agent-workflows-owner.json') {
      throw new Error('codexNativeProjectionUnsafe: native Skill cannot contain an AW owner marker.');
    }
    if (entry.isDirectory()) {
      await assertRegularProjectionTree(path.join(root, entry.name), rejectOwnerMarker);
    }
  }
}

async function readProjectionJson(
  trustedRoot: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const stats = await inspectMarketplacePath(trustedRoot, filePath, 'file');
  if (!stats) throw new CodexNativeProjectionNotReusableError();
  try {
    const value = await fs.readJson(filePath) as unknown;
    if (!isRecord(value)) throw new CodexNativeProjectionNotReusableError();
    return value;
  } catch (error) {
    if (error instanceof CodexNativeProjectionNotReusableError) throw error;
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new CodexNativeProjectionNotReusableError();
  }
}

async function readValidatedCodexProjection(options: {
  sourceRoot: string; pluginName: string; sourceId: string; sourceIdentity: string;
}): Promise<CodexNativeRenderReceipt> {
  const pluginRoot = path.join(options.sourceRoot, 'plugins', options.pluginName);
  const platformManifest = await readProjectionJson(options.sourceRoot, path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (platformManifest.name !== options.pluginName) throw new Error('codexNativeProjectionIdentityMismatch: plugin identity does not match its marketplace path.');
  const skillsRelative = normalizePluginRelativeDirectory(platformManifest.skills, 'codex/skills');
  if (!skillsRelative) throw new Error('codexNativeProjectionUnsafe: Codex Skills root is unsafe.');
  const receiptPath = path.join(pluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH);
  if (!await inspectMarketplacePath(options.sourceRoot, receiptPath, 'file')) throw new CodexNativeProjectionNotReusableError();
  let receipt: CodexNativeRenderReceipt;
  try { receipt = parseCodexNativeRenderReceipt(await fs.readFile(receiptPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new CodexNativeProjectionNotReusableError();
  }
  if (receipt.logicalPluginId !== `${options.sourceId}/${options.pluginName}` || receipt.sourceIdentity !== options.sourceIdentity) {
    throw new Error('codexNativeProjectionIdentityMismatch: receipt identity does not match its marketplace.');
  }
  // The other platform may have updated the common bundle metadata. The installed
  // Codex manifest and verified receipt retain this platform's actual version and targets.
  if (platformManifest.version !== receipt.pluginVersion) throw new CodexNativeProjectionNotReusableError();
  const emptyDigest = createCodexSkillStagingTreeContentDigest({ skillKey: 'empty', files: {} });
  for (const target of receipt.targets) {
    const skillRoot = path.join(pluginRoot, ...skillsRelative.split('/'), target.skillKey);
    const stats = await inspectMarketplacePath(options.sourceRoot, skillRoot, 'directory');
    if (stats) await assertRegularProjectionTree(skillRoot, true);
    let tree;
    try { tree = stats ? await readDynamicSkillTree(skillRoot, 'codex.skill') : null; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      throw new CodexNativeProjectionNotReusableError();
    }
    if ((stats && !tree) || (tree ? createCodexSkillStagingTreeContentDigest(tree) : emptyDigest) !== target.artifactDigest) throw new CodexNativeProjectionNotReusableError();
  }
  if (await calculateCodexNativeRenderPayloadDigest(pluginRoot) !== receipt.payloadDigest) throw new CodexNativeProjectionNotReusableError();
  return receipt;
}

async function preserveMarketplacePluginProjection(options: {
  sourceRoot: string; stagingRoot: string; pluginName: string; sourceId: string; sourceIdentity: string;
}): Promise<void> {
  const sourcePluginRoot = path.join(options.sourceRoot, 'plugins', options.pluginName);
  const stagingPluginRoot = path.join(options.stagingRoot, 'plugins', options.pluginName);
  const sourceManifest = await readProjectionJson(options.sourceRoot, path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'));
  const stagingManifest = await readProjectionJson(options.stagingRoot, path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json'));
  if (sourceManifest.name !== options.pluginName || stagingManifest.name !== options.pluginName) throw new Error(`${nativeCodexTargets(sourceManifest).length ? 'codexNativeProjectionIdentityMismatch' : 'marketplaceProjectionIdentityMismatch'}: plugin identity does not match its marketplace path.`);
  await assertRegularProjectionTree(sourcePluginRoot);
  await assertRegularProjectionTree(stagingPluginRoot);
  let receipt: CodexNativeRenderReceipt | undefined;
  if (nativeCodexTargets(sourceManifest).length || await inspectMarketplacePath(options.sourceRoot, path.join(sourcePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), 'file')) {
    receipt = await readValidatedCodexProjection(options);
  } else {
    for (const platform of ['codex', 'claude']) {
      const manifestPath = path.join(sourcePluginRoot, `.${platform}-plugin`, 'plugin.json');
      if (!await inspectMarketplacePath(options.sourceRoot, manifestPath, 'file')) continue;
      const manifest = await readProjectionJson(options.sourceRoot, manifestPath);
      if (manifest.name !== options.pluginName) throw new Error('marketplaceProjectionIdentityMismatch: plugin identity does not match its marketplace path.');
      assertStrictSemVer(manifest.version, 'preserved platform plugin version');
    }
  }
  await fs.remove(stagingPluginRoot);
  await fs.copy(sourcePluginRoot, stagingPluginRoot, { dereference: false });
  if (receipt && await calculateCodexNativeRenderPayloadDigest(stagingPluginRoot) !== receipt.payloadDigest) throw new CodexNativeProjectionNotReusableError();
}

export interface PreservedPlatformReceipt { pluginName: string; receipt: CodexNativeRenderReceipt }

async function preserveUnrequestedMarketplacePlatforms(options: {
  sourceRoot: string; stagingRoot: string; pluginName: string; sourceId: string; sourceIdentity: string;
  requested: ReadonlySet<PlatformName>;
}): Promise<{ platforms: PlatformName[]; receipt?: PreservedPlatformReceipt }> {
  if (options.requested.has('codex') && options.requested.has('claude')) return { platforms: [] };
  const sourcePluginRoot = path.join(options.sourceRoot, 'plugins', options.pluginName);
  const stagingPluginRoot = path.join(options.stagingRoot, 'plugins', options.pluginName);
  const sourceManifest = await readProjectionJson(options.sourceRoot, path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'));
  if (sourceManifest.name !== options.pluginName) throw new Error('marketplaceProjectionIdentityMismatch: retained plugin identity does not match its path.');
  const platforms: PlatformName[] = [];
  let receipt: PreservedPlatformReceipt | undefined;
  for (const platform of ['codex', 'claude'] as const) {
    if (options.requested.has(platform)) continue;
    const manifestRelative = `.${platform}-plugin`;
    if (!await inspectMarketplacePath(options.sourceRoot, path.join(sourcePluginRoot, manifestRelative, 'plugin.json'), 'file')) continue;
    const manifest = await readProjectionJson(options.sourceRoot, path.join(sourcePluginRoot, manifestRelative, 'plugin.json'));
    if (manifest.name !== options.pluginName) throw new Error('marketplaceProjectionIdentityMismatch: retained platform identity does not match its path.');
    assertStrictSemVer(manifest.version, 'preserved platform plugin version');
    const roots = new Set([platform, manifestRelative]);
    const skillsRelative = manifest.skills === undefined ? undefined : normalizePluginRelativeDirectory(manifest.skills, `${platform}/skills`);
    if (manifest.skills !== undefined) {
      const relative = normalizePluginRelativeDirectory(manifest.skills, `${platform}/skills`);
      if (!relative || ['codex', 'claude'].some((other) => other !== platform && (relative === other || relative.startsWith(`${other}/`))) || ['.agents-plugin', '.codex-plugin', '.claude-plugin'].some((root) => relative === root || relative.startsWith(`${root}/`))) {
        throw new Error('marketplaceProjectionInvalid: retained Skill root overlaps another platform.');
      }
      roots.add(relative);
    }
    for (const requested of options.requested) {
      const requestedManifest = await readProjectionJson(options.stagingRoot, path.join(stagingPluginRoot, `.${requested}-plugin`, 'plugin.json'));
      const requestedSkills = requestedManifest.skills === undefined ? undefined : normalizePluginRelativeDirectory(requestedManifest.skills, `${requested}/skills`);
      if (requestedManifest.skills !== undefined && !requestedSkills) throw new Error('marketplaceProjectionInvalid: requested Skill root is unsafe.');
      for (const retainedRoot of roots) for (const requestedRoot of [requested, `.${requested}-plugin`, '.agents-plugin', ...(requestedSkills ? [requestedSkills] : [])]) {
        if (retainedRoot === requestedRoot || retainedRoot.startsWith(`${requestedRoot}/`) || requestedRoot.startsWith(`${retainedRoot}/`)) throw new Error('marketplaceProjectionInvalid: retained platform resources overlap the requested platform.');
      }
    }
    const codexReceipt = platform === 'codex' && await inspectMarketplacePath(options.sourceRoot, path.join(sourcePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), 'file')
      ? await readValidatedCodexProjection(options) : undefined;
    if (platform === 'codex' && !codexReceipt) {
      for (const target of nativeCodexTargets(sourceManifest)) {
        const tree = skillsRelative ? path.join(sourcePluginRoot, ...skillsRelative.split('/'), target.skillKey) : undefined;
        if (tree && await inspectMarketplacePath(options.sourceRoot, tree, 'directory')) throw new Error('codexNativeProjectionDamaged: an installed dynamic Skill has no render receipt; reinstall both platforms.');
      }
    }
    const checked = new Set<string>();
    const validateRecords = async (directory: string): Promise<void> => {
      if (checked.has(directory)) return;
      checked.add(directory);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await validateRecords(absolute);
        else if (entry.name === '.aw-command-producer.json') {
          const record = normalizeInstalledCommandProducer(await fs.readJson(absolute));
          const producer = record.producer;
          if (producer.sourceId !== options.sourceId || producer.sourceIdentity !== options.sourceIdentity || producer.pluginName !== options.pluginName || producer.platform !== platform || producer.scope !== 'user' || producer.projectRoot !== null || producer.kind === 'package') throw new Error('commandOwnerMismatch: retained native producer does not match its platform and source.');
          const skillKey = producer.kind === 'static-skill' ? producer.key : codexReceipt?.targets.find((target) => target.id === producer.key)?.skillKey;
          if (!skillsRelative || !skillKey || directory !== path.join(sourcePluginRoot, ...skillsRelative.split('/'), skillKey)) throw new Error('commandOwnerMismatch: retained native producer is outside its exact Skill path.');
          if (!await readDynamicSkillTree(directory, `${platform}.skill`)) throw new Error('commandResourceInvalid: retained native producer has no valid Skill.');
          await validateCommandEntryFiles(directory, record.sets.flatMap((set) => set.entries));
        }
      }
    };
    for (const relative of roots) {
      const source = path.join(sourcePluginRoot, ...relative.split('/'));
      if (await inspectMarketplacePath(options.sourceRoot, source, 'directory')) {
        await assertRegularProjectionTree(source, true);
        await validateRecords(source);
      }
    }
    if (codexReceipt) {
      receipt = { pluginName: options.pluginName, receipt: codexReceipt };
      await fs.copy(path.join(sourcePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), path.join(stagingPluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH));
    }
    for (const relative of roots) {
      const source = path.join(sourcePluginRoot, ...relative.split('/'));
      const destination = path.join(stagingPluginRoot, ...relative.split('/'));
      await fs.remove(destination);
      if (await inspectMarketplacePath(options.sourceRoot, source, 'directory')) await fs.copy(source, destination, { dereference: false });
    }
    platforms.push(platform);
  }
  return { platforms, ...(receipt ? { receipt } : {}) };
}

/** Rebind only the combined payload digest after verified, unrelated platform changes. */
export async function refreshPreservedPlatformReceipt(stagingRoot: string, retained: PreservedPlatformReceipt): Promise<void> {
  const pluginRoot = path.join(stagingRoot, 'plugins', retained.pluginName);
  const payloadDigest = await calculateCodexNativeRenderPayloadDigest(pluginRoot);
  await fs.outputFile(path.join(pluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), serializeCodexNativeRenderReceipt({ ...retained.receipt, payloadDigest }), 'utf8');
}

/**
 * Replays unselected plugin copies into a fresh Catalog generation.
 * Retains their payload and marketplace entries even when the Catalog changes.
 * Codex native dynamic projections must also retain their original validated receipt.
 * Damaged weak projections are skipped so their owning plugin can recover by sync.
 */
export async function replayNamespacedMarketplacePluginProjections(options: {
  sourceRoot: string;
  stagingRoot: string;
  sourceId: string;
  sourceIdentity: string;
  marketplaceName: string;
  rematerializedPluginIds?: ReadonlySet<string>;
  rematerializedPluginPlatforms?: ReadonlyMap<string, ReadonlySet<PlatformName>>;
  onPreservedPlatformReceipt?: (receipt: PreservedPlatformReceipt) => void;
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
    throw new Error(`marketplaceProjectionReadFailed: ${sanitizeCatalogSourceErrorMessage(
      error instanceof Error ? error.message : String(error),
      process.env,
      [options.sourceRoot, options.stagingRoot],
    )}`);
  }
  if (!existing) return;
  const retainedPluginNames = { codex: new Set<string>(), claude: new Set<string>() };
  const pluginsRoot = path.join(options.sourceRoot, 'plugins');
  let entries: Dirent[];
  try {
    entries = await readOverlayDirectory(options.sourceRoot, pluginsRoot, [options.sourceRoot, options.stagingRoot]);
  } catch (error) {
    throw new Error(`marketplaceProjectionReadFailed: ${sanitizeCatalogSourceErrorMessage(
      error instanceof Error ? error.message : String(error),
      process.env,
      [options.sourceRoot, options.stagingRoot],
    )}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error('codexNativeProjectionUnsafe: plugin root cannot be a symlink.');
    }
    if (!entry.isDirectory()) continue;
    const logicalPluginId = `${options.sourceId}/${entry.name}`;
    if (options.rematerializedPluginIds?.has(logicalPluginId)) {
      const requested = options.rematerializedPluginPlatforms?.get(logicalPluginId);
      if (requested) {
        try {
          const retained = await preserveUnrequestedMarketplacePlatforms({ ...options, pluginName: entry.name, requested });
          for (const platform of retained.platforms) retainedPluginNames[platform].add(entry.name);
          if (retained.receipt) options.onPreservedPlatformReceipt?.(retained.receipt);
        } catch (error) {
          throw new Error(`marketplaceProjectionInvalid: cannot preserve the unrequested platform for ${logicalPluginId}; reinstall both platforms. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }
    try {
      await preserveMarketplacePluginProjection({ ...options, pluginName: entry.name });
      retainedPluginNames.codex.add(entry.name);
      retainedPluginNames.claude.add(entry.name);
    } catch (error) {
      if (error instanceof CodexNativeProjectionNotReusableError) continue;
      throw new Error(`marketplaceProjectionReadFailed: ${sanitizeCatalogSourceErrorMessage(
        error instanceof Error ? error.message : String(error),
        process.env,
        [options.sourceRoot, options.stagingRoot],
      )}`);
    }
  }
  for (const [sourceManifest, relativePath, platform] of [
    [existing.agentsManifest, '.agents/plugins/marketplace.json', 'codex'],
    [existing.claudeManifest, '.claude-plugin/marketplace.json', 'claude'],
  ] as const) {
    const manifestPath = path.join(options.stagingRoot, relativePath);
    const stagingManifest = await readStrictOptionalJsonObject(options.stagingRoot, manifestPath);
    const retainedNames = retainedPluginNames[platform];
    if (!stagingManifest || retainedNames.size === 0) continue;
    if (!Array.isArray(stagingManifest.plugins) || (sourceManifest && !Array.isArray(sourceManifest.plugins))) {
      throw new Error('marketplaceProjectionInvalid: marketplace plugins must be an array.');
    }
    const retainedEntries = ((sourceManifest?.plugins ?? []) as unknown[]).filter(
      (entry): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry.name === 'string' && retainedNames.has(entry.name),
    );
    await fs.writeJson(manifestPath, {
      ...stagingManifest,
      plugins: [
        ...stagingManifest.plugins.filter((entry: unknown) =>
          !isRecord(entry) || !retainedNames.has(String(entry.name))),
        ...retainedEntries.map((entry) => ({
          ...entry,
          source: `./plugins/${entry.name}`,
        })),
      ],
    }, { spaces: 2 });
  }
}

async function inspectOverlayPath(
  trustedRoot: string,
  targetPath: string,
  finalKind: 'directory' | 'file',
  redactedRoots: string[],
): Promise<fs.Stats | null> {
  try {
    return await inspectMarketplacePath(trustedRoot, targetPath, finalKind);
  } catch (error) {
    throw new Error(`marketplaceOverlayReadFailed: ${sanitizeCatalogSourceErrorMessage(
      error instanceof Error ? error.message : String(error),
      process.env,
      redactedRoots,
    )}`);
  }
}

async function readOverlayDirectory(
  trustedRoot: string,
  directoryPath: string,
  redactedRoots: string[],
): Promise<Dirent[]> {
  if (!await inspectOverlayPath(
    trustedRoot,
    directoryPath,
    'directory',
    redactedRoots,
  )) return [];
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
  for (const pluginEntry of await readOverlayDirectory(
    options.sourceRoot,
    pluginsRoot,
    redactedRoots,
  )) {
    if (pluginEntry.isSymbolicLink()) {
      throw new Error(`Codex Skill overlay plugin root cannot be a symlink: ${pluginEntry.name}`);
    }
    if (!pluginEntry.isDirectory()) continue;
    const pluginName = pluginEntry.name;
    const sourcePluginRoot = path.join(pluginsRoot, pluginName);
    const sourcePlatformManifest = await readStrictOptionalJsonObject(
      options.sourceRoot,
      path.join(sourcePluginRoot, '.codex-plugin', 'plugin.json'),
    );
    const sourceSkillsRelative = normalizePluginRelativeDirectory(
      sourcePlatformManifest?.skills,
      'codex/skills',
    );
    if (!sourceSkillsRelative) continue;
    const sourceSkillsRoot = path.join(sourcePluginRoot, ...sourceSkillsRelative.split('/'));
    const overlays: Array<{ key: string; root: string }> = [];
    for (const entry of await readOverlayDirectory(
      options.sourceRoot,
      sourceSkillsRoot,
      redactedRoots,
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex Skill overlay cannot be a symlink: ${path.join(sourceSkillsRoot, entry.name)}`);
      }
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(sourceSkillsRoot, entry.name);
      const owner = await readSkillOwnerMarker({
        skillRoot,
        allowedRoot: sourceSkillsRoot,
        expectedIdentity: {
          owner: 'agent-workflows',
          sourceId: options.sourceId,
          pluginId: `${options.sourceId}/${pluginName}`,
          plugin: pluginName,
          artifactKey: entry.name,
          platform: 'codex',
          scope: 'user',
        },
      });
      if (!owner) continue;
      overlays.push({ key: entry.name, root: skillRoot });
    }
    if (overlays.length === 0) continue;

    const stagingPluginRoot = path.join(options.stagingRoot, 'plugins', pluginName);
    if (!await inspectOverlayPath(
      options.stagingRoot,
      stagingPluginRoot,
      'directory',
      redactedRoots,
    )) continue;
    const stagingManifest = await readStrictOptionalJsonObject(
      options.stagingRoot,
      path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json'),
    );
    const targets = (stagingManifest?.artifacts as { targets?: unknown[] } | undefined)?.targets ?? [];
    const dynamicKeys = new Set(targets.flatMap((target) => {
      if (!isRecord(target)) return [];
      return target.platform === 'codex'
        && target.target === 'codex.skill'
        && isRecord(target.delivery)
        && target.delivery.mode === 'codex-native'
        && Array.isArray(target.scopes)
        && target.scopes.includes('user')
        && typeof target.skillKey === 'string'
        ? [target.skillKey]
        : [];
    }));
    const stagingPlatformManifest = await readStrictOptionalJsonObject(
      options.stagingRoot,
      path.join(stagingPluginRoot, '.codex-plugin', 'plugin.json'),
    );
    const stagingSkillsRelative = normalizePluginRelativeDirectory(
      stagingPlatformManifest?.skills,
      'codex/skills',
    );
    if (!stagingSkillsRelative) continue;
    const stagingSkillsRoot = path.join(stagingPluginRoot, ...stagingSkillsRelative.split('/'));
    await inspectOverlayPath(options.stagingRoot, stagingSkillsRoot, 'directory', redactedRoots);
    for (const overlay of overlays) {
      if (!dynamicKeys.has(overlay.key)) continue;
      const destination = path.join(stagingSkillsRoot, overlay.key);
      await assertTreeHasNoSymlinks(overlay.root);
      await fs.copy(overlay.root, destination, {
        overwrite: true, errorOnExist: false, dereference: false,
      });
    }
  }
}
