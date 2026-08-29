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
    const expectedRegistry = [
      'aw.plugin-manifest.v2',
      'aw.plugin-skills.v1',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v1',
      'aw.plugin-lifecycle.v1',
      'aw.dynamic-artifacts.v2',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
      'aw.skill-validation.v1',
      'aw.plugin-authoring.v1',
      'aw.catalog-context.v1',
      'aw.catalog-authoring.v1',
      'aw.catalog-source.v2',
      'aw.catalog-dev-source.v1',
      'aw.catalog-publication.v1',
      'aw.catalog-snapshot.v5',
      'aw.self-check.v1',
    ]
    expect(AW_CAPABILITY_IDS).toEqual(expectedRegistry)
    expect(getAwCapabilityRegistry()).toEqual(expectedRegistry)
    expect(new Set(getAwCapabilityRegistry()).size).toBe(getAwCapabilityRegistry().length)
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
        runtimeExports: [{ name: 'shared', source: './shared.mjs' }],
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
      'aw.plugin-authoring.v1',
      'aw.self-check.v1',
      'aw.skill-validation.v1',
    ])
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

  it('treats one-level literal commands as blocking unmapped commands on every scanner surface', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-one-level-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), '`aw status`\n')
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
