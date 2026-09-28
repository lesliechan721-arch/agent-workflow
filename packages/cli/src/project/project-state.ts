import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { parsePluginId } from '../utils/multi-source-catalog.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { atomicReplaceConfigFile, resolveAwProjectRoot } from '../utils/plugin-config.js';
import {
  assertCanonicalProjectManagedRoots,
  assertProjectSharedConfigPathVisible,
  type ProjectSharedConfigVisibility,
} from '../utils/project-boundary.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { assertTestReadablePath, assertTestWritablePath } from '../utils/test-path-fence.js';

export const PROJECT_INTENT_SCHEMA_VERSION = 3;
export const PROJECT_INTENT_KIND = 'aw-plugin-intents';

export interface ProjectPluginIntentV3 {
  schemaVersion: 3;
  kind: 'aw-plugin-intents';
  sources: Record<string, { logicalIdentity: string }>;
  roots: { pluginId: string }[];
}

export interface ProjectIntentLocation {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ReadEvidence {
  rawBytes: Buffer;
  rawDigest: string;
}

export type ProjectIntentObservation =
  | { state: 'absent' }
  | ({ state: 'valid'; value: ProjectPluginIntentV3; digest: string } & ReadEvidence)
  | ({ state: 'unsupported-version'; schemaVersion: number; digest: string } & ReadEvidence)
  | ({ state: 'invalid'; code: 'pluginIntentStateInvalid'; digest?: string } & Partial<ReadEvidence>)
  | { state: 'unreadable'; code: 'pluginIntentStateUnavailable' };

function digestBytes(bytes: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

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

function canonicalPluginId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid project plugin ID.');
  const parsed = parsePluginId(value);
  if (!parsed.sourceId) throw new Error('Invalid project plugin ID: source required.');
  return `${parsed.sourceId}/${parsed.pluginName}`;
}

function canonicalSources(value: unknown): ProjectPluginIntentV3['sources'] {
  if (!isRecord(value)) throw new Error('Invalid project sources.');
  const result: ProjectPluginIntentV3['sources'] = {};
  for (const sourceId of Object.keys(value).sort(compareText)) {
    const parsed = parsePluginId(`${sourceId}/placeholder`);
    if (parsed.sourceId !== sourceId) throw new Error('Invalid project source ID.');
    const binding = value[sourceId];
    if (!isRecord(binding)) throw new Error('Invalid project source binding.');
    assertKeys(binding, ['logicalIdentity'], 'project source binding');
    if (typeof binding.logicalIdentity !== 'string'
      || binding.logicalIdentity.trim() === ''
      || binding.logicalIdentity !== binding.logicalIdentity.trim()) {
      throw new Error('Invalid project source logical identity.');
    }
    result[sourceId] = { logicalIdentity: binding.logicalIdentity };
  }
  return result;
}

export function createEmptyProjectIntent(): ProjectPluginIntentV3 {
  return { schemaVersion: 3, kind: PROJECT_INTENT_KIND, sources: {}, roots: [] };
}

export function parseProjectIntent(value: unknown): ProjectPluginIntentV3 {
  if (!isRecord(value)) throw new Error('Invalid project intent.');
  assertKeys(value, ['schemaVersion', 'kind', 'sources', 'roots'], 'project intent');
  if (value.schemaVersion !== 3 || value.kind !== PROJECT_INTENT_KIND) {
    throw new Error('Invalid project intent version or kind.');
  }
  const sources = canonicalSources(value.sources);
  if (!Array.isArray(value.roots)) throw new Error('Invalid project roots.');
  const roots = value.roots.map((root) => {
    if (!isRecord(root)) throw new Error('Invalid project root.');
    assertKeys(root, ['pluginId'], 'project root');
    return { pluginId: canonicalPluginId(root.pluginId) };
  });
  const ids = roots.map((root) => root.pluginId);
  if (new Set(ids).size !== ids.length) throw new Error('Invalid project roots: duplicate plugin ID.');
  for (const root of roots) {
    const sourceId = root.pluginId.split('/')[0];
    if (!sources[sourceId]) throw new Error('Invalid project roots: source binding missing.');
  }
  return {
    schemaVersion: 3,
    kind: PROJECT_INTENT_KIND,
    sources,
    roots: roots.sort((left, right) => compareText(left.pluginId, right.pluginId)),
  };
}

export function serializeProjectIntent(value: ProjectPluginIntentV3): string {
  return `${JSON.stringify(parseProjectIntent(value), null, 2)}\n`;
}

export function calculateProjectIntentDigest(value: ProjectPluginIntentV3): string {
  return digestBytes(JSON.stringify(parseProjectIntent(value)));
}

function pruneSources(value: ProjectPluginIntentV3): ProjectPluginIntentV3 {
  const roots = [...new Set(value.roots.map((root) => canonicalPluginId(root.pluginId)))];
  const used = new Set(roots.map((pluginId) => pluginId.split('/')[0]));
  return parseProjectIntent({
    ...value,
    sources: Object.fromEntries(
      Object.entries(value.sources).filter(([sourceId]) => used.has(sourceId)),
    ),
    roots: roots.map((pluginId) => ({ pluginId })),
  });
}

export function addProjectIntentRoot(
  value: ProjectPluginIntentV3,
  pluginId: string,
  logicalIdentity: string,
): ProjectPluginIntentV3 {
  const current = parseProjectIntent(value);
  const canonicalId = canonicalPluginId(pluginId);
  const sourceId = canonicalId.split('/')[0];
  const existing = current.sources[sourceId];
  if (existing && existing.logicalIdentity !== logicalIdentity) {
    throw new Error('sourceIdentityConflict: project source alias has another logical identity.');
  }
  if (current.roots.some((root) => root.pluginId === canonicalId)) return current;
  return parseProjectIntent({
    ...current,
    sources: { ...current.sources, [sourceId]: { logicalIdentity } },
    roots: [...current.roots, { pluginId: canonicalId }],
  });
}

export function removeProjectIntentRoot(
  value: ProjectPluginIntentV3,
  pluginId: string,
): ProjectPluginIntentV3 {
  const current = parseProjectIntent(value);
  const canonicalId = canonicalPluginId(pluginId);
  return pruneSources({
    ...current,
    roots: current.roots.filter((root) => root.pluginId !== canonicalId),
  });
}

export function resolveProjectIntentPath(location: ProjectIntentLocation): string {
  return path.join(
    resolveAwProjectRoot(location.cwd),
    '.agent-workflows',
    'plugin-intents.json',
  );
}

async function projectPath(location: ProjectIntentLocation, access: 'read' | 'write'): Promise<{
  allowedRoot: string;
  filePath: string;
}> {
  const allowedRoot = await assertCanonicalProjectManagedRoots({
    cwd: location.cwd,
    rootNames: [],
    managedPaths: ['.agent-workflows'],
  });
  const filePath = path.join(allowedRoot, '.agent-workflows', 'plugin-intents.json');
  const message = '用隔离 project 根登记可读写路径。';
  if (access === 'read') assertTestReadablePath(filePath, 'project intent', message);
  else assertTestWritablePath(filePath, 'project intent', message);
  return { allowedRoot, filePath };
}

function invalidPath(error: unknown): boolean {
  return error instanceof Error && /(?:symbolic link|regular (?:directory|file)|escapes its allowed root|符号链接|realpath 越界|必须位于 repo 内)/iu
    .test(error.message);
}

export async function observeProjectIntent(location: ProjectIntentLocation): Promise<ProjectIntentObservation> {
  let rawBytes: Buffer | undefined;
  try {
    const { allowedRoot, filePath } = await projectPath(location, 'read');
    await assertSafeFileMutationPath({ filePath, allowedRoot, label: 'Project intent' });
    try {
      rawBytes = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      throw error;
    }
    const rawDigest = digestBytes(rawBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      return { state: 'invalid', code: 'pluginIntentStateInvalid', digest: rawDigest, rawBytes, rawDigest };
    }
    if (!isRecord(parsed) || parsed.kind !== PROJECT_INTENT_KIND
      || !Number.isInteger(parsed.schemaVersion)) {
      return { state: 'invalid', code: 'pluginIntentStateInvalid', digest: rawDigest, rawBytes, rawDigest };
    }
    try {
      if (parsed.schemaVersion === 3) {
        const value = parseProjectIntent(parsed);
        return { state: 'valid', value, digest: rawDigest, rawBytes, rawDigest };
      }
      return { state: 'unsupported-version', schemaVersion: parsed.schemaVersion as number, digest: rawDigest, rawBytes, rawDigest };
    } catch {
      return { state: 'invalid', code: 'pluginIntentStateInvalid', digest: rawDigest, rawBytes, rawDigest };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return invalidPath(error)
      ? { state: 'invalid', code: 'pluginIntentStateInvalid' }
      : { state: 'unreadable', code: 'pluginIntentStateUnavailable' };
  }
}

export interface ProjectIntentWriteResult {
  state: ProjectPluginIntentV3;
  changed: boolean;
  visibility: ProjectSharedConfigVisibility;
}

async function mutateProjectIntent(
  location: ProjectIntentLocation & { token?: AwHomeMutationToken },
  update: (current: ProjectPluginIntentV3) => ProjectPluginIntentV3,
): Promise<ProjectIntentWriteResult> {
  return withAwHomeMutationLock({ env: location.env, token: location.token, action: async () => {
    const observation = await observeProjectIntent(location);
    if (observation.state !== 'absent' && observation.state !== 'valid') {
      throw new Error(`Cannot edit project intent in ${observation.state} state.`);
    }
    const current = observation.state === 'valid' ? observation.value : createEmptyProjectIntent();
    const next = pruneSources(update(current));
    if (calculateProjectIntentDigest(next) === calculateProjectIntentDigest(current)) {
      return { state: current, changed: false, visibility: { state: 'visible' } };
    }
    const { allowedRoot, filePath } = await projectPath(location, 'write');
    const visibility = await assertProjectSharedConfigPathVisible({
      cwd: location.cwd, targetPath: resolveProjectIntentPath(location),
    });
    await atomicReplaceConfigFile({ filePath, allowedRoot, content: serializeProjectIntent(next) });
    return { state: next, changed: true, visibility };
  } });
}

export function writeProjectIntent(
  location: ProjectIntentLocation & { token?: AwHomeMutationToken },
  value: ProjectPluginIntentV3,
): Promise<ProjectIntentWriteResult> {
  return mutateProjectIntent(location, () => value);
}

export function addProjectRoot(
  location: ProjectIntentLocation & { token?: AwHomeMutationToken },
  pluginId: string,
  logicalIdentity: string,
): Promise<ProjectIntentWriteResult> {
  return mutateProjectIntent(location, (current) => addProjectIntentRoot(current, pluginId, logicalIdentity));
}

export function removeProjectRoot(
  location: ProjectIntentLocation & { token?: AwHomeMutationToken },
  pluginId: string,
): Promise<ProjectIntentWriteResult> {
  return mutateProjectIntent(location, (current) => removeProjectIntentRoot(current, pluginId));
}

