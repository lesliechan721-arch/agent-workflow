import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeCatalogWorkspace } from '@lesliechan721/aw-plugin-core'

import { resolveCatalogWorkspaceRoot } from '../../src/commands/catalog-workspace-resolution.js'

const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-workspace-resolution-')))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('CLI Catalog Workspace resolution', () => {
  it('validates and selects an explicit existing Workspace', async () => {
    const root = await createRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })

    await expect(resolveCatalogWorkspaceRoot({
      cwd: path.dirname(root),
      explicitRoot: root,
      mode: 'existing',
    })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'explicit',
    })
  })

  it('selects the nearest ancestor marker from a deep directory', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'plugins', 'demo', 'skills', 'author')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.ensureDir(deep)

    await expect(resolveCatalogWorkspaceRoot({ cwd: deep, mode: 'existing' })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'workspace-marker',
    })
  })

  it('uses the injected Git root only for initialization without a marker', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'packages', 'demo')
    await fs.ensureDir(deep)
    const gitRootRunner = vi.fn(async () => root)

    await expect(resolveCatalogWorkspaceRoot({
      cwd: deep,
      mode: 'initialize',
      env: { GIT_DIR: '/ignored' },
      gitRootRunner,
    })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'git-worktree',
    })
    expect(gitRootRunner).toHaveBeenCalledWith(deep, { GIT_DIR: '/ignored' })
  })

  it('falls back to cwd for initialization when Git has no root', async () => {
    const root = await createRoot()
    const gitRootRunner = vi.fn(async () => null)

    await expect(resolveCatalogWorkspaceRoot({
      cwd: root,
      mode: 'initialize',
      gitRootRunner,
    })).resolves.toEqual({
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'cwd',
    })
  })

  it('fails an existing-workspace command before invoking Git when no marker exists', async () => {
    const root = await createRoot()
    const gitRootRunner = vi.fn(async () => root)

    await expect(resolveCatalogWorkspaceRoot({
      cwd: root,
      mode: 'existing',
      gitRootRunner,
    })).rejects.toThrow(`Catalog Workspace marker not found from: ${root}`)
    expect(gitRootRunner).not.toHaveBeenCalled()
  })
})
