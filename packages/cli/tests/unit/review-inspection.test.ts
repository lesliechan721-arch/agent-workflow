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

import { inspectReviewTarget } from '../../src/commands/review-inspection.js'
import { readAwSkillEvalManifest } from '../../src/eval/manifest-v1.js'
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js'
import { materializePortableSkills } from '../../src/portable/materializer.js'
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
  required?: boolean
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
      requiredForRelease: options.required ?? true,
      releaseSplits: ['validation'],
      releaseProcessManagement: 'allow-unmanaged-confirmed',
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
  it('inspects an empty Catalog from an absolute target outside the Workspace', async () => {
    const root = await tempRoot()
    const outside = await tempRoot('aw-review-inspection-outside-')
    await initializeCatalogWorkspace({ workspaceRoot: root })

    const receipt = await inspectReviewTarget({ cwd: outside, target: root })

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      command: 'review:inspect',
      ok: true,
      completeness: 'complete',
      target: { kind: 'catalog', path: root },
      snapshot: { state: 'absent' },
      plugins: [],
      requiredFinals: [],
      requiredEvals: [],
      issues: [],
    })
  })

  it('keeps an empty canonical Plugin as a complete source fact', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('empty'))

    const receipt = await inspectReviewTarget({ cwd: root, target: pluginRoot })

    expect(receipt).toMatchObject({
      ok: true,
      target: { kind: 'plugin', id: 'empty' },
      plugins: [{ id: 'empty', finalProfiles: [], requiredFinalKeys: [] }],
      requiredFinals: [],
      requiredEvals: [],
      issues: [],
    })
    expect(receipt.subjects).toContainEqual(expect.objectContaining({
      key: 'plugin:empty:source', kind: 'aw-plugin-source', plugin: 'empty',
    }))
  })

  it('reports source-only native and portable leaves, typed imports, and no invented Eval requirement', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const providerRoot = await writePlugin(root, manifest('provider', {
      skills: './skills',
      buildConfig: {
        runtimeExports: [{
          name: 'rules',
          source: './shared/rules.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }))
    await writeSkill(providerRoot, 'native')
    await fs.outputJson(path.join(providerRoot, 'shared', 'rules.json'), { version: 1 })
    const consumerRoot = await writePlugin(root, manifest('consumer', {
      dependencies: ['provider'],
      buildConfig: {
        buildImports: [{ plugin: 'provider', export: 'rules', env: 'AW_PLUGIN_IMPORT_RULES_PATH' }],
      },
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
    }))
    await writeSkill(consumerRoot, 'portable', 'portable-skills')

    const receipt = await inspectReviewTarget({ cwd: root, target: '.' })

    expect(receipt.plugins.map((entry) => entry.id)).toEqual(['consumer', 'provider'])
    expect(receipt.plugins.find((entry) => entry.id === 'consumer')?.imports).toEqual([{
      purpose: 'build', provider: 'provider', export: 'rules', consumer: 'AW_PLUGIN_IMPORT_RULES_PATH',
    }])
    expect(receipt.requiredFinals.filter((entry) => entry.plugin === 'consumer').map((entry) => entry.profile))
      .toEqual(['agent-skills-project', 'agent-skills-user'])
    expect(receipt.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'source-skill', plugin: 'provider', skill: 'native' }),
      expect.objectContaining({ kind: 'portable-source-skill', plugin: 'consumer', skill: 'portable' }),
    ]))
    expect(receipt.requiredEvals).toEqual([])
    expect(receipt.issues.filter((entry) => entry.code === 'requiredEvalManifestMissing')).toEqual([])
    expect(receipt.ok).toBe(false)
  })

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

    const current = await inspectReviewTarget({ cwd: root, target: './plugins/static' })
    const finals = current.requiredFinals.filter((entry) => entry.skill === 'shared')
    expect(current.snapshot.state).toBe('current')
    expect(current.ok).toBe(true)
    expect(finals.map((entry) => entry.profile)).toEqual(['codex-project', 'codex-user'])
    expect(new Set(finals.map((entry) => entry.digest)).size).toBe(1)
    expect(new Set(finals.map((entry) => entry.key)).size).toBe(2)

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nChanged.\n')
    const stale = await inspectReviewTarget({ cwd: root, target: 'static' })
    expect(stale.snapshot.state).toBe('stale')
    expect(stale.requiredFinals.every((entry) => entry.status === 'missing')).toBe(true)
    expect(stale.subjects.some((entry) => entry.origin === 'catalog-snapshot')).toBe(false)
    expect(stale.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'snapshotStale', blocking: false }),
      expect.objectContaining({ code: 'requiredFinalMissing', blocking: true }),
    ]))
  })

  it('derives only Codex required Evals and never executes an artifact renderer', async () => {
    const root = await tempRoot()
    const sideEffect = path.join(root, 'renderer-ran')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('dynamic', {
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-skill',
        sourceDirs: ['./skills/dynamic-skill'],
      }] },
    }))
    await writeSkill(pluginRoot, 'dynamic-skill')
    await writeEval(pluginRoot, 'dynamic-skill')
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'render.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sideEffect)}, 'ran');\n`,
    )

    const receipt = await inspectReviewTarget({ cwd: root, target: pluginRoot })

    expect(receipt.requiredEvals).toHaveLength(1)
    expect(receipt.requiredEvals[0]).toMatchObject({
      finalProfile: 'codex-project',
      evalProfile: { id: 'project-default', scope: 'project', plugins: ['dynamic'] },
      suite: { id: 'behavior', kind: 'conversation' },
      cases: { selected: [{ id: 'selected', split: 'validation', minimumRuns: 2 }] },
      runs: 2,
      timeoutMs: 3000,
      minimumPassRate: 0.75,
      processManagement: 'allow-unmanaged-confirmed',
    })
    await expect(fs.pathExists(sideEffect)).resolves.toBe(false)
  })

  it('reports an explicit required Eval profile with no Codex final as unsupported', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('claude-only', {
      skills: './skills',
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CLAUDE'] },
      },
    }))
    await writeSkill(pluginRoot, 'review')
    await writeEval(pluginRoot, 'review')

    const receipt = await inspectReviewTarget({ cwd: root, target: pluginRoot })

    expect(receipt.requiredEvals).toEqual([])
    expect(receipt.issues).toContainEqual(expect.objectContaining({
      category: 'unsupported', code: 'requiredEvalTargetUnsupported', blocking: true,
    }))
  })

  it('validates config only for profiles selected by a required Eval suite', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('configured', {
      skills: './skills',
      config: { fields: { mode: { type: 'string', required: true } } },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    await writeSkill(pluginRoot, 'configured-skill')
    await writeEval(pluginRoot, 'configured-skill')
    const evalManifestPath = path.join(pluginRoot, 'skills', 'configured-skill', 'evals', 'manifest.json')
    const evalManifest = await fs.readJson(evalManifestPath)
    evalManifest.profiles['project-default'].plugins.configured = { mode: 'release' }
    evalManifest.profiles.unused = { scope: 'project', plugins: { configured: {} } }
    evalManifest.suites.push({
      id: 'optional',
      kind: 'conversation',
      cases: 'cases.json',
      profiles: ['unused'],
      requiredForRelease: false,
    })
    await fs.writeJson(evalManifestPath, evalManifest)

    const receipt = await inspectReviewTarget({ cwd: root, target: pluginRoot })

    expect(receipt.requiredEvals).toHaveLength(1)
    expect(receipt.requiredEvals[0]?.evalProfile.id).toBe('project-default')
    expect(receipt.issues.some((issue) => issue.code === 'evalProfileInvalid')).toBe(false)
  })

  it('uses a verified Eval binding as a static Codex final without a snapshot', async () => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot('aw-review-static-materialization-')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('static-bound', {
      skills: './skills',
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    const skillRoot = await writeSkill(pluginRoot, 'static-skill')
    await writeEval(pluginRoot, 'static-skill')
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    const loaded = await readAwSkillEvalManifest({ plugin: workspace.plugins[0]!, skill: 'static-skill' })
    await fs.copy(skillRoot, path.join(materializedRoot, 'target'))
    await fs.outputFile(path.join(materializedRoot, 'workspace', '.keep'), '')
    const sourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot,
      loaded,
      caseIds: ['selected'],
    })
    await fs.outputJson(path.join(materializedRoot, 'cases.json'), sourceInput.selectedCases)
    const written = await writeAwSourceBinding({
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'static-bound', skill: 'static-skill', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: sourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'static-skill', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    })

    const receipt = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      materializations: [written.bindingPath],
    })

    expect(receipt.snapshot.state).toBe('absent')
    expect(receipt.requiredFinals.find((entry) => entry.profile === 'codex-project'))
      .toMatchObject({ status: 'resolved', matchedFinalKeys: [expect.any(String)] })
    expect(receipt.requiredEvals[0]).toMatchObject({
      suite: {
        id: 'behavior',
        kind: 'conversation',
        suiteDefaultsDigest: sourceInput.input.suiteDefaultsDigest,
      },
      cases: {
        sourcePath: 'plugins/static-bound/skills/static-skill/evals/cases.json',
        sourceCorpusDigest: expect.stringMatching(/^sha256:/u),
        selectedCasesDigest: sourceInput.input.selectedCasesDigest,
      },
      materializedFinalKeys: [expect.any(String)],
      verifiedBindingPaths: [written.bindingPath],
    })
    const verifiedBinding = receipt.materializations[0]?.verifiedBinding
    expect(verifiedBinding).toMatchObject({
      profile: { kind: 'eval', id: 'project-default' },
      evalInput: {
        selectedCaseIds: ['selected'],
        selectedCasesDigest: sourceInput.input.selectedCasesDigest,
        providerDigest: computeEvalProviderDigest('codex-conversation'),
        inputDigest: sourceInput.input.inputDigest,
      },
    })
    expect(verifiedBinding?.artifacts.map((entry) => entry.kind))
      .toEqual(['eval-cases', 'eval-target', 'eval-workspace'])
    expect(receipt.requiredEvals[0]?.cases.sourceCorpusDigest).not.toBe(
      verifiedBinding?.artifacts.find((entry) => entry.kind === 'eval-cases')?.digest,
    )

    const sourceCases = await fs.readJson(path.join(loaded.evalRoot, 'cases.json'))
    sourceCases.cases[0].prompt = 'Changed after preparation.'
    await fs.writeJson(path.join(loaded.evalRoot, 'cases.json'), sourceCases)
    const drifted = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      materializations: [written.bindingPath],
    })
    expect(drifted.materializations[0]).toMatchObject({
      state: 'drifted',
      finalKeys: [],
      issues: [expect.stringContaining('prepared input')],
    })
  })

  it('attributes portable dependency outputs to their declared provider Plugin', async () => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot('aw-review-portable-materialization-')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const portableCapability = {
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
    }
    const providerRoot = await writePlugin(root, manifest('portable-provider', portableCapability))
    const consumerRoot = await writePlugin(root, manifest('portable-consumer', {
      ...portableCapability,
      dependencies: ['portable-provider'],
    }))
    const unrelatedRoot = await writePlugin(root, manifest('unrelated'))
    const providerSkill = await writeSkill(providerRoot, 'provider-skill', 'portable-skills')
    const consumerSkill = await writeSkill(consumerRoot, 'consumer-skill', 'portable-skills')
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    await fs.copy(providerSkill, path.join(materializedRoot, 'skills', 'provider-skill'))
    await fs.copy(consumerSkill, path.join(materializedRoot, 'skills', 'consumer-skill'))
    const written = await writeAwSourceBinding({
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'portable-consumer' },
      profile: await resolvePortableProfileBindingInput({
        plugins: workspace.plugins,
        pluginName: 'portable-consumer',
        scope: 'project',
        cwd: root,
      }),
      artifacts: [
        {
          kind: 'portable-skill',
          plugin: 'portable-provider',
          skill: 'provider-skill',
          path: 'skills/provider-skill',
        },
        {
          kind: 'portable-skill',
          plugin: 'portable-consumer',
          skill: 'consumer-skill',
          path: 'skills/consumer-skill',
        },
      ],
    })

    const catalog = await inspectReviewTarget({
      cwd: root,
      target: 'catalog',
      materializations: [written.bindingPath],
    })
    expect(catalog.subjects.filter((entry) => entry.origin === 'source-binding').map((entry) => entry.plugin))
      .toEqual(['portable-consumer', 'portable-provider'])
    expect(catalog.requiredFinals.filter((entry) => entry.profile === 'agent-skills-project')
      .map((entry) => [entry.plugin, entry.status])).toEqual([
      ['portable-consumer', 'resolved'],
      ['portable-provider', 'resolved'],
    ])

    const consumer = await inspectReviewTarget({
      cwd: root,
      target: consumerRoot,
      materializations: [written.bindingPath],
    })
    expect(consumer.subjects.filter((entry) => entry.origin === 'source-binding').map((entry) => entry.plugin))
      .toEqual(['portable-consumer'])

    const provider = await inspectReviewTarget({
      cwd: root,
      target: providerRoot,
      materializations: [written.bindingPath],
    })
    expect(provider.materializations[0]).toMatchObject({ state: 'verified', finalKeys: [expect.any(String)] })
    expect(provider.requiredFinals.filter((entry) => entry.profile === 'agent-skills-project'))
      .toEqual([expect.objectContaining({ plugin: 'portable-provider', status: 'resolved' })])

    const unrelated = await inspectReviewTarget({
      cwd: root,
      target: unrelatedRoot,
      materializations: [written.bindingPath],
    })
    expect(unrelated).toMatchObject({
      ok: true,
      materializations: [{ state: 'verified', finalKeys: [] }],
      issues: [{ category: 'unknown', code: 'sourceBindingUnused', blocking: false }],
    })
  })

  it('rejects an old portable final when equal config values change their source', async () => {
    const root = await tempRoot()
    const outputRoot = await tempRoot('aw-review-config-source-')
    const env = { ...process.env, AW_HOME: path.join(outputRoot, 'home') }
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const target = {
      id: 'configured', distribution: 'agent-skills' as const,
      target: 'agent-skills.skill' as const, kind: 'skill' as const,
      scopes: ['project' as const], states: ['present' as const],
      refreshKeys: ['mode'], skillKey: 'configured',
    }
    const pluginRoot = await writePlugin(root, manifest('configured', {
      distributions: { agentSkills: { skills: './portable-skills' } },
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      config: { fields: { mode: { type: 'string' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [target] },
    }))
    await writeSkill(pluginRoot, 'configured', 'portable-skills')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      "import { readFileSync } from 'node:fs';",
      'const context = JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `const target = ${JSON.stringify(target)};`,
      'delete target.scopes; delete target.states;',
      'const body = "---\\nname: configured\\ndescription: Config source fixture.\\n---\\n" + context.config.values.mode + ":" + context.config.sources.mode;',
      'console.log(JSON.stringify({ version: 2, artifacts: [{ ...target, state: "present", content: { files: { "SKILL.md": body, "README.md": "# Config source fixture" } } }] }));',
    ].join('\n'))
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    const configOptions = { pluginName: 'configured', cwd: root, env, values: { mode: 'same' } }
    const profileOptions = {
      plugins: workspace.plugins, pluginName: 'configured', scope: 'project' as const, cwd: root, env,
    }
    const materializeOptions = { ...profileOptions, pluginId: 'configured' }
    await writePluginConfigStore({ ...configOptions, scope: 'user' })
    const first = await materializePortableSkills({
      ...materializeOptions, outputRoot: path.join(outputRoot, 'first'),
    })
    const profile = await resolvePortableProfileBindingInput(profileOptions)
    expect(first.configDigest).toBe(profile.inputDigest)
    await expect(fs.readFile(path.join(first.rootDir, 'skills/configured/SKILL.md'), 'utf8'))
      .resolves.toContain('same:user')
    const written = await writeAwSourceBinding({
      rootDir: first.rootDir,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'configured' }, profile,
      artifacts: [{ kind: 'portable-skill', plugin: 'configured', skill: 'configured', path: 'skills/configured' }],
    })
    const inspectOptions = { cwd: root, env, target: pluginRoot, materializations: [written.bindingPath] }
    expect((await inspectReviewTarget(inspectOptions)).materializations[0]?.state).toBe('verified')

    await writePluginConfigStore({ ...configOptions, scope: 'project' })
    const second = await materializePortableSkills({
      ...materializeOptions, outputRoot: path.join(outputRoot, 'second'),
    })
    await expect(fs.readFile(path.join(second.rootDir, 'skills/configured/SKILL.md'), 'utf8'))
      .resolves.toContain('same:project')
    expect(second.digest).not.toBe(first.digest)
    expect(second.configDigest).not.toBe(first.configDigest)
    expect((await resolvePortableProfileBindingInput(profileOptions)).inputDigest).toBe(second.configDigest)
    const stale = await inspectReviewTarget(inspectOptions)
    expect(stale.materializations[0]).toMatchObject({ state: 'drifted', finalKeys: [] })
    expect(stale.issues).toContainEqual(expect.objectContaining({ code: 'sourceBindingDrifted', blocking: true }))
  })

  it('accepts a verified Eval final, then rejects it after Workspace source drift', async () => {
    const root = await tempRoot()
    await initializeCatalogWorkspace({ workspaceRoot: root })
    const pluginRoot = await writePlugin(root, manifest('bound', {
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'bound-skill',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'bound-skill',
        sourceDirs: ['./skills/bound-skill'],
      }] },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
    }))
    const skillRoot = await writeSkill(pluginRoot, 'bound-skill')
    await writeEval(pluginRoot, 'bound-skill')
    const manifestPath = path.join(skillRoot, 'evals', 'manifest.json')
    const evalManifest = await fs.readJson(manifestPath)
    evalManifest.profiles['project-other'] = evalManifest.profiles['project-default']
    evalManifest.suites[0].profiles.push('project-other')
    await fs.writeJson(manifestPath, evalManifest)
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n')
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    const loaded = await readAwSkillEvalManifest({ plugin: workspace.plugins[0]!, skill: 'bound-skill' })
    const bindingPaths: string[] = []
    for (const evalProfile of loaded.manifest.profiles) {
      const materializedRoot = await tempRoot('aw-review-materialization-')
      const profile = resolveEvalProfileBindingInput(evalProfile, workspace.plugins).profile
      await fs.copy(skillRoot, path.join(materializedRoot, 'target'))
      await fs.outputFile(path.join(materializedRoot, 'workspace', '.keep'), '')
      const sourceInput = await conversationEvalInput({ workspaceRoot: root, materializedRoot, loaded })
      await fs.outputJson(path.join(materializedRoot, 'cases.json'), sourceInput.selectedCases)
      const written = await writeAwSourceBinding({
        rootDir: materializedRoot,
        source: await resolveWorkspaceBindingSource(workspace),
        subject: { plugin: 'bound', skill: 'bound-skill', suite: 'behavior' },
        profile,
        evalInput: sourceInput.input,
        artifacts: [
          { kind: 'eval-target', skill: 'bound-skill', path: 'target' },
          { kind: 'eval-workspace', path: 'workspace' },
          { kind: 'eval-cases', path: 'cases.json' },
        ],
      })
      bindingPaths.push(written.bindingPath)
    }

    const current = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      materializations: [...bindingPaths, bindingPaths[0]!],
    })
    expect(current.materializations).toHaveLength(3)
    expect(current.materializations.map((entry) => ({
      state: entry.state,
      finalKeys: entry.finalKeys.length,
      issues: entry.issues,
    }))).toEqual([
      { state: 'verified', finalKeys: 1, issues: [] },
      { state: 'verified', finalKeys: 1, issues: [] },
      { state: 'verified', finalKeys: 1, issues: [] },
    ])
    expect(current.requiredFinals.find((entry) => entry.profile === 'codex-project'))
      .toMatchObject({ status: 'resolved', path: null, digest: null, matchedFinalKeys: [expect.any(String), expect.any(String)] })
    const profileFinals = current.subjects.filter((entry) =>
      entry.plugin === 'bound' && entry.origin === 'source-binding')
    expect(profileFinals.map((entry) => entry.materializationProfile?.id).sort())
      .toEqual(['project-default', 'project-other'])
    expect(new Set(profileFinals.map((entry) => entry.digest)).size).toBe(1)
    expect(current.requiredEvals.map((entry) => entry.materializedFinalKeys.length)).toEqual([1, 1])

    const ambiguousRoot = await tempRoot('aw-review-ambiguous-materialization-')
    await fs.copy(skillRoot, path.join(ambiguousRoot, 'target'))
    await fs.appendFile(path.join(ambiguousRoot, 'target', 'SKILL.md'), '\nDifferent target.\n')
    await fs.outputFile(path.join(ambiguousRoot, 'workspace', '.keep'), '')
    const ambiguousSourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot: ambiguousRoot,
      loaded,
    })
    await fs.outputJson(path.join(ambiguousRoot, 'cases.json'), ambiguousSourceInput.selectedCases)
    const ambiguousBinding = await writeAwSourceBinding({
      rootDir: ambiguousRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'bound', skill: 'bound-skill', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: ambiguousSourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'bound-skill', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    })
    const ambiguousPaths = [bindingPaths[0]!, bindingPaths[1]!, ambiguousBinding.bindingPath]
    const [forward, reverse] = await Promise.all([
      inspectReviewTarget({ cwd: root, target: pluginRoot, materializations: ambiguousPaths }),
      inspectReviewTarget({ cwd: root, target: pluginRoot, materializations: [...ambiguousPaths].reverse() }),
    ])
    const ambiguityView = (receipt: typeof forward) => ({
      required: receipt.requiredFinals.find((entry) => entry.profile === 'codex-project'),
      issues: receipt.issues.filter((issue) => issue.code === 'materializedFinalDigestAmbiguous'),
    })
    expect(ambiguityView(forward)).toEqual(ambiguityView(reverse))
    expect(ambiguityView(forward)).toMatchObject({
      required: { status: 'unknown', path: null, digest: null },
      issues: [{ category: 'unknown', blocking: true }],
    })

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nDrift.\n')
    const drifted = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      materializations: ambiguousPaths,
    })
    expect(drifted.materializations).toHaveLength(3)
    expect(drifted.materializations.every((entry) =>
      entry.state === 'drifted' && entry.finalKeys.length === 0)).toBe(true)
    expect(drifted.requiredFinals.find((entry) => entry.profile === 'codex-project')?.status)
      .toBe('missing')
  })
})
