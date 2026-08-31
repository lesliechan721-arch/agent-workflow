import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeAwCapabilitySetDigest } from '@lesliechan721/aw-plugin-core/manifest'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCliEntry } from '../helpers/cli-entry.js'

const tempDirs: string[] = []

function fixturePath(...segments: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', ...segments)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)))
})

describe('AW capability CLI commands', () => {
  it('emits one self describe JSON object', async () => {
    const result = await runCliEntry(['self', 'describe', '--json'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      command: 'self:describe',
      awVersion: expect.any(String),
      coreVersion: expect.any(String),
      capabilities: expect.arrayContaining(['aw.self-check.v1', 'aw.skill-eval.v2']),
      capabilitySetDigest: expect.stringMatching(/^sha256:/u),
    })
  })

  it('returns a single failure JSON object and exit 1 for missing capabilities', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-check-missing-'))
    tempDirs.push(root)
    const capabilities = ['aw.future-feature.v3']
    await fs.writeJson(path.join(root, 'aw-plugin-requirements.json'), {
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'future', version: '1.0.0' },
      requiredCapabilities: capabilities,
      digest: computeAwCapabilitySetDigest(capabilities),
    })
    const result = await runCliEntry(['self', 'check', '--from', root, '--json'], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      command: 'self:check',
      ok: false,
      plugin: { name: 'future' },
      missingCapabilities: capabilities,
    })
  })

  it('returns a single failure JSON object when no candidate exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-check-empty-'))
    tempDirs.push(root)
    const result = await runCliEntry(['self', 'check', '--from', root, '--json'], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      command: 'self:check', ok: false, source: null,
      error: expect.stringContaining('No aw-plugin-requirements.json'),
    })
  })

  it.each([
    ['source', undefined],
    ['bundle', '1.0.0-beta.1'],
  ])('discovers and resolves a %s manifest candidate', async (_mode, version) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-check-manifest-'))
    tempDirs.push(root)
    const pluginRoot = path.join(root, 'plugin')
    await fs.copy(fixturePath('repo-template', 'plugins', 'git-commit'), pluginRoot)
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json')
    const manifest = await fs.readJson(manifestPath)
    if (version) manifest.version = version
    await fs.writeJson(manifestPath, manifest, { spaces: 2 })

    const result = await runCliEntry([
      'self', 'check', '--from', path.join(pluginRoot, 'skills', 'commit', 'SKILL.md'), '--json',
    ], { cwd: root })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      command: 'self:check',
      ok: true,
      source: { kind: 'manifest', path: manifestPath },
      plugin: { name: 'git-commit', version: version ?? '0.1.0' },
      requiredCapabilities: expect.arrayContaining(['aw.plugin-skills.v1']),
      missingCapabilities: [],
    })
  })

  it('keeps an unmapped inline Markdown command advisory during self check', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-check-unmapped-'))
    tempDirs.push(root)
    const pluginRoot = path.join(root, 'plugin')
    await fs.copy(fixturePath('repo-template', 'plugins', 'git-commit'), pluginRoot)
    await fs.appendFile(
      path.join(pluginRoot, 'skills', 'commit', 'SKILL.md'),
      '\nRun `aw unknown command` when needed.\n',
    )

    const result = await runCliEntry(['self', 'check', '--from', pluginRoot, '--json'], { cwd: root })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      command: 'self:check',
      ok: true,
      missingCapabilities: [],
      observations: expect.arrayContaining([
        expect.objectContaining({
          code: 'aw-command-unmapped',
          blocking: false,
          provenance: 'inline-code',
        }),
      ]),
    })
  })

  it('inspects source requirements without changing plugin files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-requirements-cli-'))
    tempDirs.push(root)
    await fs.copy(fixturePath('repo-template'), root)
    const pluginRoot = path.join(root, 'plugins', 'git-commit')
    const before = await fs.readFile(path.join(pluginRoot, '.agents-plugin', 'plugin.json'))
    const result = await runCliEntry([
      'plugin', 'requirements', 'plugins/git-commit', '--workspace-root', root, '--json',
    ], { cwd: root })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      command: 'plugin:requirements',
      plugin: { name: 'git-commit' },
      workspaceRoot: await fs.realpath(root),
      workspaceRootResolvedFrom: 'explicit',
      declared: [],
      derived: expect.any(Array),
      detected: expect.any(Array),
      effective: expect.any(Array),
      unsupportedByCurrentAw: expect.any(Array),
      observations: expect.any(Array),
    })
    expect(result.parseJsonStdout()).not.toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({ code: 'aw-command-unmapped' }),
      ]),
    })
    expect(await fs.readFile(path.join(pluginRoot, '.agents-plugin', 'plugin.json'))).toEqual(before)
    expect(await fs.pathExists(path.join(pluginRoot, 'aw-plugin-requirements.json'))).toBe(false)
  })

  it('projects an undeclared Hook AW command into effective requirements before the support gate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-hook-requirements-'))
    tempDirs.push(root)
    await fs.copy(fixturePath('repo-template'), root)
    const pluginRoot = path.join(root, 'plugins', 'git-commit')
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json')
    const manifest = await fs.readJson(manifestPath)
    manifest.extensions.hooks[0].command = 'aw catalog publish'
    await fs.writeJson(manifestPath, manifest, { spaces: 2 })

    const requirements = await runCliEntry([
      'plugin', 'requirements', pluginRoot, '--workspace-root', root, '--json',
    ], { cwd: root })
    expect(requirements.exitCode).toBe(0)
    expect(requirements.parseJsonStdout()).toMatchObject({
      declared: [],
      detected: expect.arrayContaining(['aw.catalog-publication.v1']),
      effective: expect.arrayContaining(['aw.catalog-publication.v1']),
      unsupportedByCurrentAw: [],
    })

    manifest.requires = { aw: { capabilities: ['aw.future-feature.v3'] } }
    await fs.writeJson(manifestPath, manifest, { spaces: 2 })
    const validation = await runCliEntry([
      'plugin', 'validate', pluginRoot, '--workspace-root', root, '--json',
    ], { cwd: root })
    expect(validation.exitCode).toBe(1)
    expect(validation.stderr).toBe('')
    expect(validation.parseJsonStdout()).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('awCapabilityUnsupported'),
      ]),
    })
  })

  it('adds and removes a declared capability without changing the plugin version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-requirements-mutate-'))
    tempDirs.push(root)
    await fs.copy(fixturePath('repo-template'), root)
    const manifestPath = path.join(root, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')

    const added = await runCliEntry([
      'plugin', 'requirements', 'plugins/git-commit', '--workspace-root', root,
      '--add', 'aw.future-feature.v3', '--json',
    ], { cwd: root })
    expect(added.exitCode).toBe(0)
    expect(added.parseJsonStdout()).toMatchObject({
      mutation: { action: 'add', capability: 'aw.future-feature.v3', changed: true },
      declared: ['aw.future-feature.v3'],
      unsupportedByCurrentAw: ['aw.future-feature.v3'],
    })
    await expect(fs.readJson(manifestPath)).resolves.toMatchObject({
      version: '0.1.0',
      requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
    })

    const removed = await runCliEntry([
      'plugin', 'requirements', 'plugins/git-commit', '--workspace-root', root,
      '--remove', 'aw.future-feature.v3', '--json',
    ], { cwd: root })
    expect(removed.exitCode).toBe(0)
    expect(removed.parseJsonStdout()).toMatchObject({
      mutation: { action: 'remove', capability: 'aw.future-feature.v3', changed: true },
      declared: [],
    })
    await expect(fs.readJson(manifestPath)).resolves.toMatchObject({ version: '0.1.0' })
  })

  it('emits one blocking plugin requirements JSON object with exit 1 and empty stderr', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-requirements-blocking-'))
    tempDirs.push(root)
    await fs.copy(fixturePath('repo-template'), root)
    const pluginRoot = path.join(root, 'plugins', 'git-commit')
    await fs.appendFile(
      path.join(pluginRoot, 'skills', 'commit', 'SKILL.md'),
      '\naw unknown command\n',
    )

    const result = await runCliEntry(['plugin', 'requirements', pluginRoot, '--json'], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      command: 'plugin:requirements',
      observations: expect.arrayContaining([
        expect.objectContaining({ code: 'aw-command-unmapped', blocking: true }),
      ]),
    })
  })

  it('emits one plugin requirements error JSON object with exit 1 and empty stderr', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-requirements-error-'))
    tempDirs.push(root)
    await fs.copy(fixturePath('repo-template'), root)
    const pluginRoot = path.join(root, 'plugins', 'git-commit')
    await fs.writeFile(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), '{broken', 'utf8')

    const result = await runCliEntry(['plugin', 'requirements', pluginRoot, '--json'], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      command: 'plugin:requirements',
      ok: false,
      error: expect.any(String),
    })
  })

  it('resolves only canonical Workspace inventory targets before inspection or mutation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-requirements-boundary-'))
    tempDirs.push(root)
    const workspaceRoot = path.join(root, 'workspace')
    await fs.copy(fixturePath('repo-template'), workspaceRoot)
    const pluginRoot = path.join(workspaceRoot, 'plugins', 'git-commit')
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json')
    const before = await fs.readFile(manifestPath)

    const invalidRoot = path.join(root, 'invalid-workspace')
    await fs.ensureDir(invalidRoot)
    await fs.writeFile(path.join(invalidRoot, '.aw-workspace.json'), '{broken', 'utf8')
    const invalidExplicit = await runCliEntry([
      'plugin', 'requirements', pluginRoot, '--workspace-root', invalidRoot,
      '--add', 'aw.future-feature.v3', '--json',
    ], { cwd: workspaceRoot })
    expect(invalidExplicit.exitCode).toBe(1)
    expect(invalidExplicit.parseJsonStdout()).toMatchObject({
      command: 'plugin:requirements',
      ok: false,
      error: expect.stringContaining('Invalid Catalog Workspace marker'),
    })
    expect(await fs.readFile(manifestPath)).toEqual(before)

    const outsidePlugin = path.join(root, 'outside-plugin')
    await fs.copy(fixturePath('repo-template', 'plugins', 'git-commit'), outsidePlugin)
    const outside = await runCliEntry([
      'plugin', 'requirements', outsidePlugin, '--workspace-root', workspaceRoot, '--json',
    ], { cwd: workspaceRoot })
    expect(outside.exitCode).toBe(1)
    expect(outside.parseJsonStdout()).toMatchObject({
      command: 'plugin:requirements',
      ok: false,
      error: expect.stringContaining('not a canonical plugin'),
    })

    const deepCwd = path.join(pluginRoot, 'skills', 'commit')
    const discovered = await runCliEntry([
      'plugin', 'requirements', '../..', '--json',
    ], { cwd: deepCwd })
    expect(discovered.exitCode).toBe(0)
    expect(discovered.parseJsonStdout()).toMatchObject({
      pluginDirectory: await fs.realpath(pluginRoot),
      workspaceRoot: await fs.realpath(workspaceRoot),
      workspaceRootResolvedFrom: 'workspace-marker',
    })

    await fs.writeFile(path.join(pluginRoot, '.aw-workspace.json'), '{broken', 'utf8')
    const damagedNearest = await runCliEntry([
      'plugin', 'requirements', pluginRoot, '--json',
    ], { cwd: workspaceRoot })
    expect(damagedNearest.exitCode).toBe(1)
    expect(damagedNearest.parseJsonStdout()).toMatchObject({
      command: 'plugin:requirements',
      ok: false,
      error: expect.stringContaining('Invalid Catalog Workspace marker'),
    })
    expect(await fs.readFile(manifestPath)).toEqual(before)
  })
})
