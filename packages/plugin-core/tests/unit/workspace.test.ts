import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildWorkspaceCatalog,
  buildWorkspacePlugin,
  initializePluginWorkspace,
  preparePublishedWorkspaceCatalog,
  readPluginWorkspace,
  resolveWorkspaceOutputPath,
  setWorkspaceCatalogVersion,
  validateCatalogSnapshot,
  validatePublishedCatalogSnapshot,
} from '../../src/workspace.js'
import { validateMarketplaceSourceMeta } from '../../src/manifest-contract.js'

const temporaryRoots: string[] = []

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-workspace-'))
  temporaryRoots.push(root)
  return root
}

async function writeSourcePlugin(root: string, name = 'atomic-plugin'): Promise<Record<string, unknown>> {
  const pluginRoot = path.join(root, 'plugins', name)
  const manifest = {
    schemaVersion: 1,
    name,
    version: '0.1.0',
    description: 'Atomic plugin.',
    compatibility: { aw: { minVersion: '0.0.0' } },
    mcpServers: './.mcp.json',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
  }
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'))
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest)
  await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { mcpServers: {} })
  return manifest
}

async function writeBundle(outputRoot: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.ensureDir(path.join(outputRoot, '.agents-plugin'))
  await fs.writeJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'), manifest)
  for (const platform of ['claude', 'codex']) {
    await fs.ensureDir(path.join(outputRoot, `.${platform}-plugin`))
    await fs.ensureDir(path.join(outputRoot, platform))
    await fs.writeJson(path.join(outputRoot, platform, '.mcp.json'), { mcpServers: {} })
    await fs.writeJson(path.join(outputRoot, `.${platform}-plugin`, 'plugin.json'), {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      compatibility: manifest.compatibility,
      mcpServers: `./${platform}/.mcp.json`,
    })
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)))
})

describe('AW plugin workspace v1', () => {
  it('creates deterministic valid metadata without Git and updates strict SemVer atomically', async () => {
    const root = await createWorkspace()
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n')
    const initialized = await initializePluginWorkspace({ workspaceRoot: root })
    const workspaceName = path.basename(root).toLowerCase()

    expect(initialized.metadata).toEqual({
      owner: {
        name: workspaceName,
        url: `https://example.invalid/aw-workspaces/${workspaceName}`,
      },
      interface: { displayName: workspaceName },
      catalog: { version: '0.1.0' },
    })
    await expect(fs.readFile(path.join(root, '.gitignore'), 'utf8'))
      .resolves.toBe('node_modules/\n.aw/\n')
    await expect(initializePluginWorkspace({ workspaceRoot: root, force: true }))
      .resolves.toMatchObject({ metadata: { catalog: { version: '0.1.0' } } })

    await expect(setWorkspaceCatalogVersion(root, '1.2.3-beta.1'))
      .resolves.toMatchObject({ catalog: { version: '1.2.3-beta.1' } })
    await expect(setWorkspaceCatalogVersion(root, '01.2.3')).rejects.toThrow(/strict SemVer/u)
    await expect(readPluginWorkspace(root)).resolves.toMatchObject({
      metadata: { catalog: { version: '1.2.3-beta.1' } },
    })
  })

  it.each(['1.2.3-rc.1', '1.2.3+build.1'])(
    'rejects non-publishable Catalog version %s during init and version updates',
    async (version) => {
      const initRoot = await createWorkspace()
      await expect(initializePluginWorkspace({ workspaceRoot: initRoot, catalogVersion: version }))
        .rejects.toThrow(/stable SemVer or an exact x\.y\.z-beta\.N/u)
      await expect(fs.pathExists(path.join(initRoot, 'plugins', 'marketplace-source.json')))
        .resolves.toBe(false)

      const versionRoot = await createWorkspace()
      await initializePluginWorkspace({ workspaceRoot: versionRoot })
      await expect(setWorkspaceCatalogVersion(versionRoot, version)).rejects.toThrow(
        /stable SemVer or an exact x\.y\.z-beta\.N/u,
      )
      await expect(readPluginWorkspace(versionRoot)).resolves.toMatchObject({
        metadata: { catalog: { version: '0.1.0' } },
      })
    },
  )

  it('defaults legacy metadata but rejects invalid and unknown public fields', () => {
    const legacy = {
      owner: { name: 'Owner', url: 'https://example.invalid/owner' },
      interface: { displayName: 'Example' },
    }
    expect(validateMarketplaceSourceMeta(legacy).catalog.version).toBe('0.1.0')
    expect(() => validateMarketplaceSourceMeta({ ...legacy, unknown: true }))
      .toThrow(/unknown field/u)
    expect(() => validateMarketplaceSourceMeta({
      ...legacy,
      catalog: { version: 'v1.0.0' },
    })).toThrow(/strict SemVer/u)
  })

  it('rejects escaped, protected, and symlink-directed build outputs', async () => {
    const root = await createWorkspace()
    await fs.ensureDir(path.join(root, 'plugins'))

    await expect(resolveWorkspaceOutputPath({ workspaceRoot: root, outputPath: '../outside' }))
      .rejects.toThrow(/inside the workspace/u)
    await expect(resolveWorkspaceOutputPath({ workspaceRoot: root, outputPath: 'plugins/output' }))
      .rejects.toThrow(/protected workspace path/u)
    await expect(resolveWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw', kind: 'catalog' }))
      .rejects.toThrow(/protected workspace path/u)
    await expect(resolveWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw/plugins/nested', kind: 'catalog' }))
      .rejects.toThrow(/different generated output kind/u)
    await fs.symlink(os.tmpdir(), path.join(root, '.aw'))
    await expect(resolveWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw/catalog' }))
      .rejects.toThrow(/symbolic links/u)
  })

  it('keeps a validated generated plugin output when a forced rebuild fails', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const pluginRoot = path.join(root, 'plugins', 'atomic-plugin')
    const sourceManifest = await writeSourcePlugin(root)
    const first = await buildWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: path.join('plugins', 'atomic-plugin'),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, sourceManifest) },
    })
    const before = await fs.readJson(path.join(first.outputRoot, '.agents-plugin', 'plugin.json'))

    await expect(buildWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: path.join('plugins', 'atomic-plugin'),
      force: true,
      adapter: {
        async build({ outputRoot }) {
          await fs.writeFile(path.join(outputRoot, 'partial.txt'), 'partial')
          throw new Error('injected build failure')
        },
      },
    })).rejects.toThrow('injected build failure')
    await expect(fs.readJson(path.join(first.outputRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toEqual(before)
    await expect(fs.pathExists(path.join(first.outputRoot, 'partial.txt'))).resolves.toBe(false)
  })

  it('force-rebuilds owned plugin and Catalog outputs after source and Catalog version changes', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const sourceManifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, sourceManifest) }
    const firstPlugin = await buildWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/atomic-plugin',
      adapter,
    })
    await buildWorkspaceCatalog({ workspaceRoot: root, adapter })

    sourceManifest.description = 'Changed source plugin.'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      sourceManifest,
    )
    await setWorkspaceCatalogVersion(root, '0.2.0')
    const rebuiltPlugin = await buildWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/atomic-plugin',
      force: true,
      adapter,
    })
    const rebuiltCatalog = await buildWorkspaceCatalog({ workspaceRoot: root, force: true, adapter })

    expect(rebuiltPlugin.outputRoot).toBe(firstPlugin.outputRoot)
    await expect(fs.readJson(path.join(rebuiltPlugin.outputRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toMatchObject({ description: 'Changed source plugin.' })
    await expect(validateCatalogSnapshot(rebuiltCatalog.outputRoot)).resolves.toMatchObject({
      manifest: { catalogVersion: '0.2.0' },
    })
  })

  it('keeps snapshot digests equal for identical workspaces at different roots', async () => {
    const roots = [await createWorkspace(), await createWorkspace()]
    const validations = []
    for (const root of roots) {
      await initializePluginWorkspace({
        workspaceRoot: root,
        ownerName: 'Same Owner',
        ownerUrl: 'https://example.invalid/same-owner',
        displayName: 'Same Catalog',
      })
      const manifest = await writeSourcePlugin(root)
      const built = await buildWorkspaceCatalog({
        workspaceRoot: root,
        adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
      })
      validations.push(await validateCatalogSnapshot(built.outputRoot))
    }

    expect(validations[0]!.snapshotDigest).toBe(validations[1]!.snapshotDigest)
    const markers = await Promise.all(roots.map((root) =>
      fs.readJson(path.join(root, '.aw', 'catalog', '.aw-generated.json'))))
    expect(markers[0].workspaceIdentity).not.toBe(markers[1].workspaceIdentity)
  })

  it('rejects an out-of-workspace linked plugin before an adapter can run', async () => {
    const root = await createWorkspace()
    const outside = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    await fs.ensureDir(path.join(outside, '.agents-plugin'))
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), { name: 'linked-plugin' })
    await fs.symlink(outside, path.join(root, 'plugins', 'linked-plugin'))
    let ran = false
    await expect(buildWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/linked-plugin',
      adapter: { async build() { ran = true } },
    })).rejects.toThrow(/symbolic link/u)
    expect(ran).toBe(false)
  })

  it('builds and strictly validates marketplace inventories', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const built = await buildWorkspaceCatalog({
      workspaceRoot: root,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    await expect(validateCatalogSnapshot(built.outputRoot)).resolves.toMatchObject({
      manifest: { schemaVersion: 4, catalogVersion: '0.1.0' },
    })
    const agentsPath = path.join(built.outputRoot, '.agents', 'plugins', 'marketplace.json')
    const validMarketplace = await fs.readFile(agentsPath)
    await fs.writeFile(agentsPath, '{ invalid')
    await expect(validateCatalogSnapshot(built.outputRoot)).rejects.toThrow()
    await fs.writeFile(agentsPath, validMarketplace)
    const claudePath = path.join(built.outputRoot, '.claude-plugin', 'marketplace.json')
    const claude = await fs.readJson(claudePath)
    claude.plugins.push({ ...claude.plugins[0], name: 'ghost', source: '../outside' })
    await fs.writeJson(claudePath, claude)
    await expect(validateCatalogSnapshot(built.outputRoot))
      .rejects.toThrow(/Claude marketplace metadata or plugin inventory/u)
  })

  it('rejects a tampered platform projection after rebuilding its Catalog digests', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)

    await expect(buildWorkspaceCatalog({
      workspaceRoot: root,
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, manifest)
          const platformManifestPath = path.join(outputRoot, '.codex-plugin', 'plugin.json')
          const platformManifest = await fs.readJson(platformManifestPath)
          platformManifest.skills = '../outside'
          await fs.writeJson(platformManifestPath, platformManifest)
        },
      },
    })).rejects.toThrow(/codex platform manifest projection/u)
  })

  it.each([
    ['1.0.0-rc.1', 'beta'],
    ['1.0.0+build.1', 'latest'],
  ])('rejects non-publishable Catalog version %s during snapshot validation', async (version, channel) => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const built = await buildWorkspaceCatalog({
      workspaceRoot: root,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const catalogManifestPath = path.join(built.outputRoot, 'catalog-manifest.json')
    const catalogManifest = await fs.readJson(catalogManifestPath)
    catalogManifest.catalogVersion = version
    catalogManifest.channel = channel
    await fs.writeJson(catalogManifestPath, catalogManifest)

    await expect(validateCatalogSnapshot(built.outputRoot)).rejects.toThrow(
      /stable SemVer or an exact x\.y\.z-beta\.N/u,
    )
  })

  it('prepares first and subsequent published snapshots with immutable ledger history', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    const first = await preparePublishedWorkspaceCatalog({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter,
    })
    const firstValidation = await validatePublishedCatalogSnapshot(first.outputRoot)
    expect(firstValidation.manifest.release).toMatchObject({
      state: 'published',
      targetVersion: '0.1.0',
      sourceHead: '1'.repeat(40),
    })
    expect(firstValidation.ledger.records).toHaveLength(1)
    const firstLedgerPath = path.join(first.outputRoot, 'plugin-release-ledger.json')
    const firstLedger = await fs.readFile(firstLedgerPath)
    await fs.remove(firstLedgerPath)
    await expect(validateCatalogSnapshot(first.outputRoot)).rejects.toThrow(/must include plugin-release-ledger/u)
    await fs.writeFile(firstLedgerPath, firstLedger)
    await fs.writeJson(firstLedgerPath, { schemaVersion: 2, records: [] })
    await expect(validateCatalogSnapshot(first.outputRoot)).rejects.toThrow(/does not match catalog entry/u)
    await fs.writeFile(firstLedgerPath, firstLedger)

    await setWorkspaceCatalogVersion(root, '0.2.0')
    const second = await preparePublishedWorkspaceCatalog({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter,
    })
    const secondValidation = await validatePublishedCatalogSnapshot(second.outputRoot)
    expect(secondValidation.ledger.records).toHaveLength(2)
    expect(secondValidation.manifest.release).toMatchObject({
      state: 'published',
      targetVersion: '0.2.0',
      planId: second.contentDigest,
      contentDigest: second.contentDigest,
    })
    await setWorkspaceCatalogVersion(root, '0.1.0')
    await expect(preparePublishedWorkspaceCatalog({
      workspaceRoot: root,
      sourceHead: '3'.repeat(40),
      previousSnapshotRoot: second.outputRoot,
      adapter,
    })).rejects.toThrow(/must be higher/u)

    for (const marketplacePath of [
      path.join(second.outputRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(second.outputRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const marketplace = await fs.readJson(marketplacePath)
      marketplace.owner = { name: 'Tampered Owner', url: 'https://example.invalid/tampered' }
      marketplace.interface = { displayName: 'Tampered Catalog' }
      await fs.writeJson(marketplacePath, marketplace)
    }
    const manifestPath = path.join(second.outputRoot, 'catalog-manifest.json')
    const publishedManifest = await fs.readJson(manifestPath)
    const changedContentDigest = sha256({
      schemaIdentity: { schemaVersion: publishedManifest.schemaVersion },
      marketplaceMetadata: {
        name: 'aw',
        owner: { name: 'Tampered Owner', url: 'https://example.invalid/tampered' },
        interface: { displayName: 'Tampered Catalog' },
      },
      compatibility: publishedManifest.compatibility,
      plugins: publishedManifest.entries.map((entry: Record<string, string>) => ({
        name: entry.name,
        targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
        contentDigest: entry.contentDigest,
      })),
    })
    publishedManifest.release.contentDigest = changedContentDigest
    publishedManifest.release.planId = changedContentDigest
    await fs.writeJson(manifestPath, publishedManifest)
    await expect(validateCatalogSnapshot(second.outputRoot)).rejects.toThrow(
      /marketplace metadata or plugin inventory/u,
    )
  })

  it('rejects reuse of a published plugin version for different content', async () => {
    const root = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const first = await preparePublishedWorkspaceCatalog({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    await setWorkspaceCatalogVersion(root, '0.2.0')
    await expect(preparePublishedWorkspaceCatalog({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, manifest)
          await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'changed')
        },
      },
    })).rejects.toThrow(/maps to different digests/u)
  })

  it('rejects foreign forced outputs without changing their bytes', async () => {
    const firstRoot = await createWorkspace()
    const secondRoot = await createWorkspace()
    for (const root of [firstRoot, secondRoot]) {
      await initializePluginWorkspace({ workspaceRoot: root })
      await writeSourcePlugin(root)
    }
    const manifest = await writeSourcePlugin(firstRoot)
    const first = await buildWorkspaceCatalog({
      workspaceRoot: firstRoot,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const firstManifest = await fs.readFile(path.join(first.outputRoot, 'catalog-manifest.json'))
    await expect(buildWorkspaceCatalog({
      workspaceRoot: firstRoot,
      force: true,
      adapter: { async build() { throw new Error('injected catalog failure') } },
    })).rejects.toThrow('injected catalog failure')
    await expect(fs.readFile(path.join(first.outputRoot, 'catalog-manifest.json'))).resolves.toEqual(firstManifest)
    const foreignRoot = path.join(secondRoot, '.aw', 'catalog')
    await fs.copy(first.outputRoot, foreignRoot)
    const before = await fs.readFile(path.join(foreignRoot, '.aw-generated.json'))
    await expect(buildWorkspaceCatalog({
      workspaceRoot: secondRoot,
      force: true,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })).rejects.toThrow(/different identity/u)
    await expect(fs.readFile(path.join(foreignRoot, '.aw-generated.json'))).resolves.toEqual(before)

    const firstPlugin = await buildWorkspacePlugin({
      workspaceRoot: firstRoot,
      pluginDirectory: 'plugins/atomic-plugin',
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const foreignPluginRoot = path.join(secondRoot, '.aw', 'plugins', 'atomic-plugin')
    await fs.copy(firstPlugin.outputRoot, foreignPluginRoot)
    const pluginBefore = await fs.readFile(path.join(foreignPluginRoot, '.aw-generated.json'))
    await expect(buildWorkspacePlugin({
      workspaceRoot: secondRoot,
      pluginDirectory: 'plugins/atomic-plugin',
      force: true,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })).rejects.toThrow(/different identity/u)
    await expect(fs.readFile(path.join(foreignPluginRoot, '.aw-generated.json'))).resolves.toEqual(pluginBefore)
  })

  it('does not adopt different metadata or a foreign non-empty plugin directory', async () => {
    const root = await createWorkspace()
    await fs.ensureDir(path.join(root, 'plugins', 'foreign'))
    await expect(initializePluginWorkspace({ workspaceRoot: root, force: true }))
      .rejects.toThrow(/non-managed plugins directory/u)

    const managed = await createWorkspace()
    await initializePluginWorkspace({ workspaceRoot: managed })
    await expect(initializePluginWorkspace({
      workspaceRoot: managed,
      force: true,
      displayName: 'Different',
    })).rejects.toThrow(/different workspace catalog metadata/u)
  })
})
