import type {
  CodexSharedHookGroup,
  HookDefinition,
  HookEvent,
  NativeHookDefinition,
  PlatformName,
  PluginManifestSource,
  RenderedHookGroup,
  TrackedHookGroupIdentity,
} from '../types.js';
import { resolvePlatformEntries } from './platform-entries.js';

export const PUBLIC_HOOK_EVENTS = [
  'before_tool',
  'after_tool',
  'session_start',
] as const satisfies HookEvent[];

export const PUBLIC_SESSION_START_SOURCES = [
  'startup',
  'resume',
  'clear',
] as const;

export const PUBLIC_SESSION_START_DEFAULT_MATCHER = PUBLIC_SESSION_START_SOURCES.join('|');

export const PUBLIC_HOOK_EVENT_RENDER_MAP = {
  before_tool: {
    claude: 'PreToolUse',
    codex: 'PreToolUse',
  },
  after_tool: {
    claude: 'PostToolUse',
    codex: 'PostToolUse',
  },
  session_start: {
    claude: 'SessionStart',
    codex: 'SessionStart',
  },
} as const satisfies Record<HookEvent, Record<PlatformName, string>>;

// Claude allowlist source:
// - src/entrypoints/sdk/coreSchemas.ts `HOOK_EVENTS`
// - src/utils/hooks/hooksConfigManager.ts `HookEventMetadata.matcherMetadata`
// - src/utils/hooks.ts runtime `matchQuery`
// Verified against Claude Code source on 2026-04-27.
export const CLAUDE_NATIVE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const;

export const CODEX_NATIVE_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
] as const;

type NativeHookEventContract = {
  matcherAllowed: boolean;
};

export const NATIVE_HOOK_EVENT_CONTRACTS = {
  claude: {
    PreToolUse: { matcherAllowed: true },
    PostToolUse: { matcherAllowed: true },
    PostToolUseFailure: { matcherAllowed: true },
    Notification: { matcherAllowed: true },
    UserPromptSubmit: { matcherAllowed: false },
    SessionStart: { matcherAllowed: true },
    SessionEnd: { matcherAllowed: true },
    Stop: { matcherAllowed: false },
    StopFailure: { matcherAllowed: true },
    SubagentStart: { matcherAllowed: true },
    SubagentStop: { matcherAllowed: true },
    PreCompact: { matcherAllowed: true },
    PostCompact: { matcherAllowed: true },
    PermissionRequest: { matcherAllowed: true },
    PermissionDenied: { matcherAllowed: true },
    Setup: { matcherAllowed: true },
    TeammateIdle: { matcherAllowed: false },
    TaskCreated: { matcherAllowed: false },
    TaskCompleted: { matcherAllowed: false },
    Elicitation: { matcherAllowed: true },
    ElicitationResult: { matcherAllowed: true },
    ConfigChange: { matcherAllowed: true },
    WorktreeCreate: { matcherAllowed: false },
    WorktreeRemove: { matcherAllowed: false },
    InstructionsLoaded: { matcherAllowed: true },
    CwdChanged: { matcherAllowed: false },
    // Claude runtime uses basename(file_path) as matchQuery for FileChanged.
    FileChanged: { matcherAllowed: true },
  },
  codex: {
    PreToolUse: { matcherAllowed: true },
    PermissionRequest: { matcherAllowed: true },
    PostToolUse: { matcherAllowed: true },
    SessionStart: { matcherAllowed: true },
    UserPromptSubmit: { matcherAllowed: false },
    Stop: { matcherAllowed: false },
  },
} as const satisfies Record<PlatformName, Record<string, NativeHookEventContract>>;

const PUBLIC_HOOK_EVENT_SET = new Set<string>(PUBLIC_HOOK_EVENTS);
const PUBLIC_SESSION_START_SOURCE_SET = new Set<string>(PUBLIC_SESSION_START_SOURCES);
const NATIVE_HOOK_EVENT_SETS = {
  claude: new Set<string>(CLAUDE_NATIVE_HOOK_EVENTS),
  codex: new Set<string>(CODEX_NATIVE_HOOK_EVENTS),
} as const;

export interface ResolvedPublicHookDefinition {
  kind: 'public';
  event: HookEvent;
  matcher?: string;
  command: string;
}

export interface ResolvedNativeHookDefinition {
  kind: 'native';
  event: string;
  matcher?: string;
  command: string;
}

export type ResolvedPlatformHookDefinition =
  | ResolvedPublicHookDefinition
  | ResolvedNativeHookDefinition;

export interface ParsedCodexSharedHookGroup {
  rawGroup: CodexSharedHookGroup;
  managedIdentity?: TrackedHookGroupIdentity;
}

export interface ParsedCodexSharedHooksFile {
  groups: ParsedCodexSharedHookGroup[];
  rawGroups: CodexSharedHookGroup[];
  managedIdentities: TrackedHookGroupIdentity[];
  opaqueRawGroups: CodexSharedHookGroup[];
}

export interface PlannedCodexSharedHooksUpdate {
  rerenderedAwRawGroups: CodexSharedHookGroup[];
  preservedHistoricalAwRawGroups: CodexSharedHookGroup[];
  preservedForeignRawGroups: CodexSharedHookGroup[];
}

type TrackedHookGroupIdentityCounts = Map<string, number>;

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
}

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function getNativeHookEventContract(
  event: string,
  platform: PlatformName,
  fieldName: string,
): NativeHookEventContract {
  const contracts = NATIVE_HOOK_EVENT_CONTRACTS[platform] as Record<string, NativeHookEventContract>;
  const contract = contracts[event];
  if (!contract) {
    throw new Error(`Invalid ${fieldName}: unsupported ${platform} hook event "${event}".`);
  }

  return contract;
}

function normalizePublicSessionStartMatcher(
  matcher: string,
  fieldName: string,
): string {
  const parts = matcher.split('|');
  if (parts.length === 0) {
    throw new Error(
      `Invalid ${fieldName}: expected startup/resume/clear sources joined by "|".`,
    );
  }

  const selected = new Set<string>();
  for (const part of parts) {
    if (!PUBLIC_SESSION_START_SOURCE_SET.has(part)) {
      throw new Error(
        `Invalid ${fieldName}: public session_start only allows startup, resume, clear, or their "|" union.`,
      );
    }
    selected.add(part);
  }

  return PUBLIC_SESSION_START_SOURCES.filter((part) => selected.has(part)).join('|');
}

function normalizeCodexSharedMatcherValue(
  matcher: string | null | undefined,
  matcherAllowed: boolean,
): string | undefined {
  if (!matcherAllowed) {
    return undefined;
  }

  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') {
    return undefined;
  }

  return matcher;
}

function normalizeStrictMatcherValue(
  matcher: string | undefined,
  matcherAllowed: boolean,
): string | undefined {
  if (!matcherAllowed) {
    return undefined;
  }

  if (matcher === undefined || matcher === '*') {
    return undefined;
  }

  return matcher;
}

function createTrackedHookGroupIdentityCounts(
  identities: TrackedHookGroupIdentity[],
): TrackedHookGroupIdentityCounts {
  const counts: TrackedHookGroupIdentityCounts = new Map();
  for (const identity of identities) {
    const key = serializeTrackedHookGroupIdentity(identity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

export function assertPublicHookEvent(value: unknown, fieldName: string): HookEvent {
  const event = assertNonEmptyString(value, fieldName);
  if (event === 'session_stop') {
    throw new Error(
      `Invalid ${fieldName}: public event "session_stop" has been removed. Use extensions.nativeHooks.claude[].event = "Stop" or "SessionEnd", or extensions.nativeHooks.codex[].event = "Stop".`,
    );
  }
  if (!PUBLIC_HOOK_EVENT_SET.has(event)) {
    throw new Error(`Invalid ${fieldName}: unsupported hook event "${event}".`);
  }

  return event as HookEvent;
}

export function renderPublicHookEvent(
  event: HookEvent,
  platform: PlatformName,
): string {
  return PUBLIC_HOOK_EVENT_RENDER_MAP[event][platform];
}

export function assertNativeHookEvent(
  event: string,
  platform: PlatformName,
  fieldName: string,
): string {
  assertNonEmptyString(event, fieldName);
  if (!NATIVE_HOOK_EVENT_SETS[platform].has(event)) {
    throw new Error(`Invalid ${fieldName}: unsupported ${platform} hook event "${event}".`);
  }

  return event;
}

export function assertHookMatcherAllowed(
  options:
    | {
        kind: 'public';
        event: HookEvent;
        matcher: string | undefined;
        fieldName: string;
      }
    | {
        kind: 'native';
        platform: PlatformName;
        event: string;
        matcher: string | undefined;
        fieldName: string;
      },
): void {
  if (options.kind === 'public') {
    if (options.event !== 'session_start' || options.matcher === undefined) {
      return;
    }

    normalizePublicSessionStartMatcher(options.matcher, options.fieldName);
    return;
  }

  const contract = getNativeHookEventContract(
    options.event,
    options.platform,
    options.fieldName,
  );
  if (!contract.matcherAllowed && options.matcher !== undefined) {
    throw new Error(
      `Invalid ${options.fieldName}: ${options.platform} event "${options.event}" does not allow matcher.`,
    );
  }
}

export function resolvePlatformHookDefinitions(
  manifest: Pick<PluginManifestSource, 'extensions'>,
  platform: PlatformName,
): ResolvedPlatformHookDefinition[] {
  const publicHooks = resolvePlatformEntries(manifest.extensions?.hooks, platform).map((hook) => ({
    kind: 'public' as const,
    event: hook.event,
    matcher: hook.matcher,
    command: hook.command,
  }));
  const nativeHooks = (manifest.extensions?.nativeHooks?.[platform] ?? []).map((hook) => ({
    kind: 'native' as const,
    event: hook.event,
    matcher: hook.matcher,
    command: hook.command,
  }));

  return [...publicHooks, ...nativeHooks];
}

export function renderHookDefinitionGroup(
  definition: ResolvedPlatformHookDefinition,
  platform: PlatformName,
): RenderedHookGroup {
  const event = definition.kind === 'public'
    ? renderPublicHookEvent(definition.event, platform)
    : definition.event;

  let matcher: string | undefined;
  if (definition.kind === 'public' && definition.event === 'session_start') {
    matcher = definition.matcher === undefined
      ? PUBLIC_SESSION_START_DEFAULT_MATCHER
      : normalizePublicSessionStartMatcher(definition.matcher, `${platform}.SessionStart.matcher`);
  } else if (definition.matcher !== undefined) {
    matcher = definition.matcher;
  } else if (getNativeHookEventContract(event, platform, `${platform}.${event}`).matcherAllowed) {
    matcher = '*';
  }

  const rendered: RenderedHookGroup = {
    event,
    hooks: [{ type: 'command', command: definition.command }],
  };
  if (matcher !== undefined) {
    rendered.matcher = matcher;
  }

  return rendered;
}

export function normalizeRenderedHookGroupIdentity(options: {
  platform: PlatformName;
  event: string;
  matcher?: string | null;
  command: string;
  mode?: 'strict' | 'codex-shared-read';
}): TrackedHookGroupIdentity {
  const command = assertNonEmptyString(options.command, `${options.platform}.${options.event}.command`);
  const contract = getNativeHookEventContract(
    options.event,
    options.platform,
    `${options.platform}.${options.event}`,
  );

  let matcher: string | undefined;
  if (options.mode === 'codex-shared-read') {
    if (
      options.matcher !== undefined &&
      options.matcher !== null &&
      typeof options.matcher !== 'string'
    ) {
      throw new Error(
        `Invalid ${options.platform}.${options.event}.matcher: expected undefined, null, or string.`,
      );
    }
    matcher = normalizeCodexSharedMatcherValue(options.matcher, contract.matcherAllowed);
  } else {
    if (options.matcher !== undefined && options.matcher !== null && typeof options.matcher !== 'string') {
      throw new Error(
        `Invalid ${options.platform}.${options.event}.matcher: expected a string.`,
      );
    }
    if (!contract.matcherAllowed && options.matcher !== undefined) {
      throw new Error(
        `Invalid ${options.platform}.${options.event}.matcher: event "${options.event}" does not allow matcher.`,
      );
    }
    matcher = normalizeStrictMatcherValue(options.matcher ?? undefined, contract.matcherAllowed);
  }

  return matcher === undefined
    ? { event: options.event, command }
    : { event: options.event, matcher, command };
}

export function serializeTrackedHookGroupIdentity(
  identity: TrackedHookGroupIdentity,
): string {
  return JSON.stringify([
    identity.event,
    identity.matcher ?? null,
    identity.command,
  ]);
}

export function renderTrackedHookGroupIdentity(
  identity: TrackedHookGroupIdentity,
): RenderedHookGroup {
  return {
    event: identity.event,
    ...(identity.matcher === undefined ? {} : { matcher: identity.matcher }),
    hooks: [{ type: 'command', command: identity.command }],
  };
}

export function trackedHookGroupsContainAll(
  actualGroups: TrackedHookGroupIdentity[],
  expectedGroups: TrackedHookGroupIdentity[],
): boolean {
  const actualCounts = createTrackedHookGroupIdentityCounts(actualGroups);

  for (const identity of expectedGroups) {
    const key = serializeTrackedHookGroupIdentity(identity);
    const remaining = actualCounts.get(key) ?? 0;
    if (remaining === 0) {
      return false;
    }
    actualCounts.set(key, remaining - 1);
  }

  return true;
}

export function subtractTrackedHookGroupIdentities(
  groups: TrackedHookGroupIdentity[],
  removedGroups: TrackedHookGroupIdentity[],
): TrackedHookGroupIdentity[] {
  const removedCounts = createTrackedHookGroupIdentityCounts(removedGroups);

  return groups.filter((group) => {
    const key = serializeTrackedHookGroupIdentity(group);
    const remaining = removedCounts.get(key) ?? 0;
    if (remaining === 0) {
      return true;
    }

    removedCounts.set(key, remaining - 1);
    return false;
  });
}

function isMinimalManagedCodexGroup(
  groupRecord: Record<string, unknown>,
  handlers: Record<string, unknown>[],
): boolean {
  if (handlers.length !== 1) {
    return false;
  }

  const handler = handlers[0];
  const allowedGroupKeys = new Set(['matcher', 'hooks']);
  if (Object.keys(groupRecord).some((key) => !allowedGroupKeys.has(key))) {
    return false;
  }

  if (handler.type !== 'command' || typeof handler.command !== 'string' || handler.command.trim() === '') {
    return false;
  }

  const allowedHandlerKeys = new Set(['type', 'command']);
  return !Object.keys(handler).some((key) => !allowedHandlerKeys.has(key));
}

function assertCodexSharedCommandHandler(
  handler: Record<string, unknown>,
  fieldName: string,
): void {
  if (typeof handler.command !== 'string' || handler.command.trim() === '') {
    throw new Error(`Invalid ${fieldName}.command: expected a non-empty string.`);
  }

  if (
    handler.timeout !== undefined &&
    (!Number.isInteger(handler.timeout) || (handler.timeout as number) < 0)
  ) {
    throw new Error(`Invalid ${fieldName}.timeout: expected a non-negative integer.`);
  }

  if (handler.async !== undefined && typeof handler.async !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.async: expected a boolean.`);
  }

  if (
    handler.statusMessage !== undefined &&
    typeof handler.statusMessage !== 'string'
  ) {
    throw new Error(`Invalid ${fieldName}.statusMessage: expected a string.`);
  }
}

function decrementIdentityCount(
  counts: Map<string, number>,
  identity: TrackedHookGroupIdentity | undefined,
): boolean {
  if (!identity) {
    return false;
  }

  const key = serializeTrackedHookGroupIdentity(identity);
  const remaining = counts.get(key) ?? 0;
  if (remaining === 0) {
    return false;
  }

  counts.set(key, remaining - 1);
  return true;
}

export function normalizeCodexSharedHookGroupForRead(
  event: string,
  value: unknown,
  fieldName: string,
): ParsedCodexSharedHookGroup {
  assertNativeHookEvent(event, 'codex', `${fieldName}.event`);

  const groupRecord = assertObject(value, fieldName);
  if (!Array.isArray(groupRecord.hooks)) {
    throw new Error(`Invalid ${fieldName}.hooks: expected an array.`);
  }

  const matcher = Object.prototype.hasOwnProperty.call(groupRecord, 'matcher')
    ? groupRecord.matcher as string | null | undefined
    : undefined;
  if (
    matcher !== undefined &&
    matcher !== null &&
    typeof matcher !== 'string'
  ) {
    throw new Error(`Invalid ${fieldName}.matcher: expected undefined, null, or string.`);
  }

  const handlers = groupRecord.hooks.map((handler, index) =>
    assertObject(handler, `${fieldName}.hooks[${index}]`),
  );
  for (const [index, handler] of handlers.entries()) {
    const type = handler.type;
    if (type !== 'command' && type !== 'prompt' && type !== 'agent') {
      throw new Error(
        `Invalid ${fieldName}.hooks[${index}].type: expected "command", "prompt", or "agent".`,
      );
    }
    if (type === 'command') {
      assertCodexSharedCommandHandler(handler, `${fieldName}.hooks[${index}]`);
    }
  }

  const rawGroup: CodexSharedHookGroup = {
    event,
    rawGroup: groupRecord,
    hooks: handlers,
    ...(Object.prototype.hasOwnProperty.call(groupRecord, 'matcher') ? { matcher } : {}),
  };

  if (!isMinimalManagedCodexGroup(groupRecord, handlers)) {
    return { rawGroup };
  }

  return {
    rawGroup,
    managedIdentity: normalizeRenderedHookGroupIdentity({
      platform: 'codex',
      event,
      matcher,
      command: handlers[0].command as string,
      mode: 'codex-shared-read',
    }),
  };
}

export function parseCodexSharedHooksFile(
  content: unknown,
  fieldName = 'codex.hooks',
): ParsedCodexSharedHooksFile {
  const root = assertObject(content, fieldName);
  const hooks = assertObject(root.hooks, `${fieldName}.hooks`);

  const groups: ParsedCodexSharedHookGroup[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid ${fieldName}.hooks.${event}: expected an array.`);
    }

    for (const [index, entry] of entries.entries()) {
      groups.push(
        normalizeCodexSharedHookGroupForRead(
          event,
          entry,
          `${fieldName}.hooks.${event}[${index}]`,
        ),
      );
    }
  }

  return {
    groups,
    rawGroups: groups.map((group) => group.rawGroup),
    managedIdentities: groups
      .flatMap((group) => (group.managedIdentity ? [group.managedIdentity] : [])),
    opaqueRawGroups: groups
      .flatMap((group) => (group.managedIdentity ? [] : [group.rawGroup])),
  };
}

export function planCodexSharedHooksUpdate(
  parsed: ParsedCodexSharedHooksFile,
  options: {
    rerenderedIdentities: TrackedHookGroupIdentity[];
    historicalIdentities?: TrackedHookGroupIdentity[];
  },
): PlannedCodexSharedHooksUpdate {
  const rerenderedCounts = createTrackedHookGroupIdentityCounts(options.rerenderedIdentities);
  const historicalCounts = createTrackedHookGroupIdentityCounts(options.historicalIdentities ?? []);

  const rerenderedAwRawGroups: CodexSharedHookGroup[] = [];
  const preservedHistoricalAwRawGroups: CodexSharedHookGroup[] = [];
  const preservedForeignRawGroups: CodexSharedHookGroup[] = [];

  for (const group of parsed.groups) {
    if (decrementIdentityCount(rerenderedCounts, group.managedIdentity)) {
      rerenderedAwRawGroups.push(group.rawGroup);
      continue;
    }

    if (decrementIdentityCount(historicalCounts, group.managedIdentity)) {
      preservedHistoricalAwRawGroups.push(group.rawGroup);
      continue;
    }

    preservedForeignRawGroups.push(group.rawGroup);
  }

  return {
    rerenderedAwRawGroups,
    preservedHistoricalAwRawGroups,
    preservedForeignRawGroups,
  };
}

export function normalizeNativeHookDefinition(
  entry: NativeHookDefinition,
): ResolvedNativeHookDefinition {
  return {
    kind: 'native',
    event: entry.event,
    matcher: entry.matcher,
    command: entry.command,
  };
}

export function normalizePublicHookDefinition(
  entry: HookDefinition,
): ResolvedPublicHookDefinition {
  return {
    kind: 'public',
    event: entry.event,
    matcher: entry.matcher,
    command: entry.command,
  };
}
