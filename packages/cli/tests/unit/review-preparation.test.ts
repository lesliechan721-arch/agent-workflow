import os from 'node:os'
import path from 'node:path'

import {
  initializeCatalogWorkspace,
  type PluginManifestSource,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { prepareReviewTarget } from '../../src/commands/review-preparation.js'
import { inspectReviewTarget } from '../../src/commands/review-inspection.js'
import { resolveReviewSelection } from '../../src/review/review-selection.js'
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js'
import { getProfileRenderScopes } from '../../src/platforms/layout.js'
import { writePluginConfigStore } from '../../src/utils/plugin-config.js'
import {
  createAwSourceBindingWorkspaceValidationContext,
  readAwSourceBinding,
  validateAwSourceBindingForWorkspace,
} from '../../src/review/source-binding.js'
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js'

const roots: string[] = []

async function createWorkspace(label = 'aw-review-preparation-'): Promise<{
  root: string
  env: NodeJS.ProcessEnv
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)))
  roots.push(root)
  await initializeCatalogWorkspace({ workspaceRoot: root })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'state', 'home'),
    USERPROFILE: path.join(root, 'state', 'home'),
    AW_HOME: path.join(root, 'state', 'aw-home'),
    CODEX_HOME: path.join(root, 'state', 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'state', 'claude-home'),
  }
  await fs.ensureDir(env.HOME!)
  return { root, env }
}

async function copyWorkspace(source: string, label: string): Promise<{
  root: string
  env: NodeJS.ProcessEnv
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)))
  roots.push(root)
  await fs.copy(source, root, { overwrite: false, errorOnExist: true, dereference: false })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'state', 'home'),
    USERPROFILE: path.join(root, 'state', 'home'),
    AW_HOME: path.join(root, 'state', 'aw-home'),
    CODEX_HOME: path.join(root, 'state', 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'state', 'claude-home'),
  }
  await fs.ensureDir(env.HOME!)
  return { root, env }
}

function manifest(name: string, extra: Partial<PluginManifestSource> = {}): PluginManifestSource {
  return {
    schemaVersion: 4,
    name,
    version: '0.1.0',
    description: `${name} Review preparation fixture.`,
    platforms: ['codex', 'claude', 'generic'],
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
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), value, { spaces: 2 })
  return pluginRoot
}

async function writeNativeSkill(pluginRoot: string, name: string): Promise<void> {
  const skillRoot = path.join(pluginRoot, 'skills', name)
  await fs.outputFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} Review fixture.\n---\n\n# ${name}\n`,
  )
  await fs.outputFile(path.join(skillRoot, 'README.md'), `# ${name}\n`)

}

function rendererSource(mutateSourcePath?: string): string {
  return `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
${mutateSourcePath ? `fs.appendFileSync(${JSON.stringify(mutateSourcePath)}, '\\n');` : ''}
const names = context.platform === 'codex' ? ['codex-extension','codex-native','unselected-skill']
  : context.platform === 'claude' ? ['claude-skill'] : ['portable-skill'];
const plan = {version:3,components:[],omitted:[],unmet:[]};
if (context.allowedOutputKinds.includes('skill')) for (const name of names) {
  if (name === 'codex-native' && context.config.values.nativeMode === 'disabled') {
    plan.omitted.push({id:name,kind:'skill',reason:'config-disabled'}); continue;
  }
  if (context.platformCapabilities.kinds.skill.status !== 'supported') {
    plan.unmet.push({id:name,kind:'skill',name,requiredFeatures:[{feature:'component.kind.skill'}],reasonCode:'capability-unverified'});continue;
  }
  plan.components.push({id:name,kind:'skill',name,content:{files:{
    'SKILL.md':{text:'---\\nname: '+name+'\\ndescription: Prepared fixture.\\n---\\n# '+name+'\\n'},
    'README.md':{text:'# '+name+'\\n'},
    'render.json':{text:JSON.stringify({scope:context.scope,config:context.config.values,basis:context.platformCapabilities.basis})}
  }}});
}
console.log(JSON.stringify(plan));
`;
}

async function createDynamicPlugin(root: string): Promise<string> {
  const pluginRoot = await writePlugin(root, manifest('dynamic-review', {
    platforms: ['codex', 'claude', 'generic'],
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    config: { schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'standard', required: true },
      nativeMode: { type: 'string', default: 'standard', required: true },
      needed: { type: 'string', default: 'available', required: true },
      token: { type: 'string', sensitive: true },
    } },
    artifacts: { configKeys: ['mode', 'nativeMode', 'needed'] },
  }))
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), rendererSource())
  return pluginRoot
}

async function createSharedConfigPlugin(root: string): Promise<string> {
  const pluginRoot = await writePlugin(root, manifest('shared-config-review', {
    platforms: ['codex', 'claude', 'generic'],
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    config: { schemaVersion: 5, fields: {
      shared: { type: 'string', default: 'shared-default', required: true },
      projectOnly: { type: 'string', default: 'project-default', required: true },
    } },
    artifacts: { configKeys: ['shared', 'projectOnly'] },
  }))
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
const plan = {version:3,components:[],omitted:[],unmet:[]};
const names = context.platform === 'codex' ? ['native','extension'] : ['portable'];
if (context.allowedOutputKinds.includes('skill')) for (const name of names) {
 if(context.platformCapabilities.kinds.skill.status !== 'supported') {
  plan.unmet.push({id:name,kind:'skill',name,requiredFeatures:[{feature:'component.kind.skill'}],reasonCode:'capability-unverified'});continue;
 }
 plan.components.push({id:name,kind:'skill',name,content:{files:{
  'SKILL.md':{text:'---\\nname: '+name+'\\ndescription: Shared config fixture.\\n---\\n# '+name+'\\n'},
  'README.md':{text:'# '+name+'\\n'},
  'config.json':{text:JSON.stringify({values:context.config.values,sources:context.config.sources,targetScope:context.scope})}
 }}});
}
console.log(JSON.stringify(plan));
`)
  return pluginRoot
}

async function createRebuildableDynamicPlugin(root: string): Promise<void> {
  const providerRoot = await writePlugin(root, manifest('review-provider', {
    platforms: ['codex', 'claude', 'generic'],
    buildConfig: {
      runtimeExports: [{
        name: 'registry',
        source: './registry.json',
        requires: { aw: { capabilities: [] } },
      }],
    },
  }))
  await fs.writeJson(path.join(providerRoot, 'registry.json'), {
    revision: 'working-tree-baseline',
  })
  const pluginRoot = await writePlugin(root, manifest('rebuild-consumer', {
    skills: './skills',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    platforms: ['codex', 'claude', 'generic'],
    dependencies: ['review-provider'],
    scripts: {
      node: { build: { runner: 'node', path: './scripts/build.mjs' } },
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    },
    buildConfig: {
      buildImports: [{
        plugin: 'review-provider',
        export: 'registry',
        env: 'AW_PLUGIN_IMPORT_REGISTRY',
      }],
    },
    artifacts: { configKeys: [], sourceDirs: ['./templates/rebuilt-skill'],
      runtimeImports: [{ name: 'registry', plugin: 'review-provider', export: 'registry' }] },
  }))
  await writeNativeSkill(pluginRoot, 'native-anchor')
  await Promise.all([
    fs.outputFile(
      path.join(pluginRoot, 'templates', 'rebuilt-skill', 'SKILL.md'),
      '---\nname: rebuilt-skill\ndescription: Long working tree source text for the rebuild fixture.\n---\n\n# Source text that the renderer replaces\n',
    ),
    fs.outputFile(
      path.join(pluginRoot, 'templates', 'rebuilt-skill', 'README.md'),
      '# Rebuilt Skill\n',
    ),
    fs.outputFile(path.join(pluginRoot, 'scripts', 'build.mjs'), [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('templates/rebuilt-skill/references', { recursive: true });",
      "await fs.copyFile(process.env.AW_PLUGIN_IMPORT_REGISTRY, 'templates/rebuilt-skill/references/build.json');",
    ].join('\n')),
    fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), `
console.log(JSON.stringify({version:3,components:[{id:'rebuilt-skill',kind:'skill',name:'rebuilt-skill',content:{files:{
 'SKILL.md':{text:'---\\nname: rebuilt-skill\\ndescription: Stable rendered rebuild fixture.\\n---\\n# Rendered\\n'},
 'README.md':{source:{kind:'bundle',path:'templates/rebuilt-skill/README.md'}},
 'references/build.json':{source:{kind:'bundle',path:'templates/rebuilt-skill/references/build.json'}},
 'references/runtime.json':{source:{kind:'runtime-import',name:'registry',path:'registry'}}
}}}],omitted:[],unmet:[]}));
`),
  ])
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Review preparation', () => {
  it('prepares only the selected consumer using isolated dependency overrides and rechecks its source binding', async () => {
    installNativeTestQualification({ platforms: ['codex'] })
    const fixture = await createWorkspace('aw-review-cross-config-')
    const pluginRoot = await createDynamicPlugin(fixture.root)
    const consumerPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json')
    const consumer = await fs.readJson(consumerPath) as PluginManifestSource
    consumer.dependencies = ['review-config-provider']
    consumer.requires = { aw: { capabilities: ['aw.plugin-config-cross-plugin-value-ref.v1'] } }
    consumer.config = { schemaVersion: 5, fields: { mode: {
      type: 'string', default: 'native', valueRef: {
        plugin: 'review-config-provider', field: 'sources', key: 'key', include: ['native'],
      },
    }, nativeMode: { type: 'string', default: 'native' }, needed: { type: 'string', default: 'available', required: true },
    token: { type: 'string', sensitive: true } } }
    await fs.writeJson(consumerPath, consumer)
    const providerRoot = await writePlugin(fixture.root, manifest('review-config-provider', {
      platforms: ['codex', 'claude', 'generic'],
      config: { schemaVersion: 5, fields: {
        sources: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
          type: 'object', properties: { key: { type: 'string', required: true }, location: { type: 'string', required: true } },
          additionalProperties: false,
        } },
        unrelated: { type: 'string', default: 'default' },
      } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { configKeys: ['sources'] },
    }))
    await fs.writeFile(path.join(providerRoot, 'render.mjs'), 'throw new Error("Unselected provider renderer ran");\n')
    const providerConfig = { sources: [{ key: 'remote', location: '/explicit' }], unrelated: 'ignored' }
    await writePluginConfigStore({ pluginName: 'review-config-provider', scope: 'user', cwd: fixture.root,
      env: fixture.env, values: providerConfig })
    const configFile = path.join(fixture.root, 'cross-config.json')
    await fs.writeJson(configFile, { 'dynamic-review': { mode: 'remote' } })
    const select = () => resolveReviewSelection({ cwd: fixture.root, target: pluginRoot,
      skills: ['codex-extension'], platform: 'codex', scope: 'project', configFile, env: fixture.env })
    await expect(select()).rejects.toThrow(/dependency config/u)
    await fs.writeJson(configFile, { 'dynamic-review': { mode: 'remote' }, 'review-config-provider': providerConfig })
    const selection = await select()
    expect(selection.profiles[0]!.profile.config).toEqual({
      'dynamic-review': { mode: 'remote' }, 'review-config-provider': { sources: providerConfig.sources },
    })
    expect(selection.profiles[0]!.pluginConfigs).toContainEqual(expect.objectContaining({
      pluginName: 'review-config-provider', scope: 'user', values: { sources: providerConfig.sources },
    }))
    expect(selection.profiles[0]!.sources).toContain(path.join(providerRoot, '.agents-plugin', 'plugin.json'))
    const output = path.join(fixture.root, '_review-output', 'cross-config')
    const result = await prepareReviewTarget({ cwd: fixture.root, target: pluginRoot,
      skills: ['codex-extension'], platform: 'codex', scope: 'project', configFile, out: output, env: fixture.env })
    expect(result.exitCode, JSON.stringify(result.receipt)).toBe(0)
    await expect(fs.readdir(path.join(output, 'skills'))).resolves.toEqual(['codex-extension'])
    await expect(fs.readJson(path.join(output, 'skills', 'codex-extension', 'render.json'))).resolves.toEqual({
      scope: 'user', basis: 'profile', config: { mode: 'remote', nativeMode: 'native', needed: 'available' },
    })
    const inspect = () => inspectReviewTarget({ cwd: fixture.root, target: pluginRoot,
      skills: ['codex-extension'], platform: 'codex', scope: 'project', configFile,
      materializations: [result.receipt.sourceBindingPath!], env: fixture.env })
    expect((await inspect()).skills).toEqual([expect.objectContaining({ state: 'ready' })])
    await fs.writeJson(configFile, { 'dynamic-review': { mode: 'remote' },
      'review-config-provider': { sources: [{ key: 'remote', location: '/changed' }] } })
    expect((await inspect()).skills).toEqual([expect.objectContaining({ state: 'missing' })])
    await fs.writeJson(configFile, { 'dynamic-review': { mode: 'remote' }, 'review-config-provider': providerConfig })
    const providerPath = path.join(providerRoot, '.agents-plugin', 'plugin.json')
    const provider = await fs.readJson(providerPath)
    provider.config.fields.sources.default = [{ key: 'default', location: '/default' }]
    await fs.writeJson(providerPath, provider)
    expect((await inspect()).skills).toEqual([expect.objectContaining({ state: 'stale' })])
  })

  it('rebuilds independent baseline and candidate source contexts with provider-bound final output', async () => {
    const source = await createWorkspace('aw-review-rebuild-source-')
    await createRebuildableDynamicPlugin(source.root)
    const baseline = await copyWorkspace(source.root, 'aw-review-rebuild-baseline-')
    const candidate = await copyWorkspace(source.root, 'aw-review-rebuild-candidate-')
    const prepare = async (
      fixture: { root: string; env: NodeJS.ProcessEnv },
      outputName: string,
    ) => prepareReviewTarget({
      cwd: fixture.root,
      target: path.join(fixture.root, 'plugins', 'rebuild-consumer'),
      skills: ['rebuilt-skill'],
      platform: 'generic',
      scope: 'project',
      out: path.join(fixture.root, '_review-output', outputName),
      env: fixture.env,
    })
    const validate = async (
      fixture: { root: string; env: NodeJS.ProcessEnv },
      bindingPath: string,
    ) => validateAwSourceBindingForWorkspace({
      bindingPath,
      context: await createAwSourceBindingWorkspaceValidationContext(fixture.root),
      expectedSubject: { plugin: 'rebuild-consumer' },
      cwd: fixture.root,
      env: fixture.env,
    })

    const [baselinePrepared, candidatePrepared] = await Promise.all([
      prepare(baseline, 'baseline'),
      prepare(candidate, 'candidate'),
    ])
    expect(baselinePrepared.exitCode, JSON.stringify(baselinePrepared.receipt)).toBe(0)
    expect(candidatePrepared.exitCode, JSON.stringify(candidatePrepared.receipt)).toBe(0)
    const baselineBindingPath = baselinePrepared.receipt.sourceBindingPath!
    const candidateBindingPath = candidatePrepared.receipt.sourceBindingPath!
    const baselineBinding = await readAwSourceBinding(baselineBindingPath)
    const candidateBinding = await readAwSourceBinding(candidateBindingPath)
    expect(baselineBinding.source).toEqual(candidateBinding.source)
    expect(baselineBinding.artifacts[0]!.digest).toBe(candidateBinding.artifacts[0]!.digest)
    const baselineOutput = path.dirname(baselineBindingPath)
    const candidateOutput = path.dirname(candidateBindingPath)
    for (const importedFile of ['build.json', 'runtime.json']) {
      await expect(fs.readJson(path.join(
        baselineOutput,
        'skills',
        'rebuilt-skill',
        'references',
        importedFile,
      ))).resolves.toEqual({ revision: 'working-tree-baseline' })
    }

    await fs.writeFile(
      path.join(candidate.root, 'plugins', 'rebuild-consumer', 'templates', 'rebuilt-skill', 'SKILL.md'),
      '---\nname: rebuilt-skill\ndescription: Short source.\n---\n',
    )
    const shortenedPrepared = await prepare(candidate, 'candidate-shortened')
    expect(shortenedPrepared.exitCode, JSON.stringify(shortenedPrepared.receipt)).toBe(0)
    const shortenedBindingPath = shortenedPrepared.receipt.sourceBindingPath!
    const shortenedBinding = await readAwSourceBinding(shortenedBindingPath)
    expect(shortenedBinding.artifacts[0]!.digest).toBe(candidateBinding.artifacts[0]!.digest)
    await expect(validate(candidate, shortenedBindingPath)).resolves.toMatchObject({ state: 'verified' })
    await expect(fs.readFile(path.join(
      path.dirname(shortenedBindingPath),
      'skills',
      'rebuilt-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toBe(await fs.readFile(path.join(
      candidateOutput,
      'skills',
      'rebuilt-skill',
      'SKILL.md',
    ), 'utf8'))

    await fs.writeJson(
      path.join(candidate.root, 'plugins', 'review-provider', 'registry.json'),
      { revision: 'candidate-provider-change' },
    )
    const changedPrepared = await prepare(candidate, 'candidate-provider-changed')
    expect(changedPrepared.exitCode, JSON.stringify(changedPrepared.receipt)).toBe(0)
    const changedBindingPath = changedPrepared.receipt.sourceBindingPath!
    const changedBinding = await readAwSourceBinding(changedBindingPath)
    expect(changedBinding.artifacts[0]!.digest).not.toBe(shortenedBinding.artifacts[0]!.digest)
    for (const importedFile of ['build.json', 'runtime.json']) {
      await expect(fs.readJson(path.join(
        path.dirname(changedBindingPath),
        'skills',
        'rebuilt-skill',
        'references',
        importedFile,
      ))).resolves.toEqual({ revision: 'candidate-provider-change' })
    }
    await expect(validate(candidate, changedBindingPath)).resolves.toMatchObject({ state: 'verified' })
    await expect(validate(candidate, shortenedBindingPath)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingSourceDrift' })]),
    })
    await expect(validate(baseline, baselineBindingPath)).resolves.toMatchObject({ state: 'verified' })
    await expect(fs.readJson(path.join(
      baseline.root,
      'plugins',
      'review-provider',
      'registry.json',
    ))).resolves.toEqual({ revision: 'working-tree-baseline' })
    await expect(fs.readJson(path.join(
      baselineOutput,
      'skills',
      'rebuilt-skill',
      'references',
      'runtime.json',
    ))).resolves.toEqual({ revision: 'working-tree-baseline' })
  })

  it('keeps selected disabled native Skills as a strict Review failure', async () => {
    const fixture = await createWorkspace()
    const pluginRoot = await createDynamicPlugin(fixture.root)
    const configFile = path.join(fixture.root, 'disabled-native-config.json')
    await fs.writeJson(configFile, { 'dynamic-review': { nativeMode: 'disabled' } })
    const output = path.join(fixture.root, '_review-output', 'disabled-native')
    const result = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      skills: ['codex-native'],
      platform: 'codex',
      scope: 'project',
      configFile,
      out: output,
      env: fixture.env,
    })
    expect(result.exitCode).toBe(1)
    expect(result.receipt).toMatchObject({
      ok: false,
      issues: [{ code: 'materializationFailed' }],
    })
    await expect(fs.pathExists(output)).resolves.toBe(false)
  })

  it('prepares multiple static Skills with generated and imported runtime files without Eval data', async () => {
    const fixture = await createWorkspace()
    const providerRoot = await writePlugin(fixture.root, manifest('runtime-provider', {
      buildConfig: {
        runtimeExports: [{
          name: 'registry',
          source: './registry.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }))
    await fs.writeJson(path.join(providerRoot, 'registry.json'), { provider: true })
    const pluginRoot = await writePlugin(fixture.root, manifest('static-review', {
      skills: './skills',
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'alpha',
          target: 'references/generated.json',
        }],
        skillRuntimeFiles: [{
          skill: 'alpha',
          target: 'references/registry.json',
          import: { plugin: 'runtime-provider', export: 'registry' },
        }],
      },
    }))
    await Promise.all([
      writeNativeSkill(pluginRoot, 'alpha'),
      writeNativeSkill(pluginRoot, 'beta'),
    ])
    await fs.writeFile(path.join(pluginRoot, 'build.mjs'), [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('skills/alpha/references', { recursive: true });",
      "await fs.writeFile('skills/alpha/references/generated.json', JSON.stringify({ home: process.env.HOME }));",
    ].join('\n'))
    const output = path.join(fixture.root, '_review-output', 'static')

    const result = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      skills: ['beta', 'alpha'],
      platform: 'generic',
      scope: 'project',
      out: path.relative(fixture.root, output),
      env: fixture.env,
    })

    expect(result.exitCode).toBe(0)
    expect(result.receipt).toMatchObject({
      ok: true,
      target: { kind: 'plugin', path: pluginRoot },
      sourceBindingPath: path.join(output, 'aw-source-binding.json'),
      skills: [
        { skill: 'alpha', state: 'ready', profile: { platform: 'generic', scope: 'project' } },
        { skill: 'beta', state: 'ready', profile: { platform: 'generic', scope: 'project' } },
      ],
      issues: [],
    })
    await expect(fs.readJson(path.join(output, 'skills', 'alpha', 'references', 'registry.json')))
      .resolves.toEqual({ provider: true })
    expect((await fs.readJson(path.join(
      output,
      'skills',
      'alpha',
      'references',
      'generated.json',
    ))).home).toContain('.aw-review-static-')
    await expect(fs.pathExists(path.join(pluginRoot, 'skills', 'alpha', 'references', 'generated.json')))
      .resolves.toBe(false)
    const binding = await readAwSourceBinding(result.receipt.sourceBindingPath!)
    expect(binding).toMatchObject({
      schemaVersion: 2,
      profile: { kind: 'review', id: 'generic-project', config: {} },
      artifacts: [
        { kind: 'review-skill', plugin: 'static-review', skill: 'alpha', path: 'skills/alpha' },
        { kind: 'review-skill', plugin: 'static-review', skill: 'beta', path: 'skills/beta' },
      ],
    })
  })

  it.each([
    ['codex', 'project', 'codex-extension', 'user', { mode: 'custom' }],
    ['codex', 'project', 'codex-native', 'user', { nativeMode: 'custom' }],
    ['claude', 'user', 'claude-skill', 'user', { mode: 'custom' }],
    ['generic', 'project', 'portable-skill', 'project', { mode: 'custom' }],
  ] as const)(
    'uses the selected %s/%s production projection for %s',
    async (platform, scope, skill, expectedConfigScope, expectedConfig) => {
      const fixture = await createWorkspace()
      const pluginRoot = await createDynamicPlugin(fixture.root)
      const configFile = path.join(fixture.root, 'review-config.json')
      await fs.writeJson(configFile, {
        'dynamic-review': { mode: 'custom', nativeMode: 'custom' },
      })
      const output = path.join(fixture.root, '_review-output', `${platform}-${skill}`)
      const selection = await resolveReviewSelection({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope,
        configFile,
      })
      expect(selection.profiles[0]!.pluginConfigs[0]).toMatchObject({
        overrides: expectedConfig,
        values: expectedConfig,
      })

      const result = await prepareReviewTarget({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope,
        configFile,
        out: output,
        env: fixture.env,
      })

      expect(result.exitCode, JSON.stringify(result.receipt)).toBe(0)
      if (getAuthoringPlatformCapabilities(platform, expectedConfigScope).kinds.skill.status !== 'supported') {
        expect(result.receipt.skills).toEqual([])
        expect(result.receipt.preparation?.flatMap((unit) => unit.unmet)).toContainEqual(expect.objectContaining({name:skill,reasonCode:'capability-unverified'}))
        return
      }
      expect(result.receipt).toMatchObject({
        ok: true,
        skills: [{ skill, state: 'ready', profile: { platform, scope } }],
      })
      const render = await fs.readJson(path.join(output, 'skills', skill, 'render.json'))
      expect(render).toEqual({
        scope: expectedConfigScope, basis: 'profile',
        config: { mode: 'custom', nativeMode: 'custom', needed: 'available' },
      })
      const binding = await readAwSourceBinding(result.receipt.sourceBindingPath!)
      expect(binding.profile).toMatchObject({
        kind: 'review',
        id: `${platform}-${scope}`,
        platform,
        scope,
        config: { 'dynamic-review': expectedConfig },
      })
      await expect(fs.pathExists(path.join(output, '.native-marketplace'))).resolves.toBe(false)
      await expect(fs.pathExists(path.join(output, '.aw-materialization.json'))).resolves.toBe(false)
    },
  )

  it.each([
    ['codex', 'extension'],
    ['generic', 'portable'],
  ] as const)(
    'keeps shared native and ordinary project config aligned for %s/%s',
    async (platform, skill) => {
      if (platform === 'codex') installNativeTestQualification({ platforms: ['codex'] })
      const fixture = await createWorkspace('aw-review-shared-config-')
      const pluginRoot = await createSharedConfigPlugin(fixture.root)
      const configFile = path.join(fixture.root, 'review-config.json')
      await fs.writeJson(configFile, {
        'shared-config-review': {
          shared: 'shared-custom',
          projectOnly: 'project-custom',
        },
      })
      const output = path.join(fixture.root, '_review-output', `${platform}-${skill}`)
      const selection = await resolveReviewSelection({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope: 'project',
        configFile,
      })
      expect(selection.profiles[0]!.pluginConfigs).toEqual(getProfileRenderScopes(platform, 'project').sort().map((scope) =>
        expect.objectContaining({scope,overrides:{shared:'shared-custom',projectOnly:'project-custom'},sources:{shared:'platform',projectOnly:'platform'}})))
      expect(selection.profiles[0]!.profile.config).toEqual({
        'shared-config-review': {
          projectOnly: 'project-custom',
          shared: 'shared-custom',
        },
      })

      const prepared = await prepareReviewTarget({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope: 'project',
        configFile,
        out: path.relative(fixture.root, output),
        env: fixture.env,
      })
      expect(prepared.exitCode, JSON.stringify(prepared.receipt)).toBe(0)
      await expect(fs.readJson(path.join(output, 'skills', skill, 'config.json'))).resolves.toEqual({
        values: { projectOnly: 'project-custom', shared: 'shared-custom' },
        sources: { projectOnly: 'platform', shared: 'platform' },
        targetScope: platform === 'codex' ? 'user' : 'project',
      })
      const binding = await readAwSourceBinding(prepared.receipt.sourceBindingPath!)
      expect(binding.profile).toMatchObject({
        kind: 'review',
        config: {
          'shared-config-review': {
            projectOnly: 'project-custom',
            shared: 'shared-custom',
          },
        },
      })
      const current = await inspectReviewTarget({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope: 'project',
        configFile,
        materializations: [prepared.receipt.sourceBindingPath!],
        env: fixture.env,
      })
      expect(current.skills).toEqual([
        expect.objectContaining({ skill, state: 'ready' }),
      ])
      const defaults = await inspectReviewTarget({
        cwd: fixture.root,
        target: pluginRoot,
        skills: [skill],
        platform,
        scope: 'project',
        materializations: [prepared.receipt.sourceBindingPath!],
        env: fixture.env,
      })
      expect(defaults.skills).toEqual([
        expect.objectContaining({ skill, state: 'missing' }),
      ])
      expect(defaults.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'materializationNotSelected' }),
      ]))
    },
  )

  it('rejects output overlap and symlink ancestors before running a build', async () => {
    const fixture = await createWorkspace()
    const pluginRoot = await writePlugin(fixture.root, manifest('safe-output', {
      skills: './skills',
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
    }))
    await writeNativeSkill(pluginRoot, 'safe-output')
    const overlap = path.join(pluginRoot, 'review-output')
    const overlapResult = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      platform: 'codex',
      scope: 'project',
      out: overlap,
      env: fixture.env,
    })
    expect(overlapResult).toMatchObject({
      exitCode: 2,
      receipt: { ok: false, sourceBindingPath: null, skills: [], issues: [{ code: 'unsafeOutput' }] },
    })
    await expect(fs.pathExists(overlap)).resolves.toBe(false)

    const realParent = path.join(fixture.root, 'real-output-parent')
    const linkedParent = path.join(fixture.root, 'linked-output-parent')
    await fs.ensureDir(realParent)
    await fs.symlink(realParent, linkedParent)
    const symlinkOutput = path.join(linkedParent, 'review')
    const symlinkResult = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      platform: 'codex',
      scope: 'project',
      out: symlinkOutput,
      env: fixture.env,
    })
    expect(symlinkResult).toMatchObject({
      exitCode: 2,
      receipt: { ok: false, issues: [{ code: 'unsafeOutput' }] },
    })
    await expect(fs.pathExists(path.join(realParent, 'review'))).resolves.toBe(false)
  })

  it.each(['AW_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', '.agents', '.codex', '.claude'])(
    'rejects output inside the physical installation root behind %s',
    async (installationRoot) => {
      const fixture = await createWorkspace()
      const buildMarker = path.join(fixture.root, 'build-ran')
      const pluginRoot = await writePlugin(fixture.root, manifest('linked-installation', {
        skills: './skills',
        scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
      }))
      await writeNativeSkill(pluginRoot, 'linked-installation')
      await fs.writeFile(path.join(pluginRoot, 'build.mjs'), [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(buildMarker)}, 'build ran');`,
      ].join('\n'))
      const physicalRoot = path.join(fixture.root, 'physical-installation')
      await fs.ensureDir(physicalRoot)
      const alias = path.join(fixture.root, installationRoot)
      await fs.symlink(physicalRoot, alias, 'junction')
      const suffix = installationRoot === 'AW_HOME' ? 'not-created-yet' : ''
      if (['AW_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(installationRoot)) {
        fixture.env[installationRoot] = path.join(alias, suffix)
      }
      const output = path.join(physicalRoot, suffix, 'review-copy')

      const result = await prepareReviewTarget({
        cwd: fixture.root,
        target: pluginRoot,
        platform: 'codex',
        scope: 'project',
        out: output,
        env: fixture.env,
      })

      expect(result).toMatchObject({
        exitCode: 2,
        receipt: { ok: false, sourceBindingPath: null, skills: [], issues: [{ code: 'unsafeOutput' }] },
      })
      await expect(fs.pathExists(buildMarker)).resolves.toBe(false)
      await expect(fs.readdir(physicalRoot)).resolves.toEqual([])
    },
  )

  it('reports source drift and commits no partial output or binding', async () => {
    const fixture = await createWorkspace()
    const pluginRoot = await createDynamicPlugin(fixture.root)
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json')
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'render.mjs'), rendererSource(manifestPath))
    const output = path.join(fixture.root, '_review-output', 'drifted')

    const result = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      skills: ['codex-extension'],
      platform: 'codex',
      scope: 'project',
      out: output,
      env: fixture.env,
    })

    expect(result).toMatchObject({
      exitCode: 3,
      receipt: {
        ok: false,
        sourceBindingPath: null,
        skills: [],
        issues: [{ code: 'sourceChanged', path: pluginRoot }],
      },
    })
    await expect(fs.pathExists(output)).resolves.toBe(false)
    const parentEntries = await fs.readdir(path.dirname(output))
    expect(parentEntries.some((entry) => entry.startsWith('.aw-review-drifted-'))).toBe(false)
  })

  it('cleans staged files when a renderer fails', async () => {
    const fixture = await createWorkspace()
    const pluginRoot = await createDynamicPlugin(fixture.root)
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'render.mjs'),
      'throw new Error("expected review renderer failure")\n',
    )
    const output = path.join(fixture.root, '_review-output', 'renderer-failure')

    const result = await prepareReviewTarget({
      cwd: fixture.root,
      target: pluginRoot,
      skills: ['codex-extension'],
      platform: 'codex',
      scope: 'project',
      out: output,
      env: fixture.env,
    })

    expect(result).toMatchObject({
      exitCode: 1,
      receipt: {
        ok: false,
        sourceBindingPath: null,
        skills: [],
        issues: [{ code: 'materializationFailed' }],
      },
    })
    await expect(fs.pathExists(output)).resolves.toBe(false)
    const parentEntries = await fs.readdir(path.dirname(output))
    expect(parentEntries.some((entry) => entry.startsWith('.aw-review-renderer-failure-'))).toBe(false)
  })
})
