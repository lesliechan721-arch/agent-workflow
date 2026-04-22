import type { HookDefinition, PlatformName } from '../types.js';

export interface RenderedHooksArtifact {
  relativePath: string;
  content: Record<string, unknown>;
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
    const commands = hooks
      .filter((hook) => hook.event === 'command')
      .map((hook) => ({
        matcher: hook.matcher ?? '*',
        command: hook.command,
        description: hook.description,
      }));

    if (commands.length === 0) {
      return null;
    }

    return {
      relativePath: 'hooks.json',
      content: { commands },
    };
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
