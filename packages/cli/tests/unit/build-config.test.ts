import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';

describe('buildConfig validation', () => {
  const baseManifest = {
    name: 'demo',
    version: '0.1.0',
    description: 'demo',
    compatibility: { aw: { minVersion: '0.1.0' } },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
  } as const;

  it('accepts templates, file rules and Claude manifest overrides', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      name: 'demo',
      version: '0.1.0',
      description: 'demo',
      slashCommands: './slash-commands',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      buildConfig: {
        templates: {
          vars: {
            agent_name: {
              claude: 'Claude Code',
              codex: 'Codex',
            },
          },
          include: ['skills/**/*.md'],
        },
        fileRules: {
          claude: {
            include: ['skills/**', 'output-styles/**'],
            exclude: [],
          },
          codex: {
            include: ['skills/**'],
            exclude: ['output-styles/**'],
          },
        },
        manifestOverrides: {
          claude: {
            outputStyles: './output-styles',
            lspServers: ['./config/lsp.json', { name: 'inline' }],
          },
          codex: {},
        },
      },
    });

    expect(manifest.buildConfig?.manifestOverrides?.claude?.outputStyles).toBe('./output-styles');
    expect(manifest.buildConfig?.fileRules?.codex?.exclude).toEqual(['output-styles/**']);
  });

  it('rejects deprecated Claude commands authoring entries', () => {
    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'demo',
        version: '0.1.0',
        description: 'demo',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
        buildConfig: {
          manifestOverrides: {
            claude: {
              commands: './commands',
            },
          },
        },
      }),
    ).toThrow('use "slashCommands" instead');
  });

  it('rejects legacy Claude commands file rules', () => {
    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'demo',
        version: '0.1.0',
        description: 'demo',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
        buildConfig: {
          fileRules: {
            claude: {
              include: ['commands/**'],
              exclude: [],
            },
          },
        },
      }),
    ).toThrow('legacy "commands/**"');
  });

  it('normalizes the catalog runtime projection contract', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        runtimeExports: [{ name: 'frontmatter-registry', source: './registry.json' }],
        buildImports: [{
          plugin: '@aw/cli',
          export: 'skill-frontmatter-capabilities',
          env: 'AW_PLUGIN_IMPORT_FRONTMATTER',
        }],
        skillRuntimeFiles: [{
          skill: 'write-agent-content',
          target: 'references/frontmatter.md',
          platforms: ['codex'],
          import: { plugin: 'provider', export: 'frontmatter-registry' },
        }],
      },
    });

    expect(manifest.buildConfig).toMatchObject({
      runtimeExports: [{ name: 'frontmatter-registry', source: './registry.json' }],
      buildImports: [{
        plugin: '@aw/cli',
        export: 'skill-frontmatter-capabilities',
        env: 'AW_PLUGIN_IMPORT_FRONTMATTER',
      }],
      skillRuntimeFiles: [{
        skill: 'write-agent-content',
        target: 'references/frontmatter.md',
        platforms: ['codex'],
        import: { plugin: 'provider', export: 'frontmatter-registry' },
      }],
    });
  });

  it('keeps native runtime file defaults and accepts explicit portable distribution projection', () => {
    const native = validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'native-skill',
          target: 'references/native.txt',
          source: './native.txt',
        }],
      },
    });
    expect(native.buildConfig?.skillRuntimeFiles?.[0]?.distributions).toBeUndefined();

    const portable = validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'portable-skill',
          target: 'references/portable.txt',
          distributions: ['agent-skills'],
          source: './portable.txt',
        }],
      },
    });
    expect(portable.buildConfig?.skillRuntimeFiles?.[0]).toMatchObject({
      distributions: ['agent-skills'],
    });
  });

  it('requires an agent-skills distribution declaration for portable dynamic targets', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      artifacts: {
        targets: [{
          id: 'portable',
          distribution: 'agent-skills',
          target: 'agent-skills.skill',
          scopes: ['user'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'portable',
        }],
      },
    })).toThrow('require distributions.agentSkills');
  });

  it('rejects empty extensions as a portable-only plugin and accepts a real native capability', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      extensions: {},
      distributions: { agentSkills: { skills: './portable-skills' } },
    })).toThrow('portable-only plugins');

    expect(validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
    }).distributions?.agentSkills?.skills).toBe('./portable-skills');
  });

  it('requires the public portable distribution AW compatibility floor', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      compatibility: { aw: { minVersion: '0.0.0' } },
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
    })).toThrow('distributions.agentSkills requires AW 0.1.0 or newer');
  });

  it('rejects unsafe portable distribution paths', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: '../portable-skills' } },
    })).toThrow('must start with "./"');
  });

  it('accepts only an explicit deterministic build cache declaration with a Node build', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: { cacheable: true },
      scripts: {
        node: { build: { runner: 'node', path: './build.mjs' } },
      },
    });
    expect(manifest.buildConfig?.cacheable).toBe(true);

    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: { cacheable: false },
    })).toThrow('buildConfig.cacheable: expected true');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: { cacheable: true },
    })).toThrow('true requires scripts.node.build');
  });

  it.each([
    {
      buildConfig: { runtimeExports: [{ name: 'registry', source: './a/../registry.json' }] },
      error: 'canonical POSIX path',
    },
    {
      buildConfig: { buildImports: [{ plugin: 'provider', export: 'registry', env: 'PATH' }] },
      error: 'AW_PLUGIN_IMPORT_',
    },
    {
      buildConfig: {
        skillRuntimeFiles: [{ skill: 'demo', target: 'SKILL.md', source: './source.md' }],
      },
      error: 'below references/, assets/, or scripts/',
    },
    {
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/file.md',
          source: './source.md',
          import: { plugin: 'provider', export: 'registry' },
        }],
      },
      error: 'exactly one of source or import',
    },
    {
      buildConfig: { runtimeExports: [{ name: 'registry', source: './registry.json', extra: true }] },
      error: 'unknown field "extra"',
    },
  ])('rejects an unsafe catalog runtime projection manifest', ({ buildConfig, error }) => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig,
    })).toThrow(error);
  });
});
