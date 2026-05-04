import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import { readCodexConfigFile, upsertCodexMarketplaceFile } from '../../src/utils/codex-config.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { getTrackingManifestPath, readTrackingManifest } from '../../src/utils/tracking.js';
import type { NativeCliInvocation, NativeCliRunner } from '../../src/utils/native-cli.js';
import type { Scope } from '../../src/types.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { runWithZeroWriteSnapshot } from '../helpers/repo-managed-state.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function repoPluginPath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    ...segments,
  );
}

async function copyWorkspacePlugin(repoRoot: string, pluginName: string): Promise<void> {
  await fs.copy(
    repoPluginPath('plugins', pluginName),
    path.join(repoRoot, 'plugins', pluginName),
  );
}

async function rebuildEmbeddedRoot(repoRoot: string): Promise<string> {
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  return embeddedRoot;
}

async function mutateCodexExploreManifest(
  rootDir: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(rootDir, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  mutate(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function writeCodexExploreRenderer(rootDir: string, source: string): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, 'plugins', 'codex-explore', 'scripts', 'render-artifacts.mjs'),
    source,
    'utf8',
  );
}

async function writeRecordingCodexExploreRenderer(
  rootDir: string,
  options: {
    logFileName?: string;
    failScopes?: Scope[];
  } = {},
): Promise<void> {
  const logFileName = options.logFileName ?? 'artifact-render.log';
  const failScopes = options.failScopes ?? [];
  await writeCodexExploreRenderer(
    rootDir,
    `
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
await appendFile(
  path.join(context.paths.awHome, ${JSON.stringify(logFileName)}),
  \`\${context.event}:\${context.scope}\\n\`,
);

if (${JSON.stringify(failScopes)}.includes(context.scope)) {
  throw new Error(\`forced renderer failure for \${context.scope}\`);
}

const values = context.artifactRenderConfig?.values ?? {};
const enableLightweightInstruction = values.enableLightweightInstruction ?? true;
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

const plan = {
  version: 1,
  artifacts: [
    enableLightweightInstruction
      ? {
          id: 'lightweight-instruction',
          kind: 'instruction',
          platform: 'codex',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
          content: \`recorded instruction \${explorerModel} \${modelReasoningEffort}\`,
        }
      : {
          id: 'lightweight-instruction',
          kind: 'instruction',
          platform: 'codex',
          target: 'codex.developerInstructionsBlock',
          state: 'disabled',
          disabledReason: 'config',
          refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
        },
    {
      id: 'codex-explorer-role',
      kind: 'codexRole',
      platform: 'codex',
      target: 'codex.agentRole',
      state: 'present',
      roleKey: 'codex-explorer',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        registration: {
          description: 'Recorded explorer role.',
        },
        roleFile: {
          name: 'codex-explorer',
          description: 'Recorded explorer role.',
          developer_instructions: 'Recorded explorer role instructions.',
          model: explorerModel,
          model_reasoning_effort: modelReasoningEffort,
        },
      },
    },
  ],
};

process.stdout.write(\`\${JSON.stringify(plan, null, 2)}\\n\`);
`,
  );
}

async function writeCodexExploreLifecycleRecorder(rootDir: string, logFileName = 'lifecycle.log'): Promise<void> {
  await mutateCodexExploreManifest(rootDir, (manifest) => {
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
    scripts.lifecycle = {
      install: './scripts/lifecycle.mjs',
      upgrade: './scripts/lifecycle.mjs',
      uninstall: './scripts/lifecycle.mjs',
    };
    manifest.scripts = scripts;
  });
  await fs.writeFile(
    path.join(rootDir, 'plugins', 'codex-explore', 'scripts', 'lifecycle.mjs'),
    `
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
await appendFile(
  path.join(context.paths.awHome, ${JSON.stringify(logFileName)}),
  \`\${context.event}\\n\`,
);
`,
    'utf8',
  );
}

async function addRequiredTokenConfigToCodexExplore(rootDir: string): Promise<void> {
  await mutateCodexExploreManifest(rootDir, (manifest) => {
    manifest.config = {
      ...((manifest.config ?? {}) as Record<string, unknown>),
      schema: {
        ...(((manifest.config ?? {}) as { schema?: Record<string, unknown> }).schema ?? {}),
        token: {
          type: 'string',
          title: 'Token',
          required: true,
        },
      },
    };
  });
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

async function makeWorkspaceWithCodexExplore(): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-explore-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await copyWorkspacePlugin(repoRoot, 'codex-explore');

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    embeddedRoot,
  };
}

async function makeMultiRepoWorkspaceWithCodexExplore(): Promise<{
  repoA: string;
  repoB: string;
  awHome: string;
  codexHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-explore-multi-'));
  tempDirs.push(root);

  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  await fs.copy(fixturePath('repo-template'), repoA);
  await fs.copy(fixturePath('repo-template'), repoB);
  await copyWorkspacePlugin(repoA, 'codex-explore');
  await copyWorkspacePlugin(repoB, 'codex-explore');

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoA);
  tempDirs.push(embeddedRoot);

  return {
    repoA,
    repoB,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    embeddedRoot,
  };
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

function userSkillMetadataPath(awHome: string): string {
  return path.join(
    awHome,
    'plugins',
    'codex-explore',
    'codex',
    'skills',
    'codex-explore',
    'agents',
    'openai.yaml',
  );
}

function projectSkillMetadataPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    '.agents',
    'skills',
    'codex-explore',
    'agents',
    'openai.yaml',
  );
}

async function readAllowImplicitInvocation(filePath: string): Promise<boolean> {
  return (await fs.readFile(filePath, 'utf8')).includes('allow_implicit_invocation: true');
}

async function trustCodexProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  trustLevel: 'trusted' | 'untrusted',
): Promise<void> {
  const projectKey = await resolveCodexProjectKey(repoRoot);
  const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
  const existing = await fs.pathExists(configPath)
    ? await fs.readFile(configPath, 'utf8')
    : '';
  const projectBlock = [`[projects.${JSON.stringify(projectKey)}]`, `trust_level = "${trustLevel}"`].join('\n');
  const next = existing.includes(`[projects.${JSON.stringify(projectKey)}]`)
    ? existing.replace(
      new RegExp(`\\[projects\\.${JSON.stringify(projectKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?(?=\\n\\[|$)`),
      projectBlock,
    )
    : [existing.trimEnd(), projectBlock, ''].filter(Boolean).join('\n\n');
  await fs.outputFile(configPath, `${next.trimEnd()}\n`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('codex-explore integration acceptance', () => {
  it('installs Codex user scope with native enabled, lightweight instruction, and managed role artifacts', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'high',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });

    const nativeCalls: NativeCliInvocation[] = [];
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env, nativeCalls),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const config = await readCodexConfigFile(userPaths.configTomlPath);
    const rawConfig = await fs.readFile(userPaths.configTomlPath, 'utf8');
    const rolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const trackedArtifacts = (await readTrackingManifest(userPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];

    expect(nativeCalls).toHaveLength(1);
    expect(rawConfig).toContain('[plugins."codex-explore@aw"]');
    expect(rawConfig).toContain('enabled = true');
    expect(rawConfig).toContain('[agents.codex-explorer]');
    expect(await readAllowImplicitInvocation(userSkillMetadataPath(awHome))).toBe(false);
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      'Codex 内置 `explorer` role',
    );
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`model`: `gpt-5.4`',
    );
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `high`',
    );
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).not.toContain(
      'agent_type = "codex-explorer"',
    );
    expect(config.snapshot.agents['codex-explorer']).toEqual({
      key: 'codex-explorer',
      description: 'Read-only codebase exploration role for Codex Explore.',
      configFile: 'agents/aw-codex-explore-codex-explorer.toml',
    });
    expect(roleContent).toContain('name = "codex-explorer"');
    expect(roleContent).toContain('model = "gpt-5.4"');
    expect(roleContent).toContain('model_reasoning_effort = "high"');
    expect(trackedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: 'codex-explorer',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    ]));
  });

  it('uses only default+user render config for Codex user scope install and status, even when project config changes later', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4-mini',
        modelReasoningEffort: 'low',
      },
    });

    const result = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        env: process.env,
      },
    );
    const report = result.reports[0]?.plugins[0];
    const instructionArtifact = report?.managedArtifacts?.find((artifact) => artifact.id === 'lightweight-instruction');
    const roleArtifact = report?.managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role');

    expect(instructionArtifact).toMatchObject({
      state: 'present',
      health: 'healthy',
    });
    expect(instructionArtifact?.configDigest).toBe(instructionArtifact?.currentConfigDigest);
    expect(roleArtifact).toMatchObject({
      state: 'present',
      health: 'healthy',
      roleKey: 'codex-explorer',
    });
    expect(roleArtifact?.configDigest).toBe(roleArtifact?.currentConfigDigest);
    expect(roleArtifact?.health).not.toBe('configDigestStale');
  });

  it('installs Codex project scope with repo-managed skill and project-only artifacts without enabling the user native plugin', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });

    const nativeCalls: NativeCliInvocation[] = [];
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env, nativeCalls),
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectConfig = await readCodexConfigFile(projectPaths.configTomlPath);
    const projectRawConfig = await fs.readFile(projectPaths.configTomlPath, 'utf8');
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const skillPath = path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md');
    const skillMetadataPath = projectSkillMetadataPath(repoRoot);
    const skillContent = await fs.readFile(skillPath, 'utf8');
    const trackedArtifacts = (await readTrackingManifest(projectPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];

    expect(nativeCalls).toHaveLength(0);
    await expect(fs.pathExists(skillPath)).resolves.toBe(true);
    await expect(fs.pathExists(skillMetadataPath)).resolves.toBe(true);
    await expect(fs.readFile(skillMetadataPath, 'utf8')).resolves.toContain(
      'allow_implicit_invocation: false',
    );
    expect(skillContent).toContain('agent_type` 设为 `"codex-explorer"`');
    expect(skillContent).toContain('`close_agent` 关闭本 workflow 启动的 explorer');
    expect(projectRawConfig).toContain('[agents.codex-explorer]');
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      'Codex 内置 `explorer` role',
    );
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`model`: `gpt-5.5`',
    );
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `xhigh`',
    );
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).not.toContain(
      'agent_type = "codex-explorer"',
    );
    expect(roleContent).toContain('model = "gpt-5.5"');
    expect(roleContent).toContain('model_reasoning_effort = "xhigh"');
    expect(roleContent).toContain('name = "codex-explorer"');
    expect(trackedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'skill',
        artifactKey: 'codex-explore',
      }),
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        configDigest: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: 'codex-explorer',
        configDigest: expect.stringMatching(/^sha256:/),
      }),
    ]));

    if (await fs.pathExists(userPaths.configTomlPath)) {
      await expect(fs.readFile(userPaths.configTomlPath, 'utf8')).resolves.not.toContain(
        '[plugins."codex-explore@aw"]',
      );
    }
  });

  it('installs disabled lightweight instruction by removing the managed block and keeping status out of missing state', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        enableLightweightInstruction: false,
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'high',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        env: process.env,
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const [projectConfig, result] = await Promise.all([
      readCodexConfigFile(projectPaths.configTomlPath),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const plugin = result.reports[0]?.plugins[0];
    const instructionArtifact = plugin?.managedArtifacts?.find((artifact) => artifact.id === 'lightweight-instruction');

    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeUndefined();
    expect(instructionArtifact).toMatchObject({
      id: 'lightweight-instruction',
      state: 'disabled',
      health: 'disabledByConfig',
      disabledReason: 'config',
    });
    expect(plugin?.driftWarnings ?? []).not.toContain(
      'Codex instruction artifact "lightweight-instruction" 缺失。',
    );
  });

  it('upgrades a disabled rendered role by removing the managed registration and role layer while keeping status out of missing state', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await mutateCodexExploreManifest(repoRoot, (manifest) => {
      const targets = ((manifest.artifacts ?? {}) as { targets?: Array<Record<string, unknown>> }).targets ?? [];
      const roleTarget = targets.find((target) =>
        target.id === 'codex-explorer-role' && target.target === 'codex.agentRole',
      );
      if (!roleTarget) {
        throw new Error('missing codex-explorer-role target');
      }
      roleTarget.states = ['present', 'disabled'];
    });
    setEmbeddedPluginsRootOverrideForTests(await rebuildEmbeddedRoot(repoRoot));

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        env: process.env,
      },
    );

    await writeCodexExploreRenderer(
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
        '      content: "Recorded instruction after role disable"',
        '    },',
        '    {',
        '      id: "codex-explorer-role",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "disabled",',
        '      roleKey: "codex-explorer",',
        '      disabledReason: "config",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"]',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );
    setEmbeddedPluginsRootOverrideForTests(await rebuildEmbeddedRoot(repoRoot));

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        env: process.env,
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const [projectConfig, tracking, result] = await Promise.all([
      readCodexConfigFile(projectPaths.configTomlPath),
      readTrackingManifest(projectPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const plugin = result.reports[0]?.plugins[0];
    const roleArtifact = plugin?.managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role');

    expect(projectConfig.snapshot.agents['codex-explorer']).toBeUndefined();
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect(tracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      target: 'codex.agentRole',
      state: 'disabled',
      roleKey: 'codex-explorer',
      disabledReason: 'config',
      configDigest: expect.stringMatching(/^sha256:/),
      contentDigest: expect.stringMatching(/^sha256:/),
    });
    expect(roleArtifact).toMatchObject({
      id: 'codex-explorer-role',
      target: 'codex.agentRole',
      state: 'disabled',
      health: 'disabledByConfig',
      disabledReason: 'config',
    });
    expect(plugin?.driftWarnings ?? []).not.toContain(
      'Codex role artifact "codex-explorer" 缺失。',
    );
  });

  it('fails user install role preflight before config prompt, renderer, native enable, or any writes', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await addRequiredTokenConfigToCodexExplore(repoRoot);
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    await writeCodexExploreLifecycleRecorder(repoRoot, 'lifecycle.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await seedCodexRoleAlias({
      configPath: resolveCodexPaths(repoRoot, 'user', process.env).configTomlPath,
      tableKey: 'shadow',
      roleFileRelativePath: 'agents/shadow.toml',
      roleName: 'codex-explorer',
    });

    let configureCalls = 0;
    const nativeCalls: NativeCliInvocation[] = [];
    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot,
          env: process.env,
        },
        () => installCommand(
          ['codex-explore'],
          {
            cwd: repoRoot,
            scope: 'user',
            platform: 'codex',
            requestedSkillTrigger: 'auto',
          },
          {
            env: process.env,
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
            nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env, nativeCalls),
          },
        ),
      ),
    ).rejects.toThrow('最终 role 名为 "codex-explorer"');

    expect(configureCalls).toBe(0);
    expect(nativeCalls).toHaveLength(0);
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'lifecycle.log'))).resolves.toBe(false);
  });

  it('allows $codex-explore to become auto-triggerable only after explicit --skill-trigger auto install', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
    );

    expect(await readAllowImplicitInvocation(projectSkillMetadataPath(repoRoot))).toBe(true);

    const result = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: process.env,
      },
    );

    expect(result.reports[0]?.plugins[0]).toMatchObject({
      skillTriggerPreference: 'auto',
    });
  });

  it('reports artifact health, projectTrust, and session visibility in status JSON for Codex project scope', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const result = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: process.env,
      },
    );
    const payload = JSON.parse(result.output) as {
      reports: Array<{
        plugins: Array<{
          projectTrust?: string;
          managedArtifacts?: Array<{
            id?: string;
            health?: string;
            sessionVisibility?: string;
          }>;
        }>;
      }>;
    };
    const plugin = payload.reports[0]?.plugins[0];
    const roleArtifact = plugin?.managedArtifacts?.find((artifact) => artifact.id === 'codex-explorer-role');
    const instructionArtifact = plugin?.managedArtifacts?.find((artifact) => artifact.id === 'lightweight-instruction');

    expect(plugin?.projectTrust).toBe('unknown');
    expect(instructionArtifact).toMatchObject({
      health: 'healthy',
      sessionVisibility: 'projectTrustUnknown',
    });
    expect(roleArtifact).toMatchObject({
      health: 'healthy',
      sessionVisibility: 'projectTrustUnknown',
    });
  });

  it('explains invisible reasons in human verbose status for repo trust and higher-priority session layers', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const projectVerbose = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
      {
        env: process.env,
      },
    );

    expect(projectVerbose.output).toContain('当前 repo trust 状态未知');
    expect(projectVerbose.output).toContain('instruction 的 project scope 会话可见性暂时无法确定');
    expect(projectVerbose.output).toContain('role codex-explorer 的 project scope 会话可见性暂时无法确定');

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );
    await trustCodexProject(repoRoot, process.env, 'trusted');
    await fs.outputFile(
      path.join(repoRoot, '.codex', 'config.toml'),
      '[agents.shadow-alias]\ndescription = "Shadow alias"\nconfig_file = "agents/shadow.toml"\n',
    );
    await fs.outputFile(
      path.join(repoRoot, '.codex', 'agents', 'shadow.toml'),
      'name = "codex-explorer"\ndescription = "Shadow role"\ndeveloper_instructions = "shadow"\n',
    );

    const userVerbose = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      {
        env: process.env,
      },
    );

    expect(userVerbose.output).toContain('role:codex-explorer=healthy/unknownByExternalLayer');
    expect(userVerbose.output).toContain('role codex-explorer 的会话可见性无法可靠判断，因为更高优先级 layer 里存在可能覆盖它的同名配置');
  });

  it('uninstalls historical Codex project artifacts when tracking can recover roleKey from artifactKey', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const trackingManifest = await readTrackingManifest(projectPaths.trackingDir);
    const roleArtifact = trackingManifest.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    if (!roleArtifact) {
      throw new Error('missing codex-explorer-role tracking artifact');
    }
    delete roleArtifact.roleKey;
    await fs.writeJson(
      getTrackingManifestPath(projectPaths.trackingDir),
      trackingManifest,
      { spaces: 2 },
    );

    await fs.remove(path.join(repoRoot, 'plugins', 'codex-explore'));
    await rebuildEmbeddedRoot(repoRoot);

    await uninstallCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const projectConfig = await readCodexConfigFile(projectPaths.configTomlPath);
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const afterTracking = await readTrackingManifest(projectPaths.trackingDir);

    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeUndefined();
    expect(projectConfig.snapshot.agents['codex-explorer']).toBeUndefined();
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect(afterTracking.plugins['codex-explore']).toBeUndefined();
  });

  it('re-renders Codex user scope artifacts on upgrade using the latest default+user config, without reading project config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const beforeArtifacts = (await readTrackingManifest(userPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];
    const beforeInstructionDigest = beforeArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest;
    const beforeRoleDigest = beforeArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest;

    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'high',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4-mini',
        modelReasoningEffort: 'low',
      },
    });

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const config = await readCodexConfigFile(userPaths.configTomlPath);
    const rolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const afterArtifacts = (await readTrackingManifest(userPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];
    const afterInstructionDigest = afterArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest;
    const afterRoleDigest = afterArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest;

    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`model`: `gpt-5.5`');
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `high`');
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).not.toContain('gpt-5.4-mini');
    expect(roleContent).toContain('model = "gpt-5.5"');
    expect(roleContent).toContain('model_reasoning_effort = "high"');
    expect(roleContent).not.toContain('model_reasoning_effort = "low"');
    expect(afterInstructionDigest).not.toBe(beforeInstructionDigest);
    expect(afterRoleDigest).not.toBe(beforeRoleDigest);
  });

  it('fails user upgrade role preflight before config prompt, renderer, or any writes', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await addRequiredTokenConfigToCodexExplore(repoRoot);
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    await writeCodexExploreLifecycleRecorder(repoRoot, 'lifecycle.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        token: 'install-token',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    await fs.outputFile(
      path.join(userPaths.configDir, 'agents', 'shadow-role.toml'),
      'name = "codex-explorer"\ndescription = "shadow"\ndeveloper_instructions = "shadow"\n',
      'utf8',
    );
    await fs.appendFile(
      userPaths.configTomlPath,
      '\n[agents.shadow-alias]\ndescription = "Shadow alias"\nconfig_file = "agents/shadow-role.toml"\n',
      'utf8',
    );
    await fs.remove(path.join(awHome, 'artifact-render.log')).catch(() => undefined);
    await fs.remove(path.join(awHome, 'lifecycle.log')).catch(() => undefined);
    await fs.remove(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'));

    let configureCalls = 0;
    const nativeCalls: NativeCliInvocation[] = [];
    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot,
          env: process.env,
        },
        () => upgradeCommand(
          ['codex-explore'],
          {
            cwd: repoRoot,
            scope: 'user',
            platform: 'codex',
            requestedSkillTrigger: 'default',
          },
          {
            env: process.env,
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
            nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env, nativeCalls),
          },
        ),
      ),
    ).rejects.toThrow('最终 role 名为 "codex-explorer"');

    expect(configureCalls).toBe(0);
    expect(nativeCalls).toHaveLength(0);
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'lifecycle.log'))).resolves.toBe(false);
  });

  it('re-renders Codex project scope artifacts on upgrade using the latest default+user+project config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const beforeArtifacts = (await readTrackingManifest(projectPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];
    const beforeInstructionDigest = beforeArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest;
    const beforeRoleDigest = beforeArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest;

    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4-mini',
        modelReasoningEffort: 'low',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'high',
      },
    });

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
    );

    const config = await readCodexConfigFile(projectPaths.configTomlPath);
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const afterArtifacts = (await readTrackingManifest(projectPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];
    const afterInstructionDigest = afterArtifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest;
    const afterRoleDigest = afterArtifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest;

    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`model`: `gpt-5.5`');
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `high`');
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).not.toContain('`reasoning_effort`: `low`');
    expect(roleContent).toContain('model = "gpt-5.5"');
    expect(roleContent).toContain('model_reasoning_effort = "high"');
    expect(roleContent).not.toContain('model_reasoning_effort = "low"');
    expect(afterInstructionDigest).not.toBe(beforeInstructionDigest);
    expect(afterRoleDigest).not.toBe(beforeRoleDigest);
  });

  it('refreshes installed user and current-project Codex dynamic artifacts on user config writes', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'high',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'enableLightweightInstruction', 'false', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'user',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['enableLightweightInstruction'],
      },
    });

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const [userConfig, projectConfig, userTracking, projectTracking] = await Promise.all([
      readCodexConfigFile(userPaths.configTomlPath),
      readCodexConfigFile(projectPaths.configTomlPath),
      readTrackingManifest(userPaths.trackingDir),
      readTrackingManifest(projectPaths.trackingDir),
    ]);

    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeUndefined();
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeUndefined();
    await expect(fs.pathExists(path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'))).resolves.toBe(true);
    expect(userTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      state: 'disabled',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['enableLightweightInstruction'],
      },
      refreshReach: {
        commandScope: 'user',
        refreshedUserTarget: true,
        refreshedCurrentProjectTarget: true,
      },
    });
    expect(projectTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      state: 'disabled',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['enableLightweightInstruction'],
      },
      refreshReach: {
        commandScope: 'user',
        refreshedUserTarget: true,
        refreshedCurrentProjectTarget: true,
      },
    });
  });

  it('refreshes only current-project artifacts on project config writes and leaves user artifacts healthy', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const userTrackingBefore = await readTrackingManifest(userPaths.trackingDir);
    const userRoleBefore = await fs.readFile(
      path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'),
      'utf8',
    );

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '-s', 'project', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'project',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['modelReasoningEffort'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'project',
          }),
        ]),
      },
    });

    const [userConfig, projectConfig, userStatus, userTrackingAfter, projectRoleContent] = await Promise.all([
      readCodexConfigFile(userPaths.configTomlPath),
      readCodexConfigFile(projectPaths.configTomlPath),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
      readTrackingManifest(userPaths.trackingDir),
      fs.readFile(path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'), 'utf8'),
    ]);

    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `medium`');
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `low`');
    expect(projectRoleContent).toContain('model_reasoning_effort = "low"');
    expect(await fs.readFile(path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'), 'utf8')).toBe(userRoleBefore);
    expect(userTrackingAfter.plugins['codex-explore']).toEqual(userTrackingBefore.plugins['codex-explore']);
    expect(userStatus.reports[0]?.plugins[0].managedArtifacts?.every((artifact) => artifact.health === 'healthy')).toBe(true);
  });

  it('skips artifact refresh when changed keys do not hit any tracked refreshKeys', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    const manifestPath = path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    const config = manifest.config as { schema: Record<string, Record<string, unknown>> };
    config.schema.notes = {
      type: 'string',
      required: false,
      title: 'notes',
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const beforeTracking = await readTrackingManifest(userPaths.trackingDir);
    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'notes', 'hello', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
        triggerKeys: ['notes'],
        artifacts: [],
      },
    });
    await expect(readTrackingManifest(userPaths.trackingDir)).resolves.toEqual(beforeTracking);
  });

  it('refreshes Codex project artifacts through config configure and writes updated digests back to tracking', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const beforeTracking = await readTrackingManifest(projectPaths.trackingDir);
    const beforeInstructionDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction')?.configDigest;
    const beforeRoleDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role')?.configDigest;

    const result = await runCliEntry(
      ['config', 'configure', 'codex-explore', '-s', 'project', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
        interactive: true,
        prompt: {
          configurePlugin: async (options) => {
            expect(options.initialScope).toBe('project');
            return {
              selectedScope: 'project',
              updates: {
                modelReasoningEffort: 'low',
              },
              updatedKeys: ['modelReasoningEffort'],
            };
          },
        },
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:configure',
      scope: 'project',
      updatedKeys: ['modelReasoningEffort'],
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['modelReasoningEffort'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'project',
            id: 'lightweight-instruction',
          }),
          expect.objectContaining({
            scope: 'project',
            id: 'codex-explorer-role',
          }),
        ]),
      },
    });

    const [projectConfig, roleContent, afterTracking, projectStatus] = await Promise.all([
      readCodexConfigFile(projectPaths.configTomlPath),
      fs.readFile(path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'), 'utf8'),
      readTrackingManifest(projectPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const trackedInstruction = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction');
    const trackedRole = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `low`',
    );
    expect(roleContent).toContain('model_reasoning_effort = "low"');
    expect(trackedInstruction).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(trackedRole).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(trackedInstruction?.configDigest).not.toBe(beforeInstructionDigest);
    expect(trackedRole?.configDigest).not.toBe(beforeRoleDigest);
    expect(projectStatus.reports[0]?.plugins[0].managedArtifacts?.every((artifact) => artifact.health === 'healthy')).toBe(true);
  });

  it('re-enables lightweight instruction through config unset and rewrites the managed block from current render config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        enableLightweightInstruction: false,
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'high',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const beforeTracking = await readTrackingManifest(userPaths.trackingDir);
    const beforeInstructionDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction')?.configDigest;

    const result = await runCliEntry(
      ['config', 'unset', 'codex-explore', 'enableLightweightInstruction', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:unset',
      scope: 'user',
      removedKey: 'enableLightweightInstruction',
      existed: true,
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['enableLightweightInstruction'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'user',
            id: 'lightweight-instruction',
            state: 'present',
          }),
        ]),
      },
    });

    const [configStore, userConfig, afterTracking, userStatus] = await Promise.all([
      fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json')),
      readCodexConfigFile(userPaths.configTomlPath),
      readTrackingManifest(userPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const trackedInstruction = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction');

    expect(configStore).toMatchObject({
      explorerModel: 'gpt-5.4',
      modelReasoningEffort: 'high',
    });
    expect(configStore.enableLightweightInstruction).toBeUndefined();
    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`model`: `gpt-5.4`',
    );
    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `high`',
    );
    expect(trackedInstruction).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['enableLightweightInstruction'],
      },
    });
    expect(trackedInstruction?.configDigest).not.toBe(beforeInstructionDigest);
    expect(userStatus.reports[0]?.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      health: 'healthy',
      state: 'present',
    });
  });

  it('refreshes tracked artifacts through config reset and restores default render output', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const beforeTracking = await readTrackingManifest(projectPaths.trackingDir);
    const beforeInstructionDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction')?.configDigest;
    const beforeRoleDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role')?.configDigest;

    const result = await runCliEntry(
      ['config', 'reset', 'codex-explore', '-s', 'project', '--yes', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:reset',
      scope: 'project',
      existed: true,
      deleted: true,
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
    });

    const projectStorePath = path.join(repoRoot, '.agent-workflows', 'plugin-config', 'codex-explore', 'config.json');
    const [projectConfig, roleContent, afterTracking, projectStatus] = await Promise.all([
      readCodexConfigFile(projectPaths.configTomlPath),
      fs.readFile(path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'), 'utf8'),
      readTrackingManifest(projectPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const trackedInstruction = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction');
    const trackedRole = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    await expect(fs.pathExists(projectStorePath)).resolves.toBe(false);
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`model`: `gpt-5.4-mini`',
    );
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `medium`',
    );
    expect(roleContent).toContain('model = "gpt-5.4-mini"');
    expect(roleContent).toContain('model_reasoning_effort = "medium"');
    expect(trackedInstruction).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
    });
    expect(trackedRole).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
    });
    expect(trackedInstruction?.configDigest).not.toBe(beforeInstructionDigest);
    expect(trackedRole?.configDigest).not.toBe(beforeRoleDigest);
    expect(projectStatus.reports[0]?.plugins[0].managedArtifacts?.every((artifact) => artifact.health === 'healthy')).toBe(true);
  });

  it('does not run lifecycle scripts during config-triggered refresh', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeCodexExploreLifecycleRecorder(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const lifecycleLogPath = path.join(awHome, 'lifecycle.log');
    expect((await fs.readFile(lifecycleLogPath, 'utf8')).trim().split('\n').filter(Boolean)).toEqual(['install']);

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect((await fs.readFile(lifecycleLogPath, 'utf8')).trim().split('\n').filter(Boolean)).toEqual(['install']);
  });

  it('does not run renderer or lifecycle scripts during status', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    await writeCodexExploreLifecycleRecorder(repoRoot, 'lifecycle.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );
    await fs.remove(path.join(awHome, 'artifact-render.log'));
    await fs.remove(path.join(awHome, 'lifecycle.log'));

    const result = await statusCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: process.env,
      },
    );

    expect(result.reports[0]?.plugins[0]?.pluginName).toBe('codex-explore');
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'lifecycle.log'))).resolves.toBe(false);
  });

  it('does not treat a lone project config store as a project artifact install during user-scope refresh', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );
    await fs.outputFile(
      path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
      'shadow project skill\n',
    );

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'explorerModel', 'gpt-5.5', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'user',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['explorerModel'],
      },
    });
    expect(result.parseJsonStdout<{ artifactRefresh: { artifacts: Array<{ scope: Scope }> } }>().artifactRefresh.artifacts.every((artifact) => artifact.scope === 'user')).toBe(true);
    expect((await fs.readFile(path.join(awHome, 'artifact-render.log'), 'utf8')).trim().split('\n').filter(Boolean)).toEqual([
      'install:user',
      'refresh:user',
    ]);
  });

  it('keeps the config store and skips renderer/project artifact writes when project preflight fails during refresh', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const managedRolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const skillPath = path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md');
    const skillMetadataPath = projectSkillMetadataPath(repoRoot);
    const [baselineProjectConfig, baselineRoleContent, baselineSkillContent, baselineSkillMetadata, beforeTracking] = await Promise.all([
      fs.readFile(projectPaths.configTomlPath, 'utf8'),
      fs.readFile(managedRolePath, 'utf8'),
      fs.readFile(skillPath, 'utf8'),
      fs.readFile(skillMetadataPath, 'utf8'),
      readTrackingManifest(projectPaths.trackingDir),
    ]);
    const beforeInstructionDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction')?.configDigest;
    const beforeRoleDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role')?.configDigest;

    await fs.remove(path.join(awHome, 'artifact-render.log'));
    await fs.outputFile(userPaths.configTomlPath, '[plugins."broken"\n');

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'explorerModel', 'gpt-5.5', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'user',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['explorerModel'],
        error: expect.stringContaining('无法完成 Codex project 写入前安全预检'),
      },
    });
    await expect(fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'))).resolves.toMatchObject({
      explorerModel: 'gpt-5.5',
    });
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.readFile(projectPaths.configTomlPath, 'utf8')).resolves.toBe(baselineProjectConfig);
    await expect(fs.readFile(managedRolePath, 'utf8')).resolves.toBe(baselineRoleContent);
    await expect(fs.readFile(skillPath, 'utf8')).resolves.toBe(baselineSkillContent);
    await expect(fs.readFile(skillMetadataPath, 'utf8')).resolves.toBe(baselineSkillMetadata);

    const afterTracking = await readTrackingManifest(projectPaths.trackingDir);
    expect(afterTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      configDigest: beforeInstructionDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
      },
    });
    expect(afterTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      configDigest: beforeRoleDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
      },
    });
  });

  it('records only the current repo in refreshReach while flagging other known project installs as potentially stale', async () => {
    const { repoA, repoB, awHome, codexHome, embeddedRoot } = await makeMultiRepoWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoA,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoA, process.env),
      },
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoA,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoB,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const repoAUserPaths = resolveCodexPaths(repoA, 'user', process.env);
    const repoAProjectPaths = resolveCodexPaths(repoA, 'project', process.env);
    const repoBProjectPaths = resolveCodexPaths(repoB, 'project', process.env);
    const beforeRepoBTracking = await readTrackingManifest(repoBProjectPaths.trackingDir);
    const repoBProjectKey = await resolveCodexProjectKey(repoB);

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '--json'],
      {
        cwd: repoA,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'user',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['modelReasoningEffort'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'user',
          }),
          expect.objectContaining({
            scope: 'project',
          }),
        ]),
      },
    });

    const [repoAUserTracking, repoAProjectTracking, repoBTrackingAfter, repoAUserStatus] = await Promise.all([
      readTrackingManifest(repoAUserPaths.trackingDir),
      readTrackingManifest(repoAProjectPaths.trackingDir),
      readTrackingManifest(repoBProjectPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoA,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const expectedReach = {
      commandScope: 'user',
      refreshedUserTarget: true,
      refreshedCurrentProjectTarget: true,
      scannedHistoricalProjects: false,
      historicalProjectTargetsMayBeStale: true,
      knownProjectTargetsOutsideReach: [`project:${repoBProjectKey}`],
    };

    expect(repoAUserTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      refreshReach: expectedReach,
    });
    expect(repoAProjectTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      refreshReach: expectedReach,
    });
    expect(repoBTrackingAfter.plugins['codex-explore']).toEqual(beforeRepoBTracking.plugins['codex-explore']);
    expect(repoAUserStatus.reports[0]?.plugins[0].managedArtifacts?.find((artifact) => artifact.id === 'lightweight-instruction')).toMatchObject({
      refreshReach: expectedReach,
    });
  });

  it('keeps the config store when refresh fails and records recent refresh failure diagnostics', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const managedRolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const baselineRoleContent = await fs.readFile(managedRolePath, 'utf8');
    const baselineConfig = await fs.readFile(userPaths.configTomlPath, 'utf8');
    await fs.outputFile(path.join(userPaths.configDir, 'agents', 'shadow-role.toml'), 'name = "codex-explorer"\n');
    await fs.writeFile(
      userPaths.configTomlPath,
      baselineConfig.replace(
        'config_file = "agents/aw-codex-explore-codex-explorer.toml"',
        'config_file = "agents/shadow-role.toml"',
      ),
      'utf8',
    );
    const beforeTracking = await readTrackingManifest(userPaths.trackingDir);

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'explorerModel', 'gpt-5.5', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['explorerModel'],
      },
    });
    await expect(fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'))).resolves.toMatchObject({
      explorerModel: 'gpt-5.5',
    });
    await expect(fs.readFile(managedRolePath, 'utf8')).resolves.toBe(baselineRoleContent);
    const afterTracking = await readTrackingManifest(userPaths.trackingDir);
    expect(afterTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
      },
    });
  });

  it('keeps already-committed user scope refresh artifacts when the current project refresh unit fails later', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'project',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.5',
        modelReasoningEffort: 'xhigh',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: process.env,
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const projectRolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const userRolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const [baselineUserRoleContent, baselineProjectRoleContent, userTrackingBefore, projectTrackingBefore] = await Promise.all([
      fs.readFile(userRolePath, 'utf8'),
      fs.readFile(projectRolePath, 'utf8'),
      readTrackingManifest(userPaths.trackingDir),
      readTrackingManifest(projectPaths.trackingDir),
    ]);
    await fs.writeFile(projectRolePath, `${baselineProjectRoleContent}\n# project drift\n`, 'utf8');

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'user',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['modelReasoningEffort'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'user',
            id: 'lightweight-instruction',
            state: 'present',
          }),
          expect.objectContaining({
            scope: 'project',
            id: 'codex-explorer-role',
            state: 'present',
          }),
        ]),
      },
    });

    const [userConfig, projectConfig, userRoleContent, projectRoleContent, userTrackingAfter, projectTrackingAfter, userStatus, projectStatus] = await Promise.all([
      readCodexConfigFile(userPaths.configTomlPath),
      readCodexConfigFile(projectPaths.configTomlPath),
      fs.readFile(userRolePath, 'utf8'),
      fs.readFile(projectRolePath, 'utf8'),
      readTrackingManifest(userPaths.trackingDir),
      readTrackingManifest(projectPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const userRoleTrackingBefore = userTrackingBefore.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const userRoleTrackingAfter = userTrackingAfter.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const projectRoleTrackingBefore = projectTrackingBefore.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const projectRoleTrackingAfter = projectTrackingAfter.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const userRoleStatus = userStatus.reports[0]?.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const projectRoleStatus = projectStatus.reports[0]?.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `low`');
    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain('`reasoning_effort`: `xhigh`');
    expect(baselineUserRoleContent).not.toContain('model_reasoning_effort = "low"');
    expect(userRoleContent).toContain('model_reasoning_effort = "low"');
    expect(projectRoleContent).toBe(`${baselineProjectRoleContent}\n# project drift\n`);
    expect(userRoleTrackingAfter).toMatchObject({
      configDigest: expect.any(String),
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(userRoleTrackingAfter?.configDigest).not.toBe(userRoleTrackingBefore?.configDigest);
    expect(projectRoleTrackingAfter).toMatchObject({
      configDigest: projectRoleTrackingBefore?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(userRoleStatus).toMatchObject({
      health: 'healthy',
    });
    expect(projectRoleStatus).toMatchObject({
      health: 'contentDrift',
    });
  });

  it('fails refresh on role layer content drift before renderer, keeps the user-edited role file, and records failed refresh metadata', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const managedRolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const baselineRoleContent = await fs.readFile(managedRolePath, 'utf8');
    await fs.writeFile(managedRolePath, `${baselineRoleContent}\n# user drift\n`, 'utf8');
    const beforeTracking = await readTrackingManifest(userPaths.trackingDir);
    await fs.remove(path.join(awHome, 'artifact-render.log'));

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['modelReasoningEffort'],
        error: expect.stringContaining('tracking contentDigest 不一致'),
      },
    });
    await expect(fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'))).resolves.toMatchObject({
      explorerModel: 'gpt-5.4',
      modelReasoningEffort: 'low',
    });
    await expect(fs.readFile(managedRolePath, 'utf8')).resolves.toBe(`${baselineRoleContent}\n# user drift\n`);
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);

    const [afterTracking, statusResult] = await Promise.all([
      readTrackingManifest(userPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const roleArtifact = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const roleStatus = statusResult.reports[0]?.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(roleArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(roleStatus).toMatchObject({
      health: 'contentDrift',
    });
    expect(roleStatus?.diagnostics?.[0]).toContain('tracking contentDigest 不一致');
  });

  it('keeps the config store and reports recent refresh failure when renderer returns an invalid refresh plan', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    await writeCodexExploreRenderer(
      repoRoot,
      `
const plan = {
  version: 1,
  artifacts: [
    {
      id: 'lightweight-instruction',
      kind: 'instruction',
      platform: 'codex',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      content: 'invalid refresh plan instruction',
    },
    {
      id: 'codex-explorer-role',
      kind: 'codexRole',
      platform: 'codex',
      target: 'codex.agentRole',
      state: 'present',
      roleKey: 'shadow-role',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        registration: {
          description: 'Invalid refresh plan role.',
        },
        roleFile: {
          name: 'shadow-role',
          description: 'Invalid refresh plan role.',
          developer_instructions: 'Invalid refresh plan role instructions.',
        },
      },
    },
  ],
};

process.stdout.write(\`\${JSON.stringify(plan, null, 2)}\\n\`);
`,
    );
    const refreshedEmbeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    setEmbeddedPluginsRootOverrideForTests(refreshedEmbeddedRoot);

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const managedRolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const [baselineRoleContent, baselineConfig, beforeTracking] = await Promise.all([
      fs.readFile(managedRolePath, 'utf8'),
      fs.readFile(userPaths.configTomlPath, 'utf8'),
      readTrackingManifest(userPaths.trackingDir),
    ]);

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'explorerModel', 'gpt-5.5', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['explorerModel'],
        error: expect.stringContaining('expected "codex-explorer" from static metadata'),
      },
    });
    await expect(fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'))).resolves.toMatchObject({
      explorerModel: 'gpt-5.5',
      modelReasoningEffort: 'medium',
    });
    await expect(fs.readFile(managedRolePath, 'utf8')).resolves.toBe(baselineRoleContent);
    await expect(fs.readFile(userPaths.configTomlPath, 'utf8')).resolves.toBe(baselineConfig);

    const [afterTracking, statusResult] = await Promise.all([
      readTrackingManifest(userPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const roleArtifact = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const instructionArtifact = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction');
    const roleStatus = statusResult.reports[0]?.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(instructionArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
      },
    });
    expect(roleArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
      },
    });
    expect(roleStatus).toMatchObject({
      health: 'recentRefreshFailed',
    });
    expect(roleStatus?.diagnostics?.[0]).toContain('最近一次 refresh 失败');
  });

  it('rolls back already-written role artifacts when refresh apply fails mid-flight and keeps status diagnosable', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: process.env,
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot, process.env),
      },
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const managedRolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const [baselineRoleContent, baselineConfig, beforeTracking] = await Promise.all([
      fs.readFile(managedRolePath, 'utf8'),
      fs.readFile(userPaths.configTomlPath, 'utf8'),
      readTrackingManifest(userPaths.trackingDir),
    ]);
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (path.normalize(String(file)) === path.normalize(userPaths.configTomlPath)) {
        throw new Error('forced config write failure during refresh');
      }
      return originalWriteFile(file, data, options as never);
    });

    const result = await runCliEntry(
      ['config', 'set', 'codex-explore', 'modelReasoningEffort', 'low', '--json'],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:set',
      artifactRefresh: {
        attempted: true,
        status: 'failed',
        triggerKeys: ['modelReasoningEffort'],
        error: expect.stringContaining('forced config write failure during refresh'),
      },
    });
    await expect(fs.readJson(path.join(awHome, 'plugin-config', 'codex-explore', 'config.json'))).resolves.toMatchObject({
      explorerModel: 'gpt-5.4',
      modelReasoningEffort: 'low',
    });
    await expect(fs.readFile(managedRolePath, 'utf8')).resolves.toBe(baselineRoleContent);
    await expect(fs.readFile(userPaths.configTomlPath, 'utf8')).resolves.toBe(baselineConfig);

    const [afterTracking, statusResult] = await Promise.all([
      readTrackingManifest(userPaths.trackingDir),
      statusCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          json: true,
        },
        {
          env: process.env,
        },
      ),
    ]);
    const instructionArtifact = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'lightweight-instruction');
    const roleArtifact = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explorer-role');
    const roleStatus = statusResult.reports[0]?.plugins[0].managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(instructionArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'lightweight-instruction')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(roleArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(roleStatus).toMatchObject({
      health: 'recentRefreshFailed',
    });
    expect(roleStatus?.diagnostics?.[0]).toContain('forced config write failure during refresh');
  });

  it('reinstalls capabilityChanged Codex project artifacts with new dynamic ids and role identity, and prunes old residues', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const legacyRolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const legacySkillPath = path.join(repoRoot, '.agents', 'skills', 'codex-explore');

    await mutateCodexExploreManifest(repoRoot, (manifest) => {
      delete manifest.skills;
      delete manifest.skillTriggers;
      manifest.artifacts = {
        targets: [
          {
            id: 'repo-lightweight-instruction-v2',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.developerInstructionsBlock',
            projectManagedKind: 'instruction',
            states: ['present', 'disabled'],
            refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
            requiresCodexProjectConfig: true,
          },
          {
            id: 'repo-codex-explorer-role-v2',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.agentRole',
            projectManagedKind: 'agent',
            states: ['present'],
            refreshKeys: ['explorerModel', 'modelReasoningEffort'],
            requiresCodexProjectConfig: true,
            roleKey: 'repo-codex-explorer',
          },
        ],
      };
    });
    await fs.remove(path.join(repoRoot, 'plugins', 'codex-explore', 'skills'));
    await writeCodexExploreRenderer(
      repoRoot,
      [
        'console.log(JSON.stringify({',
        '  version: 1,',
        '  artifacts: [',
        '    {',
        '      id: "repo-lightweight-instruction-v2",',
        '      kind: "instruction",',
        '      platform: "codex",',
        '      target: "codex.developerInstructionsBlock",',
        '      state: "present",',
        '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
        '      content: "Capability changed instruction v2"',
        '    },',
        '    {',
        '      id: "repo-codex-explorer-role-v2",',
        '      kind: "codexRole",',
        '      platform: "codex",',
        '      target: "codex.agentRole",',
        '      state: "present",',
        '      roleKey: "repo-codex-explorer",',
        '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
        '      content: {',
        '        registration: { description: "Capability changed role v2." },',
        '        roleFile: {',
        '          name: "repo-codex-explorer",',
        '          description: "Capability changed role v2.",',
        '          developer_instructions: "Capability changed role instructions v2"',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}));',
      ].join('\n'),
    );
    await rebuildEmbeddedRoot(repoRoot);

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        env: process.env,
      },
    );

    const config = await readCodexConfigFile(projectPaths.configTomlPath);
    const newRolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-repo-codex-explorer.toml');
    const trackedArtifacts = (await readTrackingManifest(projectPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];

    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      'Capability changed instruction v2',
    );
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).not.toContain(
      'Codex 内置 `explorer` role',
    );
    expect(config.snapshot.agents['codex-explorer']).toBeUndefined();
    expect(config.snapshot.agents['repo-codex-explorer']).toEqual({
      key: 'repo-codex-explorer',
      description: 'Capability changed role v2.',
      configFile: 'agents/aw-codex-explore-repo-codex-explorer.toml',
    });
    await expect(fs.pathExists(legacyRolePath)).resolves.toBe(false);
    await expect(fs.pathExists(newRolePath)).resolves.toBe(true);
    await expect(fs.readFile(newRolePath, 'utf8')).resolves.toContain(
      'Capability changed role instructions v2',
    );
    await expect(fs.pathExists(legacySkillPath)).resolves.toBe(false);
    expect(trackedArtifacts.map((artifact) => artifact.id ?? artifact.artifactKey).sort()).toEqual([
      'repo-codex-explorer-role-v2',
      'repo-lightweight-instruction-v2',
    ]);
  });

  it('blocks Claude install through marketplace product policy', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    await expect(
      installCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
      ),
    ).rejects.toThrow('marketplace.policy.products=[CODEX]');
  });
});
