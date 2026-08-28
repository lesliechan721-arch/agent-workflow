import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-context-')))
  roots.push(root)
  return root
}

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (text: string) => { stdout += text },
      stderr: (text: string) => { stderr += text },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function initializeWorkspace(root: string, plugin = 'context-demo'): Promise<void> {
  await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io })
  await runCli([
    'plugin', 'init', plugin, '--description', 'Catalog context fixture.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: capture().io })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Catalog context and unified inference', () => {
  it('reports initialization and unavailable Git facts outside a repository', async () => {
    const root = await createRoot()
    const output = capture()
    expect(await runCli(['catalog', 'context', '--json'], { cwd: root, io: output.io })).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      workspace: { found: false, root: null, identity: null, resolvedFrom: null },
      initialization: { suggestedRoot: root, resolvedFrom: 'cwd' },
      git: { repositoryRoot: null, sourceHead: null, clean: null, remotes: [] },
      publication: { remote: null, remoteResolvedFrom: 'unavailable', branch: 'catalog' },
      issues: [{ code: 'workspaceUnavailable', blocking: false }],
    })
  })

  it('initializes at the Git worktree root and resolves authoring commands from a deep plugin directory', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'packages', 'nested')
    await fs.ensureDir(deep)
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    const initialized = capture()

    expect(await runCli(['catalog', 'init', '--json'], { cwd: deep, io: initialized.io })).toBe(0)
    expect(JSON.parse(initialized.stdout())).toMatchObject({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'git-worktree',
    })
    await runCli([
      'plugin', 'init', 'deep-demo', '--description', 'Deep plugin fixture.',
      '--skill-name', 'deep-skill', '--skill-description', 'Use this Skill for deep discovery tests.',
      '--skill-short-description', 'Discover a deep Catalog root.',
    ], { cwd: deep, io: capture().io })
    const pluginRoot = path.join(root, 'plugins', 'deep-demo')
    const skillPath = path.join(pluginRoot, 'skills', 'deep-skill', 'SKILL.md')
    await fs.writeFile(skillPath, (await fs.readFile(skillPath, 'utf8')).replaceAll('TODO', 'Implemented'))
    const nestedPluginDirectory = path.join(pluginRoot, 'skills', 'deep-skill', 'references')
    await fs.ensureDir(nestedPluginDirectory)
    const version = capture()
    const versionExitCode = await runCli(['catalog', 'version', '--json'], {
      cwd: nestedPluginDirectory,
      io: version.io,
    })
    expect(versionExitCode, version.stderr()).toBe(0)
    expect(JSON.parse(version.stdout())).toMatchObject({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'workspace-marker',
    })
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ], { cwd: root })
    const validation = capture()
    const validationExitCode = await runCli(['plugin', 'validate', pluginRoot, '--json'], {
      cwd: nestedPluginDirectory,
      io: validation.io,
    })
    expect(validationExitCode, `${validation.stdout()}\n${validation.stderr()}`).toBe(0)
  })

  it('resolves plugin validate dot from the original plugin working directory', async () => {
    const root = await createRoot()
    await initializeWorkspace(root, 'validate-dot')
    const pluginRoot = path.join(root, 'plugins', 'validate-dot')
    const output = capture()

    expect(await runCli(['plugin', 'validate', '.', '--json'], {
      cwd: pluginRoot,
      io: output.io,
    })).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: true,
      pluginDirectory: pluginRoot,
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'workspace-marker',
    })
    expect(output.stderr()).toBe('')
  })

  it('reports a read-only dirty context with origin and the catalog default branch', async () => {
    const root = await createRoot()
    const remote = await createRoot()
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await execFileAsync('git', ['init', '--bare', '--quiet'], { cwd: remote })
    await initializeWorkspace(root)
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root })
    await fs.outputFile(path.join(root, 'dirty.txt'), 'dirty\n')
    const before = (await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })).stdout
    const output = capture()

    expect(await runCli(['catalog', 'context', '--json'], { cwd: root, io: output.io })).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 1,
      command: 'catalog:context',
      toolchain: { capabilities: expect.arrayContaining(['aw.catalog-context.v1']), digest: expect.stringMatching(/^sha256:/u) },
      workspace: { found: true, root, resolvedFrom: 'workspace-marker' },
      git: { repositoryRoot: root, clean: false, remotes: ['origin'] },
      publication: {
        remote: 'origin',
        remoteResolvedFrom: 'origin',
        branch: 'catalog',
        branchResolvedFrom: 'default',
        ambiguous: false,
      },
      developmentSource: { existingSourceId: null, active: false },
    })
    expect(output.stderr()).toBe('')
    expect((await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })).stdout).toBe(before)
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('')
  })

  it('does not change Git index bytes during context or static status', async () => {
    const root = await createRoot()
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await initializeWorkspace(root, 'index-demo')
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ], { cwd: root })
    const indexPath = path.join(root, '.git', 'index')
    const before = await fs.readFile(indexPath)

    expect(await runCli(['catalog', 'context', '--json'], { cwd: root, io: capture().io })).toBe(0)
    expect(await runCli(['catalog', 'status', '--json'], { cwd: root, io: capture().io })).toBe(0)
    await expect(fs.readFile(indexPath)).resolves.toEqual(before)
  })

  it('returns one JSON failure and no stderr for invalid nearest-marker command resolution', async () => {
    const root = await createRoot()
    await initializeWorkspace(root, 'invalid-nearest')
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'plugins', 'invalid-nearest')
    await fs.ensureDir(deep)
    await fs.writeJson(path.join(nested, '.aw-workspace.json'), { schemaVersion: 99 })

    const contextOutput = capture()
    expect(await runCli(['catalog', 'context', '--json'], {
      cwd: deep,
      io: contextOutput.io,
    })).toBe(1)
    expect(JSON.parse(contextOutput.stdout())).toMatchObject({
      schemaVersion: 1,
      command: 'catalog:context',
      initialization: { suggestedRoot: null, resolvedFrom: null },
      issues: [{ code: 'workspaceInvalid', blocking: true }],
    })
    expect(contextOutput.stderr()).toBe('')

    for (const command of [
      ['plugin', 'validate', '.', '--json'],
      ['plugin', 'status', 'invalid-nearest', '--json'],
      ['plugin', 'remove', 'invalid-nearest', '--yes', '--json'],
    ]) {
      const output = capture()
      expect(await runCli(command, { cwd: deep, io: output.io })).toBe(1)
      expect(JSON.parse(output.stdout())).toMatchObject({ ok: false })
      expect(output.stderr()).toBe('')
    }
  })

  it('uses a sole remote and reports multiple remotes without origin as ambiguous', async () => {
    const root = await createRoot()
    const first = await createRoot()
    const second = await createRoot()
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await initializeWorkspace(root)
    const unavailable = capture()
    await runCli(['catalog', 'context', '--json'], { cwd: root, io: unavailable.io })
    expect(JSON.parse(unavailable.stdout()).publication).toMatchObject({
      remote: null, remoteResolvedFrom: 'unavailable', ambiguous: false,
    })
    await execFileAsync('git', ['remote', 'add', 'upstream', first], { cwd: root })
    const sole = capture()
    await runCli(['catalog', 'context', '--json'], { cwd: root, io: sole.io })
    expect(JSON.parse(sole.stdout()).publication).toMatchObject({
      remote: 'upstream', remoteResolvedFrom: 'sole-remote', ambiguous: false,
    })

    await execFileAsync('git', ['remote', 'add', 'mirror', second], { cwd: root })
    const ambiguous = capture()
    await runCli(['catalog', 'context', '--json'], { cwd: root, io: ambiguous.io })
    expect(JSON.parse(ambiguous.stdout()).publication).toMatchObject({
      remote: null, remoteResolvedFrom: 'ambiguous', ambiguous: true,
    })
    const explicit = capture()
    await runCli(['catalog', 'context', '--remote', 'mirror', '--branch', 'preview', '--json'], {
      cwd: root,
      io: explicit.io,
    })
    expect(JSON.parse(explicit.stdout()).publication).toMatchObject({
      remote: 'mirror', remoteResolvedFrom: 'explicit', branch: 'preview', branchResolvedFrom: 'explicit',
    })
  })

  it('reports absent, current, stale, and invalid development snapshot evidence without rebuilding', async () => {
    const root = await createRoot()
    await initializeWorkspace(root, 'snapshot-demo')
    const status = async () => {
      const output = capture()
      expect(await runCli(['catalog', 'status', '--json'], { cwd: root, io: output.io })).toBe(0)
      return JSON.parse(output.stdout())
    }
    expect((await status()).snapshot).toMatchObject({ state: 'absent', valid: false })
    await runCli(['catalog', 'build', '--json'], { cwd: root, io: capture().io })
    expect((await status()).snapshot).toMatchObject({
      state: 'current', valid: true, sourceIdentityMatches: true,
      catalogVersion: '0.1.0', snapshotDigest: expect.stringMatching(/^sha256:/u),
    })
    await fs.appendFile(path.join(root, 'plugins', 'snapshot-demo', 'README.md'), 'changed\n')
    expect((await status()).snapshot).toMatchObject({ state: 'stale', valid: true, sourceIdentityMatches: false })
    await fs.writeFile(path.join(root, '.aw', 'catalog', '.aw-generated.json'), '{invalid')
    expect((await status()).snapshot).toMatchObject({
      state: 'invalid', valid: false, sourceIdentityMatches: null, snapshotDigest: null,
    })
  })
})
