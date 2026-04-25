import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';

describe('buildConfig validation', () => {
  it('accepts templates, file rules and Claude manifest overrides', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
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
            include: ['skills/**', 'commands/**'],
            exclude: [],
          },
          codex: {
            include: ['skills/**'],
            exclude: ['commands/**'],
          },
        },
        manifestOverrides: {
          claude: {
            commands: './commands',
            outputStyles: './output-styles',
            lspServers: ['./config/lsp.json', { name: 'inline' }],
          },
          codex: {},
        },
      },
    });

    expect(manifest.buildConfig?.manifestOverrides?.claude?.commands).toBe('./commands');
    expect(manifest.buildConfig?.fileRules?.codex?.exclude).toEqual(['commands/**']);
  });

  it('rejects non-whitelisted Claude manifest overrides', () => {
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
              hooks: './hooks/hooks.json',
            },
          },
        },
      }),
    ).toThrow('unknown field "hooks"');
  });
});
