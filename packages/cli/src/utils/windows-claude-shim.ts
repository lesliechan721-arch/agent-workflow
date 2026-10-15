import {
  resolveWindowsNpmCommand,
  type WindowsNpmCommand,
} from './windows-npm-shim.js';

export type WindowsClaudeCommand = WindowsNpmCommand;

export async function resolveWindowsClaudeCommand(options: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WindowsClaudeCommand> {
  return resolveWindowsNpmCommand({
    ...options,
    packageName: '@anthropic-ai/claude-code',
    binName: 'claude',
    displayName: 'Claude',
  });
}
