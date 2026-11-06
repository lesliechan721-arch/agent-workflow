import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { PlatformTarget, Scope } from '../types.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { atomicReplaceConfigFile } from '../utils/plugin-config.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import {
  resolveAbsoluteAwHome,
} from '../utils/state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from '../utils/test-path-fence.js';
import { describeStrongStateProblem } from './diagnostics.js';

export type AgentId = PlatformTarget;
export interface DeploymentExclusion { plugin: string; target: AgentId }
export interface DeploymentPreferences {
  schemaVersion: 2;
  kind: 'aw-deployment-preferences';
  targets: AgentId[];
  exclusions: DeploymentExclusion[];
}
export interface PreferencesLocation {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: AwHomeMutationToken;
}
export type PreferencesObservation =
  | { state: 'absent' }
  | { state: 'valid'; value: DeploymentPreferences; digest: string; rawBytes: Buffer; rawDigest: string }
  | { state: 'invalid'; code: 'deploymentPreferencesInvalid'; digest?: string; rawBytes?: Buffer; rawDigest?: string }
  | { state: 'unreadable'; code: 'deploymentPreferencesUnavailable' };
export interface PreferencesWriteResult { value: DeploymentPreferences; changed: boolean }
export interface AgentSelection {
  agents: AgentId[];
  origin: 'argument' | 'preference' | 'none';
  preferences: PreferencesObservation['state'];
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const digestBytes = (bytes: Buffer): string =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length
    || Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error(`Invalid ${label} fields.`);
  }
}

export function normalizeAgents(values: readonly string[]): AgentId[] {
  return [...new Set(values.map((value): AgentId => {
    if (isPlatformTarget(value)) return value;
    throw new Error('Invalid Agent ID.');
  }))].sort(compareText);
}

export function normalizeExclusions(value: unknown): DeploymentExclusion[] {
  if (!Array.isArray(value)) throw new Error('Invalid deployment exclusions.');
  const result = value.map((entry): DeploymentExclusion => {
    if (!isRecord(entry)) throw new Error('Invalid deployment exclusion.');
    assertKeys(entry, ['plugin', 'target'], 'deployment exclusion');
    if (typeof entry.plugin !== 'string' || typeof entry.target !== 'string') throw new Error('Invalid deployment exclusion.');
    const parsed = parsePluginId(entry.plugin);
    if (!parsed.sourceId) throw new Error('Deployment exclusion requires source/plugin.');
    return { plugin: `${parsed.sourceId}/${parsed.pluginName}`, target: normalizeAgents([entry.target])[0]! };
  });
  const keys = result.map((entry) => `${entry.plugin}\0${entry.target}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate deployment exclusion.');
  return result.sort((a, b) => compareText(`${a.plugin}\0${a.target}`, `${b.plugin}\0${b.target}`));
}

export function createEmptyPreferences(): DeploymentPreferences {
  return { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [], exclusions: [] };
}

export function parsePreferences(value: unknown, _scope?: Scope): DeploymentPreferences {
  if (!isRecord(value)) throw new Error('Invalid deployment preferences.');
  assertKeys(value, ['schemaVersion', 'kind', 'targets', 'exclusions'], 'deployment preferences');
  if (value.schemaVersion !== 2 || value.kind !== 'aw-deployment-preferences') {
    throw new Error('Invalid deployment preferences version or kind.');
  }
  if (!Array.isArray(value.targets)) throw new Error('Invalid deployment Agents.');
  return {
    schemaVersion: 2, kind: 'aw-deployment-preferences',
    targets: normalizeAgents(value.targets),
    exclusions: normalizeExclusions(value.exclusions),
  };
}

export function serializePreferences(value: DeploymentPreferences, scope: Scope): string {
  return `${JSON.stringify(parsePreferences(value, scope), null, 2)}\n`;
}

export async function resolvePreferencesPath(location: PreferencesLocation): Promise<string> {
  const awHome = resolveAbsoluteAwHome(location.env);
  return path.join(awHome, 'deployment-preferences.json');
}

function invalidPath(error: unknown): boolean {
  return error instanceof Error && /(?:symbolic link|regular (?:directory|file)|escapes its allowed root)/iu
    .test(error.message);
}

export async function observePreferences(location: PreferencesLocation): Promise<PreferencesObservation> {
  try {
    const allowedRoot = resolveAbsoluteAwHome(location.env);
    const filePath = await resolvePreferencesPath(location);
    assertTestReadablePath(filePath, 'deployment preferences', '用隔离 AW_HOME 登记可读路径。');
    await assertSafeFileMutationPath({ filePath, allowedRoot, label: 'Deployment preferences' });
    let rawBytes: Buffer;
    try {
      rawBytes = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      throw error;
    }
    const rawDigest = digestBytes(rawBytes);
    try {
      const value = parsePreferences(JSON.parse(rawBytes.toString('utf8')), location.scope);
      return { state: 'valid', value, digest: rawDigest, rawBytes, rawDigest };
    } catch {
      return { state: 'invalid', code: 'deploymentPreferencesInvalid', digest: rawDigest,
        rawBytes, rawDigest };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return invalidPath(error)
      ? { state: 'invalid', code: 'deploymentPreferencesInvalid' }
      : { state: 'unreadable', code: 'deploymentPreferencesUnavailable' };
  }
}

async function mutatePreferences(
  location: PreferencesLocation,
  update: (current: DeploymentPreferences) => DeploymentPreferences,
  allowInvalid = false,
): Promise<PreferencesWriteResult> {
  return withAwHomeMutationLock({ env: location.env, token: location.token, action: async () => {
    const observation = await observePreferences(location);
    if (observation.state === 'unreadable') {
      const diagnostic = describeStrongStateProblem({ kind: 'preferences', scope: 'user',
        state: observation.state, filePath: await resolvePreferencesPath(location) });
      throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
    }
    if (observation.state === 'invalid' && !allowInvalid) {
      const diagnostic = describeStrongStateProblem({ kind: 'preferences', scope: 'user',
        state: observation.state, filePath: await resolvePreferencesPath(location) });
      throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
    }
    const current = observation.state === 'valid' ? observation.value : createEmptyPreferences();
    const next = parsePreferences(update(current), location.scope);
    if (observation.state !== 'invalid' && JSON.stringify(next) === JSON.stringify(current)) {
      return { value: current, changed: false };
    }
    const allowedRoot = resolveAbsoluteAwHome(location.env);
    const filePath = await resolvePreferencesPath(location);
    assertTestWritablePath(filePath, 'deployment preferences', '用隔离 AW_HOME 登记可写路径。');
    await atomicReplaceConfigFile({ filePath, allowedRoot, content: serializePreferences(next, location.scope) });
    return { value: next, changed: true };
  } });
}

export function writePreferences(
  location: PreferencesLocation, value: DeploymentPreferences,
): Promise<PreferencesWriteResult> {
  return mutatePreferences(location, () => value);
}

export function setAgents(location: PreferencesLocation, agents: readonly string[]): Promise<PreferencesWriteResult> {
  const normalized = normalizeAgents(agents);
  return mutatePreferences(location, (current) => ({ ...current, targets: normalized }));
}

export function resetTargets(location: PreferencesLocation): Promise<PreferencesWriteResult> {
  return mutatePreferences(location, createEmptyPreferences, true);
}

export function selectAgents(options: {
  preferences: PreferencesObservation;
  targets?: readonly string[];
}): AgentSelection {
  const { preferences, targets } = options;
  if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
    throw new Error(`Cannot select Agents with ${preferences.state} preferences.`);
  }
  if (targets !== undefined) {
    return { agents: normalizeAgents(targets), origin: 'argument', preferences: preferences.state };
  }
  const agents = preferences.state === 'valid' ? preferences.value.targets : [];
  return { agents, origin: agents.length > 0 ? 'preference' : 'none', preferences: preferences.state };
}

export const setTargets = setAgents;

/** The caller supplies a complete joint-demand check; it runs under the same write lock. */
export async function setExclusions(location: PreferencesLocation, exclusions: readonly DeploymentExclusion[],
  validate: (draft: DeploymentPreferences) => Promise<void>): Promise<PreferencesWriteResult> {
  const normalized = normalizeExclusions(exclusions);
  return withAwHomeMutationLock({ env: location.env, token: location.token, action: async (token) => {
    const observed = await observePreferences(location);
    if (observed.state !== 'valid' && observed.state !== 'absent') throw new Error('deploymentPreferencesInvalid');
    const next = { ...(observed.state === 'valid' ? observed.value : createEmptyPreferences()), exclusions: normalized };
    await validate(next);
    return writePreferences({ ...location, token }, next);
  } });
}
