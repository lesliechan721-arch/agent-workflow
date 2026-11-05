import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';

describe('buildConfig validation', () => {
  const baseManifest = {
    name: 'demo',
    version: '0.1.0',
    description: 'demo',
    schemaVersion: 3,
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
      schemaVersion: 3,
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
        schemaVersion: 3,
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
        schemaVersion: 3,
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
        runtimeExports: [{
          name: 'frontmatter-registry', source: './registry.json',
          requires: { aw: { capabilities: [
            'aw.review-inspection.v2',
            'aw.plugin-skills.v1',
          ] } },
        }],
        buildImports: [{
          plugin: 'provider',
          export: 'frontmatter-registry',
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
      runtimeExports: [{
        name: 'frontmatter-registry', source: './registry.json',
        requires: { aw: { capabilities: [
          'aw.plugin-skills.v1',
          'aw.review-inspection.v2',
        ] } },
      }],
      buildImports: [{
        plugin: 'provider',
        export: 'frontmatter-registry',
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

  it('requires runtime export metadata and accepts an explicit empty capability set', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        runtimeExports: [{ name: 'missing-requires', source: './registry.json' }],
      },
    })).toThrow("must have required property 'requires'");

    expect(validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        runtimeExports: [{
          name: 'empty-requires',
          source: './registry.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }).buildConfig?.runtimeExports?.[0]?.requires.aw.capabilities).toEqual([]);
  });

  it('normalizes declared build-generated Skill runtime targets', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'author',
          target: 'references/manifest.generated.md',
        }],
      },
    });

    expect(manifest.buildConfig?.generatedSkillRuntimeFiles).toEqual([{
      skill: 'author',
      target: 'references/manifest.generated.md',
    }]);
  });

  it('rejects removed CLI reserved imports', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: {
        buildImports: [{
          plugin: '@aw/cli',
          export: 'unknown-export',
          env: 'AW_PLUGIN_IMPORT_UNKNOWN',
        }],
      },
    })).toThrow('unknown reserved provider "@aw/cli"');
  });

  it('keeps omitted runtime selectors and accepts a concrete Portable platform projection', () => {
    const common = validatePluginManifest('/tmp/plugin', {
      ...baseManifest, buildConfig: { skillRuntimeFiles: [{
        skill: 'common-skill', target: 'references/common.txt', source: './common.txt',
      }] },
    });
    expect(common.buildConfig?.skillRuntimeFiles?.[0]?.platforms).toBeUndefined();
    const portable = validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['generic'], skills: './skills',
      buildConfig: { skillRuntimeFiles: [{ skill: 'portable-skill', target: 'references/portable.txt',
        platforms: ['generic'], source: './portable.txt' }] },
    });
    expect(portable.buildConfig?.skillRuntimeFiles?.[0]?.platforms).toEqual(['generic']);
  });

  it('requires a concrete Portable platform on a dynamic Skill target', () => {
    const target = { id: 'portable', distribution: 'agent-skills', target: 'agent-skills.skill',
      scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'portable' };
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['generic'], artifacts: { targets: [target] },
    })).toThrow('/artifacts/targets/0');
    expect(validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['generic'], artifacts: { targets: [{ ...target, platform: 'generic' }] },
    }).artifacts?.targets?.[0]?.platform).toBe('generic');
  });

  it('accepts a Portable-only declaration without Native inventory', () => {
    expect(validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['cursor'], skills: './skills',
    }).platforms).toEqual(['cursor']);
  });

  it('accepts canonical platform selectors in the current explicit manifest version', () => {
    expect(validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['pi'], skills: './skills',
      buildConfig: { generatedSkillRuntimeFiles: [{
        skill: 'portable', target: 'references/options.json', platforms: ['pi'],
      }] },
    }).buildConfig?.generatedSkillRuntimeFiles?.[0]?.platforms).toEqual(['pi']);
  });

  it('rejects removed Portable roots and unsafe unified Skill paths', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest, distributions: { agentSkills: { skills: './portable-skills' } },
    })).toThrow('Remove distributions.agentSkills');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest, platforms: ['generic'], skills: '../skills',
    })).toThrow('/skills must match pattern');
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
    })).toThrow('/buildConfig/cacheable must be equal to constant');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig: { cacheable: true },
    })).toThrow('true requires scripts.node.build');
  });

  it.each([
    {
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './a/../registry.json',
        requires: { aw: { capabilities: [] } },
      }] },
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
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: [] } }, extra: true,
      }] },
      error: '/buildConfig/runtimeExports/0 must NOT have additional properties',
    },
    {
      buildConfig: {
        generatedSkillRuntimeFiles: [{ skill: 'demo', target: 'SKILL.md' }],
      },
      error: 'below references/, assets/, or scripts/',
    },
    {
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/generated.md',
          platforms: ['agent-skills'],
        }],
      },
      error: '/buildConfig/generatedSkillRuntimeFiles/0/platforms/0',
    },
  ])('rejects an unsafe catalog runtime projection manifest', ({ buildConfig, error }) => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...baseManifest,
      buildConfig,
    })).toThrow(error);
  });
});
