import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { attachSafeOperationError } from '../utils/safe-operation-diagnostic.js';

import { assertRealFileParentWithinRoot, assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import { assertTestReadablePath } from '../utils/test-path-fence.js';
import type { ReadContext, ScopeRef } from './contracts.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import { parseGrokPermissionDocument } from './grok-permission-document.js';
import { readGrokShellRule } from './grok-permissions.js';
import type { OpenCodeLayerRule } from './opencode-permissions.js';
import { permissionConflict } from './permission-sidecar.js';
export { parseGrokPermissionDocument } from './grok-permission-document.js';

const SHELL_ACTIONS = ['allow', 'ask', 'deny'] as const;
const MAX_CONFIG_BYTES = 1024 * 1024;
type GrokPermissionRule = { action: typeof SHELL_ACTIONS[number]; pattern: string };

interface GrokPermissionReview {
  rules: Array<GrokPermissionRule & { path: string }>;
  readFailures: string[];
  unverifiedProjectPath?: string;
}

export function getGrokPermissionConfigPath(ctx: ReadContext, scope: ScopeRef): string {
  const root = scope.kind === 'project' ? path.join(scope.projectRoot, '.grok') : resolvePlatformConfigRoot('grok', ctx);
  return path.join(root, 'config.toml');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function statIfExists(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function readTomlText(file: string, projectRoot?: string): Promise<string | undefined> {
  assertTestReadablePath(file, 'Grok permission review');
  const stat = await statIfExists(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('grokConfigurationUnreadable');
  if (projectRoot) await assertRealFileParentWithinRoot({ filePath: file, allowedRoot: projectRoot, label: 'Grok permission review' });
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error('grokConfigurationUnreadable');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function shellRules(source: string) {
  const document = parseGrokPermissionDocument(source);
  return [...document.permissions, ...document.compactRules].flatMap(readGrokShellRule);
}

async function projectTrust(hostConfigRoot: string, projectRoot: string): Promise<string | null> {
  const source = await readTomlText(path.join(hostConfigRoot, 'trusted_folders.toml'));
  if (source === undefined) return null;
  const folders = record(record(getStaticTOMLValue(parseTOML(source)))?.folders);
  const canonical = await fs.realpath(projectRoot);
  const decision = folders && Object.hasOwn(folders, canonical) ? record(folders[canonical]) : undefined;
  return decision?.trusted === true && Number.isSafeInteger(decision.decided_at) ? JSON.stringify([canonical, decision.decided_at]) : null;
}

export async function grokProjectPermissionsAuthorized(ctx: ReadContext, hostConfigRoot: string, projectRoot: string): Promise<boolean> {
  ctx.signal?.throwIfAborted();
  try {
    const expected = await canonicalizePathThroughExistingAncestor(resolvePlatformConfigRoot('grok', ctx));
    return path.isAbsolute(hostConfigRoot) && expected === await canonicalizePathThroughExistingAncestor(hostConfigRoot)
      && await projectTrust(expected, projectRoot) !== null;
  } catch {
    return false;
  }
}

export async function assertGrokPermissionPath(ctx: ReadContext, destination: string, hostConfigRoot: string,
  projectRoot?: string): Promise<string | null> {
  ctx.signal?.throwIfAborted();
  let trust: string | null = null;
  try {
    const userRoot = await canonicalizePathThroughExistingAncestor(resolvePlatformConfigRoot('grok', ctx));
    if (!path.isAbsolute(hostConfigRoot) || userRoot !== await canonicalizePathThroughExistingAncestor(hostConfigRoot)) throw permissionConflict();
    let root = userRoot;
    if (projectRoot) {
      root = await fs.realpath(projectRoot);
      if (root !== projectRoot) throw permissionConflict();
      trust = await projectTrust(userRoot, root);
      if (!trust) {
        const code = 'grokProjectAuthorizationDenied';
        throw attachSafeOperationError(Object.assign(new Error('Grok project authorization is required to change project permissions.'), { code }),
          { code, safeMessage: 'Grok project authorization is required to change project permissions.' });
      }
    }
    const expected = path.join(root, ...(projectRoot ? ['.grok'] : []), 'config.toml');
    if (destination !== expected) throw permissionConflict();
    await assertSafeFileMutationPath({ allowedRoot: root, filePath: destination, label: 'Grok permissions' });
    await readTomlText(destination, projectRoot);
  } catch (error) {
    if ((error as { code?: string }).code === 'grokProjectAuthorizationDenied') throw error;
    throw permissionConflict();
  }
  return trust;
}

export async function readGrokPermissionLayers(ctx: ReadContext, destination: string, hostConfigRoot: string,
  projectRoot: string | undefined, document: { compactRules: unknown[] }): Promise<OpenCodeLayerRule[]> {
  const trust = await assertGrokPermissionPath(ctx, destination, hostConfigRoot, projectRoot);
  const rules: OpenCodeLayerRule[] = document.compactRules.map((rule) => ({ layer: 'higher', path: destination, rule }));
  if (trust) rules.push({ layer: 'higher', path: path.join(hostConfigRoot, 'trusted_folders.toml'), rule: { trust } });
  const sources = [path.join(hostConfigRoot, 'managed_config.toml'), ...(projectRoot ? [path.join(hostConfigRoot, 'config.toml')] : [])];
  for (const file of sources) {
    try {
      for (const rule of shellRules(await readTomlText(file) ?? '')) rules.push({ layer: 'higher', path: file, rule });
    } catch {
      rules.push({ layer: 'higher', path: file, rule: null });
    }
  }
  return rules;
}

function mayApply(pattern: string, commandPrefix: string): boolean {
  // An initial literal fragment can rule out some unrelated patterns. This is
  // a review of configured candidates, separate from Grok's runtime decision.
  const literal = pattern.trim().replace(/:\*$/u, '').split(/[*?[\\]/u, 1)[0]!;
  return commandPrefix.startsWith(literal) || literal.startsWith(commandPrefix);
}

export async function inspectGrokPermissionConfig(ctx: ReadContext, argvPrefix: readonly string[],
  projectRoot?: string): Promise<GrokPermissionReview> {
  const result: GrokPermissionReview = { rules: [], readFailures: [] };
  const commandPrefix = argvPrefix.join(' ');
  const inspect = async (file: string, allowedProjectRoot?: string) => {
    try {
      const source = allowedProjectRoot ? getGrokPermissionConfigPath(ctx, { kind: 'project', projectRoot: allowedProjectRoot }) : file;
      const rules = shellRules(await readTomlText(source, allowedProjectRoot) ?? '');
      for (const { effect: action, resource: pattern } of rules) {
        if (mayApply(pattern, commandPrefix)) result.rules.push({ path: file, action, pattern });
      }
    } catch {
      result.readFailures.push(file);
    }
  };
  ctx.signal?.throwIfAborted();
  let userFile: string | undefined;
  try {
    userFile = getGrokPermissionConfigPath(ctx, { kind: 'user' });
  } catch {
    result.readFailures.push('$GROK_HOME/config.toml');
  }
  if (userFile) await inspect(userFile);
  ctx.signal?.throwIfAborted();
  if (!projectRoot) return result;

  const projectFile = getGrokPermissionConfigPath(ctx, { kind: 'project', projectRoot });
  try {
    if (!await statIfExists(projectFile)) return result;
  } catch {
    result.readFailures.push(projectFile);
    return result;
  }
  const trustFile = userFile && path.join(path.dirname(userFile), 'trusted_folders.toml');
  let authorizedRoot: string | undefined;
  if (trustFile) {
    try {
      const exactRoot = await fs.realpath(projectRoot);
      if (await projectTrust(path.dirname(trustFile), exactRoot)) authorizedRoot = exactRoot;
    } catch {
      result.readFailures.push(trustFile);
    }
  }
  ctx.signal?.throwIfAborted();
  if (authorizedRoot) await inspect(projectFile, authorizedRoot);
  else result.unverifiedProjectPath = projectFile;
  return result;
}
