import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  canonicalizeIdentityValue,
  CONFIG_SUGGESTIONS_TIMEOUT_DEFAULT_MS,
  CONFIG_SUGGESTIONS_TIMEOUT_MAX_MS,
  CONFIG_SUGGESTIONS_TIMEOUT_MIN_MS,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { PlatformTarget, PluginConfigScalar, PluginConfigValue } from '../types.js';
import type { CommandHost } from './managed-command-runtime.js';
import { resolveAwHomeCanonical, resolveCliPackageRoot } from './paths.js';
import {
  assertNoSensitiveConfigValues,
  buildNodeScriptInvocation,
  defaultPluginProcessRunner,
  redactPluginScriptOutput,
} from './plugin-scripts.js';
import { readSafeOperationError } from './safe-operation-diagnostic.js';
import { readEnvironmentValue } from './state-paths.js';

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_ITEMS = 128;
const MAX_DIAGNOSTICS = 8;
const EVAL_PROCESS_MARKER = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER';
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)(?:(?!\u001b\\)[^\u0007\u009c])*(?:\u0007|\u009c|\u001b\\|$)/gu;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const DIAGNOSTIC_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u;

interface ConfigSuggestionsPluginIdentity {
  pluginId: string;
  name: string;
  version: string;
}

interface ConfigSuggestionsRequestBase {
  schemaVersion: 2;
  hint?: string;
  provider: string;
  platform?: PlatformTarget;
  profile: 'common' | PlatformTarget;
  consumer: ConfigSuggestionsPluginIdentity;
  providerPlugin: ConfigSuggestionsPluginIdentity & { rootDir: string };
  fieldPath: Array<string | number>;
  dependencyValues: Record<string, PluginConfigValue>;
  providerConfigValues: Record<string, PluginConfigValue>;
  cwd: string;
  commandHost?: CommandHost;
  deadlineAt?: number;
}

export type ConfigSuggestionsRequestV2 = ConfigSuggestionsRequestBase & (
  { kind: 'scalar' } | { kind: 'object'; targets: string[] }
);

interface SuggestionPresentation {
  title: string;
  description?: string;
  recommended?: boolean;
  source?: 'dynamic' | 'configured' | 'merged' | 'builtin';
}

export interface ScalarSuggestionItemV2 extends SuggestionPresentation {
  value: PluginConfigScalar;
}

export interface ObjectSuggestionPatch {
  set?: Record<string, PluginConfigScalar>;
  unset?: string[];
}

export interface ObjectSuggestionChildItemV2 extends ObjectSuggestionPatch, SuggestionPresentation {
  recommendedHints?: string[];
}

export interface ObjectSuggestionItemV2 extends ObjectSuggestionChildItemV2 {
  children?: { title?: string; items: ObjectSuggestionChildItemV2[] };
}

export type ConfigSuggestionItemV2 = ScalarSuggestionItemV2 | ObjectSuggestionItemV2;

export interface ConfigSuggestionsResponseV2 {
  schemaVersion: 2;
  status: 'ok' | 'not-applicable' | 'no-probe' | 'unavailable';
  items: ConfigSuggestionItemV2[];
  message?: string;
  diagnostics?: Array<{ code: string; message: string }>;
}

type ProjectionOptions = {
  kind: 'scalar' | 'object';
  hint?: string;
  mode: 'cache' | 'field';
  targets?: readonly string[];
  isValidValue?: (value: PluginConfigScalar) => boolean;
  isValidPatch?: (patch: ObjectSuggestionPatch) => boolean;
};

export function hasRecommendedHints(response: ConfigSuggestionsResponseV2): boolean {
  return response.items.some((item) => !('value' in item) && (item.recommendedHints?.length
    || item.children?.items.some((child) => child.recommendedHints?.length)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is PluginConfigScalar {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function stripUnsafeCharacters(value: string): string {
  return stripVTControlCharacters(value.replace(OSC_SEQUENCE, '')).replace(UNSAFE_CHARACTERS, '');
}

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && [...value].length <= limit;
}

function boundedText(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

export function mergeObjectSuggestionPatches(
  parent: ObjectSuggestionPatch, child: ObjectSuggestionPatch,
): ObjectSuggestionPatch {
  const set = { ...parent.set, ...child.set };
  const unset = new Set([...(parent.unset ?? []), ...(child.unset ?? [])]);
  for (const key of Object.keys(child.set ?? {})) unset.delete(key);
  for (const key of child.unset ?? []) delete set[key];
  return { set, unset: [...unset] };
}

function patchKey(patch: ObjectSuggestionPatch): string {
  return canonicalizeIdentityValue({ set: patch.set ?? {}, unset: [...(patch.unset ?? [])].sort() });
}

function constrainStaticRecommendation(items: SuggestionPresentation[]): void {
  let recommended = false;
  for (const item of items) {
    if (item.recommended) {
      item.recommended = !recommended;
      recommended = true;
    }
  }
}

export function projectConfigSuggestionsResponse(
  raw: unknown,
  sensitiveValues: readonly string[],
  options: ProjectionOptions,
): ConfigSuggestionsResponseV2 {
  if (!isRecord(raw) || raw.schemaVersion !== 2 ||
    (raw.status !== 'ok' && raw.status !== 'not-applicable' && raw.status !== 'no-probe' && raw.status !== 'unavailable') ||
    !Array.isArray(raw.items) || raw.items.length > MAX_ITEMS ||
    (raw.message !== undefined && !isBoundedText(raw.message, 256)) ||
    (raw.diagnostics !== undefined && (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > MAX_DIAGNOSTICS))) {
    throw new Error('Invalid config suggestions response.');
  }

  // Redact after stripping control sequences so they cannot split a token.
  const tokens = [...new Set(sensitiveValues.flatMap((value) => [value, stripUnsafeCharacters(value)]))];
  const sanitize = (value: string): string => redactPluginScriptOutput(stripUnsafeCharacters(value), tokens);
  // Reject a candidate instead of changing what applying it would save.
  const safeScalar = (value: unknown): value is PluginConfigScalar => isScalar(value)
    && (typeof value === 'string' ? sanitize(value) === value : !tokens.includes(String(value)));
  const presentation = (item: Record<string, unknown>): SuggestionPresentation | undefined => {
    if (!isBoundedText(item.title, 128) ||
      (item.description !== undefined && !isBoundedText(item.description, 256)) ||
      (item.recommended !== undefined && typeof item.recommended !== 'boolean') ||
      (item.source !== undefined && item.source !== 'dynamic' && item.source !== 'configured'
        && item.source !== 'merged' && item.source !== 'builtin')) return undefined;
    const title = boundedText(sanitize(item.title), 128);
    if (!title.trim()) return undefined;
    return {
      title,
      ...(item.description === undefined ? {} : { description: boundedText(sanitize(item.description), 256) }),
      ...(item.recommended === undefined ? {} : { recommended: item.recommended }),
      ...(item.source === undefined ? {} : { source: item.source }),
    };
  };
  const items: ConfigSuggestionItemV2[] = [];
  const candidates = raw.status === 'ok' ? raw.items : [];
  if (options.kind === 'scalar') {
    const seen = new Set<PluginConfigScalar>();
    for (const item of candidates) {
      if (!isRecord(item) || !safeScalar(item.value) || seen.has(item.value) ||
        (options.isValidValue && !options.isValidValue(item.value))) continue;
      const display = presentation(item);
      if (!display) continue;
      items.push({ value: item.value, ...display });
      seen.add(item.value);
    }
  } else {
    const allowedTargets = new Set(options.targets);
    const safeKey = (key: unknown): key is string => typeof key === 'string'
      && allowedTargets.has(key) && sanitize(key) === key;
    const patch = (item: Record<string, unknown>): ObjectSuggestionPatch | undefined => {
      if ((item.set !== undefined && (!isRecord(item.set)
          || Object.entries(item.set).some(([key, value]) => !safeKey(key) || !safeScalar(value))))
        || (item.unset !== undefined && (!Array.isArray(item.unset) || item.unset.some((key) => !safeKey(key))))) return undefined;
      const set = item.set as ObjectSuggestionPatch['set'];
      const unset = item.unset === undefined ? undefined : [...new Set(item.unset as string[])];
      if (unset?.some((key) => Object.hasOwn(set ?? {}, key))) return undefined;
      return { ...(set === undefined ? {} : { set }), ...(unset === undefined ? {} : { unset }) };
    };
    const validPatch = (entry: ObjectSuggestionPatch): boolean =>
      (Object.keys(entry.set ?? {}).length > 0 || (entry.unset?.length ?? 0) > 0)
      && (options.isValidPatch?.(entry) ?? true);
    // The shared cache does not bind a field schema. Only enforce tree-wide
    // uniqueness after field validation so an invalid leaf cannot claim a hint.
    const seenHints = new Set<string>();
    const cleanHints = (rawHints: unknown): string[] | undefined => {
      if (!Array.isArray(rawHints)) return undefined;
      const hints = new Set<string>();
      for (const hint of rawHints) {
        if (typeof hint !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(hint)
          || sanitize(hint) !== hint || hints.has(hint)
          || (options.mode === 'field' && seenHints.has(hint))) continue;
        hints.add(hint);
        if (options.mode === 'field') seenHints.add(hint);
        if (hints.size >= 8) break;
      }
      return hints.size ? [...hints] : undefined;
    };
    const leaf = (
      source: Record<string, unknown>, ownPatch: ObjectSuggestionPatch, display: SuggestionPresentation,
      seen: Set<string>, effective: ObjectSuggestionPatch = ownPatch,
    ): ObjectSuggestionChildItemV2 | undefined => {
      if (!validPatch(effective)) return undefined;
      const key = patchKey(effective);
      if (seen.has(key)) return undefined;
      seen.add(key);
      const hints = cleanHints(source.recommendedHints);
      return { ...display, ...ownPatch, ...(hints ? { recommendedHints: hints } : {}) };
    };
    const seen = new Set<string>();
    for (const item of candidates) {
      if (!isRecord(item)) continue;
      const ownPatch = patch(item);
      const display = presentation(item);
      if (!ownPatch || !display) continue;
      if (item.children === undefined) {
        const entry = leaf(item, ownPatch, display, seen);
        if (entry) items.push(entry);
        continue;
      }
      const children = item.children;
      if (!isRecord(children) || !Array.isArray(children.items) || children.items.length > 32
        || (children.title !== undefined && (!isBoundedText(children.title, 128) || !sanitize(children.title).trim()))) continue;
      const childItems: ObjectSuggestionChildItemV2[] = [];
      const seenChildren = new Set<string>();
      for (const child of children.items) {
        if (!isRecord(child) || child.children !== undefined) continue;
        const childPatch = patch(child);
        const childDisplay = presentation(child);
        if (!childPatch || !childDisplay) continue;
        const entry = leaf(child, childPatch, childDisplay, seenChildren, mergeObjectSuggestionPatches(ownPatch, childPatch));
        if (entry) childItems.push(entry);
      }
      if (childItems.length) items.push({ ...display, ...ownPatch, children: {
        ...(children.title === undefined ? {} : { title: boundedText(sanitize(children.title), 128) }),
        items: childItems,
      } });
    }
    if (options.mode === 'field') {
      const objectItems = items as ObjectSuggestionItemV2[];
      const leaves = objectItems.flatMap((item) => item.children?.items ?? [item]);
      if (leaves.some((entry) => entry.recommendedHints?.length)) {
        // A hint-aware provider's recommendations replace all static flags.
        const hint = options.hint ?? 'balanced';
        for (const item of objectItems) {
          delete item.recommended;
          if (item.children) {
            for (const child of item.children.items) {
              delete child.recommended;
              if (child.recommendedHints?.includes(hint)) child.recommended = item.recommended = true;
            }
          } else if (item.recommendedHints?.includes(hint)) item.recommended = true;
        }
      } else {
        constrainStaticRecommendation(items);
        for (const item of objectItems) if (item.children) constrainStaticRecommendation(item.children.items);
      }
    }
  }
  if (options.kind === 'scalar' && options.mode === 'field') constrainStaticRecommendation(items);

  const diagnostics = raw.diagnostics?.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.code !== 'string' || !isBoundedText(entry.message, 256)) {
      throw new Error('Invalid config suggestions diagnostic.');
    }
    const code = DIAGNOSTIC_CODE.test(entry.code) && sanitize(entry.code) === entry.code
      ? entry.code : 'configSuggestionsProviderDiagnostic';
    return {
      code,
      message: boundedText(sanitize(entry.message), 256),
    };
  });
  return {
    schemaVersion: 2,
    status: raw.status,
    items,
    ...(raw.message === undefined ? {} : { message: boundedText(sanitize(raw.message), 256) }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function unavailable(code: string, message: string): ConfigSuggestionsResponseV2 {
  return { schemaVersion: 2, status: 'unavailable', items: [], message, diagnostics: [{ code, message }] };
}

async function resolveSuggestionCommandHost(env: NodeJS.ProcessEnv): Promise<CommandHost | undefined> {
  const cliEntry = await realpath(path.join(resolveCliPackageRoot(), 'dist', 'index.js')).catch(() => undefined);
  if (!cliEntry) return undefined;
  return { schemaVersion: 1, cliEntry, nodeExecutable: process.execPath, awHome: await resolveAwHomeCanonical(env) };
}

export async function runPluginConfigSuggestions(options: {
  request: ConfigSuggestionsRequestV2;
  entry: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  sensitiveValues?: readonly string[];
}): Promise<ConfigSuggestionsResponseV2> {
  const { request, signal, sensitiveValues = [] } = options;
  signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? CONFIG_SUGGESTIONS_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < CONFIG_SUGGESTIONS_TIMEOUT_MIN_MS ||
    timeoutMs > CONFIG_SUGGESTIONS_TIMEOUT_MAX_MS) {
    return unavailable('configSuggestionsTimeoutInvalid', 'The config suggestions timeout is outside the supported range.');
  }

  let result: Awaited<ReturnType<typeof defaultPluginProcessRunner.run>>;
  try {
    const bundleRoot = await realpath(request.providerPlugin.rootDir);
    const segments = options.entry.replace(/^\.\//u, '').split('/');
    if (segments.some((segment) => !segment || /[\\:\0]/u.test(segment) ||
      ['.', '..', '.git', 'node_modules'].includes(segment.toLowerCase()))) {
      throw new Error('Invalid config suggestions entry path.');
    }
    const entryPath = path.join(bundleRoot, ...segments);
    if (await realpath(entryPath) !== entryPath || !(await stat(entryPath)).isFile()) {
      throw new Error('Config suggestions entry must be a regular file in the plugin bundle.');
    }
    assertNoSensitiveConfigValues([request.dependencyValues, request.providerConfigValues], sensitiveValues,
      'Config suggestions input contains a sensitive config value.');
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !/^AW_/iu.test(key)));
    const evalProcessMarker = readEnvironmentValue(options.env, EVAL_PROCESS_MARKER);
    if (evalProcessMarker !== undefined) env[EVAL_PROCESS_MARKER] = evalProcessMarker;
    const commandHost = await resolveSuggestionCommandHost(options.env);
    const invocation = buildNodeScriptInvocation({
      entryPath,
      cwd: bundleRoot,
      env,
      stdin: JSON.stringify({ ...request, commandHost, deadlineAt: Date.now() + timeoutMs }),
    });
    result = await defaultPluginProcessRunner.run(invocation, {
      timeoutMs,
      signal,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      markerFreeContainment: true,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (readSafeOperationError(error)?.code === 'pluginProcessCleanupFailed') {
      return unavailable('configSuggestionsCleanupFailed', 'Config suggestions process cleanup could not be confirmed.');
    }
    return unavailable('configSuggestionsScriptFailed', 'The config suggestions script could not run.');
  }
  signal?.throwIfAborted();
  if (result.stdoutTruncated) {
    return unavailable('configSuggestionsOutputTooLarge', 'Config suggestions output exceeds 1 MiB.');
  }
  if (result.timedOut) return unavailable('configSuggestionsTimeout', 'The config suggestions script timed out.');
  if (result.exitCode !== 0 || result.signal !== null) {
    return unavailable('configSuggestionsScriptFailed', 'The config suggestions script exited unsuccessfully.');
  }
  try {
    return projectConfigSuggestionsResponse(JSON.parse(result.stdout), sensitiveValues, {
      kind: request.kind, mode: 'cache', ...(request.kind === 'object' ? { targets: request.targets } : {}),
    });
  } catch {
    return unavailable('configSuggestionsResponseInvalid', 'The config suggestions script returned an invalid response.');
  }
}
