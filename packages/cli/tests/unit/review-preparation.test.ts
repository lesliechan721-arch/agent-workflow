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
import { readAwSourceBinding } from '../../src/review/source-binding.js'

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
    AW_CODEX_HOME: path.join(root, 'state', 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'state', 'claude-home'),
  }
  await fs.ensureDir(env.HOME!)
  return { root, env }
}

function manifest(name: string, extra: Partial<PluginManifestSource> = {}): PluginManifestSource {
  return {
    schemaVersion: 3,
    name,
    version: '0.1.0',
    description: `${name} Review preparation fixture.`,
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
  await fs.outputFile(
    path.join(skillRoot, 'agents', 'openai.yaml'),
    'interface:\n  display_name: Review fixture\n  short_description: Review fixture\n'
      + 'policy:\n  allow_implicit_invocation: true\n',
  )
}

function rendererSource(mutateSourcePath?: string): string {
  return [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    ...(mutateSourcePath
      ? [`fs.appendFileSync(${JSON.stringify(mutateSourcePath)}, '\\n');`]
      : []),
    'const definitions = {',
    "  'codex-extension': { platform: 'codex', target: 'codex.skill', skillKey: 'codex-extension' },",
    "  'codex-native': { platform: 'codex', target: 'codex.skill', skillKey: 'codex-native' },",
    "  'claude-skill': { platform: 'claude', target: 'claude.skill', skillKey: 'claude-skill' },",
    "  'portable-skill': { distribution: 'agent-skills', target: 'agent-skills.skill', skillKey: 'portable-skill' },",
    "  'unselected-skill': { platform: 'codex', target: 'codex.skill', skillKey: 'unselected-skill' },",
    '};',
    'const artifacts = context.requestedArtifactIds.map((id) => {',
    '  const definition = definitions[id];',
    '  if (!definition) process.exit(19);',
    "  const codex = definition.target === 'codex.skill';",
    "  const skill = definition.skillKey;",
    '  const files = {',
    "    'SKILL.md': `---\\nname: ${skill}\\ndescription: ${skill} prepared fixture.\\n---\\n\\n# ${skill}\\n`,",
    "    'README.md': `# ${skill}\\n`,",
    "    'render.json': JSON.stringify({ requested: context.requestedArtifactIds, scope: context.scope, configScope: context.config.targetScope, config: context.config.values }),",
    '  };',
    "  if (codex) files['agents/openai.yaml'] = 'policy:\\n  allow_implicit_invocation: true\\n';",
    '  return {',
    '    id, ...definition, kind: "skill", state: "present", refreshKeys: [id === "unselected-skill" ? "needed" : id === "codex-native" ? "nativeMode" : "mode"],',
    '    content: { files },',
    '  };',
    '});',
    'process.stdout.write(JSON.stringify({ version: 2, artifacts }));',
  ].join('\n')
}

async function createDynamicPlugin(root: string): Promise<string> {
  const pluginRoot = await writePlugin(root, manifest('dynamic-review', {
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX', 'CLAUDE'],
      },
    },
    distributions: { agentSkills: {} },
    scripts: {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    },
    config: {
      fields: {
        mode: { type: 'string', default: 'standard', required: true },
        nativeMode: { type: 'string', default: 'standard', required: true },
        needed: { type: 'string', required: true },
        token: { type: 'string', sensitive: true },
      },
    },
    artifacts: {
      targets: [
        {
          id: 'codex-extension',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'codex-extension',
        },
        {
          id: 'codex-native',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          states: ['present'],
          refreshKeys: ['nativeMode'],
          skillKey: 'codex-native',
        },
        {
          id: 'claude-skill',
          platform: 'claude',
          scopes: ['project', 'user'],
          target: 'claude.skill',
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'claude-skill',
        },
        {
          id: 'portable-skill',
          distribution: 'agent-skills',
          scopes: ['project', 'user'],
          target: 'agent-skills.skill',
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'portable-skill',
        },
        {
          id: 'unselected-skill',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          states: ['present'],
          refreshKeys: ['needed'],
          skillKey: 'unselected-skill',
        },
        {
          id: 'sensitive-role',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.agentRole',
          states: ['present'],
          refreshKeys: ['token'],
          roleKey: 'sensitive-role',
          requiresCodexProjectConfig: true,
        },
      ],
    },
  }))
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), rendererSource())
  return pluginRoot
}

async function createSharedConfigPlugin(root: string): Promise<string> {
  const pluginRoot = await writePlugin(root, manifest('shared-config-review', {
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
    distributions: { agentSkills: {} },
    scripts: {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    },
    config: {
      fields: {
        shared: { type: 'string', default: 'shared-default', required: true },
        projectOnly: { type: 'string', default: 'project-default', required: true },
      },
    },
    artifacts: {
      targets: [
        {
          id: 'native',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          states: ['present'],
          refreshKeys: ['shared'],
          skillKey: 'native',
        },
        {
          id: 'extension',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          states: ['present'],
          refreshKeys: ['shared', 'projectOnly'],
          skillKey: 'extension',
        },
        {
          id: 'portable',
          distribution: 'agent-skills',
          scopes: ['project', 'user'],
          target: 'agent-skills.skill',
          states: ['present'],
          refreshKeys: ['shared', 'projectOnly'],
          skillKey: 'portable',
        },
      ],
    },
  }))
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    'const definitions = {',
    "  native: { platform: 'codex', target: 'codex.skill', skillKey: 'native', refreshKeys: ['shared'] },",
    "  extension: { platform: 'codex', target: 'codex.skill', skillKey: 'extension', refreshKeys: ['shared', 'projectOnly'] },",
    "  portable: { distribution: 'agent-skills', target: 'agent-skills.skill', skillKey: 'portable', refreshKeys: ['shared', 'projectOnly'] },",
    '};',
    'const artifacts = context.requestedArtifactIds.map((id) => {',
    '  const definition = definitions[id];',
    '  const files = {',
    "    'SKILL.md': `---\nname: ${id}\ndescription: ${id} shared config fixture.\n---\n\n# ${id}\n`,",
    "    'README.md': `# ${id}\n`,",
    "    'config.json': JSON.stringify({ values: context.config.values, sources: context.config.sources, targetScope: context.config.targetScope }),",
    '  };',
    '  if (definition.target === \'codex.skill\') files[\'agents/openai.yaml\'] = "policy:\\n  allow_implicit_invocation: true\\n";',
    '  return { id, ...definition, kind: "skill", state: "present", content: { files } };',
    '});',
    'process.stdout.write(JSON.stringify({ version: 2, artifacts }));',
  ].join('\n'))
  return pluginRoot
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Review preparation', () => {
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
          products: ['CODEX'],
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
      platform: 'codex',
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
        { skill: 'alpha', state: 'ready', profile: { platform: 'codex', scope: 'project' } },
        { skill: 'beta', state: 'ready', profile: { platform: 'codex', scope: 'project' } },
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
      profile: { kind: 'review', id: 'codex-project', config: {} },
      artifacts: [
        { kind: 'review-skill', plugin: 'static-review', skill: 'alpha', path: 'skills/alpha' },
        { kind: 'review-skill', plugin: 'static-review', skill: 'beta', path: 'skills/beta' },
      ],
    })
  })

  it.each([
    ['codex', 'project', 'codex-extension', 'project', { mode: 'custom' }],
    ['codex', 'project', 'codex-native', 'user', { nativeMode: 'custom' }],
    ['claude', 'user', 'claude-skill', 'user', { mode: 'custom' }],
    ['agent-skills', 'project', 'portable-skill', 'project', { mode: 'custom' }],
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
      expect(result.receipt).toMatchObject({
        ok: true,
        skills: [{ skill, state: 'ready', profile: { platform, scope } }],
      })
      const render = await fs.readJson(path.join(output, 'skills', skill, 'render.json'))
      expect(render).toEqual({
        requested: [skill],
        scope: platform === 'codex' && skill === 'codex-native' ? 'user' : scope,
        configScope: expectedConfigScope,
        config: expectedConfig,
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
    ['agent-skills', 'portable'],
  ] as const)(
    'keeps shared native and ordinary project config aligned for %s/%s',
    async (platform, skill) => {
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
      expect(selection.profiles[0]!.pluginConfigs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: 'user',
          overrides: { shared: 'shared-custom' },
          sources: { shared: 'user' },
        }),
        expect.objectContaining({
          scope: 'project',
          overrides: { projectOnly: 'project-custom' },
          sources: { projectOnly: 'project' },
        }),
      ]))
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
        sources: { projectOnly: 'project', shared: 'user' },
        targetScope: 'project',
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
          products: ['CODEX'],
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

  it.each(['AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME', '.agents', '.codex', '.claude'])(
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
      if (installationRoot.startsWith('AW_')) {
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
