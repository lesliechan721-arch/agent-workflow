import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { computeEvalProviderDigest } from '@lesliechan721/agent-skill-eval'
import {
  buildCatalogWorkspace,
  initializeCatalogWorkspace,
  readCatalogWorkspace,
  type PluginManifestSource,
} from '@lesliechan721/aw-plugin-core'

import {
  inspectReviewTarget,
} from '../../src/commands/review-inspection.js'
import { readAwSkillEvalManifest } from '../../src/eval/manifest-v1.js'
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js'
import { resolveReviewSelection } from '../../src/review/review-selection.js'
import {
  resolveEvalProfileBindingInput,
  resolveEvalSourceBindingInput,
  resolvePortableProfileBindingInput,
  resolveWorkspaceBindingSource,
  writeAwSourceBinding,
} from '../../src/review/source-binding.js'
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js'
import { CLI_RESERVED_IMPORTS } from '../../src/utils/manifest.js'
import { writePluginConfigStore } from '../../src/utils/plugin-config.js'

const roots: string[] = []

async function tempRoot(label = 'aw-review-inspection-'): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)))
  roots.push(root)
  return root
}

function manifest(name: string, extra: Partial<PluginManifestSource> = {}): PluginManifestSource {
  return {
    schemaVersion: 3,
    name,
    version: '0.1.0',
    description: `${name} inspection fixture.`,
    mcpServers: './.mcp.json',
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...extra,
  }
}

async function writePlugin(root: string, value: PluginManifestSource): Promise<string> {
  const pluginRoot = path.join(root, 'plugins', value.name)
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), value)
  if (value.mcpServers) {
    await fs.outputJson(path.join(pluginRoot, value.mcpServers.replace(/^\.\//u, '')), {
      mcpServers: {},
    })
  }
  return pluginRoot
}

async function writeSkill(pluginRoot: string, skill: string, collection = 'skills'): Promise<string> {
  const skillRoot = path.join(pluginRoot, collection, skill)
  await fs.outputFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: ${skill} fixture.\n---\n\n# ${skill}\n`,
  )
  if (collection !== 'skills') {
    await fs.outputFile(path.join(skillRoot, 'README.md'), `# ${skill}\n`)
  }
  return skillRoot
}

async function writeEval(pluginRoot: string, skill: string, options: {
  profiles?: Array<'project' | 'user'>
} = {}): Promise<void> {
  const evalRoot = path.join(pluginRoot, 'skills', skill, 'evals')
  const profiles = options.profiles ?? ['project']
  await fs.outputJson(path.join(evalRoot, 'manifest.json'), {
    version: 1,
    defaults: { runs: 2, timeoutMs: 3000 },
    profiles: Object.fromEntries(profiles.map((scope) => [`${scope}-default`, {
      scope,
      plugins: { [path.basename(pluginRoot)]: {} },
    }])),
    suites: [{
      id: 'behavior',
      kind: 'conversation',
      cases: 'cases.json',
      profiles: profiles.map((scope) => `${scope}-default`),
    }],
  })
  await fs.outputJson(path.join(evalRoot, 'cases.json'), {
    version: 1,
    suite: { kind: 'conversation', unitUnderTest: skill, runtime: { minimumPassRate: 0.75 } },
    cases: [
      { id: 'selected', split: 'validation', tags: [], prompt: 'Run selected.', assertions: ['Selected.'] },
      { id: 'not-selected', split: 'train', tags: [], prompt: 'Run train.', assertions: ['Train.'] },
    ],
  })
}

async function buildStaticSnapshot(root: string): Promise<void> {
  await buildCatalogWorkspace({
    workspaceRoot: root,
    adapter: {
      async build(options) {
        await bundleLocalPlugin(options.plugin, options.outputRoot, {
          buildMode: 'staging',
          runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
        })
      },
    },
  })
}

async function conversationEvalInput(options: {
  workspaceRoot: string
  materializedRoot: string
  loaded: Awaited<ReturnType<typeof readAwSkillEvalManifest>>
  caseIds?: readonly string[]
}) {
  await fs.ensureDir(path.join(options.materializedRoot, 'workspace', 'eval'))
  const suite = options.loaded.manifest.suites[0]!
  return await resolveEvalSourceBindingInput({
    workspaceRoot: options.workspaceRoot,
    evalRoot: options.loaded.evalRoot,
    manifestPath: options.loaded.manifestPath,
    suite,
    defaults: options.loaded.manifest.defaults,
    cases: options.loaded.casesBySuite.get(suite.id)!,
    corpusPaths: options.loaded.manifest.suites.map((entry) => entry.cases),
    selection: {
      caseIds: options.caseIds
        ?? options.loaded.casesBySuite.get(suite.id)!.cases.map((entry) => entry.id),
    },
    providerDigest: computeEvalProviderDigest('codex-conversation'),
    preparedEvalRoot: path.join(options.materializedRoot, 'workspace', 'eval'),
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('AW Review static inspection', () => {
  it('uses only a current snapshot and keeps equal leaf digests distinct by profile', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('static', {
      skills: './skills',
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    const skillRoot = await writeSkill(pluginRoot, 'shared')
    await buildStaticSnapshot(root)

    const current = await inspectReviewTarget({ cwd: root, target: root })
    expect(current.snapshot?.state).toBe('current')
    expect(current.ok).toBe(true)
    expect(current.skills.map((entry) => `${entry.profile.platform}-${entry.profile.scope}`))
      .toEqual(['codex-project', 'codex-user'])
    expect(current.skills.every((entry) => entry.state === 'ready')).toBe(true)
    expect(new Set(current.skills.map((entry) => entry.digest)).size).toBe(1)

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nChanged.\n')
    const stale = await inspectReviewTarget({ cwd: root, target: root })
    expect(stale.snapshot?.state).toBe('stale')
    expect(stale.ok).toBe(true)
    expect(stale.skills.every((entry) => entry.state === 'missing' && entry.finalPath === null)).toBe(true)
    expect(stale.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'snapshotStale' }),
      expect.objectContaining({ code: 'requiredFinalMissing' }),
    ]))
  })

  it('matches a legacy portable binding against only the corresponding Skill config', async () => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot('aw-review-portable-leaf-config-')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const targets = [
      ...['one', 'two'].map((skill) => ({
        id: skill,
        distribution: 'agent-skills' as const,
        target: 'agent-skills.skill' as const,
        kind: 'skill' as const,
        scopes: ['project' as const],
        states: ['present' as const],
        refreshKeys: [skill],
        skillKey: skill,
        sourceDirs: [`./portable-skills/${skill}`],
      })),
      {
        id: 'native',
        platform: 'codex' as const,
        target: 'codex.skill' as const,
        kind: 'skill' as const,
        scopes: ['project' as const, 'user' as const],
        states: ['present' as const],
        delivery: { mode: 'codex-native' as const, identity: 'shared', renderProfile: 'user' as const },
        refreshKeys: ['one'],
        skillKey: 'native',
        sourceDirs: ['./skills/native'],
      },
    ]
    const pluginRoot = await writePlugin(root, manifest('portable-leaves', {
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
      config: { fields: {
        one: { type: 'string', default: 'default-one' },
        two: { type: 'string', default: 'default-two' },
      } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets },
    }))
    const oneRoot = await writeSkill(pluginRoot, 'one', 'portable-skills')
    await writeSkill(pluginRoot, 'two', 'portable-skills')
    await writeSkill(pluginRoot, 'native')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    await writePluginConfigStore({
      pluginName: 'portable-leaves',
      scope: 'project',
      cwd: root,
      values: { one: 'ignored-project', two: 'custom-two' },
    })
    await fs.copy(oneRoot, path.join(materializedRoot, 'one'))
    const binding = await writeAwSourceBinding({
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'portable-leaves' },
      profile: await resolvePortableProfileBindingInput({
        plugins: workspace.plugins,
        pluginName: 'portable-leaves',
        scope: 'project',
        cwd: root,
      }),
      artifacts: [{
        kind: 'portable-skill',
        plugin: 'portable-leaves',
        skill: 'one',
        path: 'one',
      }],
    })
    const configFile = path.join(root, 'review-config.json')
    await fs.outputJson(configFile, { 'portable-leaves': { two: 'custom-two' } })

    const receipt = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      platform: 'agent-skills',
      scope: 'project',
      configFile,
      materializations: [binding.bindingPath],
    })

    expect(receipt.skills.find((entry) => entry.skill === 'one'))
      .toMatchObject({ state: 'ready', evidencePath: binding.bindingPath })
    expect(receipt.skills.find((entry) => entry.skill === 'two'))
      .toMatchObject({ state: 'missing' })
    expect(receipt.issues).not.toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }))

    const incompatibleConfigFile = path.join(root, 'review-incompatible-config.json')
    await fs.outputJson(incompatibleConfigFile, {
      'portable-leaves': { one: 'ignored-project', two: 'custom-two' },
    })
    const incompatible = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['one'],
      platform: 'agent-skills',
      scope: 'project',
      configFile: incompatibleConfigFile,
      materializations: [binding.bindingPath],
    })
    expect(incompatible.skills).toEqual([
      expect.objectContaining({ skill: 'one', state: 'missing' }),
    ])
    expect(incompatible.issues).toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }))
  })

  it('does not reinterpret an Eval project override for a native-shared key as user config', async () => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot('aw-review-eval-shared-config-')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('eval-shared-config', {
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
      config: { fields: {
        shared: { type: 'string', default: 'shared-default' },
        projectOnly: { type: 'string', default: 'project-default' },
      } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [
        {
          id: 'native',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          states: ['present'],
          refreshKeys: ['shared'],
          skillKey: 'native',
          sourceDirs: ['./skills/native'],
        },
        {
          id: 'extension',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          states: ['present'],
          refreshKeys: ['shared', 'projectOnly'],
          skillKey: 'extension',
          sourceDirs: ['./skills/extension'],
        },
      ] },
    }))
    await writeSkill(pluginRoot, 'native')
    const extensionRoot = await writeSkill(pluginRoot, 'extension')
    await writeEval(pluginRoot, 'extension')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')
    const evalManifestPath = path.join(extensionRoot, 'evals', 'manifest.json')
    const evalManifest = await fs.readJson(evalManifestPath)
    evalManifest.profiles['project-default'].plugins['eval-shared-config'] = {
      shared: 'eval-project-shared',
      projectOnly: 'eval-project-only',
    }
    await fs.writeJson(evalManifestPath, evalManifest)
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    const plugin = workspace.plugins.find((entry) => entry.manifest.name === 'eval-shared-config')!
    const loaded = await readAwSkillEvalManifest({ plugin, skill: 'extension' })
    await fs.copy(extensionRoot, path.join(materializedRoot, 'target'))
    await fs.outputFile(path.join(materializedRoot, 'workspace', '.keep'), '')
    const sourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot,
      loaded,
    })
    await fs.outputJson(path.join(materializedRoot, 'cases.json'), sourceInput.selectedCases)
    const binding = await writeAwSourceBinding({
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'eval-shared-config', skill: 'extension', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: sourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'extension', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    })
    const matchingConfigFile = path.join(root, 'review-matching-config.json')
    await fs.outputJson(matchingConfigFile, {
      'eval-shared-config': { projectOnly: 'eval-project-only' },
    })

    const matching = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['extension'],
      platform: 'codex',
      scope: 'project',
      configFile: matchingConfigFile,
      materializations: [binding.bindingPath],
    })
    expect(matching.skills).toEqual([
      expect.objectContaining({ skill: 'extension', state: 'ready', evidencePath: binding.bindingPath }),
    ])

    const incompatibleConfigFile = path.join(root, 'review-incompatible-config.json')
    await fs.outputJson(incompatibleConfigFile, {
      'eval-shared-config': {
        shared: 'eval-project-shared',
        projectOnly: 'eval-project-only',
      },
    })
    const incompatible = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['extension'],
      platform: 'codex',
      scope: 'project',
      configFile: incompatibleConfigFile,
      materializations: [binding.bindingPath],
    })
    expect(incompatible.skills).toEqual([
      expect.objectContaining({ skill: 'extension', state: 'missing' }),
    ])
    expect(incompatible.issues).toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }))
  })

  it('navigates a source Skill review and rejects conflicting finals', async () => {
    const root = await tempRoot()
    const firstRoot = await tempRoot('aw-review-navigation-first-')
    const secondRoot = await tempRoot('aw-review-navigation-second-')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('navigation', {
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'navigation-native',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'navigation-skill',
        sourceDirs: ['./skills/navigation-skill'],
      }] },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    const skillRoot = await writeSkill(pluginRoot, 'navigation-skill')
    await writeEval(pluginRoot, 'navigation-skill')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')
    const target = path.join(skillRoot, 'SKILL.md')
    const selection = await resolveReviewSelection({
      cwd: root,
      target,
      skills: ['navigation-skill', 'navigation-skill'],
      platform: 'codex',
      scope: 'project',
    })
    const workspace = selection.workspace

    const evalRoot = await tempRoot('aw-review-navigation-eval-')
    const loaded = await readAwSkillEvalManifest({
      plugin: workspace.plugins[0]!,
      skill: 'navigation-skill',
    })
    await fs.copy(skillRoot, path.join(evalRoot, 'target'))
    await fs.outputFile(path.join(evalRoot, 'workspace', '.keep'), '')
    const evalSourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot: evalRoot,
      loaded,
      caseIds: ['selected'],
    })
    await fs.outputJson(path.join(evalRoot, 'cases.json'), evalSourceInput.selectedCases)
    const evalBinding = await writeAwSourceBinding({
      rootDir: evalRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: evalSourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'navigation-skill', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    })
    const evalReview = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [evalBinding.bindingPath],
    })
    expect(evalReview.skills).toEqual([expect.objectContaining({ state: 'missing' })])
    expect(evalReview.issues).toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: evalBinding.bindingPath,
    }))
    await fs.copy(skillRoot, path.join(firstRoot, 'navigation-skill'))
    const first = await writeAwSourceBinding({
      rootDir: firstRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill' },
      profile: selection.profiles[0]!.profile,
      artifacts: [{
        kind: 'review-skill',
        plugin: 'navigation',
        skill: 'navigation-skill',
        path: 'navigation-skill',
      }],
    })

    const current = await inspectReviewTarget({
      cwd: root,
      target,
      skills: ['navigation-skill'],
      platform: 'codex',
      scope: 'project',
      materializations: [first.bindingPath, first.bindingPath],
    })
    expect(current).toMatchObject({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: true,
      target: { kind: 'skill', path: skillRoot },
      skills: [{
        skill: 'navigation-skill',
        sourcePath: skillRoot,
        state: 'ready',
        evidencePath: first.bindingPath,
      }],
    })
    expect(current).not.toHaveProperty('requiredEvals')
    expect(current).not.toHaveProperty('subjects')
    const legacyRoot = await tempRoot('aw-review-navigation-v1-')
    const legacyBinding = await fs.readJson(first.bindingPath)
    legacyBinding.schemaVersion = 1
    const legacyBindingPath = path.join(legacyRoot, 'aw-source-binding.json')
    await fs.outputJson(legacyBindingPath, legacyBinding)
    await expect(inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [legacyBindingPath],
    })).rejects.toMatchObject({ code: 'sourceBindingInvalid', exitCode: 2 })

    await fs.copy(skillRoot, path.join(secondRoot, 'navigation-skill'))
    await fs.appendFile(path.join(secondRoot, 'navigation-skill', 'SKILL.md'), '\nDifferent final.\n')
    const second = await writeAwSourceBinding({
      rootDir: secondRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill' },
      profile: selection.profiles[0]!.profile,
      artifacts: [{
        kind: 'review-skill',
        plugin: 'navigation',
        skill: 'navigation-skill',
        path: 'navigation-skill',
      }],
    })
    const ambiguous = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [second.bindingPath, first.bindingPath],
    })
    expect(ambiguous.skills).toEqual([
      expect.objectContaining({ state: 'invalid', finalPath: null, digest: null, evidencePath: null }),
    ])
    expect(ambiguous.issues).toContainEqual(expect.objectContaining({ code: 'materializationAmbiguous' }))

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nSource drift.\n')
    const stale = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [first.bindingPath],
    })
    expect(stale).toMatchObject({
      ok: true,
      skills: [{ state: 'stale', finalPath: path.join(firstRoot, 'navigation-skill') }],
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingDrifted' })]),
    })
  })

  it('navigates the declared source for each dynamic Skill surface', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })

    const portableRoot = await writePlugin(root, manifest('declared-portable', {
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'portable-output',
        distribution: 'agent-skills',
        scopes: ['project'],
        target: 'agent-skills.skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'shared-name',
        sourceDirs: ['./portable-source'],
      }] },
    }))
    await writeSkill(portableRoot, 'shared-name', 'portable-skills')
    const portableSource = path.join(portableRoot, 'portable-source')
    await fs.outputFile(path.join(portableSource, 'input.txt'), 'portable declared source\n')
    await fs.outputFile(path.join(portableRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')

    const surfacesRoot = await writePlugin(root, manifest('surface-sources', {
      skills: './skills',
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [
        {
          id: 'shared-target',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          states: ['present'],
          refreshKeys: [],
          skillKey: 'same-skill',
          sourceDirs: ['./skills/same-skill/codex-source', './skills/same-skill'],
        },
        {
          id: 'shared-target',
          platform: 'claude',
          scopes: ['project'],
          target: 'claude.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'same-skill',
          sourceDirs: ['./skills/same-skill/claude-source', './skills/same-skill'],
        },
      ] },
    }))
    const surfaceSkillRoot = await writeSkill(surfacesRoot, 'same-skill')
    const codexSource = path.join(surfaceSkillRoot, 'codex-source')
    const claudeSource = path.join(surfaceSkillRoot, 'claude-source')
    await fs.outputFile(path.join(codexSource, 'input.txt'), 'codex source\n')
    await fs.outputFile(path.join(claudeSource, 'input.txt'), 'claude source\n')
    await fs.outputFile(path.join(surfacesRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')

    const extensionRoot = await writePlugin(root, manifest('renderer-source', {
      skills: './skills',
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'extension-output',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        states: ['present'],
        refreshKeys: [],
        skillKey: 'placeholder',
      }] },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    const placeholder = await writeSkill(extensionRoot, 'placeholder')
    const rendererSource = path.join(extensionRoot, 'scripts', 'render.mjs')
    await fs.outputFile(rendererSource, '// actual extension source\n')

    const assertMappedSource = async (options: {
      pluginRoot: string
      skill: string
      platform: 'codex' | 'claude' | 'agent-skills'
      expectedSource: string
    }): Promise<void> => {
      const review = await inspectReviewTarget({
        cwd: root,
        target: options.pluginRoot,
        skills: [options.skill],
        platform: options.platform,
        scope: 'project',
      })
      expect(review.skills).toEqual([
        expect.objectContaining({ skill: options.skill, sourcePath: options.expectedSource }),
      ])
    }

    await assertMappedSource({
      pluginRoot: portableRoot,
      skill: 'shared-name',
      platform: 'agent-skills',
      expectedSource: portableSource,
    })
    await assertMappedSource({
      pluginRoot: surfacesRoot,
      skill: 'same-skill',
      platform: 'codex',
      expectedSource: codexSource,
    })
    await assertMappedSource({
      pluginRoot: surfacesRoot,
      skill: 'same-skill',
      platform: 'claude',
      expectedSource: claudeSource,
    })
    await assertMappedSource({
      pluginRoot: extensionRoot,
      skill: 'placeholder',
      platform: 'codex',
      expectedSource: rendererSource,
    })
    expect(rendererSource).not.toBe(placeholder)
  })
})
