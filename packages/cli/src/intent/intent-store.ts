import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { Scope } from '../types.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { atomicReplaceConfigFile } from '../utils/plugin-config.js';
import {
  assertCanonicalProjectManagedRoots,
  assertProjectSharedConfigPathVisible,
  type ProjectSharedConfigVisibility,
} from '../utils/project-boundary.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { resolveAbsoluteAwHome, resolveRequiredCanonicalRepoRoot } from '../utils/state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from '../utils/test-path-fence.js';
import {
  addIntentRoot, calculateIntentDigest, createEmptyIntent, parseIntent,
  removeIntentRoot, serializeIntent, type PluginIntent,
} from './intent-codec.js';
import { describeStrongStateProblem } from './diagnostics.js';

export interface IntentLocation {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: AwHomeMutationToken;
}

interface ReadEvidence { rawBytes: Buffer; rawDigest: string }
export type IntentObservation =
  | { state: 'absent' }
  | ({ state: 'valid'; value: PluginIntent; digest: string } & ReadEvidence)
  | ({ state: 'unsupported-version'; schemaVersion: number; digest: string } & ReadEvidence)
  | ({ state: 'invalid'; code: 'pluginIntentStateInvalid'; digest?: string } & Partial<ReadEvidence>)
  | { state: 'unreadable'; code: 'pluginIntentStateUnavailable' };

export interface IntentWriteResult {
  value: PluginIntent;
  changed: boolean;
  visibility?: ProjectSharedConfigVisibility;
}

const digestBytes = (bytes: Buffer): string =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPath(error: unknown): boolean {
  return error instanceof Error && /(?:symbolic link|regular (?:directory|file)|escapes its allowed root|符号链接|realpath 越界|必须位于 repo 内)/iu
    .test(error.message);
}

async function intentPath(location: IntentLocation, access: 'read' | 'write'): Promise<{
  allowedRoot: string;
  filePath: string;
}> {
  const allowedRoot = location.scope === 'user'
    ? resolveAbsoluteAwHome(location.env)
    : await assertCanonicalProjectManagedRoots({
        cwd: await resolveRequiredCanonicalRepoRoot(location.cwd),
        rootNames: [], managedPaths: ['.agent-workflows'],
      });
  const filePath = location.scope === 'user'
    ? path.join(allowedRoot, 'plugin-intents.json')
    : path.join(allowedRoot, '.agent-workflows', 'plugin-intents.json');
  const message = '用隔离 AW_HOME 或 project 根登记可读写路径。';
  if (access === 'read') assertTestReadablePath(filePath, 'plugin intent', message);
  else assertTestWritablePath(filePath, 'plugin intent', message);
  return { allowedRoot, filePath };
}

export async function resolveIntentPath(location: IntentLocation): Promise<string> {
  if (location.scope === 'user') return path.join(resolveAbsoluteAwHome(location.env), 'plugin-intents.json');
  return path.join(await resolveRequiredCanonicalRepoRoot(location.cwd), '.agent-workflows', 'plugin-intents.json');
}

export async function observeIntent(location: IntentLocation): Promise<IntentObservation> {
  try {
    const { allowedRoot, filePath } = await intentPath(location, 'read');
    await assertSafeFileMutationPath({ filePath, allowedRoot, label: 'Plugin intent' });
    let rawBytes: Buffer;
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
    if (!isRecord(parsed) || parsed.kind !== 'aw-plugin-intents'
      || !Number.isInteger(parsed.schemaVersion)) {
      return { state: 'invalid', code: 'pluginIntentStateInvalid', digest: rawDigest, rawBytes, rawDigest };
    }
    if (parsed.schemaVersion !== 3) {
      return { state: 'unsupported-version', schemaVersion: parsed.schemaVersion as number,
        digest: rawDigest, rawBytes, rawDigest };
    }
    try {
      return { state: 'valid', value: parseIntent(parsed), digest: rawDigest, rawBytes, rawDigest };
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

async function mutateIntent(
  location: IntentLocation,
  update: (current: PluginIntent) => PluginIntent,
): Promise<IntentWriteResult> {
  return withAwHomeMutationLock({ env: location.env, token: location.token, action: async () => {
    const observation = await observeIntent(location);
    if (observation.state !== 'absent' && observation.state !== 'valid') {
      const diagnostic = describeStrongStateProblem({
        kind: 'intent', scope: location.scope, state: observation.state,
        filePath: await resolveIntentPath(location),
      });
      throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
    }
    const current = observation.state === 'valid' ? observation.value : createEmptyIntent();
    const next = parseIntent(update(current));
    if (calculateIntentDigest(next) === calculateIntentDigest(current)) {
      return { value: current, changed: false };
    }
    const { allowedRoot, filePath } = await intentPath(location, 'write');
    const visibility = location.scope === 'project'
      ? await assertProjectSharedConfigPathVisible({ cwd: allowedRoot, targetPath: filePath, env: location.env })
      : undefined;
    await atomicReplaceConfigFile({ filePath, allowedRoot, content: serializeIntent(next) });
    return { value: next, changed: true, ...(visibility ? { visibility } : {}) };
  } });
}

export function writeIntent(location: IntentLocation, value: PluginIntent): Promise<IntentWriteResult> {
  return mutateIntent(location, () => value);
}

export function addRoot(
  location: IntentLocation, pluginId: string, logicalIdentity: string,
): Promise<IntentWriteResult> {
  return mutateIntent(location, (current) => addIntentRoot(current, pluginId, logicalIdentity));
}

export function removeRoot(location: IntentLocation, pluginId: string): Promise<IntentWriteResult> {
  return mutateIntent(location, (current) => removeIntentRoot(current, pluginId));
}
