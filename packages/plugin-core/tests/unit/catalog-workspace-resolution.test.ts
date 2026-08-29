import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveCatalogWorkspaceRoot } from '../../src/catalog-workspace-resolution.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-workspace-resolution-')))
  roots.push(root)
  return root
}

async function writeMarker(root: string, workspaceIdentity = 'workspace-id'): Promise<void> {
  await fs.writeJson(path.join(root, '.aw-workspace.json'), {
    schemaVersion: 1,
    kind: 'aw-catalog-workspace',
    workspaceIdentity,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Catalog Workspace resolution', () => {
  it('uses the nearest valid ancestor from a deep plugin Skill directory', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'plugins', 'demo', 'skills', 'author', 'references')
    await fs.ensureDir(deep)
    await writeMarker(root)

    await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'existing' })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'workspace-marker',
    })
  })

  it('fails at an invalid nearest marker instead of crossing it', async () => {
    const root = await createRoot()
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'plugins', 'demo')
    await fs.ensureDir(deep)
    await writeMarker(root)
    await fs.writeJson(path.join(nested, '.aw-workspace.json'), { schemaVersion: 99 })

    await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'existing' }))
      .rejects.toThrow(`Invalid Catalog Workspace marker: ${path.join(nested, '.aw-workspace.json')}`)
  })

  it('fails at a symbolic-link nearest marker instead of crossing it', async () => {
    if (process.platform === 'win32') return
    const root = await createRoot()
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'plugins', 'demo')
    await fs.ensureDir(deep)
    await writeMarker(root)
    await fs.symlink(path.join(root, 'missing-marker.json'), path.join(nested, '.aw-workspace.json'))

    await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'existing' }))
      .rejects.toThrow(`Invalid Catalog Workspace marker: ${path.join(nested, '.aw-workspace.json')}`)
  })

  it('suggests the Git worktree root for initialization without an existing workspace', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'packages', 'demo')
    await fs.ensureDir(deep)
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })

    await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'initialize' })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'git-worktree',
    })
  })

  it('ignores injected repository-selection environment when discovering an initialization root', async () => {
    const selected = await createRoot()
    const actual = await createRoot()
    const deep = path.join(actual, 'packages', 'demo')
    await fs.ensureDir(deep)
    await Promise.all([
      execFileAsync('git', ['init', '--quiet'], { cwd: selected }),
      execFileAsync('git', ['init', '--quiet'], { cwd: actual }),
    ])
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    }
    process.env.GIT_DIR = path.join(selected, '.git')
    process.env.GIT_WORK_TREE = selected
    process.env.GIT_COMMON_DIR = path.join(selected, '.git')
    try {
      await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'initialize' })).resolves.toEqual({
        workspaceRoot: actual,
        workspaceRootResolvedFrom: 'git-worktree',
      })
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
