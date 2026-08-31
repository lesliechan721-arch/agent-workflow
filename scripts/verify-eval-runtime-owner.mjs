#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compareStrictSemVer, parseStrictSemVer } from '../packages/cli/authoring/scripts/lib/semver.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const canonicalSchemas = [
  { name: 'eval-spec', version: 1 },
  { name: 'eval-audit', version: 1 },
  { name: 'eval-result', version: 1 },
]
const runnerSkillFiles = new Set([
  'README.md',
  'SKILL.md',
  'aw-plugin-requirements.json',
  'agents/openai.yaml',
])
const runnerSkillDirectories = new Set(['agents'])
const allowedAwCommands = [
  /^aw skill eval prepare --help$/u,
  /^aw skill eval prepare <plugin> <skill> --suite <suite> --profile <profile> --output <new-spec-directory> --json$/u,
  /^aw skill eval doctor --json$/u,
]
const allowedEvalCommands = [
  /^aw-skill-eval spec validate <spec\.json>$/u,
  /^aw-skill-eval audit validate <audit\.json> --spec <spec\.json>$/u,
  /^aw-skill-eval run <spec\.json> --audit <audit\.json>$/u,
  /^aw-skill-eval result validate <result\.json> --spec <spec\.json> --audit <audit\.json>$/u,
  /^aw-skill-eval inspect-result <result\.json> --spec <spec\.json> --audit <audit\.json>$/u,
  /^aw-skill-eval doctor --json$/u,
]

function fail(message) {
  throw new Error(message)
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function parseMinimumPackageVersion(skill) {
  const matches = [...skill.matchAll(
    /@lesliechan721\/agent-skill-eval\s+>=\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/gu,
  )]
  const versions = [...new Set(matches.map((match) => match[1]))]
  if (versions.length !== 1) {
    fail('Runner final SKILL.md must declare exactly one agent-skill-eval minimum version.')
  }
  parseStrictSemVer(versions[0], 'Runner agent-skill-eval minimum version')
  return versions[0]
}

async function assertRegularFile(filePath, label) {
  const info = await lstat(filePath).catch((error) => {
    fail(`${label} is missing: ${error.message}`)
  })
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular non-symlink file.`)
  const contents = await readFile(filePath, 'utf8')
  if (!contents.trim()) fail(`${label} must not be empty.`)
  return contents
}

async function collectBundleFiles(root, relative = '') {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const collected = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name
    const entryPath = path.join(root, entryRelative)
    const info = await lstat(entryPath)
    if (info.isSymbolicLink()) fail(`Runner final Skill contains a symlink: ${entryRelative}`)
    if (entry.isDirectory()) {
      if (!runnerSkillDirectories.has(entryRelative)) {
        fail(`Runner final Skill contains an unexpected directory: ${entryRelative}`)
      }
      collected.push(...await collectBundleFiles(root, entryRelative))
      continue
    }
    if (!entry.isFile()) fail(`Runner final Skill contains a non-regular entry: ${entryRelative}`)
    if (!runnerSkillFiles.has(entryRelative)) {
      fail(`Runner final Skill contains an unexpected file: ${entryRelative}`)
    }
    collected.push(entryRelative)
  }
  return collected
}

const shellFenceLanguages = new Set([
  '',
  'bash',
  'bat',
  'cmd',
  'powershell',
  'ps1',
  'pwsh',
  'sh',
  'shell',
  'zsh',
])

function looksLikeInlineShellCommand(candidate) {
  const normalized = candidate.trim()
  if (normalized === '' || /^[{[]/u.test(normalized)) return false
  if (/^(?:aw|aw-skill-eval)\s/u.test(normalized)) return true
  if (/^(?:bash|bun|deno|node|npm|npx|pnpm|pwsh|sh|zsh)\s/u.test(normalized)) return true
  if (/^(?:\.\/)?(?:assets|providers|schemas|scripts)\/[A-Za-z0-9._/-]+$/u.test(normalized)) {
    return true
  }
  if (/^(?:\.\/)?(?:assets|providers|schemas|scripts)\/[A-Za-z0-9._/-]+\s/u.test(normalized)) {
    return true
  }
  return false
}

function markdownCommandCandidates(markdown) {
  const candidates = []
  let fence = null
  for (const sourceLine of markdown.split(/\r?\n/u)) {
    let line = sourceLine
    while (/^ {0,3}>[ \t]?/u.test(line)) line = line.replace(/^ {0,3}>[ \t]?/u, '')
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/u)
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = null
      } else if (fence.capturesCommands) {
        candidates.push(line)
      }
      continue
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)
    if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
      const language = opening[2].trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? ''
      fence = {
        marker: opening[1][0],
        length: opening[1].length,
        capturesCommands: shellFenceLanguages.has(language),
      }
      continue
    }

    const indented = line.match(/^(?: {4}|\t)(.*)$/u)
    if (indented) {
      candidates.push(indented[1])
      continue
    }

    for (const match of line.matchAll(/(`+)([^`\n]*?)\1/gu)) {
      if (looksLikeInlineShellCommand(match[2])) candidates.push(match[2])
    }
  }
  return candidates.map((candidate) => candidate
    .trim()
    .replace(/^(?:[-*+]\s+|\$\s+|>\s+)/u, ''))
    .filter(Boolean)
}

function shellCommandSegments(candidate) {
  return candidate
    .split(/\s*(?:&&|\|\||[;|])\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function assertRunnerCommands(skill) {
  for (const candidate of markdownCommandCandidates(skill)) {
    for (const command of shellCommandSegments(candidate)) {
      const executable = command.split(/\s+/u, 1)[0]
      if (executable === 'aw') {
        if (!allowedAwCommands.some((pattern) => pattern.test(command))) {
          fail(`Runner final SKILL.md contains an undocumented aw command: ${command}`)
        }
        continue
      }
      if (executable === 'aw-skill-eval') {
        if (!allowedEvalCommands.some((pattern) => pattern.test(command))) {
          fail(`Runner final SKILL.md contains an undocumented aw-skill-eval command: ${command}`)
        }
        continue
      }
      fail(`Runner final SKILL.md shell commands must directly execute aw or aw-skill-eval: ${candidate}`)
    }
  }
}

function containsSchemaMarker(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSchemaMarker)
  if (Object.hasOwn(value, '$schema')) return true
  return Object.values(value).some(containsSchemaMarker)
}

export async function assertRunnerSkillBundle(skillRoot) {
  const canonicalRoot = await realpath(skillRoot).catch((error) => {
    fail(`Runner final Skill root is unavailable: ${error.message}`)
  })
  const rootInfo = await lstat(canonicalRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('Runner final Skill root must be a regular directory.')
  }

  const skill = await assertRegularFile(path.join(canonicalRoot, 'SKILL.md'), 'Runner final SKILL.md')
  await assertRegularFile(path.join(canonicalRoot, 'README.md'), 'Runner final README.md')
  await assertRegularFile(
    path.join(canonicalRoot, 'agents', 'openai.yaml'),
    'Runner final agents/openai.yaml',
  )
  const entries = await collectBundleFiles(canonicalRoot)

  for (const entry of entries) {
    if (path.extname(entry).toLowerCase() === '.json') {
      const value = JSON.parse(await readFile(path.join(canonicalRoot, entry), 'utf8'))
      if (containsSchemaMarker(value)) {
        fail(`Runner final Skill contains a machine schema marker: ${entry}`)
      }
    }
  }

  assertRunnerCommands(skill)

  return {
    minimumPackageVersion: parseMinimumPackageVersion(skill),
    files: entries,
  }
}

export function assertCompatibleRuntimeVersion({
  packageVersion,
  minimumPackageVersion,
}) {
  parseStrictSemVer(packageVersion, 'agent-skill-eval package version')
  parseStrictSemVer(minimumPackageVersion, 'Runner agent-skill-eval minimum version')
  if (compareStrictSemVer(packageVersion, minimumPackageVersion) < 0) {
    fail(`agent-skill-eval ${packageVersion} does not satisfy Runner >= ${minimumPackageVersion}.`)
  }
}

export async function verifyEvalRuntimeOwner() {
  const evalRoot = path.join(repositoryRoot, 'packages', 'agent-skill-eval')
  const evalApiPath = path.join(evalRoot, 'dist', 'index.js')
  const closureValidatorPath = path.join(
    repositoryRoot,
    'packages',
    'cli',
    'dist',
    'src',
    'utils',
    'runtime-skill-closure.js',
  )
  const runnerRoot = path.join(
    repositoryRoot,
    'packages',
    'cli',
    'plugins-dist',
    'plugins',
    'aw-skill-eval-runner',
  )
  const packageJson = JSON.parse(await readFile(path.join(evalRoot, 'package.json'), 'utf8'))
  if (packageJson.name !== '@lesliechan721/agent-skill-eval') {
    fail('Built Eval runtime package identity must be @lesliechan721/agent-skill-eval.')
  }
  const evalApi = await import(pathToFileURL(evalApiPath).href)

  const schemas = []
  for (const { name, version } of canonicalSchemas) {
    const canonical = await evalApi.getSchema(name)
    if (canonical?.properties?.version?.const !== version) {
      fail(`${name} canonical version must be ${version}.`)
    }
    const digest = await evalApi.getSchemaDigest(name)
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail(`${name} canonical schema digest is unreadable.`)
    if (digest !== sha256(JSON.stringify(canonical))) fail(`${name} canonical schema digest does not match its bytes.`)
    schemas.push({ name, version, digest })
  }

  const closureValidator = await import(pathToFileURL(closureValidatorPath).href)
  const runnerBundles = []
  for (const platform of ['claude', 'codex']) {
    const skillRoot = path.join(runnerRoot, platform, 'skills', 'run-aw-skill-evals')
    await closureValidator.validateRuntimeSkillClosure(skillRoot)
    const result = await assertRunnerSkillBundle(skillRoot)
    runnerBundles.push({
      platform,
      skillRoot: path.relative(repositoryRoot, skillRoot),
      localClosureValidated: true,
      ...result,
    })
  }
  if (runnerBundles[0].minimumPackageVersion !== runnerBundles[1].minimumPackageVersion) {
    fail('Claude and Codex Runner bundles declare different agent-skill-eval dependency ranges.')
  }

  assertCompatibleRuntimeVersion({
    packageVersion: packageJson.version,
    minimumPackageVersion: runnerBundles[0].minimumPackageVersion,
  })

  return {
    schemaVersion: 1,
    invariant: 'awSkillEvalExecutionOwner',
    awSkillEvalExecutionOwner: {
      package: packageJson.name,
      version: packageJson.version,
    },
    schemas,
    runnerBundles,
    cleanTarballBins: {
      coveredBy: 'packages/cli/tests/smoke/pack-smoke.test.ts',
      bins: ['aw', 'aw-skill-eval'],
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  verifyEvalRuntimeOwner()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
