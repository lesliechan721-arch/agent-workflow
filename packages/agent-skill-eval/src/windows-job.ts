import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION = 1

const require = createRequire(import.meta.url)
const WINDOWS_JOB_PACKAGES = {
  x64: '@lesliechan721/aw-windows-job-win32-x64/aw-windows-job.exe',
  arm64: '@lesliechan721/aw-windows-job-win32-arm64/aw-windows-job.exe',
} as const

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

function verifyWindowsHelper(helperPath: string, manifestPath: string, arch: 'x64' | 'arm64'): void {
  const invalid = (): never => {
    throw new Error('Windows native helper is invalid. Sync or reinstall the package.')
  }
  try {
    if (!isRegularFile(helperPath) || !isRegularFile(manifestPath)) invalid()
    if (lstatSync(manifestPath).size > 64 * 1024 || lstatSync(helperPath).size > 64 * 1024 * 1024) invalid()
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const binary = manifest?.binaries?.[arch]
    const machine = arch === 'x64' ? 0x8664 : 0xaa64
    if (manifest?.schemaVersion !== 1 || !binary ||
      binary.goarch !== (arch === 'x64' ? 'amd64' : 'arm64') ||
      binary.path !== `${arch}/aw-windows-job.exe` ||
      binary.peMachine !== `0x${machine.toString(16)}` ||
      typeof binary.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(binary.sha256)) invalid()
    const bytes = readFileSync(helperPath)
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') invalid()
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset < 0x40 || peOffset > bytes.length - 6 ||
      bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
      bytes.readUInt16LE(peOffset + 4) !== machine ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== binary.sha256) invalid()
  } catch {
    invalid()
  }
}

export function resolveWindowsJobHelperPath(options: {
  arch?: string
  moduleUrl?: string
  resolvePackage?: (specifier: string) => string
} = {}): string {
  const arch = assertWindowsJobArch(options.arch ?? process.arch)
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
  let packagePath: string | undefined
  const resolvePackage = options.resolvePackage ?? (options.moduleUrl ? undefined : require.resolve)
  if (resolvePackage) {
    try {
      packagePath = resolvePackage(WINDOWS_JOB_PACKAGES[arch])
    } catch {
      // Source checkouts can use the committed artifact before workspace packages are built.
    }
  }
  const nativeRoot = path.join(moduleDirectory, '..', 'native', 'windows')
  const helperPath = packagePath ?? path.join(nativeRoot, arch, 'aw-windows-job.exe')
  const manifestPath = packagePath
    ? path.join(path.dirname(packagePath), 'manifest.json')
    : path.join(nativeRoot, 'manifest.json')
  if (!isRegularFile(helperPath)) {
    throw new Error(`Windows Job containment helper is missing for architecture ${arch}. Sync or reinstall the package.`)
  }
  verifyWindowsHelper(helperPath, manifestPath, arch)
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
