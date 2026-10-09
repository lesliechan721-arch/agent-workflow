import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getSchema, parseWorkflowFixtureAction, validateJsonSchema, validateWorkflowFixtureActions } from '../../src/index.js'
import { runWorkflowFixtureAction } from '../../src/codex-workflow-fixtures.js'
import { parseCodexWorkflowRequest } from '../../src/codex-workflow.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workflow-fixture-test-')))
  roots.push(root)
  const workspace = path.join(root, 'subject')
  const fixtures = path.join(root, 'fixtures')
  const output = path.join(root, 'output')
  await Promise.all([mkdir(workspace), mkdir(fixtures), mkdir(output)])
  return { root, workspace, fixtures, output }
}

describe('Eval-owned workflow fixture actions', () => {
  // Value gate: trusted fixture references cannot escape the bound Eval fixture tree,
  // and fixture processes cannot receive model credentials or read foreign content.
  it('validates the public fixed Node tuple and rejects shell commands, path escape, and symlinks', async () => {
    const { workspace, fixtures } = await fixture()
    const action = { command: ['node', 'action.mjs'], input: { operation: 'release-files', args: { 'evidence/new.md': 'Actual new evidence.' } } }
    await writeFile(path.join(fixtures, 'action.mjs'), 'export const fixture = true;')
    expect(parseWorkflowFixtureAction(action)).toEqual(action)
    expect(validateJsonSchema(await getSchema('workflow-fixture-action'), action)).toEqual([])
    expect(validateJsonSchema(await getSchema('workflow-fixture-action'), { ...action, command: ['sh', 'action.mjs'] })).not.toEqual([])
    expect(() => parseWorkflowFixtureAction({ ...action, command: ['node', '../escape.mjs'] })).toThrow('relative')
    expect(() => parseWorkflowFixtureAction({ ...action, command: ['node', '/absolute.mjs'] })).toThrow('relative')
    expect(() => parseWorkflowFixtureAction({ ...action, command: ['node', 'action.mjs', 'extra'] })).toThrow('command')
    await symlink(path.join(fixtures, 'action.mjs'), path.join(fixtures, 'link.mjs'))
    await expect(validateWorkflowFixtureActions([parseWorkflowFixtureAction({ ...action, command: ['node', 'link.mjs'] })], fixtures)).rejects.toThrow('symbolic')
    const request = {
      version: 1, prompt: 'Bound task.', sandbox: 'read-only', model: null, developerInstructions: 'Canonical worker.', roles: [],
      multiAgent: { protocol: 'v2', maxDepth: 1, hideSpawnAgentMetadata: false, exposeSpawnAgentModelOverrides: false },
      evaluation: { artifacts: [], checks: [{ name: 'facts', criterion: 'Use real evidence.' }], interactions: [], setupActions: [action] },
    }
    await expect(parseCodexWorkflowRequest(request, [], workspace)).rejects.toThrow('fixture root')
    await expect(parseCodexWorkflowRequest(request, [], workspace, fixtures)).resolves.toMatchObject({ evaluation: { setupActions: [action] } })
  })

  it.skipIf(process.platform !== 'darwin')('runs a credential-free fixture behind the actual file boundary and records factual side effects', async () => {
    const { root, workspace, fixtures, output } = await fixture()
    const foreignRoot = path.join(root, 'foreign-private')
    const foreign = path.join(foreignRoot, 'secret.txt')
    const hidden = path.join(output, 'oracle.txt')
    await mkdir(foreignRoot)
    await Promise.all([writeFile(foreign, 'foreign'), writeFile(hidden, 'hidden')])
    await writeFile(path.join(fixtures, 'action.mjs'), [
      "import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';",
      "import { execFileSync } from 'node:child_process';",
      "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "assert.equal(request.version, 1); assert.equal(request.input.operation, 'release-files');",
      "assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.CODEX_HOME, undefined); assert.equal(process.env.UNTRUSTED_SECRET, undefined);",
      `assert.throws(() => fs.readFileSync(${JSON.stringify(foreign)}), (error) => ['EPERM','EACCES'].includes(error.code));`,
      `assert.throws(() => fs.readdirSync(${JSON.stringify(foreignRoot)}), (error) => ['EPERM','EACCES'].includes(error.code));`,
      `assert.throws(() => fs.readFileSync(${JSON.stringify(hidden)}), (error) => ['EPERM','EACCES'].includes(error.code));`,
      `assert.throws(() => fs.writeFileSync(${JSON.stringify(foreign)}, 'changed'), (error) => ['EPERM','EACCES'].includes(error.code));`,
      "execFileSync('/usr/bin/git', ['init', '--quiet', request.paths.workspace], { cwd: request.paths.workspace, stdio: 'pipe' });",
      "assert.match(fs.readFileSync(path.join(request.paths.workspace, '.git/HEAD'), 'utf8'), /^ref: refs\\/heads\\//u);",
      "fs.mkdirSync(path.join(request.paths.workspace, 'evidence')); fs.writeFileSync(path.join(request.paths.workspace, 'evidence/new.md'), request.input.content);",
      "process.stdout.write(JSON.stringify({ version: 1, completed: true, artifacts: ['evidence/new.md', '.git/HEAD'], evidence: { operation: request.input.operation, filesWritten: 1, gitPrompt: process.env.GIT_TERMINAL_PROMPT, gitInitialized: true } }));",
    ].join('\n'))
    const result = await runWorkflowFixtureAction({
      action: parseWorkflowFixtureAction({ command: ['node', 'action.mjs'], input: { operation: 'release-files', content: 'Actual later evidence.' } }),
      workspace, fixtures, output, evalRoot: root,
      sourceEnv: { PATH: process.env.PATH, HOME: os.homedir(), CODEX_HOME: '/foreign-codex', OPENAI_API_KEY: 'never-forward', UNTRUSTED_SECRET: 'never-forward' },
      runtime: { inherited: false, model: null, modelProvider: 'openai', credentialSource: 'none', configToml: '', providerEnvironment: {}, sourceCodexHome: root, copyOpenAiAuth: false, sensitiveEnvironmentNames: [], sensitiveValues: ['never-forward'], evidenceDigest: `sha256:${'1'.repeat(64)}` },
      timeoutMs: 5_000,
      processManagement: { mode: 'managed', inspectionAvailable: true, userAcknowledged: false, descendantCleanupGuaranteed: false, limitation: 'Observed cooperative process cleanup.' },
    })
    expect(result.receipt).toEqual({ version: 1, completed: true, artifacts: ['evidence/new.md', '.git/HEAD'], evidence: { operation: 'release-files', filesWritten: 1, gitPrompt: '0', gitInitialized: true } })
    expect(result.scriptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(path.join(workspace, 'evidence/new.md'), 'utf8')).toBe('Actual later evidence.')
    expect(await readFile(path.join(workspace, '.git/HEAD'), 'utf8')).toMatch(/^ref: refs\/heads\//u)
    expect(await readFile(foreign, 'utf8')).toBe('foreign')
  })
})
