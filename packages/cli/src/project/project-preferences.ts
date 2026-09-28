import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { DependencyScopeOverride } from '../types.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { atomicReplaceConfigFile } from '../utils/plugin-config.js';
import { canonicalizePluginIntentState } from '../utils/plugin-intent-state.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import {
  createProjectLocationKey,
  resolveAwHome,
  resolveCanonicalRepoProjectKey,
} from '../utils/state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from '../utils/test-path-fence.js';

export type ProjectAgentId = 'codex' | 'claude-code' | 'cursor';

export interface ProjectPreferencesV1 {
  schemaVersion: 1;
  kind: 'aw-project-preferences';
  agents: ProjectAgentId[];
  dependencyScopeOverrides: DependencyScopeOverride[];
}

export interface ProjectPreferencesLocation {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type ProjectPreferencesObservation =
  | { state: 'absent' }
  | { state: 'valid'; value: ProjectPreferencesV1; digest: string; rawDigest: string }
  | { state: 'invalid'; code: 'projectPreferencesInvalid'; digest?: string; rawDigest?: string }
  | { state: 'unreadable'; code: 'projectPreferencesUnavailable' };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length
    || Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error(`Invalid ${label} fields.`);
  }
}

function parseAgent(value: unknown, allowAlias: boolean): ProjectAgentId {
  if (allowAlias && value === 'claude') return 'claude-code';
  if (value === 'codex' || value === 'claude-code' || value === 'cursor') return value;
  throw new Error('Invalid project Agent ID.');
}

export function normalizeProjectAgents(values: readonly string[], allowAlias = false): ProjectAgentId[] {
  return [...new Set(values.map((value) => parseAgent(value, allowAlias)))].sort(compareText);
}

export function createEmptyProjectPreferences(): ProjectPreferencesV1 {
  return {
    schemaVersion: 1,
    kind: 'aw-project-preferences',
    agents: [],
    dependencyScopeOverrides: [],
  };
}

export function parseProjectPreferences(value: unknown): ProjectPreferencesV1 {
  if (!isRecord(value)) throw new Error('Invalid project preferences.');
  assertKeys(value, ['schemaVersion', 'kind', 'agents', 'dependencyScopeOverrides'], 'project preferences');
  if (value.schemaVersion !== 1 || value.kind !== 'aw-project-preferences') {
    throw new Error('Invalid project preferences version or kind.');
  }
  if (!Array.isArray(value.agents)) throw new Error('Invalid project agents.');
  const agents = normalizeProjectAgents(value.agents);
  if (!Array.isArray(value.dependencyScopeOverrides)) {
    throw new Error('Invalid project dependency scope overrides.');
  }
  const overrides = value.dependencyScopeOverrides.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid project dependency scope override.');
    assertKeys(entry, ['pluginId', 'platform', 'scope'], 'project dependency scope override');
    return entry as unknown as DependencyScopeOverride;
  });
  const dependencyScopeOverrides = canonicalizePluginIntentState({
    schemaVersion: 2,
    kind: 'aw-plugin-intents',
    roots: [],
    dependencyScopeOverrides: overrides,
  }).dependencyScopeOverrides;
  return {
    schemaVersion: 1,
    kind: 'aw-project-preferences',
    agents,
    dependencyScopeOverrides,
  };
}

export function serializeProjectPreferences(value: ProjectPreferencesV1): string {
  return `${JSON.stringify(parseProjectPreferences(value), null, 2)}\n`;
}

export async function resolveProjectPreferencesPath(location: ProjectPreferencesLocation): Promise<string> {
  const projectKey = await resolveCanonicalRepoProjectKey(location.cwd);
  return path.join(
    resolveAwHome(location.env),
    'project-preferences',
    `${createProjectLocationKey(projectKey)}.json`,
  );
}

function invalidPath(error: unknown): boolean {
  return error instanceof Error && /(?:symbolic link|regular (?:directory|file)|escapes its allowed root)/iu
    .test(error.message);
}

export async function observeProjectPreferences(
  location: ProjectPreferencesLocation,
): Promise<ProjectPreferencesObservation> {
  try {
    const allowedRoot = resolveAwHome(location.env);
    const filePath = await resolveProjectPreferencesPath(location);
    assertTestReadablePath(filePath, 'project preferences', '用隔离 AW_HOME 登记可读路径。');
    await assertSafeFileMutationPath({ filePath, allowedRoot, label: 'Project preferences' });
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      throw error;
    }
    const rawDigest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    try {
      return {
        state: 'valid', value: parseProjectPreferences(JSON.parse(bytes.toString('utf8'))),
        digest: rawDigest, rawDigest,
      };
    } catch {
      return { state: 'invalid', code: 'projectPreferencesInvalid', digest: rawDigest, rawDigest };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return invalidPath(error)
      ? { state: 'invalid', code: 'projectPreferencesInvalid' }
      : { state: 'unreadable', code: 'projectPreferencesUnavailable' };
  }
}

export interface ProjectPreferencesWriteResult {
  value: ProjectPreferencesV1;
  changed: boolean;
}

async function mutateProjectPreferences(
  location: ProjectPreferencesLocation & { token?: AwHomeMutationToken },
  update: (current: ProjectPreferencesV1) => ProjectPreferencesV1,
  allowInvalid = false,
): Promise<ProjectPreferencesWriteResult> {
  return withAwHomeMutationLock({ env: location.env, token: location.token, action: async () => {
    const observation = await observeProjectPreferences(location);
    if (observation.state !== 'absent' && observation.state !== 'valid' && !allowInvalid) {
      throw new Error(`Cannot edit project preferences in ${observation.state} state.`);
    }
    if (observation.state === 'unreadable') {
      throw new Error('Cannot edit unreadable project preferences.');
    }
    const current = observation.state === 'valid' ? observation.value : createEmptyProjectPreferences();
    const next = parseProjectPreferences(update(current));
    if (observation.state === 'valid' && JSON.stringify(current) === JSON.stringify(next)) {
      return { value: current, changed: false };
    }
    if (observation.state === 'absent' && JSON.stringify(next) === JSON.stringify(current)) {
      return { value: current, changed: false };
    }
    const allowedRoot = resolveAwHome(location.env);
    const filePath = await resolveProjectPreferencesPath(location);
    assertTestWritablePath(filePath, 'project preferences', '用隔离 AW_HOME 登记可写路径。');
    await atomicReplaceConfigFile({
      filePath, allowedRoot, content: serializeProjectPreferences(next),
    });
    return { value: next, changed: true };
  } });
}

export function writeProjectPreferences(
  location: ProjectPreferencesLocation & { token?: AwHomeMutationToken },
  value: ProjectPreferencesV1,
): Promise<ProjectPreferencesWriteResult> {
  return mutateProjectPreferences(location, () => value);
}

export function setProjectAgents(
  location: ProjectPreferencesLocation & { token?: AwHomeMutationToken },
  agents: readonly string[],
): Promise<ProjectPreferencesWriteResult> {
  const normalized = normalizeProjectAgents(agents, true);
  return mutateProjectPreferences(location, (current) => ({ ...current, agents: normalized }));
}

export function resetProjectTargets(
  location: ProjectPreferencesLocation & { token?: AwHomeMutationToken },
): Promise<ProjectPreferencesWriteResult> {
  return mutateProjectPreferences(location, () => createEmptyProjectPreferences(), true);
}

export interface ProjectAgentSelection {
  agents: ProjectAgentId[];
  origin: 'argument' | 'preference' | 'none';
  preferences: ProjectPreferencesObservation['state'];
}

export function selectProjectAgents(options: {
  preferences: ProjectPreferencesObservation;
  target?: string;
  targets?: readonly string[];
  platform?: string;
}): ProjectAgentSelection {
  const explicitCount = Number(options.target !== undefined)
    + Number(options.targets !== undefined)
    + Number(options.platform !== undefined);
  if (explicitCount > 1) {
    throw new Error('--target and -p are mutually exclusive.');
  }
  if (options.preferences.state === 'invalid' || options.preferences.state === 'unreadable') {
    throw new Error(`Cannot select project Agents with ${options.preferences.state} preferences.`);
  }
  if (options.platform !== undefined && options.platform !== 'codex'
    && options.platform !== 'claude') {
    throw new Error('Invalid -p project platform alias.');
  }
  if (explicitCount > 0) {
    const agents = normalizeProjectAgents(
      options.targets ?? [options.target ?? options.platform as string],
      true,
    );
    return { agents, origin: 'argument', preferences: options.preferences.state };
  }
  const agents = options.preferences.state === 'valid' ? options.preferences.value.agents : [];
  return {
    agents,
    origin: agents.length > 0 ? 'preference' : 'none',
    preferences: options.preferences.state,
  };
}
