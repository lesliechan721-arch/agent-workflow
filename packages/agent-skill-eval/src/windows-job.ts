import { lstatSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

function assertWindowsJobArch(arch: string): 'x64' | 'arm64' {
  if (arch === 'x64' || arch === 'arm64') return arch
  throw new Error(`Windows Job containment is unsupported on architecture ${arch}.`)
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = lstatSync(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export function resolveWindowsJobHelperPath(options: {
  arch?: string
  moduleUrl?: string
} = {}): string {
  const arch = assertWindowsJobArch(options.arch ?? process.arch)
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
  const candidates = [
    path.join(moduleDirectory, 'native', 'windows', arch, 'aw-windows-job.exe'),
    path.join(moduleDirectory, '..', 'native', 'windows', arch, 'aw-windows-job.exe'),
  ]
  const helperPath = candidates.find(isRegularFile)
  if (!helperPath) {
    throw new Error(`Windows Job containment helper is missing for architecture ${arch}.`)
  }
  return helperPath
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
    arch?: string
    helperPath?: string
    moduleUrl?: string
    parentPid?: number
  } = {},
): WindowsJobInvocation {
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    throw new Error(
      'Windows Job containment requires an executable file; .cmd and .bat targets are unsupported.',
    )
  }
  const config: WindowsJobHelperConfig = {
    schemaVersion: WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
    executable,
    args: [...args],
    parentPid: options.parentPid ?? process.pid,
  }
  return {
    command: options.helperPath ?? resolveWindowsJobHelperPath(options),
    args: ['--config', encodeWindowsJobHelperConfig(config)],
    config,
  }
}
