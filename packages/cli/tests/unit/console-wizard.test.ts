import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInstallWizardDecision,
  createResolvedInstallOptionEntry,
  executeInstallWizardDecision,
  prepareConsoleWritePreflight,
  resolveConsoleRequiredConfigPrompts,
  resolveConsoleWriteActionPlan,
} from '../../src/commands/console-wizard.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import * as skillTriggerModule from '../../src/utils/skill-trigger-preferences.js';
import {
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
import { resolveEffectivePluginConfig } from '../../src/utils/plugin-config.js';
import { applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import type {
  EnvironmentDetection,
  PluginManifestSource,
  PluginMeta,
  ResolvedInstallOptions,
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
  forceCodex?: boolean;
}): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-console-wizard-'));
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
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      ...(options.forceCodex === false ? {} : { AW_FORCE_CODEX_AVAILABLE: '1' }),
      PATH: '',
    },
  };
}

async function makeRepoTemplateWorkspace(options: {
  mutateRepo?: (repoRoot: string) => Promise<void>;
} = {}): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-console-wizard-template-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await options.mutateRepo?.(repoRoot);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
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

async function seedCodexRoleAlias(options: {
  configPath: string;
  tableKey: string;
  roleFileRelativePath: string;
  roleName: string;
}): Promise<void> {
  await fs.outputFile(
    options.configPath,
    [
      `[agents.${options.tableKey}]`,
      `description = ${JSON.stringify(`${options.tableKey} alias`)}`,
      `config_file = ${JSON.stringify(options.roleFileRelativePath)}`,
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.outputFile(
    path.join(path.dirname(options.configPath), options.roleFileRelativePath),
    [
      `name = ${JSON.stringify(options.roleName)}`,
      'description = "Foreign role"',
      'developer_instructions = "Inspect the repo."',
      '',
    ].join('\n'),
    'utf8',
  );
}

function repoSkillRoot(repoRoot: string, skillName: string): string {
  return path.join(repoRoot, '.agents', 'skills', skillName);
}

function syntheticPlugin(options: {
  name?: string;
  apps?: string;
  config?: PluginManifestSource['config'];
  skillTriggers?: PluginManifestSource['skillTriggers'];
} = {}): PluginMeta {
  return {
    rootDir: '/synthetic/plugin',
    manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: options.name ?? 'demo-plugin',
      version: '1.0.0',
      description: 'demo',
      apps: options.apps,
      skillTriggers: options.skillTriggers,
      config: options.config,
      marketplace: {
        category: 'demo',
        strict: false,
        policy: {
          installation: 'manual',
          authentication: 'none',
        },
      },
    },
  };
}

function target(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    source: 'currentCatalog',
  };
}

async function readTarget(repoRoot: string, pluginName: string): Promise<ResolvedPluginTarget> {
  const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', pluginName));
  return target(plugin);
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('console write decision model', () => {
  it('blocks before required config resolution and command execution when read-only preflight fails', async () => {
    const plugin = syntheticPlugin({
      config: {
        schema: {
          token: {
            type: 'string',
            required: true,
          },
        },
      },
    });
    const configResolver = vi.fn(async () => []);
    const decision = await createInstallWizardDecision({
      intent: 'install',
      targets: [target(plugin)],
      platforms: ['codex'],
      cwd: '/workspace',
      scope: 'project',
      preparePreflight: async () => ({
        ok: false,
        operation: 'install',
        blockedReason: {
          code: 'externalOwnership',
          message: 'blocked',
          nextSteps: ['fix ownership'],
        },
        nextSteps: ['fix ownership'],
        notes: [],
      }),
      resolveRequiredConfigPrompts: configResolver,
    });

    expect(decision.blockedReason?.code).toBe('externalOwnership');
    expect(decision.shouldPromptConfig).toBe(false);
    expect(configResolver).not.toHaveBeenCalled();

    const promptRequiredConfig = vi.fn(async () => {});
    const runCommand = vi.fn(async () => 'written');
    const executed = await executeInstallWizardDecision({
      decision,
      promptRequiredConfig,
      runCommand,
    });

    expect(executed.blocked).toBe(true);
    expect(promptRequiredConfig).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps skill trigger metadata hidden in the wizard even for overridable targets', async () => {
    const plugin = syntheticPlugin();
    const decision = await createInstallWizardDecision({
      intent: 'install',
      targets: [target(plugin)],
      platforms: ['codex'],
      cwd: '/workspace',
      scope: 'project',
      resolvedInstallOptions: [
        createResolvedInstallOptionEntry('codex', plugin, {
          applicability: 'overridable',
          ledgerTrust: 'available',
          skillTriggerPreference: 'manual',
          skillTriggerSource: 'default',
        }),
      ],
      preparePreflight: async () => ({
        ok: true,
        operation: 'install',
        nextSteps: [],
        notes: [],
      }),
      resolveRequiredConfigPrompts: async () => [],
    });

    expect(decision.skillTrigger.show).toBe(false);
    expect(decision.skillTrigger.selected).toBe('manual');
    expect(decision.skillTrigger.options).toEqual([
      { value: 'default', label: '默认' },
      { value: 'manual', label: '手动' },
      { value: 'auto', label: '自动' },
    ]);

    const hidden = await createInstallWizardDecision({
      intent: 'install',
      targets: [target(plugin)],
      platforms: ['codex'],
      cwd: '/workspace',
      scope: 'project',
      resolvedInstallOptions: [
        createResolvedInstallOptionEntry('codex', plugin, {
          applicability: 'fixed',
          ledgerTrust: 'available',
        } as ResolvedInstallOptions),
      ],
      preparePreflight: async () => ({
        ok: true,
        operation: 'install',
        nextSteps: [],
        notes: [],
      }),
      resolveRequiredConfigPrompts: async () => [],
    });

    expect(hidden.skillTrigger.show).toBe(false);
  });

  it('deduplicates mixed-target required config prompts and only produces one form', async () => {
    const workspace = await makeRepoTemplateWorkspace({
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'git-commit'),
    });
    const gitCommit = await readTarget(workspace.repoRoot, 'git-commit');

    const prompts = await resolveConsoleRequiredConfigPrompts({
      targets: [gitCommit, { ...gitCommit }],
      cwd: workspace.repoRoot,
      defaultScope: 'project',
      env: workspace.env,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].pluginName).toBe('git-commit');
    expect(prompts[0].form.allowedScopes).toEqual(['project']);
    expect(prompts[0].form.requiredKeys).toEqual(['token']);
  });

  it('splits same-store required config prompts when form identity differs across platforms', async () => {
    const plugin = syntheticPlugin({
      config: {
        schema: {
          token: {
            type: 'string',
            required: true,
          },
        },
      },
    });
    vi.spyOn(skillTriggerModule, 'resolveSkillTriggerConfigEntries').mockResolvedValue([
      {
        skillName: 'commit',
        defaultTrigger: 'auto',
        allowDynamicTrigger: true,
        source: 'declared',
        platforms: ['codex', 'claude'],
      },
      {
        skillName: 'review',
        defaultTrigger: 'manual',
        allowDynamicTrigger: true,
        source: 'declared',
        platforms: ['codex'],
      },
    ] as never);

    const prompts = await resolveConsoleRequiredConfigPrompts({
      scopedTargets: [
        {
          target: target(plugin),
          platform: 'codex',
          scope: 'user',
          requested: true,
        },
        {
          target: target(plugin),
          platform: 'claude',
          scope: 'user',
          requested: true,
        },
      ],
      cwd: '/workspace',
      defaultScope: 'user',
      env: {} as NodeJS.ProcessEnv,
    });

    expect(prompts).toHaveLength(2);
    expect(new Set(prompts.map((prompt) => prompt.formIdentity)).size).toBe(2);
  });

  it('prompts mixed-target required config once before running the command with re-resolved config', async () => {
    const workspace = await makeRepoTemplateWorkspace({
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'git-commit'),
    });
    const gitCommit = await readTarget(workspace.repoRoot, 'git-commit');

    const decision = await createInstallWizardDecision({
      intent: 'install',
      targets: [gitCommit, { ...gitCommit }],
      platforms: ['codex', 'claude'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
      preparePreflight: async () => ({
        ok: true,
        operation: 'install',
        nextSteps: [],
        notes: [],
      }),
    });

    expect(decision.shouldPromptConfig).toBe(true);
    expect(decision.configPrompts).toHaveLength(1);

    const promptRequiredConfig = vi.fn(async () => {
      await applyPluginConfigWrite({
        plugin: gitCommit.plugin,
        pluginName: 'git-commit',
        scope: 'project',
        cwd: workspace.repoRoot,
        env: workspace.env,
        request: {
          updates: {
            token: 'shared-secret',
          },
        },
      });
    });
    const runCommand = vi.fn(async () => {
      const effective = await resolveEffectivePluginConfig({
        pluginName: 'git-commit',
        manifest: gitCommit.plugin.manifest,
        cwd: workspace.repoRoot,
        env: workspace.env,
      });
      return effective.values.token;
    });

    const result = await executeInstallWizardDecision({
      decision,
      promptRequiredConfig,
      runCommand,
    });

    expect(result.blocked).toBe(false);
    expect(result.promptedConfig).toBe(true);
    expect(promptRequiredConfig).toHaveBeenCalledTimes(1);
    expect(promptRequiredConfig).toHaveBeenCalledWith(decision.configPrompts);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.commandResult).toBe('shared-secret');
  });

  it('returns a friendly unsupported-project reason and never enters config resolution', async () => {
    const workspace = await makeRepoTemplateWorkspace();
    const gitCommit = await readTarget(workspace.repoRoot, 'git-commit');
    const configResolver = vi.fn(async () => []);

    const decision = await runWithZeroWriteSnapshot(
      {
        repoRoot: workspace.repoRoot,
        env: workspace.env,
      },
      () => createInstallWizardDecision({
        intent: 'install',
        targets: [gitCommit],
        platforms: ['codex'],
        cwd: workspace.repoRoot,
        scope: 'project',
        env: workspace.env,
        resolveRequiredConfigPrompts: configResolver,
      }),
    );

    expect(decision.blockedReason?.code).toBe('unsupportedProjectTarget');
    expect(decision.nextSteps.join('\n')).toContain('个人位置');
    expect(configResolver).not.toHaveBeenCalled();
  });

  it('keeps Codex project targets available without native and explains that the write stays project-local', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
      forceCodex: false,
    });
    const detection: EnvironmentDetection = {
      codex: {
        available: false,
        scopes: [],
        reason: 'native missing',
      },
      claude: {
        available: false,
        scopes: [],
        reason: 'native missing',
      },
    };

    const result = await prepareConsoleWritePreflight({
      intent: 'install',
      targets: [await readTarget(workspace.repoRoot, 'skills-only')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
      detection,
    });

    expect(result.ok).toBe(true);
    expect(result.notes).toContain('当前环境没有可用的 Codex native runner，但这个目标只会写当前项目文件，所以仍然可以继续。');
  });

  it('maps unreadable user Codex config to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'mcp-only'),
    });
    await writeCorruptedCodexUserConfig({ env: workspace.env });

    const result = await runWithZeroWriteSnapshot(
      {
        repoRoot: workspace.repoRoot,
        env: workspace.env,
      },
      async () => prepareConsoleWritePreflight({
        intent: 'install',
        targets: [await readTarget(workspace.repoRoot, 'mcp-only')],
        platforms: ['codex'],
        cwd: workspace.repoRoot,
        scope: 'project',
        env: workspace.env,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('userCodexConfigUnreadable');
    expect(result.nextSteps[0]).toContain('用户级 Codex 配置');
  });

  it('maps unreadable project Codex config to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['instructions-mcp'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'instructions-mcp'),
    });
    await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot });

    const result = await prepareConsoleWritePreflight({
      intent: 'install',
      targets: [await readTarget(workspace.repoRoot, 'instructions-mcp')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('projectCodexConfigUnreadable');
  });

  it('maps external ownership to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['mcp-only'],
      mutateRepo: async (repoRoot) => addRequiredTokenConfig(repoRoot, 'mcp-only'),
    });
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'mcp-only@third-party',
      { enabled: true },
    );

    const result = await prepareConsoleWritePreflight({
      intent: 'install',
      targets: [await readTarget(workspace.repoRoot, 'mcp-only')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('externalOwnership');
  });

  it('maps tracking identity damage to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    await writeTrackingManifestWithMissingArtifactKey({
      repoRoot: workspace.repoRoot,
      pluginName: 'skills-only',
      platform: 'codex',
      artifactKind: 'skill',
      artifactPath: path.join(workspace.repoRoot, '.agents', 'skills', 'repo-check'),
    });

    const result = await prepareConsoleWritePreflight({
      intent: 'upgrade',
      targets: [await readTarget(workspace.repoRoot, 'skills-only')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('trackingIdentityBroken');
  });

  it('maps role conflicts to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['dynamic-artifacts'],
    });
    await seedCodexRoleAlias({
      configPath: resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      tableKey: 'foo',
      roleFileRelativePath: 'agents/foo.toml',
      roleName: 'codex-explorer',
    });

    const result = await prepareConsoleWritePreflight({
      intent: 'install',
      targets: [await readTarget(workspace.repoRoot, 'dynamic-artifacts')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'user',
      env: workspace.env,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('roleOrMcpConflict');
  });

  it('maps unmanaged artifact conflicts to a structured blocked reason', async () => {
    const workspace = await makeCodexWorkspace({
      pluginDirs: ['skills-only'],
    });
    await fs.outputFile(
      path.join(repoSkillRoot(workspace.repoRoot, 'repo-check'), 'SKILL.md'),
      '# unmanaged\n',
      'utf8',
    );

    const result = await prepareConsoleWritePreflight({
      intent: 'install',
      targets: [await readTarget(workspace.repoRoot, 'skills-only')],
      platforms: ['codex'],
      cwd: workspace.repoRoot,
      scope: 'project',
      env: workspace.env,
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason?.code).toBe('unmanagedArtifactConflict');
  });

  it('lets repairInstall reuse install or upgrade semantics and limits cleanupRecovery to matched evidence', () => {
    expect(resolveConsoleWriteActionPlan({
      intent: 'repairInstall',
      repairOperation: 'upgrade',
    })).toEqual({
      kind: 'wizardWrite',
      operation: 'upgrade',
      intent: 'repairInstall',
    });

    expect(resolveConsoleWriteActionPlan({
      intent: 'repairInstall',
      repairOperation: 'install',
    })).toEqual({
      kind: 'wizardWrite',
      operation: 'install',
      intent: 'repairInstall',
    });

    expect(resolveConsoleWriteActionPlan({
      intent: 'cleanupRecovery',
      cleanupRecoveryEvidenceMatches: true,
    })).toEqual({
      kind: 'directCommand',
      operation: 'uninstall',
      intent: 'cleanupRecovery',
    });

    const blocked = resolveConsoleWriteActionPlan({
      intent: 'cleanupRecovery',
      cleanupRecoveryEvidenceMatches: false,
    });
    expect('code' in blocked && blocked.code).toBe('cleanupRecoveryUnmatched');
  });
});
