import crypto from 'node:crypto';
import path from 'node:path';

import { isPortablePlatformTarget } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';

import type { Scope } from '../types.js';
import {
  validatePortableSkillDirectory, validatePortableSkillFrontmatter, validatePortableSkillName,
} from '../utils/dynamic-skill-tree.js';
import { assertSafeOwnershipSegment, SKILL_OWNER_MARKER } from '../utils/ownership.js';
import { atomicReplaceSafeFile } from '../utils/safe-fs.js';
import { ensureRegularDirectoryPath } from '../utils/state-paths.js';
import { validateRuntimeSkillClosure } from '../utils/runtime-skill-closure.js';
import { assertPortablePath, portableJsonDigest } from './historical-materialization.js';
import type { PortableAgent } from './recovery-layout.js';

export interface PortableOwnerIdentity {
  pluginId: string;
  logicalIdentity: string;
  platform: PortableAgent;
  scope: Scope;
  skill: string;
}

export interface PortableSkillOwner extends PortableOwnerIdentity {
  schemaVersion: 1;
  owner: 'agent-workflows';
  kind: 'portable-skill';
  filesDigest: string;
  configDigest: string;
}

export interface PortableSkillObservation {
  skill: string;
  physicalPath: string;
  ownership: 'aw' | 'external' | 'unknown';
  observation: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  contentState: 'current' | 'stale' | 'damaged' | 'unknown';
  installedDigest?: string;
  owner?: PortableSkillOwner;
  recoverableIdentity?: PortableOwnerIdentity;
  evidenceDigest: string;
  blocker?: string;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function parseIdentity(value: unknown): PortableOwnerIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['schemaVersion', 'owner', 'kind', 'pluginId',
    'logicalIdentity', 'platform', 'scope', 'skill', 'filesDigest', 'configDigest'].includes(key))) return undefined;
  if (row.schemaVersion !== 1 || row.owner !== 'agent-workflows' || row.kind !== 'portable-skill'
    || typeof row.pluginId !== 'string' || typeof row.logicalIdentity !== 'string'
    || !row.logicalIdentity || !isPortablePlatformTarget(row.platform)
    || (row.scope !== 'user' && row.scope !== 'project') || typeof row.skill !== 'string') return undefined;
  const parts = row.pluginId.split('/');
  if (parts.length !== 2) return undefined;
  try {
    for (const part of parts) assertSafeOwnershipSegment(part, 'Portable plugin identity');
    validatePortableSkillName(row.skill);
  } catch { return undefined; }
  return { pluginId: row.pluginId, logicalIdentity: row.logicalIdentity,
    platform: row.platform, scope: row.scope, skill: row.skill };
}

function sameIdentity(left: PortableOwnerIdentity, right: PortableOwnerIdentity): boolean {
  return left.pluginId === right.pluginId && left.logicalIdentity === right.logicalIdentity
    && left.platform === right.platform && left.scope === right.scope && left.skill === right.skill;
}

function parseOwner(value: unknown): PortableSkillOwner | undefined {
  const identity = parseIdentity(value);
  if (!identity) return undefined;
  const row = value as Record<string, unknown>;
  if (!isDigest(row.filesDigest) || !isDigest(row.configDigest)
    || Object.keys(row).some((key) => !['schemaVersion', 'owner', 'kind', 'pluginId',
      'logicalIdentity', 'platform', 'scope', 'skill', 'filesDigest', 'configDigest'].includes(key))) return undefined;
  return { schemaVersion: 1, owner: 'agent-workflows', kind: 'portable-skill', ...identity,
    filesDigest: row.filesDigest, configDigest: row.configDigest };
}

/** Includes every regular content file; the weak owner evidence is not Skill content. */
export async function portableOwnedTreeDigest(root: string): Promise<string> {
  const files: Array<[string, Buffer]> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('portableOutputConflict');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('portableOutputConflict');
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) {
        if (relative !== SKILL_OWNER_MARKER) files.push([relative, await fs.readFile(absolute)]);
      } else throw new Error('portableOutputConflict');
    }
  };
  await visit(root, '');
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** A marker only proves the bounded AW resource, never current installation health. */
export async function observePortableSkill(options: {
  destinationRoot: string;
  skill: string;
  identity?: PortableOwnerIdentity;
  expectedDigest?: string;
  configDigest?: string;
  physicalPath?: string;
}): Promise<PortableSkillObservation> {
  validatePortableSkillName(options.skill);
  const physicalPath = options.physicalPath ?? path.join(options.destinationRoot, options.skill);
  const base: PortableSkillObservation = { skill: options.skill, physicalPath, ownership: 'unknown',
    observation: 'unknown', contentState: 'unknown', evidenceDigest: '' };
  const finish = (result: Partial<PortableSkillObservation>, evidence: unknown): PortableSkillObservation => {
    const merged = { ...base, ...result };
    return { ...merged, evidenceDigest: portableJsonDigest({ physicalPath,
      installedDigest: merged.installedDigest, owner: merged.owner,
      recoverableIdentity: merged.recoverableIdentity, ownership: merged.ownership, evidence }) };
  };
  try {
    if (!path.isAbsolute(options.destinationRoot) || path.dirname(physicalPath) !== path.resolve(options.destinationRoot)) {
      return finish({ observation: 'conflict', blocker: 'portableOutputConflict' }, 'boundary');
    }
    if (!await assertPortablePath(path.parse(physicalPath).root, physicalPath)) {
      return finish({ observation: 'absent' }, 'absent');
    }
    const stat = await fs.lstat(physicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return finish({ ownership: 'external', observation: 'conflict', blocker: 'portableOutputConflict' }, 'type');
    }
    const markerPath = path.join(physicalPath, SKILL_OWNER_MARKER);
    const markerStat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!markerStat) return finish({ ownership: 'external', observation: 'conflict',
      blocker: 'portableOutputConflict' }, { dev: stat.dev, ino: stat.ino, marker: 'absent' });
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return finish({ ownership: 'external', observation: 'conflict', blocker: 'portableOutputConflict' }, 'marker-type');
    }
    const raw = await fs.readFile(markerPath, 'utf8');
    const evidence = { dev: stat.dev, ino: stat.ino, marker: portableJsonDigest(raw) };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return finish({ blocker: 'portableOwnerInvalid' }, evidence); }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.owner !== undefined && row.owner !== 'agent-workflows'
        || row.kind !== undefined && row.kind !== 'portable-skill'
        || row.schemaVersion !== undefined && row.schemaVersion !== 1) {
        return finish({ ownership: 'external', observation: 'conflict', blocker: 'portableOutputConflict' }, evidence);
      }
    }
    const identity = parseIdentity(parsed);
    if (!identity || identity.skill !== options.skill) return finish({ blocker: 'portableOwnerInvalid' }, evidence);
    if (options.identity && !sameIdentity(identity, options.identity)) {
      return finish({ ownership: 'external', observation: 'conflict', blocker: 'portableOutputConflict' }, evidence);
    }
    const owner = parseOwner(parsed);
    const installedDigest = await portableOwnedTreeDigest(physicalPath);
    if (!owner) return finish({ ownership: 'aw', observation: 'drifted', contentState: 'damaged',
      installedDigest, recoverableIdentity: identity, blocker: 'portableOwnerDamaged' }, evidence);
    const observed = { owner, recoverableIdentity: identity, installedDigest, ownership: 'aw' as const };
    if (installedDigest !== owner.filesDigest) {
      return finish({ ...observed, observation: 'drifted', contentState: 'damaged' }, evidence);
    }
    try {
      validatePortableSkillFrontmatter(await fs.readFile(path.join(physicalPath, 'SKILL.md'), 'utf8'), options.skill);
      if (!(await fs.readFile(path.join(physicalPath, 'README.md'), 'utf8')).trim()) throw new Error('missing-readme');
      await validateRuntimeSkillClosure(physicalPath);
    } catch {
      return finish({ ...observed, observation: 'drifted', contentState: 'damaged' }, evidence);
    }
    const stale = options.expectedDigest !== undefined && installedDigest !== options.expectedDigest
      || options.configDigest !== undefined && owner.configDigest !== options.configDigest;
    return finish({ ...observed, observation: stale ? 'drifted' : 'satisfied',
      contentState: stale ? 'stale' : 'current' }, evidence);
  } catch (error) {
    if (error instanceof Error && error.message === 'portableOutputConflict') {
      return finish({ observation: 'conflict', blocker: 'portableOutputConflict' }, 'unsafe-path');
    }
    return finish({ blocker: 'portableObservationFailed' }, 'unavailable');
  }
}

export async function scanPortableSkills(options: {
  destinationRoot: string;
  platform: PortableAgent;
  scope: Scope;
  signal?: AbortSignal;
}): Promise<{ targets: PortableSkillObservation[]; complete: boolean }> {
  const targets: PortableSkillObservation[] = [];
  try {
    options.signal?.throwIfAborted();
    if (!await assertPortablePath(path.parse(options.destinationRoot).root, options.destinationRoot)) {
      return { targets, complete: true };
    }
    const rootStat = await fs.lstat(options.destinationRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { targets, complete: false };
    let complete = true;
    for (const entry of await fs.readdir(options.destinationRoot, { withFileTypes: true })) {
      options.signal?.throwIfAborted();
      try { validatePortableSkillName(entry.name); } catch { continue; }
      const target = await observePortableSkill({ destinationRoot: options.destinationRoot, skill: entry.name });
      const identity = target.owner ?? target.recoverableIdentity;
      if (identity && (identity.platform !== options.platform || identity.scope !== options.scope)) continue;
      // Markerless and foreign resources are not AW inventory or adoption candidates.
      if (target.ownership === 'external') continue;
      if (target.observation === 'unknown' || target.observation === 'conflict') complete = false;
      targets.push(target);
    }
    return { targets, complete };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { targets, complete: false };
  }
}

function assertSnapshot(actual: PortableSkillObservation, expected: PortableSkillObservation): void {
  if (actual.evidenceDigest !== expected.evidenceDigest) throw new Error('operationReviewStale');
}

/** Stage and validate a complete real copy before changing the discoverable output. */
export async function publishPortableSkill(options: {
  sourceDir: string;
  destinationRoot: string;
  identity: PortableOwnerIdentity;
  expectedDigest: string;
  configDigest: string;
  observed: PortableSkillObservation;
}): Promise<void> {
  const owner: PortableSkillOwner = { schemaVersion: 1, owner: 'agent-workflows', kind: 'portable-skill',
    ...options.identity, filesDigest: options.expectedDigest, configDigest: options.configDigest };
  if (!parseOwner(owner)) throw new Error('portableOwnerInvalid');
  const target = path.join(options.destinationRoot, owner.skill);
  if (options.observed.physicalPath !== target
    || !['absent', 'satisfied', 'drifted'].includes(options.observed.observation)
    || (options.observed.observation !== 'absent' && options.observed.ownership !== 'aw')) {
    throw new Error('portableOutputConflict');
  }
  await assertPortablePath(path.parse(options.sourceDir).root, options.sourceDir);
  await validatePortableSkillDirectory(options.sourceDir);
  await validateRuntimeSkillClosure(options.sourceDir);
  if (await portableOwnedTreeDigest(options.sourceDir) !== options.expectedDigest) throw new Error('operationReviewStale');
  await ensureRegularDirectoryPath(options.destinationRoot, 'Portable destination');
  const staging = await fs.mkdtemp(path.join(path.dirname(options.destinationRoot), '.aw-portable-stage-'));
  const stagingStat = await fs.lstat(staging);
  const stagedSkill = path.join(staging, owner.skill);
  const old = path.join(staging, 'previous');
  let moved = false;
  try {
    await fs.copy(options.sourceDir, stagedSkill, { dereference: false, errorOnExist: true });
    await validatePortableSkillDirectory(stagedSkill);
    await validateRuntimeSkillClosure(stagedSkill);
    if (await portableOwnedTreeDigest(stagedSkill) !== options.expectedDigest) throw new Error('operationReviewStale');
    await atomicReplaceSafeFile({ filePath: path.join(stagedSkill, SKILL_OWNER_MARKER), allowedRoot: staging,
      content: `${JSON.stringify(owner, null, 2)}\n`, label: 'Portable owner', temporaryTag: 'owner' });
    const current = await observePortableSkill({ destinationRoot: options.destinationRoot,
      identity: options.identity, skill: owner.skill, expectedDigest: options.expectedDigest, configDigest: options.configDigest });
    assertSnapshot(current, options.observed);
    if (current.observation !== 'absent') {
      await fs.rename(target, old);
      moved = true;
      const oldStat = await fs.lstat(old);
      const oldMarker = await fs.readJson(path.join(old, SKILL_OWNER_MARKER));
      const oldIdentity = parseIdentity(oldMarker);
      if (!oldStat.isDirectory() || oldStat.isSymbolicLink() || !oldIdentity
        || !sameIdentity(oldIdentity, owner)
        || await portableOwnedTreeDigest(old) !== current.installedDigest) throw new Error('portableOutputConflict');
    }
    await assertPortablePath(path.parse(options.destinationRoot).root, options.destinationRoot);
    await fs.rename(stagedSkill, target);
    moved = false;
  } catch (error) {
    if (moved && !await fs.lstat(target).catch(() => undefined)) {
      await fs.rename(old, target).then(() => { moved = false; }).catch(() => undefined);
    }
    throw error;
  } finally {
    // This operation created staging. A failed restore retains the old weak output for manual recovery.
    if (!moved) {
      try {
        await assertPortablePath(path.parse(staging).root, staging);
        const current = await fs.lstat(staging);
        if (current.isDirectory() && !current.isSymbolicLink()
          && current.dev === stagingStat.dev && current.ino === stagingStat.ino) await fs.remove(staging);
      } catch { /* Keep weak staging when its path can no longer be verified. */ }
    }
  }
}

/** Force only tolerates damaged digest metadata with a complete matching AW identity. */
export async function removePortableSkill(options: {
  destinationRoot: string;
  identity: PortableOwnerIdentity;
  observed: PortableSkillObservation;
  force?: boolean;
}): Promise<void> {
  const current = await observePortableSkill({ destinationRoot: options.destinationRoot,
    skill: options.identity.skill, identity: options.identity });
  assertSnapshot(current, options.observed);
  if (current.observation === 'absent') return;
  if (current.ownership !== 'aw' || !current.recoverableIdentity
    || !sameIdentity(current.recoverableIdentity, options.identity)
    || (current.blocker && !(options.force && current.blocker === 'portableOwnerDamaged'))) {
    throw new Error(current.blocker ?? 'portableOutputConflict');
  }
  const quarantine = path.join(options.destinationRoot, `.aw-portable-remove-${crypto.randomUUID()}`);
  await fs.rename(current.physicalPath, quarantine);
  try {
    await assertPortablePath(path.parse(quarantine).root, quarantine);
    const marker = await fs.readJson(path.join(quarantine, SKILL_OWNER_MARKER));
    const identity = parseIdentity(marker);
    if (!identity || !sameIdentity(identity, options.identity)
      || await portableOwnedTreeDigest(quarantine) !== current.installedDigest) throw new Error('portableOutputConflict');
    await fs.remove(quarantine);
  } catch (error) {
    if (!await fs.lstat(current.physicalPath).catch(() => undefined)) {
      await fs.rename(quarantine, current.physicalPath).catch(() => undefined);
    }
    throw error;
  }
}
