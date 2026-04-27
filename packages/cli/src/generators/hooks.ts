import type { CodexHookGroup, HookDefinition, PlatformName } from '../types.js';

export interface RenderedHooksArtifact {
  relativePath: string;
  content: Record<string, unknown>;
}

export interface CodexHookBundle {
  pluginName: string;
  hooks: HookDefinition[];
}

function compareCodexHookGroups(
  left: CodexHookGroup,
  right: CodexHookGroup,
): number {
  return (
    left.event.localeCompare(right.event) ||
    left.matcher.localeCompare(right.matcher) ||
    JSON.stringify(left.hooks).localeCompare(JSON.stringify(right.hooks))
  );
}

function renderNativeEventName(event: HookDefinition['event'], platform: PlatformName): string {
  switch (event) {
    case 'before_tool':
      return 'PreToolUse';
    case 'after_tool':
      return 'PostToolUse';
    case 'session_start':
      return 'SessionStart';
    case 'session_stop':
      return platform === 'claude' ? 'SessionEnd' : 'Stop';
    default:
      return event;
  }
}

function renderHookGroups(
  hooks: HookDefinition[],
  platform: PlatformName,
): Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>> {
  const groups: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>> = {};
  for (const hook of hooks) {
    const event = renderNativeEventName(hook.event, platform);
    groups[event] ??= [];
    groups[event].push({
      matcher: hook.matcher ?? '*',
      hooks: [{ type: 'command', command: hook.command }],
    });
  }

  for (const event of Object.keys(groups)) {
    groups[event].sort((left, right) =>
      (left.matcher ?? '').localeCompare(right.matcher ?? '') ||
      JSON.stringify(left.hooks).localeCompare(JSON.stringify(right.hooks)),
    );
  }

  return groups;
}

export function renderHooksArtifact(
  hooks: HookDefinition[],
  platform: PlatformName,
): RenderedHooksArtifact | null {
  if (hooks.length === 0) {
    return null;
  }

  if (platform === 'codex') {
    return renderCodexHooks([{ pluginName: 'aw', hooks }]);
  }

  return {
    relativePath: 'hooks/hooks.json',
    content: {
      hooks: renderHookGroups(hooks, 'claude'),
    },
  };
}

export function extractCodexHookGroups(hooks: HookDefinition[]): CodexHookGroup[] {
  return hooks
    .map((hook) => ({
      event: renderNativeEventName(hook.event, 'codex'),
      matcher: hook.matcher ?? '*',
      hooks: [{ type: 'command', command: hook.command }],
    }));
}

export function renderCodexHookGroups(
  groups: CodexHookGroup[],
): RenderedHooksArtifact | null {
  if (groups.length === 0) {
    return null;
  }

  const hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>> = {};
  for (const group of [...groups].sort(compareCodexHookGroups)) {
    hooks[group.event] ??= [];
    hooks[group.event].push({
      matcher: group.matcher,
      hooks: group.hooks,
    });
  }

  return {
    relativePath: 'hooks.json',
    content: { hooks },
  };
}

export function renderCodexHooks(
  bundles: CodexHookBundle[],
): RenderedHooksArtifact | null {
  return renderCodexHookGroups(
    bundles
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName))
    .flatMap((bundle) =>
      extractCodexHookGroups(bundle.hooks),
    ),
  );
}
