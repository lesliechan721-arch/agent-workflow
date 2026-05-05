import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';
import { preflightCodexProjectWriteSafety } from '../../src/commands/codex-project-safety.js';
import { buildGeneratedName } from '../../src/generators/shared.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import {
  removeCodexMcpServer,
  upsertCodexMcpServer,
  upsertCodexPluginEnabledFile,
  upsertManagedDeveloperInstructionsFile,
  readCodexConfigFile,
} from '../../src/utils/codex-config.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { readTrackingManifest, upsertTrackingRecord } from '../../src/utils/tracking.js';
import * as trackingModule from '../../src/utils/tracking.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  runWithZeroWriteSnapshot,
  writeCorruptedCodexProjectConfig,
  writeCorruptedCodexUserConfig,
  writeTrackingManifestWithMissingArtifactKey,
} from '../helpers/repo-managed-state.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeCodexWorkspace(options: {
  pluginDirs: string[];
  mutateRepo?: (repoRoot: string) => Promise<void>;
  forceClaude?: boolean;
  forceCodex?: boolean;
}): Promise<{
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-safety-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(path.join(repoRoot, 'plugins'));
  await fs.copy(
    fixturePath('codex-project-repo-managed', 'plugins', 'marketplace-source.json'),
    path.join(repoRoot, 'plugins', 'marketplace-source.json'),
  );

  for (const pluginDir of options.pluginDirs) {
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', pluginDir),
      path.join(repoRoot, 'plugins', pluginDir),
    );
  }

  await options.mutateRepo?.(repoRoot);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      ...(options.forceCodex === false ? {} : { AW_FORCE_CODEX_AVAILABLE: '1' }),
      ...(options.forceClaude ? { AW_FORCE_CLAUDE_AVAILABLE: '1' } : {}),
      PATH: '',
    },
  };
}

async function makeRepoTemplateWorkspace(options: {
  mutateRepo?: (repoRoot: string) => Promise<void>;
} = {}): Promise<{
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-safety-template-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await removeAppsFromGitCommit(repoRoot);
  await options.mutateRepo?.(repoRoot);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_FORCE_CODEX_AVAILABLE: '1',
      AW_FORCE_CLAUDE_AVAILABLE: '1',
      PATH: '',
    },
  };
}

async function rebuildEmbeddedRootForWorkspace(repoRoot: string): Promise<string> {
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  return embeddedRoot;
}

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
}

async function addRequiredTokenConfig(repoRoot: string, pluginName: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', pluginName, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config = {
    ...(manifest.config ?? {}),
    schema: {
      ...(manifest.config?.schema ?? {}),
      token: {
        type: 'string',
        title: 'Token',
        required: true,
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function mutateFixturePluginManifest(
  repoRoot: string,
  pluginName: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', pluginName, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  mutate(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function removeFixturePluginSkills(
  repoRoot: string,
  pluginName: string,
): Promise<void> {
  await mutateFixturePluginManifest(repoRoot, pluginName, (manifest) => {
    delete manifest.skills;
    delete manifest.skillTriggers;
  });
  await fs.remove(path.join(repoRoot, 'plugins', pluginName, 'skills'));
}

async function writeFixtureArtifactRenderer(
  repoRoot: string,
  pluginName: string,
  source: string,
): Promise<void> {
  await fs.writeFile(
    path.join(repoRoot, 'plugins', pluginName, 'scripts', 'render-artifacts.mjs'),
    source,
    'utf8',
  );
}

function renderInvalidDynamicArtifactsPlan(): string {
  return [
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
    '          developer_instructions: "Inspect the repository."',
    '        }',
    '      }',
    '    }',
    '  ]',
    '}));',
  ].join('\n');
}

function renderValidDynamicArtifactsPlan(): string {
  return [
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
    '      content: "Inspect the repository carefully."',
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
  ].join('\n');
}

async function seedCodexProjectEvidence(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  artifacts: GeneratedArtifact[];
  managedKinds: Array<'skill' | 'mcpServer' | 'instruction'>;
}): Promise<void> {
  const projectKey = await resolveCodexProjectKey(options.repoRoot);
  const ledger = createAvailableLedger();
  ledger.plugins[options.pluginName] = {
    lastResolvedVersion: '0.1.0',
    platforms: {
      codex: {
        projectScopes: {
          [projectKey]: {
            managed: true,
            updatedAt: '2026-04-30T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: false,
              hasRepoManagedArtifacts: true,
              projectManagedKinds: options.managedKinds,
            },
          },
        },
        sharedNativeRefs: {
          user: false,
          projects: [],
        },
      },
    },
  };
  await writeInstalledLedger(ledger, options.env);
  await upsertTrackingRecord(
    resolveCodexPaths(options.repoRoot, 'project', options.env).trackingDir,
    options.pluginName,
    options.artifacts,
  );
}

async function seedManagedInstructionEvidence(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
}): Promise<void> {
  const codexPaths = resolveCodexPaths(options.repoRoot, 'project', options.env);
  await upsertManagedDeveloperInstructionsFile(codexPaths.configTomlPath, {
    pluginName: options.pluginName,
    value: `## ${options.pluginName}\n\nmanaged instruction`,
  });
  await seedCodexProjectEvidence({
    repoRoot: options.repoRoot,
    env: options.env,
    pluginName: options.pluginName,
    managedKinds: ['instruction'],
    artifacts: [{
      path: codexPaths.configTomlPath,
      kind: 'instruction',
      platform: 'codex',
    }],
  });
}

async function seedManagedSkillEvidence(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  skillName: string;
}): Promise<void> {
  const skillDir = path.join(options.repoRoot, '.agents', 'skills', options.skillName);
  await fs.outputFile(path.join(skillDir, 'SKILL.md'), `# ${options.skillName}\n`, 'utf8');
  await seedCodexProjectEvidence({
    repoRoot: options.repoRoot,
    env: options.env,
    pluginName: options.pluginName,
    managedKinds: ['skill'],
    artifacts: [{
      path: skillDir,
      kind: 'skill',
      platform: 'codex',
      artifactKey: options.skillName,
    }],
  });
}

function repoSkillRoot(repoRoot: string, skillName: string): string {
  return path.join(repoRoot, '.agents', 'skills', skillName);
}

async function readRepoSkillAllowImplicitInvocation(
  repoRoot: string,
  skillName: string,
): Promise<boolean> {
  const parsed = YAML.parse(
    await fs.readFile(path.join(repoSkillRoot(repoRoot, skillName), 'agents', 'openai.yaml'), 'utf8'),
  ) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

async function seedCodexRoleAlias(options: {
  configPath: string;
  tableKey: string;
  roleFileRelativePath: string;
  roleName: string;
  description?: string;
}): Promise<void> {
  await fs.outputFile(
    options.configPath,
    [
      `[agents.${options.tableKey}]`,
      `description = ${JSON.stringify(options.description ?? `${options.tableKey} alias`)}`,
      `config_file = ${JSON.stringify(options.roleFileRelativePath)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.outputFile(
    path.join(path.dirname(options.configPath), options.roleFileRelativePath),
    [
      `name = ${JSON.stringify(options.roleName)}`,
      'description = "Role layer"',
      'developer_instructions = "Explore code"',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function seedCodexRoleFile(options: {
  configPath: string;
  roleFileRelativePath: string;
  roleName: string;
}): Promise<void> {
  await fs.ensureFile(options.configPath);
  await fs.outputFile(
    path.join(path.dirname(options.configPath), options.roleFileRelativePath),
    [
      `name = ${JSON.stringify(options.roleName)}`,
      'description = "Loose role"',
      'developer_instructions = "Explore code"',
      '',
    ].join('\n'),
    'utf8',
  );
}

class RecordingAdapter implements PlatformAdapter {
  readonly installExtensionsCalls: string[] = [];
  private readonly installed = new Set<string>();

  constructor(
    readonly name: PlatformName,
    private readonly repoRoot: string,
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(): Promise<void> {}

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    this.installExtensionsCalls.push(`${plugin.manifest.name}:${scope}`);
    this.installed.add(plugin.manifest.name);
    const artifactPath = path.join(
      this.repoRoot,
      this.name === 'codex' ? '.codex' : '.claude',
      `${plugin.manifest.name}.${this.name}.txt`,
    );
    await fs.outputFile(artifactPath, `${this.name}:${plugin.manifest.name}`, 'utf8');
    return [{
      path: artifactPath,
      kind: 'instruction',
      platform: this.name,
    }];
  }

  async uninstallExtensions(plugin: PluginMeta): Promise<void> {
    this.installed.delete(plugin.manifest.name);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const installed = this.installed.has(plugin.manifest.name);
    return {
      platform: this.name,
      scope,
      initialized: installed,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: false,
          pluginAvailable: true,
          pluginInstalled: false,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
        driftWarnings: [],
        scopeInitialized: installed ? 'yes' : 'no',
        catalogCompatibility: 'current',
        scopeManagedEvidence: {
          ledger: installed,
          tracking: installed,
          sharedNativeRef: false,
        },
        currentCatalog: {
          rootDir: '/synthetic',
          source: 'embedded',
          available: true,
        },
        artifactsInitialized: true,
        repoManagedSessionState: {
          instructions: 'not_applicable',
          rules: 'not_applicable',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      }],
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex project safety preflight', () => {
  it('fails install before config prompt when user Codex config is unreadable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'mcp-only'),
    });
    await writeCorruptedCodexUserConfig({ env: workspace.env });

    let configureCalls = 0;

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['mcp-only'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'codex',
          },
          {
            env: workspace.env,
            interactive: true,
            prompt: {
              configurePlugin: async () => {
                configureCalls += 1;
                return {
                  selectedScope: 'project',
                  updates: { token: 'should-not-write' },
                  updatedKeys: ['token'],
                  cancelled: false,
                };
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('无法可靠检查 external ownership');

    expect(configureCalls).toBe(0);
  });

  it('fails install before config prompt when external ownership is present', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'mcp-only'),
    });
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'mcp-only@third-party',
      { enabled: true },
    );

    let configureCalls = 0;

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['mcp-only'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'codex',
          },
          {
            env: workspace.env,
            interactive: true,
            prompt: {
              configurePlugin: async () => {
                configureCalls += 1;
                return {
                  selectedScope: 'project',
                  updates: { token: 'should-not-write' },
                  updatedKeys: ['token'],
                  cancelled: false,
                };
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('已启用外部同名插件');

    expect(configureCalls).toBe(0);
  });

  it('fails config-backed installs before config prompt when project Codex config is unreadable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['instructions-mcp'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'instructions-mcp'),
    });
    await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot });

    let configureCalls = 0;

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['instructions-mcp'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'codex',
          },
          {
            env: workspace.env,
            interactive: true,
            prompt: {
              configurePlugin: async () => {
                configureCalls += 1;
                return {
                  selectedScope: 'project',
                  updates: { token: 'should-not-write' },
                  updatedKeys: ['token'],
                  cancelled: false,
                };
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('项目级 Codex 配置');

    expect(configureCalls).toBe(0);
  });

  it('fails install before config prompt when static codex.agentRole roleKey conflicts in the user layer', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'dynamic-artifacts'),
    });
    await seedCodexRoleAlias({
      configPath: resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      tableKey: 'foo',
      roleFileRelativePath: 'agents/foo.toml',
      roleName: 'codex-explorer',
    });

    let configureCalls = 0;

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['dynamic-artifacts'],
          {
            cwd: workspace.repoRoot,
            scope: 'user',
            platform: 'codex',
          },
          {
            env: workspace.env,
            interactive: true,
            prompt: {
              configurePlugin: async () => {
                configureCalls += 1;
                return {
                  selectedScope: 'user',
                  updates: { token: 'should-not-write' },
                  updatedKeys: ['token'],
                  cancelled: false,
                };
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('最终 role 名为 "codex-explorer"');

    expect(configureCalls).toBe(0);
  });

  it('fails install on invalid dynamic artifact plans before any project writes, tracking, or ledger updates', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
      mutateRepo: async (repoRoot) => {
        await removeFixturePluginSkills(repoRoot, 'dynamic-artifacts');
        await writeFixtureArtifactRenderer(
          repoRoot,
          'dynamic-artifacts',
          renderInvalidDynamicArtifactsPlan(),
        );
      },
    });
    const events: Array<{ type: string }> = [];

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['dynamic-artifacts'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'codex',
          },
          {
            env: workspace.env,
            reporter: {
              event: async (event) => {
                events.push({ type: event.type });
              },
              notice: async () => {},
            },
            debugLogger: {
              log: async () => {},
            },
          },
        ),
      ),
    ).rejects.toThrow('renderer must return artifact "lightweight-instruction"');

    expect(events.map((event) => event.type)).toContain('artifacts:plan');
    expect(events.map((event) => event.type)).not.toContain('artifacts:written');
    expect(events.map((event) => event.type)).not.toContain('tracking:written');
    expect(events.map((event) => event.type)).not.toContain('ledger:written');
  });

  it('fails install before config prompt when an unmanaged MCP server with the same key already exists', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => {
        await addRequiredTokenConfig(repoRoot, 'mcp-only');
        const configPath = path.join(repoRoot, '.codex', 'config.toml');
        await fs.outputFile(
          configPath,
          upsertCodexMcpServer('', 'acme.tools v1', {
            command: 'foreign',
          }),
          'utf8',
        );
      },
    });

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        async () => {
          const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'mcp-only'));
          const target: ResolvedPluginTarget = {
            pluginName: 'mcp-only',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          };
          return preflightCodexProjectWriteSafety({
            targets: [target],
            platforms: ['codex'],
            cwd: workspace.repoRoot,
            scope: 'project',
            env: workspace.env,
            operation: 'install',
          });
        },
      ),
    ).rejects.toThrow('存在冲突');
  });

  it('fails install before config prompt when another plugin tracking record already owns the same MCP server key', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'mcp-only'),
    });
    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    await upsertTrackingRecord(codexPaths.trackingDir, 'other-plugin', [
      {
        path: codexPaths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
    ]);

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        async () => {
          const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'mcp-only'));
          const target: ResolvedPluginTarget = {
            pluginName: 'mcp-only',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          };
          return preflightCodexProjectWriteSafety({
            targets: [target],
            platforms: ['codex'],
            cwd: workspace.repoRoot,
            scope: 'project',
            env: workspace.env,
            operation: 'install',
          });
        },
      ),
    ).rejects.toThrow('other-plugin');
  });

  it('fails project role preflight when a table-key alias resolves to the target final role name', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
    });
    await seedCodexRoleAlias({
      configPath: resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).configTomlPath,
      tableKey: 'foo',
      roleFileRelativePath: 'agents/foo.toml',
      roleName: 'codex-explorer',
    });
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'dynamic-artifacts'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'dynamic-artifacts',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'install',
        }),
      ),
    ).rejects.toThrow('[agents.foo]');
  });

  it('fails project role preflight when an unreferenced role file exposes the target final role name', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
    });
    await seedCodexRoleFile({
      configPath: resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).configTomlPath,
      roleFileRelativePath: 'agents/nested/explorer.toml',
      roleName: 'codex-explorer',
    });
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'dynamic-artifacts'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'dynamic-artifacts',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'install',
        }),
      ),
    ).rejects.toThrow('agents/nested/explorer.toml');
  });

  it('allows same-name project roles when the existing role layer matches the stable AW-managed path', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
    });
    const projectConfigPath = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).configTomlPath;
    const managedRoleRelativePath = path.join(
      'agents',
      `${buildGeneratedName('dynamic-artifacts', 'codex-explorer')}.toml`,
    );
    await seedCodexRoleAlias({
      configPath: projectConfigPath,
      tableKey: 'foo',
      roleFileRelativePath: managedRoleRelativePath,
      roleName: 'codex-explorer',
      description: 'Managed alias',
    });
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'dynamic-artifacts'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'dynamic-artifacts',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'install',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not block skills-only installs on unrelated broken project Codex config', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot });

    await expect(
      installCommand(
        ['skills-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: workspace.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['skills-only'],
    });
  });

  it('fails write preflight when tracking-only dynamic Codex role needs project config access', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    const roleKey = 'codex-explorer';
    const rolePath = path.join(
      codexPaths.configDir,
      'agents',
      `${buildGeneratedName('skills-only', roleKey)}.toml`,
    );
    await upsertTrackingRecord(codexPaths.trackingDir, 'skills-only', [{
      path: rolePath,
      paths: [codexPaths.configTomlPath, rolePath],
      kind: 'agent',
      platform: 'codex',
      artifactKey: roleKey,
      id: 'codex-explorer-role',
      target: 'codex.agentRole',
      state: 'present',
      roleKey,
    }]);
    await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot });
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'skills-only'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'skills-only',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'refresh',
        }),
      ),
    ).rejects.toThrow('项目级 Codex 配置');
  });

  it('installs repo-managed skills into .agents/skills with project-local trigger materialization', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });

    await expect(
      installCommand(
        ['skills-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          env: workspace.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['skills-only'],
    });

    const trackedSkillPath = repoSkillRoot(workspace.repoRoot, 'repo-check');
    await expect(fs.pathExists(path.join(trackedSkillPath, 'SKILL.md'))).resolves.toBe(true);
    await expect(readRepoSkillAllowImplicitInvocation(workspace.repoRoot, 'repo-check')).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(workspace.env.AW_HOME!, 'plugins', 'skills-only')),
    ).resolves.toBe(false);
    await expect(
      readTrackingManifest(resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir),
    ).resolves.toMatchObject({
      plugins: {
        'skills-only': {
          artifacts: [{
            path: trackedSkillPath,
            kind: 'skill',
            platform: 'codex',
            artifactKey: 'repo-check',
          }],
        },
      },
    });
  });

  it('fails fast when an unmanaged repo skill directory already exists', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    await fs.outputFile(
      path.join(repoSkillRoot(workspace.repoRoot, 'repo-check'), 'SKILL.md'),
      '# unmanaged\n',
      'utf8',
    );
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'skills-only'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'skills-only',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'install',
        }),
      ),
    ).rejects.toThrow('repo skill "repo-check"');
  });

  it('fails fast when another plugin already tracks the same repo skill', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    const trackedSkillPath = repoSkillRoot(workspace.repoRoot, 'repo-check');
    await upsertTrackingRecord(
      resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir,
      'other-plugin',
      [{
        path: trackedSkillPath,
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'repo-check',
      }],
    );
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'skills-only'));

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => preflightCodexProjectWriteSafety({
          targets: [{
            pluginName: 'skills-only',
            plugin,
            currentPlugin: plugin,
            source: 'currentCatalog',
          }],
          platforms: ['codex'],
          cwd: workspace.repoRoot,
          scope: 'project',
          env: workspace.env,
          operation: 'install',
        }),
      ),
    ).rejects.toThrow('other-plugin');
  });

  it('keeps slashCommands-generated repo skills manual-only and allows fixed-target refresh without ledger preferences', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['slashCommands-only'],
    });

    await expect(
      installCommand(
        ['slash-commands-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'auto',
        },
        {
          env: workspace.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['slash-commands-only'],
    });

    const reviewSkillRoot = repoSkillRoot(workspace.repoRoot, 'review');
    await expect(fs.pathExists(path.join(reviewSkillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(reviewSkillRoot, 'assets', 'review-16.svg'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(reviewSkillRoot, 'assets', 'review-64.svg'))).resolves.toBe(true);
    await expect(readRepoSkillAllowImplicitInvocation(workspace.repoRoot, 'review')).resolves.toBe(false);

    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    await expect(
      installCommand(
        ['slash-commands-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: workspace.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['slash-commands-only'],
    });
    await expect(readRepoSkillAllowImplicitInvocation(workspace.repoRoot, 'review')).resolves.toBe(false);
  });

  it('rolls back repo skill directories when tracking or ledger writes fail after materialization', async () => {
    const trackingFailure = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    vi.spyOn(trackingModule, 'writeTrackingManifest').mockRejectedValueOnce(new Error('tracking write failed'));

    await expect(
      installCommand(
        ['skills-only'],
        {
          cwd: trackingFailure.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          env: trackingFailure.env,
        },
      ),
    ).rejects.toThrow('tracking write failed');
    await expect(fs.pathExists(repoSkillRoot(trackingFailure.repoRoot, 'repo-check'))).resolves.toBe(false);

    vi.restoreAllMocks();

    const ledgerFailure = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    const writeInstalledLedgerImpl = localMarketplaceModule.writeInstalledLedger;
    let failedOnce = false;
    vi.spyOn(localMarketplaceModule, 'writeInstalledLedger').mockImplementation(async (ledger, env) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('ledger write failed');
      }
      return writeInstalledLedgerImpl(ledger, env);
    });

    await expect(
      installCommand(
        ['skills-only'],
        {
          cwd: ledgerFailure.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          env: ledgerFailure.env,
        },
      ),
    ).rejects.toThrow('ledger write failed');
    await expect(fs.pathExists(repoSkillRoot(ledgerFailure.repoRoot, 'repo-check'))).resolves.toBe(false);
  });

  it('fails explicit upgrade before config prompt when tracking identity is broken', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'skills-only'),
      forceCodex: false,
    });
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['skills-only'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-30T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: false,
                hasRepoManagedArtifacts: true,
                projectManagedKinds: ['skill'],
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, workspace.env);
    await writeTrackingManifestWithMissingArtifactKey({
      repoRoot: workspace.repoRoot,
      pluginName: 'skills-only',
      platform: 'codex',
      artifactKind: 'skill',
      artifactPath: path.join(workspace.repoRoot, '.agents', 'skills', 'repo-check'),
    });

    let configureCalls = 0;

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => upgradeCommand(
          ['skills-only'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'codex',
          },
          {
            env: workspace.env,
            interactive: true,
            prompt: {
              configurePlugin: async () => {
                configureCalls += 1;
                return {
                  selectedScope: 'project',
                  updates: { token: 'should-not-write' },
                  updatedKeys: ['token'],
                  cancelled: false,
                };
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('tracking identity 已损坏');

    expect(configureCalls).toBe(0);
  });

  it('fails upgrade on invalid dynamic artifact plans before any project writes, tracking, or ledger updates', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
      mutateRepo: async (repoRoot) => {
        await removeFixturePluginSkills(repoRoot, 'dynamic-artifacts');
        await writeFixtureArtifactRenderer(
          repoRoot,
          'dynamic-artifacts',
          renderValidDynamicArtifactsPlan(),
        );
      },
    });

    await installCommand(
      ['dynamic-artifacts'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );

    await writeFixtureArtifactRenderer(
      workspace.repoRoot,
      'dynamic-artifacts',
      renderInvalidDynamicArtifactsPlan(),
    );
    await rebuildEmbeddedRootForWorkspace(workspace.repoRoot);
    const events: Array<{ type: string }> = [];

    await expect(
      upgradeCommand(
        ['dynamic-artifacts'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: workspace.env,
          reporter: {
            event: async (event) => {
              events.push({ type: event.type });
            },
            notice: async () => {},
          },
          debugLogger: {
            log: async () => {},
          },
        },
      ),
    ).rejects.toThrow('renderer must return artifact "lightweight-instruction"');

    expect(events.map((event) => event.type)).toContain('artifacts:plan');
    expect(events.map((event) => event.type)).not.toContain('artifacts:written');
    expect(events.map((event) => event.type)).not.toContain('tracking:written');
    expect(events.map((event) => event.type)).not.toContain('ledger:written');
  });

  it('prompts required config only once for mixed project installs after safety preflight passes', async () => {
    const workspace = await makeRepoTemplateWorkspace({
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'git-commit'),
    });
    const codex = new RecordingAdapter('codex', workspace.repoRoot);
    const claude = new RecordingAdapter('claude', workspace.repoRoot);
    const configureCalls: Array<{ pluginName: string; allowedScopes: string[] }> = [];

    const result = await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'both',
      },
      {
        env: workspace.env,
        interactive: true,
        prompt: {
          configurePlugin: async (options) => {
            configureCalls.push({
              pluginName: options.pluginName,
              allowedScopes: options.allowedScopes,
            });
            return {
              selectedScope: 'project',
              updates: { token: 'shared-secret' },
              updatedKeys: ['token'],
              cancelled: false,
            };
          },
        },
        adapters: { codex, claude },
      },
    );

    expect(result.platforms).toEqual(['codex', 'claude']);
    expect(configureCalls).toEqual([{
      pluginName: 'git-commit',
      allowedScopes: ['user', 'project'],
    }]);
    await expect(
      fs.readJson(path.join(workspace.repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json')),
    ).resolves.toEqual({
      token: 'shared-secret',
    });
  });

  it('allows project uninstall to continue when user Codex config is unreadable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['instructions-mcp'],
      forceCodex: false,
    });
    await seedManagedInstructionEvidence({
      repoRoot: workspace.repoRoot,
      env: workspace.env,
      pluginName: 'instructions-mcp',
    });
    await writeCorruptedCodexUserConfig({ env: workspace.env });

    const result = await uninstallCommand(
      ['instructions-mcp'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );

    expect(result.warnings.join('\n')).toContain('unknown 处理');
    await expect(readTrackingManifest(resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir))
      .resolves.toMatchObject({ plugins: {} });
    await expect(readCodexConfigFile(resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).configTomlPath))
      .resolves.toMatchObject({
        snapshot: {
          developerInstructions: {
            managedBlocks: {},
          },
        },
      });
  });

  it('allows project uninstall to continue when external ownership is present', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['instructions-mcp'],
      forceCodex: false,
    });
    await seedManagedInstructionEvidence({
      repoRoot: workspace.repoRoot,
      env: workspace.env,
      pluginName: 'instructions-mcp',
    });
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'instructions-mcp@third-party',
      { enabled: true },
    );

    const result = await uninstallCommand(
      ['instructions-mcp'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );

    expect(result.warnings.join('\n')).toContain('外部同名插件');
    await expect(readTrackingManifest(resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir))
      .resolves.toMatchObject({ plugins: {} });
  });

  it('reports skills-only project status instead of failing when user Codex config is unreadable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      forceCodex: false,
    });
    await seedManagedSkillEvidence({
      repoRoot: workspace.repoRoot,
      env: workspace.env,
      pluginName: 'skills-only',
      skillName: 'repo-check',
    });
    await writeCorruptedCodexUserConfig({ env: workspace.env });

    const result = await statusCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: workspace.env,
      },
    );

    expect(result.matrix.cells[0]).toMatchObject({
      pluginName: 'skills-only',
      health: 'unknown',
      report: {
        externalOwnership: {
          checkState: 'unknown',
        },
        repoManagedSessionState: {
          skills: {
            state: 'visible',
          },
          mcpServers: {
            state: 'not_applicable',
          },
        },
      },
    });
  });

  it('keeps skills-only project status ready when project trust is not applicable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      forceCodex: false,
    });

    await installCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );

    const result = await statusCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: workspace.env,
      },
    );

    expect(result.matrix.cells[0]).toMatchObject({
      health: 'ready',
      report: {
        projectTrust: 'not_applicable',
        repoManagedSessionState: {
          skills: {
            state: 'visible',
            visibleCount: 1,
          },
          mcpServers: {
            state: 'not_applicable',
            totalCount: 0,
          },
        },
      },
    });
    expect(result.matrix.summaries[0].nextSteps).toEqual(['查看详情：aw status skills-only --verbose']);
  });

  it('marks repo-managed project status as needsAttention when external ownership conflicts with repo evidence', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      forceCodex: false,
    });

    await installCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'skills-only@third-party',
      { enabled: true },
    );

    const result = await statusCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: workspace.env,
      },
    );

    expect(result.matrix.cells[0]).toMatchObject({
      health: 'needsAttention',
      report: {
        externalOwnership: {
          present: true,
          checkState: 'known',
        },
        repoManagedSessionState: {
          skills: {
            state: 'visible',
          },
        },
      },
    });
  });

  it('reports repo-managed mcp summaries and items with quoted artifact keys', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['multi-mcp'],
      forceCodex: false,
    });
    await fs.outputFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      `[projects.${JSON.stringify(workspace.repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    await installCommand(
      ['multi-mcp'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: workspace.env,
      },
    );

    const projectConfigPath = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).configTomlPath;
    const currentConfig = await fs.readFile(projectConfigPath, 'utf8');
    await fs.writeFile(
      projectConfigPath,
      removeCodexMcpServer(currentConfig, 'acme.tools v1'),
      'utf8',
    );

    const result = await statusCommand(
      ['multi-mcp'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: workspace.env,
      },
    );
    const report = result.reports[0].plugins[0];

    expect(result.matrix.cells[0].health).toBe('needsAttention');
    expect(report.repoManagedSessionState?.mcpServers).toMatchObject({
      state: 'missing',
      totalCount: 3,
      visibleCount: 2,
      missingCount: 1,
    });
    expect(report.repoManagedSessionState?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mcpServer',
          artifactKey: 'acme.tools v1',
          state: 'missing',
          exists: false,
          tracked: true,
        }),
        expect.objectContaining({
          kind: 'mcpServer',
          artifactKey: 'sibling-server',
          state: 'visible',
          exists: true,
          tracked: true,
        }),
        expect.objectContaining({
          kind: 'mcpServer',
          artifactKey: 'nested/object server',
          state: 'visible',
          exists: true,
          tracked: true,
        }),
      ]),
    );
  });

  it('reads project config for status when tracking only contains a dynamic Codex role', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      forceCodex: false,
    });
    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    const roleKey = 'codex-explorer';
    const rolePath = path.join(
      codexPaths.configDir,
      'agents',
      `${buildGeneratedName('skills-only', roleKey)}.toml`,
    );
    await seedCodexRoleAlias({
      configPath: codexPaths.configTomlPath,
      tableKey: roleKey,
      roleFileRelativePath: path.relative(codexPaths.configDir, rolePath),
      roleName: roleKey,
      description: 'Role layer',
    });
    await upsertTrackingRecord(codexPaths.trackingDir, 'skills-only', [{
      path: rolePath,
      paths: [codexPaths.configTomlPath, rolePath],
      kind: 'agent',
      platform: 'codex',
      artifactKey: roleKey,
      id: 'codex-explorer-role',
      target: 'codex.agentRole',
      state: 'present',
      roleKey,
    }]);

    const result = await statusCommand(
      ['skills-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: workspace.env,
      },
    );
    const report = result.reports[0].plugins[0];
    const roleArtifact = report.managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role');

    expect(roleArtifact).toMatchObject({
      target: 'codex.agentRole',
      roleKey,
      health: 'healthy',
    });
  });

  it('fails status for config-backed project targets when project Codex config is unreadable', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['instructions-mcp'],
      forceCodex: false,
    });
    await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot });

    await expect(
      statusCommand(
        ['instructions-mcp'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: workspace.env,
        },
      ),
    ).rejects.toThrow('项目级 Codex 配置');
  });
});
