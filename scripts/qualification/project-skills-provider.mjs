#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.5.23'
const INTEGRITY = 'sha512-+hMNBSi35yfX0sKD+ZcRm9y5or7u313OdkcvrRvJAsAzGCaA8wRTu2OmVdN0KRbk9ybqKby5dijkn6OVvNTUmw=='
const here = path.dirname(fileURLToPath(import.meta.url))
const defaultReport = path.resolve(here, '../../.dev-workflows/project-plugin-recovery/qualification-provider-report.json')
const SKILL = 'aw-qualification-probe'
const AGENTS = ['codex', 'claude-code', 'cursor']
const DISPLAY = ['Claude Code', 'Codex', 'Cursor']

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function write(file, content) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content) }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }

export function isolatedEnvironment(root, network = false) {
  const home = path.join(root, 'home')
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home, USERPROFILE: home,
    AW_HOME: path.join(root, 'aw-home'), AW_CODEX_HOME: path.join(root, 'aw-codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'aw-claude-home'), CODEX_HOME: path.join(root, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'), XDG_STATE_HOME: path.join(root, 'xdg-state'),
    TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    GIT_TERMINAL_PROMPT: '0', CI: '1', NO_COLOR: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    npm_config_userconfig: path.join(root, 'empty-npmrc'),
    npm_config_globalconfig: path.join(root, 'empty-global-npmrc'),
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false',
  }
  if (!network) Object.assign(env, {
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '',
    http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1',
    all_proxy: 'http://127.0.0.1:1', no_proxy: '',
  })
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  return env
}

export async function boundedCommand(command, args, { cwd, env, timeoutMs = 20_000 }) {
  const started = Date.now()
  const controller = new AbortController()
  let child
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    if (child && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* child already exited */ }
    }
  }, timeoutMs)
  try {
    return await new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let errorCode = null
      child = spawn(command, args, {
        cwd, env, signal: controller.signal, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const [stream, append] of [
        [child.stdout, value => { stdout += value }],
        [child.stderr, value => { stderr += value }],
      ]) stream.on('data', data => {
        append(data.toString('utf8').slice(0, 64 * 1024))
        if (stdout.length + stderr.length > 256 * 1024) controller.abort()
      })
      child.on('error', error => { errorCode = error.code ?? 'spawnError' })
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, errorCode, timedOut, durationMs: Date.now() - started }))
    })
  } finally { clearTimeout(timer) }
}

async function tree(root) {
  async function visit(file, relative) {
    let stat
    try { stat = await fs.lstat(file) } catch (error) {
      if (error.code === 'ENOENT') return [{ path: relative, kind: 'missing' }]
      throw error
    }
    if (stat.isSymbolicLink()) return [{ path: relative, kind: 'symlink', target: await fs.readlink(file) }]
    if (stat.isFile()) return [{ path: relative, kind: 'file', sha256: hash(await fs.readFile(file)), size: stat.size, mtimeMs: stat.mtimeMs, inode: stat.ino }]
    if (!stat.isDirectory()) return [{ path: relative, kind: 'special' }]
    const children = await fs.readdir(file)
    const output = [{ path: relative, kind: 'directory', mtimeMs: stat.mtimeMs, inode: stat.ino }]
    for (const name of children.sort()) output.push(...await visit(path.join(file, name), relative ? `${relative}/${name}` : name))
    return output
  }
  return visit(root, '')
}

function contentTree(items) {
  return items.map(({ path: name, kind, sha256, target }) => ({ path: name, kind, ...(sha256 ? { sha256 } : {}), ...(target ? { target } : {}) }))
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

async function prepareRoot(root) {
  const env = isolatedEnvironment(root)
  for (const key of ['HOME', 'AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) await fs.mkdir(env[key], { recursive: true })
  await fs.mkdir(path.join(env.HOME, '.cursor'), { recursive: true })
  for (const key of ['GIT_CONFIG_GLOBAL', 'npm_config_userconfig', 'npm_config_globalconfig']) await write(env[key], '')
  return env
}

async function acquireOfficial(root, env) {
  const metadataResponse = await fetch(`https://registry.npmjs.org/skills/${VERSION}`, { signal: AbortSignal.timeout(15_000) })
  if (!metadataResponse.ok) throw new Error(`metadataHttp${metadataResponse.status}`)
  const metadata = await metadataResponse.json()
  assert.equal(metadata.name, 'skills')
  assert.equal(metadata.version, VERSION)
  assert.equal(metadata.dist.tarball, `https://registry.npmjs.org/skills/-/skills-${VERSION}.tgz`)
  assert.equal(metadata.dist.integrity, INTEGRITY)
  assert.deepEqual(metadata.dependencies, { tar: '^7.5.20', yaml: '^2.8.3' })
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`tarballHttp${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, INTEGRITY)
  const archive = path.join(root, 'skills.tgz')
  await write(archive, bytes)
  const tar = await boundedCommand('tar', ['-tzf', archive], { cwd: root, env, timeoutMs: 10_000 })
  if (tar.code !== 0 || tar.stdout.split('\n').filter(Boolean).some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('unsafeArchive')
  const extraction = await boundedCommand('tar', ['-xzf', archive, '-C', root], { cwd: root, env, timeoutMs: 10_000 })
  if (extraction.code !== 0) throw new Error('extractFailed')
  const pkg = await readJson(path.join(root, 'package', 'package.json'))
  assert.equal(pkg.name, 'skills')
  assert.equal(pkg.version, VERSION)
  const deps = path.join(root, 'dependencies')
  await write(path.join(deps, 'package.json'), `${JSON.stringify({ private: true, dependencies: { tar: '7.5.20', yaml: '2.8.3' } })}\n`)
  const npm = await boundedCommand('npm', ['install', '--ignore-scripts', '--package-lock=false', '--prefix', deps], { cwd: root, env: { ...isolatedEnvironment(root, true), npm_config_registry: 'https://registry.npmjs.org/' }, timeoutMs: 90_000 })
  if (npm.code !== 0) throw new Error(`dependencyInstall${npm.errorCode ?? npm.code}`)
  await fs.symlink(path.join(deps, 'node_modules'), path.join(root, 'package', 'node_modules'))
  return { cli: path.join(root, 'package', 'bin', 'cli.mjs'), evidence: { version: VERSION, integrity: INTEGRITY, dependencies: { tar: '7.5.20', yaml: '2.8.3' } } }
}

async function project(root, name) {
  const dir = path.join(root, name)
  for (const part of ['.git', '.codex', '.claude', '.cursor']) await fs.mkdir(path.join(dir, part), { recursive: true })
  return dir
}

async function fixture(root, name = SKILL, suffix = 'V1') {
  const dir = path.join(root, 'source', name)
  await write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Local qualification Skill.\n---\n\n# Qualification\n`)
  await write(path.join(dir, 'payload.txt'), `${suffix}\n`)
  await write(path.join(dir, 'assets', 'nested.txt'), 'NESTED\n')
  await write(path.join(dir, '.hidden-probe'), 'HIDDEN\n')
  return dir
}

export async function runQualification({ cli: providedCli, reportPath = defaultReport, fake = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skills-qualification-'))
  const realRoot = await fs.realpath(root)
  const redact = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value
    for (const prefix of [realRoot, root]) if (value === prefix || value.startsWith(`${prefix}${path.sep}`)) return `<temporary-root>${value.slice(prefix.length)}`
    return value
  }
  const report = {
    schemaVersion: 1, kind: 'project-skills-provider', status: 'failed',
    officialProvider: !providedCli && !fake, requiredVersion: VERSION,
    environment: { os: process.platform, release: os.release(), arch: process.arch, node: process.version, consumerLoadTested: false },
    package: null, agents: { ids: AGENTS, displayNames: DISPLAY },
    qualifiedContent: {
      scope: 'local-project-copy-with-prewrite-filter',
      observedCompleteTree: false,
      validMetadataJsonDropped: null,
      excludedFileBasenames: ['metadata.json'],
      excludedDirectoryBasenames: ['.git', '__pycache__', '__pypackages__'],
      exclusionEvidence: 'metadata.json observed; remaining names in official skills v1.5.23 installer source',
      affectedPluginAction: 'reject-before-provider-write',
      realConsumerLoad: 'unverified',
    },
    cases: {}, requiredGuards: [], blockers: [], cleanup: null,
  }
  try {
    const env = await prepareRoot(root)
    const { cli, evidence } = providedCli ? { cli: providedCli, evidence: { version: VERSION, source: fake ? 'test-fake' : 'provided' } } : await acquireOfficial(root, env)
    report.package = evidence
    async function call(label, args, cwd, timeoutMs) {
      const result = await boundedCommand(process.execPath, [cli, ...args], { cwd, env, timeoutMs })
      report.cases[label] = { args: args.map(redact), exitCode: result.code, signal: result.signal, errorCode: result.errorCode, timedOut: result.timedOut, durationMs: result.durationMs }
      return result
    }
    const version = await call('version', ['--version'], root)
    report.actualVersion = version.stdout.trim()
    if (version.code !== 0 || version.stdout.trim() !== VERSION) throw new Error('exactVersionMismatch')
    const source = await fixture(root)
    const sourceTree = contentTree(await tree(source))
    const main = await project(root, 'main')
    const unrelated = { source: './foreign-source', sourceType: 'local', skillPath: 'foreign-skill', computedHash: 'foreign-sentinel' }
    await write(path.join(main, 'skills-lock.json'), `${JSON.stringify({ version: 1, skills: { 'foreign-skill': unrelated } })}\n`)
    const addArgs = ['add', source, '--skill', SKILL, '--agent', ...AGENTS, '--copy', '--yes']
    const added = await call('projectAdd', addArgs, main)
    const canonical = path.join(main, '.agents', 'skills', SKILL)
    const claude = path.join(main, '.claude', 'skills', SKILL)
    const targets = { canonical: contentTree(await tree(canonical)), claudeCode: contentTree(await tree(claude)), codexSpecific: contentTree(await tree(path.join(main, '.codex', 'skills', SKILL))), cursorSpecific: contentTree(await tree(path.join(main, '.cursor', 'skills', SKILL))) }
    const lockAfter = await readJson(path.join(main, 'skills-lock.json'))
    const lockEntry = lockAfter.skills?.[SKILL] ? { ...lockAfter.skills[SKILL] } : null
    let lockSourceRelative = null
    let lockSourceMatchesFixture = null
    if (lockEntry) {
      const realSource = await fs.realpath(source)
      const sourceMatches = await fs.realpath(path.resolve(main, lockEntry.source)).then(value => value === realSource).catch(() => false)
      lockSourceRelative = !path.isAbsolute(lockEntry.source)
      lockSourceMatchesFixture = sourceMatches
      lockEntry.source = sourceMatches ? '<relative-path-to-temporary-source>' : '<unmatched-source>'
    }
    report.cases.projectAdd.observed = { sourceTree, targets, lockVersion: lockAfter.version, lockSkillNames: Object.keys(lockAfter.skills ?? {}).sort(), lockEntry, lockSourceRelative, lockSourceMatchesFixture, unrelatedLockPreserved: same(lockAfter.skills?.['foreign-skill'], unrelated), completeCanonicalTree: same(sourceTree, targets.canonical), completeClaudeTree: same(sourceTree, targets.claudeCode) }
    report.qualifiedContent.observedCompleteTree = report.cases.projectAdd.observed.completeCanonicalTree && report.cases.projectAdd.observed.completeClaudeTree
    const listed = await call('projectList', ['list', '--json'], main)
    report.cases.projectList.observed = listed.code === 0 ? JSON.parse(listed.stdout).map(entry => ({ name: entry.name, path: redact(entry.path), scope: entry.scope, agents: entry.agents, source: redact(entry.source) })) : null
    const beforeRepeat = await tree(canonical)
    const beforeClaudeRepeat = await tree(claude)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const repeated = await call('repeatAdd', addArgs, main)
    report.cases.repeatAdd.observed = { rewroteCanonical: !same(beforeRepeat, await tree(canonical)), rewroteClaude: !same(beforeClaudeRepeat, await tree(claude)) }
    const collision = await project(root, 'collision')
    await write(path.join(collision, '.agents', 'skills', SKILL, 'foreign.txt'), 'FOREIGN\n')
    await write(path.join(collision, '.claude', 'skills', SKILL, 'foreign.txt'), 'FOREIGN\n')
    const collisionRun = await call('sameNameCollision', addArgs, collision)
    report.cases.sameNameCollision.observed = { canonicalForeignRemains: (await tree(path.join(collision, '.agents', 'skills', SKILL))).some(item => item.path === 'foreign.txt'), claudeForeignRemains: (await tree(path.join(collision, '.claude', 'skills', SKILL))).some(item => item.path === 'foreign.txt') }
    const global = await project(root, 'global-cwd')
    const globalRun = await call('globalAdd', [...addArgs, '--global'], global)
    const globalList = await call('globalList', ['list', '--json', '--global'], global)
    report.cases.globalAdd.observed = { canonical: contentTree(await tree(path.join(env.HOME, '.agents', 'skills', SKILL))), claudeCode: contentTree(await tree(path.join(env.CLAUDE_CONFIG_DIR, 'skills', SKILL))), projectCanonical: contentTree(await tree(path.join(global, '.agents', 'skills', SKILL))) }
    report.cases.globalList.observed = globalList.code === 0 ? JSON.parse(globalList.stdout).filter(entry => entry.name === SKILL).map(entry => ({ name: entry.name, scope: entry.scope, agents: entry.agents, path: redact(entry.path) })) : null
    const normalized = await fixture(root, 'AW_Qualification.Probe')
    await write(path.join(normalized, 'metadata.json'), '{"excluded":true}\n')
    const normProject = await project(root, 'normalization')
    const normRun = await call('normalization', ['add', normalized, '--agent', 'codex', '--copy', '--yes'], normProject)
    report.cases.normalization.observed = { paths: await fs.readdir(path.join(normProject, '.agents', 'skills')).catch(() => []), sourceName: 'AW_Qualification.Probe', sourceMetadataJsonSha256: hash(await fs.readFile(path.join(normalized, 'metadata.json'))), metadataJsonCopied: (await tree(path.join(normProject, '.agents', 'skills', 'aw_qualification.probe'))).some(item => item.path === 'metadata.json') }
    report.qualifiedContent.validMetadataJsonDropped = !report.cases.normalization.observed.metadataJsonCopied
    const normalizedCollision = await fixture(root, 'aw_qualification.probe', 'V2')
    const normalizedCollisionRun = await call('normalizationCollision', ['add', normalizedCollision, '--agent', 'codex', '--copy', '--yes'], normProject)
    report.cases.normalizationCollision.observed = { paths: await fs.readdir(path.join(normProject, '.agents', 'skills')).catch(() => []), contentChanged: (await fs.readFile(path.join(normProject, '.agents', 'skills', 'aw_qualification.probe', 'payload.txt'), 'utf8').catch(() => null)) === 'V2\n', lockSkillNames: Object.keys((await readJson(path.join(normProject, 'skills-lock.json'))).skills ?? {}).sort() }
    await fs.rm(source, { recursive: true })
    const sourceGone = await call('listAfterSourceDeletion', ['list', '--json'], main)
    report.cases.listAfterSourceDeletion.observed = { sourceRemoved: !(await fs.stat(source).then(() => true).catch(() => false)), entries: sourceGone.code === 0 ? JSON.parse(sourceGone.stdout).filter(entry => entry.name === SKILL).map(entry => ({ name: entry.name, scope: entry.scope, source: redact(entry.source), agents: entry.agents })) : null, canonical: contentTree(await tree(canonical)), claudeCode: contentTree(await tree(claude)) }
    const badLockProject = await project(root, 'bad-lock')
    await write(path.join(badLockProject, 'skills-lock.json'), '{bad json\n')
    const badLock = await call('badLock', ['add', normalized, '--agent', 'codex', '--copy', '--yes'], badLockProject)
    const badLockAfter = await fs.readFile(path.join(badLockProject, 'skills-lock.json'), 'utf8')
    report.cases.badLock.observed = { invalidLockOverwritten: badLockAfter !== '{bad json\n', lockSkillNames: badLockAfter === '{bad json\n' ? null : Object.keys(JSON.parse(badLockAfter).skills ?? {}), output: contentTree(await tree(path.join(badLockProject, '.agents', 'skills', 'aw_qualification.probe'))) }
    const partialProject = await project(root, 'partial')
    await write(path.join(partialProject, '.claude', 'skills'), 'BLOCKED\n')
    const partial = await call('partialWrite', ['add', normalized, '--agent', 'codex', 'claude-code', '--copy', '--yes'], partialProject)
    report.cases.partialWrite.observed = { canonical: contentTree(await tree(path.join(partialProject, '.agents', 'skills'))), claudeBlockerPreserved: (await fs.readFile(path.join(partialProject, '.claude', 'skills'), 'utf8')) === 'BLOCKED\n', lock: contentTree(await tree(path.join(partialProject, 'skills-lock.json'))) }
    for (const [label, result] of [['projectAdd', added], ['repeatAdd', repeated], ['sameNameCollision', collisionRun], ['globalAdd', globalRun], ['normalization', normRun], ['normalizationCollision', normalizedCollisionRun]]) if (result.code !== 0) report.blockers.push(`${label}Failed`)
    if (!report.cases.projectAdd.observed.completeCanonicalTree || !report.cases.projectAdd.observed.completeClaudeTree) report.blockers.push('incompleteCopyTree')
    if (!report.cases.projectAdd.observed.unrelatedLockPreserved) report.blockers.push('unrelatedLockLost')
    if (!lockSourceRelative || !lockSourceMatchesFixture) report.blockers.push('projectLockSourceMismatch')
    const projectEntry = report.cases.projectList.observed?.find(entry => entry.name === SKILL)
    if (!projectEntry || projectEntry.scope !== 'project' || !same(projectEntry.agents, DISPLAY) || projectEntry.path !== `<temporary-root>/main/.agents/skills/${SKILL}`) report.blockers.push('projectListMismatch')
    const globalEntry = report.cases.globalList.observed?.find(entry => entry.name === SKILL)
    if (!globalEntry || globalEntry.scope !== 'global' || !same(globalEntry.agents, DISPLAY)) report.blockers.push('globalListMismatch')
    if (!same(sourceTree, report.cases.globalAdd.observed.canonical) || !same(sourceTree, report.cases.globalAdd.observed.claudeCode) || report.cases.globalAdd.observed.projectCanonical[0]?.kind !== 'missing') report.blockers.push('globalOutputMismatch')
    if (report.cases.normalization.observed.paths[0] !== 'aw_qualification.probe' || !report.cases.normalizationCollision.observed.contentChanged) report.blockers.push('normalizationMismatch')
    if (!same(report.cases.normalizationCollision.observed.lockSkillNames, ['AW_Qualification.Probe', 'aw_qualification.probe'])) report.blockers.push('normalizedCollisionLockMismatch')
    const deleted = report.cases.listAfterSourceDeletion.observed
    if (!deleted.sourceRemoved || deleted.entries?.length !== 1 || deleted.entries[0].source !== `<temporary-root>/source/${SKILL}` || !same(deleted.canonical, targets.canonical) || !same(deleted.claudeCode, targets.claudeCode)) report.blockers.push('sourceDeletionObservationMismatch')
    if (report.qualifiedContent.validMetadataJsonDropped) report.requiredGuards.push('rejectProviderExcludedSkillTreeEntriesBeforeAdd')
    if (badLock.code === 0 && report.cases.badLock.observed.invalidLockOverwritten) report.requiredGuards.push('rejectMalformedLockBeforeAdd')
    if (partial.code === 0) report.requiredGuards.push('verifyEveryPhysicalTargetAfterAddEvenOnZeroExit')
    if (report.cases.repeatAdd.observed.rewroteCanonical || report.cases.repeatAdd.observed.rewroteClaude) report.requiredGuards.push('skipSatisfiedAdd')
    if (!report.cases.sameNameCollision.observed.canonicalForeignRemains || !report.cases.sameNameCollision.observed.claudeForeignRemains) report.requiredGuards.push('rejectForeignSameNameBeforeAdd')
    if (report.cases.normalizationCollision.observed.contentChanged) report.requiredGuards.push('rejectNormalizedNameCollisionBeforeAdd')
    report.status = report.blockers.length === 0 ? 'passed' : 'blocked'
  } catch (error) {
    report.blockers.push(error.message ?? 'qualificationFailed')
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); report.cleanup = { completed: true } }
    catch { report.cleanup = { completed: false }; report.blockers.push('cleanupFailed'); report.status = 'failed' }
    await write(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runQualification()
  process.stdout.write(`${JSON.stringify({ status: report.status, report: defaultReport, blockers: report.blockers })}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
