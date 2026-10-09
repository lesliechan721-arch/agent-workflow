import { createHash } from 'node:crypto'
import path from 'node:path'

import fs from 'fs-extra'

import { assertHostReadContainmentAvailable, type CodexEvalProcessManagementEvidence } from './codex-eval-app-server.js'
import { createCodexEvalTemporaryRoot, redactCodexEvalValue, type CodexEvalRuntimeConfig } from './codex-eval-runtime-config.js'
import { applyCodexEvalGitIsolation } from './codex-eval-isolation.js'
import { runProviderProcess } from './process.js'
import type { ProcessTreeDependencies } from './process-tree.js'

export type WorkflowFixtureValue = null | boolean | number | string | WorkflowFixtureValue[] | { [key: string]: WorkflowFixtureValue }

/** Commands are fixed Eval assets. Subject messages never select an action. */
export interface WorkflowFixtureAction {
  command: readonly ['node', string]
  input: WorkflowFixtureValue
  pathPrepend?: string[]
}

export interface WorkflowFixtureReceipt {
  version: 1
  completed: true
  artifacts: string[]
  evidence: WorkflowFixtureValue
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  if (required.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} is missing a required field.`)
  if (Object.keys(value).some((key) => ![...required, ...optional].includes(key))) throw new Error(`${label} has an unknown field.`)
}

function relative(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1_024 || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('workflow fixture asset must be a normalized relative path.')
  }
  return value
}

function json(value: unknown, depth = 0): WorkflowFixtureValue {
  if (depth > 8) throw new Error('workflow fixture JSON depth limit exceeded.')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.length <= 128) return value.map((entry) => json(entry, depth + 1))
  const entries = Object.entries(object(value, 'workflow fixture JSON'))
  if (entries.length > 128) throw new Error('workflow fixture JSON field limit exceeded.')
  return Object.fromEntries(entries.map(([key, entry]) => [key, json(entry, depth + 1)]))
}

export function parseWorkflowFixtureAction(value: unknown): WorkflowFixtureAction {
  const action = object(value, 'workflow fixture action')
  exact(action, ['command', 'input'], ['pathPrepend'], 'workflow fixture action')
  if (!Array.isArray(action.command) || action.command.length !== 2 || action.command[0] !== 'node') {
    throw new Error('workflow fixture command must be ["node", relative fixture script].')
  }
  const input = json(action.input)
  if (Buffer.byteLength(JSON.stringify(input)) > 200_000) throw new Error('workflow fixture input byte limit exceeded.')
  let pathPrepend: string[] | undefined
  if (action.pathPrepend !== undefined) {
    if (!Array.isArray(action.pathPrepend) || action.pathPrepend.length > 8) throw new Error('workflow fixture pathPrepend has too many entries.')
    pathPrepend = action.pathPrepend.map(relative)
    if (new Set(pathPrepend).size !== pathPrepend.length) throw new Error('workflow fixture pathPrepend must be unique.')
  }
  return { command: ['node', relative(action.command[1])], input, ...(pathPrepend ? { pathPrepend } : {}) }
}

async function fixtureAsset(root: string, relativePath: string, directory = false): Promise<string> {
  let current = root
  for (const segment of relative(relativePath).split('/')) {
    current = path.join(current, segment)
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('workflow fixture assets must not contain symbolic links.')
  }
  const info = await fs.lstat(current)
  if (directory ? !info.isDirectory() : !info.isFile() || info.size > 1024 * 1024) throw new Error('workflow fixture asset kind or size is invalid.')
  if (directory) {
    for (const entry of await fs.readdir(current)) {
      const child = await fs.lstat(path.join(current, entry))
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) throw new Error('workflow fixture PATH tree contains an unsafe node.')
      if (child.isDirectory()) await fixtureAsset(root, `${relativePath}/${entry}`, true)
    }
  }
  return current
}

export async function validateWorkflowFixtureActions(actions: WorkflowFixtureAction[], fixtures: string): Promise<void> {
  for (const action of actions) {
    await fixtureAsset(fixtures, action.command[1])
    for (const directory of action.pathPrepend ?? []) await fixtureAsset(fixtures, directory, true)
  }
}

export async function runWorkflowFixtureAction(options: {
  action: WorkflowFixtureAction
  workspace: string
  fixtures: string
  output: string
  evalRoot: string
  sourceEnv: NodeJS.ProcessEnv
  runtime: CodexEvalRuntimeConfig
  timeoutMs: number
  signal?: AbortSignal
  processManagement: CodexEvalProcessManagementEvidence
  processTree?: ProcessTreeDependencies
  protectedEvalRoots?: readonly string[]
}): Promise<{ receipt: WorkflowFixtureReceipt; scriptSha256: string }> {
  await validateWorkflowFixtureActions([options.action], options.fixtures)
  const script = await fixtureAsset(options.fixtures, options.action.command[1])
  const scriptSha256 = createHash('sha256').update(await fs.readFile(script)).digest('hex')
  const temporaryRoot = await createCodexEvalTemporaryRoot('workflow-fixture-')
  const root = await fs.realpath(temporaryRoot.root)
  try {
    const environment: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'LANG', 'LC_ALL'] as const) if (options.sourceEnv[key] !== undefined) environment[key] = options.sourceEnv[key]
    environment.PATH = [...(options.action.pathPrepend ?? []).map((entry) => path.join(options.fixtures, entry)), environment.PATH ?? ''].join(path.delimiter)
    const env = applyCodexEvalGitIsolation({ ...environment, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), NO_COLOR: '1' })
    await Promise.all([fs.ensureDir(env.HOME!), fs.ensureDir(env.TMPDIR!)])
    const allowed = [options.workspace, options.fixtures, root, path.dirname(process.execPath), '/System', '/usr', '/bin', '/sbin', '/dev', '/Library/Developer/CommandLineTools']
    let profile = [
      '(version 1)', '(allow default)',
      // macOS executable startup needs the root directory; descendants remain restricted.
      `(deny file-read-data (require-all (require-not (literal "/")) ${allowed.map((entry) => `(require-not (subpath ${JSON.stringify(entry)}))`).join(' ')}))`,
      '(deny file-write*)',
      '(allow file-write* (literal "/dev/null"))', '(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
      ...[options.workspace, root].map((entry) => `(allow file-write* (subpath ${JSON.stringify(entry)}))`),
      `(deny file-read* (subpath ${JSON.stringify(options.output)}))`,
    ].join('\n')
    for (const entry of allowed) {
      for (let ancestor = path.dirname(entry); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
        profile += `\n(allow file-read-metadata (literal ${JSON.stringify(ancestor)}))`
      }
    }
    await assertHostReadContainmentAvailable(profile)
    const result = await runProviderProcess({
      executable: '/usr/bin/sandbox-exec', args: ['-p', profile, process.execPath, script], cwd: options.workspace, env,
      stdin: JSON.stringify({ version: 1, input: options.action.input, paths: { workspace: options.workspace, fixtures: options.fixtures } }),
      timeoutMs: options.timeoutMs, maxBufferBytes: 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}),
    }, {}, {
      containment: options.processManagement.mode === 'unmanaged-confirmed' ? 'unmanaged-confirmed' : 'verified-observed',
      ...(options.processManagement.mode === 'unmanaged-confirmed' ? {} : { processTree: options.processTree }),
    })
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled || result.maxBufferExceeded
      || (options.processManagement.mode !== 'unmanaged-confirmed' && !result.gradingEvidenceAccepted)) {
      throw new Error('workflow fixture action did not finish with confirmed process cleanup; no answer or grade was released.')
    }
    const value = object(JSON.parse(result.stdout), 'workflow fixture receipt')
    exact(value, ['version', 'completed', 'artifacts', 'evidence'], [], 'workflow fixture receipt')
    if (value.version !== 1 || value.completed !== true || !Array.isArray(value.artifacts) || value.artifacts.length > 64) {
      throw new Error('workflow fixture action returned an invalid factual receipt.')
    }
    const artifacts = value.artifacts.map(relative)
    for (const artifact of artifacts) await fixtureAsset(options.workspace, artifact)
    return redactCodexEvalValue({ receipt: { version: 1, completed: true, artifacts, evidence: json(value.evidence) }, scriptSha256 }, options.runtime)
  } finally {
    await temporaryRoot.cleanup()
  }
}
