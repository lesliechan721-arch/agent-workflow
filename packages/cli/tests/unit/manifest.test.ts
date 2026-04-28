import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readMarketplaceSourceMeta,
  readPluginManifest,
} from '../../src/utils/manifest.js';
import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_EVENT_CONTRACTS,
} from '../../src/utils/hooks-contract.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest utils', () => {
  it('reads marketplace source metadata and plugin source manifest', async () => {
    const repoRoot = await makeTempRepo();
    const [marketplace, plugin] = await Promise.all([
      readMarketplaceSourceMeta(repoRoot),
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ]);

    expect(marketplace).toEqual({
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
    });

    expect(plugin.manifest.marketplace).toMatchObject({
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    });
    expect(plugin.manifest.marketplace.policy.products).toBeUndefined();
    expect(plugin.manifest.extensions?.hooks?.[0]).toMatchObject({
      event: 'before_tool',
      matcher: 'Bash',
    });
  });

  it('rejects deprecated top-level claude block', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.claude = {
      hooks: './hooks/hooks.json',
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('unknown field "claude"');
  });

  it('rejects hook fields and permission patterns outside the public source contract', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks[0].event = 'command';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unsupported hook event "command"',
    );

    manifest.extensions.hooks[0].event = 'before_tool';
    manifest.extensions.hooks[0].description = 'old field';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "description"',
    );

    delete manifest.extensions.hooks[0].description;
    manifest.extensions.permissions[0].allow = ['git *'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'only plain token prefixes are supported',
    );

    manifest.extensions.permissions[0].allow = ['git;rm -rf'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'shell control characters',
    );
  });

  it('rejects unknown root marketplace metadata fields', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePath = path.join(repoRoot, 'plugins', 'marketplace-source.json');
    const source = await fs.readJson(sourcePath);
    source.metadata = {
      internal: true,
    };
    await fs.writeJson(sourcePath, source, { spaces: 2 });

    await expect(readMarketplaceSourceMeta(repoRoot)).rejects.toThrow(
      'unknown field "metadata"',
    );
  });

  it('rejects undeclared default skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    delete manifest.skills;
    delete manifest.skillTriggers;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('found skills but missing "skills" declaration');
  });

  it('rejects declared native asset paths that do not exist', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = './missing-skills';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'skills points to "./missing-skills" but path does not exist',
    );
  });

  it('accepts valid skillTriggers declared against source skills', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      },
    });
  });

  it('rejects skillTriggers without skills or with unknown fields', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    delete manifest.skills;
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '"skillTriggers" requires a declared "skills" directory',
    );

    manifest.skills = './skills';
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
        mode: 'manual',
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "mode"',
    );

    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: 'yes',
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'allowInstallOverride: expected a boolean',
    );
  });

  it('rejects skillTriggers entries that do not match a source skill directory', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      missing: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid skillTriggers.missing: expected a skill directory at "skills/missing".',
    );
  });

  it('rejects undeclared default MCP manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.mcpServers;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { servers: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .mcp.json but missing "mcpServers" declaration',
    );
  });

  it('rejects undeclared default app manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.apps;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .app.json but missing "apps" declaration',
    );
  });

  it('allows templated JSON native assets at source time but validates non-template JSON shape', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.mcpServers = './.mcp.json';
    manifest.apps = './.app.json';
    manifest.buildConfig = {
      templates: {
        include: ['.mcp.json', '.app.json'],
        vars: {
          serverName: { claude: 'claude-server', codex: 'codex-server' },
        },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeFile(path.join(pluginRoot, '.mcp.json'), '{"mcpServers": {{serverName}}}', 'utf8');
    await fs.writeFile(path.join(pluginRoot, '.app.json'), '{"apps": {{serverName}}}', 'utf8');

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        mcpServers: './.mcp.json',
        apps: './.app.json',
      },
    });

    delete manifest.buildConfig;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { mcpServers: [] }, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: {} }, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'expected top-level "mcpServers" object',
    );
  });

  it('loads bundle manifests without applying source-only default asset checks', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const bundlePluginRoot = path.join(repoRoot, 'bundle', 'plugins', 'git-commit');
    await fs.ensureDir(path.join(bundlePluginRoot, '.agents-plugin'));
    const manifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    );
    delete manifest.skills;
    delete manifest.skillTriggers;
    await fs.writeJson(
      path.join(bundlePluginRoot, '.agents-plugin', 'plugin.json'),
      manifest,
      { spaces: 2 },
    );
    await fs.ensureDir(path.join(bundlePluginRoot, 'skills'));

    await expect(readPluginManifest(bundlePluginRoot)).rejects.toThrow(
      'found skills but missing "skills" declaration',
    );
    await expect(
      readPluginManifest(bundlePluginRoot, { mode: 'bundle' }),
    ).resolves.toMatchObject({
      manifest: {
        name: 'git-commit',
      },
    });
  });

  it('preserves skillTriggers in bundle mode without requiring a source skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const bundlePluginRoot = path.join(repoRoot, 'bundle', 'plugins', 'git-commit');
    await fs.ensureDir(path.join(bundlePluginRoot, '.agents-plugin'));
    const manifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    );
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(
      path.join(bundlePluginRoot, '.agents-plugin', 'plugin.json'),
      manifest,
      { spaces: 2 },
    );

    await expect(
      readPluginManifest(bundlePluginRoot, { mode: 'bundle' }),
    ).resolves.toMatchObject({
      manifest: {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      },
    });
  });

  it('accepts native hooks and public session_start shared matcher values', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks = [
      {
        event: 'session_start',
        matcher: 'startup|resume|clear',
        command: 'echo shared session start',
      },
    ];
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
        {
          event: 'Stop',
          command: 'echo claude stop',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          hooks: [
            {
              event: 'session_start',
              matcher: 'startup|resume|clear',
              command: 'echo shared session start',
            },
          ],
          nativeHooks: {
            claude: [
              {
                event: 'Notification',
                matcher: '*',
                command: 'echo claude notification',
              },
              {
                event: 'Stop',
                command: 'echo claude stop',
              },
            ],
            codex: [
              {
                event: 'UserPromptSubmit',
                command: 'echo codex prompt',
              },
            ],
          },
        },
      },
    });
  });

  it('rejects removed public session_stop and invalid public session_start matchers', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks = [
      {
        event: 'session_stop',
        command: 'echo stop',
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public event "session_stop" has been removed',
    );

    manifest.extensions.hooks = [
      {
        event: 'before_tool',
        matcher: 'Bash',
        command: 'echo shared',
        agentOverrides: {
          codex: {
            event: 'session_stop',
            command: 'echo codex stop',
          },
        },
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public event "session_stop" has been removed',
    );

    manifest.extensions.hooks = [
      {
        event: 'session_start',
        matcher: 'compact',
        command: 'echo invalid compact',
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public session_start only allows startup, resume, clear',
    );

    manifest.extensions.hooks[0].matcher = '*';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public session_start only allows startup, resume, clear',
    );
  });

  it('rejects invalid native hook platform keys, matcherless matcher, extra fields, and platform duplicates', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.nativeHooks = {
      openai: [],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'extensions.nativeHooks: unknown field "openai"',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'UserPromptSubmit',
          matcher: '*',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'does not allow matcher',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'Stop',
          matcher: '*',
          command: 'echo codex stop',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'does not allow matcher',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: '[',
          command: 'echo invalid regex',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'valid Codex matcher pattern',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: 'Write(?=File)',
          command: 'echo unsupported lookahead',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'valid Codex matcher pattern',
    );

    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo notify',
          description: 'old field',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "description"',
    );

    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo notify',
          agentOverrides: {
            codex: null,
          },
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "agentOverrides"',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'Notification',
          command: 'echo wrong platform event',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unsupported codex hook event "Notification"',
    );

    manifest.extensions.hooks = [
      {
        event: 'before_tool',
        matcher: 'Bash',
        command: 'echo duplicate',
      },
    ];
    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: 'echo duplicate',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'duplicate codex hook',
    );
  });

  it('accepts Rust-regex-only valid Codex native hook matchers in source manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: '(?i:write)',
          command: 'echo inline flags',
        },
        {
          event: 'PostToolUse',
          matcher: '(?P<tool>Write|Bash)',
          command: 'echo named capture',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'PreToolUse',
                matcher: '(?i:write)',
                command: 'echo inline flags',
              },
              {
                event: 'PostToolUse',
                matcher: '(?P<tool>Write|Bash)',
                command: 'echo named capture',
              },
            ],
          },
        },
      },
    });
  });

  it('accepts every Claude native hook event and enforces the full matcher capability table', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const originalManifest = await fs.readJson(manifestPath);

    for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
      const manifest = structuredClone(originalManifest);
      manifest.extensions.nativeHooks = {
        claude: [
          {
            event,
            ...(NATIVE_HOOK_EVENT_CONTRACTS.claude[event].matcherAllowed
              ? { matcher: '*' }
              : {}),
            command: `echo ${event}`,
          },
        ],
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
        manifest: {
          extensions: {
            nativeHooks: {
              claude: [
                {
                  event,
                  command: `echo ${event}`,
                },
              ],
            },
          },
        },
      });
    }

    for (const [event, contract] of Object.entries(NATIVE_HOOK_EVENT_CONTRACTS.claude)) {
      const manifest = structuredClone(originalManifest);
      manifest.extensions.nativeHooks = {
        claude: [
          {
            event,
            matcher: '*',
            command: `echo ${event}`,
          },
        ],
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      if (contract.matcherAllowed) {
        await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
          manifest: {
            extensions: {
              nativeHooks: {
                claude: [
                  {
                    event,
                    matcher: '*',
                    command: `echo ${event}`,
                  },
                ],
              },
            },
          },
        });
      } else {
        await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
          'does not allow matcher',
        );
      }
    }
  });

  it('accepts the portable public session_start matcher variants', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    for (const matcher of ['startup', 'resume', 'clear', 'startup|resume|clear']) {
      manifest.extensions.hooks = [
        {
          event: 'session_start',
          matcher,
          command: 'echo start',
        },
      ];
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
        manifest: {
          extensions: {
            hooks: [
              {
                event: 'session_start',
                matcher,
                command: 'echo start',
              },
            ],
          },
        },
      });
    }
  });
});
