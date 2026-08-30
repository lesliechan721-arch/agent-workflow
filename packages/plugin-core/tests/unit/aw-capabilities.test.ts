import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AW_CAPABILITY_IDS,
  checkAwCapabilitySupport,
  computeAwCapabilitySetDigest,
  deriveAwCapabilitiesFromManifest,
  getAwCapabilityRegistry,
  normalizeAwCapabilities,
  parseAwPluginRequirementsReceipt,
  readPluginManifest,
  resolvePluginRequirements,
  scanPluginAwCliRequirements,
} from '../../src/manifest.js'
import type { NormalizedPluginManifest } from '../../src/types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)))
})

function manifest(overrides: Record<string, unknown> = {}): NormalizedPluginManifest {
  return {
    schemaVersion: 2,
    name: 'example',
    version: '1.0.0',
    description: 'Example.',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...overrides,
  } as NormalizedPluginManifest
}

describe('AW capability contracts', () => {
  it('publishes a unique fixed registry and stable normalized digest', () => {
    const registry = getAwCapabilityRegistry()
    expect(registry).toEqual(AW_CAPABILITY_IDS)
    expect(registry.every((capability) => (
      normalizeAwCapabilities([capability])[0] === capability
    ))).toBe(true)
    expect(new Set(registry).size).toBe(registry.length)
    expect(registry).toEqual(expect.arrayContaining([
      'aw.plugin-manifest.v2',
      'aw.plugin-authoring.v1',
      'aw.catalog-snapshot.v5',
      'aw.self-check.v1',
    ]))
    expect(normalizeAwCapabilities([
      'aw.plugin-skills.v1', 'aw.plugin-config.v1', 'aw.plugin-skills.v1',
    ])).toEqual(['aw.plugin-config.v1', 'aw.plugin-skills.v1'])
    expect(computeAwCapabilitySetDigest([
      'aw.plugin-skills.v1', 'aw.plugin-config.v1',
    ])).toBe(computeAwCapabilitySetDigest([
      'aw.plugin-config.v1', 'aw.plugin-skills.v1', 'aw.plugin-config.v1',
    ]))
    expect(computeAwCapabilitySetDigest(['aw.self-check.v1']))
      .toBe('sha256:07e66a91aef4989637bd24703703305ea88250c2538f810f3820acdddc73b5e1')
  })

  it('treats an unknown valid capability as missing, not invalid data', () => {
    expect(checkAwCapabilitySupport(
      ['aw.future-feature.v3', 'aw.plugin-skills.v1'],
      ['aw.plugin-skills.v1'],
    )).toEqual({ supported: false, missing: ['aw.future-feature.v3'] })
  })

  it('validates receipt digest while accepting unknown valid capability IDs', () => {
    const requiredCapabilities = ['aw.future-feature.v3']
    expect(parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      digest: computeAwCapabilitySetDigest(requiredCapabilities),
    }).requiredCapabilities).toEqual(requiredCapabilities)
    expect(() => parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      digest: 'sha256:bad',
    })).toThrow('digest')
  })

  it('derives the v2 manifest capability and other structural requirements', () => {
    expect(deriveAwCapabilitiesFromManifest(manifest({
      skills: './skills',
      buildConfig: {
        runtimeExports: [{
          name: 'shared', source: './shared.mjs',
          requires: { aw: { capabilities: [] } },
        }],
      },
      config: { schema: {} },
      scripts: { lifecycle: { install: { default: { runner: 'node', path: './scripts/install.mjs' } } } },
      artifacts: { targets: [{ id: 'dynamic', scopes: ['user'], target: 'codex.skill', states: ['present'], refreshKeys: [] }] },
      distributions: { agentSkills: { skills: './portable' } },
    }))).toEqual([
      'aw.dynamic-artifacts.v2',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v1',
      'aw.plugin-lifecycle.v1',
      'aw.plugin-manifest.v2',
      'aw.plugin-skills.v1',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
    ])
  })

  it('scans only production Skill, script, and slash-command sources', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-core-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), '`aw plugin validate . --json`\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'scripts', 'check.mjs'), 'spawnSync("aw", ["self", "check"])\n')
    for (const extension of ['js', 'cjs', 'sh', 'ps1', 'cmd', 'bat']) {
      await fs.outputFile(
        path.join(pluginRoot, 'skills', 'one', 'scripts', `check.${extension}`),
        ['js', 'cjs'].includes(extension) ? 'spawnSync("aw", ["self", "check"])\n' : 'aw self check\n',
      )
    }
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'README.md'), '`aw catalog source add`\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'references', 'sample.mjs'), 'spawnSync("aw", ["catalog", "source", "add"])\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'evals', 'fixture.sh'), 'aw catalog source add\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'reports', 'fixture.ps1'), 'aw catalog source add\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'scripts', 'fixture'), 'aw catalog publish\n')
    await fs.outputFile(path.join(pluginRoot, 'portable', 'portable-one', 'scripts', 'run.bash'), 'aw catalog source list\n')
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'run.mjs'),
      'spawnSync("aw", ["skill", "validate", "./skill"])\nconst fixture = "PATH aw rejected fixture"\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'only.test.mjs'), 'spawnSync("aw", ["catalog", "dev", "status"])\n')
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'shared.test.mjs'),
      'import "./nested/imported.test.mjs"\nspawnSync("aw", ["catalog", "dev", "status"])\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'nested', 'only.test.mjs'), 'spawnSync("aw", ["catalog", "source", "list"])\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'nested', 'imported.test.mjs'), 'spawnSync("aw", ["catalog", "publish"])\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'publish.cmd'), 'aw catalog publish\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'publish.bat'), 'aw catalog publish\n')
    await fs.outputFile(path.join(pluginRoot, 'tools', 'publish'), 'aw catalog publish\n')
    await fs.outputFile(
      path.join(pluginRoot, 'tools', 'node-entry'),
      'import "./node-helper.mjs"\nspawnSync("aw", ["catalog", "publish"])\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'tools', 'node-helper.mjs'), 'spawnSync("aw", ["self", "check"])\n')
    await fs.outputFile(path.join(pluginRoot, 'tools', 'bash-entry.js'), 'aw catalog source list\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'ignored.txt'), 'aw catalog publish\n')
    await fs.outputFile(path.join(pluginRoot, 'commands', 'release.md'), 'aw catalog status --preflight\n')
    await fs.outputFile(path.join(pluginRoot, 'references', 'notes.md'), 'aw catalog publish\n')
    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        skills: './skills',
        slashCommands: './commands',
        distributions: { agentSkills: { skills: './portable' } },
        scripts: {
          lifecycle: {
            install: {
              default: { runner: 'bash', path: './tools/publish' },
              unix: { runner: 'bash', path: './tools/bash-entry.js' },
            },
            upgrade: { windows: { runner: 'auto', path: './scripts/publish.cmd' } },
            uninstall: { default: { runner: 'node', path: './tools/node-entry' } },
          },
          node: { build: { runner: 'node', path: './scripts/shared.test.mjs' } },
          tests: { node: ['./scripts/**/*.test.mjs'] },
        },
      }),
    })
    expect(result.detected).toEqual([
      'aw.catalog-authoring.v1',
      'aw.catalog-dev-source.v1',
      'aw.catalog-publication.v1',
      'aw.catalog-source.v2',
      'aw.self-check.v1',
      'aw.skill-validation.v1',
    ])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-detected',
        command: 'aw plugin validate',
        capability: 'aw.plugin-authoring.v1',
        blocking: false,
        provenance: 'inline-code',
      }),
    ]))
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/README.md')
    expect(result.observations.map((entry) => entry.path)).not.toContain('references/notes.md')
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/references/sample.mjs')
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/evals/fixture.sh')
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/reports/fixture.ps1')
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/scripts/fixture')
    expect(result.observations.map((entry) => entry.path)).not.toContain('scripts/only.test.mjs')
    expect(result.observations.map((entry) => entry.path)).not.toContain('scripts/nested/only.test.mjs')
    expect(result.observations.map((entry) => entry.path)).toContain('scripts/shared.test.mjs')
    expect(result.observations.map((entry) => entry.path)).toContain('scripts/nested/imported.test.mjs')
    expect(result.observations.map((entry) => entry.path)).toContain('scripts/publish.cmd')
    expect(result.observations.map((entry) => entry.path)).toContain('scripts/publish.bat')
    expect(result.observations.map((entry) => entry.path)).toContain('tools/publish')
    expect(result.observations.map((entry) => entry.path)).toContain('tools/node-entry')
    expect(result.observations.map((entry) => entry.path)).toContain('tools/node-helper.mjs')
    expect(result.observations.map((entry) => entry.path)).toContain('tools/bash-entry.js')
    for (const extension of ['js', 'mjs', 'cjs', 'sh', 'ps1', 'cmd', 'bat']) {
      expect(result.observations.map((entry) => entry.path)).toContain(`skills/one/scripts/check.${extension}`)
    }
    expect(result.observations.map((entry) => entry.path)).toContain('portable/portable-one/scripts/run.bash')
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw rejected fixture' }),
    ]))
  })

  it('derives requirements from structured Hook and MCP executables', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-executables-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'hook', 'entry.mjs'),
      'import "./helper.mjs"\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'hook', 'helper.mjs'),
      'spawnSync("aw", ["catalog", "publish"])\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'hook', 'run.sh'), [
      'aw catalog source list',
      '. ./shell-helper.sh',
      '',
    ].join('\n'))
    await fs.outputFile(path.join(pluginRoot, 'hook', 'shell-helper.sh'), 'aw review show record\n')
    await fs.outputFile(
      path.join(pluginRoot, 'mcp', 'entry.mjs'),
      'export { run } from "./helper.mjs"\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'mcp', 'helper.mjs'),
      'export const run = () => spawnSync("aw", ["skill", "validate"])\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'mcp', 'run.ps1'), [
      'aw catalog status',
      '. ./shell-helper.ps1',
      '',
    ].join('\n'))
    await fs.outputFile(path.join(pluginRoot, 'mcp', 'shell-helper.ps1'), 'aw review list\n')
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), {
      mcpServers: {
        direct: { command: 'aw', args: ['catalog', 'dev', 'status'] },
        node: { command: 'node', args: ['./mcp/entry.mjs'] },
        shell: { command: 'pwsh', args: ['./mcp/run.ps1'] },
        foreign: { command: 'python', args: ['./mcp/ignored.py'] },
      },
    })

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        mcpServers: './.mcp.json',
        extensions: {
          hooks: [
            { event: 'before_tool', command: 'aw plugin validate .' },
            { event: 'after_tool', command: 'node ./hook/entry.mjs' },
            { event: 'session_start', command: 'bash ./hook/run.sh' },
            { event: 'session_start', command: 'echo foreign' },
          ],
          nativeHooks: {
            claude: [{ event: 'Stop', command: 'aw self check' }],
            codex: [{ event: 'Stop', command: 'git status' }],
          },
        },
      }),
    })

    expect(result.detected).toEqual([
      'aw.catalog-authoring.v1',
      'aw.catalog-dev-source.v1',
      'aw.catalog-publication.v1',
      'aw.catalog-source.v2',
      'aw.plugin-authoring.v1',
      'aw.self-check.v1',
      'aw.skill-validation.v1',
    ])
    expect(result.detected).not.toContain('aw.review-publication.v1')
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-detected', path: '.agents-plugin/plugin.json',
        command: 'aw plugin validate',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: '.agents-plugin/plugin.json',
        command: 'aw self check',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: 'hook/helper.mjs',
        command: 'aw catalog publish',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: 'hook/run.sh',
        command: 'aw catalog source',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: '.mcp.json',
        command: 'aw catalog dev',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: 'mcp/helper.mjs',
        command: 'aw skill validate',
      }),
      expect.objectContaining({
        code: 'aw-command-detected', path: 'mcp/run.ps1',
        command: 'aw catalog status',
      }),
    ]))
    expect(result.observations.map((entry) => entry.path)).not.toContain('hook/shell-helper.sh')
    expect(result.observations.map((entry) => entry.path)).not.toContain('mcp/shell-helper.ps1')
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.stringContaining('python') }),
      expect.objectContaining({ command: expect.stringContaining('echo') }),
      expect.objectContaining({ command: expect.stringContaining('git') }),
    ]))
  })

  it('scans only Hook commands that are effective on a supported platform', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-hook-overrides-'))
    tempDirs.push(pluginRoot)
    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        extensions: {
          hooks: [{
            event: 'before_tool',
            command: 'aw catalog publish',
            agentOverrides: {
              claude: { command: 'aw self check' },
              codex: null,
            },
          }],
        },
      }),
    })

    expect(result.detected).toEqual(['aw.self-check.v1'])
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw catalog publish' }),
    ]))
  })

  it('keeps a base Hook command when one supported platform still uses it', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-hook-base-'))
    tempDirs.push(pluginRoot)
    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        extensions: {
          hooks: [{
            event: 'before_tool',
            command: 'aw catalog publish',
            agentOverrides: { claude: null },
          }],
        },
      }),
    })

    expect(result.detected).toEqual(['aw.catalog-publication.v1'])
    expect(result.observations.filter((entry) => (
      entry.command === 'aw catalog publish'
    ))).toHaveLength(1)
  })

  it('keeps templated MCP JSON non-blocking after source manifest validation', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-mcp-template-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      name: 'template-mcp',
      version: '1.0.0',
      description: 'Template MCP.',
      mcpServers: './.mcp.json',
      buildConfig: {
        templates: {
          vars: { COMMAND: { claude: 'aw', codex: 'aw' } },
          include: ['.mcp.json'],
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    }))
    await fs.outputFile(path.join(pluginRoot, '.mcp.json'), [
      '{ "mcpServers": {',
      '  "server": { "command": {{COMMAND}}, "args": ["self", "check"] }',
      '} }',
    ].join('\n'))

    const plugin = await readPluginManifest(pluginRoot, { mode: 'source' })
    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: plugin.manifest,
      implementedCapabilities: [],
    })

    expect(result.detected).toEqual([])
    expect(result.observations).toEqual([expect.objectContaining({
      code: 'aw-command-dynamic',
      blocking: false,
      path: '.mcp.json',
      message: expect.stringContaining('requires.aw.capabilities'),
    })])
  })

  it('blocks static unknown AW executables and keeps indeterminate structured commands advisory', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-executable-edge-'))
    tempDirs.push(pluginRoot)
    const outside = path.join(pluginRoot, '..', `${path.basename(pluginRoot)}-outside.mjs`)
    tempDirs.push(outside)
    await fs.outputFile(outside, 'spawnSync("aw", ["catalog", "publish"])\n')
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), {
      mcpServers: {
        unknown: { command: 'aw', args: ['future', 'command'] },
        dynamic: { command: 'aw', args: ['$GROUP', 'status'] },
        outside: { command: 'node', args: [`../${path.basename(outside)}`] },
        foreign: { command: 'python', args: ['$DYNAMIC'] },
      },
    })

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        mcpServers: './.mcp.json',
        extensions: {
          hooks: [
            { event: 'before_tool', command: 'aw future command' },
            { event: 'after_tool', command: 'aw $GROUP status' },
            { event: 'session_start', command: 'node "./hook.mjs"' },
            { event: 'session_start', command: 'bash ../outside.sh' },
            { event: 'session_start', command: 'echo $FOREIGN' },
          ],
        },
      }),
    })

    expect(result.detected).toEqual([])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-unmapped', blocking: true,
        path: '.agents-plugin/plugin.json', command: 'aw future command',
      }),
      expect.objectContaining({
        code: 'aw-command-unmapped', blocking: true,
        path: '.mcp.json', command: 'aw future command',
      }),
      expect.objectContaining({
        code: 'aw-command-dynamic', blocking: false,
        path: '.agents-plugin/plugin.json',
        message: expect.stringContaining('requires.aw.capabilities'),
      }),
      expect.objectContaining({
        code: 'aw-command-dynamic', blocking: false,
        path: '.mcp.json',
        message: expect.stringContaining('requires.aw.capabilities'),
      }),
    ]))
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.stringContaining('python') }),
      expect.objectContaining({ command: expect.stringContaining('echo') }),
    ]))
  })

  it('maps Markdown and shell skill eval commands without matching the npm executable', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-skill-eval-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), [
      'aw skill eval prepare --plugin example --json',
      'aw skill validate ./skill --json',
      'aw-skill-eval capabilities --json',
      '',
    ].join('\n'))
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'run.sh'), [
      'aw skill eval prepare --plugin example --json',
      'aw skill validate ./skill --json',
      'aw-skill-eval run plan.json --audit audit.json',
      '',
    ].join('\n'))

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({ skills: './skills' }),
    })

    expect(result.detected).toEqual([
      'aw.skill-eval.v1',
      'aw.skill-validation.v1',
    ])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-detected',
        command: 'aw skill eval',
        capability: 'aw.skill-eval.v1',
        provenance: 'direct-command-line',
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        command: 'aw skill eval',
        capability: 'aw.skill-eval.v1',
        path: 'scripts/run.sh',
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        command: 'aw skill validate',
        capability: 'aw.skill-validation.v1',
      }),
    ]))
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw skill eval' }),
      expect.objectContaining({ command: 'aw-skill-eval' }),
    ]))
  })

  it('detects static Node process argv and keeps dynamic argv non-blocking', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-process-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'run.mjs'), [
      'spawn("aw", ["plugin", "validate"])',
      'spawnSync("aw", ["catalog", "publish"])',
      'execFile("aw", ["unknown", "command"])',
      'execFileSync("aw", argv)',
      '// spawnSync("aw", ["unknown", "comment"])',
      'const quoted = \'execFile("aw", ["unknown", "quoted"])\'',
      'const regex = /spawnSync\\("aw", \\["unknown", "regex"\\]\\)/u',
      'const templateText = `spawnSync("aw", ["unknown", "template-text"])`',
      'const templateCode = `${spawnSync("aw", ["self", "check"])}`',
      'const fixture = "PATH aw rejected fixture"',
    ].join('\n'))
    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest() })
    expect(result.detected).toEqual([
      'aw.catalog-publication.v1',
      'aw.plugin-authoring.v1',
      'aw.self-check.v1',
    ])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw unknown command', blocking: true }),
      expect.objectContaining({ code: 'aw-command-dynamic', blocking: false }),
    ]))
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw rejected fixture' }),
      expect.objectContaining({ command: 'aw unknown comment' }),
      expect.objectContaining({ command: 'aw unknown quoted' }),
      expect.objectContaining({ command: 'aw unknown regex' }),
      expect.objectContaining({ command: 'aw unknown template-text' }),
    ]))
  })

  it('maps every review publication command to one capability', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-review-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'review.sh'),
      ['publish', 'digest', 'verify', 'list', 'show']
        .map((command) => `aw review ${command}\n`)
        .join(''),
    )

    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest() })
    expect(result.detected).toEqual(['aw.review-publication.v1'])
    expect(result.observations).toHaveLength(5)
    expect(result.observations).toEqual(expect.arrayContaining(
      ['publish', 'digest', 'verify', 'list', 'show'].map((command) => expect.objectContaining({
        code: 'aw-command-detected',
        command: `aw review ${command}`,
        capability: 'aw.review-publication.v1',
      })),
    ))
  })

  it('keeps a production promisified execFile AW argv observation non-blocking', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-process-async-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'run.mjs'),
      'execFileAsync("aw", argv)\n// execFileAsync("aw", ["unknown"])\n',
    )

    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest() })
    expect(result.observations).toEqual([expect.objectContaining({
      code: 'aw-command-dynamic',
      blocking: false,
      path: 'scripts/run.mjs',
    })])
  })

  it('treats one-level executable literals as blocking unmapped commands on every scanner surface', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-one-level-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), 'aw status\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'run.sh'), 'aw tui\n')
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'run.mjs'), 'spawnSync("aw", ["future"])\n')

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({ skills: './skills' }),
    })
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw status', blocking: true }),
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw tui', blocking: true }),
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw future', blocking: true }),
    ]))
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-dynamic' }),
    ]))
  })

  it('keeps fenced and direct Markdown commands as hard evidence but inline code as advisory', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-markdown-provenance-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), [
      '```bash',
      'aw catalog publish',
      'aw fenced future',
      '```',
      'aw plugin validate . --json',
      'aw direct future',
      'Use `aw catalog source list` for a source and `aw inline future` for a future command.',
      '',
    ].join('\n'))

    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: manifest({ skills: './skills' }),
      implementedCapabilities: [
        'aw.plugin-skills.v1',
        'aw.catalog-publication.v1',
        'aw.plugin-authoring.v1',
      ],
    })

    expect(result.detected).toEqual([
      'aw.catalog-publication.v1',
      'aw.plugin-authoring.v1',
    ])
    expect(result.effective).not.toContain('aw.catalog-source.v2')
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'aw catalog publish',
        capability: 'aw.catalog-publication.v1',
        blocking: false,
        provenance: 'shell-fence',
      }),
      expect.objectContaining({
        command: 'aw fenced future',
        blocking: true,
        provenance: 'shell-fence',
      }),
      expect.objectContaining({
        command: 'aw plugin validate',
        capability: 'aw.plugin-authoring.v1',
        blocking: false,
        provenance: 'direct-command-line',
      }),
      expect.objectContaining({
        command: 'aw direct future',
        blocking: true,
        provenance: 'direct-command-line',
      }),
      expect.objectContaining({
        command: 'aw catalog source',
        capability: 'aw.catalog-source.v2',
        blocking: false,
        provenance: 'inline-code',
      }),
      expect.objectContaining({
        command: 'aw inline future',
        blocking: false,
        provenance: 'inline-code',
      }),
    ]))
  })

  it('reports unmapped literals as blocking and dynamic construction as non-blocking', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-observation-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'run.sh'),
      'aw unknown command\naw "$GROUP" "$COMMAND"\nconst command = "aw " + group + " " + action\n',
    )
    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: manifest(),
      implementedCapabilities: [],
    })
    expect(result.declared).toEqual([])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', blocking: true }),
      expect.objectContaining({ code: 'aw-command-dynamic', blocking: false }),
    ]))
  })
})
