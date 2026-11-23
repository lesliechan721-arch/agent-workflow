import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { identityDigest } from './identity.js';
import { assertSafeFileMutationPath, atomicReplaceSafeFile } from '../utils/safe-fs.js';
import { canonicalizePathThroughExistingAncestor, resolveAwHomeCanonical } from '../utils/state-paths.js';
import { parseSharedOwnerToken } from '../utils/ownership.js';
import { attachSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import type { Diagnostic, PlatformId } from './contracts.js';

export interface PermissionClaim {
  name: string;
  effect: 'allow' | 'ask' | 'deny';
  tokens: string[];
}
export type HostPermissionAdjustment = PermissionClaim & { reasonCode: string; resource: string; message: string };

export function isPermissionClaim(value: unknown): value is PermissionClaim {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Partial<PermissionClaim>;
  return typeof claim.name === 'string' && !!claim.name && ['allow', 'ask', 'deny'].includes(String(claim.effect))
    && Array.isArray(claim.tokens) && claim.tokens.length > 0 && claim.tokens.every((token) => typeof token === 'string' && token.length > 0 && !/\s/u.test(token));
}

export interface PermissionOwnership {
  version: 1;
  platform: PlatformId;
  target: string;
  owners: Record<string, PermissionClaim[]>;
  before: unknown[];
  after: unknown[];
  manualPermissions: unknown[];
  hostDigest: string | null;
  /** Rule order at the last write. Hosts can reformat settings or append unrelated rules. */
  permissionOrder?: Record<string, string[]>;
}

function digest(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}
export function permissionFileFingerprint(host: string | null, sidecar: string | null): string {
  return identityDigest([digest(host), digest(sidecar)]);
}
export type PermissionWriteReceipt = (previous: string, current: string, target?: string,
  host?: { previous: string | null; current: string | null }) => void;
const writeFailed = 'Host permissions changed, but their ownership could not be saved. Review the rules in the host file and sync again.';
const configConflict = 'The host permission configuration changed or could not be parsed. Check the configuration and retry.';
export function permissionFailureNotice(code: string | undefined, target: string, subject: Diagnostic['subject']): Diagnostic | undefined {
  const message = code === 'permissionOwnershipWriteFailed' ? writeFailed : code === 'permissionConfigurationConflict' ? configConflict : undefined;
  if (code && message) return { code, severity: 'error', subject, detail: { reasonCode: code, path: target }, message };
}
export function permissionConflict(): Error {
  const code = 'permissionConfigurationConflict';
  return attachSafeOperationError(Object.assign(new Error(configConflict), { code, mutation: 'none' }), { code, safeMessage: configConflict });
}
async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parsePermissionOwnership(raw: string, platform: PlatformId, file: string): PermissionOwnership | undefined {
  try {
    const { checksum, ...state } = JSON.parse(raw) as PermissionOwnership & { checksum: string };
    if (state.version === 1 && state.platform === platform && typeof state.target === 'string'
      && path.isAbsolute(state.target) && path.normalize(state.target) === state.target
      && path.basename(file) === digest(state.target) + '.json' && checksum === identityDigest(state)
      && typeof state.owners === 'object' && state.owners !== null && !Array.isArray(state.owners)
      && Object.entries(state.owners).every(([owner, claims]) => parseSharedOwnerToken(owner)?.platform === platform
        && Array.isArray(claims) && claims.every(isPermissionClaim))
      && Array.isArray(state.before) && Array.isArray(state.after) && Array.isArray(state.manualPermissions)
      && (state.permissionOrder === undefined || state.permissionOrder !== null && typeof state.permissionOrder === 'object'
        && !Array.isArray(state.permissionOrder) && Object.values(state.permissionOrder).every((group) =>
          Array.isArray(group) && group.every((key) => typeof key === 'string' && /^sha256:[a-f0-9]{64}$/u.test(key))))
      && (state.hostDigest === null || typeof state.hostDigest === 'string' && /^[a-f0-9]{64}$/u.test(state.hostDigest))) return state;
  } catch { /* Unknown ownership never authorizes modifying a host. */ }
  return undefined;
}

/** Inspect AW's own known deployments. No host configuration or project directory is opened. */
export async function listPermissionSidecarStates(env: NodeJS.ProcessEnv | undefined, platform: PlatformId): Promise<PermissionOwnership[]> {
  const root = await resolveAwHomeCanonical(env);
  const directory = path.join(root, 'platforms', platform, 'permission-ownership');
  try {
    if (await fs.realpath(directory) !== directory) throw permissionConflict();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const states: PermissionOwnership[] = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    await assertSafeFileMutationPath({ allowedRoot: root, filePath: file, label: 'Permission ownership' });
    const raw = await readOptional(file);
    const state = raw === null ? undefined : parsePermissionOwnership(raw, platform, file);
    if (state) states.push(state);
  }
  return states;
}

export async function readPermissionSidecar(env: NodeJS.ProcessEnv | undefined, platform: PlatformId, destination: string) {
  if (!path.isAbsolute(destination)) throw new Error('permissionConfigurationPathInvalid');
  const target = path.join(await canonicalizePathThroughExistingAncestor(path.dirname(destination)), path.basename(destination));
  const root = await resolveAwHomeCanonical(env);
  const file = path.join(root, 'platforms', platform, 'permission-ownership', digest(target) + '.json');
  const base = { file, root, target, platform };
  let raw: string | null;
  let state: PermissionOwnership | undefined;
  try {
    await assertSafeFileMutationPath({ allowedRoot: root, filePath: file, label: 'Permission ownership' });
    raw = await readOptional(file);
  } catch {
    // Cleanup can still release other owned outputs. Never follow or replace an unsafe sidecar.
    return { ...base, raw: null, state, unreadable: true };
  }
  if (raw !== null) state = parsePermissionOwnership(raw, platform, file);
  return { ...base, raw, state, unreadable: false };
}
type SidecarSnapshot = Awaited<ReturnType<typeof readPermissionSidecar>>;

export async function readPermissionHost(target: string): Promise<string | null> {
  await assertSafeFileMutationPath({ allowedRoot: path.dirname(target), filePath: target, label: 'Host permissions' });
  return readOptional(target);
}

/** Strip only copies contributed by AW. An ambiguous copy after an external edit stays in the manual section. */
export function manualPermissionEntries(snapshot: SidecarSnapshot, host: string | null, entries: unknown[], group?: PermissionGroup) {
  const state = snapshot.state;
  if (!state || !entries.length) return { entries, retainedAfterDrift: false };
  const hostChanged = state.hostDigest !== digest(host);
  if (hostChanged && !state.permissionOrder) return { entries, retainedAfterDrift: true };

  const manual: unknown[] = [];
  const originalBefore = groupPermissions(state.before, group);
  const originalAfter = groupPermissions(state.after, group);
  const current = groupPermissions(entries, group);
  for (const key of Object.keys(current)) {
    const rules = current[key]!;
    const before = originalBefore[key] ?? [];
    const after = originalAfter[key] ?? [];
    if (!before.length && !after.length) {
      manual.push(...rules);
      continue;
    }
    const keys = rules.map(identityDigest);
    let start = 0;
    let end = rules.length;
    if (hostChanged) {
      const prior = state.permissionOrder?.[key] ?? [];
      const original = new Set(prior);
      start = keys.findIndex((value) => original.has(value));
      end = start + prior.length;
      // A complete, unchanged block can survive reformatting or new unrelated
      // rules at either end. One displaced rule has no neighbour to confirm it.
      const owned = new Set([...before, ...after].map(identityDigest));
      const sharedCopy = prior.length !== keys.length && state.manualPermissions.some((value) => owned.has(identityDigest(value)));
      const intact = !sharedCopy && start >= 0 && prior.every((value, i) => keys[start + i] === value)
        && !keys.slice(end).some((value) => original.has(value))
        && (prior.length > 1 || group !== undefined && prior.length === keys.length);
      if (!intact) return { entries, retainedAfterDrift: true };
    }
    const suffix = end - after.length;
    if (start + before.length > suffix || !before.every((value, i) => keys[start + i] === identityDigest(value))
      || !after.every((value, i) => keys[suffix + i] === identityDigest(value))) {
      return { entries, retainedAfterDrift: true };
    }
    manual.push(...rules.slice(0, start), ...rules.slice(start + before.length, suffix), ...rules.slice(end));
  }
  return { entries: manual, retainedAfterDrift: false };
}

type PermissionGroup = (entry: unknown) => string;
function groupPermissions(entries: unknown[], group?: PermissionGroup): Record<string, unknown[]> {
  if (!group) return { all: entries };
  const groups: Record<string, unknown[]> = Object.create(null);
  for (const entry of entries) (groups[group(entry)] ??= []).push(entry);
  return groups;
}

export interface PermissionDocument {
  permissions: unknown[];
  /** Some hosts keep each decision in its own ordered array. */
  permissionGroup?: PermissionGroup;
  writePermissions(entries: unknown[]): string;
}

/** The caller holds the existing AW_HOME lock. A failed second write leaves only weak evidence. */
export async function commitPermissionOwnership(options: {
  snapshot: SidecarSnapshot; host: string | null; document: PermissionDocument;
  owners: PermissionOwnership['owners']; manual: unknown[]; before: unknown[]; after: unknown[];
  effective: unknown[]; verifyChain: () => Promise<void>; onWrite?: PermissionWriteReceipt;
}): Promise<boolean> {
  const { snapshot, host, document, owners, manual, before, after } = options;
  if (snapshot.unreadable) throw permissionConflict();
  const final = [...before, ...manual, ...after];
  const changed = identityDigest(groupPermissions(final, document.permissionGroup)) !== identityDigest(groupPermissions(document.permissions, document.permissionGroup));
  const nextHost = changed ? document.writePermissions(final) : host;
  const effective = new Set([...before, ...after, ...options.effective].map(identityDigest));
  const state: PermissionOwnership = { version: 1, platform: snapshot.platform, target: snapshot.target, owners,
    before, after, manualPermissions: manual.filter((rule) => effective.has(identityDigest(rule))), hostDigest: digest(nextHost),
    permissionOrder: Object.fromEntries(Object.entries(groupPermissions(final, document.permissionGroup))
      .map(([group, rules]) => [group, rules.map(identityDigest)])) };
  const next = Object.keys(owners).length ? JSON.stringify({ ...state, checksum: identityDigest(state) }, null, 2) + '\n' : null;
  const label = 'Permission ownership';
  const verify = async (expectedHost: string | null) => {
    await options.verifyChain();
    if (await readPermissionHost(snapshot.target) !== expectedHost || await readOptional(snapshot.file) !== snapshot.raw) throw permissionConflict();
  };
  await verify(host);
  if (changed) await atomicReplaceSafeFile({ filePath: snapshot.target, allowedRoot: path.dirname(snapshot.target), label: 'Host permissions',
    content: nextHost!, beforeRename: () => verify(host) });
  if (next === snapshot.raw) return changed;
  try {
    if (next !== null) await atomicReplaceSafeFile({ filePath: snapshot.file, allowedRoot: snapshot.root, content: next, label,
      beforeRename: () => verify(nextHost) });
    else if (snapshot.state) {
      await assertSafeFileMutationPath({ filePath: snapshot.file, allowedRoot: snapshot.root, label });
      await verify(nextHost);
      await fs.unlink(snapshot.file);
    }
  } catch (error) {
    if (changed) {
      const code = 'permissionOwnershipWriteFailed';
      throw attachSafeOperationError(Object.assign(new Error(writeFailed, { cause: error }), {
        code, mutation: 'confirmed', path: snapshot.target,
      }), { code, safeMessage: writeFailed });
    }
    throw error;
  }
  options.onWrite?.(permissionFileFingerprint(host, snapshot.raw), permissionFileFingerprint(nextHost, next), snapshot.target,
    { previous: digest(host), current: state.hostDigest });
  return true;
}
