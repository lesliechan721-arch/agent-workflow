import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CODEX_CONTRACT_VERSIONS = ['0.151.0', '0.153.0']
export const INSTALL_MEDIAN_BUDGET_MS = 15_000

const marketplaceName = 'aw-native-performance'
const pluginName = 'aw-native-performance'
const pluginId = `${pluginName}@${marketplaceName}`
const pluginVersion = '1.0.0'

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function isolatedEnvironment(baseEnv, root) {
  const blockedProxy = 'http://127.0.0.1:1'
  const home = path.join(root, 'home')
  const codexHome = path.join(root, 'codex-home')
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(root, 'app-data'),
    LOCALAPPDATA: path.join(root, 'local-app-data'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    CODEX_HOME: codexHome,
    AW_CODEX_HOME: codexHome,
    AW_HOME: path.join(root, 'aw-home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'git-config'),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    HTTP_PROXY: blockedProxy,
    HTTPS_PROXY: blockedProxy,
    ALL_PROXY: blockedProxy,
    NO_PROXY: '',
    http_proxy: blockedProxy,
    https_proxy: blockedProxy,
    all_proxy: blockedProxy,
    no_proxy: '',
  }
}

async function createMarketplace(root) {
  const pluginRoot = path.join(root, 'plugins', pluginName)
  await mkdir(path.join(root, '.agents', 'plugins'), { recursive: true })
  await mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  await writeFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    name: marketplaceName,
    plugins: [{
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      description: 'Local Codex performance qualification fixture.',
      category: 'Developer Tools',
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    }],
  }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), `${JSON.stringify({
    name: pluginName,
    version: pluginVersion,
    description: 'Local Codex performance qualification fixture.',
  }, null, 2)}\n`, 'utf8')
}

async function execute(command, args, options) {
  return execFileAsync(command, [...options.argsPrefix, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
}

function emptyReport(requiredVersion, samples) {
  return {
    schemaVersion: 1,
    kind: 'codex-native-performance-qualification',
    result: 'failed',
    requiredVersion,
    actualVersion: null,
    samples,
    isolation: {
      codexHome: 'temporary',
      userHome: 'temporary',
      awHome: 'temporary-unused',
      marketplace: 'temporary-local',
      network: 'blocked-proxy-local-commands-only',
      cleanup: 'completed',
    },
    contracts: {
      marketplaceScopedJsonList: false,
      localScopedListWithoutRemote: requiredVersion === '0.153.0' ? false : 'not-required',
      installationMedianMs: null,
      installationBudgetMs: INSTALL_MEDIAN_BUDGET_MS,
    },
    errorCode: null,
  }
}

function parseVersion(stdout) {
  return String(stdout).trim().match(/^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/u)?.[1] ?? null
}

function parseScopedList(stdout) {
  let value
  try {
    value = JSON.parse(String(stdout))
  } catch {
    const error = new Error('Codex scoped plugin list did not return valid JSON.')
    error.code = 'invalidScopedListOutput'
    throw error
  }
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Array.isArray(value.installed)
    || !Array.isArray(value.available)) {
    const error = new Error('Codex scoped plugin list must contain installed and available arrays.')
    error.code = 'invalidScopedListOutput'
    throw error
  }
  const installed = value.installed.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      const error = new Error(`Codex scoped plugin list installed[${index}] must be an object.`)
      error.code = 'invalidScopedListOutput'
      throw error
    }
    if (typeof entry.pluginId !== 'string'
      || entry.pluginId !== entry.pluginId.trim()
      || !/^[^@\s]+@[^@\s]+$/u.test(entry.pluginId)
      || entry.installed !== true
      || typeof entry.enabled !== 'boolean'
      || (entry.version !== undefined && typeof entry.version !== 'string')
      || (entry.source !== undefined
        && (entry.source === null
          || typeof entry.source !== 'object'
          || Array.isArray(entry.source)))
      || (entry.source?.path !== undefined && typeof entry.source.path !== 'string')) {
      const error = new Error(`Codex scoped plugin list installed[${index}] is invalid.`)
      error.code = 'invalidScopedListOutput'
      throw error
    }
    return entry
  })
  return { installed }
}

function requireQualifiedInstall(entries) {
  const matches = entries.filter((entry) => entry.pluginId === pluginId)
  if (matches.length !== 1 || matches[0].version !== pluginVersion) {
    const error = new Error('Codex plugin add did not produce the exact installed plugin version.')
    error.code = 'nativePluginPostcheckFailed'
    throw error
  }
}

export async function runCodexNativePerformanceQualification(input = {}) {
  const requiredVersion = input.requiredVersion ?? process.env.CODEX_QUALIFICATION_VERSION
  const samples = input.samples ?? 5
  if (!CODEX_CONTRACT_VERSIONS.includes(requiredVersion) || !Number.isInteger(samples) || samples < 1) {
    throw new Error('Use one supported exact Codex version and a positive sample count.')
  }
  const report = emptyReport(requiredVersion, samples)
  const command = input.codexCommand ?? process.env.CODEX_QUALIFICATION_CLI
  if (!command) {
    report.result = 'missing'
    report.errorCode = 'exactCodexBinaryMissing'
    return report
  }
  const durations = []
  let scopedListEvidenceCount = 0
  for (let index = 0; index < samples; index += 1) {
    const root = await mkdtemp(path.join(input.tempParent ?? os.tmpdir(), 'aw-codex-native-performance-'))
    const marketplace = path.join(root, 'marketplace')
    const project = path.join(root, 'project')
    const env = isolatedEnvironment(input.baseEnv ?? process.env, root)
    try {
      await Promise.all([
        mkdir(project, { recursive: true }),
        mkdir(env.CODEX_HOME, { recursive: true }),
        mkdir(env.HOME, { recursive: true }),
        createMarketplace(marketplace),
        writeFile(env.GIT_CONFIG_GLOBAL, '', 'utf8'),
      ])
      const options = {
        cwd: project,
        env,
        argsPrefix: input.codexArgsPrefix ?? [],
        timeoutMs: input.timeoutMs ?? INSTALL_MEDIAN_BUDGET_MS,
      }
      await execute('git', ['init', '--quiet'], { ...options, argsPrefix: [] })
      const version = parseVersion((await execute(command, ['--version'], options)).stdout)
      report.actualVersion ??= version
      if (version !== requiredVersion || report.actualVersion !== version) {
        report.errorCode = 'exactCodexVersionMismatch'
        return report
      }
      await execute(command, ['plugin', 'marketplace', 'add', marketplace, '--json'], options)
      const listResult = await execute(
        command,
        ['plugin', 'list', '--marketplace', marketplaceName, '--json'],
        options,
      )
      parseScopedList(listResult.stdout)
      const startedAt = performance.now()
      await execute(command, ['plugin', 'add', pluginId, '--json'], options)
      const duration = performance.now() - startedAt
      const postListResult = await execute(
        command,
        ['plugin', 'list', '--marketplace', marketplaceName, '--json'],
        options,
      )
      requireQualifiedInstall(parseScopedList(postListResult.stdout).installed)
      scopedListEvidenceCount += 1
      durations.push(duration)
    } catch (error) {
      report.errorCode = typeof error?.code === 'string' ? error.code : 'qualificationCommandFailed'
      return report
    } finally {
      try {
        await rm(root, { recursive: true, force: true })
      } catch {
        report.isolation.cleanup = 'failed'
      }
    }
  }
  report.contracts.marketplaceScopedJsonList = scopedListEvidenceCount === samples
  if (requiredVersion === '0.153.0') {
    report.contracts.localScopedListWithoutRemote = scopedListEvidenceCount === samples
  }
  report.contracts.installationMedianMs = Math.round(median(durations) * 100) / 100
  report.result = report.isolation.cleanup === 'completed'
    && report.contracts.marketplaceScopedJsonList
    && report.contracts.installationMedianMs < INSTALL_MEDIAN_BUDGET_MS
    && (requiredVersion !== '0.153.0' || report.contracts.localScopedListWithoutRemote === true)
    ? 'passed'
    : 'failed'
  if (report.result === 'failed') report.errorCode ??= 'qualificationContractFailed'
  return report
}
