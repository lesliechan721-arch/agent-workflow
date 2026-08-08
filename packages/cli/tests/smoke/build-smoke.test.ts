import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';
import {
  createSmokeStagingRunner,
  type SmokeStagingRunner,
} from '../support/smoke-staging-runner.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let cliBuildPromise: Promise<void> | null = null;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function buildCli(root: string): Promise<void> {
  await execFileAsync('pnpm', ['build'], {
    cwd: root,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function ensureBuiltCli(root: string): Promise<void> {
  cliBuildPromise ??= buildCli(root);
  await cliBuildPromise;
  await installCurrentSmokeDistIsolationBridge();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('build smoke', () => {
  const root = repoRoot();
  const builtPluginsDistRoot = path.join(root, 'packages', 'cli', 'plugins-dist');

  it('runs pnpm build and produces plugins-dist through the compiled bundle script', async () => {
    const outputRoot = builtPluginsDistRoot;
    const staleDistPath = path.join(
      root,
      'packages',
      'cli',
      'dist',
      'stale-build-sentinel.js',
    );
    await fs.outputFile(staleDistPath, 'export const stale = true;\n', 'utf8');

    await ensureBuiltCli(root);

    await expect(fs.pathExists(staleDistPath)).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'ask-me', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'git-commit',
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'ask-me', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      marketplace: {
        category: 'workflow',
        policy: {
          authentication: 'NONE',
        },
      },
      extensions: {
        instructions: [
          expect.objectContaining({
            name: 'quality-gate',
            content: expect.stringContaining('使用 `requirements-clarifier`'),
          }),
        ],
      },
    });
    for (const pluginName of [
      'ask-me',
      'git-commit',
      'codex-explore',
      'codex-subagent-guide',
    ]) {
      await expect(
        fs.pathExists(path.join(outputRoot, 'plugins', pluginName, 'evals')),
      ).resolves.toBe(false);
      await expect(
        fs.pathExists(path.join(outputRoot, '.catalog', 'full', 'plugins', pluginName, 'evals')),
      ).resolves.toBe(false);
    }
    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
      fs.readJson(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);
    const [canonicalCatalogManifestText, sidecarCatalogManifestText, fullCatalogManifestText] = await Promise.all([
      fs.readFile(path.join(outputRoot, '.catalog', 'catalog-manifest.json'), 'utf8'),
      fs.readFile(path.join(outputRoot, '.catalog', 'sidecar', 'catalog-manifest.json'), 'utf8'),
      fs.readFile(path.join(outputRoot, '.catalog', 'full', 'catalog-manifest.json'), 'utf8'),
    ]);
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'ask-me',
      'git-commit',
    ]);
    expect(codexMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'ask-me',
      'codex-explore',
      'codex-subagent-guide',
      'git-commit',
    ]);
    expect(codexMarketplace).toMatchObject({
      owner: claudeMarketplace.owner,
      interface: claudeMarketplace.interface,
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: 'ask-me',
          source: './plugins/ask-me',
          policy: expect.objectContaining({
            authentication: 'NONE',
          }),
        }),
        expect.objectContaining({
          name: 'codex-explore',
          source: './plugins/codex-explore',
          policy: expect.objectContaining({
            products: ['CODEX'],
          }),
        }),
        expect.objectContaining({
          name: 'codex-subagent-guide',
          source: './plugins/codex-subagent-guide',
          policy: expect.objectContaining({
            products: ['CODEX'],
          }),
        }),
      ]),
    });
    expect(claudeMarketplace.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'ask-me',
        source: './plugins/ask-me',
        policy: expect.objectContaining({
          authentication: 'NONE',
        }),
      }),
    ]));
    const askMeSkills = await Promise.all(
      ['requirements-clarifier', 'decision-grill'].flatMap((skillName) =>
        ['codex', 'claude'].map(async (platform) => ({
          skillName,
          platform,
          skill: await fs.readFile(
            path.join(
              outputRoot,
              'plugins',
              'ask-me',
              platform,
              'skills',
              skillName,
              'SKILL.md',
            ),
            'utf8',
          ),
          openaiYaml: await fs.readFile(
            path.join(
              outputRoot,
              'plugins',
              'ask-me',
              platform,
              'skills',
              skillName,
              'agents',
              'openai.yaml',
            ),
            'utf8',
          ),
        })),
      ),
    );
    for (const { skillName, platform, skill, openaiYaml } of askMeSkills) {
      expect(skill).toContain('互相独立时每轮最多三题');
      expect(skill).not.toMatch(/^disable-model-invocation:\s*true$/m);
      if (platform === 'codex') {
        expect(skill).toContain('使用 `request_user_input`');
        expect(skill).not.toContain('AskUserQuestion');
      } else {
        expect(skill).toContain('使用 `AskUserQuestion`');
        expect(skill).not.toContain('request_user_input');
      }
      expect(openaiYaml).toContain(`default_prompt: "使用 $${skillName}：`);
      expect(openaiYaml).toContain('allow_implicit_invocation: true');
    }
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'ask-me', 'codex', 'skills', 'ask-me')),
    ).resolves.toBe(false);
    await Promise.all([
      path.join(
        outputRoot,
        'plugins',
        'codex-subagent-guide',
        '.codex-plugin',
        'plugin.json',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-subagent-guide',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-subagent-guide-skill',
        '0',
        'SKILL.md',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-subagent-guide',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-subagent-guide-skill',
        '0',
        'agents',
        'openai.yaml',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-subagent-guide',
        'scripts',
        'render-artifacts.mjs',
      ),
    ].map(async (requiredPath) => {
      await expect(fs.pathExists(requiredPath)).resolves.toBe(true);
    }));
    await expect(
      fs.pathExists(
        path.join(
          outputRoot,
          'plugins',
          'codex-subagent-guide',
          '.claude-plugin',
          'plugin.json',
        ),
      ),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(
        path.join(
          outputRoot,
          'plugins',
          'codex-subagent-guide',
          '.agents-plugin',
          'plugin.json',
        ),
      ),
    ).resolves.toMatchObject({
      interface: {
        capabilities: ['Skills', 'Agents'],
      },
      config: {
        schema: {
          simpleTaskModel: {
            type: 'string',
            default: 'gpt-5.6-luna',
          },
          simpleTaskReasoningEffort: {
            type: 'enum',
            default: 'max',
          },
          generalTaskModel: {
            type: 'string',
            default: 'gpt-5.6-sol',
          },
          generalTaskReasoningEffort: {
            type: 'enum',
            default: 'medium',
          },
          complexTaskModel: {
            type: 'string',
            default: 'gpt-5.6-sol',
          },
          complexTaskReasoningEffort: {
            type: 'enum',
            default: 'high',
          },
          planningReviewTaskModel: {
            type: 'string',
            default: 'gpt-5.6-sol',
          },
          planningReviewTaskReasoningEffort: {
            type: 'enum',
            default: 'xhigh',
          },
        },
      },
      scripts: {
        artifacts: {
          render: {
            runner: 'node',
            path: './scripts/render-artifacts.mjs',
          },
        },
      },
      artifacts: {
        targets: [
          expect.objectContaining({
            id: 'codex-subagent-guide-skill',
            target: 'codex.skill',
            skillKey: 'codex-subagent-guide',
            refreshKeys: ['minimumInitialWaitMinutes'],
          }),
          ...[
            [
              'codex-subagent-simple-role',
              'codex-subagent-simple',
              ['simpleTaskModel', 'simpleTaskReasoningEffort'],
            ],
            [
              'codex-subagent-general-role',
              'codex-subagent-general',
              ['generalTaskModel', 'generalTaskReasoningEffort'],
            ],
            [
              'codex-subagent-complex-role',
              'codex-subagent-complex',
              ['complexTaskModel', 'complexTaskReasoningEffort'],
            ],
            [
              'codex-subagent-plan-review-role',
              'codex-subagent-plan-review',
              ['planningReviewTaskModel', 'planningReviewTaskReasoningEffort'],
            ],
          ].map(([id, roleKey, refreshKeys]) => expect.objectContaining({
            id,
            target: 'codex.agentRole',
            roleKey,
            refreshKeys,
          })),
        ],
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'codex-explore', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'codex-explore',
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      config: {
        schema: {
          quickModel: { type: 'string', default: 'gpt-5.6-luna' },
          quickReasoningEffort: { type: 'enum', default: 'medium' },
          standardModel: { type: 'string', default: 'gpt-5.6-luna' },
          standardReasoningEffort: { type: 'enum', default: 'high' },
          deepModel: { type: 'string', default: 'gpt-5.6-luna' },
          deepReasoningEffort: { type: 'enum', default: 'xhigh' },
        },
      },
      scripts: {
        artifacts: {
          render: {
            runner: 'node',
            path: './scripts/render-artifacts.mjs',
          },
        },
      },
      artifacts: {
        targets: expect.arrayContaining([
          expect.objectContaining({
            id: 'codex-explore-skill',
            platform: 'codex',
            target: 'codex.skill',
            skillKey: 'codex-explore',
          }),
          ...[
            [
              'codex-explore-quick-role',
              'codex-explore-quick',
              ['quickModel', 'quickReasoningEffort'],
            ],
            [
              'codex-explore-standard-role',
              'codex-explore-standard',
              ['standardModel', 'standardReasoningEffort'],
            ],
            [
              'codex-explore-deep-role',
              'codex-explore-deep',
              ['deepModel', 'deepReasoningEffort'],
            ],
            ['codex-explore-custom-role', 'codex-explore-custom', []],
          ].map(([id, roleKey, refreshKeys]) => expect.objectContaining({
            id,
            platform: 'codex',
            target: 'codex.agentRole',
            requiresCodexProjectConfig: true,
            roleKey,
            refreshKeys,
          })),
        ]),
      },
    });
    await Promise.all([
      path.join(outputRoot, 'plugins', 'codex-explore', 'scripts', 'render-artifacts.mjs'),
      path.join(outputRoot, 'plugins', 'codex-explore', '.agents-plugin', 'artifact-sources', 'codex', 'codex-explore-skill', '0', 'SKILL.md'),
      path.join(outputRoot, 'plugins', 'codex-explore', '.agents-plugin', 'artifact-sources', 'codex', 'codex-explore-skill', '0', 'agents', 'openai.yaml'),
    ].map(async (requiredPath) => {
      await expect(fs.pathExists(requiredPath)).resolves.toBe(true);
    }));
    await Promise.all([
      path.join(outputRoot, 'plugins', 'codex-explore', 'codex', 'roles', 'codex-explorer.md'),
      path.join(outputRoot, 'plugins', 'codex-explore', 'codex', 'instructions', 'lightweight.md'),
    ].map(async (removedPath) => {
      await expect(fs.pathExists(removedPath)).resolves.toBe(false);
    }));
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'codex-explore', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'codex-explore', 'claude')),
    ).resolves.toBe(false);
    expect(canonicalCatalogManifestText).toBe(sidecarCatalogManifestText);
    expect(canonicalCatalogManifestText).toBe(fullCatalogManifestText);
    await expect(
      fs.readJson(path.join(outputRoot, '.catalog', 'catalog-manifest.json')),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      packages: {
        sidecar: {
          name: '@yiliang/aw-plugins-manifest',
        },
        full: {
          name: '@yiliang/aw-plugins',
          manifestPath: './catalog-manifest.json',
        },
      },
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: 'ask-me',
          source: './plugins/ask-me',
          artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
        expect.objectContaining({
          name: 'git-commit',
          source: './plugins/git-commit',
          artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
      ]),
    });
    await expect(
      fs.readJson(path.join(outputRoot, '.catalog', 'sidecar', 'package.json')),
    ).resolves.toMatchObject({
      name: '@yiliang/aw-plugins-manifest',
      files: ['catalog-manifest.json'],
      awCatalog: {
        kind: 'sidecar',
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, '.catalog', 'full', 'package.json')),
    ).resolves.toMatchObject({
      name: '@yiliang/aw-plugins',
      files: expect.arrayContaining(['catalog-manifest.json', '.agents/', '.claude-plugin/', 'plugins/']),
      awCatalog: {
        kind: 'full',
      },
    });
    await expect(
      fs.pathExists(path.join(outputRoot, '.catalog', 'full', 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toBe(true);
  });

  it('starts the real dist entry and reads the bundled plugins-dist', async () => {
    const packageJson = await fs.readJson(path.join(root, 'packages', 'cli', 'package.json')) as {
      version: string;
    };
    await ensureBuiltCli(root);

    await expect(
      execFileAsync('node', ['packages/cli/dist/index.js', '--help'], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Usage: aw'),
    });

    await expect(
      execFileAsync('node', ['packages/cli/dist/index.js', '--version'], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: `${packageJson.version}\n`,
    });

    const tempRoot = await createSmokeTempRoot('aw-dist-entry-', 'build smoke dist entry temp root');
    const awHome = path.join(tempRoot, 'aw-home');
    registerSmokeWritableRoot(awHome, 'build smoke dist entry AW_HOME');
    await expect(
      execFileAsync('node', ['packages/cli/dist/index.js', 'init', '--force'], {
        cwd: root,
        env: {
          ...process.env,
          AW_HOME: awHome,
        },
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('无法解析 current catalog sidecar metadata'),
    });
  });

  it('bundles declared MCP, app and native hook assets through the compiled bundle script', async () => {
    await ensureBuiltCli(root);

    const tempRoot = await createSmokeTempRoot('aw-smoke-assets-', 'build smoke assets temp root');
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'build smoke assets repo root');
    registerSmokeWritableRoot(outputRoot, 'build smoke assets output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const manifestPath = path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo smoke claude notification',
        },
      ],
      codex: [
        {
          event: 'Stop',
          command: 'echo smoke codex stop',
        },
      ],
    };
    manifest.slashCommands = './slash-commands';
    manifest.buildConfig = {
      ...(manifest.buildConfig ?? {}),
      manifestOverrides: {
        ...(manifest.buildConfig?.manifestOverrides ?? {}),
        claude: {
          ...(manifest.buildConfig?.manifestOverrides?.claude ?? {}),
          outputStyles: './output-styles',
          lspServers: './config/lsp.json',
          userConfig: {
            awSmokeMode: {
              type: 'string',
              default: 'standard',
            },
          },
          channels: {
            stable: {
              description: 'Smoke stable channel',
            },
          },
        },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.outputFile(
      path.join(tempRepo, 'plugins', 'git-commit', 'slash-commands', 'review.md'),
      [
        '---',
        'description: Smoke review command',
        '---',
        '',
        'Run smoke review.',
      ].join('\n'),
      'utf8',
    );
    await fs.outputFile(
      path.join(tempRepo, 'plugins', 'git-commit', 'output-styles', 'smoke.md'),
      '# Smoke Style\n',
      'utf8',
    );
    await fs.outputJson(
      path.join(tempRepo, 'plugins', 'git-commit', 'config', 'lsp.json'),
      {
        smokeLsp: {
          command: 'node',
          args: ['server.mjs'],
        },
      },
      { spaces: 2 },
    );

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', '.mcp.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'codex', '.app.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'Notification',
              matcher: '*',
              command: 'echo smoke claude notification',
            },
          ],
          codex: [
            {
              event: 'Stop',
              command: 'echo smoke codex stop',
            },
          ],
        },
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'hooks', 'hooks.json')),
    ).resolves.toMatchObject({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo smoke claude notification' }],
          },
        ],
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'echo smoke codex stop' }],
            },
          ],
        },
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: './claude/hooks/hooks.json',
      commands: './claude/commands',
      agents: expect.arrayContaining(['./claude/agents/aw-git-commit-commit-reviewer.md']),
      outputStyles: './claude/output-styles',
      lspServers: './claude/config/lsp.json',
      userConfig: {
        awSmokeMode: {
          type: 'string',
          default: 'standard',
        },
      },
      channels: {
        stable: {
          description: 'Smoke stable channel',
        },
      },
    });
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'output-styles', 'smoke.md')),
    ).resolves.toBe(true);

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles public slashCommands through the compiled bundler without shipping raw source directories', async () => {
    await ensureBuiltCli(root);

    const tempRoot = await createSmokeTempRoot(
      'aw-smoke-slash-commands-',
      'build smoke slash commands temp root',
    );
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'build smoke slash commands repo root');
    registerSmokeWritableRoot(outputRoot, 'build smoke slash commands output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', 'slashCommands-only'),
      path.join(tempRepo, 'plugins', 'slash-commands-only'),
    );

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    const pluginRoot = path.join(outputRoot, 'plugins', 'slash-commands-only');
    await expect(
      fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      slashCommands: './slash-commands',
    });
    await expect(
      fs.pathExists(path.join(pluginRoot, 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'assets', 'review-16.svg')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'slash-commands', 'review.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.not.toContain('$ARGUMENTS');

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles scripts.node plugins through the compiled staging bundle path', async () => {
    await ensureBuiltCli(root);

    const tempRoot = await createSmokeTempRoot(
      'aw-smoke-scripts-node-',
      'build smoke scripts.node temp root',
    );
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'build smoke scripts.node repo root');
    registerSmokeWritableRoot(outputRoot, 'build smoke scripts.node output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await writeNodeScriptFixture(tempRepo);

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as {
      bundlePlugins: (options: {
        repoRoot: string;
        outputRoot: string;
        buildMode: 'staging';
        stagingRunner?: SmokeStagingRunner;
      }) => Promise<unknown>;
    };
    await bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      buildMode: 'staging',
      stagingRunner: createSmokeStagingRunner(),
    });

    const pluginRoot = path.join(outputRoot, 'plugins', 'git-commit');
    const bundleManifest = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
    expect(bundleManifest).toMatchObject({
      description: 'Built smoke description',
      marketplace: {
        policy: {
          products: ['CODEX'],
        },
      },
      scripts: {
        lifecycle: {
          install: {
            default: {
              runner: 'node',
              path: './scripts/runtime.mjs',
            },
          },
        },
        node: {
          packageRoot: './scripts',
        },
      },
    });
    expect(bundleManifest.scripts.tests).toBeUndefined();
    expect(bundleManifest.scripts.node.build).toBeUndefined();

    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'yaml', 'package.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'fs-extra')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', '.pnpm', 'fs-extra@11.3.4')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', '.pnpm', 'universalify@2.0.1')),
    ).resolves.toBe(false);

    const runtime = (await import(
      pathToFileURL(path.join(pluginRoot, 'scripts', 'runtime.mjs')).href
    )) as { parseSmokeConfig: (source: string) => string };
    expect(runtime.parseSmokeConfig('name: bundle\n')).toBe('bundle:runtime-helper');

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });
    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
      fs.readJson(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);
    expect(claudeMarketplace.plugins).toEqual([]);
    expect(codexMarketplace.plugins).toEqual([
      expect.objectContaining({
        name: 'git-commit',
        description: 'Built smoke description',
        source: './plugins/git-commit',
        policy: expect.objectContaining({
          products: ['CODEX'],
        }),
      }),
    ]);

  }, 120_000);
});
