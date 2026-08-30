import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { findNearestCatalogWorkspaceRoot } from '../../src/catalog-workspace-resolution.js'
import { readCatalogWorkspaceMarker } from '../../src/workspace.js'

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

    await expect(findNearestCatalogWorkspaceRoot({ from: deep })).resolves.toBe(root)
  })

  it('returns null when no ancestor has a marker', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'plugins', 'demo')
    await fs.ensureDir(deep)

    await expect(findNearestCatalogWorkspaceRoot({ from: deep })).resolves.toBeNull()
  })

  it('fails at an invalid nearest marker instead of crossing it', async () => {
    const root = await createRoot()
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'plugins', 'demo')
    await fs.ensureDir(deep)
    await writeMarker(root)
    await fs.writeJson(path.join(nested, '.aw-workspace.json'), { schemaVersion: 99 })

    await expect(findNearestCatalogWorkspaceRoot({ from: deep }))
      .rejects.toThrow('Invalid Catalog Workspace marker.')
  })

  it('fails at a symbolic-link nearest marker instead of crossing it', async () => {
    if (process.platform === 'win32') return
    const root = await createRoot()
    const nested = path.join(root, 'nested')
    const deep = path.join(nested, 'plugins', 'demo')
    await fs.ensureDir(deep)
    await writeMarker(root)
    await fs.symlink(path.join(root, 'missing-marker.json'), path.join(nested, '.aw-workspace.json'))

    await expect(findNearestCatalogWorkspaceRoot({ from: deep }))
      .rejects.toThrow(`Catalog Workspace marker must be a regular non-symbolic-link file: ${path.join(nested, '.aw-workspace.json')}`)
  })

  it('uses the formal marker reader for validation', async () => {
    const root = await createRoot()
    const deep = path.join(root, 'plugins', 'demo')
    await fs.ensureDir(deep)
    await fs.writeJson(path.join(root, '.aw-workspace.json'), {
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: '',
    })

    await expect(readCatalogWorkspaceMarker(root)).rejects.toThrow('Invalid Catalog Workspace marker.')
    await expect(findNearestCatalogWorkspaceRoot({ from: deep })).rejects.toThrow('Invalid Catalog Workspace marker.')
  })
})
