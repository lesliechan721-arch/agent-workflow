import { stat } from 'node:fs/promises'
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

export interface PrepareWindowsJobHelperOptions {
  platform?: NodeJS.Platform
  arch?: string
}

/** Prepare the helper installed with this Eval package before starting consumers. */
export async function prepareWindowsJobHelper(
  options: PrepareWindowsJobHelperOptions = {},
): Promise<string> {
  return resolveWindowsJobHelperPath(options)
}

export async function resolveWindowsJobHelperPath(
  options: PrepareWindowsJobHelperOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'win32' || (arch !== 'x64' && arch !== 'arm64')) {
    throw Object.assign(new Error(`Windows Job helper does not support ${platform}/${arch}.`), {
      code: 'nativePlatformUnsupported',
    })
  }
  const packageName = `@lesliechan721/aw-windows-job-win32-${arch}`
  try {
    const executable = fileURLToPath(import.meta.resolve(`${packageName}/aw-windows-job.exe`))
    if (!(await stat(executable)).isFile()) throw new Error('Windows Job helper is not a file.')
    return executable
  } catch {
    throw Object.assign(new Error(
      `Windows Job helper dependency ${packageName} is unavailable. ` +
      'Reinstall the current AW CLI or Eval package with optional dependencies included.',
    ), { code: 'nativePackageUnavailable' })
  }
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
