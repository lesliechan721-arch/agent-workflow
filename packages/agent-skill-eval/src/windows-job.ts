import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { parseNativeToolDescriptor, resolveNativeTool } from '@lesliechan721/aw-native-runtime'
import type { NativeToolMode, NativeToolRegistry } from '@lesliechan721/aw-native-runtime'

export const WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION = 1

export interface WindowsJobHelperConfig {
  schemaVersion: typeof WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION
  executable: string
  args: string[]
  parentPid: number
}

export interface WindowsJobInvocation {
  command: string
  args: ['--config', string]
  config: WindowsJobHelperConfig
}

export interface PrepareWindowsJobHelperOptions {
  cacheRoot: string
  arch?: string
  mode?: NativeToolMode
  descriptorPath?: string | URL
  archivePath?: string
  registry?: string | NativeToolRegistry
  sourceEnv?: NodeJS.ProcessEnv
}

/** Foreground admission. Low-level process operations only receive its resolved path. */
export async function prepareWindowsJobHelper(options: PrepareWindowsJobHelperOptions): Promise<string> {
  if (!options.cacheRoot) throw new Error('Windows native execution requires an explicit native cache root.')
  const descriptor = parseNativeToolDescriptor(JSON.parse(await readFile(
    options.descriptorPath ?? new URL('./native/windows-job.lock.json', import.meta.url),
    'utf8',
  )))
  if (descriptor.tool.protocol !== 'aw.windows-job.v1') {
    throw new Error('Windows native helper protocol is invalid.')
  }
  const tool = await resolveNativeTool({
    descriptor,
    cacheRoot: options.cacheRoot,
    platform: 'win32',
    arch: options.arch ?? process.arch,
    mode: options.mode ?? 'network',
    ...(options.archivePath ? { archivePath: options.archivePath } : {}),
    registryEnvironment: options.sourceEnv,
    ...(options.registry ? { registry: options.registry } : {}),
  })
  return tool.executable
}

/** Identity probes and diagnostics must never download executable code. */
export async function resolveWindowsJobHelperPath(
  options: Omit<PrepareWindowsJobHelperOptions, 'mode' | 'archivePath' | 'registry'>,
): Promise<string> {
  return prepareWindowsJobHelper({ ...options, mode: 'cache-only' })
}

export function encodeWindowsJobHelperConfig(config: WindowsJobHelperConfig): string {
  if (
    config.schemaVersion !== WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION ||
    config.executable.length === 0 ||
    config.executable.includes('\0') ||
    !Number.isSafeInteger(config.parentPid) ||
    config.parentPid <= 0 ||
    config.args.some((arg) => arg.includes('\0'))
  ) {
    throw new Error('Invalid Windows Job helper launch configuration.')
  }
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')
}

export function quoteWindowsCommandLineArgument(value: string): string {
  let output = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      output += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    output += `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${output}${'\\'.repeat(backslashes * 2)}"`
}

export function buildWindowsCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsCommandLineArgument).join(' ')
}

export function createWindowsJobInvocation(
  executable: string,
  args: readonly string[],
  options: {
    helperPath: string
    parentPid?: number
  },
): WindowsJobInvocation {
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    throw new Error(
      'Windows Job containment requires an executable file; .cmd and .bat targets are unsupported.',
    )
  }
  if (!options.helperPath || options.helperPath.includes('\0')) {
    throw new Error('Windows Job containment requires a prepared native helper.')
  }
  const config: WindowsJobHelperConfig = {
    schemaVersion: WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
    executable,
    args: [...args],
    parentPid: options.parentPid ?? process.pid,
  }
  return {
    command: options.helperPath,
    args: ['--config', encodeWindowsJobHelperConfig(config)],
    config,
  }
}
