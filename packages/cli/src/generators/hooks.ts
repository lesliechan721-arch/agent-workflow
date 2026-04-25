import type { CodexHookCommand, HookDefinition, PlatformName } from '../types.js';

export interface RenderedHooksArtifact {
  relativePath: string;
  content: Record<string, unknown>;
}

export interface CodexHookBundle {
  pluginName: string;
  hooks: HookDefinition[];
}

function compareCodexHookCommands(
  left: CodexHookCommand,
  right: CodexHookCommand,
): number {
  return (
    left.matcher.localeCompare(right.matcher) ||
    left.command.localeCompare(right.command) ||
    (left.description ?? '').localeCompare(right.description ?? '')
  );
}

function renderClaudeEventName(event: HookDefinition['event']): string {
  switch (event) {
    case 'before_tool':
      return 'beforeToolUse';
    case 'after_tool':
      return 'afterToolUse';
    case 'session_start':
      return 'sessionStart';
    case 'session_stop':
      return 'sessionStop';
    case 'command':
      return 'command';
    default:
      return event;
  }
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
      hooks: hooks.map((hook) => ({
        event: renderClaudeEventName(hook.event),
        matcher: hook.matcher ?? '*',
        command: hook.command,
        description: hook.description,
      })),
    },
  };
}

export function extractCodexHookCommands(hooks: HookDefinition[]): CodexHookCommand[] {
  return hooks
    .filter((hook) => hook.event === 'command')
    .map((hook) => ({
      matcher: hook.matcher ?? '*',
      command: hook.command,
      description: hook.description,
    }));
}

export function renderCodexHookCommands(
  commands: CodexHookCommand[],
): RenderedHooksArtifact | null {
  if (commands.length === 0) {
    return null;
  }

  return {
    relativePath: 'hooks.json',
    content: {
      commands: [...commands].sort(compareCodexHookCommands),
    },
  };
}

export function renderCodexHooks(
  bundles: CodexHookBundle[],
): RenderedHooksArtifact | null {
  return renderCodexHookCommands(
    bundles
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName))
    .flatMap((bundle) =>
      extractCodexHookCommands(bundle.hooks),
    ),
  );
}
