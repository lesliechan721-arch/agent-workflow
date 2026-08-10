import {
  createCliExecutionContext,
  createCommandExecutionContext,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CommandExecutionContext,
  type CommandExecutionContextInput,
} from '../../src/commands/runtime.js';
import {
  runCli,
  type CliRuntimeOptions,
} from '../../src/index.js';
import { getCurrentSourceTestRootRegistry } from '../setup/test-isolation.js';
import { createTestNativeCliGuard } from './native-guard.js';
import {
  assertIsolatedTestEnv,
  assertSafeTestCwd,
} from './test-isolation.js';

export interface SafeCliRuntimeOptions extends Omit<CliRuntimeOptions, 'cwd' | 'env'> {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SafeCommandExecutionContextInput extends Omit<CommandExecutionContextInput, 'env'> {
  env?: NodeJS.ProcessEnv;
}

export interface SafeCliExecutionContextInput extends Omit<CliExecutionContextInput, 'cwd' | 'env'> {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunSafeCliOptions extends SafeCliRuntimeOptions {
  runCli?: typeof runCli;
}

function cloneProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env };
}

export function resolveSafeCliEnv(
  envOverrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env = {
    ...cloneProcessEnv(process.env),
    ...envOverrides,
  };
  assertIsolatedTestEnv(env, getCurrentSourceTestRootRegistry());
  return env;
}

export function resolveSafeCliCwd(
  cwd: string | undefined,
  source = 'resolveSafeCliCwd()',
): string {
  return assertSafeTestCwd(cwd ?? process.cwd(), getCurrentSourceTestRootRegistry(), source);
}

export function createSafeCliRuntimeOptions(
  options: SafeCliRuntimeOptions = {},
): CliRuntimeOptions {
  const {
    nativeCliRunner,
    ...runtimeOptions
  } = options;

  return {
    ...runtimeOptions,
    cwd: resolveSafeCliCwd(runtimeOptions.cwd, 'createSafeCliRuntimeOptions().cwd'),
    env: resolveSafeCliEnv(runtimeOptions.env),
    nativeCliRunner: nativeCliRunner ?? createTestNativeCliGuard({
      cwdSource: 'createSafeCliRuntimeOptions().cwd',
      envSource: 'createSafeCliRuntimeOptions().env',
    }),
  };
}

export async function runSafeCli(
  argv: string[],
  options: RunSafeCliOptions = {},
): Promise<number> {
  const { runCli: execute = runCli, ...runtimeOptions } = options;
  return execute(argv, createSafeCliRuntimeOptions(runtimeOptions));
}

export function createSafeCommandExecutionContext(
  input: SafeCommandExecutionContextInput = {},
): CommandExecutionContext {
  const {
    nativeCliRunner,
    ...contextInput
  } = input;

  return createCommandExecutionContext({
    ...contextInput,
    env: resolveSafeCliEnv(contextInput.env),
    nativeCliRunner: nativeCliRunner ?? createTestNativeCliGuard({
      cwdSource: 'createSafeCommandExecutionContext().native invocation.cwd',
      envSource: 'createSafeCommandExecutionContext().env',
    }),
  });
}

export function createSafeCliExecutionContext(
  input: SafeCliExecutionContextInput = {},
): CliExecutionContext {
  return createCliExecutionContext(createSafeCliRuntimeOptions(input));
}
