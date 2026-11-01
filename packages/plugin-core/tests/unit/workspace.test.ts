import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildCatalogWorkspace,
  buildCatalogWorkspacePlugin,
  initializeCatalogWorkspace,
  mutateCatalogWorkspaceVersion,
  preparePublishedCatalogWorkspace,
  readCatalogWorkspace,
  resolvePublishedPluginVersions,
  resolveCatalogVersionMutation,
  resolveCatalogWorkspaceOutputPath,
  validateCatalogSnapshotComplete,
  validatePublishedCatalogSnapshot,
  validatePublishedCatalogSnapshotMetadata,
} from '../../src/workspace.js'
import { validateMarketplaceSourceMeta } from '../../src/manifest-contract.js'
import { createAwPluginRequirementsReceipt } from '../../src/aw-capabilities.js'

const temporaryRoots: string[] = []

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-workspace-'))
  temporaryRoots.push(root)
  return root
}

async function writeSourcePlugin(root: string, name = 'atomic-plugin'): Promise<Record<string, unknown>> {
  const pluginRoot = path.join(root, 'plugins', name)
  const manifest = {
    schemaVersion: 3,
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
    requires: { aw: { capabilities: ['aw.plugin-manifest.v3'] } },
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
    'aw.plugin-manifest.v3',
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
      schemaVersion: 3,
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

  it('builds a complete schema 7 snapshot for an empty plugin inventory', async () => {
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
      manifest: { schemaVersion: 7, catalogVersion: '0.1.0', entries: [] },
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
      manifest: { schemaVersion: 7, catalogVersion: '0.1.0' },
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

  it.skipIf(process.platform === 'win32')('validates executable Catalog bundles after Windows drops Unix mode bits', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const built = await buildCatalogWorkspace({
      workspaceRoot: root,
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, manifest)
          const script = path.join(outputRoot, 'runtime.mjs')
          await fs.writeFile(script, '#!/usr/bin/env node\nconsole.log("example")\n')
          await fs.chmod(script, 0o755)
        },
      },
    })
    const original = await validateCatalogSnapshotComplete(built.outputRoot)
    const pluginRoot = path.join(built.outputRoot, 'plugins', String(manifest.name))
    const script = path.join(pluginRoot, 'runtime.mjs')
    await fs.chmod(script, 0o644)
    await expect(validateCatalogSnapshotComplete(built.outputRoot)).rejects.toThrow(/artifactDigest/u)

    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await expect(validateCatalogSnapshotComplete(built.outputRoot)).resolves.toEqual(original)
      await fs.appendFile(script, '// changed\n')
      await expect(validateCatalogSnapshotComplete(built.outputRoot)).rejects.toThrow(/artifactDigest/u)
    } finally {
      platform.mockRestore()
    }
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

  it('prepares published snapshots with minimal release metadata and no ledger', async () => {
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
    expect(firstValidation.manifest.release).toEqual({
      state: 'published',
      sourceHead: '1'.repeat(40),
    })
    await expect(fs.pathExists(path.join(first.outputRoot, 'plugin-release-ledger.json'))).resolves.toBe(false)
    await fs.writeJson(path.join(first.outputRoot, 'plugin-release-ledger.json'), { schemaVersion: 3, records: [] })
    await expect(validateCatalogSnapshotComplete(first.outputRoot)).rejects.toThrow(/root layout/u)
    await fs.remove(path.join(first.outputRoot, 'plugin-release-ledger.json'))

    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    const second = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter,
    })
    const secondValidation = await validatePublishedCatalogSnapshot(second.outputRoot)
    expect(secondValidation.manifest.release).toEqual({
      state: 'published',
      sourceHead: '2'.repeat(40),
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
    await expect(validateCatalogSnapshotComplete(second.outputRoot)).rejects.toThrow(
      /marketplace metadata or plugin inventory/u,
    )
  })

  it('validates published history metadata without requiring Plugin bundles', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const prepared = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '3'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const metadataRoot = await createWorkspace()
    for (const relative of ['.aw-generated.json', 'catalog-manifest.json']) {
      await fs.copy(path.join(prepared.outputRoot, relative), path.join(metadataRoot, relative))
    }

    await expect(validatePublishedCatalogSnapshotMetadata(metadataRoot)).resolves.toMatchObject({
      workspaceIdentity: (await fs.readJson(path.join(prepared.outputRoot, '.aw-generated.json'))).workspaceIdentity,
      manifest: {
        release: { state: 'published', sourceHead: '3'.repeat(40) },
        entries: [{ name: 'atomic-plugin', version: '0.1.0' }],
      },
    })

    const manifestPath = path.join(metadataRoot, 'catalog-manifest.json')
    const historyManifest = await fs.readJson(manifestPath) as Record<string, unknown>
    const entries = historyManifest.entries as Array<Record<string, unknown>>
    await fs.writeJson(manifestPath, {
      ...historyManifest,
      entries: [{ ...entries[0], source: './plugins/different-plugin' }],
    }, { spaces: 2 })
    await expect(validatePublishedCatalogSnapshotMetadata(metadataRoot))
      .rejects.toThrow(/source.*does not match its plugin bundle/u)
  })

  it('rejects a schema 5 publication parent before building the next snapshot', async () => {
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
    const manifestPath = path.join(first.outputRoot, 'catalog-manifest.json')
    const publishedManifest = await fs.readJson(manifestPath)
    await fs.writeJson(manifestPath, { ...publishedManifest, schemaVersion: 5 })

    await mutateCatalogWorkspaceVersion(root, { version: '0.1.0-beta.2' })
    let buildCalled = false
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '5'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter: { build: async () => { buildCalled = true } },
    })).rejects.toThrow(/schemaVersion: expected 7/u)
    expect(buildCalled).toBe(false)
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
        sourceHead: '4'.repeat(40),
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
          'aw.plugin-manifest.v3',
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

  it('increments beta versions from the recent entry and resets on a higher source base', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.1' })
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '7'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })

    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.2' })
    const changedAdapter = {
      async build({ outputRoot }: { outputRoot: string }) {
        await writeBundle(outputRoot, manifest)
        await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'changed')
      },
    }
    const second = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '8'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter: changedAdapter,
    })
    await expect(validatePublishedCatalogSnapshot(second.outputRoot)).resolves.toMatchObject({
      manifest: { entries: [{ version: '0.1.0-beta.2' }] },
    })

    manifest.version = '0.2.0'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.3' })
    const third = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '9'.repeat(40),
      previousSnapshotRoot: second.outputRoot,
      adapter: changedAdapter,
    })
    await expect(validatePublishedCatalogSnapshot(third.outputRoot)).resolves.toMatchObject({
      manifest: { entries: [{ version: '0.2.0-beta.1' }] },
    })

    manifest.version = '0.1.0'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.4' })
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'a'.repeat(40),
      previousSnapshotRoot: third.outputRoot,
      adapter: changedAdapter,
    })).rejects.toThrow(/must not be lower than previous base/u)
  })

  it('promotes a beta to stable and preserves an equal stable entry in a later beta Catalog', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0-beta.1' })
    const beta = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'b'.repeat(40),
      adapter,
    })
    await mutateCatalogWorkspaceVersion(root, { version: '1.0.0' })
    const stable = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'c'.repeat(40),
      previousSnapshotRoot: beta.outputRoot,
      adapter,
    })
    await expect(validatePublishedCatalogSnapshot(stable.outputRoot)).resolves.toMatchObject({
      manifest: { entries: [{ version: '0.1.0' }] },
    })

    await mutateCatalogWorkspaceVersion(root, { version: '1.0.1-beta.1' })
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'd'.repeat(40),
      previousSnapshotRoot: stable.outputRoot,
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, manifest)
          await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'changed')
        },
      },
    })).rejects.toThrow(/stable version 0\.1\.0 maps to different content/u)
    const laterBeta = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'd'.repeat(40),
      previousSnapshotRoot: stable.outputRoot,
      adapter,
    })
    await expect(validatePublishedCatalogSnapshot(laterBeta.outputRoot)).resolves.toMatchObject({
      manifest: { entries: [{ version: '0.1.0' }] },
    })
  })

  it('allows a higher stable Plugin version and rejects a later downgrade', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })

    manifest.version = '0.2.0'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    const second = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, manifest)
          await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'changed')
        },
      },
    })
    await expect(validatePublishedCatalogSnapshot(second.outputRoot)).resolves.toMatchObject({
      manifest: { entries: [{ version: '0.2.0' }] },
    })

    manifest.version = '0.1.0'
    await fs.writeJson(
      path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'),
      manifest,
    )
    await mutateCatalogWorkspaceVersion(root, { version: '0.3.0' })
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '3'.repeat(40),
      previousSnapshotRoot: second.outputRoot,
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })).rejects.toThrow(/must not be lower than previous/u)
  })

  it.each([
    { history: ['1.0.0'], changed: false, channel: 'beta', expected: '1.0.0' },
    { history: ['1.0.1-beta.3', '1.0.1'], changed: false, channel: 'beta', expected: '1.0.1' },
    { history: ['1.0.1'], changed: true, channel: 'beta', expected: '1.0.2-beta.1' },
    { history: ['1.1.0-beta.2', '1.0.1'], changed: true, channel: 'beta', expected: '1.1.0-beta.3' },
    { history: ['1.1.0-beta.2'], changed: false, channel: 'beta', expected: '1.1.0-beta.2' },
    { history: ['1.1.0-beta.2'], changed: true, channel: 'beta', source: '2.0.0', expected: '2.0.0-beta.1' },
    { history: [], changed: false, channel: 'beta', expected: '0.1.0-beta.1' },
    { history: ['1.1.0-beta.2'], changed: false, channel: 'latest', expected: '1.1.0' },
    { history: ['1.0.1'], changed: false, channel: 'latest', expected: '1.0.1' },
    { history: ['1.0.1'], changed: true, channel: 'latest', expected: '1.0.2' },
    { history: ['1.0.1'], changed: false, channel: 'latest', source: '2.0.0', expected: '2.0.0' },
  ])('allocates official Plugin versions from full successful history: $expected', async (scenario) => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    const baseline = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter,
    })
    const entry = (await validatePublishedCatalogSnapshot(baseline.outputRoot)).manifest.entries[0]!
    if (scenario.source) {
      manifest.version = scenario.source
      await fs.writeJson(path.join(root, 'plugins', 'atomic-plugin', '.agents-plugin', 'plugin.json'), manifest)
    }
    await mutateCatalogWorkspaceVersion(root, {
      version: scenario.channel === 'beta' ? '2.0.0-beta.1' : '2.0.0',
    })
    const candidate = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      officialPluginHistory: scenario.history.map((version) => ({ ...entry, version })),
      adapter: {
        async build({ outputRoot }) {
          await adapter.build({ outputRoot })
          if (scenario.changed) await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'changed')
        },
      },
    })
    const published = await validatePublishedCatalogSnapshot(candidate.outputRoot)
    expect(published.manifest.entries[0]?.version).toBe(scenario.expected)
    expect(await fs.readJson(path.join(candidate.outputRoot, 'plugins', 'atomic-plugin', '.codex-plugin', 'plugin.json')))
      .toMatchObject({ version: scenario.expected })
  })

  it('rejects conflicting content at any official historical Plugin version', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    const baseline = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter,
    })
    const entry = (await validatePublishedCatalogSnapshot(baseline.outputRoot)).manifest.entries[0]!
    await mutateCatalogWorkspaceVersion(root, { version: '2.0.0-beta.1' })
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '2'.repeat(40),
      officialPluginHistory: [
        { ...entry, version: '1.1.0-beta.2' },
        { ...entry, version: '1.0.0' },
        { ...entry, version: '1.0.0', contentDigest: `sha256:${'f'.repeat(64)}` },
      ],
      adapter,
    })).rejects.toThrow(/version 1\.0\.0 maps to different content/u)
  })

  it('distinguishes explicit Plugin targets from old main metadata and beta promotion', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const baseline = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '1'.repeat(40),
      adapter: { build: ({ outputRoot }) => writeBundle(outputRoot, manifest) },
    })
    const entry = (await validatePublishedCatalogSnapshot(baseline.outputRoot)).manifest.entries[0]!
    const entries = [{ ...entry, version: '1.0.0' }]
    const officialPluginHistory = [{ ...entry, version: '1.1.0-beta.2' }]
    expect(resolvePublishedPluginVersions({
      channel: 'beta', entries, officialPluginHistory,
      sourcePluginVersionsAtBaseline: { 'atomic-plugin': '1.0.0' },
    })).toEqual({ 'atomic-plugin': '1.1.0-beta.2' })
    expect(() => resolvePublishedPluginVersions({
      channel: 'beta', entries, officialPluginHistory,
      sourcePluginVersionsAtBaseline: { 'atomic-plugin': '1.2.0' },
    })).toThrow(/explicit source version 1\.0\.0 must not be lower/u)
    expect(resolvePublishedPluginVersions({
      channel: 'beta', entries, officialPluginHistory: [{ ...entry, version: '1.0.0' }],
      sourcePluginVersionsAtBaseline: { 'atomic-plugin': '1.0.0' },
    })).toEqual({ 'atomic-plugin': '1.0.0' })
    expect(() => resolvePublishedPluginVersions({
      channel: 'beta', entries, officialPluginHistory: [{ ...entry, version: '1.0.0' }],
      sourcePluginVersionsAtBaseline: { 'atomic-plugin': '0.1.0' },
    })).toThrow(/already published as stable/u)
    expect(resolvePublishedPluginVersions({
      channel: 'latest', entries, officialPluginHistory: [{ ...entry, version: '1.0.0-beta.2' }],
      sourcePluginVersionsAtBaseline: { 'atomic-plugin': '0.1.0' },
    })).toEqual({ 'atomic-plugin': '1.0.0' })
  })

  it('retains a removed Plugin history entry when it is added again', async () => {
    const root = await createWorkspace()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const manifest = await writeSourcePlugin(root)
    const adapter = { build: ({ outputRoot }: { outputRoot: string }) => writeBundle(outputRoot, manifest) }
    const first = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'e'.repeat(40),
      adapter,
    })
    const firstValidation = await validatePublishedCatalogSnapshot(first.outputRoot)
    await fs.remove(path.join(root, 'plugins', 'atomic-plugin'))
    await mutateCatalogWorkspaceVersion(root, { version: '0.2.0' })
    const removed = await preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: 'f'.repeat(40),
      previousSnapshotRoot: first.outputRoot,
      adapter,
    })

    const readded = await writeSourcePlugin(root)
    await mutateCatalogWorkspaceVersion(root, { version: '0.3.0' })
    await expect(preparePublishedCatalogWorkspace({
      workspaceRoot: root,
      sourceHead: '0'.repeat(40),
      previousSnapshotRoot: removed.outputRoot,
      historicalPluginEntries: [firstValidation.manifest.entries[0]!],
      adapter: {
        async build({ outputRoot }) {
          await writeBundle(outputRoot, readded)
          await fs.writeFile(path.join(outputRoot, 'changed.txt'), 'new history')
        },
      },
    })).rejects.toThrow(/maps to different content/u)
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
    })).rejects.toThrow(/maps to different content/u)
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
