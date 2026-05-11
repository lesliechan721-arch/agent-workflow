import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexMarketplaceAddInvocation,
  CodexAdapter,
  pruneCodexTrackedArtifacts,
} from '../../src/adapters/codex.js';
import { buildGeneratedName } from '../../src/generators/shared.js';
import { getGeneratedArtifactIdentityKey } from '../../src/utils/generated-artifacts.js';
import {
  createAvailableLedger,
  initializeLocalMarketplace,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexPluginEnabledFile,
  removeCodexMcpServer,
  upsertCodexMcpServer,
  upsertCodexMarketplaceFile,
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
import {
  readCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';
import * as codexNativeRecoveryModule from '../../src/utils/codex-native-recovery.js';
import * as codexConfigModule from '../../src/utils/codex-config.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  NativeCliError,
  type NativeCliInvocation,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import {
  removeTrackingRecordFromManifest,
  readTrackingManifest,
  upsertTrackingRecord,
  writeTrackingManifest,
} from '../../src/utils/tracking.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  cwd: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-adapter-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');

  const cwd = path.join(repoRoot, 'packages', 'app');
  await fs.ensureDir(cwd);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
    cwd,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    },
  };
}

async function copyRepoManagedFixturePlugin(
  repoRoot: string,
  pluginDir:
    | 'dynamic-artifacts'
    | 'mcp-only'
    | 'instructions-mcp'
    | 'skills-only'
    | 'slashCommands-only',
): Promise<void> {
  await fs.copy(
    fixturePath('codex-project-repo-managed', 'plugins', pluginDir),
    path.join(repoRoot, 'plugins', pluginDir),
  );
}

async function removePluginFromEmbeddedCatalog(
  embeddedRoot: string,
  pluginName: string,
): Promise<void> {
  await fs.remove(path.join(embeddedRoot, 'plugins', pluginName));
  for (const manifestPath of [
    path.join(embeddedRoot, '.claude-plugin', 'marketplace.json'),
    path.join(embeddedRoot, '.agents', 'plugins', 'marketplace.json'),
  ]) {
    const manifest = await fs.readJson(manifestPath);
    manifest.plugins = (manifest.plugins ?? []).filter(
      (entry: { name?: string }) => entry.name !== pluginName,
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  }
}

function resolveCodexNativeCacheVersionPath(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): string {
  return path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version);
}

async function writeDynamicArtifactRendererScript(
  repoRoot: string,
  source: string,
): Promise<void> {
  await fs.writeFile(
    path.join(repoRoot, 'plugins', 'dynamic-artifacts', 'scripts', 'render-artifacts.mjs'),
    source,
    'utf8',
  );
}

function renderDynamicArtifactsFixture(options?: {
  instructionState?: 'present' | 'disabled';
  instructionContent?: string;
  instructionDisabledReason?: string;
  roleState?: 'present' | 'disabled';
  roleDisabledReason?: string;
}): string {
  const instructionState = options?.instructionState ?? 'present';
  const roleState = options?.roleState ?? 'present';
  const instructionBody = instructionState === 'present'
    ? [
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        `      content: ${JSON.stringify(options?.instructionContent ?? 'Inspect the repository carefully.')}`,
        '    },',
      ]
    : [
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "disabled",',
        `      disabledReason: ${JSON.stringify(options?.instructionDisabledReason ?? 'config')},`,
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"]',
        '    },',
      ];
  const roleBody = roleState === 'present'
    ? [
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: "Inspect the repository.",',
        '          model: "gpt-5.4-mini",',
        '          model_reasoning_effort: "medium"',
        '        }',
        '      }',
        '    }',
      ]
    : [
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "disabled",',
        '      roleKey: "codex-explorer",',
        `      disabledReason: ${JSON.stringify(options?.roleDisabledReason ?? 'config')},`,
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"]',
        '    }',
      ];

  return [
    'console.log(JSON.stringify({',
    '  version: 1,',
    '  artifacts: [',
    ...instructionBody,
    ...roleBody,
    '  ]',
    '}));',
  ].join('\n');
}

function createCodexMarketplaceAddRunner(
  cwd: string,
  env: NodeJS.ProcessEnv,
  calls: NativeCliInvocation[] = [],
): NativeCliRunner {
  return async (invocation) => {
    calls.push(invocation);
    const awHome = invocation.args[3] ?? '';
    await upsertCodexMarketplaceFile(
      resolveCodexPaths(cwd, 'user', env).configTomlPath,
      'aw',
      {
        source: awHome,
        sourceType: 'local',
      },
    );
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  };
}

async function waitForHarnessMethod(
  harness: ReturnType<typeof createFakeCodexAppServerHarness>,
  method: string,
): Promise<void> {
  while (!harness.stdinMessages.some((message) => message.json?.method === method)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CodexAdapter', () => {
  it('preserves foreign and unresolved historical shared hook groups while rerendering the current plugin', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await upsertTrackingRecord(paths.trackingDir, 'history-only', [
      {
        path: paths.hooksPath,
        kind: 'hook',
        platform: 'codex',
        hookGroups: [
          {
            event: 'PreToolUse',
            matcher: 'Edit',
            command: 'echo historical',
          },
        ],
      },
    ]);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo historical' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: 'ignored',
            hooks: [{ type: 'command', command: 'echo foreign prompt' }],
          },
        ],
      },
    }, { spaces: 2 });

    await adapter.installExtensions(plugin, 'project');

    await expect(fs.readJson(paths.hooksPath)).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo historical' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: 'ignored',
            hooks: [{ type: 'command', command: 'echo foreign prompt' }],
          },
        ],
      },
    });
  });

  it('replaces current plugin shared hook groups during install when legacy tracking lacks hook groups', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: paths.hooksPath,
        kind: 'hook',
        platform: 'codex',
      },
    ]);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    }, { spaces: 2 });

    await adapter.installExtensions(plugin, 'project');

    await expect(fs.readJson(paths.hooksPath)).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
      },
    });
  });

  it('installs and uninstalls nativeHooks-only Codex plugins without removing foreign shared groups', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const plugin = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'Stop',
                command: 'echo native stop',
              },
            ],
          },
        },
      },
    };
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.ensureDir(path.dirname(paths.hooksPath));
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    }, { spaces: 2 });

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const hookArtifact = artifacts.find((artifact) => artifact.kind === 'hook');
    expect(hookArtifact?.path).toBeTruthy();
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    expect(await fs.pathExists(hookArtifact!.path)).toBe(true);
    const installedHooks = await fs.readJson(hookArtifact!.path).catch((error: Error) => {
      throw new Error(`read after install failed: ${error.message}`);
    });
    expect(installedHooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo native stop' }],
          },
        ],
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    expect(await fs.pathExists(hookArtifact!.path)).toBe(true);
    const remainingHooks = await fs.readJson(hookArtifact!.path).catch((error: Error) => {
      throw new Error(`read after uninstall failed: ${error.message}`);
    });
    expect(remainingHooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    });
  });

  it('writes structured MCP servers with quoted keys and tracking artifacts', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'mcp-only');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'mcp-only'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.outputFile(
      paths.configTomlPath,
      [
        '# keep me',
        '',
        '[mcp_servers.external]',
        'command = "external"',
        '',
      ].join('\n'),
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');

    expect(artifacts.filter((artifact) => artifact.kind === 'mcpServer')).toEqual([
      {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
      {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'sibling-server',
      },
    ]);

    const written = await fs.readFile(paths.configTomlPath, 'utf8');
    expect(written).toContain('[mcp_servers."acme.tools v1"]');
    expect(written).toContain('[mcp_servers."acme.tools v1".env]');
    expect(written).toContain('[mcp_servers."acme.tools v1".tools."deploy.check"]');
    expect(written).toContain('[mcp_servers.external]');
    expect(written).toContain('# keep me');
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        mcpServers: {
          'acme.tools v1': {
            value: {
              command: 'node',
              args: ['./servers/acme-tools.js', '--stdio'],
              env: {
                ACME_MODE: 'fixture',
                ACME_DEBUG: 'false',
              },
              startup_timeout_sec: 10,
              tool_timeout_sec: 30,
              tools: {
                'deploy.check': {
                  approval_mode: 'manual',
                },
              },
            },
          },
          external: {
            value: {
              command: 'external',
            },
          },
        },
      },
    });
  });

  it('refreshes tracked MCP servers and removes stale descendant tables', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'mcp-only');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'mcp-only'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.outputFile(
      paths.configTomlPath,
      [
        '[mcp_servers."acme.tools v1"]',
        'command = "old"',
        '',
        '[mcp_servers."acme.tools v1".env]',
        'OLD = "1"',
        '',
        '[mcp_servers."acme.tools v1".tools.old]',
        'approval_mode = "manual"',
        '',
      ].join('\n'),
      'utf8',
    );
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
    ]);

    await adapter.installExtensions(plugin, 'project');

    const written = await fs.readFile(paths.configTomlPath, 'utf8');
    expect(written).not.toContain('[mcp_servers."acme.tools v1".tools.old]');
    expect(written).not.toContain('OLD = "1"');
    expect(written).toContain('[mcp_servers."acme.tools v1".tools."deploy.check"]');
  });

  it('fails fast when an unmanaged MCP server with the same key already exists', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'mcp-only');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'mcp-only'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.outputFile(
      paths.configTomlPath,
      upsertCodexMcpServer('', 'acme.tools v1', {
        command: 'foreign',
      }),
      'utf8',
    );

    await expect(adapter.installExtensions(plugin, 'project')).rejects.toThrow(
      '当前插件没有 tracking 证明归属',
    );
  });

  it('removes only tracked MCP servers and can restore the config baseline for rollback', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'instructions-mcp');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'instructions-mcp'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const baseline = upsertCodexMcpServer(
      [
        '# baseline',
        '',
        'developer_instructions = "manual"',
        '',
      ].join('\n'),
      'external',
      {
        command: 'keep',
      },
    );
    await fs.outputFile(paths.configTomlPath, baseline, 'utf8');

    const rollbackArtifacts = await adapter.installExtensions(plugin, 'project');
    await adapter.uninstallExtensions(plugin, 'project', rollbackArtifacts);
    await expect(fs.readFile(paths.configTomlPath, 'utf8')).resolves.toBe(baseline);

    const trackedArtifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, trackedArtifacts);
    await adapter.uninstallExtensions(plugin, 'project');

    const finalConfig = await fs.readFile(paths.configTomlPath, 'utf8');
    expect(finalConfig).toContain('[mcp_servers.external]');
    expect(finalConfig).toContain('developer_instructions = "manual"');
    expect(finalConfig).not.toContain('instructions-mcp-server');
    expect(finalConfig).not.toContain('[[aw-managed:start plugin="instructions-mcp"');
  });

  it('reports MCP missing and drifted states through status warnings', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'mcp-only');
    const refreshedEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(refreshedEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(refreshedEmbeddedRoot);
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'mcp-only'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const drifted = upsertCodexMcpServer(
      removeCodexMcpServer(await fs.readFile(paths.configTomlPath, 'utf8'), 'sibling-server'),
      'acme.tools v1',
      {
        command: 'node',
        args: ['./servers/acme-tools.js', '--stdio'],
        env: {
          ACME_MODE: 'drifted',
          ACME_DEBUG: 'false',
        },
        startup_timeout_sec: 10,
        tool_timeout_sec: 30,
      },
    );
    await fs.writeFile(paths.configTomlPath, drifted, 'utf8');

    const report = await adapter.status(plugin, 'project');

    expect(report.plugins[0]).toMatchObject({
      artifactsInitialized: false,
    });
    expect(report.plugins[0].driftWarnings).toEqual(expect.arrayContaining([
      'Codex MCP server "acme.tools v1" 已漂移。 current TOML subtree differs from rendered .mcp.json.',
      'Codex MCP server "sibling-server" 缺失。',
    ]));
  });

  it('reports repo skill missing, drifted, and orphan states through status warnings', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'skills-only');
    const refreshedEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(refreshedEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(refreshedEmbeddedRoot);
    const plugin = await readPluginManifest(
      path.join(refreshedEmbeddedRoot, 'plugins', 'skills-only'),
      { mode: 'bundle' },
    );
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const skillPath = path.join(repoRoot, '.agents', 'skills', 'repo-check');

    await fs.copy(
      path.join(refreshedEmbeddedRoot, 'plugins', 'skills-only', 'codex', 'skills', 'repo-check'),
      skillPath,
    );
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [{
      path: skillPath,
      kind: 'skill',
      platform: 'codex',
      artifactKey: 'repo-check',
    }]);

    const projectKey = await resolveCodexProjectKey(cwd);
    const ledger = createAvailableLedger();
    ledger.plugins[plugin.manifest.name] = {
      lastResolvedVersion: plugin.manifest.version,
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-30T00:00:00.000Z',
              resolvedVersion: plugin.manifest.version,
              capabilitySnapshot: {
                requiresNativePlugin: false,
                hasRepoManagedArtifacts: true,
                projectManagedKinds: ['skill'],
              },
              installOptions: {
                skillTriggerPreference: 'default',
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, env);

    let report = await adapter.status(plugin, 'project');
    expect(
      report.plugins[0].driftWarnings.some((warning) => warning.includes('Codex repo skill "repo-check"')),
    ).toBe(false);

    await fs.remove(skillPath);
    report = await adapter.status(plugin, 'project');
    expect(report.plugins[0].driftWarnings).toContain('Codex repo skill "repo-check" 缺失。');

    await fs.copy(
      path.join(refreshedEmbeddedRoot, 'plugins', 'skills-only', 'codex', 'skills', 'repo-check'),
      skillPath,
    );
    await fs.appendFile(path.join(skillPath, 'SKILL.md'), '\nDrifted body.\n', 'utf8');
    report = await adapter.status(plugin, 'project');
    expect(
      report.plugins[0].driftWarnings.some((warning) => warning.includes('Codex repo skill "repo-check" 已漂移。')),
    ).toBe(true);

    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    await writeTrackingManifest(
      paths.trackingDir,
      removeTrackingRecordFromManifest(trackingManifest, plugin.manifest.name),
    );
    report = await adapter.status(plugin, 'project');
    expect(report.plugins[0].driftWarnings).toContain(
      'Codex repo skill "repo-check" 存在，但当前插件没有 tracking 证明归属。',
    );
  });

  it('renders and applies Codex instruction and role artifacts before writing static outputs', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'import { readFileSync } from "node:fs";',
        'const context = JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: `event=${context.event};scope=${context.scope};model=${context.config.values.explorerModel}`,',
        '          model: context.config.values.explorerModel,',
        '          model_reasoning_effort: context.config.values.modelReasoningEffort',
        '        }',
        '      }',
        '    },',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: `instruction-event=${context.event}`',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project', { event: 'upgrade' });
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: paths.configTomlPath,
        kind: 'instruction',
        platform: 'codex',
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      }),
      expect.objectContaining({
        path: roleFilePath,
        kind: 'agent',
        platform: 'codex',
        artifactKey: 'codex-explorer',
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: 'codex-explorer',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      }),
    ]));
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    const trackedArtifacts = (await readTrackingManifest(paths.trackingDir))
      .plugins[plugin.manifest.name]?.artifacts ?? [];
    expect(trackedArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toEqual(
      expect.objectContaining({
        path: paths.configTomlPath,
        paths: [paths.configTomlPath],
        state: 'present',
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(trackedArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toEqual(
      expect.objectContaining({
        path: roleFilePath,
        paths: [paths.configTomlPath, roleFilePath],
        state: 'present',
        roleKey: 'codex-explorer',
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    );

    const scopeConfig = await readCodexConfigFile(paths.configTomlPath);
    expect(scopeConfig.snapshot.developerInstructions.managedBlocks['dynamic-artifacts']?.value).toContain(
      'instruction-event=upgrade',
    );
    expect(scopeConfig.snapshot.agents['codex-explorer']).toEqual({
      key: 'codex-explorer',
      description: 'Read-only code exploration role.',
      configFile: 'agents/aw-dynamic-artifacts-codex-explorer.toml',
    });
    await expect(fs.readFile(roleFilePath, 'utf8')).resolves.toContain(
      'developer_instructions = "event=upgrade;scope=project;model=gpt-5.4-mini"',
    );
    await expect(fs.readFile(roleFilePath, 'utf8')).resolves.toContain(
      'model_reasoning_effort = "medium"',
    );
  });

  it('removes disabled rendered instruction blocks without leaving stale prompt text', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "disabled",',
        '      disabledReason: "config",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"]',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: "Inspect the repository."',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      upsertManagedInstructionBlock: {
        pluginName: 'dynamic-artifacts',
        value: 'legacy dynamic instruction',
      },
    });
    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      upsertManagedInstructionBlock: {
        pluginName: 'other-plugin',
        value: 'keep me',
      },
    });

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    const trackedArtifacts = (await readTrackingManifest(paths.trackingDir))
      .plugins[plugin.manifest.name]?.artifacts ?? [];
    expect(trackedArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toEqual(
      expect.objectContaining({
        path: paths.configTomlPath,
        paths: [paths.configTomlPath],
        kind: 'instruction',
        platform: 'codex',
        state: 'disabled',
        disabledReason: 'config',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(trackedArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toEqual(
      expect.objectContaining({
        kind: 'agent',
        roleKey: 'codex-explorer',
        state: 'present',
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    );

    const scopeConfig = await readCodexConfigFile(paths.configTomlPath);
    expect(scopeConfig.snapshot.developerInstructions.managedBlocks['dynamic-artifacts']).toBeUndefined();
    expect(scopeConfig.snapshot.developerInstructions.managedBlocks['other-plugin']?.value).toBe('keep me\n');
    await expect(fs.readFile(paths.configTomlPath, 'utf8')).resolves.not.toContain('legacy dynamic instruction');
  });

  it('removes disabled rendered role registrations and managed role layers while tracking the role as disabled', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    const initialArtifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, initialArtifacts);
    await expect(fs.pathExists(roleFilePath)).resolves.toBe(true);

    const roleTarget = plugin.manifest.artifacts?.targets.find((artifact) =>
      artifact.id === 'codex-explorer-role' && artifact.target === 'codex.agentRole',
    );
    if (!roleTarget) {
      throw new Error('missing codex-explorer-role target');
    }
    roleTarget.states = ['present', 'disabled'];
    await writeDynamicArtifactRendererScript(
      repoRoot,
      renderDynamicArtifactsFixture({ roleState: 'disabled' }),
    );

    const disabledArtifacts = await adapter.installExtensions(plugin, 'project', { event: 'upgrade' });
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, disabledArtifacts);

    await expect(fs.pathExists(roleFilePath)).resolves.toBe(false);
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        agents: {},
      },
    });

    const trackedArtifacts = (await readTrackingManifest(paths.trackingDir))
      .plugins[plugin.manifest.name]?.artifacts ?? [];
    expect(trackedArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toEqual(
      expect.objectContaining({
        path: roleFilePath,
        paths: [paths.configTomlPath, roleFilePath],
        kind: 'agent',
        target: 'codex.agentRole',
        state: 'disabled',
        roleKey: 'codex-explorer',
        disabledReason: 'config',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    );

    const status = await adapter.status(plugin, 'project');
    const roleArtifact = status.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role',
    );
    expect(roleArtifact).toMatchObject({
      target: 'codex.agentRole',
      state: 'disabled',
      health: 'disabledByConfig',
      sessionVisibility: 'absent',
      disabledReason: 'config',
    });
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex role artifact "codex-explorer" 缺失。',
    );
  });

  it('does not remove externally managed role registrations or files when a rendered role becomes disabled', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const managedRolePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );
    const userRolePath = path.join(paths.configDir, 'agents', 'user-codex-explorer.toml');

    const initialArtifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, initialArtifacts);
    await fs.outputFile(
      userRolePath,
      [
        'name = "codex-explorer"',
        'description = "User owned role"',
        'developer_instructions = "User instructions"',
        '',
      ].join('\n'),
      'utf8',
    );
    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      upsertAgentRegistrations: {
        'codex-explorer': {
          description: 'User owned role',
          configFile: 'agents/user-codex-explorer.toml',
        },
      },
    });

    const roleTarget = plugin.manifest.artifacts?.targets.find((artifact) =>
      artifact.id === 'codex-explorer-role' && artifact.target === 'codex.agentRole',
    );
    if (!roleTarget) {
      throw new Error('missing codex-explorer-role target');
    }
    roleTarget.states = ['present', 'disabled'];
    await writeDynamicArtifactRendererScript(
      repoRoot,
      renderDynamicArtifactsFixture({ roleState: 'disabled' }),
    );

    const disabledArtifacts = await adapter.installExtensions(plugin, 'project', { event: 'upgrade' });
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, disabledArtifacts);

    await expect(fs.pathExists(managedRolePath)).resolves.toBe(false);
    await expect(fs.pathExists(userRolePath)).resolves.toBe(true);
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        agents: {
          'codex-explorer': {
            key: 'codex-explorer',
            description: 'User owned role',
            configFile: 'agents/user-codex-explorer.toml',
          },
        },
      },
    });
  });

  it('applies dynamic instruction and role registration changes through a single Codex config transaction', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const transactionSpy = vi.spyOn(codexConfigModule, 'applyCodexConfigTransactionFile');

    await adapter.installExtensions(plugin, 'project');

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        upsertManagedInstructionBlock: expect.objectContaining({
          pluginName: 'dynamic-artifacts',
        }),
        upsertAgentRegistrations: {
          'codex-explorer': expect.objectContaining({
            description: 'Read-only code exploration role.',
            configFile: 'agents/aw-dynamic-artifacts-codex-explorer.toml',
          }),
        },
      }),
    );
  });

  it('keeps upgraded dynamic instruction and role surfaces while pruning stale tracked identities', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');

    const legacyPlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    legacyPlugin.manifest = {
      ...legacyPlugin.manifest,
      artifacts: {
        targets: [
          {
            id: 'legacy-instruction',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.developerInstructionsBlock',
            kind: 'instruction',
            projectManagedKind: 'instruction',
            states: ['present'],
            refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
            requiresCodexProjectConfig: true,
          },
          {
            id: 'legacy-role',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.agentRole',
            kind: 'codexRole',
            projectManagedKind: 'agent',
            states: ['present'],
            refreshKeys: ['explorerModel', 'modelReasoningEffort'],
            requiresCodexProjectConfig: true,
            roleKey: 'legacy-explorer',
          },
        ],
      },
    };
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "legacy-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "legacy instruction body"',
        '    },',
        '    {',
        '      id: "legacy-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "legacy-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Legacy role" },',
        '        roleFile: {',
        '          name: "legacy-explorer",',
        '          description: "Legacy role",',
        '          developer_instructions: "legacy role instructions"',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const legacyArtifacts = await adapter.installExtensions(legacyPlugin, 'project', { event: 'install' });
    await upsertTrackingRecord(paths.trackingDir, legacyPlugin.manifest.name, legacyArtifacts);

    const upgradedPlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "upgraded instruction body"',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Upgraded role" },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Upgraded role",',
        '          developer_instructions: "upgraded role instructions"',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const upgradedArtifacts = await adapter.installExtensions(upgradedPlugin, 'project', { event: 'upgrade' });
    const staleArtifacts = legacyArtifacts.filter((artifact) =>
      !new Set(upgradedArtifacts.map((entry) => getGeneratedArtifactIdentityKey(entry))).has(
        getGeneratedArtifactIdentityKey(artifact),
      ),
    );
    await pruneCodexTrackedArtifacts({
      cwd,
      scope: 'project',
      env,
      pluginName: upgradedPlugin.manifest.name,
      artifacts: staleArtifacts,
      preservedArtifacts: upgradedArtifacts,
    });
    await upsertTrackingRecord(paths.trackingDir, upgradedPlugin.manifest.name, upgradedArtifacts);

    const legacyRolePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(upgradedPlugin.manifest.name, 'legacy-explorer')}.toml`,
    );
    const upgradedRolePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(upgradedPlugin.manifest.name, 'codex-explorer')}.toml`,
    );
    const scopeConfig = await readCodexConfigFile(paths.configTomlPath);
    const trackedArtifacts = (await readTrackingManifest(paths.trackingDir))
      .plugins[upgradedPlugin.manifest.name]?.artifacts ?? [];

    expect(scopeConfig.snapshot.developerInstructions.managedBlocks['dynamic-artifacts']?.value).toContain(
      'upgraded instruction body',
    );
    expect(scopeConfig.snapshot.developerInstructions.managedBlocks['dynamic-artifacts']?.value).not.toContain(
      'legacy instruction body',
    );
    expect(scopeConfig.snapshot.agents['legacy-explorer']).toBeUndefined();
    expect(scopeConfig.snapshot.agents['codex-explorer']).toEqual({
      key: 'codex-explorer',
      description: 'Upgraded role',
      configFile: 'agents/aw-dynamic-artifacts-codex-explorer.toml',
    });
    await expect(fs.pathExists(legacyRolePath)).resolves.toBe(false);
    await expect(fs.readFile(upgradedRolePath, 'utf8')).resolves.toContain('upgraded role instructions');
    expect(trackedArtifacts.map((artifact) => artifact.id).sort()).toEqual([
      'codex-explorer-role',
      'lightweight-instruction',
    ]);
  });

  it('reports dynamic instruction and role artifacts separately in project status', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const status = await adapter.status(plugin, 'project');
    const managedArtifacts = status.plugins[0].managedArtifacts ?? [];

    expect(status.plugins[0].repoManagedSessionState).toMatchObject({
      instructions: 'visible',
      agents: 'visible',
    });
    expect(managedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        health: 'healthy',
        sessionVisibility: 'visible',
        configDigest: expect.stringMatching(/^sha256:/),
        currentConfigDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
        currentContentDigest: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: 'codex-explorer',
        health: 'healthy',
        sessionVisibility: 'visible',
        configDigest: expect.stringMatching(/^sha256:/),
        currentConfigDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
        currentContentDigest: expect.stringMatching(/^sha256:/),
      }),
    ]));
  });

  it('does not report disabled instruction artifacts as missing in status', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(
      repoRoot,
      renderDynamicArtifactsFixture({ instructionState: 'disabled' }),
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const status = await adapter.status(plugin, 'project');
    const instructionArtifact = status.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'lightweight-instruction',
    );

    expect(instructionArtifact).toMatchObject({
      target: 'codex.developerInstructionsBlock',
      state: 'disabled',
      health: 'disabledByConfig',
      sessionVisibility: 'absent',
      disabledReason: 'config',
    });
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex instruction artifact "lightweight-instruction" 缺失。',
    );
  });

  it('diagnoses recent refresh failures from tracking metadata', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(
      paths.trackingDir,
      plugin.manifest.name,
      artifacts.map((artifact) =>
        artifact.id === 'codex-explorer-role'
          ? {
              ...artifact,
              lastRefresh: {
                status: 'failed' as const,
                updatedAt: '2026-05-04T08:00:00.000Z',
                triggerKeys: ['explorerModel'],
                event: 'refresh' as const,
                error: 'renderer failed',
              },
              refreshReach: {
                commandScope: 'project' as const,
                refreshedCurrentProjectTarget: true,
                scannedHistoricalProjects: false,
              },
            }
          : artifact),
    );

    const status = await adapter.status(plugin, 'project');
    const roleArtifact = status.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role',
    );

    expect(roleArtifact).toMatchObject({
      health: 'recentRefreshFailed',
      sessionVisibility: 'visible',
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T08:00:00.000Z',
        triggerKeys: ['explorerModel'],
        event: 'refresh',
        error: 'renderer failed',
      },
      refreshReach: {
        commandScope: 'project',
        refreshedCurrentProjectTarget: true,
        scannedHistoricalProjects: false,
      },
    });
    expect(status.plugins[0].driftWarnings).toContain(
      'Codex role artifact "codex-explorer" 最近 refresh 失败。 最近一次 refresh 失败（2026-05-04T08:00:00.000Z，triggerKeys=explorerModel）：renderer failed',
    );
  });

  it('diagnoses config stale, registration drift, and missing role layers for dynamic role artifacts', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        explorerModel: 'gpt-5.4',
      },
    });
    let status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      health: 'configDigestStale',
      sessionVisibility: 'visible',
    });

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {},
    });
    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      upsertAgentRegistrations: {
        'codex-explorer': {
          description: 'Drifted registration description.',
          configFile: 'agents/aw-dynamic-artifacts-codex-explorer.toml',
        },
      },
    });
    status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      health: 'registrationDrift',
      sessionVisibility: 'visible',
    });

    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      upsertAgentRegistrations: {
        'codex-explorer': {
          description: 'Read-only code exploration role.',
          configFile: 'agents/aw-dynamic-artifacts-codex-explorer.toml',
        },
      },
    });
    await fs.remove(roleFilePath);
    status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      health: 'roleLayerMissing',
      sessionVisibility: 'absent',
    });
  });

  it('separates project artifact health from session visibility across repo trust states', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    let status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].projectTrust).toBe('unknown');
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.health)).toEqual([
      'healthy',
      'healthy',
    ]);
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.sessionVisibility)).toEqual([
      'projectTrustUnknown',
      'projectTrustUnknown',
    ]);

    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "untrusted"\n`,
      'utf8',
    );
    status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].projectTrust).toBe('untrusted');
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.health)).toEqual([
      'healthy',
      'healthy',
    ]);
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.sessionVisibility)).toEqual([
      'blockedByProjectTrust',
      'blockedByProjectTrust',
    ]);

    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );
    status = await adapter.status(plugin, 'project');
    expect(status.plugins[0].projectTrust).toBe('trusted');
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.health)).toEqual([
      'healthy',
      'healthy',
    ]);
    expect(status.plugins[0].managedArtifacts?.map((artifact) => artifact.sessionVisibility)).toEqual([
      'visible',
      'visible',
    ]);
  });

  it('diagnoses user-scope dynamic role visibility from the final role namespace', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'user', env);

    const artifacts = await adapter.installExtensions(plugin, 'user');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await fs.ensureDir(path.dirname(paths.configTomlPath));
    await fs.writeFile(
      paths.configTomlPath,
      `${await fs.readFile(paths.configTomlPath, 'utf8')}\n[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const projectCodexDir = path.join(repoRoot, '.codex');
    await fs.ensureDir(path.join(projectCodexDir, 'agents'));
    await fs.writeFile(
      path.join(projectCodexDir, 'config.toml'),
      '[agents.shadow-alias]\ndescription = "Shadow alias"\nconfig_file = "agents/shadow.toml"\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectCodexDir, 'agents', 'shadow.toml'),
      'name = "codex-explorer"\ndescription = "Shadow role"\ndeveloper_instructions = "shadow"\n',
      'utf8',
    );

    const status = await adapter.status(plugin, 'user');
    expect(status.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      health: 'healthy',
      sessionVisibility: 'unknownByExternalLayer',
    });
  });

  it('fails invalid rendered artifact plans before writing any Codex files', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await expect(adapter.installExtensions(plugin, 'project')).rejects.toThrow(
      'renderer must return artifact "lightweight-instruction"',
    );
    await expect(fs.pathExists(paths.configTomlPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(paths.configDir, 'agents'))).resolves.toBe(false);
  });

  it('refuses to apply a rendered role when tracking claims a different managed role identity', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    const baselineConfig = await fs.readFile(paths.configTomlPath, 'utf8');
    const baselineRoleFile = await fs.readFile(roleFilePath, 'utf8');
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackedRoleArtifact = trackingManifest.plugins[plugin.manifest.name]?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role'
    );
    if (!trackedRoleArtifact) {
      throw new Error('missing tracked role artifact');
    }
    trackedRoleArtifact.artifactKey = 'shadow-explorer';
    trackedRoleArtifact.roleKey = 'shadow-explorer';
    await writeTrackingManifest(paths.trackingDir, trackingManifest);

    await expect(
      adapter.installExtensions(plugin, 'project', { event: 'upgrade' }),
    ).rejects.toThrow('tracking 受管身份');
    await expect(fs.readFile(paths.configTomlPath, 'utf8')).resolves.toBe(baselineConfig);
    await expect(fs.readFile(roleFilePath, 'utf8')).resolves.toBe(baselineRoleFile);
  });

  it('restores dynamic role files and config when later static artifact generation fails', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "old instruction"',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: "old role instructions"',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    await adapter.installExtensions(plugin, 'project');
    const baselineConfig = await fs.readFile(paths.configTomlPath, 'utf8');
    const baselineRoleFile = await fs.readFile(roleFilePath, 'utf8');

    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "new instruction"',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: "new role instructions"',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );
    const pluginWithInvalidPermission = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        extensions: {
          ...(plugin.manifest.extensions ?? {}),
          permissions: [{
            name: 'invalid',
            allow: ['bad;cmd'],
          }],
        },
      },
    };

    await expect(adapter.installExtensions(pluginWithInvalidPermission, 'project')).rejects.toThrow(
      'only plain token prefixes',
    );
    await expect(fs.readFile(paths.configTomlPath, 'utf8')).resolves.toBe(baselineConfig);
    await expect(fs.readFile(roleFilePath, 'utf8')).resolves.toBe(baselineRoleFile);
  });

  it('uninstalls managed Codex roles without deleting drifted user-owned role files', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "lightweight-instruction",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "Inspect the repository."',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Read-only code exploration role." },',
        '        roleFile: {',
        '          name: "codex-explorer",',
        '          description: "Read-only code exploration role.",',
        '          developer_instructions: "Inspect the repository."',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    const managedRolePath = artifacts.find(
      (artifact) => artifact.kind === 'agent' && artifact.artifactKey === 'codex-explorer',
    )?.path;
    const userRolePath = path.join(paths.configDir, 'agents', 'user-codex-explorer.toml');
    await fs.outputFile(
      userRolePath,
      'name = "codex-explorer"\ndescription = "user"\ndeveloper_instructions = "user"\n',
      'utf8',
    );
    await applyCodexConfigTransactionFile(paths.configTomlPath, {
      removeAgentRegistrations: ['codex-explorer'],
      upsertAgentRegistrations: {
        'codex-explorer': {
          description: 'User owned role',
          configFile: 'agents/user-codex-explorer.toml',
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project');

    expect(managedRolePath).toBeTruthy();
    await expect(fs.pathExists(managedRolePath!)).resolves.toBe(false);
    await expect(fs.pathExists(userRolePath)).resolves.toBe(true);
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        agents: {},
      },
    });
  });

  it('cleans up disabled dynamic instruction and role artifacts during uninstall', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'dynamic-artifacts');
    await writeDynamicArtifactRendererScript(repoRoot, renderDynamicArtifactsFixture());

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'dynamic-artifacts'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const roleFilePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'codex-explorer')}.toml`,
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(
      paths.trackingDir,
      plugin.manifest.name,
      artifacts.map((artifact) =>
        artifact.id
          ? {
              ...artifact,
              state: 'disabled' as const,
              disabledReason: 'config',
            }
          : artifact),
    );

    await adapter.uninstallExtensions(plugin, 'project');

    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        developerInstructions: {
          managedBlocks: {},
        },
        agents: {},
      },
    });
    await expect(fs.pathExists(roleFilePath)).resolves.toBe(false);
  });

  it('registers the Codex marketplace through native add using the canonical AW_HOME path', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    const realAwHome = `${env.AW_HOME}-real`;
    const aliasAwHome = `${env.AW_HOME}-alias`;
    await fs.ensureDir(realAwHome);
    await fs.symlink(realAwHome, aliasAwHome);
    env.AW_HOME = aliasAwHome;
    process.env.AW_HOME = aliasAwHome;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCalls: NativeCliInvocation[] = [];
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(
      cwd,
      createCodexMarketplaceAddRunner(cwd, env, nativeCalls),
      env,
      appServerHarness.createRunner(),
    );
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    await adapter.installPlugin(plugin, 'user');
    await installSideEffect;

    const configSnapshot = await readCodexConfigFile(configPath);
    const canonicalAwHome = await fs.realpath(aliasAwHome);

    expect(nativeCalls.map((invocation) => invocation.args)).toEqual([
      ['plugin', 'marketplace', 'add', canonicalAwHome],
    ]);
    expect(nativeCalls[0]).toMatchObject({
      command: 'codex',
      cwd,
      env,
    });
    expect(configSnapshot.snapshot.marketplaces.aw).toMatchObject({
      source: canonicalAwHome,
      sourceType: 'local',
    });
    expect(appServerHarness.invocations).toEqual([
      {
        command: 'codex',
        args: ['app-server'],
        cwd,
        env,
      },
    ]);
    await expect(
      fs.pathExists(path.join(env.AW_CODEX_HOME!, 'plugins', '.tmp', 'marketplaces', 'aw')),
    ).resolves.toBe(false);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain(
      `source = ${JSON.stringify(canonicalAwHome)}`,
    );
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(
      `source = ${JSON.stringify(aliasAwHome)}`,
    );
  });

  it('skips native marketplace add when Codex already points to the canonical AW_HOME', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env, appServerHarness.createRunner());
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    await adapter.installPlugin(plugin, 'user');
    await installSideEffect;

    expect(nativeCliRunner).not.toHaveBeenCalled();
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'git-commit@aw': {
            enabled: true,
          },
        },
      },
    });
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'pending_after_native_write',
    });
    expect(appServerHarness.invocations).toHaveLength(1);
  });

  it('runs Codex user native install through app-server RPC and requires cache materialization', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    await adapter.installPlugin(plugin, 'user');
    await installSideEffect;

    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'git-commit@aw': {
            enabled: true,
          },
        },
      },
    });
    await expect(
      fs.pathExists(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name)),
    ).resolves.toBe(true);
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'pending_after_native_write',
      marketplacePath: path.join(canonicalAwHome, '.agents', 'plugins', 'marketplace.json'),
    });
    expect(appServerHarness.stdinMessages.map((message) => message.json?.method)).toContain('plugin/install');
  });

  it('fails install when app-server reports unknown method and does not fall back to config-only', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'install-1', error: { code: -32601, message: 'unknown method plugin/install' } },
          },
        ],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('不支持 `plugin/install`');
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
      },
    });
    await expect(
      fs.pathExists(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name)),
    ).resolves.toBe(false);
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
  });

  it('fails install when app-server denies install policy and does not write config-only fallback', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: {
              id: 'install-1',
              error: { code: -32001, message: 'Installation denied by marketplace policy' },
            },
          },
        ],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('install policy');
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
      },
    });
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
  });

  it('fails install post-check when cache is missing and keeps a recovery breadcrumb', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    adapter.setCommandEventSink((event) => {
      events.push(event as { type: string; data?: Record<string, unknown> });
    });
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
    });

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('安装后校验失败');
    await installSideEffect;
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'post_check_failed',
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'native:marketplace',
          data: expect.objectContaining({
            operation: 'verify',
            phase: 'success',
            plugin: 'git-commit',
            marketplaceName: 'aw',
          }),
        }),
        expect.objectContaining({
          type: 'native:rpc',
          data: expect.objectContaining({
            method: 'plugin/install',
            phase: 'success',
            pluginId: 'git-commit@aw',
            nativeWriteSucceeded: true,
          }),
        }),
        expect.objectContaining({
          type: 'native:post-check',
          data: expect.objectContaining({
            operation: 'install',
            phase: 'error',
            pluginEnabled: true,
            configEntryPresent: true,
            pluginInstalled: false,
            errorCategory: 'post_check_failed',
          }),
        }),
        expect.objectContaining({
          type: 'native:recovery',
          data: expect.objectContaining({
            operation: 'update',
            phase: 'success',
            state: 'post_check_failed',
            nativeWriteSucceeded: true,
            recoveryBreadcrumbPersisted: true,
          }),
        }),
      ]),
    );
  });

  it('fails immediately when native install succeeded but breadcrumb persistence fails', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    adapter.setCommandEventSink((event) => {
      events.push(event as { type: string; data?: Record<string, unknown> });
    });
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    vi.spyOn(codexNativeRecoveryModule, 'writeCodexNativeRecoveryBreadcrumb')
      .mockRejectedValueOnce(new Error('simulated breadcrumb write failure'));

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('AW 没有持久化恢复证据');
    await installSideEffect;
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'native:rpc',
          data: expect.objectContaining({
            method: 'plugin/install',
            phase: 'success',
            nativeWriteSucceeded: true,
          }),
        }),
        expect.objectContaining({
          type: 'native:recovery',
          data: expect.objectContaining({
            operation: 'write',
            phase: 'error',
            state: 'pending_after_native_write',
            nativeWriteSucceeded: true,
            recoveryBreadcrumbPersisted: false,
            errorCategory: 'breadcrumb_write_failed',
          }),
        }),
      ]),
    );
    expect(
      events.find((event) => event.type === 'native:recovery' && event.data?.phase === 'error')?.data?.suggestion,
    ).toContain('自动授权');
  });

  it('repairs old manifest-file Codex marketplace sources through native add', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: path.join(env.AW_HOME!, '.agents', 'plugins', 'marketplace.json'),
      sourceType: 'local',
    });

    const nativeCalls: NativeCliInvocation[] = [];
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(
      cwd,
      createCodexMarketplaceAddRunner(cwd, env, nativeCalls),
      env,
      appServerHarness.createRunner(),
    );
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    await adapter.installPlugin(plugin, 'user');
    await installSideEffect;

    expect(nativeCalls.map((invocation) => invocation.args)).toEqual([
      ['plugin', 'marketplace', 'add', await fs.realpath(env.AW_HOME!)],
    ]);
  });

  it('repairs wrong local Codex marketplace directories through native add', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: path.join(env.AW_HOME!, 'old-copy'),
      sourceType: 'local',
    });

    const nativeCalls: NativeCliInvocation[] = [];
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(
      cwd,
      createCodexMarketplaceAddRunner(cwd, env, nativeCalls),
      env,
      appServerHarness.createRunner(),
    );
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, plugin.manifest.name);
    const installSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/install').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
      await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    });

    await adapter.installPlugin(plugin, 'user');
    await installSideEffect;

    expect(nativeCalls.map((invocation) => invocation.args)).toEqual([
      ['plugin', 'marketplace', 'add', await fs.realpath(env.AW_HOME!)],
    ]);
  });

  it('reports wrong local Codex marketplace directories as status drift', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await initializeLocalMarketplace({ force: true, env });
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const wrongSource = path.join(env.AW_HOME!, 'old-copy');
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: wrongSource,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const report = await adapter.status(plugin, 'user');

    expect(report.plugins[0].native).toMatchObject({
      marketplaceRegistered: false,
      marketplaceSource: wrongSource,
      marketplaceSourceType: 'local',
      marketplaceRootResolution: 'unknown',
      pluginInstalled: false,
    });
    expect(report.plugins[0].driftWarnings).toContain(
      `Codex marketplace source 指向 ${wrongSource}，未指向当前 AW_HOME ${await fs.realpath(env.AW_HOME!)}。`,
    );
  });

  it('treats enabled-only Codex config as fallback evidence instead of installed cache', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const report = await adapter.status(plugin, 'user');

    expect(report.initialized).toBe(true);
    expect(report.plugins[0]).toMatchObject({
      native: {
        pluginInstalled: false,
        pluginEnabled: true,
        configEntryPresent: true,
        recovery: {
          present: false,
          state: null,
          reason: null,
          evidenceMatches: null,
          suggestion: null,
        },
      },
      platformNativeFallbackEvidence: {
        present: true,
      },
    });
    await expect(
      fs.pathExists(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name)),
    ).resolves.toBe(false);
  });

  it('does not call native marketplace add for instruction-only Codex plugins', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const plugin = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: undefined,
        mcpServers: undefined,
        apps: undefined,
      },
    };
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env);

    await adapter.installPlugin(plugin, 'user');

    expect(nativeCliRunner).not.toHaveBeenCalled();
  });

  it('wraps native marketplace add failures with an actionable Codex error', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([]);
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: 'marketplace root is invalid',
      });
    };
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env, appServerHarness.createRunner());

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow(
      '无法通过 Codex 原生命令注册 AW 本地 marketplace',
    );
    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow(
      'marketplace root is invalid',
    );
    expect(appServerHarness.invocations).toEqual([]);
  });

  it('wraps native marketplace add failures that have no command output', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
    };
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env);

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow(
      '无法通过 Codex 原生命令注册 AW 本地 marketplace',
    );
    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('exit code 1');
  });

  it('explains native marketplace add timeouts', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 124,
        stdout: '',
        stderr: '',
      });
    };
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env);

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('超时');
  });

  it('explains missing codex executables when native marketplace add cannot start', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      const cause = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: '',
        cause,
      });
    };
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env);

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow('找不到 `codex` 可执行文件');
  });

  it('fails clearly when native add does not register the canonical marketplace source', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([]);
    const nativeCliRunner: NativeCliRunner = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env, appServerHarness.createRunner());

    await expect(adapter.installPlugin(plugin, 'user')).rejects.toThrow(
      '[marketplaces.aw] 没有指向',
    );
    expect(appServerHarness.invocations).toEqual([]);
  });

  it('builds Codex local marketplace add invocations without git-only flags', async () => {
    const env = { PATH: '/tmp/bin' } as NodeJS.ProcessEnv;

    expect(buildCodexMarketplaceAddInvocation('/tmp/aw', '/tmp/project', env)).toEqual({
      command: 'codex',
      args: ['plugin', 'marketplace', 'add', '/tmp/aw'],
      cwd: '/tmp/project',
      env,
    });
  });

  it('runs Codex user native uninstall through app-server RPC and removes cache/config/breadcrumb', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await fs.ensureDir(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const installedManifestPath = path.join(env.AW_CODEX_HOME!, 'plugins', 'git-commit@aw', 'manifest.json');
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, 'git-commit'), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await fs.outputFile(installedManifestPath, '{}\n', 'utf8');
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-04T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                },
                sharedNativeRefs: {
                  user: true,
                  projects: [],
                },
              },
            },
          },
        },
      },
      env,
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: plugin.manifest.name,
      state: 'pending_after_native_write',
      reason: 'native_write_succeeded_post_steps_pending',
      env,
    });
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    adapter.setCommandEventSink((event) => {
      events.push(event as { type: string; data?: Record<string, unknown> });
    });
    const uninstallSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/uninstall').then(async () => {
      await removeCodexPluginEnabledFile(configPath, 'git-commit@aw');
      await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'git-commit'));
    });

    await adapter.uninstallPlugin(plugin, 'user');
    await uninstallSideEffect;

    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
      },
    });
    await expect(fs.pathExists(installedManifestPath)).resolves.toBe(false);
    await expect(
      fs.pathExists(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name)),
    ).resolves.toBe(false);
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
    expect(appServerHarness.stdinMessages.map((message) => message.json?.method)).toContain('plugin/uninstall');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'native:rpc',
          data: expect.objectContaining({
            method: 'plugin/uninstall',
            phase: 'success',
            pluginId: 'git-commit@aw',
            nativeWriteSucceeded: true,
          }),
        }),
        expect.objectContaining({
          type: 'native:post-check',
          data: expect.objectContaining({
            operation: 'uninstall',
            phase: 'success',
            pluginEnabled: false,
            configEntryPresent: false,
            pluginInstalled: false,
          }),
        }),
        expect.objectContaining({
          type: 'native:recovery',
          data: expect.objectContaining({
            operation: 'delete',
            phase: 'success',
            state: 'pending_after_native_write',
            nativeWriteSucceeded: true,
            recoveryBreadcrumbPersisted: false,
          }),
        }),
      ]),
    );
  });

  it('does not call plugin/uninstall while the target plugin still has shared native refs', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await fs.ensureDir(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, 'git-commit'), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-04T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                },
                sharedNativeRefs: {
                  user: true,
                  projects: ['repo:/another'],
                },
              },
            },
          },
        },
      },
      env,
    );

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const appServerHarness = createFakeCodexAppServerHarness([]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());

    await adapter.uninstallPlugin(plugin, 'user');

    expect(appServerHarness.invocations).toEqual([]);
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'git-commit@aw': {
            enabled: true,
          },
        },
        marketplaces: {
          aw: {
            source: canonicalAwHome,
            sourceType: 'local',
          },
        },
      },
    });
    await expect(
      fs.pathExists(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name)),
    ).resolves.toBe(true);
  });

  it('supports breadcrumb-only cleanup through adapter-level plugin id uninstall', async () => {
    const { cwd, env } = await makeWorkspace();
    await fs.ensureDir(env.AW_HOME!);
    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, 'git-commit'), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    const installedManifestPath = path.join(env.AW_CODEX_HOME!, 'plugins', 'git-commit@aw', 'manifest.json');
    await fs.outputFile(installedManifestPath, '{}\n', 'utf8');
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(cwd, env, appServerHarness.createRunner());
    const uninstallSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/uninstall').then(async () => {
      await removeCodexPluginEnabledFile(configPath, 'git-commit@aw');
      await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'git-commit'));
    });

    await adapter.uninstallUserNativePluginById('git-commit@aw');
    await uninstallSideEffect;

    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
        marketplaces: {},
      },
    });
    await expect(fs.pathExists(installedManifestPath)).resolves.toBe(false);
  });

  it('does not call marketplace add or app-server for Codex project scope installs', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'skills-only');
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'skills-only'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const appServerHarness = createFakeCodexAppServerHarness([]);
    const adapter = new CodexAdapter(cwd, nativeCliRunner, env, appServerHarness.createRunner());

    await adapter.installPlugin(plugin, 'project');

    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(appServerHarness.invocations).toEqual([]);
    await expect(
      fs.pathExists(resolveCodexPaths(cwd, 'user', env).configTomlPath),
    ).resolves.toBe(false);
  });

  it('detects enabled higher-priority current/tree/repo layers in user scope status', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    process.env.AW_HOME = env.AW_HOME;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'user');
    await upsertTrackingRecord(userPaths.trackingDir, plugin.manifest.name, artifacts);
    await expect(readCodexConfigFile(userPaths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        projects: {
          [repoRoot]: {
            trustLevel: 'trusted',
          },
        },
      },
    });
    await fs.writeFile(
      path.join(cwd, 'config.toml'),
      'developer_instructions = "cwd layer"\n',
      'utf8',
    );

    const generatedAgentId = buildGeneratedName(plugin.manifest.name, 'commit-reviewer');
    const ancestorCodexDir = path.join(repoRoot, 'packages', '.codex');
    await fs.ensureDir(path.join(ancestorCodexDir, 'rules'));
    await fs.ensureDir(path.join(ancestorCodexDir, 'agents'));
    await fs.writeFile(
      path.join(ancestorCodexDir, 'config.toml'),
      'developer_instructions = "tree layer"\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(ancestorCodexDir, 'rules', 'overlay.rules'),
      'allow = []\n',
      'utf8',
    );
    await fs.writeJson(path.join(ancestorCodexDir, 'hooks.json'), { hooks: [] }, { spaces: 2 });
    await fs.writeFile(
      path.join(ancestorCodexDir, 'agents', `${generatedAgentId}.toml`),
      'name = "tree-reviewer"\ndescription = "tree"\ndeveloper_instructions = "tree"\n',
      'utf8',
    );

    const repoCodexDir = path.join(repoRoot, '.codex');
    await fs.ensureDir(repoCodexDir);
    await fs.writeFile(
      path.join(repoCodexDir, 'config.toml'),
      'developer_instructions = "repo layer"\n',
      'utf8',
    );

    const status = await adapter.status(plugin, 'user');

    expect(status.plugins[0]).toMatchObject({
      projectTrust: 'trusted',
      repoManagedSessionState: {
        instructions: 'unknownByExternalLayer',
        rules: 'visible',
        hooks: 'visible',
        agents: 'unknownByExternalLayer',
      },
    });
    expect(status.plugins[0].repoManagedSessionState?.diagnostics).toContain(
      'effective exec policy 还叠加了外部 layer 的 rules。',
    );
    expect(status.plugins[0].repoManagedSessionState?.diagnostics).toContain(
      'effective hooks registry 还叠加了外部 layer 的 hooks。',
    );
  });

  it('removes repo-managed Codex artifacts without relying on tracking records', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const permissionArtifact = artifacts.find((artifact) => artifact.kind === 'permission');
    const agentArtifact = artifacts.find((artifact) => artifact.kind === 'agent');
    const hookArtifact = artifacts.find((artifact) => artifact.kind === 'hook');

    expect(permissionArtifact?.path).toBeTruthy();
    expect(agentArtifact?.path).toBeTruthy();
    expect(hookArtifact?.path).toBeTruthy();
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        developerInstructions: {
          defined: true,
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        developerInstructions: {
          defined: false,
          managedBlocks: {},
        },
      },
    });
    await expect(fs.pathExists(permissionArtifact!.path)).resolves.toBe(false);
    await expect(fs.pathExists(agentArtifact!.path)).resolves.toBe(false);
    await expect(fs.pathExists(hookArtifact!.path)).resolves.toBe(false);
  });

  it('reports Codex hook drift when the shared hooks file loses this plugin handlers', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [],
      },
    }, { spaces: 2 });

    const status = await adapter.status(plugin, 'project');

    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(status.plugins[0].driftWarnings).toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('does not treat invalid Codex matcher groups as satisfying managed hooks', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: '[',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
      },
    }, { spaces: 2 });

    const status = await adapter.status(plugin, 'project');

    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(status.plugins[0].driftWarnings).toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('treats Rust-regex-only valid Codex matcher groups as satisfying managed hooks', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const plugin = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'PreToolUse',
                matcher: '(?i:write)',
                command: 'echo inline flags',
              },
            ],
          },
        },
      },
    };
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);

    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const status = await adapter.status(plugin, 'project');

    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('visible');
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('falls back to tracked hook identities when the current Codex catalog entry is missing', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    process.env.AW_HOME = env.AW_HOME;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'user', env);

    const artifacts = await adapter.installExtensions(plugin, 'user');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    await removePluginFromEmbeddedCatalog(embeddedRoot, plugin.manifest.name);

    const status = await adapter.status(plugin, 'user');

    expect(status.plugins[0]).toMatchObject({
      catalogCompatibility: 'missing',
      repoManagedSessionState: {
        hooks: 'visible',
      },
    });
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('rejects existing Codex hooks with unsupported native event names before rewriting', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        sessionStop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo done' }],
          },
        ],
      },
    }, { spaces: 2 });

    await expect(adapter.uninstallExtensions(plugin, 'project', artifacts)).rejects.toThrow(
      'codex.hooks.hooks.sessionStop',
    );
  });

  it('reports a clear diagnostic when legacy hook tracking lacks comparable hook groups', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    process.env.AW_HOME = env.AW_HOME;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'user', env);

    await fs.ensureDir(path.dirname(paths.hooksPath));
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo historical raw hook' }],
          },
        ],
      },
    }, { spaces: 2 });
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: paths.hooksPath,
        kind: 'hook',
        platform: 'codex',
      },
    ]);

    await removePluginFromEmbeddedCatalog(embeddedRoot, plugin.manifest.name);

    const status = await adapter.status(plugin, 'user');

    expect(status.plugins[0].catalogCompatibility).toBe('missing');
    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(status.plugins[0].driftWarnings).toContain(
      '历史 tracking manifest 只有 Codex hook kind，缺少可比较的 hook identities。',
    );
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('preserves raw shared hook groups when uninstalling a legacy hook artifact without hook groups', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.ensureDir(path.dirname(paths.hooksPath));
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo historical raw hook' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    }, { spaces: 2 });
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: paths.hooksPath,
        kind: 'hook',
        platform: 'codex',
      },
    ]);

    await adapter.uninstallExtensions(plugin, 'project');

    await expect(fs.readJson(paths.hooksPath)).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo historical raw hook' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    });
  });
});
