#!/usr/bin/env node
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { boundedCommand, isolatedEnvironment } from './project-skills-provider.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const reportPath = path.resolve(here, '../../.dev-workflows/project-plugin-recovery/qualification-consumers.json')
const skillName = 'aw-consumer-qualification'
const requiredProviderVersion = '1.5.23'
const claudeDocs = 'https://code.claude.com/docs/en/skills'
const cursorDocs = 'https://cursor.com/docs/skills'

async function findExecutable(name, searchPath) {
  if (path.isAbsolute(name)) {
    try { await fs.access(name, constants.X_OK); return name } catch { return null }
  }
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory, name)
    try { await fs.access(candidate, constants.X_OK); return candidate } catch { /* try next */ }
  }
  return null
}

function exactVersion(output, product) {
  const value = output.trim()
  if (product === 'skills') return /^1\.5\.23$/u.test(value) ? value : null
  if (product === 'claude') return /^(\d+\.\d+\.\d+) \(Claude Code\)$/u.exec(value)?.[1] ?? null
  return /^(?:agent |Cursor Agent )?(\d+\.\d+\.\d+)(?: .*)?$/u.exec(value)?.[1] ?? null
}

async function commandVersion(command, args, options, product) {
  if (!command) return { version: null, result: 'binaryMissing' }
  const result = await boundedCommand(command, [...args, '--version'], options)
  if (result.timedOut) return { version: null, result: 'versionTimeout' }
  if (result.code !== 0) return { version: null, result: 'versionFailed' }
  const version = exactVersion(result.stdout, product)
  return { version, result: version ? 'versionObserved' : 'versionOutputUnrecognized' }
}

async function observedDelivery(project, source, add, listed) {
  const expected = [
    ['canonical', '.agents/skills'],
    ['claudeCode', '.claude/skills'],
  ]
  const targets = await Promise.all(expected.map(async ([id, base]) => {
    const relative = `${base}/${skillName}`
    const target = path.join(project, relative)
    try {
      const [skill, payload] = await Promise.all([
        fs.readFile(path.join(target, 'SKILL.md'), 'utf8'),
        fs.readFile(path.join(target, 'payload.txt'), 'utf8'),
      ])
      return { id, path: relative, complete: skill === source.skill && payload === source.payload }
    } catch { return { id, path: relative, complete: false } }
  }))
  let entry = null
  if (listed.code === 0) {
    try {
      const entries = JSON.parse(listed.stdout)
      entry = entries.find(item => item.name === skillName)
    } catch { /* invalid list is unverified */ }
  }
  const canonical = path.join(project, '.agents', 'skills', skillName)
  const realProject = await fs.realpath(project)
  const pathMatchesCanonical = entry?.path === canonical
    || entry?.path === path.join(realProject, '.agents', 'skills', skillName)
  const associated = entry?.scope === 'project'
    && Array.isArray(entry.agents)
    && ['Claude Code', 'Codex', 'Cursor'].every(agent => entry.agents.includes(agent))
    && pathMatchesCanonical
  return {
    result: add.code === 0 && listed.code === 0 && targets.every(target => target.complete) && associated
      ? 'verified' : 'unverified',
    targets,
    projectAssociationVerified: Boolean(associated),
    listPathMatchesCanonical: Boolean(pathMatchesCanonical),
    listed: entry ? {
      name: skillName,
      scope: entry.scope === 'project' ? 'project' : 'other',
      agents: Array.isArray(entry.agents)
        ? entry.agents.filter(agent => ['Claude Code', 'Codex', 'Cursor'].includes(agent)) : [],
    } : null,
    addExitCode: add.code,
    listExitCode: listed.code,
  }
}

export async function runQualification(input = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(input.tempParent ?? os.tmpdir(), 'aw-project-consumers-'))
  const project = path.join(temporaryRoot, 'project')
  const sourcePath = path.join(temporaryRoot, 'source', skillName)
  const home = path.join(temporaryRoot, 'home')
  const localEnv = isolatedEnvironment(temporaryRoot)
  const networkEnv = isolatedEnvironment(temporaryRoot, true)
  const timeoutMs = input.timeoutMs ?? 20_000
  const report = {
    schemaVersion: 1,
    kind: 'project-consumer-qualification',
    environment: { os: process.platform, release: os.release(), arch: process.arch, node: process.version },
    isolation: { project: 'temporary', home: 'temporary', consumerNetwork: 'blocked-proxy', cleanup: 'pending' },
    provider: { requiredVersion: requiredProviderVersion, actualVersion: null, source: input.providerCommand ? 'provided' : 'npm-registry', delivery: 'unverified', targets: [], projectAssociationVerified: false },
    consumers: {
      claudeCode: { version: null, status: 'unverified', reason: 'notRun', deliveryPath: `.claude/skills/${skillName}`, officialLoadingContract: claudeDocs },
      cursor: { version: null, status: 'unverified', reason: 'notRun', deliveryPath: `.agents/skills/${skillName}`, officialLoadingContract: cursorDocs },
    },
    evidenceGap: [],
  }
  try {
    await Promise.all([
      project, sourcePath, home,
      ...['AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']
        .map(key => localEnv[key]),
      path.join(home, '.cursor'),
    ].map(directory => fs.mkdir(directory, { recursive: true })))
    await Promise.all(['.git', '.codex', '.claude', '.cursor'].map(name => fs.mkdir(path.join(project, name))))
    const source = {
      skill: `---\nname: ${skillName}\ndescription: Local consumer qualification Skill.\n---\n\n# Consumer qualification\n`,
      payload: 'QUALIFICATION\n',
    }
    await Promise.all([
      fs.writeFile(path.join(sourcePath, 'SKILL.md'), source.skill),
      fs.writeFile(path.join(sourcePath, 'payload.txt'), source.payload),
    ])

    let provider = input.providerCommand ?? null
    let providerPrefix = input.providerArgsPrefix ?? []
    if (!provider) {
      const npm = await findExecutable('npm', process.env.PATH ?? '')
      if (!npm) throw new Error('npmMissing')
      const prefix = path.join(temporaryRoot, 'provider')
      const installed = await boundedCommand(npm, [
        'install', '--prefix', prefix, '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund',
        `skills@${requiredProviderVersion}`,
      ], { cwd: temporaryRoot, env: networkEnv, timeoutMs: input.installTimeoutMs ?? 90_000 })
      if (installed.timedOut) throw new Error('providerInstallTimeout')
      if (installed.code !== 0) throw new Error('providerInstallFailed')
      provider = process.execPath
      providerPrefix = [path.join(prefix, 'node_modules', 'skills', 'bin', 'cli.mjs')]
    }
    const providerOptions = { cwd: project, env: localEnv, timeoutMs }
    const providerVersion = await commandVersion(provider, providerPrefix, providerOptions, 'skills')
    report.provider.actualVersion = providerVersion.version
    if (providerVersion.version !== requiredProviderVersion) throw new Error(providerVersion.result === 'versionObserved' ? 'providerVersionMismatch' : providerVersion.result)

    const add = await boundedCommand(provider, [
      ...providerPrefix, 'add', sourcePath, '--skill', skillName,
      '--agent', 'codex', 'claude-code', 'cursor', '--copy', '--yes',
    ], providerOptions)
    if (add.timedOut) throw new Error('providerAddTimeout')
    const listed = await boundedCommand(provider, [...providerPrefix, 'list', '--json'], providerOptions)
    if (listed.timedOut) throw new Error('providerListTimeout')
    const delivery = await observedDelivery(project, source, add, listed)
    const { result: deliveryResult, ...deliveryEvidence } = delivery
    Object.assign(report.provider, { delivery: deliveryResult, ...deliveryEvidence })
    if (delivery.result !== 'verified') throw new Error('providerDeliveryUnverified')

    for (const [id, name, product] of [
      ['claudeCode', input.claudeCommand ?? 'claude', 'claude'],
      ['cursor', input.cursorCommand ?? 'agent', 'cursor'],
    ]) {
      const executable = await findExecutable(name, input.searchPath ?? process.env.PATH ?? '')
      const version = await commandVersion(executable, [], { cwd: project, env: localEnv, timeoutMs }, product)
      report.consumers[id].version = version.version
      report.consumers[id].reason = version.result === 'versionObserved'
        ? 'consumerSkillLoadNotObserved' : version.result
    }
  } catch (error) {
    const allowed = new Set([
      'npmMissing', 'providerInstallTimeout', 'providerInstallFailed', 'providerVersionMismatch',
      'providerAddTimeout', 'providerListTimeout', 'providerDeliveryUnverified',
      'binaryMissing', 'versionTimeout', 'versionFailed', 'versionOutputUnrecognized',
    ])
    report.provider.reason = allowed.has(error?.message) ? error.message : 'qualificationFailed'
    for (const consumer of Object.values(report.consumers)) if (consumer.reason === 'notRun') consumer.reason = 'providerDeliveryUnavailable'
  } finally {
    try { await fs.rm(temporaryRoot, { recursive: true, force: true }); report.isolation.cleanup = 'completed' }
    catch { report.isolation.cleanup = 'failed'; report.evidenceGap.push('temporaryCleanupFailed') }
  }
  if (report.provider.delivery !== 'verified') report.evidenceGap.push('providerDeliveryUnverified')
  for (const [id, consumer] of Object.entries(report.consumers)) {
    if (consumer.status !== 'supported') report.evidenceGap.push(`${id}:${consumer.reason}`)
  }
  report.status = report.provider.delivery !== 'verified' || report.isolation.cleanup !== 'completed'
    ? 'blocked'
    : Object.values(report.consumers).every(consumer => consumer.status === 'supported')
      ? 'supported' : 'unverified'
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runQualification({
    providerCommand: process.env.PROJECT_CONSUMERS_QUALIFICATION_PROVIDER,
    claudeCommand: process.env.CLAUDE_QUALIFICATION_CLI,
    cursorCommand: process.env.CURSOR_QUALIFICATION_CLI,
  })
  const destination = process.env.PROJECT_CONSUMERS_QUALIFICATION_REPORT ?? reportPath
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.status !== 'supported') process.exitCode = 1
}
