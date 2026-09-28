import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { DependencyScopeOverride, Scope } from '../types.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { atomicReplaceConfigFile } from '../utils/plugin-config.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import {
  createProjectLocationKey, resolveAbsoluteAwHome, resolveRequiredCanonicalRepoRoot,
} from '../utils/state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from '../utils/test-path-fence.js';
import { describeStrongStateProblem } from './diagnostics.js';

export type AgentId = 'codex' | 'claude-code' | 'cursor';
export interface DeploymentPreferences {
  schemaVersion: 1;
  kind: 'aw-deployment-preferences';
  agents: AgentId[];
  dependencyScopeOverrides: DependencyScopeOverride[];
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
    if (value === 'codex' || value === 'claude-code' || value === 'cursor') return value;
    throw new Error('Invalid Agent ID.');
  }))].sort(compareText);
}

export function validateDependencyScopeOverrides(
  value: unknown, scope: Scope,
): DependencyScopeOverride[] {
  if (!Array.isArray(value)) throw new Error('Invalid dependency scope overrides.');
  const overrides = value.map((entry): DependencyScopeOverride => {
    if (!isRecord(entry)) throw new Error('Invalid dependency scope override.');
    assertKeys(entry, ['pluginId', 'platform', 'scope'], 'dependency scope override');
    if (typeof entry.pluginId !== 'string') throw new Error('Invalid dependency plugin ID.');
    const parsed = parsePluginId(entry.pluginId);
    if (!parsed.sourceId) throw new Error('Invalid dependency plugin ID: source required.');
    if (entry.platform !== 'codex' && entry.platform !== 'claude') {
      throw new Error('Invalid dependency platform.');
    }
    if (entry.scope !== 'project' && entry.scope !== 'user') {
      throw new Error('Invalid dependency placement.');
    }
    if (scope === 'user' && entry.scope === 'project') {
      throw new Error('User dependency cannot use project placement.');
    }
    return {
      pluginId: `${parsed.sourceId}/${parsed.pluginName}`,
      platform: entry.platform,
      scope: entry.scope,
    };
  });
  const keys = overrides.map((item) => `${item.pluginId}\0${item.platform}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate dependency placement.');
  return overrides.sort((a, b) => compareText(`${a.pluginId}\0${a.platform}`, `${b.pluginId}\0${b.platform}`));
}

export function createEmptyPreferences(): DeploymentPreferences {
  return { schemaVersion: 1, kind: 'aw-deployment-preferences', agents: [], dependencyScopeOverrides: [] };
}

export function parsePreferences(value: unknown, scope: Scope): DeploymentPreferences {
  if (!isRecord(value)) throw new Error('Invalid deployment preferences.');
  assertKeys(value, ['schemaVersion', 'kind', 'agents', 'dependencyScopeOverrides'], 'deployment preferences');
  if (value.schemaVersion !== 1 || value.kind !== 'aw-deployment-preferences') {
    throw new Error('Invalid deployment preferences version or kind.');
  }
  if (!Array.isArray(value.agents)) throw new Error('Invalid deployment Agents.');
  return {
    schemaVersion: 1, kind: 'aw-deployment-preferences',
    agents: normalizeAgents(value.agents),
    dependencyScopeOverrides: validateDependencyScopeOverrides(value.dependencyScopeOverrides, scope),
  };
}

export function serializePreferences(value: DeploymentPreferences, scope: Scope): string {
  return `${JSON.stringify(parsePreferences(value, scope), null, 2)}\n`;
}

export async function resolvePreferencesPath(location: PreferencesLocation): Promise<string> {
  const awHome = resolveAbsoluteAwHome(location.env);
  if (location.scope === 'user') return path.join(awHome, 'deployment-preferences.json');
  const key = await resolveRequiredCanonicalRepoRoot(location.cwd);
  return path.join(awHome, 'project-preferences', `${createProjectLocationKey(key)}.json`);
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
      const diagnostic = describeStrongStateProblem({ kind: 'preferences', scope: location.scope,
        state: observation.state, filePath: await resolvePreferencesPath(location) });
      throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
    }
    if (observation.state === 'invalid' && !allowInvalid) {
      const diagnostic = describeStrongStateProblem({ kind: 'preferences', scope: location.scope,
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
  return mutatePreferences(location, (current) => ({ ...current, agents: normalized }));
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
  const agents = preferences.state === 'valid' ? preferences.value.agents : [];
  return { agents, origin: agents.length > 0 ? 'preference' : 'none', preferences: preferences.state };
}
