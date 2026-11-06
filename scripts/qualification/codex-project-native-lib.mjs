import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const QUALIFICATION_SCHEMA_VERSION = 1
export const REQUIRED_CODEX_VERSION = '0.151.0'
export const QUALIFICATION_KIND = 'codex-project-native'

const marketplaceName = 'aw-native-qualification'
const pluginName = 'aw-native-qualification'
const pluginId = `${pluginName}@${marketplaceName}`
const skillName = 'aw-native-qualification-skill'
const mcpServerName = 'aw_native_qualification'
const appName = 'aw-native-qualification-app'

function isPathWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`))
}

function readPathEnvironment(env, platform) {
  if (platform !== 'win32') return env.PATH
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')
  return pathEntry?.[1]
}

function executableNames(command, env, platform) {
  if (platform !== 'win32') return [command]
  if (['.com', '.exe', '.bat', '.cmd'].includes(path.extname(command).toLowerCase())) {
    return [command]
  }
  const pathExt = Object.entries(env)
    .find(([key]) => key.toLowerCase() === 'pathext')?.[1]
    ?? '.COM;.EXE;.BAT;.CMD'
  const supportedExtensions = new Set(['.com', '.exe', '.bat', '.cmd'])
  const extensions = pathExt.split(';')
    .map((extension) => extension.trim())
    .filter((extension) => supportedExtensions.has(extension.toLowerCase()))
  const orderedExtensions = [
    ...extensions.filter((extension) => ['.com', '.exe'].includes(extension.toLowerCase())),
    ...extensions.filter((extension) => ['.bat', '.cmd'].includes(extension.toLowerCase())),
  ]
  return [...orderedExtensions.map((extension) => `${command}${extension}`), command]
}

async function resolveWindowsExecutable(command, env, cwd) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = path.resolve(cwd, command)
    return (await stat(candidate)).isFile() ? candidate : null
  }
  const pathEnvironment = readPathEnvironment(env, 'win32')
  if (pathEnvironment === undefined) return null
  for (const rawEntry of pathEnvironment.split(';')) {
    const entry = rawEntry.replace(/^"|"$/gu, '')
    const directory = path.resolve(cwd, entry || '.')
    for (const executableName of executableNames(command, env, 'win32')) {
      const candidate = path.join(directory, executableName)
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch (error) {
        if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code)) continue
        throw error
      }
    }
  }
  return null
}

async function resolveWindowsNpmLauncher(shimPath, execPath) {
  try {
    const shimStats = await lstat(shimPath)
    if (!shimStats.isFile() || shimStats.isSymbolicLink()) throw new Error('invalid shim')

    const prefixRoot = path.dirname(shimPath)
    const packageRoot = path.join(prefixRoot, 'node_modules', '@openai', 'codex')
    const packageJsonPath = path.join(packageRoot, 'package.json')
    const launcherPath = path.join(packageRoot, 'bin', 'codex.js')
    const [packageStats, packageJsonStats, launcherStats] = await Promise.all([
      lstat(packageRoot),
      lstat(packageJsonPath),
      lstat(launcherPath),
    ])
    if (
      !packageStats.isDirectory()
      || packageStats.isSymbolicLink()
      || !packageJsonStats.isFile()
      || packageJsonStats.isSymbolicLink()
      || !launcherStats.isFile()
      || launcherStats.isSymbolicLink()
    ) {
      throw new Error('invalid npm tree')
    }

    const [canonicalPrefix, canonicalPackageRoot, canonicalLauncher] = await Promise.all([
      realpath(prefixRoot),
      realpath(packageRoot),
      realpath(launcherPath),
    ])
    if (
      !isPathWithin(canonicalPrefix, canonicalPackageRoot)
      || !isPathWithin(canonicalPackageRoot, canonicalLauncher)
    ) {
      throw new Error('npm tree outside prefix')
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    const bin = packageJson?.bin
    if (
      packageJson?.name !== '@openai/codex'
      || typeof packageJson.version !== 'string'
      || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(packageJson.version)
      || !bin
      || typeof bin !== 'object'
      || Array.isArray(bin)
      || bin.codex !== 'bin/codex.js'
    ) {
      throw new Error('invalid package identity')
    }

    return {
      codexCommand: execPath,
      codexArgsPrefix: [canonicalLauncher],
      expectedPackageVersion: packageJson.version,
    }
  } catch {
    throw Object.assign(new Error('The Windows Codex npm launcher is unsupported.'), {
      code: 'codexWindowsLauncherUnsupported',
    })
  }
}

async function resolveCodexLauncher(input) {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32') {
    return {
      codexCommand: input.codexCommand,
      codexArgsPrefix: [...(input.codexArgsPrefix ?? [])],
      expectedPackageVersion: null,
    }
  }

  let command
  try {
    command = await resolveWindowsExecutable(input.codexCommand, input.env, input.cwd)
  } catch {
    command = null
  }
  if (!command) {
    throw Object.assign(new Error('The Windows Codex executable is unavailable.'), {
      code: 'codexWindowsLauncherUnavailable',
    })
  }
  const extension = path.extname(command).toLowerCase()
  if (extension === '.bat') {
    throw Object.assign(new Error('The Windows Codex batch launcher is unsupported.'), {
      code: 'codexWindowsLauncherUnsupported',
    })
  }
  if (extension !== '.cmd') {
    return {
      codexCommand: command,
      codexArgsPrefix: [...(input.codexArgsPrefix ?? [])],
      expectedPackageVersion: null,
    }
  }
  const resolved = await resolveWindowsNpmLauncher(command, input.execPath ?? process.execPath)
  return {
    ...resolved,
    codexArgsPrefix: [...resolved.codexArgsPrefix, ...(input.codexArgsPrefix ?? [])],
  }
}

function result(id, status, evidence) {
  return { id, result: status, evidence }
}

function failedEvidence(code, error) {
  return [{ code, message: safeErrorMessage(error) }]
}

function safeErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'qualificationCommandFailed'
}

export function parseCodexVersion(stdout) {
  const match = String(stdout).trim().match(/^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/u)
  return match?.[1] ?? null
}

function tomlQuoted(value) {
  return JSON.stringify(value)
}

function pluginConfigBlock(enabled) {
  return `[plugins.${tomlQuoted(pluginId)}]\nenabled = ${enabled ? 'true' : 'false'}\n`
}

function projectTrustBlock(projectRoot, trusted) {
  return `[projects.${tomlQuoted(projectRoot)}]\ntrust_level = ${tomlQuoted(trusted ? 'trusted' : 'untrusted')}\n`
}

function replacePluginEnabled(config, enabled) {
  const pattern = new RegExp(`(\\[plugins\\.${tomlQuoted(pluginId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*enabled\\s*=\\s*)(?:true|false)`, 'u')
  if (!pattern.test(config)) {
    throw Object.assign(new Error('Codex plugin add did not create the expected user plugin entry.'), {
      code: 'pluginConfigEntryMissing',
    })
  }
  return config.replace(pattern, `$1${enabled ? 'true' : 'false'}`)
}

function readPluginEnabled(config) {
  const pattern = new RegExp(`\\[plugins\\.${tomlQuoted(pluginId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*enabled\\s*=\\s*(true|false)`, 'u')
  const match = config.match(pattern)
  return match ? match[1] === 'true' : null
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createMarketplace(root) {
  const pluginRoot = path.join(root, 'plugins', pluginName)
  await writeJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: marketplaceName,
    interface: { displayName: 'AW Native Qualification' },
    plugins: [{
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      description: 'Local-only fixture for Codex native qualification.',
      category: 'Developer Tools',
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    }],
  })
  await writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: pluginName,
    version: '1.0.0',
    description: 'Local-only fixture for Codex native qualification.',
    skills: './skills',
    mcpServers: './.mcp.json',
    hooks: './hooks.json',
    apps: './.app.json',
    interface: {
      displayName: 'AW Native Qualification',
      shortDescription: 'Probe isolated Codex native plugin behavior',
      capabilities: ['Skills', 'MCP', 'Hooks', 'Apps', 'Commands'],
    },
  })
  const skillRoot = path.join(pluginRoot, 'skills', skillName)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Isolated qualification marker.\n---\n\n# Qualification marker\n`,
    'utf8',
  )
  await writeJson(path.join(pluginRoot, '.mcp.json'), {
    mcpServers: {
      [mcpServerName]: {
        command: process.execPath,
        args: ['--version'],
      },
    },
  })
  await writeJson(path.join(pluginRoot, 'hooks.json'), {
    hooks: {
      SessionStart: [{
        hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} --version` }],
      }],
    },
  })
  await writeJson(path.join(pluginRoot, '.app.json'), {
    apps: {
      [appName]: { id: appName },
    },
  })
  await mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
  await writeFile(
    path.join(pluginRoot, 'commands', 'qualification.md'),
    'Run the isolated AW native qualification marker.\n',
    'utf8',
  )
}

async function createGitProject(root) {
  const gitRoot = path.join(root, '.git')
  await mkdir(path.join(gitRoot, 'objects'), { recursive: true })
  await mkdir(path.join(gitRoot, 'refs', 'heads'), { recursive: true })
  await writeFile(path.join(gitRoot, 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  await writeFile(
    path.join(gitRoot, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tbare = false\n',
    'utf8',
  )
}

function isolatedEnvironment(baseEnv, roots) {
  const blockedProxy = 'http://127.0.0.1:1'
  return {
    ...baseEnv,
    CODEX_HOME: roots.codexHome,
    HOME: roots.osHome,
    USERPROFILE: roots.osHome,
    APPDATA: roots.appData,
    LOCALAPPDATA: roots.localAppData,
    XDG_CONFIG_HOME: roots.xdgConfig,
    XDG_DATA_HOME: roots.xdgData,
    XDG_CACHE_HOME: roots.xdgCache,
    XDG_STATE_HOME: roots.xdgState,
    AW_HOME: roots.awHome,
    AW_CODEX_HOME: roots.codexHome,
    AW_CLAUDE_HOME: roots.claudeHome,
    CLAUDE_CONFIG_DIR: roots.claudeHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: roots.gitConfig,
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

async function assertNeutralCwd(directory) {
  for (let current = await realpath(directory); ; current = path.dirname(current)) {
    for (const marker of ['.git', '.agent-workflows', '.aw', path.join('.codex', 'config.toml')]) {
      try {
        await lstat(path.join(current, marker))
        throw Object.assign(new Error('Neutral cwd has a project marker.'), { code: 'neutralCwdUnsafe' })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (path.dirname(current) === current) return
  }
}

async function executeCodex(options, args, cwd) {
  const invocationArgs = [...options.codexArgsPrefix, ...args]
  try {
    const execution = await execFileAsync(options.codexCommand, invocationArgs, {
      cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return {
      exitCode: 0,
      stdout: execution.stdout,
      stderr: execution.stderr,
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      error.code = typeof error.code === 'string' ? error.code : 'codexCommandFailed'
    }
    throw error
  }
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(String(output).trim())
  } catch {
    throw Object.assign(new Error(`${label} did not return one JSON value.`), {
      code: 'codexJsonOutputInvalid',
    })
  }
}

function appServerRequest(options, cwd, method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.codexCommand,
      [...options.codexArgsPrefix, 'app-server', '--stdio'],
      {
        cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    let pending = null
    const timeout = setTimeout(() => finish(new Error('Codex app-server request timed out.')), options.timeoutMs)

    function finish(error, value) {
      if (pending) return
      clearTimeout(timeout)
      pending = { error, value }
      child.stdin.end()
      child.kill()
    }

    function settleAfterExit() {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const outcome = pending ?? {
        error: Object.assign(new Error('Codex app-server exited before the response.'), {
          code: 'codexAppServerExited',
        }),
      }
      if (outcome.error) {
        outcome.error.code = typeof outcome.error.code === 'string'
          ? outcome.error.code
          : 'codexAppServerFailed'
        reject(outcome.error)
      } else {
        resolve(outcome.value)
      }
    }

    function inspectLines() {
      const lines = stdout.split(/\r?\n/u)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error('Codex app-server initialize failed.'))
            return
          }
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
          child.stdin.write(`${JSON.stringify({ id: 2, method, params })}\n`)
        } else if (message.id === 2) {
          if (message.error) finish(new Error('Codex app-server probe failed.'))
          else finish(null, message.result)
          return
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      inspectLines()
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(error))
    child.on('close', () => {
      void stderr
      settleAfterExit()
    })
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'aw-native-qualification', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    })}\n`)
  })
}

async function observedSkill(options, cwd) {
  const response = await appServerRequest(options, cwd, 'skills/list', {
    cwds: [cwd],
    forceReload: true,
  })
  const entry = Array.isArray(response?.data) ? response.data[0] : null
  const skill = Array.isArray(entry?.skills)
    ? entry.skills.find((candidate) => candidate?.pluginId === pluginId && (
      candidate?.name === skillName || candidate?.name?.endsWith(`:${skillName}`)
    ))
    : null
  return {
    loaded: Boolean(skill),
    enabled: skill?.enabled === true,
    pluginBound: skill?.pluginId === pluginId,
    scope: typeof skill?.scope === 'string' ? skill.scope : null,
    errorCount: Array.isArray(entry?.errors) ? entry.errors.length : null,
  }
}

async function observedHooks(options, cwd) {
  const response = await appServerRequest(options, cwd, 'hooks/list', { cwds: [cwd] })
  const entry = Array.isArray(response?.data) ? response.data[0] : null
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : []
  const hook = hooks.find((candidate) => candidate?.pluginId === pluginId)
  return {
    loaded: Boolean(hook),
    enabled: hook?.enabled === true,
    eventName: typeof hook?.eventName === 'string' ? hook.eventName : null,
    pluginBound: hook?.pluginId === pluginId,
    trustStatus: typeof hook?.trustStatus === 'string' ? hook.trustStatus : null,
    errorCount: Array.isArray(entry?.errors) ? entry.errors.length : null,
  }
}


async function observedActivation(options, cwd) {
  const skill = await observedSkill(options, cwd)
  const hook = await observedHooks(options, cwd)
  return {
    active: (skill.loaded && skill.enabled) || (hook.loaded && hook.enabled),
    skill,
    hook,
  }
}

async function observedPluginDetail(options, cwd, marketplaceManifest) {
  const response = await appServerRequest(options, cwd, 'plugin/read', {
    marketplacePath: marketplaceManifest,
    pluginName,
  })
  return response?.plugin ?? null
}

function normalizeCommandEvidence(output) {
  const value = parseJsonOutput(output, 'Codex command')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { jsonObject: false }
  const normalized = { jsonObject: true }
  for (const key of ['name', 'marketplaceName', 'pluginName', 'pluginId', 'alreadyPresent', 'enabled']) {
    if (['string', 'boolean'].includes(typeof value[key])) normalized[key] = value[key]
  }
  return normalized
}

function findNamedObject(value, name) {
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value) && (value.name === name || value.id === name)) return value
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findNamedObject(child, name)
    if (match) return match
  }
  return null
}

async function observedMcp(options, cwd) {
  const execution = await executeCodex(options, ['mcp', 'list', '--json'], cwd)
  const match = findNamedObject(parseJsonOutput(execution.stdout, 'Codex MCP list'), mcpServerName)
  return {
    listed: Boolean(match),
    enabled: typeof match?.enabled === 'boolean' ? match.enabled : null,
    pluginBound: match?.pluginId === pluginId || match?.plugin_id === pluginId,
  }
}

async function observedSharedPackage(options, cwd) {
  const execution = await executeCodex(options, [
    'plugin', 'list', '--marketplace', marketplaceName, '--json',
  ], cwd)
  const list = parseJsonOutput(execution.stdout, 'Codex plugin list')
  if (!Array.isArray(list?.installed) || !Array.isArray(list?.available)) {
    throw Object.assign(new Error('Codex plugin list has an unsupported shape.'), {
      code: 'codexPluginListInvalid',
    })
  }
  const entries = list.installed.filter((entry) => entry?.pluginId === pluginId)
  return {
    listedOnce: entries.length === 1,
    installed: entries.length === 1 && entries[0]?.installed === true,
    enabled: entries.length === 1 ? entries[0]?.enabled === true : null,
  }
}

function surfaceResult(id, supported, evidence) {
  return {
    id,
    result: supported ? 'supported' : 'unsupported',
    evidence,
  }
}

function createBaseReport(input = {}) {
  return {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    kind: QUALIFICATION_KIND,
    minimumContractPassed: false,
    environment: {
      os: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      codexCli: {
        requiredExactVersion: REQUIRED_CODEX_VERSION,
        actualVersion: null,
        result: 'failed',
      },
    },
    isolation: {
      codexHome: 'temporary',
      userHome: 'temporary',
      awHome: 'temporary-unused',
      project: 'temporary',
      marketplace: 'temporary-local',
      network: 'local-only-commands-with-blocked-proxy',
      cleanup: 'completed',
    },
    scenarios: [],
    nativeKinds: {
      skill: surfaceResult('skill', false, [{ code: 'notProbed' }]),
      mcp: surfaceResult('mcp', false, [{ code: 'notProbed' }]),
      hook: surfaceResult('hook', false, [{ code: 'notProbed' }]),
      app: surfaceResult('app', false, [{ code: 'notProbed' }]),
      slashCommand: surfaceResult('slashCommand', false, [{ code: 'notProbed' }]),
    },
  }
}

function blockedScenarios(report, reason) {
  const existing = new Set(report.scenarios.map((scenario) => scenario.id))
  for (const id of [
    'marketplace-add',
    'plugin-add-default-user-enabled',
    'neutral-cwd-repo-free',
    'user-false-project-true',
    'user-true-project-false',
    'user-true-project-true',
    'both-disabled-shared-package-retained',
    'neutral-cwd-excludes-project-activation',
    'exact-project-cwd-loads-project-activation',
    'project-trust-not-effective',
  ]) {
    if (!existing.has(id)) report.scenarios.push(result(id, 'unsupported', [{ code: reason }]))
  }
}

export function createQualificationFailureReport(code = 'qualificationInitializationFailed', input = {}) {
  const report = createBaseReport(input)
  report.scenarios.push(result('exact-version-gate', 'failed', [{ code }]))
  blockedScenarios(report, code)
  report.scenarios.push(result('report-redaction', 'passed', [{ code: 'failureDetailsOmitted' }]))
  return assertQualificationReport(report)
}

function assertStatus(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} has an invalid result.`)
}

export function assertQualificationReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Qualification report must be an object.')
  if (report.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) throw new Error('Qualification report schemaVersion is invalid.')
  if (report.kind !== QUALIFICATION_KIND) throw new Error('Qualification report kind is invalid.')
  if (typeof report.minimumContractPassed !== 'boolean') throw new Error('Qualification report minimumContractPassed is invalid.')
  if (!report.environment || typeof report.environment.os !== 'string' || typeof report.environment.arch !== 'string') {
    throw new Error('Qualification report environment is invalid.')
  }
  const cli = report.environment.codexCli
  if (cli?.requiredExactVersion !== REQUIRED_CODEX_VERSION
    || !(typeof cli.actualVersion === 'string' || cli.actualVersion === null)) {
    throw new Error('Qualification report Codex CLI evidence is invalid.')
  }
  assertStatus(cli.result, ['passed', 'failed'], 'Codex CLI evidence')
  const isolation = report.isolation
  if (isolation?.codexHome !== 'temporary'
    || isolation.userHome !== 'temporary'
    || isolation.awHome !== 'temporary-unused'
    || isolation.project !== 'temporary'
    || isolation.marketplace !== 'temporary-local'
    || isolation.network !== 'local-only-commands-with-blocked-proxy') {
    throw new Error('Qualification report isolation evidence is invalid.')
  }
  assertStatus(isolation.cleanup, ['completed', 'failed'], 'Qualification cleanup')
  if (!Array.isArray(report.scenarios)) throw new Error('Qualification report scenarios are invalid.')
  const scenarioIds = new Set()
  for (const scenario of report.scenarios) {
    if (typeof scenario?.id !== 'string' || !Array.isArray(scenario.evidence)) throw new Error('Qualification report scenario is invalid.')
    if (scenarioIds.has(scenario.id)) throw new Error(`Qualification report scenario ${scenario.id} is duplicated.`)
    scenarioIds.add(scenario.id)
    assertStatus(scenario.result, ['passed', 'failed', 'unsupported'], `Scenario ${scenario.id}`)
    if (scenario.evidence.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new Error(`Qualification report scenario ${scenario.id} evidence is invalid.`)
    }
  }
  for (const id of [
    'exact-version-gate',
    'marketplace-add',
    'plugin-add-default-user-enabled',
    'neutral-cwd-repo-free',
    'user-false-project-true',
    'user-true-project-false',
    'user-true-project-true',
    'both-disabled-shared-package-retained',
    'neutral-cwd-excludes-project-activation',
    'exact-project-cwd-loads-project-activation',
    'project-trust-not-effective',
    'report-redaction',
  ]) {
    if (!scenarioIds.has(id)) throw new Error(`Qualification report scenario ${id} is missing.`)
  }
  const nativeKindIds = Object.keys(report.nativeKinds ?? {}).sort()
  if (nativeKindIds.join(',') !== 'app,hook,mcp,skill,slashCommand') {
    throw new Error('Qualification report native kind inventory is invalid.')
  }
  for (const id of ['skill', 'mcp', 'hook', 'app', 'slashCommand']) {
    const kind = report.nativeKinds?.[id]
    if (kind?.id !== id || !Array.isArray(kind.evidence)) throw new Error(`Qualification report native kind ${id} is invalid.`)
    assertStatus(kind.result, ['supported', 'unsupported'], `Native kind ${id}`)
    if (kind.evidence.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new Error(`Qualification report native kind ${id} evidence is invalid.`)
    }
  }
  return report
}

function containsForbiddenText(report, forbidden) {
  const serialized = JSON.stringify(report)
  return forbidden.some((value) => typeof value === 'string' && value.length > 0 && serialized.includes(value))
}

export async function runQualification(input = {}) {
  const report = createBaseReport(input)
  const temporaryRoot = await mkdtemp(path.join(input.tempParent ?? os.tmpdir(), 'aw-codex-native-qualification-'))
  const roots = {
    temporaryRoot,
    codexHome: path.join(temporaryRoot, 'codex-home'),
    osHome: path.join(temporaryRoot, 'os-home'),
    appData: path.join(temporaryRoot, 'app-data'),
    localAppData: path.join(temporaryRoot, 'local-app-data'),
    xdgConfig: path.join(temporaryRoot, 'xdg-config'),
    xdgData: path.join(temporaryRoot, 'xdg-data'),
    xdgCache: path.join(temporaryRoot, 'xdg-cache'),
    xdgState: path.join(temporaryRoot, 'xdg-state'),
    awHome: path.join(temporaryRoot, 'aw-home'),
    claudeHome: path.join(temporaryRoot, 'claude-home'),
    gitConfig: path.join(temporaryRoot, 'git-config'),
    marketplace: path.join(temporaryRoot, 'marketplace'),
    project: path.join(temporaryRoot, 'project'),
    neutral: path.join(temporaryRoot, 'neutral'),
  }
  const options = {
    codexCommand: input.codexCommand ?? process.env.CODEX_QUALIFICATION_CLI ?? 'codex',
    codexArgsPrefix: input.codexArgsPrefix ?? [],
    expectedPackageVersion: null,
    timeoutMs: input.timeoutMs ?? 15_000,
    env: isolatedEnvironment(input.baseEnv ?? process.env, roots),
  }

  try {
    await Promise.all(Object.values(roots).filter((value) => value !== temporaryRoot).map(async (directory) => {
      if (directory === roots.gitConfig) return
      await mkdir(directory, { recursive: true })
    }))
    await writeFile(roots.gitConfig, '', 'utf8')
    await createGitProject(roots.project)
    await createMarketplace(roots.marketplace)

    try {
      await assertNeutralCwd(roots.neutral)
      report.scenarios.push(result('neutral-cwd-repo-free', 'passed', [{ code: 'noAncestorProjectMarker' }]))
    } catch (error) {
      report.scenarios.push(result('neutral-cwd-repo-free', 'failed', failedEvidence('neutralCwdUnsafe', error)))
      report.scenarios.push(result('exact-version-gate', 'failed', [{ code: 'neutralCwdUnsafe' }]))
      blockedScenarios(report, 'neutralCwdUnsafe')
      return report
    }

    let versionExecution
    try {
      const launcher = await resolveCodexLauncher({
        codexCommand: options.codexCommand,
        codexArgsPrefix: options.codexArgsPrefix,
        cwd: roots.neutral,
        env: options.env,
        execPath: input.execPath,
        platform: input.platform,
      })
      options.codexCommand = launcher.codexCommand
      options.codexArgsPrefix = launcher.codexArgsPrefix
      options.expectedPackageVersion = launcher.expectedPackageVersion
      versionExecution = await executeCodex(options, ['--version'], roots.neutral)
    } catch (error) {
      report.scenarios.push(result('exact-version-gate', 'failed', failedEvidence('codexVersionProbeFailed', error)))
      blockedScenarios(report, 'versionGateFailed')
      return report
    }
    const actualVersion = parseCodexVersion(versionExecution.stdout)
    const packageVersionMatched = options.expectedPackageVersion === null
      || options.expectedPackageVersion === actualVersion
    const exactVersionMatched = actualVersion === REQUIRED_CODEX_VERSION && packageVersionMatched
    report.environment.codexCli.actualVersion = actualVersion
    report.environment.codexCli.result = exactVersionMatched ? 'passed' : 'failed'
    report.scenarios.push(result(
      'exact-version-gate',
      exactVersionMatched ? 'passed' : 'failed',
      [{
        code: exactVersionMatched
          ? 'exactVersionMatched'
          : packageVersionMatched ? 'exactVersionMismatch' : 'launcherPackageVersionMismatch',
      }],
    ))
    if (!exactVersionMatched) {
      blockedScenarios(report, 'versionGateFailed')
      return report
    }

    try {
      const marketplaceAdd = await executeCodex(
        options,
        ['plugin', 'marketplace', 'add', roots.marketplace, '--json'],
        roots.neutral,
      )
      report.scenarios.push(result('marketplace-add', 'passed', [{
        code: 'localMarketplaceAdded',
        exitCode: marketplaceAdd.exitCode,
        response: normalizeCommandEvidence(marketplaceAdd.stdout),
      }]))
    } catch (error) {
      report.scenarios.push(result('marketplace-add', 'failed', failedEvidence('marketplaceAddFailed', error)))
      blockedScenarios(report, 'marketplaceAddFailed')
      return report
    }

    try {
      const pluginAdd = await executeCodex(options, ['plugin', 'add', pluginId, '--json'], roots.neutral)
      const userConfigPath = path.join(roots.codexHome, 'config.toml')
      const userConfig = await readFile(userConfigPath, 'utf8')
      const enabled = readPluginEnabled(userConfig)
      report.scenarios.push(result(
        'plugin-add-default-user-enabled',
        enabled === true ? 'passed' : 'failed',
        [{
          code: enabled === true ? 'defaultUserEnabledObserved' : 'defaultUserEnabledMissing',
          exitCode: pluginAdd.exitCode,
          response: normalizeCommandEvidence(pluginAdd.stdout),
        }],
      ))
      if (enabled !== true) {
        blockedScenarios(report, 'defaultUserEnablementMissing')
        return report
      }

      const projectConfigPath = path.join(roots.project, '.codex', 'config.toml')
      await mkdir(path.dirname(projectConfigPath), { recursive: true })
      await writeFile(projectConfigPath, pluginConfigBlock(true), 'utf8')

      const disabledUserConfig = `${replacePluginEnabled(userConfig, false).trim()}\n\n${projectTrustBlock(roots.project, true)}`
      await writeFile(userConfigPath, disabledUserConfig, 'utf8')
      const projectOnly = await observedActivation(options, roots.project)
      const neutralProjectOnly = await observedActivation(options, roots.neutral)
      report.scenarios.push(result(
        'user-false-project-true',
        projectOnly.active && !neutralProjectOnly.active ? 'passed' : 'failed',
        [{ code: 'activationObserved', project: projectOnly, neutral: neutralProjectOnly }],
      ))
      report.scenarios.push(result(
        'neutral-cwd-excludes-project-activation',
        !neutralProjectOnly.active ? 'passed' : 'failed',
        [{ code: neutralProjectOnly.active ? 'projectActivationLeaked' : 'projectActivationExcluded', observed: neutralProjectOnly }],
      ))
      report.scenarios.push(result(
        'exact-project-cwd-loads-project-activation',
        projectOnly.active ? 'passed' : 'failed',
        [{ code: projectOnly.active ? 'projectActivationLoaded' : 'projectActivationMissing', observed: projectOnly }],
      ))

      const enabledUserConfig = `${replacePluginEnabled(userConfig, true).trim()}\n\n${projectTrustBlock(roots.project, true)}`
      await writeFile(userConfigPath, enabledUserConfig, 'utf8')
      const projectBoth = await observedActivation(options, roots.project)
      const neutralUser = await observedActivation(options, roots.neutral)
      report.scenarios.push(result(
        'user-true-project-true',
        projectBoth.active && neutralUser.active ? 'passed' : 'failed',
        [{ code: 'sharedNativeActivationObserved', project: projectBoth, neutral: neutralUser }],
      ))

      await writeFile(projectConfigPath, pluginConfigBlock(false), 'utf8')
      const userOnlyProject = await observedActivation(options, roots.project)
      const userOnlyNeutral = await observedActivation(options, roots.neutral)
      report.scenarios.push(result(
        'user-true-project-false',
        userOnlyProject.active && userOnlyNeutral.active ? 'passed' : 'failed',
        [{ code: 'userActivationPreservedAfterProjectDisable', project: userOnlyProject, neutral: userOnlyNeutral }],
      ))

      await writeFile(userConfigPath, `${replacePluginEnabled(userConfig, false).trim()}\n\n${projectTrustBlock(roots.project, true)}`, 'utf8')
      const disabledProject = await observedActivation(options, roots.project)
      const disabledNeutral = await observedActivation(options, roots.neutral)
      const sharedPackage = await observedSharedPackage(options, roots.neutral)
      report.scenarios.push(result(
        'both-disabled-shared-package-retained',
        !disabledProject.active && !disabledNeutral.active
          && sharedPackage.listedOnce && sharedPackage.installed && !sharedPackage.enabled ? 'passed' : 'failed',
        [{ code: 'sharedPackageRetainedAfterScopeDisable', project: disabledProject, neutral: disabledNeutral, sharedPackage }],
      ))

      await writeFile(projectConfigPath, pluginConfigBlock(true), 'utf8')

      const untrustedUserConfig = `${replacePluginEnabled(userConfig, false).trim()}\n\n${projectTrustBlock(roots.project, false)}`
      await writeFile(userConfigPath, untrustedUserConfig, 'utf8')
      const untrustedProject = await observedActivation(options, roots.project)
      report.scenarios.push(result(
        'project-trust-not-effective',
        !untrustedProject.active ? 'passed' : 'failed',
        [{ code: untrustedProject.active ? 'untrustedProjectActivationLoaded' : 'untrustedProjectActivationExcluded', observed: untrustedProject }],
      ))

      await writeFile(userConfigPath, enabledUserConfig, 'utf8')
      const marketplaceManifest = path.join(roots.marketplace, '.agents', 'plugins', 'marketplace.json')
      let pluginDetail = null
      try {
        pluginDetail = await observedPluginDetail(options, roots.neutral, marketplaceManifest)
      } catch {
        pluginDetail = null
      }
      const detailSkills = Array.isArray(pluginDetail?.skills) ? pluginDetail.skills : []
      const detailMcp = Array.isArray(pluginDetail?.mcpServers) ? pluginDetail.mcpServers : []
      const detailHooks = Array.isArray(pluginDetail?.hooks) ? pluginDetail.hooks : []
      const detailApps = Array.isArray(pluginDetail?.apps) ? pluginDetail.apps : []
      const hookObservation = await observedHooks(options, roots.neutral).catch(() => ({
        loaded: false,
        eventName: null,
        pluginBound: false,
        trustStatus: null,
        errorCount: null,
      }))
      const mcpObservation = await observedMcp(options, roots.neutral).catch(() => ({
        listed: false,
        enabled: null,
        pluginBound: false,
      }))
      const skillSupported = neutralUser.skill.loaded
        && neutralUser.skill.pluginBound
        && detailSkills.some((skill) => skill?.name === skillName || skill?.name?.endsWith(`:${skillName}`))
      const mcpSupported = detailMcp.includes(mcpServerName) && mcpObservation.listed
      const hookSupported = detailHooks.length > 0 && hookObservation.loaded && hookObservation.pluginBound
      const appSupported = detailApps.some((app) => app?.id === appName || app?.name === appName)
      report.nativeKinds = {
        skill: surfaceResult('skill', skillSupported, [{
          code: skillSupported ? 'pluginSkillLoaded' : 'pluginSkillNotProven',
          runtime: neutralUser.skill,
          detailDeclared: detailSkills.some((skill) => skill?.name === skillName || skill?.name?.endsWith(`:${skillName}`)),
        }]),
        mcp: surfaceResult('mcp', mcpSupported, [{
          code: mcpSupported ? 'pluginReadExposedMcpServer' : 'pluginMcpNotProven',
          serverNameMatched: mcpSupported,
          runtime: mcpObservation,
        }]),
        hook: surfaceResult('hook', hookSupported, [{
          code: hookSupported ? 'pluginHookDiscovered' : 'pluginHookNotProven',
          runtime: hookObservation,
          detailDeclared: detailHooks.length > 0,
        }]),
        app: surfaceResult('app', appSupported, [{
          code: appSupported ? 'pluginReadExposedApp' : 'pluginAppNotProven',
          appMatched: appSupported,
        }]),
        slashCommand: surfaceResult('slashCommand', false, [{
          code: 'offlineRuntimeEvidenceUnavailable',
          pluginReadExposedCommands: Boolean(pluginDetail && Object.hasOwn(pluginDetail, 'commands')),
        }]),
      }

      const requiredScenarioIds = new Set([
        'exact-version-gate',
        'marketplace-add',
        'plugin-add-default-user-enabled',
        'neutral-cwd-repo-free',
        'user-false-project-true',
        'user-true-project-false',
        'user-true-project-true',
        'both-disabled-shared-package-retained',
        'neutral-cwd-excludes-project-activation',
        'exact-project-cwd-loads-project-activation',
        'project-trust-not-effective',
      ])
      report.minimumContractPassed = report.scenarios
        .filter((scenario) => requiredScenarioIds.has(scenario.id))
        .every((scenario) => scenario.result === 'passed')
        && Object.values(report.nativeKinds).some((kind) => kind.result === 'supported')
    } catch (error) {
      blockedScenarios(report, safeErrorMessage(error))
    }
    return report
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true })
      report.isolation.cleanup = 'completed'
    } catch {
      report.isolation.cleanup = 'failed'
      report.minimumContractPassed = false
    }
    if (containsForbiddenText(report, [temporaryRoot, roots.codexHome, roots.project, roots.marketplace])) {
      report.minimumContractPassed = false
      report.scenarios.push(result('report-redaction', 'failed', [{ code: 'temporaryPathLeak' }]))
    } else {
      report.scenarios.push(result('report-redaction', 'passed', [{ code: 'temporaryPathsAbsent' }]))
    }
    assertQualificationReport(report)
  }
}
