import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';

describe('buildConfig validation', () => {
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

    expect(manifest.slashCommands).toBe('./slash-commands');
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
});
