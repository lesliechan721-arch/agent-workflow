import crypto from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import fs from 'fs-extra';

import type { PlatformName, Scope, SourceIdentity } from '../types.js';

export const SKILL_OWNER_MARKER = '.agent-workflows-owner.json';
export const OWNED_TEXT_HEADER_PREFIX = '# agent-workflows-owner: ';
export const SHARED_OWNER_TOKEN_PREFIX = 'aw-owner-v2:';

export type OwnershipState = 'present' | 'absent' | 'partial';
export type OwnershipInspectionState = OwnershipState | 'error';

export interface TargetIdentity {
  platform: PlatformName;
  scope: Scope;
}

export interface OwnerIdentity extends TargetIdentity {
  owner: 'agent-workflows';
  sourceId?: string;
  sourceIdentity?: SourceIdentity;
  pluginId?: string;
  plugin: string;
  artifactKey: string;
}

export function createSharedOwnerToken(identity: OwnerIdentity): string {
  validateOwnerIdentity(identity);
  if (!identity.sourceId) return identity.plugin;
  return `${SHARED_OWNER_TOKEN_PREFIX}${Buffer.from(createSkillOwnerMarkerContent(identity)).toString('base64url')}`;
}

export function parseSharedOwnerToken(value: string): OwnerIdentity | null {
  if (!value.startsWith(SHARED_OWNER_TOKEN_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(SHARED_OWNER_TOKEN_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Shared owner token is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 2) {
    throw new Error('Shared owner token must contain schema 2 identity.');
  }
  return parseOwnerIdentity(parsed, 'Shared owner token');
}

export type SkillOwnerMarker = OwnerIdentity & { schemaVersion: 1 | 2 };

export type OwnedProbeResult = 'present' | 'absent' | 'partial' | 'foreign';

interface OwnedPathComponent {
  path: string;
  allowedRoot: string;
  identity: OwnerIdentity;
}

export type OwnedComponent =
  | ({
      kind: 'skill-directory';
      validateHealth?: () => Promise<void>;
      // A pristine markerless catalog tree is absent, not deletion-authorized ownership.
      unownedIsPristine?: (actualPath: string) => Promise<boolean>;
    } & OwnedPathComponent)
  | ({ kind: 'owned-text-file' } & OwnedPathComponent)
  | {
      kind: 'managed-block' | 'shared-config';
      identity: OwnerIdentity;
      label: string;
      inspect: () => Promise<OwnedProbeResult>;
      remove: () => Promise<void>;
    }
  | {
      kind: 'native-plugin';
      identity: OwnerIdentity;
      pluginId: string;
    };

export interface OwnedComponentInspection {
  component: OwnedComponent;
  state: OwnershipInspectionState;
  diagnostic?: string;
}

export interface OwnershipError {
  label: string;
  message: string;
}

export interface OwnershipInspection {
  state: OwnershipInspectionState;
  components: OwnedComponentInspection[];
  errors: OwnershipError[];
}

export type NativeOwnershipProbe = (
  component: Extract<OwnedComponent, { kind: 'native-plugin' }>,
) => Promise<OwnedProbeResult>;

export type NativeOwnershipRemove = (
  component: Extract<OwnedComponent, { kind: 'native-plugin' }>,
) => Promise<void>;

export interface CleanupFailure extends OwnershipError {
  phase: 'probe' | 'mutation' | 'verify' | 'remove' | 'post-probe';
  quarantinePath?: string;
}

export interface CleanupResult {
  removed: string[];
  absent: string[];
  residual: string[];
  quarantined: string[];
  failures: CleanupFailure[];
}

class OwnershipSymlinkError extends Error {}

let atomicReplaceBeforeRenameHookForTests: (() => Promise<void>) | undefined;

export function setAtomicReplaceBeforeRenameHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  atomicReplaceBeforeRenameHookForTests = hook;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertSafeOwnershipSegment(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error(`${label} 必须是安全的单一路径 segment：${JSON.stringify(value)}`);
  }
}

export function validateOwnerIdentity(identity: OwnerIdentity): void {
  if (identity.owner !== 'agent-workflows') {
    throw new Error('Owner identity.owner 必须是 "agent-workflows"。');
  }
  assertSafeOwnershipSegment(identity.plugin, 'Owner identity.plugin');
  assertSafeOwnershipSegment(identity.artifactKey, 'Owner identity.artifactKey');
  const sourceFields = [identity.sourceId, identity.sourceIdentity, identity.pluginId];
  if (sourceFields.some((value) => value !== undefined)) {
    if (sourceFields.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new Error('Owner identity source fields must be present together.');
    }
    assertSafeOwnershipSegment(identity.sourceId!, 'Owner identity.sourceId');
    if (!/^sha256:[0-9a-f]{64}$/u.test(identity.sourceIdentity!)) {
      throw new Error('Owner identity.sourceIdentity must be a SHA-256 digest.');
    }
    if (identity.pluginId !== `${identity.sourceId}/${identity.plugin}`) {
      throw new Error('Owner identity.pluginId must be the canonical sourceId/plugin name.');
    }
  }
  if (identity.platform !== 'codex' && identity.platform !== 'claude') {
    throw new Error(`Owner identity.platform 无效：${String(identity.platform)}`);
  }
  if (identity.scope !== 'user' && identity.scope !== 'project') {
    throw new Error(`Owner identity.scope 无效：${String(identity.scope)}`);
  }
}

function identitiesEqual(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.owner === right.owner &&
    left.sourceId === right.sourceId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.pluginId === right.pluginId &&
    left.plugin === right.plugin &&
    left.artifactKey === right.artifactKey &&
    left.platform === right.platform &&
    left.scope === right.scope;
}

function markerFromIdentity(identity: OwnerIdentity): SkillOwnerMarker {
  validateOwnerIdentity(identity);
  const namespaced = identity.sourceId !== undefined;
  return {
    schemaVersion: namespaced ? 2 : 1,
    owner: identity.owner,
    ...(namespaced ? {
      sourceId: identity.sourceId,
      sourceIdentity: identity.sourceIdentity,
      pluginId: identity.pluginId,
    } : {}),
    plugin: identity.plugin,
    artifactKey: identity.artifactKey,
    platform: identity.platform,
    scope: identity.scope,
  };
}

function parseOwnerIdentity(value: unknown, label: string): OwnerIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object。`);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schemaVersion',
    'owner',
    'sourceId',
    'sourceIdentity',
    'pluginId',
    'plugin',
    'artifactKey',
    'platform',
    'scope',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} 包含未知字段。`);
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new Error(`${label}.schemaVersion 不受支持。`);
  }
  if (record.schemaVersion === 2 && (
    typeof record.sourceId !== 'string'
    || typeof record.sourceIdentity !== 'string'
    || typeof record.pluginId !== 'string'
  )) {
    throw new Error(`${label}.schemaVersion 必须是 1，或提供完整 schema 2 source identity。`);
  }
  const identity = {
    owner: record.owner,
    ...(record.schemaVersion === 2 ? {
      sourceId: record.sourceId,
      sourceIdentity: record.sourceIdentity,
      pluginId: record.pluginId,
    } : {}),
    plugin: record.plugin,
    artifactKey: record.artifactKey,
    platform: record.platform,
    scope: record.scope,
  } as OwnerIdentity;
  validateOwnerIdentity(identity);
  return identity;
}

export function createSkillOwnerMarkerContent(identity: OwnerIdentity): string {
  return `${JSON.stringify(markerFromIdentity(identity), null, 2)}\n`;
}

function assertPathBoundary(allowedRoot: string, candidatePath: string): {
  root: string;
  candidate: string;
} {
  const root = path.resolve(allowedRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Ownership 路径越界：${candidate} 不在 ${root} 的子路径中。`);
  }
  return { root, candidate };
}

async function assertNoSymlinkInPath(allowedRoot: string, candidatePath: string): Promise<void> {
  const { root, candidate } = assertPathBoundary(allowedRoot, candidatePath);
  const relativeSegments = path.relative(root, candidate).split(path.sep);
  const paths = [root];
  let current = root;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const currentPath of paths) {
    const stats = await fs.lstat(currentPath).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (stats?.isSymbolicLink()) {
      throw new OwnershipSymlinkError(`Ownership 路径不能包含符号链接：${currentPath}`);
    }
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

async function readDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity> {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new OwnershipSymlinkError(`Ownership 稳定目录必须是真实目录：${directoryPath}`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    realPath: await fs.realpath(directoryPath),
  };
}

function assertStableDirectory(
  label: string,
  before: DirectoryIdentity,
  after: DirectoryIdentity,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.realPath !== after.realPath) {
    throw new Error(`${label} identity 在 atomic rename 前发生变化。`);
  }
}

function assertRealDirectoryBoundary(root: DirectoryIdentity, parent: DirectoryIdentity): void {
  const relative = path.relative(root.realPath, parent.realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Ownership parent realpath 不在 allowedRoot realpath 内。');
  }
}

async function atomicReplaceFile(options: {
  path: string;
  allowedRoot: string;
  content: string;
}): Promise<void> {
  await assertNoSymlinkInPath(options.allowedRoot, options.path);
  await fs.ensureDir(path.dirname(options.path));
  await assertNoSymlinkInPath(options.allowedRoot, options.path);
  const rootIdentity = await readDirectoryIdentity(path.resolve(options.allowedRoot));
  const parentIdentity = await readDirectoryIdentity(path.dirname(path.resolve(options.path)));
  assertRealDirectoryBoundary(rootIdentity, parentIdentity);
  const temporaryPath = path.join(
    path.dirname(options.path),
    `.${path.basename(options.path)}.owner-${process.pid}-${crypto.randomUUID()}`,
  );
  assertPathBoundary(options.allowedRoot, temporaryPath);
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(temporaryPath, 'wx', 0o666);
    await handle.writeFile(options.content, 'utf8');
    await handle.close();
    handle = undefined;
    await atomicReplaceBeforeRenameHookForTests?.();
    // Threat model: this blocks pre-existing symlinks/hardlinks, traversal, and callers that use
    // this API concurrently. Node has no portable dirfd/openat/renameat2 sequence, so this does not
    // claim to stop a process with the same file permissions from swapping a directory after this
    // final check and before rename; that process can already edit or delete the user's files.
    await assertNoSymlinkInPath(options.allowedRoot, options.path);
    const currentRootIdentity = await readDirectoryIdentity(path.resolve(options.allowedRoot));
    const currentParentIdentity = await readDirectoryIdentity(path.dirname(path.resolve(options.path)));
    assertRealDirectoryBoundary(currentRootIdentity, currentParentIdentity);
    assertStableDirectory('allowedRoot', rootIdentity, currentRootIdentity);
    assertStableDirectory('parent', parentIdentity, currentParentIdentity);
    await nodeFs.rename(temporaryPath, options.path);
  } finally {
    await handle?.close().catch(() => undefined);
    await nodeFs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function assertOwnedSkillPath(options: {
  skillRoot: string;
  allowedRoot: string;
  identity: OwnerIdentity;
}): Promise<void> {
  validateOwnerIdentity(options.identity);
  assertSafeOwnershipSegment(path.basename(options.skillRoot), 'Skill 目录名');
  if (path.basename(options.skillRoot) !== options.identity.artifactKey) {
    throw new Error('Skill 目录名必须与 owner artifactKey 一致。');
  }
  await assertNoSymlinkInPath(options.allowedRoot, options.skillRoot);
}

export async function writeSkillOwnerMarker(options: {
  skillRoot: string;
  allowedRoot: string;
  identity: OwnerIdentity;
}): Promise<string> {
  await assertOwnedSkillPath(options);
  const stats = await fs.lstat(options.skillRoot).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!stats?.isDirectory()) {
    throw new Error(`Skill owner marker 目标必须是真实目录：${options.skillRoot}`);
  }
  const markerPath = path.join(options.skillRoot, SKILL_OWNER_MARKER);
  await atomicReplaceFile({
    path: markerPath,
    allowedRoot: options.allowedRoot,
    content: createSkillOwnerMarkerContent(options.identity),
  });
  return markerPath;
}

async function readMarkerAt(markerPath: string): Promise<SkillOwnerMarker | null> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Skill owner marker 不是有效 JSON：${markerPath}`);
  }
  return markerFromIdentity(parseOwnerIdentity(parsed, 'Skill owner marker'));
}

export async function readSkillOwnerMarker(options: {
  skillRoot: string;
  allowedRoot: string;
  expectedIdentity?: OwnerIdentity;
}): Promise<SkillOwnerMarker | null> {
  if (options.expectedIdentity) {
    await assertOwnedSkillPath({
      skillRoot: options.skillRoot,
      allowedRoot: options.allowedRoot,
      identity: options.expectedIdentity,
    });
  } else {
    assertSafeOwnershipSegment(path.basename(options.skillRoot), 'Skill 目录名');
    await assertNoSymlinkInPath(options.allowedRoot, options.skillRoot);
  }
  const markerPath = path.join(options.skillRoot, SKILL_OWNER_MARKER);
  await assertNoSymlinkInPath(options.allowedRoot, markerPath);
  const marker = await readMarkerAt(markerPath);
  if (!marker) return null;
  if (marker.artifactKey !== path.basename(options.skillRoot)) {
    throw new Error('Skill owner marker artifactKey 与目录名不一致。');
  }
  if (options.expectedIdentity?.sourceId !== undefined && marker.schemaVersion === 1) {
    throw new Error('legacyStateUnsupported: schema 1 owner marker is not supported.');
  }
  if (
    options.expectedIdentity?.sourceId !== undefined
    && marker.sourceId === options.expectedIdentity.sourceId
    && marker.sourceIdentity !== options.expectedIdentity.sourceIdentity
  ) {
    throw new Error('sourceChanged: owner source identity does not match the configured source.');
  }
  if (options.expectedIdentity && !identitiesEqual(marker, options.expectedIdentity)) {
    throw new Error('Skill owner marker identity 与目标 identity 不匹配。');
  }
  return marker;
}

function ownerHeader(identity: OwnerIdentity): string {
  return `${OWNED_TEXT_HEADER_PREFIX}${JSON.stringify(markerFromIdentity(identity))}`;
}

function frontmatterHeaderIndex(content: string): number {
  if (!content.startsWith('---\n')) return 0;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error('Owner header 目标包含未闭合的 YAML frontmatter。');
  }
  return end + '\n---\n'.length;
}

export function renderOwnedTextFile(content: string, identity: OwnerIdentity): string {
  validateOwnerIdentity(identity);
  const normalized = content.replace(/\r\n/gu, '\n');
  const index = frontmatterHeaderIndex(normalized);
  return `${normalized.slice(0, index)}${ownerHeader(identity)}\n${normalized.slice(index)}`;
}

export function parseOwnedTextHeader(
  content: string,
  expectedIdentity?: OwnerIdentity,
): { identity: OwnerIdentity; content: string } | null {
  const normalized = content.replace(/\r\n/gu, '\n');
  const index = frontmatterHeaderIndex(normalized);
  const lineEnd = normalized.indexOf('\n', index);
  const headerLine = normalized.slice(index, lineEnd === -1 ? normalized.length : lineEnd);
  const occurrences = normalized.split('\n').filter((line) => line.startsWith(OWNED_TEXT_HEADER_PREFIX));
  if (!headerLine.startsWith(OWNED_TEXT_HEADER_PREFIX)) {
    if (occurrences.length > 0) throw new Error('Owner header 不在允许的位置。');
    return null;
  }
  if (occurrences.length !== 1) throw new Error('Owner header 必须且只能出现一次。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerLine.slice(OWNED_TEXT_HEADER_PREFIX.length));
  } catch {
    throw new Error('Owner header 不是有效 JSON。');
  }
  const identity = parseOwnerIdentity(parsed, 'Owner header');
  if (expectedIdentity?.sourceId !== undefined && identity.sourceId === undefined) {
    throw new Error('legacyStateUnsupported: schema 1 owner header is not supported.');
  }
  if (
    expectedIdentity?.sourceId !== undefined
    && identity.sourceId === expectedIdentity.sourceId
    && identity.sourceIdentity !== expectedIdentity.sourceIdentity
  ) {
    throw new Error('sourceChanged: owner source identity does not match the configured source.');
  }
  if (expectedIdentity && !identitiesEqual(identity, expectedIdentity)) {
    throw new Error('Owner header identity 与目标 identity 不匹配。');
  }
  const contentStart = lineEnd === -1 ? normalized.length : lineEnd + 1;
  return {
    identity,
    content: normalized.slice(0, index) + normalized.slice(contentStart),
  };
}

export async function writeOwnedTextFile(options: {
  path: string;
  allowedRoot: string;
  identity: OwnerIdentity;
  content: string;
}): Promise<void> {
  validateOwnerIdentity(options.identity);
  await atomicReplaceFile({
    path: options.path,
    allowedRoot: options.allowedRoot,
    content: renderOwnedTextFile(options.content, options.identity),
  });
}

async function inspectPathAt(
  component: Extract<OwnedComponent, OwnedPathComponent>,
  actualPath: string,
  canonicalPath: boolean,
): Promise<OwnedProbeResult> {
  try {
    await assertNoSymlinkInPath(component.allowedRoot, actualPath);
  } catch (error) {
    if (error instanceof OwnershipSymlinkError) return 'foreign';
    throw error;
  }
  const stats = await fs.lstat(actualPath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!stats) return 'absent';
  if (component.kind === 'skill-directory') {
    if (!stats.isDirectory()) return 'foreign';
    const markerPath = path.join(actualPath, SKILL_OWNER_MARKER);
    try {
      await assertNoSymlinkInPath(component.allowedRoot, markerPath);
    } catch (error) {
      if (error instanceof OwnershipSymlinkError) return 'foreign';
      throw error;
    }
    let marker: SkillOwnerMarker | null;
    try {
      marker = await readMarkerAt(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      return 'foreign';
    }
    if (!marker) {
      return await component.unownedIsPristine?.(actualPath) ? 'absent' : 'foreign';
    }
    if (!identitiesEqual(marker, component.identity)) return 'foreign';
    if (canonicalPath && path.basename(actualPath) !== component.identity.artifactKey) return 'foreign';
    return 'present';
  }
  if (!stats.isFile()) return 'foreign';
  let raw: string;
  try {
    raw = await fs.readFile(actualPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return 'absent';
    throw error;
  }
  try {
    return parseOwnedTextHeader(raw, component.identity) ? 'present' : 'foreign';
  } catch {
    return 'foreign';
  }
}

function componentLabel(component: OwnedComponent): string {
  if ('path' in component) return component.path;
  if (component.kind === 'native-plugin') return component.pluginId;
  return component.label;
}

function validateNativePlugin(component: Extract<OwnedComponent, { kind: 'native-plugin' }>): void {
  validateOwnerIdentity(component.identity);
  const prefix = `${component.identity.plugin}@aw`;
  if (
    component.pluginId !== prefix
    && (!component.pluginId.startsWith(`${prefix}-`)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(component.pluginId.slice(`${prefix}-`.length)))
  ) {
    throw new Error(`Native plugin identity 必须使用 ${prefix} marketplace namespace。`);
  }
}

async function inspectComponent(
  component: OwnedComponent,
  nativeProbe?: NativeOwnershipProbe,
): Promise<OwnedProbeResult> {
  validateOwnerIdentity(component.identity);
  if ('path' in component) return inspectPathAt(component, component.path, true);
  if (component.kind === 'native-plugin') {
    validateNativePlugin(component);
    if (!nativeProbe) throw new Error('Native ownership inspection 缺少 nativeProbe。');
    return nativeProbe(component);
  }
  return component.inspect();
}

export async function inspectOwnedComponents(options: {
  components: readonly OwnedComponent[];
  nativeProbe?: NativeOwnershipProbe;
  verifyHealth?: boolean;
}): Promise<OwnershipInspection> {
  const components: OwnedComponentInspection[] = [];
  const errors: OwnershipError[] = [];
  for (const component of options.components) {
    const label = componentLabel(component);
    try {
      let probe = await inspectComponent(component, options.nativeProbe);
      let healthDiagnostic: string | undefined;
      if (
        options.verifyHealth
        && probe === 'present'
        && component.kind === 'skill-directory'
        && component.validateHealth
      ) {
        try {
          await component.validateHealth();
        } catch (error) {
          probe = 'partial';
          healthDiagnostic = errorMessage(error);
        }
      }
      components.push({
        component,
        state: probe === 'foreign' ? 'partial' : probe,
        ...(probe === 'foreign'
          ? { diagnostic: `存在 foreign collision：${label}` }
          : healthDiagnostic
            ? { diagnostic: healthDiagnostic }
            : probe === 'partial'
              ? { diagnostic: `组件归属有效但内容或启用状态不完整：${label}` }
              : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      components.push({ component, state: 'error', diagnostic: message });
      errors.push({ label, message });
    }
  }
  const state: OwnershipInspectionState = errors.length > 0
    ? 'error'
    : components.length === 0 || components.every((entry) => entry.state === 'absent')
      ? 'absent'
      : components.every((entry) => entry.state === 'present')
        ? 'present'
        : 'partial';
  return { state, components, errors };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

async function cleanupPathComponent(options: {
  component: Extract<OwnedComponent, OwnedPathComponent>;
  result: CleanupResult;
  afterQuarantine?: (component: OwnedComponent, quarantinePath: string) => Promise<void>;
}): Promise<void> {
  const { component, result } = options;
  const label = componentLabel(component);
  const quarantinePath = path.join(
    path.resolve(component.allowedRoot),
    `.agent-workflows-quarantine-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await assertNoSymlinkInPath(component.allowedRoot, component.path);
    assertPathBoundary(component.allowedRoot, quarantinePath);
    await nodeFs.rename(component.path, quarantinePath);
  } catch (error) {
    result.failures.push({ label, phase: 'mutation', message: errorMessage(error) });
    pushUnique(result.residual, label);
    return;
  }

  try {
    await options.afterQuarantine?.(component, quarantinePath);
  } catch (error) {
    result.failures.push({
      label,
      phase: 'verify',
      message: errorMessage(error),
      quarantinePath,
    });
    pushUnique(result.quarantined, quarantinePath);
    pushUnique(result.residual, label);
    return;
  }

  let verified: OwnedProbeResult;
  try {
    verified = await inspectPathAt(component, quarantinePath, false);
  } catch (error) {
    result.failures.push({
      label,
      phase: 'verify',
      message: errorMessage(error),
      quarantinePath,
    });
    // Never restore automatically after verification starts. The canonical path can now belong to
    // a concurrent foreign writer; the exact quarantine path is returned for manual recovery.
    pushUnique(result.quarantined, quarantinePath);
    pushUnique(result.residual, label);
    return;
  }
  if (verified !== 'present') {
    result.failures.push({
      label,
      phase: 'verify',
      message: 'Quarantine 对象的 type/owner 与目标 identity 不匹配。',
      quarantinePath,
    });
    pushUnique(result.quarantined, quarantinePath);
    pushUnique(result.residual, label);
    return;
  }

  // A matching marker/header is deletion authorization. Content drift is intentionally out of scope.
  try {
    await fs.remove(quarantinePath);
  } catch (error) {
    result.failures.push({
      label,
      phase: 'remove',
      message: errorMessage(error),
      quarantinePath,
    });
    if (await fs.pathExists(quarantinePath)) pushUnique(result.quarantined, quarantinePath);
    pushUnique(result.residual, label);
    return;
  }

  try {
    const after = await inspectComponent(component);
    if (after === 'absent') pushUnique(result.removed, label);
    else pushUnique(result.residual, label);
  } catch (error) {
    result.failures.push({ label, phase: 'post-probe', message: errorMessage(error) });
    pushUnique(result.residual, label);
  }
}

export async function cleanupOwnedComponents(options: {
  components: readonly OwnedComponent[];
  nativeProbe?: NativeOwnershipProbe;
  nativeRemove?: NativeOwnershipRemove;
  beforeMutation?: (component: OwnedComponent) => Promise<void>;
  afterQuarantine?: (component: OwnedComponent, quarantinePath: string) => Promise<void>;
}): Promise<CleanupResult> {
  const result: CleanupResult = {
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [],
  };
  const probes = new Map<OwnedComponent, OwnedProbeResult>();

  for (const component of options.components) {
    const label = componentLabel(component);
    try {
      const probe = await inspectComponent(component, options.nativeProbe);
      probes.set(component, probe);
      if (probe === 'absent') pushUnique(result.absent, label);
      if (probe === 'foreign' || probe === 'partial') pushUnique(result.residual, label);
    } catch (error) {
      result.failures.push({ label, phase: 'probe', message: errorMessage(error) });
      pushUnique(result.residual, label);
    }
  }
  for (const component of options.components) {
    if (probes.get(component) !== 'present') continue;
    const label = componentLabel(component);
    try {
      await options.beforeMutation?.(component);
    } catch (error) {
      result.failures.push({ label, phase: 'mutation', message: errorMessage(error) });
      pushUnique(result.residual, label);
      continue;
    }

    if ('path' in component) {
      await cleanupPathComponent({
        component,
        result,
        afterQuarantine: options.afterQuarantine,
      });
      continue;
    }

    try {
      if (component.kind === 'native-plugin') {
        validateNativePlugin(component);
        if (!options.nativeRemove || !options.nativeProbe) {
          throw new Error('Native ownership cleanup 缺少 nativeProbe/nativeRemove。');
        }
        await options.nativeRemove(component);
      } else {
        await component.remove();
      }
    } catch (error) {
      result.failures.push({ label, phase: 'remove', message: errorMessage(error) });
      pushUnique(result.residual, label);
      continue;
    }

    try {
      const after = await inspectComponent(component, options.nativeProbe);
      if (after === 'absent') pushUnique(result.removed, label);
      else pushUnique(result.residual, label);
    } catch (error) {
      result.failures.push({ label, phase: 'post-probe', message: errorMessage(error) });
      pushUnique(result.residual, label);
    }
  }
  return result;
}

export async function cleanupCorruptExclusivePluginDirectory(options: {
  directory: string;
  allowedRoot: string;
  sourceId: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  rename?: (source: string, destination: string) => Promise<void>;
  remove?: (target: string) => Promise<void>;
}): Promise<CleanupResult | null> {
  const markerPath = path.join(options.directory, SKILL_OWNER_MARKER);
  let raw: Record<string, unknown> | null = null;
  try {
    const [directoryStats, markerStats] = await Promise.all([
      nodeFs.lstat(options.directory),
      nodeFs.lstat(markerPath),
    ]);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
      || !markerStats.isFile() || markerStats.isSymbolicLink()) return null;
    await assertNoSymlinkInPath(options.allowedRoot, markerPath);
    raw = await fs.readJson(markerPath) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw
    || raw.schemaVersion !== 2
    || raw.owner !== 'agent-workflows'
    || raw.sourceId !== options.sourceId
    || raw.plugin !== options.pluginName
    || raw.pluginId !== `${options.sourceId}/${options.pluginName}`
    || raw.platform !== options.platform
    || raw.scope !== options.scope) return null;
  assertSafeOwnershipSegment(path.basename(options.directory), 'Exclusive plugin directory');
  const quarantinePath = path.join(
    path.resolve(options.allowedRoot),
    `.agent-workflows-quarantine-${process.pid}-${crypto.randomUUID()}`,
  );
  assertPathBoundary(options.allowedRoot, quarantinePath);
  try {
    await (options.rename ?? nodeFs.rename)(options.directory, quarantinePath);
  } catch (error) {
    const [canonicalExists, quarantineExists] = await Promise.all([
      fs.pathExists(options.directory),
      fs.pathExists(quarantinePath),
    ]);
    if (!canonicalExists && !quarantineExists) {
      return {
        removed: [options.directory], absent: [], residual: [], quarantined: [], failures: [],
      };
    }
    return {
      removed: [], absent: [],
      residual: [quarantineExists ? quarantinePath : options.directory],
      quarantined: quarantineExists ? [quarantinePath] : [],
      failures: [{
        label: options.directory,
        phase: 'mutation',
        message: errorMessage(error),
        ...(quarantineExists ? { quarantinePath } : {}),
      }],
    };
  }
  try {
    await (options.remove ?? fs.remove)(quarantinePath);
  } catch (error) {
    if (!await fs.pathExists(quarantinePath)) {
      return {
        removed: [options.directory], absent: [], residual: [], quarantined: [], failures: [],
      };
    }
    return {
      removed: [], absent: [], residual: [quarantinePath], quarantined: [quarantinePath],
      failures: [{
        label: options.directory,
        phase: 'remove',
        message: errorMessage(error),
        quarantinePath,
      }],
    };
  }
  if (await fs.pathExists(quarantinePath)) {
    return {
      removed: [], absent: [], residual: [quarantinePath], quarantined: [quarantinePath],
      failures: [{
        label: options.directory,
        phase: 'verify',
        message: 'Exclusive plugin quarantine remained after removal.',
        quarantinePath,
      }],
    };
  }
  return {
    removed: [options.directory], absent: [], residual: [], quarantined: [], failures: [],
  };
}
