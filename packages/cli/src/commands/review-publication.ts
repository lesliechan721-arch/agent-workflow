import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { computeSkillDigest } from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';

import {
  bundleLocalPlugin,
  prepareLocalPluginBundleSource,
} from '../generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../utils/catalog-runtime-projection.js';
import { readPluginManifest } from '../utils/manifest.js';
import type { PluginManifestSource, PluginMeta } from '../types.js';

const execFileAsync = promisify(execFile);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const kebabPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reviewIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{8}$/u;

export type ReviewPublicationKind = 'skill' | 'workflow' | 'aw-plugin' | 'aw-workflow';
export type ReviewAttachmentInput = { kind: string; path: string };

export interface ReviewScopeComponent {
  kind: string;
  id: string;
  path: string;
  digest: string;
}

export interface ReviewScope {
  schemaVersion: 1;
  kind: 'workflow' | 'aw-workflow';
  id: string;
  userOutcome: string;
  entry: string;
  components: ReviewScopeComponent[];
  representativePaths: string[];
  externalDependencies: unknown[];
  excluded: unknown[];
}

interface ManifestFileReference {
  path: string;
  digest: string;
}

export interface ReviewRecordManifest {
  schemaVersion: 1;
  reviewId: string;
  publishedAt: string;
  target: {
    kind: ReviewPublicationKind;
    id: string;
    digest: string;
    scopePath?: 'scope.json';
  };
  report: ManifestFileReference;
  result: ManifestFileReference | null;
  checks: Array<{ kind: string } & ManifestFileReference>;
  evidence: Array<{ kind: string } & ManifestFileReference>;
  releaseCheck: ManifestFileReference | null;
  source: { commit: string; dirty: boolean };
  supersedes: string | null;
}

export interface PublishReviewRecordInput {
  repoRoot: string;
  kind: ReviewPublicationKind;
  target: string;
  report: string;
  scope?: string;
  result?: string;
  checks?: ReviewAttachmentInput[];
  evidence?: ReviewAttachmentInput[];
  releaseCheck?: string;
  supersedes?: string;
  now?: Date;
  /** @internal Only deterministic failure tests use this hook. */
  beforeCommit?: () => void | Promise<void>;
}

export interface ReviewRecord {
  root: string;
  manifest: ReviewRecordManifest;
  existing: boolean;
}

export interface VerifyReviewRecordInput {
  repoRoot: string;
  reportDir: string;
}

export interface ListReviewRecordsInput {
  repoRoot: string;
  kind?: ReviewPublicationKind;
  targetId?: string;
}

export interface ShowReviewRecordInput {
  repoRoot: string;
  reviewId: string;
}

export interface ReviewComponentDigestInput {
  repoRoot: string;
  path: string;
}

export interface ReviewComponentDigest {
  path: string;
  digest: string;
}

interface ResolvedTarget {
  kind: ReviewPublicationKind;
  id: string;
  digest: string;
  root?: string;
  scope?: ReviewScope;
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeJson(record[key])]));
  }
  return value;
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKebab(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !kebabPattern.test(value)) {
    throw new Error(`${label} must use lowercase kebab-case.`);
  }
}

function assertReviewKind(value: unknown): asserts value is ReviewPublicationKind {
  if (!['skill', 'workflow', 'aw-plugin', 'aw-workflow'].includes(String(value))) {
    throw new Error('Invalid review kind.');
  }
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a safe relative POSIX path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value === '..' || value.startsWith('../') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must not escape its root.`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error(`${label} must be a sha256 digest.`);
  }
}

function parseScope(value: unknown, expectedKind?: ReviewPublicationKind): ReviewScope {
  if (!isRecord(value)) throw new Error('Scope must be a JSON object.');
  exactKeys(value, [
    'schemaVersion', 'kind', 'id', 'userOutcome', 'entry', 'components',
    'representativePaths', 'externalDependencies', 'excluded',
  ], 'Scope');
  if (value.schemaVersion !== 1) throw new Error('Scope schemaVersion must be 1.');
  if (value.kind !== 'workflow' && value.kind !== 'aw-workflow') {
    throw new Error('Scope kind must be workflow or aw-workflow.');
  }
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new Error(`Scope kind must match review kind ${expectedKind}.`);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error('Scope id must be nonempty.');
  if (typeof value.userOutcome !== 'string' || value.userOutcome.trim() === '') {
    throw new Error('Scope userOutcome must be nonempty.');
  }
  if (typeof value.entry !== 'string' || value.entry.trim() === '') throw new Error('Scope entry must be nonempty.');
  assertSafeRelativePath(value.entry, 'Scope entry');
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error('Scope components must be nonempty.');
  }
  const components = value.components.map((component, index): ReviewScopeComponent => {
    if (!isRecord(component)) throw new Error(`Scope component ${index + 1} must be an object.`);
    exactKeys(component, ['kind', 'id', 'path', 'digest'], `Scope component ${index + 1}`);
    assertKebab(component.kind, `Scope component ${index + 1} kind`);
    if (typeof component.id !== 'string' || component.id.trim() === '') {
      throw new Error(`Scope component ${index + 1} id must be nonempty.`);
    }
    assertSafeRelativePath(component.path, `Scope component ${index + 1} path`);
    assertDigest(component.digest, `Scope component ${index + 1} digest`);
    return component as unknown as ReviewScopeComponent;
  });
  if (!Array.isArray(value.representativePaths) || value.representativePaths.length === 0) {
    throw new Error('Scope representativePaths must be nonempty.');
  }
  const representativePaths = value.representativePaths.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`Scope representative path ${index + 1} must be nonempty.`);
    }
    return entry;
  });
  if (!Array.isArray(value.externalDependencies) || !Array.isArray(value.excluded)) {
    throw new Error('Scope externalDependencies and excluded must be arrays.');
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    id: value.id,
    userOutcome: value.userOutcome,
    entry: value.entry,
    components,
    representativePaths,
    externalDependencies: value.externalDependencies,
    excluded: value.excluded,
  };
}

function scopeDigest(scope: ReviewScope): string {
  return sha256(stableJson(scope));
}

function encodeTargetId(value: string): string {
  return `id-${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function isEncodedTargetId(value: string): boolean {
  if (!value.startsWith('id-') || value.length === 3) return false;
  const decoded = Buffer.from(value.slice(3), 'base64url').toString('utf8');
  return decoded.length > 0 && encodeTargetId(decoded) === value;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository.`);
  }
}

async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  const resolved = path.resolve(repoRoot);
  const stat = await fs.lstat(resolved).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('repoRoot must be a real directory.');
  return fs.realpath(resolved);
}

async function assertNoSymlinkChain(
  root: string,
  candidate: string,
  label: string,
  allowMissing = false,
): Promise<boolean> {
  assertWithin(root, candidate, label);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) {
      if (allowMissing) return false;
      throw new Error(`${label} does not exist: ${candidate}.`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot use symlinks: ${candidate}.`);
  }
  return true;
}

async function assertNoSymlinkAncestors(root: string, candidate: string, label: string): Promise<void> {
  assertWithin(root, candidate, label);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot use symlinks: ${current}.`);
    if (current !== candidate && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory ancestor: ${current}.`);
    }
  }
}

async function resolveRepoFile(repoRoot: string, value: string, label: string): Promise<string> {
  const candidate = path.resolve(repoRoot, value);
  await assertNoSymlinkChain(repoRoot, candidate, label);
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  const real = await fs.realpath(candidate);
  assertWithin(repoRoot, real, label);
  return real;
}

async function resolveRepoDirectory(repoRoot: string, candidate: string, label: string): Promise<string> {
  const resolved = path.resolve(candidate);
  await assertNoSymlinkChain(repoRoot, resolved, label);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory.`);
  return fs.realpath(resolved);
}

async function resolveSkillTarget(repoRoot: string, target: string): Promise<ResolvedTarget> {
  let root: string;
  let id: string;
  const parts = target.split('/');
  const staticId = parts.length === 1 && kebabPattern.test(parts[0]!);
  const pluginSkillId = parts.length === 2 && parts.every((part) => kebabPattern.test(part));
  if (staticId || pluginSkillId) {
    if (staticId) {
      id = parts[0]!;
      root = path.join(repoRoot, '.agents', 'skills', id);
    } else {
      id = target;
      root = path.join(repoRoot, 'plugins', parts[0]!, 'skills', parts[1]!);
    }
    root = await resolveRepoDirectory(repoRoot, root, 'Skill target');
  } else {
    root = await resolveRepoDirectory(repoRoot, path.resolve(repoRoot, target), 'Skill target');
    const relative = path.relative(repoRoot, root).split(path.sep).join('/');
    let match = /^\.agents\/skills\/([^/]+)$/u.exec(relative);
    if (match) id = match[1]!;
    else {
      match = /^plugins\/([^/]+)\/skills\/([^/]+)$/u.exec(relative);
      if (!match) throw new Error('Skill target path must identify a static or plugin Skill root.');
      id = `${match[1]}/${match[2]}`;
    }
  }
  return { kind: 'skill', id, digest: await computeSkillDigest(root), root };
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function listStrictRegularFiles(root: string, label: string): Promise<Array<{ path: string; mode: string; bytes: Buffer }>> {
  const files: Array<{ path: string; mode: string; bytes: Buffer }> = [];
  async function walk(current: string, relative = ''): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareCodepoint(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${label} cannot contain symlinks: ${childRelative}.`);
      if (stat.isDirectory()) await walk(absolute, childRelative);
      else if (stat.isFile()) files.push({
        path: childRelative,
        mode: process.platform !== 'win32' && (stat.mode & 0o111) !== 0 ? '100755' : '100644',
        bytes: await fs.readFile(absolute),
      });
      else throw new Error(`${label} must contain only regular files: ${childRelative}.`);
    }
  }
  await walk(root);
  return files;
}

async function reviewComponentDigestAtRoot(repoRoot: string, relativePath: string, label: string): Promise<string> {
  const candidate = path.resolve(repoRoot, relativePath);
  await assertNoSymlinkChain(repoRoot, candidate, label);
  const stat = await fs.lstat(candidate);
  if (stat.isFile()) {
    return productionTreeDigest([{
      path: '.',
      mode: process.platform !== 'win32' && (stat.mode & 0o111) !== 0 ? '100755' : '100644',
      bytes: await fs.readFile(candidate),
    }]);
  }
  if (stat.isDirectory()) {
    return productionTreeDigest(await listStrictRegularFiles(candidate, label));
  }
  throw new Error(`${label} must be a regular file or directory.`);
}

export async function computeReviewComponentDigest(
  input: ReviewComponentDigestInput,
): Promise<ReviewComponentDigest> {
  const repoRoot = await canonicalRepoRoot(input.repoRoot);
  const candidate = path.resolve(repoRoot, input.path);
  const digest = await reviewComponentDigestAtRoot(repoRoot, input.path, 'Review component');
  return {
    path: path.relative(repoRoot, candidate).split(path.sep).join('/') || '.',
    digest,
  };
}

async function assertScopeComponentBindings(repoRoot: string, scope: ReviewScope): Promise<void> {
  for (const [index, component] of scope.components.entries()) {
    const label = `Scope component ${index + 1}`;
    const actual = await reviewComponentDigestAtRoot(repoRoot, component.path, label);
    if (actual !== component.digest) {
      throw new Error(`${label} digest does not match repository content: ${component.path}.`);
    }
  }
}

async function assertPluginSourceNodes(root: string): Promise<void> {
  async function walk(current: string, relative = ''): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const skillRoot = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md');
    for (const entry of entries) {
      if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
      if (relative === '' && entry.name === 'reports') continue;
      if (skillRoot && ['evals', 'reports'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Plugin target cannot contain symlinks: ${childRelative}.`);
      if (stat.isDirectory()) await walk(absolute, childRelative);
      else if (!stat.isFile()) throw new Error(`Plugin target contains a non-regular node: ${childRelative}.`);
    }
  }
  await walk(root);
}

function productionTreeDigest(files: Array<{ path: string; mode: string; bytes: Buffer }>): string {
  const hash = createHash('sha256');
  const update = (value: string | Buffer): void => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  update('aw-production-records-v1');
  for (const file of files.sort((a, b) => compareCodepoint(a.path, b.path))) {
    update(file.path);
    update(file.mode);
    update(createHash('sha256').update(file.bytes).digest());
  }
  return `sha256:${hash.digest('hex')}`;
}

function productionProviderNames(manifest: PluginManifestSource): string[] {
  const names = [
    ...(manifest.buildConfig?.buildImports ?? []).map((entry) => entry.plugin),
    ...(manifest.buildConfig?.skillRuntimeFiles ?? [])
      .flatMap((entry) => entry.import ? [entry.import.plugin] : []),
    ...(manifest.artifacts?.targets ?? [])
      .flatMap((target) => (target.runtimeImports ?? []).map((entry) => entry.plugin)),
  ];
  return [...new Set(names.filter((name) => !name.startsWith('@aw/')))].sort(compareCodepoint);
}

async function resolveProductionProviderSourceSet(
  repoRoot: string,
  plugin: PluginMeta,
): Promise<PluginMeta[]> {
  const plugins = [plugin];
  for (const providerName of productionProviderNames(plugin.manifest)) {
    const roots = [...new Set([
      path.join(repoRoot, 'plugins', providerName),
      path.join(path.dirname(plugin.rootDir), providerName),
    ].map((candidate) => path.resolve(candidate)))];
    for (const root of roots) {
      if (root === plugin.rootDir) continue;
      const rootLabel = `Provider plugin "${providerName}" root`;
      if (!await assertNoSymlinkChain(repoRoot, root, rootLabel, true)) continue;
      const providerRoot = await resolveRepoDirectory(
        repoRoot,
        root,
        rootLabel,
      );
      const metadataPath = path.join(providerRoot, '.agents-plugin');
      const metadataLabel = `Provider plugin "${providerName}" metadata`;
      if (!await assertNoSymlinkChain(repoRoot, metadataPath, metadataLabel, true)) continue;
      await resolveRepoDirectory(
        repoRoot,
        metadataPath,
        metadataLabel,
      );
      const manifestPath = path.join(metadataPath, 'plugin.json');
      const manifestLabel = `Provider plugin "${providerName}" manifest`;
      if (!await assertNoSymlinkChain(repoRoot, manifestPath, manifestLabel, true)) continue;
      await resolveRepoFile(
        repoRoot,
        manifestPath,
        manifestLabel,
      );
      plugins.push(await readPluginManifest(providerRoot));
    }
  }
  return plugins;
}

async function pluginProductionDigest(repoRoot: string, pluginRoot: string): Promise<string> {
  await assertPluginSourceNodes(pluginRoot);
  const plugin = await readPluginManifest(pluginRoot);
  const plugins = await resolveProductionProviderSourceSet(repoRoot, plugin);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-plugin-bundle-'));
  let prepared: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>> | undefined;
  try {
    prepared = await prepareLocalPluginBundleSource(plugin, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(plugins),
    });
    const bundleRoot = path.join(tempRoot, 'bundle');
    await bundleLocalPlugin(prepared.plugin, bundleRoot, {
      buildMode: 'prepared',
      preparedRuntimeContext: prepared.runtimeContext,
    });
    return productionTreeDigest(await listStrictRegularFiles(bundleRoot, 'Plugin production bundle'));
  } finally {
    await Promise.all([
      prepared?.cleanup() ?? Promise.resolve(),
      fs.remove(tempRoot),
    ]);
  }
}

async function resolvePluginTarget(repoRoot: string, target: string): Promise<ResolvedTarget> {
  const defaultRoot = path.join(repoRoot, 'plugins', target);
  const pathTarget = path.resolve(repoRoot, target);
  const idTarget = kebabPattern.test(target)
    && (await fs.pathExists(defaultRoot) || !await fs.pathExists(pathTarget));
  let root: string;
  if (!idTarget) {
    root = await resolveRepoDirectory(repoRoot, pathTarget, 'Plugin target');
  } else {
    assertKebab(target, 'Plugin id');
    root = await resolveRepoDirectory(repoRoot, defaultRoot, 'Plugin target');
  }
  const manifestPath = await resolveRepoFile(repoRoot, path.join(root, '.agents-plugin', 'plugin.json'), 'Plugin manifest');
  const manifest = await fs.readJson(manifestPath) as unknown;
  if (!isRecord(manifest)) throw new Error('Plugin manifest must be a JSON object.');
  assertKebab(manifest.name, 'Plugin manifest name');
  if (path.basename(root) !== manifest.name) throw new Error('Plugin manifest name must match target id.');
  if (idTarget && target !== manifest.name) throw new Error('Plugin target id does not match manifest name.');
  return {
    kind: 'aw-plugin',
    id: manifest.name,
    digest: await pluginProductionDigest(repoRoot, root),
    root,
  };
}

async function resolveWorkflowTarget(
  repoRoot: string,
  kind: 'workflow' | 'aw-workflow',
  target: string,
  scopePath: string | undefined,
): Promise<ResolvedTarget> {
  if (!scopePath) throw new Error(`${kind} publication requires scope.`);
  const resolvedScopePath = await resolveRepoFile(repoRoot, scopePath, 'Scope');
  const scope = parseScope(await fs.readJson(resolvedScopePath), kind);
  await assertScopeComponentBindings(repoRoot, scope);
  if (target === scope.id) {
    return { kind, id: scope.id, digest: scopeDigest(scope), scope };
  }
  if (await fs.pathExists(path.resolve(repoRoot, target))) {
    const resolvedTarget = await resolveRepoFile(repoRoot, target, 'Workflow target');
    if (resolvedTarget !== resolvedScopePath) throw new Error('Workflow path target must be the scope file itself.');
  } else {
    throw new Error('Workflow target must match scope id.');
  }
  return { kind, id: scope.id, digest: scopeDigest(scope), scope };
}

async function resolveTarget(
  repoRoot: string,
  kind: ReviewPublicationKind,
  target: string,
  scope?: string,
): Promise<ResolvedTarget> {
  if (kind === 'skill') {
    if (scope !== undefined) throw new Error('skill publication does not accept scope.');
    return resolveSkillTarget(repoRoot, target);
  }
  if (kind === 'aw-plugin') {
    if (scope !== undefined) throw new Error('aw-plugin publication does not accept scope.');
    return resolvePluginTarget(repoRoot, target);
  }
  return resolveWorkflowTarget(repoRoot, kind, target, scope);
}

async function readJsonAttachment(repoRoot: string, value: string, label: string): Promise<unknown> {
  const file = await resolveRepoFile(repoRoot, value, label);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function validateAttachmentInputs(values: readonly ReviewAttachmentInput[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertKebab(value.kind, `${label} kind`);
    if (seen.has(value.kind)) throw new Error(`${label} kind must be unique: ${value.kind}.`);
    seen.add(value.kind);
  }
}

export function parseReviewAttachment(value: string, label = 'Attachment'): ReviewAttachmentInput {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} must use <kind>=<path>.`);
  }
  const attachment = { kind: value.slice(0, separator), path: value.slice(separator + 1) };
  assertKebab(attachment.kind, `${label} kind`);
  return attachment;
}

async function gitSource(repoRoot: string): Promise<{ commit: string; dirty: boolean }> {
  let commit: string;
  try {
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    commit = head.stdout.trim();
  } catch {
    throw new Error('Review publication requires a Git commit.');
  }
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('Review publication requires a valid Git commit.');
  const status = await execFileAsync('git', [
    'status', '--porcelain=v1', '--untracked-files=normal', '--', '.',
    ':(exclude)reports/reviews/**',
  ], { cwd: repoRoot, encoding: 'utf8' });
  return { commit, dirty: status.stdout.trim() !== '' };
}

function timestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('Publication time must be valid.');
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function createReviewId(date: Date, targetDigest: string, reportDigest: string): string {
  return `${timestamp(date)}-${targetDigest.slice(7, 15)}-${reportDigest.slice(7, 15)}`;
}

function manifestFile(pathValue: string, bytes: string | Buffer): ManifestFileReference {
  return { path: pathValue, digest: sha256(bytes) };
}

async function findManifestPaths(repoRoot: string): Promise<string[]> {
  const root = path.join(repoRoot, 'reports', 'reviews');
  if (!await fs.pathExists(root)) return [];
  await assertNoSymlinkChain(repoRoot, root, 'Review storage');
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Review storage must be a directory.');
  const result: string[] = [];
  for (const kindEntry of (await fs.readdir(root, { withFileTypes: true }))
    .sort((left, right) => compareCodepoint(left.name, right.name))) {
    const kindRoot = path.join(root, kindEntry.name);
    if (kindEntry.isSymbolicLink() || !kindEntry.isDirectory()) {
      throw new Error(`Review storage kind must be a regular directory: ${kindRoot}.`);
    }
    assertReviewKind(kindEntry.name);
    for (const targetEntry of (await fs.readdir(kindRoot, { withFileTypes: true }))
      .sort((left, right) => compareCodepoint(left.name, right.name))) {
      const targetRoot = path.join(kindRoot, targetEntry.name);
      if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory() || !isEncodedTargetId(targetEntry.name)) {
        throw new Error(`Review storage target must be one encoded directory: ${targetRoot}.`);
      }
      for (const recordEntry of (await fs.readdir(targetRoot, { withFileTypes: true }))
        .sort((left, right) => compareCodepoint(left.name, right.name))) {
        if (recordEntry.name.startsWith('.tmp-')) continue;
        const recordRoot = path.join(targetRoot, recordEntry.name);
        if (
          recordEntry.isSymbolicLink()
          || !recordEntry.isDirectory()
          || !reviewIdPattern.test(recordEntry.name)
        ) {
          throw new Error(`Review storage contains a foreign record: ${recordRoot}.`);
        }
        const manifestPath = path.join(recordRoot, 'manifest.json');
        const manifestStat = await fs.lstat(manifestPath).catch(() => null);
        if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
          throw new Error(`Review record is missing a regular manifest: ${recordRoot}.`);
        }
        result.push(manifestPath);
      }
    }
  }
  return result;
}

function parseManifest(value: unknown): ReviewRecordManifest {
  if (!isRecord(value)) throw new Error('Review manifest must be an object.');
  exactKeys(value, [
    'schemaVersion', 'reviewId', 'publishedAt', 'target', 'report', 'result',
    'checks', 'evidence', 'releaseCheck', 'source', 'supersedes',
  ], 'Review manifest');
  if (value.schemaVersion !== 1) throw new Error('Review manifest schemaVersion must be 1.');
  if (typeof value.reviewId !== 'string' || !reviewIdPattern.test(value.reviewId)) throw new Error('Invalid reviewId.');
  if (
    typeof value.publishedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.publishedAt)
    || Number.isNaN(Date.parse(value.publishedAt))
  ) throw new Error('Invalid publishedAt.');
  if (!isRecord(value.target)) throw new Error('Review target must be an object.');
  const targetKeys = value.target.scopePath === undefined ? ['kind', 'id', 'digest'] : ['kind', 'id', 'digest', 'scopePath'];
  exactKeys(value.target, targetKeys, 'Review target');
  if (!['skill', 'workflow', 'aw-plugin', 'aw-workflow'].includes(String(value.target.kind))) throw new Error('Invalid target kind.');
  if (typeof value.target.id !== 'string' || value.target.id.length === 0) throw new Error('Invalid target id.');
  assertDigest(value.target.digest, 'Target digest');
  if (['workflow', 'aw-workflow'].includes(String(value.target.kind))) {
    if (value.target.scopePath !== 'scope.json') throw new Error('Workflow target requires scope.json.');
  } else if (value.target.scopePath !== undefined) throw new Error('Leaf target cannot use scopePath.');
  const parseRef = (entry: unknown, expectedPath: string, label: string): ManifestFileReference => {
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    exactKeys(entry, ['path', 'digest'], label);
    if (entry.path !== expectedPath) throw new Error(`${label} path must be ${expectedPath}.`);
    assertDigest(entry.digest, `${label} digest`);
    return entry as unknown as ManifestFileReference;
  };
  const parseMany = (entry: unknown, root: string, label: string): Array<{ kind: string } & ManifestFileReference> => {
    if (!Array.isArray(entry)) throw new Error(`${label} must be an array.`);
    const seen = new Set<string>();
    return entry.map((item) => {
      if (!isRecord(item)) throw new Error(`${label} entry must be an object.`);
      exactKeys(item, ['kind', 'path', 'digest'], `${label} entry`);
      assertKebab(item.kind, `${label} kind`);
      if (seen.has(item.kind)) throw new Error(`${label} kind must be unique.`);
      seen.add(item.kind);
      if (item.path !== `${root}/${item.kind}.json`) throw new Error(`${label} path is invalid.`);
      assertDigest(item.digest, `${label} digest`);
      return item as unknown as { kind: string } & ManifestFileReference;
    });
  };
  if (!isRecord(value.source)) throw new Error('Review source must be an object.');
  exactKeys(value.source, ['commit', 'dirty'], 'Review source');
  if (typeof value.source.commit !== 'string' || !/^[0-9a-f]{40,64}$/u.test(value.source.commit)) throw new Error('Invalid source commit.');
  if (typeof value.source.dirty !== 'boolean') throw new Error('Invalid source dirty value.');
  if (value.supersedes !== null && (typeof value.supersedes !== 'string' || !reviewIdPattern.test(value.supersedes))) {
    throw new Error('Invalid supersedes review id.');
  }
  return {
    schemaVersion: 1,
    reviewId: value.reviewId,
    publishedAt: value.publishedAt,
    target: value.target as ReviewRecordManifest['target'],
    report: parseRef(value.report, 'report.md', 'Report'),
    result: value.result === null ? null : parseRef(value.result, 'review-result.json', 'Result'),
    checks: parseMany(value.checks, 'checks', 'Checks'),
    evidence: parseMany(value.evidence, 'evidence', 'Evidence'),
    releaseCheck: value.releaseCheck === null ? null : parseRef(value.releaseCheck, 'release-check.json', 'Release check'),
    source: value.source as ReviewRecordManifest['source'],
    supersedes: value.supersedes as string | null,
  };
}

async function verifyJsonFile(root: string, reference: ManifestFileReference, label: string): Promise<void> {
  const file = path.join(root, ...reference.path.split('/'));
  await assertNoSymlinkChain(root, file, label);
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== reference.digest) throw new Error(`${label} digest mismatch.`);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error(`${label} is invalid JSON.`); }
  if (bytes.toString('utf8') !== prettyJson(parsed)) throw new Error(`${label} is not canonical archived JSON.`);
}

async function verifyAtRoot(repoRoot: string, root: string, requireLocation = true): Promise<ReviewRecordManifest> {
  await assertNoSymlinkChain(repoRoot, root, 'Review record');
  const manifestPath = path.join(root, 'manifest.json');
  await assertNoSymlinkChain(root, manifestPath, 'Review manifest');
  const manifest = parseManifest(await fs.readJson(manifestPath));
  if (requireLocation) {
    const expected = path.join(repoRoot, 'reports', 'reviews', manifest.target.kind, encodeTargetId(manifest.target.id), manifest.reviewId);
    if (root !== expected) throw new Error('Review record storage path does not match manifest identity.');
  }
  const expectedFiles = new Set(['manifest.json', 'report.md']);
  if (manifest.target.scopePath) expectedFiles.add(manifest.target.scopePath);
  if (manifest.result) expectedFiles.add(manifest.result.path);
  if (manifest.releaseCheck) expectedFiles.add(manifest.releaseCheck.path);
  for (const entry of [...manifest.checks, ...manifest.evidence]) expectedFiles.add(entry.path);
  const actualFiles: string[] = [];
  async function collect(current: string, relative = ''): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Review record cannot contain symlinks: ${child}.`);
      if (entry.isDirectory()) await collect(absolute, child);
      else if (entry.isFile()) actualFiles.push(child);
      else throw new Error(`Review record contains a non-regular node: ${child}.`);
    }
  }
  await collect(root);
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error('Review record file inventory does not match its manifest.');
  }
  const reportBytes = await fs.readFile(path.join(root, manifest.report.path));
  if (sha256(reportBytes) !== manifest.report.digest) throw new Error('Report digest mismatch.');
  const expectedReviewId = createReviewId(
    new Date(manifest.publishedAt),
    manifest.target.digest,
    manifest.report.digest,
  );
  if (manifest.reviewId !== expectedReviewId) {
    throw new Error('Review manifest identity does not match its publication inputs.');
  }
  for (const entry of manifest.checks) await verifyJsonFile(root, entry, `Check ${entry.kind}`);
  for (const entry of manifest.evidence) await verifyJsonFile(root, entry, `Evidence ${entry.kind}`);
  if (manifest.result) await verifyJsonFile(root, manifest.result, 'Review result');
  if (manifest.releaseCheck) await verifyJsonFile(root, manifest.releaseCheck, 'Release check');
  if (manifest.target.scopePath) {
    const scopeFile = path.join(root, manifest.target.scopePath);
    const bytes = await fs.readFile(scopeFile);
    const parsed = parseScope(JSON.parse(bytes.toString('utf8')) as unknown, manifest.target.kind);
    if (bytes.toString('utf8') !== prettyJson(parsed)) throw new Error('Scope is not canonical archived JSON.');
    if (parsed.id !== manifest.target.id || scopeDigest(parsed) !== manifest.target.digest) {
      throw new Error('Scope target binding mismatch.');
    }
  }
  return manifest;
}

export async function verifyReviewRecord(input: VerifyReviewRecordInput): Promise<ReviewRecord> {
  const repoRoot = await canonicalRepoRoot(input.repoRoot);
  const suppliedRepoRoot = path.resolve(input.repoRoot);
  const supplied = path.resolve(suppliedRepoRoot, input.reportDir);
  const suppliedRelative = path.relative(suppliedRepoRoot, supplied);
  const isSafeRelative = (value: string): boolean =>
    value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
  const root = isSafeRelative(suppliedRelative)
    ? path.join(repoRoot, suppliedRelative)
    : supplied;
  await assertNoSymlinkChain(repoRoot, root, 'Review record');
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Review record must be a directory.');
  const manifest = await verifyAtRoot(repoRoot, root);
  return { root, manifest, existing: true };
}

async function findByReviewId(repoRoot: string, reviewId: string): Promise<string[]> {
  const manifests = await findManifestPaths(repoRoot);
  return manifests.filter((entry) => path.basename(path.dirname(entry)) === reviewId).map(path.dirname);
}

async function assertSupersedes(
  repoRoot: string,
  target: ResolvedTarget,
  reviewId: string | undefined,
): Promise<string | null> {
  if (reviewId === undefined) return null;
  if (!reviewIdPattern.test(reviewId)) throw new Error('supersedes must be a valid review id.');
  const matches = await findByReviewId(repoRoot, reviewId);
  if (matches.length !== 1) throw new Error('supersedes must identify one existing review record.');
  const manifest = await verifyAtRoot(repoRoot, matches[0]!);
  if (manifest.target.kind !== target.kind || manifest.target.id !== target.id) {
    throw new Error('supersedes must reference the same kind and target.');
  }
  return reviewId;
}

function equivalentRequest(left: ReviewRecordManifest, right: ReviewRecordManifest): boolean {
  const normalize = (manifest: ReviewRecordManifest): unknown => ({
    target: manifest.target,
    report: manifest.report,
    result: manifest.result,
    checks: manifest.checks,
    evidence: manifest.evidence,
    releaseCheck: manifest.releaseCheck,
    source: manifest.source,
    supersedes: manifest.supersedes,
  });
  return stableJson(normalize(left)) === stableJson(normalize(right));
}

export async function publishReviewRecord(input: PublishReviewRecordInput): Promise<ReviewRecord> {
  const repoRoot = await canonicalRepoRoot(input.repoRoot);
  assertReviewKind(input.kind);
  const target = await resolveTarget(repoRoot, input.kind, input.target, input.scope);
  const reportPath = await resolveRepoFile(repoRoot, input.report, 'Report');
  const reportBytes = await fs.readFile(reportPath);
  const checks = input.checks ?? [];
  const evidence = input.evidence ?? [];
  validateAttachmentInputs(checks, 'Check');
  validateAttachmentInputs(evidence, 'Evidence');
  const archivedChecks = (await Promise.all(checks.map(async (entry) => ({
    kind: entry.kind,
    bytes: prettyJson(await readJsonAttachment(repoRoot, entry.path, `Check ${entry.kind}`)),
  })))).sort((left, right) => compareCodepoint(left.kind, right.kind));
  const archivedEvidence = (await Promise.all(evidence.map(async (entry) => ({
    kind: entry.kind,
    bytes: prettyJson(await readJsonAttachment(repoRoot, entry.path, `Evidence ${entry.kind}`)),
  })))).sort((left, right) => compareCodepoint(left.kind, right.kind));
  const resultBytes = input.result === undefined ? null
    : prettyJson(await readJsonAttachment(repoRoot, input.result, 'Review result'));
  const releaseCheckBytes = input.releaseCheck === undefined ? null
    : prettyJson(await readJsonAttachment(repoRoot, input.releaseCheck, 'Release check'));
  const source = await gitSource(repoRoot);
  const supersedes = await assertSupersedes(repoRoot, target, input.supersedes);
  const publicationTime = input.now ?? new Date();
  const publishedAt = publicationTime.toISOString();
  const targetManifest: ReviewRecordManifest['target'] = target.scope
    ? { kind: target.kind, id: target.id, digest: target.digest, scopePath: 'scope.json' }
    : { kind: target.kind, id: target.id, digest: target.digest };
  const report = manifestFile('report.md', reportBytes);
  const provisional: ReviewRecordManifest = {
    schemaVersion: 1,
    reviewId: createReviewId(publicationTime, target.digest, report.digest),
    publishedAt,
    target: targetManifest,
    report,
    result: resultBytes === null ? null : manifestFile('review-result.json', resultBytes),
    checks: archivedChecks.map((entry) => ({ kind: entry.kind, ...manifestFile(`checks/${entry.kind}.json`, entry.bytes) })),
    evidence: archivedEvidence.map((entry) => ({ kind: entry.kind, ...manifestFile(`evidence/${entry.kind}.json`, entry.bytes) })),
    releaseCheck: releaseCheckBytes === null ? null : manifestFile('release-check.json', releaseCheckBytes),
    source,
    supersedes,
  };
  const targetParent = path.join(repoRoot, 'reports', 'reviews', target.kind, encodeTargetId(target.id));
  await assertNoSymlinkAncestors(repoRoot, targetParent, 'Review storage');
  if (await fs.pathExists(targetParent)) {
    for (const entry of await fs.readdir(targetParent, { withFileTypes: true })) {
      if (entry.name.startsWith('.tmp-')) continue;
      const existingRoot = path.join(targetParent, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory() || !reviewIdPattern.test(entry.name)) {
        throw new Error(`Review storage contains a foreign record: ${existingRoot}.`);
      }
      const manifest = await verifyAtRoot(repoRoot, existingRoot);
      if (manifest.target.digest === target.digest && manifest.report.digest === report.digest) {
        if (equivalentRequest(manifest, provisional)) return { root: existingRoot, manifest, existing: true };
        throw new Error('A review with the same target and report digests has conflicting publication inputs.');
      }
    }
  }
  const destination = path.join(targetParent, provisional.reviewId);
  if (await fs.pathExists(destination)) throw new Error(`Review record already exists: ${provisional.reviewId}.`);
  await fs.ensureDir(targetParent);
  const staging = path.join(targetParent, `.tmp-${process.pid}-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    if (await fs.pathExists(destination)) throw new Error(`Review record already exists: ${provisional.reviewId}.`);
    await fs.writeFile(path.join(staging, 'report.md'), reportBytes, { flag: 'wx' });
    if (target.scope) await fs.writeFile(path.join(staging, 'scope.json'), prettyJson(target.scope), { flag: 'wx' });
    if (resultBytes !== null) await fs.writeFile(path.join(staging, 'review-result.json'), resultBytes, { flag: 'wx' });
    if (releaseCheckBytes !== null) await fs.writeFile(path.join(staging, 'release-check.json'), releaseCheckBytes, { flag: 'wx' });
    if (archivedChecks.length > 0) await fs.mkdir(path.join(staging, 'checks'));
    for (const entry of archivedChecks) await fs.writeFile(path.join(staging, 'checks', `${entry.kind}.json`), entry.bytes, { flag: 'wx' });
    if (archivedEvidence.length > 0) await fs.mkdir(path.join(staging, 'evidence'));
    for (const entry of archivedEvidence) await fs.writeFile(path.join(staging, 'evidence', `${entry.kind}.json`), entry.bytes, { flag: 'wx' });
    await fs.writeFile(path.join(staging, 'manifest.json'), prettyJson(provisional), { flag: 'wx' });
    await verifyAtRoot(repoRoot, staging, false);
    await input.beforeCommit?.();
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.remove(staging);
    throw error;
  }
  return { root: destination, manifest: provisional, existing: false };
}

export async function listReviewRecords(input: ListReviewRecordsInput): Promise<ReviewRecord[]> {
  const repoRoot = await canonicalRepoRoot(input.repoRoot);
  if (input.kind !== undefined) assertReviewKind(input.kind);
  const records: ReviewRecord[] = [];
  for (const manifestPath of await findManifestPaths(repoRoot)) {
    const root = path.dirname(manifestPath);
    await assertNoSymlinkChain(repoRoot, manifestPath, 'Review manifest');
    const manifest = parseManifest(await fs.readJson(manifestPath));
    const expected = path.join(
      repoRoot,
      'reports',
      'reviews',
      manifest.target.kind,
      encodeTargetId(manifest.target.id),
      manifest.reviewId,
    );
    if (root !== expected) throw new Error('Review record storage path does not match manifest identity.');
    if (input.kind !== undefined && manifest.target.kind !== input.kind) continue;
    if (input.targetId !== undefined && manifest.target.id !== input.targetId) continue;
    records.push({ root, manifest, existing: true });
  }
  return records.sort((left, right) =>
    compareCodepoint(left.manifest.publishedAt, right.manifest.publishedAt)
    || compareCodepoint(left.manifest.reviewId, right.manifest.reviewId));
}

export async function showReviewRecord(input: ShowReviewRecordInput): Promise<ReviewRecord> {
  const repoRoot = await canonicalRepoRoot(input.repoRoot);
  if (!reviewIdPattern.test(input.reviewId)) throw new Error('Invalid reviewId.');
  const matches = await findByReviewId(repoRoot, input.reviewId);
  if (matches.length !== 1) throw new Error(`Expected one review record for ${input.reviewId}; found ${matches.length}.`);
  const manifest = await verifyAtRoot(repoRoot, matches[0]!);
  return { root: matches[0]!, manifest, existing: true };
}
