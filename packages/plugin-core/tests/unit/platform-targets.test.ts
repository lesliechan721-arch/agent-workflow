import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertPluginDependencyPlatformCoverage,
  assertPluginManifestStructure,
  createMarketplaceManifest,
  createMarketplaceManifestEntry,
  createRuntimeConfigSnapshot,
  normalizeCatalogManifestEntries,
  normalizePluginConfigDefinition,
  normalizePlatformTargets,
  PLATFORM_TARGETS,
  renderTemplate,
  resolveSupportedNativePlatforms,
  resolveSupportedPlatforms,
  validatePluginManifest,
  validatePlatformManifestProjection,
  validateSourcePluginManifest,
} from '../../src/manifest.js'
import type { PlatformTarget, PluginMeta } from '../../src/types.js'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-platform-targets-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)))
})

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    name: 'consumer',
    version: '1.0.0',
    description: 'Platform targets fixture.',
    marketplace: {
      category: 'workflow', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...overrides,
  }
}

function plugin(platforms?: PlatformTarget[]): PluginMeta {
  return {
    rootDir: '/tmp/consumer', manifestPath: '/tmp/consumer/.agents-plugin/plugin.json',
    manifest: validatePluginManifest('/tmp/consumer', manifest(platforms === undefined ? {} : { platforms })),
  }
}

describe('canonical plugin platform targets', () => {
  it('treats omitted and empty platforms as all seven targets and preserves explicit subsets', () => {
    for (const platforms of [undefined, []] as const) {
      expect([...resolveSupportedPlatforms(plugin(platforms).manifest)])
        .toEqual(['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'generic'])
    }
    expect([...resolveSupportedPlatforms(plugin(['pi', 'cursor']).manifest)]).toEqual(['pi', 'cursor'])
    expect(normalizePlatformTargets([])).toEqual([])
    expect(PLATFORM_TARGETS).toHaveLength(7)
  })

  it.each([null, '', 'codex', [''], ['gemini'], ['claude-code'], ['agent-skills'], ['codex', 'codex']]
    .map((platforms) => ({ platforms })))(
    'rejects an invalid plugin support declaration $platforms', ({ platforms }) => {
      expect(() => assertPluginManifestStructure(manifest({ platforms }))).toThrow()
    },
  )

  it.each([
    { distributions: { agentSkills: { skills: './portable' } } },
    { marketplace: { category: 'workflow', strict: true, policy: {
      installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CLAUDE'],
    } } },
    { buildConfig: { generatedSkillRuntimeFiles: [{ skill: 'example', target: 'scripts/tool.mjs', distributions: ['agent-skills'] }] } },
  ])('rejects removed support selectors with a rebuild instruction', (override) => {
    expect(() => assertPluginManifestStructure(manifest({ platforms: ['claude'], ...override })))
      .toThrow(/MigrationRequired:.*(?:platforms|canonical target).*rebuild/iu)
  })

  it('derives Native marketplace entries and output products only from plugin platforms', () => {
    const portable = plugin(['cursor', 'pi'])
    expect([...resolveSupportedNativePlatforms(portable.manifest)]).toEqual([])
    expect(createMarketplaceManifestEntry(plugin(['claude'])).policy.products).toEqual(['CLAUDE'])
    expect(createMarketplaceManifestEntry(plugin([])).policy.products).toEqual(['CLAUDE', 'CODEX'])
    expect(createMarketplaceManifest({
      owner: { name: 'fixture', url: 'https://example.invalid' },
      interface: { displayName: 'Fixture' }, catalog: { version: '1.0.0' },
    }, [portable]).plugins).toEqual([])
    const entry = createMarketplaceManifestEntry(plugin([]))
    const normalized = normalizeCatalogManifestEntries([{
      ...entry, version: '1.0.0', dependencies: [], requires: { aw: { capabilities: [] } },
      artifactDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}`,
    }], { catalogVersion: '1.0.0', channel: 'latest', requires: { aw: { capabilities: [] } } }, 'catalog')
    expect(normalized[0]?.policy).toEqual(entry.policy)
  })

  it('requires each dependency to cover the complete consumer support set', () => {
    expect(() => assertPluginDependencyPlatformCoverage({
      source: 'fixture/catalog', consumer: { name: 'parent', platforms: [] },
      dependency: { name: 'child', platforms: ['codex', 'claude'] },
      path: ['root', 'parent', 'child'],
    })).toThrow(/source "fixture\/catalog", consumer "parent", dependency "child".*antigravity, cursor, opencode, pi, generic.*root -> parent -> child/u)
    expect(() => assertPluginDependencyPlatformCoverage({
      source: 'fixture/catalog', consumer: { name: 'parent', platforms: ['codex'] },
      dependency: { name: 'child' },
    })).not.toThrow()
  })

  it('uses canonical targets consistently for build selectors, templates and dynamic Portable Skills', () => {
    const parsed = validatePluginManifest('/tmp/consumer', manifest({
      platforms: ['cursor', 'pi'],
      buildConfig: {
        fileRules: { cursor: { include: ['skills/**'], exclude: [] } },
        templates: { vars: { agent: { cursor: 'Cursor', pi: 'Pi' } }, include: ['skills/**'] },
        skillRuntimeFiles: [{ skill: 'example', target: 'scripts/tool.mjs', platforms: ['cursor'], source: './runtime/tool.mjs' }],
        generatedSkillRuntimeFiles: [{ skill: 'example', target: 'references/options.json', platforms: ['pi'] }],
      },
      artifacts: { targets: [{
        id: 'portable-example', platform: 'cursor', distribution: 'agent-skills', target: 'agent-skills.skill',
        scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'example',
      }] },
    }))
    expect(parsed.artifacts?.targets?.[0]?.platform).toBe('cursor')
    expect(renderTemplate('{{agent}}', parsed.buildConfig!.templates!.vars, 'pi')).toBe('Pi')
    expect(() => renderTemplate('{{agent}}', parsed.buildConfig!.templates!.vars, 'generic')).toThrow(/generic/u)
    expect(renderTemplate('Portable instructions.', { nativeOnly: { codex: 'Native' } }, 'cursor'))
      .toBe('Portable instructions.')
  })

  it('fixes Native Skill production to user scope and rejects the removed delivery choice', () => {
    const target = { id: 'native', platform: 'claude', target: 'claude.skill', scopes: ['project'],
      states: ['present'], refreshKeys: [], skillKey: 'example' }
    expect(validatePluginManifest('/tmp/consumer', manifest({
      platforms: ['claude'], artifacts: { targets: [target] },
    })).artifacts?.targets?.[0]?.scopes).toEqual(['user'])
    expect(() => validatePluginManifest('/tmp/consumer', manifest({ artifacts: { targets: [{
      ...target, platform: 'codex', target: 'codex.skill', delivery: { mode: 'aw-extension' },
    }] } }))).toThrow(/nativeSkillDeliveryMigrationRequired/u)
  })

  it.each(['codex', 'claude'] as const)('validates a %s Native dynamic Skill root without a static Skill declaration', async (platform) => {
    const root = await temporaryRoot()
    const parsed = validatePluginManifest(root, manifest({
      platforms: [platform], artifacts: { targets: [{
        id: 'native', platform, target: `${platform}.skill`, scopes: ['user'],
        states: ['present'], refreshKeys: [], skillKey: 'example',
      }] },
    }))
    await fs.ensureDir(path.join(root, platform, 'skills'))
    const projection = { name: parsed.name, version: parsed.version, description: parsed.description,
      skills: `./${platform}/skills` }
    await expect(validatePlatformManifestProjection({
      rootDir: root, manifestPath: path.join(root, '.agents-plugin', 'plugin.json'), manifest: parsed,
    }, platform, projection)).resolves.toEqual(projection)
  })

  it('uses canonical Skill directories as shared dynamic source for each selected platform', async () => {
    const root = await temporaryRoot()
    await fs.outputFile(path.join(root, 'skills', 'example', 'SKILL.md'), 'Source.\n')
    const targets = [
      { id: 'codex', platform: 'codex', target: 'codex.skill' },
      { id: 'claude', platform: 'claude', target: 'claude.skill' },
      { id: 'generic', platform: 'generic', target: 'agent-skills.skill', distribution: 'agent-skills' },
    ].map((target) => ({ ...target, scopes: ['user'], states: ['present'], refreshKeys: [],
      skillKey: 'example', sourceDirs: ['./skills/example'] }))
    const raw = manifest({ platforms: ['codex', 'claude', 'generic'], skills: './skills',
      artifacts: { targets } })
    await expect(validateSourcePluginManifest(root, raw)).resolves.toMatchObject({ skills: './skills' })
    await expect(validateSourcePluginManifest(root, { ...raw, artifacts: { targets: [{
      ...targets[0], sourceDirs: undefined,
    }] } })).rejects.toThrow(/conflicts with a static Skill/u)
  })

  it('selects dynamic runtime projections by platform while retaining Native restrictions', async () => {
    const root = await temporaryRoot()
    await fs.outputFile(path.join(root, 'skills', 'example', 'SKILL.md'), 'Source.\n')
    const portable = { id: 'portable', platform: 'generic', target: 'agent-skills.skill', distribution: 'agent-skills',
      scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'example', sourceDirs: ['./skills/example'] }
    const native = { id: 'native', platform: 'codex', target: 'codex.skill', scopes: ['user'],
      states: ['present'], refreshKeys: [], skillKey: 'example', sourceDirs: ['./skills/example'] }
    const runtimeEntry = { skill: 'example', target: 'references/runtime.txt', source: './runtime.txt', platforms: ['generic'] }
    const generatedEntry = { skill: 'example', target: 'references/options.json', platforms: ['generic'] }
    const raw = manifest({ platforms: ['codex', 'generic'], skills: './skills',
      artifacts: { targets: [native, portable] },
      buildConfig: { skillRuntimeFiles: [runtimeEntry], generatedSkillRuntimeFiles: [generatedEntry] } })
    await expect(validateSourcePluginManifest(root, raw)).resolves.toMatchObject({ skills: './skills' })
    await expect(validateSourcePluginManifest(root, { ...raw, buildConfig: {
      skillRuntimeFiles: [{ ...runtimeEntry, platforms: [] }],
    } })).rejects.toThrow(/Native dynamic Skill targets.*codex/u)
    await expect(validateSourcePluginManifest(root, { ...raw, artifacts: { targets: [portable] }, buildConfig: {
      skillRuntimeFiles: [{ ...runtimeEntry, platforms: ['codex'] }],
    } })).resolves.toMatchObject({ skills: './skills' })
    await expect(validateSourcePluginManifest(root, { ...raw, skills: undefined, platforms: ['generic'],
      artifacts: { targets: [portable] },
    })).resolves.toMatchObject({ artifacts: { targets: [expect.objectContaining({ platform: 'generic' })] } })
  })

  it('allows different runtime files at one path only for disjoint target selections', () => {
    const entry = { skill: 'example', target: 'scripts/tool.mjs', source: './runtime/cursor.mjs', platforms: ['cursor'] }
    const raw = manifest({ platforms: ['cursor', 'pi'], buildConfig: { skillRuntimeFiles: [
      entry, { ...entry, source: './runtime/pi.mjs', platforms: ['pi'] },
    ] } })
    expect(() => validatePluginManifest('/tmp/consumer', raw)).not.toThrow()
    expect(() => validatePluginManifest('/tmp/consumer', manifest({ buildConfig: { skillRuntimeFiles: [
      entry, { ...entry, platforms: [] },
    ] } }))).toThrow(/duplicate target "cursor:example\/scripts\/tool.mjs"/u)
  })

  it('checks Skill secrets using the selected platform schema', () => {
    expect(() => validatePluginManifest('/tmp/consumer', manifest({
      platforms: ['cursor'],
      config: { schemaVersion: 5, fields: { key: { type: 'string' } }, platforms: {
        cursor: { fields: { key: { type: 'string', sensitive: true } } },
      } },
      artifacts: { targets: [{
        id: 'portable', platform: 'cursor', distribution: 'agent-skills', target: 'agent-skills.skill',
        scopes: ['user'], states: ['present'], refreshKeys: ['key'], skillKey: 'example',
      }] },
    }))).toThrow(/skillRenderSensitiveRefreshKey/u)
  })

  it('checks installed runtime keys against the installed platform schema', () => {
    const definition = normalizePluginConfigDefinition({
      schemaVersion: 5, fields: { key: { type: 'string' } }, platforms: {
        claude: { fields: { key: { type: 'string', sensitive: true } } },
      },
    })
    expect(() => createRuntimeConfigSnapshot({
      definition, values: { key: 'private' }, declaration: { keys: ['key'] },
      installedIdentity: {
        sourceId: 'fixture', sourceIdentity: 'fixture', pluginId: 'fixture/consumer', pluginName: 'consumer',
        pluginVersion: '1.0.0', platform: 'claude', scope: 'user', configScope: 'user',
        artifactId: 'native', skillKey: 'example',
      },
    })).toThrow(/runtimeConfigKeyDenied/u)
  })
})
