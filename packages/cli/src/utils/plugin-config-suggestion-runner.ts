import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
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

export interface ConfigSuggestionsRequestV1 {
  schemaVersion: 1;
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

export interface ConfigSuggestionItemV1 {
  value: PluginConfigScalar;
  title: string;
  description?: string;
  recommended?: boolean;
  source?: 'dynamic' | 'configured' | 'merged';
}

export interface ConfigSuggestionsResponseV1 {
  schemaVersion: 1;
  status: 'ok' | 'unsupported' | 'unavailable';
  items: ConfigSuggestionItemV1[];
  message?: string;
  diagnostics?: Array<{ code: string; message: string }>;
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

export function projectConfigSuggestionsResponse(
  raw: unknown,
  sensitiveValues: readonly string[],
  isValidValue?: (value: PluginConfigScalar) => boolean,
): ConfigSuggestionsResponseV1 {
  if (!isRecord(raw) || raw.schemaVersion !== 1 ||
    (raw.status !== 'ok' && raw.status !== 'unsupported' && raw.status !== 'unavailable') ||
    !Array.isArray(raw.items) || raw.items.length > MAX_ITEMS ||
    (raw.message !== undefined && !isBoundedText(raw.message, 256)) ||
    (raw.diagnostics !== undefined && (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > MAX_DIAGNOSTICS))) {
    throw new Error('Invalid config suggestions response.');
  }

  // Redact after stripping control sequences so they cannot split a token.
  const tokens = [...new Set(sensitiveValues.flatMap((value) => [value, stripUnsafeCharacters(value)]))];
  const sanitize = (value: string): string => redactPluginScriptOutput(stripUnsafeCharacters(value), tokens);
  const items: ConfigSuggestionItemV1[] = [];
  const seen = new Set<PluginConfigScalar>();
  let hasRecommendation = false;
  const candidates = raw.status === 'ok' ? raw.items : [];
  for (const item of candidates) {
    if (!isRecord(item) || !isScalar(item.value) || seen.has(item.value) ||
      !isBoundedText(item.title, 128) ||
      (item.description !== undefined && !isBoundedText(item.description, 256)) ||
      (item.recommended !== undefined && typeof item.recommended !== 'boolean') ||
      (item.source !== undefined && item.source !== 'dynamic' && item.source !== 'configured' && item.source !== 'merged')) {
      continue;
    }
    // Sanitizing a candidate could change what the editor would save.
    if ((typeof item.value === 'string' ? sanitize(item.value) !== item.value : tokens.includes(String(item.value))) ||
      (isValidValue && !isValidValue(item.value))) continue;
    const title = boundedText(sanitize(item.title), 128);
    if (!title.trim()) continue;
    // A shared response keeps its flags until a field has filtered its candidates.
    let recommended = item.recommended;
    if (isValidValue && recommended) {
      recommended = !hasRecommendation;
      hasRecommendation = true;
    }
    items.push({
      value: item.value,
      title,
      ...(item.description === undefined ? {} : { description: boundedText(sanitize(item.description), 256) }),
      ...(recommended === undefined ? {} : { recommended }),
      ...(item.source === undefined ? {} : { source: item.source }),
    });
    seen.add(item.value);
  }

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
    schemaVersion: 1,
    status: raw.status,
    items,
    ...(raw.message === undefined ? {} : { message: boundedText(sanitize(raw.message), 256) }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function unavailable(code: string, message: string): ConfigSuggestionsResponseV1 {
  return { schemaVersion: 1, status: 'unavailable', items: [], message, diagnostics: [{ code, message }] };
}

async function resolveSuggestionCommandHost(env: NodeJS.ProcessEnv): Promise<CommandHost | undefined> {
  const cliEntry = await realpath(path.join(resolveCliPackageRoot(), 'dist', 'index.js')).catch(() => undefined);
  if (!cliEntry) return undefined;
  return { schemaVersion: 1, cliEntry, nodeExecutable: process.execPath, awHome: await resolveAwHomeCanonical(env) };
}

export async function runPluginConfigSuggestions(options: {
  request: ConfigSuggestionsRequestV1;
  entry: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  sensitiveValues?: readonly string[];
}): Promise<ConfigSuggestionsResponseV1> {
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
    return projectConfigSuggestionsResponse(JSON.parse(result.stdout), sensitiveValues);
  } catch {
    return unavailable('configSuggestionsResponseInvalid', 'The config suggestions script returned an invalid response.');
  }
}
