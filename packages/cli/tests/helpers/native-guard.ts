import path from 'node:path';

import {
  CodexAppServerError,
  type CodexAppServerInvocation,
  type CodexAppServerProcessRunner,
  setCodexAppServerProcessRunnerOverrideForTests,
} from '../../src/utils/codex-app-server-client.js';
import {
  execFileNativeCliRunner,
  type NativeCliInvocation,
  type NativeCliRunner,
  setNativeCliRunnerOverrideForTests,
} from '../../src/utils/native-cli.js';

const DEFAULT_GUARDED_NATIVE_COMMANDS = ['codex', 'claude'] as const;
const DEFAULT_VERSION_OUTPUTS: Record<string, string> = {
  codex: 'codex-cli 0.145.0',
  claude: '2.1.88 (Claude Code)',
};

function normalizeCommandName(command: string): string {
  const baseName = path.basename(command).toLowerCase();
  return baseName.replace(/\.(cmd|exe)$/u, '');
}

function renderEnvSummary(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) {
    return '<undefined>';
  }

  const entries = [
    ['AW_HOME', env.AW_HOME],
    ['AW_CODEX_HOME', env.AW_CODEX_HOME],
    ['AW_CLAUDE_HOME', env.AW_CLAUDE_HOME],
    ['HOME', env.HOME],
    ['USERPROFILE', env.USERPROFILE],
    ['PATH', env.PATH],
  ].filter(([, value]) => typeof value === 'string' && value.trim() !== '');

  if (entries.length === 0) {
    return '<empty>';
  }

  return entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}

function renderArgs(args: string[]): string {
  return JSON.stringify(args);
}

function isGuardedNativeCliInvocation(
  invocation: NativeCliInvocation,
  guardedCommands: readonly string[],
): boolean {
  const commandName = normalizeCommandName(invocation.command);
  return guardedCommands.some((guardedCommand) => guardedCommand === commandName);
}

function isVersionProbeInvocation(invocation: NativeCliInvocation): boolean {
  return invocation.args.length === 1 && invocation.args[0] === '--version';
}

function isCodexAppServerInvocation(invocation: CodexAppServerInvocation): boolean {
  return (
    normalizeCommandName(invocation.command) === 'codex' &&
    invocation.args.length > 0 &&
    invocation.args[0] === 'app-server'
  );
}

export class TestNativeCliGuardError extends Error {
  readonly invocation: NativeCliInvocation;
  readonly cwdSource: string;
  readonly envSource: string;

  constructor(options: {
    invocation: NativeCliInvocation;
    cwdSource: string;
    envSource: string;
  }) {
    super([
      `测试默认禁止真实 native CLI 调用：${options.invocation.command} ${options.invocation.args.join(' ')}`.trim(),
      `command: ${options.invocation.command}`,
      `args: ${renderArgs(options.invocation.args)}`,
      `cwd: ${JSON.stringify(options.invocation.cwd ?? '<undefined>')}`,
      `cwd 来源: ${options.cwdSource}`,
      `env 来源: ${options.envSource}`,
      `env 摘要: ${renderEnvSummary(options.invocation.env)}`,
      '请显式注入 fake native runner，例如传入 `nativeCliRunner`，或通过自定义 adapters factory 构造 adapter。',
    ].join('\n'));
    this.name = 'TestNativeCliGuardError';
    this.invocation = options.invocation;
    this.cwdSource = options.cwdSource;
    this.envSource = options.envSource;
  }
}

export function createTestNativeCliGuard(options: {
  cwdSource?: string;
  envSource?: string;
  fallbackRunner?: NativeCliRunner;
  guardedCommands?: readonly string[];
} = {}): NativeCliRunner {
  const fallbackRunner = options.fallbackRunner ?? execFileNativeCliRunner;
  const guardedCommands = options.guardedCommands ?? DEFAULT_GUARDED_NATIVE_COMMANDS;
  const cwdSource = options.cwdSource ?? 'nativeCli invocation.cwd';
  const envSource = options.envSource ?? 'nativeCli invocation.env';

  return async (invocation) => {
    if (isGuardedNativeCliInvocation(invocation, guardedCommands)) {
      if (isVersionProbeInvocation(invocation)) {
        const commandName = normalizeCommandName(invocation.command);
        return {
          exitCode: 0,
          stdout: DEFAULT_VERSION_OUTPUTS[commandName] ?? '0.0.0',
          stderr: '',
        };
      }
      throw new TestNativeCliGuardError({
        invocation,
        cwdSource,
        envSource,
      });
    }

    return fallbackRunner(invocation);
  };
}

export function createTestCodexAppServerProcessGuard(options: {
  cwdSource?: string;
  envSource?: string;
  fallbackRunner?: CodexAppServerProcessRunner;
} = {}): CodexAppServerProcessRunner {
  const cwdSource = options.cwdSource ?? 'codex app-server invocation.cwd';
  const envSource = options.envSource ?? 'codex app-server invocation.env';

  return (invocation) => {
    if (isCodexAppServerInvocation(invocation)) {
      throw new CodexAppServerError({
        category: 'spawn_failure',
        summary: '测试默认禁止启动真实 `codex app-server`。',
        suggestion: '请显式注入 fake app-server harness，例如 `createFakeCodexAppServerHarness()` 或向 safe CLI/helper 传入 `codexAppServerRunner`。',
        debugContext: {
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          envSummary: renderEnvSummary(invocation.env),
          cwdSource,
          envSource,
          method: 'initialize',
        },
      });
    }

    if (options.fallbackRunner) {
      return options.fallbackRunner(invocation);
    }

    throw new Error(
      `Unexpected non-Codex app-server invocation in test guard: ${invocation.command} ${invocation.args.join(' ')}`.trim(),
    );
  };
}

export function installSourceTestNativeGuards(): void {
  setNativeCliRunnerOverrideForTests(createTestNativeCliGuard({
    cwdSource: 'runNativeCli()/createCommandExecutionContext() invocation.cwd',
    envSource: 'runNativeCli()/createCommandExecutionContext() invocation.env',
  }));
  setCodexAppServerProcessRunnerOverrideForTests(createTestCodexAppServerProcessGuard({
    cwdSource: 'installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.cwd',
    envSource: 'installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.env',
  }));
}

export function resetSourceTestNativeGuards(): void {
  setNativeCliRunnerOverrideForTests(null);
  setCodexAppServerProcessRunnerOverrideForTests(null);
}
