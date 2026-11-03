import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { validateCommandEnvironment, type CommandLaunch } from '@lesliechan721/aw-plugin-core/manifest';

import { resolveAwHomeCanonical } from './state-paths.js';
import { prepareNativeToolContext, type NativeToolContext } from './native-tool-context.js';
import type { prepareWindowsJobHelper } from '@lesliechan721/agent-skill-eval';
import { ManagedCommandError, resolveManagedCommand } from './managed-command-store.js';

export interface CommandHost {
  schemaVersion: 1;
  nodeExecutable: string;
  cliEntry: string;
  awHome: string;
}

export function buildManagedCommandEnvironment(options: {
  launch: CommandLaunch;
  hostEnvironment: NodeJS.ProcessEnv;
  host: CommandHost;
  platform?: NodeJS.Platform;
  nativeContext?: NativeToolContext;
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  try { validateCommandEnvironment(options.launch.env, options.launch.envFrom, platform); }
  catch { throw new ManagedCommandError('commandEnvironmentInvalid', 'The command environment definition is invalid.'); }
  const original = { ...options.hostEnvironment };
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  const put = (name: string, value: string | undefined): void => {
    if (platform === 'win32') {
      for (const key of Object.keys(result)) if (key.toUpperCase() === name.toUpperCase()) delete result[key];
    }
    result[name] = value;
  };
  for (const [name, value] of Object.entries(original)) {
    if (/^AW_(?:PLUGIN|COMMAND|NATIVE)_/iu.test(name)) continue;
    put(name, value);
  }
  for (const [name, value] of Object.entries(options.launch.env)) put(name, value);
  for (const [name, source] of Object.entries(options.launch.envFrom)) {
    const sourceKey = platform === 'win32'
      ? Object.keys(original).find((key) => key.toUpperCase() === source.toUpperCase())
      : source;
    const value = sourceKey === undefined ? undefined : original[sourceKey];
    if (value === undefined) throw new ManagedCommandError('commandEnvironmentSourceMissing', `The command environment source ${source} is missing.`);
    put(name, value);
  }
  if (options.nativeContext && Object.keys(options.nativeContext.tools).length > 0) put('AW_NATIVE_TOOL_CONTEXT', JSON.stringify(options.nativeContext));
  put('AW_HOME', options.host.awHome);
  put('AW_COMMAND_HOST', JSON.stringify(options.host));
  return result;
}

export interface ManagedCommandRunOptions {
  id: string;
  args: string[];
  cwd: string;
  cliEntry: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  prepareNativeTool?: typeof prepareWindowsJobHelper;
}

export async function prepareManagedCommandRun(options: ManagedCommandRunOptions): Promise<{ executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
  const hostEnvironment = { ...(options.env ?? process.env) };
  const awHome = await resolveAwHomeCanonical(hostEnvironment);
  const { launch, resourceRoot, producer, set } = await resolveManagedCommand(options.id, hostEnvironment);
  // Reject invalid bindings before native preparation or consumer startup.
  const host: CommandHost = { schemaVersion: 1, nodeExecutable: process.execPath, cliEntry: path.resolve(options.cliEntry), awHome };
  const environment = buildManagedCommandEnvironment({ launch, hostEnvironment, host, platform: options.platform });
  let nativeContext: NativeToolContext;
  try {
    nativeContext = await prepareNativeToolContext({ closure: producer?.nativeTools, kind: 'managed-command-set', key: set ?? '',
      platform: options.platform, arch: options.arch, prepare: options.prepareNativeTool });
  } catch (error) {
    throw new ManagedCommandError(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'nativeToolUnavailable', 'The required native tool could not be prepared. Reinstall the current CLI/Eval package and include optional dependencies.');
  }
  if (Object.keys(nativeContext.tools).length > 0) environment.AW_NATIVE_TOOL_CONTEXT = JSON.stringify(nativeContext);
  const absoluteEntry = path.resolve(resourceRoot, launch.entry);
  return {
    executable: launch.runner === 'node' ? process.execPath : absoluteEntry,
    args: [...(launch.runner === 'node' ? [absoluteEntry] : []), ...launch.args, ...options.args],
    cwd: launch.cwd === 'resource' ? resourceRoot : options.cwd,
    env: environment,
  };
}

export async function runManagedCommand(options: ManagedCommandRunOptions): Promise<number> {
  const invocation = await prepareManagedCommandRun(options);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'inherit',
      shell: false,
    });
    const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map<NodeJS.Signals, () => void>();
    let received: NodeJS.Signals | undefined;
    const clean = (): void => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    for (const signal of signals) {
      const handler = (): void => {
        received = signal;
        try { child.kill(signal); } catch { /* Forwarding is best effort. */ }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once('error', () => {
      clean();
      reject(new ManagedCommandError('commandSpawnFailed', 'The operating system could not start the managed command.'));
    });
    child.once('exit', (code, signal) => {
      clean();
      if (process.platform === 'win32' && received) {
        resolve(received === 'SIGINT' ? 130 : 143);
        return;
      }
      if (signal && process.platform !== 'win32') {
        const number = os.constants.signals[signal] ?? 0;
        try { process.kill(process.pid, signal); } catch { /* The numeric fallback is required when self-signalling is unavailable. */ }
        resolve(128 + number);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
