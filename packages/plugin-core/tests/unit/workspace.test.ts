import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildCatalogWorkspace,
  buildCatalogWorkspacePlugin,
  initializeCatalogWorkspace,
  mutateCatalogWorkspaceVersion,
  preparePublishedCatalogWorkspace,
  readCatalogWorkspace,
  resolveCatalogVersionMutation,
  resolveCatalogWorkspaceOutputPath,
  validateCatalogSnapshotComplete,
  validatePublishedCatalogPublicationParent,
  validatePublishedCatalogSnapshot,
} from '../../src/workspace.js'
import { validateMarketplaceSourceMeta } from '../../src/manifest-contract.js'
import { createAwPluginRequirementsReceipt } from '../../src/aw-capabilities.js'

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

async function convertPublishedSnapshotToLegacyV4(snapshotRoot: string): Promise<void> {
  const manifestPath = path.join(snapshotRoot, 'catalog-manifest.json')
  const manifest = await fs.readJson(manifestPath)
  const compatibility = { aw: { minVersion: '0.0.0' } }
  const entries = manifest.entries.map((entry: Record<string, unknown>) => {
    const legacy = { ...entry }
    delete legacy.dependencies
    delete legacy.requires
    return { ...legacy, compatibility }
  })
  const contentDigest = sha256({
    schemaIdentity: { schemaVersion: 4 },
    marketplaceMetadata: {
      name: 'aw',
      owner: manifest.marketplace.owner,
      interface: manifest.marketplace.interface,
    },
    compatibility,
    plugins: entries.map((entry: Record<string, string>) => ({
      name: entry.name,
      targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
      contentDigest: entry.contentDigest,
    })).sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)),
  })
  await fs.writeJson(manifestPath, {
    schemaVersion: 4,
    catalogVersion: manifest.catalogVersion,
    channel: manifest.channel,
    compatibility,
    marketplace: manifest.marketplace,
    release: { ...manifest.release, planId: contentDigest, contentDigest },
    entries,
  })
}

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-workspace-'))
  temporaryRoots.push(root)
  return root
}

async function writeSourcePlugin(root: string, name = 'atomic-plugin'): Promise<Record<string, unknown>> {
  const pluginRoot = path.join(root, 'plugins', name)
  const manifest = {
    schemaVersion: 2,
    name,
    version: '0.1.0',
    description: 'Atomic plugin.',
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
  const bundleManifest = {
    ...manifest,
    requires: { aw: { capabilities: ['aw.plugin-manifest.v2'] } },
  }
  await fs.ensureDir(path.join(outputRoot, '.agents-plugin'))
  await fs.writeJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'), bundleManifest)
  for (const platform of ['claude', 'codex']) {
    await fs.ensureDir(path.join(outputRoot, `.${platform}-plugin`))
    await fs.ensureDir(path.join(outputRoot, platform))
    await fs.writeJson(path.join(outputRoot, platform, '.mcp.json'), { mcpServers: {} })
    await fs.writeJson(path.join(outputRoot, `.${platform}-plugin`, 'plugin.json'), {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      mcpServers: `./${platform}/.mcp.json`,
    })
  }
}

async function writeNativeAndPortableSkillBundle(
  outputRoot: string,
  manifest: Record<string, unknown>,
  receiptVersion = String(manifest.version),
): Promise<void> {
  await writeBundle(outputRoot, manifest)
  const capabilities = [
    'aw.plugin-manifest.v2',
    'aw.plugin-skills.v1',
    'aw.portable-skills.v1',
  ]
  const sourceManifestPath = path.join(outputRoot, '.agents-plugin', 'plugin.json')
  const sourceManifest = await fs.readJson(sourceManifestPath)
  await fs.writeJson(sourceManifestPath, {
    ...sourceManifest,
    requires: { aw: { capabilities } },
  })
  for (const platform of ['claude', 'codex'] as const) {
    const platformManifestPath = path.join(outputRoot, `.${platform}-plugin`, 'plugin.json')
    const platformManifest = await fs.readJson(platformManifestPath)
    await fs.writeJson(platformManifestPath, {
      ...platformManifest,
      skills: `./${platform}/skills`,
    })
  }
  const skill = [
    '---',
    'name: example',
    'description: Example Skill.',
    '---',
    '',
    '# Example',
    '',
  ].join('\n')
  const receipt = `${JSON.stringify(createAwPluginRequirementsReceipt(
    { name: String(manifest.name), version: receiptVersion },
    capabilities,
  ), null, 2)}\n`
  for (const relative of [
    'claude/skills/example',
    'codex/skills/example',
    'agent-skills/skills/example',
  ]) {
    await fs.outputFile(path.join(outputRoot, relative, 'SKILL.md'), skill)
    await fs.outputFile(path.join(outputRoot, relative, 'README.md'), '# Example\n')
    await fs.outputFile(
      path.join(outputRoot, relative, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    )
    await fs.outputFile(path.join(outputRoot, relative, 'aw-plugin-requirements.json'), receipt)
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)))
})

describe('AW Catalog Workspace v1', () => {
  it('initializes and reads the exact marker contract while preserving identity on force', async () => {
    const root = await createWorkspace()
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n')
    const initialized = await initializeCatalogWorkspace({ workspaceRoot: root })
    const workspaceName = path.basename(root).toLowerCase()

    expect(initialized.metadata).toEqual({
      owner: {
        name: workspaceName,
        url: `https://example.invalid/aw-workspaces/${workspaceName}`,
      },
      interface: { displayName: workspaceName },
      catalog: { version: '0.1.0' },
    })
    await expect(fs.readJson(initialized.markerPath)).resolves.toEqual({
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: initialized.workspaceIdentity,
    })
    expect(initialized.workspaceIdentity).not.toBe('')
    await expect(fs.readFile(path.join(root, '.gitignore'), 'utf8'))
      .resolves.toBe('node_modules/\n.aw/\n')
    const forced = await initializeCatalogWorkspace({ workspaceRoot: root, force: true })
    expect(forced).toMatchObject({
      workspaceIdentity: initialized.workspaceIdentity,
      metadata: { catalog: { version: '0.1.0' } },
    })

    await expect(mutateCatalogWorkspaceVersion(root, { version: '1.2.3-beta.1' }))
      .resolves.toMatchObject({ catalog: { version: '1.2.3-beta.1' } })
    await expect(mutateCatalogWorkspaceVersion(root, { bump: 'patch' }))
      .resolves.toMatchObject({ catalog: { version: '1.2.4' } })
    const unchangedBytes = await fs.readFile(initialized.metadataPath)
    await expect(mutateCatalogWorkspaceVersion(root, { version: '1.2.4' }))
      .resolves.toMatchObject({ catalog: { version: '1.2.4' } })
    await expect(fs.readFile(initialized.metadataPath)).resolves.toEqual(unchangedBytes)
    await expect(mutateCatalogWorkspaceVersion(root, { version: '01.2.3' }))
      .rejects.toThrow(/strict SemVer/u)
    await expect(readCatalogWorkspace(root)).resolves.toMatchObject({
      markerPath: initialized.markerPath,
      workspaceIdentity: initialized.workspaceIdentity,
      metadata: { catalog: { version: '1.2.4' } },
    })
  })

  it('resolves exact and stable-base Catalog version mutations deterministically', () => {
    expect(resolveCatalogVersionMutation('1.2.3-beta.7', { version: '2.0.0-beta.1' }))
      .toBe('2.0.0-beta.1')
    expect(resolveCatalogVersionMutation('1.2.3-beta.7', { bump: 'patch' })).toBe('1.2.4')
    expect(resolveCatalogVersionMutation('1.2.3-beta.7', { bump: 'minor' })).toBe('1.3.0')
    expect(resolveCatalogVersionMutation('1.2.3-beta.7', { bump: 'major' })).toBe('2.0.0')
    expect(() => resolveCatalogVersionMutation('1.2.3', {})).toThrow('exactly one')
    expect(() => resolveCatalogVersionMutation('1.2.3', {
      version: '1.2.4',
      bump: 'patch',
    })).toThrow('exactly one')
  })

  it('requires the Catalog Workspace marker to read a Catalog Workspace', async () => {
    const root = await createWorkspace()
    const initialized = await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.remove(initialized.markerPath)

    await expect(readCatalogWorkspace(root)).rejects.toThrow(/Catalog Workspace marker/u)
  })

  it.each([
    ['legacy kind', {
      schemaVersion: 1,
      kind: 'aw-plugin-workspace',
      workspaceIdentity: 'stable-workspace-id',
    }],
    ['obsolete source identity', {
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: 'stable-workspace-id',
      sourceIdentity: 'obsolete',
    }],
    ['empty identity', {
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: '',
    }],
    ['unsupported schema', {
      schemaVersion: 2,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: 'stable-workspace-id',
    }],
  ])('rejects an invalid Catalog Workspace marker with %s', async (_case, marker) => {
    const root = await createWorkspace()
    const initialized = await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.writeJson(initialized.markerPath, marker)

    await expect(readCatalogWorkspace(root)).rejects.toThrow('Invalid Catalog Workspace marker.')
  })

  it('does not replace an invalid Catalog Workspace marker on force', async () => {
    const root = await createWorkspace()
    const initialized = await initializeCatalogWorkspace({ workspaceRoot: root })
    const invalidMarker = {
      schemaVersion: 1,
      kind: 'aw-plugin-workspace',
      workspaceIdentity: initialized.workspaceIdentity,
    }
    await fs.writeJson(initialized.markerPath, invalidMarker)

    await expect(initializeCatalogWorkspace({ workspaceRoot: root, force: true }))
      .rejects.toThrow(/different identity/u)
    await expect(fs.readJson(initialized.markerPath)).resolves.toEqual(invalidMarker)
  })

  it('accepts any stable non-empty Catalog Workspace identity', async () => {
    const root = await createWorkspace()
    const initialized = await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.writeJson(initialized.markerPath, {
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: 'stable-catalog-workspace-id',
    })

    await expect(readCatalogWorkspace(root)).resolves.toMatchObject({
      workspaceIdentity: 'stable-catalog-workspace-id',
    })
  })

  it.each(['1.2.3-rc.1', '1.2.3+build.1'])(
    'rejects non-publishable Catalog version %s during init and version updates',
    async (version) => {
      const initRoot = await createWorkspace()
      await expect(initializeCatalogWorkspace({ workspaceRoot: initRoot, catalogVersion: version }))
        .rejects.toThrow(/stable SemVer or an exact x\.y\.z-beta\.N/u)
      await expect(fs.pathExists(path.join(initRoot, 'plugins', 'marketplace-source.json')))
        .resolves.toBe(false)

      const versionRoot = await createWorkspace()
      await initializeCatalogWorkspace({ workspaceRoot: versionRoot })
      await expect(mutateCatalogWorkspaceVersion(versionRoot, { version })).rejects.toThrow(
        /stable SemVer or an exact x\.y\.z-beta\.N/u,
      )
      await expect(readCatalogWorkspace(versionRoot)).resolves.toMatchObject({
        metadata: { catalog: { version: '0.1.0' } },
      })
    },
  )

  it('requires exact Catalog metadata and rejects invalid and unknown public fields', () => {
    const legacy = {
      owner: { name: 'Owner', url: 'https://example.invalid/owner' },
      interface: { displayName: 'Example' },
    }
    expect(() => validateMarketplaceSourceMeta(legacy))
      .toThrow(/marketplace source metadata\.catalog.*expected an object/u)
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

    await expect(resolveCatalogWorkspaceOutputPath({ workspaceRoot: root, outputPath: '../outside' }))
      .rejects.toThrow(/inside the Catalog Workspace/u)
    await expect(resolveCatalogWorkspaceOutputPath({ workspaceRoot: root, outputPath: 'plugins/output' }))
      .rejects.toThrow(/protected Catalog Workspace path/u)
    await expect(resolveCatalogWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw', kind: 'catalog' }))
      .rejects.toThrow(/protected Catalog Workspace path/u)
    await expect(resolveCatalogWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw/plugins/nested', kind: 'catalog' }))
      .rejects.toThrow(/different generated output kind/u)
    await fs.symlink(os.tmpdir(), path.join(root, '.aw'))
    await expect(resolveCatalogWorkspaceOutputPath({ workspaceRoot: root, outputPath: '.aw/catalog' }))
      .rejects.toThrow(/symbolic links/u)
  })

  it('keeps a validated generated plugin output when a forced rebuild fails', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = path.join(root, 'plugins', 'atomic-plugin')
    const sourceManifest = await writeSourcePlugin(root)
    const first = await buildCatalogWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: path.join('plugins', 'atomic-plugin'),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, sourceManifest) },
    })
    const before = await fs.readJson(path.join(first.outputRoot, '.agents-plugin', 'plugin.json'))

    await expect(buildCatalogWorkspacePlugin({
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
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const sourceManifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, sourceManifest) }
    const firstPlugin = await buildCatalogWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/atomic-plugin',
      adapter,
    })
    await buildCatalogWorkspace({ workspaceRoot: root, adapter })

    sourceManifest.description = 'Changed source plugin.'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      sourceManifest,
    )
    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    const rebuiltPlugin = await buildCatalogWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/atomic-plugin',
      force: true,
      adapter,
    })
    const rebuiltCatalog = await buildCatalogWorkspace({ workspaceRoot: root, force: true, adapter })

    expect(rebuiltPlugin.outputRoot).toBe(firstPlugin.outputRoot)
    await expect(fs.readJson(path.join(rebuiltPlugin.outputRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toMatchObject({ description: 'Changed source plugin.' })
    await expect(validateCatalogSnapshotComplete(rebuiltCatalog.outputRoot)).resolves.toMatchObject({
      manifest: { catalogVersion: '0.2.0' },
    })
  })

  it('builds a complete schema 5 snapshot for an empty plugin inventory', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    let adapterCalls = 0

    const built = await buildCatalogWorkspace({
      workspaceRoot: root,
      adapter: { async build() { adapterCalls += 1 } },
    })

    expect(adapterCalls).toBe(0)
    expect(built.pluginNames).toEqual([])
    await expect(fs.readdir(path.join(built.outputRoot, 'plugins'))).resolves.toEqual([])
    await expect(validateCatalogSnapshotComplete(built.outputRoot)).resolves.toMatchObject({
      manifest: { schemaVersion: 5, catalogVersion: '0.1.0', entries: [] },
    })
  })

  it('keeps snapshot digests equal for identical workspaces at different roots', async () => {
    const roots = [await createWorkspace(), await createWorkspace()]
    const validations = []
    for (const root of roots) {
      await initializeCatalogWorkspace({
        workspaceRoot: root,
        ownerName: 'Same Owner',
        ownerUrl: 'https://example.invalid/same-owner',
        displayName: 'Same Catalog',
      })
      const manifest = await writeSourcePlugin(root)
      const built = await buildCatalogWorkspace({
        workspaceRoot: root,
        adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
      })
      validations.push(await validateCatalogSnapshotComplete(built.outputRoot))
    }

    expect(validations[0]!.snapshotDigest).toBe(validations[1]!.snapshotDigest)
    const markers = await Promise.all(roots.map((root) =>
      fs.readJson(path.join(root, '.aw', 'catalog', '.aw-generated.json'))))
    expect(markers[0].workspaceIdentity).not.toBe(markers[1].workspaceIdentity)
  })

  it('rejects an out-of-workspace linked plugin before an adapter can run', async () => {
    const root = await createWorkspace()
    const outside = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.ensureDir(path.join(outside, '.agents-plugin'))
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), { name: 'linked-plugin' })
    await fs.symlink(outside, path.join(root, 'plugins', 'linked-plugin'))
    let ran = false
    await expect(buildCatalogWorkspacePlugin({
      workspaceRoot: root,
      pluginDirectory: 'plugins/linked-plugin',
      adapter: { async build() { ran = true } },
    })).rejects.toThrow(/symbolic link/u)
    expect(ran).toBe(false)
  })

  it('builds and strictly validates marketplace inventories', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const built = await buildCatalogWorkspace({
      workspaceRoot: root,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    await expect(validateCatalogSnapshotComplete(built.outputRoot)).resolves.toMatchObject({
      manifest: { schemaVersion: 5, catalogVersion: '0.1.0' },
    })
    const agentsPath = path.join(built.outputRoot, '.agents', 'plugins', 'marketplace.json')
    const validMarketplace = await fs.readFile(agentsPath)
    await fs.writeFile(agentsPath, '{ invalid')
    await expect(validateCatalogSnapshotComplete(built.outputRoot)).rejects.toThrow()
    await fs.writeFile(agentsPath, validMarketplace)
    const claudePath = path.join(built.outputRoot, '.claude-plugin', 'marketplace.json')
    const claude = await fs.readJson(claudePath)
    claude.plugins.push({ ...claude.plugins[0], name: 'ghost', source: '../outside' })
    await fs.writeJson(claudePath, claude)
    await expect(validateCatalogSnapshotComplete(built.outputRoot))
      .rejects.toThrow(/Claude marketplace metadata or plugin inventory/u)
  })

  it('rejects a tampered platform projection after rebuilding its Catalog digests', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)

    await expect(buildCatalogWorkspace({
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
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const built = await buildCatalogWorkspace({
      workspaceRoot: root,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const catalogManifestPath = path.join(built.outputRoot, 'catalog-manifest.json')
    const catalogManifest = await fs.readJson(catalogManifestPath)
    catalogManifest.catalogVersion = version
    catalogManifest.channel = channel
    await fs.writeJson(catalogManifestPath, catalogManifest)

    await expect(validateCatalogSnapshotComplete(built.outputRoot)).rejects.toThrow(
      /stable SemVer or an exact x\.y\.z-beta\.N/u,
    )
  })

  it('prepares first and subsequent published snapshots with immutable ledger history', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    const first = await preparePublishedCatalogWorkspace({
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
    await expect(validateCatalogSnapshotComplete(first.outputRoot)).rejects.toThrow(/must include plugin-release-ledger/u)
    await fs.writeFile(firstLedgerPath, firstLedger)
    await fs.writeJson(firstLedgerPath, { schemaVersion: 2, records: [] })
    await expect(validateCatalogSnapshotComplete(first.outputRoot)).rejects.toThrow(/does not match catalog entry/u)
    await fs.writeFile(firstLedgerPath, firstLedger)

    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    const second = await preparePublishedCatalogWorkspace({
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
    await mutateCatalogWorkspaceVersion(root, { version: '0.1.0' })
    await expect(preparePublishedCatalogWorkspace({
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
      requires: publishedManifest.requires,
      plugins: publishedManifest.entries.map((entry: Record<string, string>) => ({
        name: entry.name,
        targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
        contentDigest: entry.contentDigest,
      })),
    })
    publishedManifest.release.contentDigest = changedContentDigest
    publishedManifest.release.planId = changedContentDigest
    await fs.writeJson(manifestPath, publishedManifest)
    await expect(validateCatalogSnapshotComplete(second.outputRoot)).rejects.toThrow(
      /marketplace metadata or plugin inventory/u,
    )
  })

  it('uses a validated published v4 snapshot only as a v5 publication parent', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    await mutateCatalogWorkspaceVersion(root, { version: '0.1.0-beta.1' })
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '4'.repeat(40),
      adapter,
    })
    await convertPublishedSnapshotToLegacyV4(first.outputRoot)

    await expect(validateCatalogSnapshotComplete(first.outputRoot))
      .rejects.toThrow(/unknown field "compatibility"/u)
    await expect(validatePublishedCatalogPublicationParent(first.outputRoot)).resolves.toMatchObject({
      catalogVersion: '0.1.0-beta.1',
      ledger: { schemaVersion: 2, records: [{ version: '0.1.0-beta.1' }] },
    })

    await mutateCatalogWorkspaceVersion(root, { version: '0.1.0-beta.2' })
    const second = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '5'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter,
    })
    const validation = await validatePublishedCatalogSnapshot(second.outputRoot)
    expect(validation.manifest).toMatchObject({
      schemaVersion: 5,
      catalogVersion: '0.1.0-beta.2',
      entries: [{ version: '0.1.0-beta.1' }],
    })
    expect(validation.ledger.records).toHaveLength(2)

    const legacyManifestPath = path.join(first.outputRoot, 'catalog-manifest.json')
    const legacyLedgerPath = path.join(first.outputRoot, 'plugin-release-ledger.json')
    const legacyManifest = await fs.readJson(legacyManifestPath)
    const legacyLedger = await fs.readJson(legacyLedgerPath)
    legacyLedger.records[0].manifestDigest = `sha256:${'2'.repeat(64)}`
    await fs.writeJson(legacyLedgerPath, legacyLedger)
    await expect(validatePublishedCatalogPublicationParent(first.outputRoot))
      .rejects.toThrow(/does not match catalog entry/u)

    legacyLedger.records[0].manifestDigest = legacyManifest.entries[0].manifestDigest
    await fs.writeJson(legacyLedgerPath, legacyLedger)
    legacyManifest.release.contentDigest = `sha256:${'0'.repeat(64)}`
    await fs.writeJson(legacyManifestPath, legacyManifest)
    await expect(validatePublishedCatalogPublicationParent(first.outputRoot))
      .rejects.toThrow(/legacy catalog release contentDigest/u)
  })

  it('uses the committed Workspace version as the exact release candidate', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    await mutateCatalogWorkspaceVersion(root, { version: '2.0.0-beta.3' })
    const prepared = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '4'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const validation = await validatePublishedCatalogSnapshot(prepared.outputRoot)

    expect(validation.manifest).toMatchObject({
      catalogVersion: '2.0.0-beta.3',
      channel: 'beta',
      release: {
        state: 'published',
        targetVersion: '2.0.0',
        planId: prepared.planId,
      },
    })
    await expect(readCatalogWorkspace(root)).resolves.toMatchObject({
      metadata: { catalog: { version: '2.0.0-beta.3' } },
    })
  })

  it('rewrites native and portable requirements receipts while keeping beta content identity stable', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    manifest.skills = './skills'
    manifest.distributions = { agentSkills: { skills: './portable-skills' } }
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    for (const relative of ['skills/example', 'portable-skills/example']) {
      await fs.outputFile(path.join(root, 'plugins', 'atomic-plugin', relative, 'SKILL.md'), [
        '---',
        'name: example',
        'description: Example Skill.',
        '---',
        '',
        '# Example',
        '',
      ].join('\n'))
      await fs.outputFile(
        path.join(root, 'plugins', 'atomic-plugin', relative, 'README.md'),
        '# Example\n',
      )
      await fs.outputFile(
        path.join(root, 'plugins', 'atomic-plugin', relative, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      )
    }
    const adapter = {
      build: ({ outputRoot }: { outputRoot: string }) =>
        writeNativeAndPortableSkillBundle(outputRoot, manifest),
    }
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.1' })
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '5'.repeat(40),
      adapter,
    })
    const firstValidation = await validatePublishedCatalogSnapshot(first.outputRoot)
    expect(firstValidation.manifest.entries[0]?.version).toBe('0.1.0-beta.1')
    const firstContentDigest = firstValidation.manifest.entries[0]?.contentDigest
    for (const relative of [
      'claude/skills/example',
      'codex/skills/example',
      'agent-skills/skills/example',
    ]) {
      await expect(fs.readJson(path.join(
        first.outputRoot,
        'plugins',
        'atomic-plugin',
        relative,
        'aw-plugin-requirements.json',
      ))).resolves.toMatchObject({
        plugin: { name: 'atomic-plugin', version: '0.1.0-beta.1' },
        requiredCapabilities: [
          'aw.plugin-manifest.v2',
          'aw.plugin-skills.v1',
          'aw.portable-skills.v1',
        ],
      })
    }

    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.2' })
    const second = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '6'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter,
    })
    const secondValidation = await validatePublishedCatalogSnapshot(second.outputRoot)
    expect(secondValidation.manifest.entries[0]).toMatchObject({
      version: '0.1.0-beta.1',
      contentDigest: firstContentDigest,
    })
  })

  it('rejects a bundle runtime requirements receipt that does not match its manifest', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    manifest.skills = './skills'
    manifest.distributions = { agentSkills: { skills: './portable-skills' } }
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    for (const relative of ['skills/example', 'portable-skills/example']) {
      await fs.outputFile(path.join(root, 'plugins', 'atomic-plugin', relative, 'SKILL.md'), [
        '---',
        'name: example',
        'description: Example Skill.',
        '---',
        '',
      ].join('\n'))
      await fs.outputFile(path.join(root, 'plugins', 'atomic-plugin', relative, 'README.md'), '# Example\n')
      await fs.outputFile(
        path.join(root, 'plugins', 'atomic-plugin', relative, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      )
    }

    await expect(buildCatalogWorkspace({
      workspaceRoot: root,
      adapter: {
        build: ({ outputRoot }) => writeNativeAndPortableSkillBundle(
          outputRoot,
          manifest,
          '9.9.9',
        ),
      },
    })).rejects.toThrow(/mismatched runtime requirements receipt/u)
  })

  it('rejects reuse of a published plugin version for different content', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    await expect(preparePublishedCatalogWorkspace({
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
      await initializeCatalogWorkspace({ workspaceRoot: root })
      await writeSourcePlugin(root)
    }
    const manifest = await writeSourcePlugin(firstRoot)
    const first = await buildCatalogWorkspace({
      workspaceRoot: firstRoot,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const firstManifest = await fs.readFile(path.join(first.outputRoot, 'catalog-manifest.json'))
    await expect(buildCatalogWorkspace({
      workspaceRoot: firstRoot,
      force: true,
      adapter: { async build() { throw new Error('injected catalog failure') } },
    })).rejects.toThrow('injected catalog failure')
    await expect(fs.readFile(path.join(first.outputRoot, 'catalog-manifest.json'))).resolves.toEqual(firstManifest)
    const foreignRoot = path.join(secondRoot, '.aw', 'catalog')
    await fs.copy(first.outputRoot, foreignRoot)
    const before = await fs.readFile(path.join(foreignRoot, '.aw-generated.json'))
    await expect(buildCatalogWorkspace({
      workspaceRoot: secondRoot,
      force: true,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })).rejects.toThrow(/different identity/u)
    await expect(fs.readFile(path.join(foreignRoot, '.aw-generated.json'))).resolves.toEqual(before)

    const firstPlugin = await buildCatalogWorkspacePlugin({
      workspaceRoot: firstRoot,
      pluginDirectory: 'plugins/atomic-plugin',
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const foreignPluginRoot = path.join(secondRoot, '.aw', 'plugins', 'atomic-plugin')
    await fs.copy(firstPlugin.outputRoot, foreignPluginRoot)
    const pluginBefore = await fs.readFile(path.join(foreignPluginRoot, '.aw-generated.json'))
    await expect(buildCatalogWorkspacePlugin({
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
    await expect(initializeCatalogWorkspace({ workspaceRoot: root, force: true }))
      .rejects.toThrow(/non-managed plugins directory/u)

    const unmarked = await createWorkspace()
    await fs.ensureDir(path.join(unmarked, 'plugins'))
    await fs.writeJson(path.join(unmarked, 'plugins', 'marketplace-source.json'), {
      owner: { name: 'Legacy', url: 'https://example.invalid/legacy' },
      interface: { displayName: 'Legacy' },
      catalog: { version: '0.1.0' },
    })
    await expect(initializeCatalogWorkspace({ workspaceRoot: unmarked, force: true }))
      .rejects.toThrow(/metadata without a valid marker/u)
    await expect(fs.pathExists(path.join(unmarked, '.aw-workspace.json'))).resolves.toBe(false)

    const managed = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: managed })
    await expect(initializeCatalogWorkspace({
      workspaceRoot: managed,
      force: true,
      displayName: 'Different',
    })).rejects.toThrow(/different Catalog Workspace metadata/u)
  })
})
