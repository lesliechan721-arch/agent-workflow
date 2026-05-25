import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { initCommand } from '../../src/commands/init.js';
import { installCommand } from '../../src/commands/install.js';
import { cleanupCommand } from '../../src/commands/cleanup.js';
import { diagnoseCommand } from '../../src/commands/diagnose.js';
import type { CommandExecutionContextInput } from '../../src/commands/runtime.js';
import { runRepairWorkflow } from '../../src/commands/repair.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import { setCodexAppServerProcessRunnerOverrideForTests } from '../../src/utils/codex-app-server-client.js';
import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { readCodexConfigFile, upsertCodexMarketplaceFile } from '../../src/utils/codex-config.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from '../../src/utils/plugin-scripts.js';
import { getTrackingManifestPath, readTrackingManifest } from '../../src/utils/tracking.js';
import {
  setNativeCliRunnerOverrideForTests,
  type NativeCliInvocation,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import type { PluginMeta, Scope } from '../../src/types.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';
import {
  activateCliEmbeddedRoot,
  registerCliCatalogSourceRoot,
  registerCliEmbeddedRoot,
  registerCliFixtureRepoRoot,
  registerCliTempRoot,
} from '../helpers/workspace.js';
import { runWithZeroWriteSnapshot } from '../helpers/repo-managed-state.js';
import { registerCurrentTestReadonlyFixtureRoot } from '../setup/test-isolation.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerRepoFixtureRoots(): void {
  registerCurrentTestReadonlyFixtureRoot(fixturePath(), 'codex explore fixture root');
  registerCurrentTestReadonlyFixtureRoot(repoPluginPath('plugins'), 'codex explore workspace plugin root');
}

function registerEmbeddedCatalogRoots(
  embeddedRoot: string,
  source: string,
): void {
  registerCliEmbeddedRoot(embeddedRoot, `${source} embedded root`);
  registerCliCatalogSourceRoot(
    getCatalogFullPackageRoot(embeddedRoot),
    `${source} catalog source root`,
  );
}

function activateWorkspaceEnv(
  workspace: {
    awHome: string;
    codexHome: string;
    embeddedRoot: string;
    homeDir?: string;
  },
  options: {
    forceClaude?: boolean;
    overrides?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const homeDir = workspace.homeDir ?? path.join(path.dirname(workspace.awHome), 'home');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.AW_HOME = workspace.awHome;
  process.env.AW_CODEX_HOME = workspace.codexHome;
  process.env.AW_FORCE_CODEX_AVAILABLE = '1';
  if (options.forceClaude) {
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
  } else {
    delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  activateCliEmbeddedRoot(workspace.embeddedRoot, 'codex explore embedded root activation');
  return process.env;
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

async function hydrateEmbeddedCodexExploreTemplates(repoRoot: string, embeddedRoot: string): Promise<void> {
  const sourceSkillRoot = path.join(repoRoot, 'plugins', 'codex-explore', 'skills', 'codex-explore');
  const embeddedSkillRoot = path.join(embeddedRoot, 'plugins', 'codex-explore', 'skills', 'codex-explore');

  if (!(await fs.pathExists(sourceSkillRoot))) {
    return;
  }

  await fs.copy(sourceSkillRoot, embeddedSkillRoot, {
    overwrite: true,
    errorOnExist: false,
  });
}

async function rebuildEmbeddedRoot(repoRoot: string): Promise<string> {
  const embeddedRoot = await fs.realpath(await createSyntheticEmbeddedRoot(repoRoot));
  await hydrateEmbeddedCodexExploreTemplates(repoRoot, embeddedRoot);
  tempDirs.push(embeddedRoot);
  registerEmbeddedCatalogRoots(embeddedRoot, 'codex explore rebuilt');
  activateCliEmbeddedRoot(embeddedRoot, 'codex explore rebuilt embedded root');
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
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

const plan = {
  version: 1,
  artifacts: [
    {
      id: 'codex-explore-skill',
      kind: 'skill',
      platform: 'codex',
      target: 'codex.skill',
      state: 'present',
      skillKey: 'codex-explore',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        skillFile: \`# Recorded Explore\\nmodel=\${explorerModel}\\nreasoning=\${modelReasoningEffort}\\n\`,
        openaiYaml: 'policy:\\n  allow_implicit_invocation: true\\n',
      },
    },
    {
      id: 'codex-explore-agent-role',
      kind: 'codexRole',
      platform: 'codex',
      target: 'codex.agentRole',
      state: 'present',
      roleKey: 'codex-explore-agent',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        registration: {
          description: 'Recorded explore agent',
        },
        roleFile: {
          name: 'codex-explore-agent',
          description: 'Recorded explore agent',
          developer_instructions: 'Read only.',
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

async function addCodexExploreRoleGuidanceInstructionArtifact(rootDir: string): Promise<void> {
  await mutateCodexExploreManifest(rootDir, (manifest) => {
    const artifacts = manifest.artifacts as { targets?: Record<string, unknown>[] };
    artifacts.targets = [
      ...(artifacts.targets ?? []),
      {
        id: 'role-guidance',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.developerInstructionsBlock',
        projectManagedKind: 'instruction',
        states: ['present'],
        refreshKeys: ['modelReasoningEffort'],
        requiresCodexProjectConfig: true,
      },
    ];
  });
}

async function addCodexExploreDynamicSkillArtifact(rootDir: string): Promise<void> {
  await mutateCodexExploreManifest(rootDir, (manifest) => {
    const artifacts = manifest.artifacts as { targets?: Record<string, unknown>[] };
    const targets = artifacts.targets ?? [];
    if (targets.some((target) => target.id === 'codex-explore-skill' && target.target === 'codex.skill')) {
      artifacts.targets = targets;
      return;
    }
    artifacts.targets = [
      ...targets,
      {
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        skillKey: 'codex-explore',
      },
    ];
  });
}

async function configureCodexExploreSkillOnlyArtifact(rootDir: string): Promise<void> {
  await mutateCodexExploreManifest(rootDir, (manifest) => {
    manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        skillKey: 'codex-explore',
      }],
    };
  });
}

async function configureCodexExploreSingleSkillArtifact(options: {
  rootDir: string;
  id: string;
  skillKey: string;
}): Promise<void> {
  await mutateCodexExploreManifest(options.rootDir, (manifest) => {
    manifest.skillTriggers = {
      [options.skillKey]: {
        defaultTrigger: 'auto',
        allowDynamicTrigger: true,
      },
    };
    manifest.artifacts = {
      targets: [{
        id: options.id,
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        skillKey: options.skillKey,
      }],
    };
  });
}

async function writeCodexExploreDynamicSkillRenderer(
  rootDir: string,
  options: {
    failScopes?: Scope[];
  } = {},
): Promise<void> {
  const failScopes = options.failScopes ?? [];
  await writeCodexExploreRenderer(
    rootDir,
    `
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (${JSON.stringify(failScopes)}.includes(context.scope)) {
  throw new Error(\`forced dynamic skill renderer failure for \${context.scope}\`);
}

const values =
  context.config?.values ??
  context.renderConfig?.values ??
  context.artifactRenderConfig?.values ??
  context.configValues ??
  {};
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

const plan = {
  version: 1,
  artifacts: [
    {
      id: 'codex-explore-skill',
      kind: 'skill',
      platform: 'codex',
      target: 'codex.skill',
      state: 'present',
      skillKey: 'codex-explore',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        skillFile: \`# Dynamic Explore\\nmodel=\${explorerModel}\\nreasoning=\${modelReasoningEffort}\\n\`,
        openaiYaml: 'policy:\\n  allow_implicit_invocation: true\\n',
      },
    },
  ],
};

process.stdout.write(\`\${JSON.stringify(plan, null, 2)}\\n\`);
`,
  );
}

async function writeCodexExploreSkillOnlyRenderer(
  rootDir: string,
  options: {
    failScopes?: Scope[];
  } = {},
): Promise<void> {
  const failScopes = options.failScopes ?? [];
  await writeCodexExploreRenderer(
    rootDir,
    `
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (${JSON.stringify(failScopes)}.includes(context.scope)) {
  throw new Error(\`forced dynamic skill renderer failure for \${context.scope}\`);
}

const values =
  context.config?.values ??
  context.renderConfig?.values ??
  context.artifactRenderConfig?.values ??
  context.configValues ??
  {};
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

const plan = {
  version: 1,
  artifacts: [
    {
      id: 'codex-explore-skill',
      kind: 'skill',
      platform: 'codex',
      target: 'codex.skill',
      state: 'present',
      skillKey: 'codex-explore',
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        skillFile: \`# Dynamic Explore\\nmodel=\${explorerModel}\\nreasoning=\${modelReasoningEffort}\\n\`,
        openaiYaml: 'policy:\\n  allow_implicit_invocation: true\\n',
      },
    },
  ],
};

process.stdout.write(\`\${JSON.stringify(plan, null, 2)}\\n\`);
`,
  );
}

async function writeCodexExploreSingleSkillRenderer(options: {
  rootDir: string;
  id: string;
  skillKey: string;
  title: string;
  failScopes?: Scope[];
}): Promise<void> {
  const failScopes = options.failScopes ?? [];
  await writeCodexExploreRenderer(
    options.rootDir,
    `
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (${JSON.stringify(failScopes)}.includes(context.scope)) {
  throw new Error(\`forced dynamic skill renderer failure for \${context.scope}\`);
}

const values =
  context.config?.values ??
  context.renderConfig?.values ??
  context.artifactRenderConfig?.values ??
  context.configValues ??
  {};
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

const plan = {
  version: 1,
  artifacts: [
    {
      id: ${JSON.stringify(options.id)},
      kind: 'skill',
      platform: 'codex',
      target: 'codex.skill',
      state: 'present',
      skillKey: ${JSON.stringify(options.skillKey)},
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      content: {
        skillFile: \`# ${options.title}\\nmodel=\${explorerModel}\\nreasoning=\${modelReasoningEffort}\\n\`,
        openaiYaml: 'policy:\\n  allow_implicit_invocation: true\\n',
      },
    },
  ],
};

process.stdout.write(\`\${JSON.stringify(plan, null, 2)}\\n\`);
`,
  );
}

async function writeMultiInstructionCodexExploreRenderer(
  rootDir: string,
  logFileName = 'artifact-render.log',
): Promise<void> {
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

const values = context.artifactRenderConfig?.values ?? {};
const explorerModel = values.explorerModel ?? 'gpt-5.4-mini';
const modelReasoningEffort = values.modelReasoningEffort ?? 'medium';

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
      content: \`multi lightweight \${explorerModel} \${modelReasoningEffort}\`,
    },
    {
      id: 'role-guidance',
      kind: 'instruction',
      platform: 'codex',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      refreshKeys: ['modelReasoningEffort'],
      content: \`multi role guidance \${modelReasoningEffort}\`,
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
          description: 'Multi instruction explorer role.',
        },
        roleFile: {
          name: 'codex-explorer',
          description: 'Multi instruction explorer role.',
          developer_instructions: 'Multi instruction explorer role instructions.',
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
  homeDir: string;
}> {
  registerRepoFixtureRoots();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-explore-')));
  tempDirs.push(root);
  registerCliTempRoot(root, 'codex explore root');

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'codex explore repo root');
  await copyWorkspacePlugin(repoRoot, 'codex-explore');

  const embeddedRoot = await fs.realpath(await createSyntheticEmbeddedRoot(repoRoot));
  await hydrateEmbeddedCodexExploreTemplates(repoRoot, embeddedRoot);
  tempDirs.push(embeddedRoot);
  registerEmbeddedCatalogRoots(embeddedRoot, 'codex explore');

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    embeddedRoot,
    homeDir: path.join(root, 'home'),
  };
}

async function makeMultiRepoWorkspaceWithCodexExplore(): Promise<{
  repoA: string;
  repoB: string;
  awHome: string;
  codexHome: string;
  embeddedRoot: string;
  homeDir: string;
}> {
  registerRepoFixtureRoots();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-explore-multi-')));
  tempDirs.push(root);
  registerCliTempRoot(root, 'codex explore multi root');

  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  await fs.copy(fixturePath('repo-template'), repoA);
  await fs.copy(fixturePath('repo-template'), repoB);
  registerCliFixtureRepoRoot(repoA, 'codex explore repoA root');
  registerCliFixtureRepoRoot(repoB, 'codex explore repoB root');
  await copyWorkspacePlugin(repoA, 'codex-explore');
  await copyWorkspacePlugin(repoB, 'codex-explore');

  const embeddedRoot = await fs.realpath(await createSyntheticEmbeddedRoot(repoA));
  await hydrateEmbeddedCodexExploreTemplates(repoA, embeddedRoot);
  tempDirs.push(embeddedRoot);
  registerEmbeddedCatalogRoots(embeddedRoot, 'codex explore multi');

  return {
    repoA,
    repoB,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    embeddedRoot,
    homeDir: path.join(root, 'home'),
  };
}

function createCodexMarketplaceAddRunner(
  cwd: string,
  env: NodeJS.ProcessEnv,
  calls: NativeCliInvocation[] = [],
): NativeCliRunner {
  return async (invocation) => {
    calls.push(invocation);
    const invocationEnv = invocation.env ?? env;
    const invocationCwd = invocation.cwd ?? cwd;
    if (invocation.args.length === 1 && invocation.args[0] === '--version') {
      if (invocation.command === 'codex') {
        return {
          exitCode: 0,
          stdout: 'codex-cli 0.131.0',
          stderr: '',
        };
      }
      if (invocation.command === 'claude') {
        return {
          exitCode: 0,
          stdout: '2.1.88 (Claude Code)',
          stderr: '',
        };
      }
    }
    if (
      invocation.command === 'codex' &&
      invocation.args[0] === 'plugin' &&
      invocation.args[1] === 'marketplace' &&
      invocation.args[2] === 'add'
    ) {
      const awHome = invocation.args[invocation.args.length - 1] ?? '';
      await upsertCodexMarketplaceFile(
        resolveCodexPaths(invocationCwd, 'user', invocationEnv).configTomlPath,
        'aw',
        {
          source: awHome,
          sourceType: 'local',
        },
      );
    }
    if (
      invocation.command === 'codex' &&
      invocation.args[0] === 'plugin' &&
      invocation.args[1] === 'marketplace' &&
      invocation.args[2] === 'remove'
    ) {
      const configPath = resolveCodexPaths(invocationCwd, 'user', invocationEnv).configTomlPath;
      const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
      fs.ensureDirSync(path.dirname(configPath));
      fs.writeFileSync(
        configPath,
        current.replace(/\n?\[marketplaces\.aw\]\n[\s\S]*?(?=\n\[|$)/m, '').trimEnd() + '\n',
        'utf8',
      );
    }
    if (
      invocation.command === 'codex' &&
      invocation.args[0] === 'plugin' &&
      invocation.args[1] === 'add'
    ) {
      const pluginId = invocation.args[invocation.args.length - 1] ?? 'codex-explore@aw';
      materializeCodexExploreNativePluginSync(invocationCwd, invocationEnv, pluginId.split('@')[0] ?? 'codex-explore');
      fs.outputFileSync(path.join(invocationEnv.AW_CODEX_HOME!, 'plugins', pluginId, 'manifest.json'), '{}\n', 'utf8');
    }
    if (
      invocation.command === 'codex' &&
      invocation.args[0] === 'plugin' &&
      invocation.args[1] === 'remove'
    ) {
      const pluginId = invocation.args[invocation.args.length - 1] ?? 'codex-explore@aw';
      removeCodexExploreNativePluginSync(invocationCwd, invocationEnv, pluginId);
      fs.removeSync(path.join(invocationEnv.AW_CODEX_HOME!, 'plugins', pluginId));
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codexExploreNativeCachePath(env: NodeJS.ProcessEnv, pluginName: string): string {
  return path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, '0.1.0');
}

function resolveCodexExploreNativeCachePath(env: NodeJS.ProcessEnv, pluginName: string): string {
  const cacheRoot = path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName);
  if (!fs.existsSync(cacheRoot)) {
    return codexExploreNativeCachePath(env, pluginName);
  }

  const versions = fs.readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return versions.length > 0
    ? path.join(cacheRoot, versions[versions.length - 1])
    : codexExploreNativeCachePath(env, pluginName);
}

async function removeCodexPlatformSkillsDeclaration(pluginRoot: string): Promise<void> {
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  delete manifest.skills;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

function resolveMarketplacePluginRootSync(
  marketplacePath: string | undefined,
  fallbackRoot: string,
  pluginName: string,
): string {
  if (!marketplacePath || !fs.existsSync(marketplacePath)) {
    return fallbackRoot;
  }

  const marketplaceRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
  const marketplace = fs.readJsonSync(marketplacePath) as {
    plugins?: Array<{ name?: string; source?: string }>;
  };
  const source = marketplace.plugins?.find((entry) => entry.name === pluginName)?.source;
  return source ? path.resolve(marketplaceRoot, source) : fallbackRoot;
}

function materializeCodexExploreNativePluginSync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  pluginName: string,
  marketplacePath?: string,
): void {
  const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
  const pluginHeader = `[plugins.${JSON.stringify(`${pluginName}@aw`)}]`;
  fs.ensureDirSync(path.dirname(configPath));
  const current = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8')
    : '';
  if (!current.includes(pluginHeader)) {
    fs.writeFileSync(
      configPath,
      `${current.trimEnd()}${current.trimEnd() ? '\n\n' : ''}${pluginHeader}\nenabled = true\n`,
      'utf8',
    );
  }
  const cachePath = codexExploreNativeCachePath(env, pluginName);
  fs.removeSync(cachePath);
  fs.ensureDirSync(path.dirname(cachePath));
  const pluginRoot = resolveMarketplacePluginRootSync(
    marketplacePath,
    path.join(env.AW_HOME!, 'plugins', pluginName),
    pluginName,
  );
  fs.copySync(pluginRoot, cachePath, {
    overwrite: true,
    errorOnExist: false,
  });
  fs.outputFileSync(path.join(cachePath, 'plugin.json'), '{}\n', 'utf8');
}

function removeCodexExploreNativePluginSync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  pluginId: string,
): void {
  const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
  if (fs.existsSync(configPath)) {
    const pluginHeader = `[plugins.${JSON.stringify(pluginId)}]`;
    const sectionPattern = new RegExp(
      `\\n?${escapeRegExp(pluginHeader)}\\n[\\s\\S]*?(?=\\n\\[|$)`,
      'm',
    );
    const current = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, current.replace(sectionPattern, '').trimEnd() + '\n', 'utf8');
  }
  const pluginName = pluginId.endsWith('@aw') ? pluginId.slice(0, -3) : pluginId;
  fs.removeSync(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName));
}

function createCodexExploreAppServerRunner(
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return (invocation: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: (input) => {
          if (input.json?.method !== 'plugin/install') {
            return false;
          }
          const params = input.json.params as { marketplacePath?: string; pluginName?: string } | undefined;
          materializeCodexExploreNativePluginSync(
            cwd,
            env,
            params?.pluginName ?? 'codex-explore',
            params?.marketplacePath,
          );
          return true;
        },
        actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } } }],
      },
      {
        when: 'stdin',
        match: (input) => {
          if (input.json?.method !== 'plugin/uninstall') {
            return false;
          }
          const params = input.json.params as { pluginId?: string } | undefined;
          removeCodexExploreNativePluginSync(cwd, env, params?.pluginId ?? 'codex-explore@aw');
          return true;
        },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { uninstalled: true } } }],
      },
    ]);
    return harness.spawn(invocation);
  };
}

function createCodexExploreRuntime(
  cwd: string,
  env: NodeJS.ProcessEnv,
  nativeCalls: NativeCliInvocation[] = [],
): CommandExecutionContextInput {
  return {
    env,
    nativeCliRunner: createCodexMarketplaceAddRunner(cwd, env, nativeCalls),
    adaptersFactory: (adapterCwd, context) => ({
      codex: new CodexAdapter(
        adapterCwd,
        context.nativeCliRunner,
        context.env,
        createCodexExploreAppServerRunner(adapterCwd, context.env),
      ),
      claude: new ClaudeAdapter(adapterCwd, context.nativeCliRunner, context.env),
    }),
  };
}

function installCodexExploreRefreshAppServerOverride(
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  setNativeCliRunnerOverrideForTests(createCodexMarketplaceAddRunner(cwd, env));
  setCodexAppServerProcessRunnerOverrideForTests(
    createCodexExploreAppServerRunner(cwd, env),
  );
}

async function seedLegacyCodexExploreUserHealthySiblingInstall(options: {
  repoRoot: string;
  awHome: string;
  codexHome: string;
  embeddedRoot: string;
  homeDir?: string;
  requestedSkillTrigger?: 'manual' | 'auto' | 'default';
}): Promise<void> {
  const sibling = await makeWorkspaceWithCodexExplore();
  activateWorkspaceEnv(options);
  await installCommand(
    ['codex-explore'],
    {
      cwd: sibling.repoRoot,
      scope: 'user',
      platform: 'codex',
      ...(options.requestedSkillTrigger
        ? { requestedSkillTrigger: options.requestedSkillTrigger }
        : {}),
    },
      createCodexExploreRuntime(sibling.repoRoot, process.env),
  );
}

function userSkillMetadataPath(awHome: string, skillKey = 'codex-explore'): string {
  return path.join(
    awHome,
    'plugins',
    'codex-explore',
    'codex',
    'skills',
    skillKey,
    'agents',
    'openai.yaml',
  );
}

function userDynamicSkillPath(awHome: string, skillKey = 'codex-explore'): string {
  return path.join(
    awHome,
    'plugins',
    'codex-explore',
    'codex',
    'skills',
    skillKey,
    'SKILL.md',
  );
}

function cachedDynamicSkillPath(env: NodeJS.ProcessEnv, skillKey = 'codex-explore'): string {
  return path.join(
    resolveCodexExploreNativeCachePath(env, 'codex-explore'),
    'codex',
    'skills',
    skillKey,
    'SKILL.md',
  );
}

function cachedDynamicSkillMetadataPath(env: NodeJS.ProcessEnv, skillKey = 'codex-explore'): string {
  return path.join(
    resolveCodexExploreNativeCachePath(env, 'codex-explore'),
    'codex',
    'skills',
    skillKey,
    'agents',
    'openai.yaml',
  );
}

function projectSkillMetadataPath(repoRoot: string, skillKey = 'codex-explore'): string {
  return path.join(
    repoRoot,
    '.agents',
    'skills',
    skillKey,
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

interface StatusDynamicEntry {
  id?: string;
  target?: string;
  state?: string;
  disabledReason?: string;
  roleKey?: string;
  configDigest?: string;
  contentDigest?: string;
  refreshKeys?: string[];
  refreshReach?: {
    commandScope?: 'user' | 'projectShared';
    refreshedUserTarget?: boolean;
    refreshedCurrentProjectTarget?: boolean;
  };
  lastRefresh?: {
    status?: 'success' | 'failed';
    event?: 'install' | 'upgrade' | 'config' | 'repair';
    error?: string;
  };
}

interface StatusLocation {
  plugin?: string;
  platform?: 'codex' | 'claude';
  scope?: Scope;
  projectKey?: string;
  summary?: string;
  locationLabel?: string;
  state?: string;
  nextSteps?: string[];
  record?: {
    present?: boolean;
    status?: string;
    path?: string;
  };
  dynamicDiagnostic?: {
    available?: boolean;
    entries?: StatusDynamicEntry[];
  };
  issues?: Array<{
    code?: string;
    artifactPath?: string;
    detail?: string;
  }>;
}

interface StatusPayload {
  reports?: Array<{
    platform?: 'codex' | 'claude';
    scope?: Scope;
    plugins?: Array<{
      pluginName?: string;
      projectTrust?: string;
    }>;
  }>;
  locations?: StatusLocation[];
  friendlySummaries?: Array<{
    pluginName?: string;
    status?: string;
    location?: string;
    issueSummary?: string;
    nextStep?: string;
    nextSteps?: string[];
  }>;
  consoleItems?: Array<{
    pluginName?: string;
    reasonCodes?: string[];
  }>;
}

function findStatusLocation(
  payload: StatusPayload,
  options: {
    plugin: string;
    platform: 'codex' | 'claude';
    scope: Scope;
    projectKey?: string;
  },
): StatusLocation {
  const location = payload.locations?.find((candidate) =>
    candidate.plugin === options.plugin
    && candidate.platform === options.platform
    && candidate.scope === options.scope
    && (options.scope !== 'project' || options.projectKey === undefined || candidate.projectKey === options.projectKey),
  );
  expect(location).toBeDefined();
  return location!;
}

function findDynamicDiagnosticEntry(location: StatusLocation, artifactId: string): StatusDynamicEntry {
  const entry = location.dynamicDiagnostic?.entries?.find((candidate) => candidate.id === artifactId);
  expect(entry).toBeDefined();
  return entry!;
}

function findIssueCodes(location: StatusLocation, issueCode: string): Array<NonNullable<StatusLocation['issues']>[number]> {
  return (location.issues ?? []).filter((issue) => issue.code === issueCode);
}

async function readInstallRecordOptionsFromLocation(
  location: StatusLocation,
): Promise<{
  skillTriggerPreference?: 'default' | 'manual' | 'auto';
}> {
  expect(location.record?.path).toBeTruthy();
  const record = await fs.readJson(location.record!.path!) as {
    record?: {
      options?: {
        skillTriggerPreference?: 'default' | 'manual' | 'auto';
      };
    };
  };
  return record.record?.options ?? {};
}

function parseVerboseStatusPayload(output: string): StatusPayload {
  const marker = '\n\n详细信息\n';
  const index = output.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(index + marker.length)) as StatusPayload;
}

function parseStatusPayload(output: string): StatusPayload {
  return JSON.parse(output) as StatusPayload;
}

async function alignUserRecordSourceToWorkspacePlugin(repoRoot: string, recordPath: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'codex-explore');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as { version: string };
  const record = await fs.readJson(recordPath) as {
    record: {
      source: {
        pluginVersion: string;
        manifestDigest: string;
        bundleFingerprint: string;
      };
    };
  };
  record.record.source = {
    pluginVersion: manifest.version,
    manifestDigest: await calculateFileDigest(manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(pluginRoot),
  };
  await fs.writeJson(recordPath, record, { spaces: 2 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('codex-explore integration acceptance', () => {
  it.skip('installs Codex user scope with native enabled, lightweight instruction, and managed role artifacts', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env, nativeCalls),
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const config = await readCodexConfigFile(userPaths.configTomlPath);
    const rawConfig = await fs.readFile(userPaths.configTomlPath, 'utf8');
    const rolePath = path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const trackedArtifacts = (await readTrackingManifest(userPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];

    expect(nativeCalls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ['plugin', 'marketplace', 'add', awHome],
        ['plugin', 'marketplace', 'list'],
        ['plugin', 'add', 'codex-explore@aw'],
        ['plugin', 'list'],
      ]),
    );
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
      description: 'Codex Explore 只读代码库探索 role。',
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

  it.skip('uses only default+user render config for Codex user scope install and status, even when project config changes later', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const [userConfig, roleContent] = await Promise.all([
      readCodexConfigFile(userPaths.configTomlPath),
      fs.readFile(path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'), 'utf8'),
    ]);
    const location = findStatusLocation(parseStatusPayload(result.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const instructionArtifact = findDynamicDiagnosticEntry(location, 'lightweight-instruction');
    const roleArtifact = findDynamicDiagnosticEntry(location, 'codex-explorer-role');

    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`model`: `gpt-5.4`',
    );
    expect(userConfig.snapshot.developerInstructions.managedBlocks['codex-explore']?.value).toContain(
      '`reasoning_effort`: `medium`',
    );
    expect(roleContent).toContain('model = "gpt-5.4"');
    expect(roleContent).toContain('model_reasoning_effort = "medium"');
    expect(instructionArtifact).toMatchObject({
      state: 'present',
    });
    expect(roleArtifact).toMatchObject({
      state: 'present',
      roleKey: 'codex-explorer',
    });
  });

  it('installs Codex user dynamic skill through native cache and enabled config', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
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

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const nativeCacheRoot = resolveCodexExploreNativeCachePath(process.env, 'codex-explore');
    const [runtimeSkill, rawConfig, statusResult] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(userPaths.configTomlPath, 'utf8'),
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
    const location = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const skillArtifact = findDynamicDiagnosticEntry(location, 'codex-explore-skill');

    expect(runtimeSkill).toContain('model=gpt-5.5');
    expect(runtimeSkill).toContain('reasoning=high');
    expect(rawConfig).toContain('[plugins."codex-explore@aw"]');
    expect(rawConfig).toContain('enabled = true');
    await expect(fs.pathExists(path.join(nativeCacheRoot, 'plugin.json'))).resolves.toBe(true);
    await expect(fs.readFile(cachedDynamicSkillPath(process.env), 'utf8')).resolves.toContain('model=gpt-5.5');
    expect(skillArtifact).toMatchObject({
      target: 'codex.skill',
      state: 'present',
      artifactKey: 'codex-explore',
      configDigest: expect.stringMatching(/^sha256:/),
      contentDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it('prewarms local marketplace before materializing Codex user dynamic skill for native install', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    await removeCodexPlatformSkillsDeclaration(path.join(
      embeddedRoot,
      'plugins',
      'codex-explore',
    ));
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    await expect(fs.readFile(userDynamicSkillPath(awHome), 'utf8')).resolves.toContain('Dynamic Explore');
    await expect(fs.readFile(cachedDynamicSkillPath(process.env), 'utf8')).resolves.toContain('Dynamic Explore');
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'codex-explore', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({ skills: './codex/skills' });
    await expect(
      fs.readJson(
        path.join(
          resolveCodexExploreNativeCachePath(process.env, 'codex-explore'),
          '.codex-plugin',
          'plugin.json',
        ),
      ),
    ).resolves.toMatchObject({ skills: './codex/skills' });
  });

  it('refreshes Codex user dynamic skill and native cache while preserving manual trigger preference', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const nativeRefreshSpy = vi.spyOn(CodexAdapter.prototype, 'installPluginFromMarketplace').mockImplementation(
      async (plugin, scope, options) => {
        if (scope !== 'user') {
          return;
        }
        materializeCodexExploreNativePluginSync(
          repoRoot,
          process.env,
          plugin.manifest.name,
          options?.marketplacePath,
        );
      },
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
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            id: 'codex-explore-skill',
            target: 'codex.skill',
            scope: 'user',
          }),
        ]),
      },
    });
    expect(nativeRefreshSpy).toHaveBeenCalled();

    const [runtimeSkill, cachedSkill, recordStatus] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(cachedDynamicSkillPath(process.env), 'utf8'),
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
    const location = findStatusLocation(parseStatusPayload(recordStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });

    expect(runtimeSkill).toContain('model=gpt-5.5');
    expect(cachedSkill).toContain('model=gpt-5.5');
    expect(location.record?.present).toBe(true);
  });

  it('refreshes Codex user dynamic skill from historical bundle when local marketplace runtime has rendered templates', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await writePluginConfigStore({
      pluginName: 'codex-explore',
      scope: 'user',
      cwd: repoRoot,
      env: process.env,
      values: {
        explorerModel: 'gpt-5.4-mini',
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
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const renderedMarketplaceSkill = await fs.readFile(userDynamicSkillPath(awHome), 'utf8');
    expect(renderedMarketplaceSkill).toContain('推理强度 `medium`');
    expect(renderedMarketplaceSkill).not.toContain('{{modelReasoningEffort}}');

    const nativeRefreshSpy = vi.spyOn(CodexAdapter.prototype, 'installPluginFromMarketplace').mockImplementation(
      async (plugin, scope, options) => {
        if (scope !== 'user') {
          return;
        }
        materializeCodexExploreNativePluginSync(
          repoRoot,
          process.env,
          plugin.manifest.name,
          options?.marketplacePath,
        );
      },
    );
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
    expect(nativeRefreshSpy).toHaveBeenCalled();

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const [runtimeSkill, cachedSkill, roleContent] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(cachedDynamicSkillPath(process.env), 'utf8'),
      fs.readFile(path.join(userPaths.configDir, 'agents', 'aw-codex-explore-codex-explore-agent.toml'), 'utf8'),
    ]);

    expect(runtimeSkill).toContain('推理强度 `low`');
    expect(runtimeSkill).not.toContain('推理强度 `medium`');
    expect(cachedSkill).toContain('推理强度 `low`');
    expect(roleContent).toContain('model_reasoning_effort = "low"');
  });

  it('refreshes legacy dual-healthy user and current-project Codex dynamic skills on user config writes and syncs accepted digests', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
        modelReasoningEffort: 'low',
      },
    });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await seedLegacyCodexExploreUserHealthySiblingInstall({
      repoRoot,
      awHome,
      codexHome,
      embeddedRoot,
      requestedSkillTrigger: 'auto',
    });
    installCodexExploreRefreshAppServerOverride(repoRoot, process.env);

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
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            id: 'codex-explore-skill',
            target: 'codex.skill',
            scope: 'user',
            status: 'succeeded',
          }),
          expect.objectContaining({
            id: 'codex-explore-skill',
            target: 'codex.skill',
            scope: 'project',
            status: 'succeeded',
          }),
        ]),
        scopeReach: {
          refreshedUserTarget: true,
          refreshedCurrentProjectTarget: true,
        },
      },
    });

    const [userSkill, projectSkill, userMetadataAuto, projectMetadataAuto, userStatus, projectStatus] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
      readAllowImplicitInvocation(userSkillMetadataPath(awHome)),
      readAllowImplicitInvocation(projectSkillMetadataPath(repoRoot)),
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
    const userLocation = findStatusLocation(parseStatusPayload(userStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const projectLocation = findStatusLocation(parseStatusPayload(projectStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const userArtifact = findDynamicDiagnosticEntry(userLocation, 'codex-explore-skill');
    const projectArtifact = findDynamicDiagnosticEntry(projectLocation, 'codex-explore-skill');
    const userRecord = await fs.readJson(userLocation.record!.path!) as {
      record: {
        artifacts: Array<{ id?: string; target?: string; configDigest?: string; contentDigest?: string }>;
      };
    };
    const projectRecord = await fs.readJson(projectLocation.record!.path!) as {
      record: {
        artifacts: Array<{ id?: string; target?: string; configDigest?: string; contentDigest?: string }>;
      };
    };

    expect(userSkill).toContain('model=gpt-5.5');
    expect(projectSkill).toContain('model=gpt-5.4-mini');
    expect(projectSkill).toContain('reasoning=low');
    expect(userMetadataAuto).toBe(true);
    expect(projectMetadataAuto).toBe(true);
    expect(userArtifact).toMatchObject({
      configDigest: expect.stringMatching(/^sha256:/),
      contentDigest: expect.stringMatching(/^sha256:/),
    });
    expect(projectArtifact).toMatchObject({
      configDigest: expect.stringMatching(/^sha256:/),
      contentDigest: expect.stringMatching(/^sha256:/),
    });
    expect(userRecord.record.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill' && artifact.target === 'codex.skill')).toMatchObject({
      configDigest: userArtifact.configDigest,
      contentDigest: userArtifact.contentDigest,
    });
    expect(projectRecord.record.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill' && artifact.target === 'codex.skill')).toMatchObject({
      configDigest: projectArtifact.configDigest,
      contentDigest: projectArtifact.contentDigest,
    });
    await expect(fs.pathExists(path.join(resolveCodexPaths(repoRoot, 'user', process.env).configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(resolveCodexPaths(repoRoot, 'project', process.env).configDir, 'agents', 'aw-codex-explore-codex-explorer.toml'))).resolves.toBe(false);
  }, 15_000);

  it('keeps previous Codex user dynamic skill runtime and cache when historical refresh fails, and records failure diagnostics', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreDynamicSkillRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const beforeRuntimeSkill = await fs.readFile(userDynamicSkillPath(awHome), 'utf8');
    const beforeCachedSkill = await fs.readFile(cachedDynamicSkillPath(process.env), 'utf8');
    const statusBefore = await statusCommand(
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
    const locationBefore = findStatusLocation(parseStatusPayload(statusBefore.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const record = await fs.readJson(locationBefore.record!.path!) as {
      record: {
        source: {
          bundleFingerprint: string;
        };
        lifecycle: {
          bundleRoot: string;
          bundleFingerprint: string;
        };
      };
    };
    await fs.writeFile(
      path.join(record.record.lifecycle.bundleRoot, 'scripts', 'render-artifacts.mjs'),
      'throw new Error("forced historical renderer failure");\n',
      'utf8',
    );
    const bundleFingerprint = await calculatePluginBundleFingerprint(record.record.lifecycle.bundleRoot);
    record.record.lifecycle.bundleFingerprint = bundleFingerprint;
    record.record.source.bundleFingerprint = bundleFingerprint;
    await fs.writeJson(locationBefore.record!.path!, record, { spaces: 2 });

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
      },
    });

    const [afterRuntimeSkill, afterCachedSkill, statusResult] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(cachedDynamicSkillPath(process.env), 'utf8'),
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
    const location = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const skillArtifact = findDynamicDiagnosticEntry(location, 'codex-explore-skill');

    expect(afterRuntimeSkill).toBe(beforeRuntimeSkill);
    expect(afterCachedSkill).toBe(beforeCachedSkill);
    expect(skillArtifact.lastRefresh).toMatchObject({
      status: 'failed',
      event: 'config',
    });
    expect(findIssueCodes(location, 'dynamicRefreshFailed').length).toBeGreaterThanOrEqual(1);
  });

  it('shows codex.skill expected-tree diff sources in diagnose --deep without rewriting accepted cache state', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const statusBefore = await statusCommand(
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
    const locationBefore = findStatusLocation(parseStatusPayload(statusBefore.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    await alignUserRecordSourceToWorkspacePlugin(repoRoot, locationBefore.record!.path!);
    const acceptedBefore = findDynamicDiagnosticEntry(locationBefore, 'codex-explore-skill');
    const currentPlugin: PluginMeta = {
      rootDir: path.join(repoRoot, 'plugins', 'codex-explore'),
      manifestPath: path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json'),
      manifest: await fs.readJson(path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json')),
    };

    await fs.appendFile(userDynamicSkillPath(awHome), '\n# local drift\n', 'utf8');

    const result = await diagnoseCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
        deep: true,
      },
      {
        env: process.env,
        p7Targets: [{
          pluginName: 'codex-explore',
          platform: 'codex',
          scope: 'user',
          executionCwd: repoRoot,
          currentPlugin,
        }],
      },
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        findings: string[];
        deepDiagnose: {
          rendered: boolean;
          artifacts: Array<{
            id: string;
            target: string;
            artifactKey?: string;
            triggerPreference?: string;
            drift?: boolean;
            driftReasons?: string[];
            fileDiffs?: Array<{ path: string; reason: string }>;
          }>;
        };
      }>;
    };
    const deepSkill = payload.locations[0]?.deepDiagnose.artifacts.find((artifact) => artifact.id === 'codex-explore-skill');
    expect(payload.locations[0]?.deepDiagnose.rendered).toBe(true);
    expect(deepSkill).toMatchObject({
      target: 'codex.skill',
      artifactKey: 'codex-explore',
      drift: true,
    });
    expect(deepSkill?.triggerPreference).toEqual(expect.any(String));
    expect(deepSkill?.driftReasons).toContain('文件内容已漂移 SKILL.md');
    expect(deepSkill?.fileDiffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'SKILL.md',
          reason: 'contentMismatch',
        }),
      ]),
    );
    expect(payload.locations[0]?.findings.join('\n')).toContain('expected tree');

    const statusAfter = await statusCommand(
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
    const locationAfter = findStatusLocation(parseStatusPayload(statusAfter.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    expect(findDynamicDiagnosticEntry(locationAfter, 'codex-explore-skill')).toMatchObject({
      configDigest: acceptedBefore.configDigest,
      contentDigest: acceptedBefore.contentDigest,
    });
  }, 15_000);

  it('repair re-renders codex.skill from current config and current built-in trigger resolution, and prunes stale native cache runtime files', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

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
    await fs.writeFile(userDynamicSkillPath(awHome), '# stale runtime\n', 'utf8');

    const statusBeforeRepair = await statusCommand(
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
    const repairLocation = findStatusLocation(parseStatusPayload(statusBeforeRepair.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    await alignUserRecordSourceToWorkspacePlugin(repoRoot, repairLocation.record!.path!);

    const currentPlugin: PluginMeta = {
      rootDir: path.join(repoRoot, 'plugins', 'codex-explore'),
      manifestPath: path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json'),
      manifest: await fs.readJson(path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json')),
    };

    const result = await runRepairWorkflow(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        ...createCodexExploreRuntime(repoRoot, process.env),
        p7Targets: [{
          pluginName: 'codex-explore',
          platform: 'codex',
          scope: 'user',
          executionCwd: repoRoot,
          currentPlugin,
        }],
        p8CurrentPluginsByName: {
          'codex-explore': currentPlugin,
        },
      },
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        triggerPreferenceApplied?: string | null;
        dynamicArtifacts?: Array<{
          id: string;
          target: string;
          artifactKey?: string;
          configDigest?: string;
          contentDigest?: string;
        }>;
      }>;
    };
    const repairedSkill = payload.locations[0]?.dynamicArtifacts?.find((artifact) => artifact.id === 'codex-explore-skill');
    expect(payload.locations[0]?.triggerPreferenceApplied).toBe('auto');
    expect(repairedSkill).toMatchObject({
      target: 'codex.skill',
      artifactKey: 'codex-explore',
      configDigest: expect.stringMatching(/^sha256:/),
      contentDigest: expect.stringMatching(/^sha256:/),
    });

    const [runtimeSkill, runtimeAllowsImplicitInvocation, statusResult] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      readAllowImplicitInvocation(userSkillMetadataPath(awHome)),
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
    const location = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const statusSkill = findDynamicDiagnosticEntry(location, 'codex-explore-skill');

    expect(runtimeSkill).toContain('model=gpt-5.5');
    expect(runtimeSkill).toContain('reasoning=high');
    await expect(fs.readFile(cachedDynamicSkillPath(process.env), 'utf8')).resolves.toContain('model=gpt-5.5');
    await expect(readAllowImplicitInvocation(cachedDynamicSkillMetadataPath(process.env))).resolves.toBe(true);
    expect(runtimeAllowsImplicitInvocation).toBe(true);
    expect(statusSkill).toMatchObject({
      configDigest: repairedSkill?.configDigest,
      contentDigest: repairedSkill?.contentDigest,
    });
  });

  it('repair preserves explicit auto trigger preference for Codex user dynamic skill', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    await fs.writeFile(userDynamicSkillPath(awHome), '# stale runtime\n', 'utf8');

    const statusBeforeRepair = await statusCommand(
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
    const repairLocation = findStatusLocation(parseStatusPayload(statusBeforeRepair.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    await alignUserRecordSourceToWorkspacePlugin(repoRoot, repairLocation.record!.path!);

    const currentPlugin: PluginMeta = {
      rootDir: path.join(repoRoot, 'plugins', 'codex-explore'),
      manifestPath: path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json'),
      manifest: await fs.readJson(path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json')),
    };
    const result = await runRepairWorkflow(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        ...createCodexExploreRuntime(repoRoot, process.env),
        p7Targets: [{
          pluginName: 'codex-explore',
          platform: 'codex',
          scope: 'user',
          executionCwd: repoRoot,
          currentPlugin,
        }],
        p8CurrentPluginsByName: {
          'codex-explore': currentPlugin,
        },
      },
    );
    const payload = JSON.parse(result.output) as {
      locations: Array<{
        triggerPreferenceApplied?: string | null;
      }>;
    };

    const statusAfterRepair = await statusCommand(
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
    const location = findStatusLocation(parseStatusPayload(statusAfterRepair.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const recordOptions = await readInstallRecordOptionsFromLocation(location);

    expect(payload.locations[0]?.triggerPreferenceApplied).toBe('auto');
    expect(recordOptions.skillTriggerPreference).toBe('auto');
    await expect(readAllowImplicitInvocation(userSkillMetadataPath(awHome))).resolves.toBe(true);
    await expect(readAllowImplicitInvocation(cachedDynamicSkillMetadataPath(process.env))).resolves.toBe(true);
  });

  it('project repair fails with duplicateInstall in a legacy dual-healthy sibling state and leaves trigger preferences untouched', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await seedLegacyCodexExploreUserHealthySiblingInstall({
      repoRoot,
      awHome,
      codexHome,
      embeddedRoot,
      requestedSkillTrigger: 'manual',
    });

    expect(await readAllowImplicitInvocation(userSkillMetadataPath(awHome))).toBe(false);
    expect(await readAllowImplicitInvocation(projectSkillMetadataPath(repoRoot))).toBe(true);

    const statusBeforeRepair = await statusCommand(
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
    const repairLocation = findStatusLocation(parseStatusPayload(statusBeforeRepair.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    await alignUserRecordSourceToWorkspacePlugin(repoRoot, repairLocation.record!.path!);

    const currentPlugin: PluginMeta = {
      rootDir: path.join(repoRoot, 'plugins', 'codex-explore'),
      manifestPath: path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json'),
      manifest: await fs.readJson(path.join(repoRoot, 'plugins', 'codex-explore', '.agents-plugin', 'plugin.json')),
    };
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await expect(runRepairWorkflow(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: process.env,
        p7Targets: [{
          pluginName: 'codex-explore',
          platform: 'codex',
          scope: 'project',
          projectKey,
          executionCwd: repoRoot,
          currentPlugin,
        }],
        p8CurrentPluginsByName: {
          'codex-explore': currentPlugin,
        },
      },
    )).rejects.toThrow(/duplicateInstall/);

    const statusAfterRepair = await statusCommand(
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
    const location = findStatusLocation(parseStatusPayload(statusAfterRepair.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const recordOptions = await readInstallRecordOptionsFromLocation(location);

    expect(recordOptions.skillTriggerPreference).toBe('auto');
    expect(await readAllowImplicitInvocation(projectSkillMetadataPath(repoRoot))).toBe(true);
    expect(await readAllowImplicitInvocation(userSkillMetadataPath(awHome))).toBe(false);
  });

  it('uninstalls only the AW-owned Codex user dynamic skill, restores bundled templates, and can reinstall cleanly', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSkillOnlyArtifact(repoRoot);
    await writeCodexExploreSkillOnlyRenderer(repoRoot);
    const rebuiltEmbeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot: rebuiltEmbeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const foreignRuntimeSkillPath = path.join(
      awHome,
      'plugins',
      'foreign-plugin',
      'codex',
      'skills',
      'codex-explore',
      'SKILL.md',
    );
    const foreignCachedSkillPath = path.join(
      codexExploreNativeCachePath(process.env, 'foreign-plugin'),
      'codex',
      'skills',
      'codex-explore',
      'SKILL.md',
    );
    await fs.outputFile(foreignRuntimeSkillPath, '# foreign runtime\n', 'utf8');
    await fs.outputFile(foreignCachedSkillPath, '# foreign cache\n', 'utf8');

    await uninstallCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    await expect(fs.pathExists(userDynamicSkillPath(awHome))).resolves.toBe(false);
    await expect(fs.pathExists(userSkillMetadataPath(awHome))).resolves.toBe(false);
    await expect(fs.pathExists(cachedDynamicSkillPath(process.env))).resolves.toBe(false);
    await expect(fs.readFile(foreignRuntimeSkillPath, 'utf8')).resolves.toBe('# foreign runtime\n');
    await expect(fs.readFile(foreignCachedSkillPath, 'utf8')).resolves.toBe('# foreign cache\n');

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    await expect(fs.readFile(userDynamicSkillPath(awHome), 'utf8')).resolves.toContain('Dynamic Explore');
    await expect(fs.readFile(cachedDynamicSkillPath(process.env), 'utf8')).resolves.toContain('Dynamic Explore');
    await expect(readAllowImplicitInvocation(userSkillMetadataPath(awHome))).resolves.toBe(false);
  });

  it('prunes stale Codex user dynamic skills by identity during upgrade and leaves foreign same-name skills untouched', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSingleSkillArtifact({
      rootDir: repoRoot,
      id: 'codex-explore-skill',
      skillKey: 'codex-explore',
    });
    await writeCodexExploreSingleSkillRenderer({
      rootDir: repoRoot,
      id: 'codex-explore-skill',
      skillKey: 'codex-explore',
      title: 'Dynamic Explore V1',
    });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const foreignRuntimeSkillPath = path.join(
      awHome,
      'plugins',
      'foreign-plugin',
      'codex',
      'skills',
      'codex-explore',
      'SKILL.md',
    );
    const foreignCachedSkillPath = path.join(
      codexExploreNativeCachePath(process.env, 'foreign-plugin'),
      'codex',
      'skills',
      'codex-explore',
      'SKILL.md',
    );
    await fs.outputFile(foreignRuntimeSkillPath, '# foreign runtime\n', 'utf8');
    await fs.outputFile(foreignCachedSkillPath, '# foreign cache\n', 'utf8');

    await configureCodexExploreSingleSkillArtifact({
      rootDir: repoRoot,
      id: 'codex-explore-skill-v2',
      skillKey: 'codex-explore-v2',
    });
    await writeCodexExploreSingleSkillRenderer({
      rootDir: repoRoot,
      id: 'codex-explore-skill-v2',
      skillKey: 'codex-explore-v2',
      title: 'Dynamic Explore V2',
    });
    await rebuildEmbeddedRoot(repoRoot);

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const trackingArtifacts = (await readTrackingManifest(userPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];
    const statusResult = await statusCommand(
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
    const location = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });

    await expect(fs.pathExists(userDynamicSkillPath(awHome, 'codex-explore'))).resolves.toBe(false);
    await expect(fs.pathExists(cachedDynamicSkillPath(process.env, 'codex-explore'))).resolves.toBe(false);
    await expect(fs.readFile(userDynamicSkillPath(awHome, 'codex-explore-v2'), 'utf8')).resolves.toContain(
      'Dynamic Explore V2',
    );
    await expect(fs.readFile(cachedDynamicSkillPath(process.env, 'codex-explore-v2'), 'utf8')).resolves.toContain(
      'Dynamic Explore V2',
    );
    await expect(readAllowImplicitInvocation(userSkillMetadataPath(awHome, 'codex-explore-v2'))).resolves.toBe(false);
    await expect(fs.readFile(foreignCachedSkillPath, 'utf8')).resolves.toBe('# foreign cache\n');
    expect(trackingArtifacts.find((artifact) => artifact.id === 'codex-explore-skill-v2')).toMatchObject({
      id: 'codex-explore-skill-v2',
      target: 'codex.skill',
      artifactKey: 'codex-explore-v2',
    });
    expect(location.dynamicDiagnostic?.entries?.map((entry) => entry.id)).toContain('codex-explore-skill-v2');
    expect(findIssueCodes(location, 'artifactMissing')).toEqual([]);
  });

  it('cleans up residual project dynamic skills without restoring static materialization or removed instruction-role artifacts', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await configureCodexExploreSingleSkillArtifact({
      rootDir: repoRoot,
      id: 'codex-explore-skill',
      skillKey: 'codex-explore',
    });
    await writeCodexExploreSingleSkillRenderer({
      rootDir: repoRoot,
      id: 'codex-explore-skill',
      skillKey: 'codex-explore',
      title: 'Cleanup Residual Skill',
    });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const beforeStatus = await statusCommand(
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
    const beforeLocation = findStatusLocation(parseStatusPayload(beforeStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const projectSkillRoot = path.join(repoRoot, '.agents', 'skills', 'codex-explore');

    expect(beforeLocation.record?.path).toBeTruthy();
    await fs.remove(beforeLocation.record!.path!);
    await fs.remove(path.join(awHome, 'dependency-index', 'index.json'));

    await cleanupCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        force: true,
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(projectSkillMetadataPath(repoRoot))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(resolveCodexPaths(repoRoot, 'project', process.env).configDir, 'agents'))).resolves.toBe(false);

    const afterStatus = await statusCommand(
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
    const afterLocation = findStatusLocation(parseStatusPayload(afterStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    expect(afterLocation.state).toBe('notInstalled');
    expect(afterLocation.dynamicDiagnostic?.entries ?? []).toEqual([]);
  });


  it('installs Codex project scope with repo-managed skill and project-only artifacts without enabling the user native plugin', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env, nativeCalls),
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const skillPath = path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md');
    const skillMetadataPath = projectSkillMetadataPath(repoRoot);
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explore-agent.toml');
    const skillContent = await fs.readFile(skillPath, 'utf8');
    const projectConfig = await readCodexConfigFile(projectPaths.configTomlPath);
    const roleContent = await fs.readFile(rolePath, 'utf8');
    const trackedArtifacts = (await readTrackingManifest(projectPaths.trackingDir)).plugins['codex-explore']?.artifacts ?? [];

    expect(nativeCalls).toEqual([
      expect.objectContaining({
        command: 'codex',
        args: ['--version'],
      }),
    ]);
    expect(projectConfig.snapshot.agents['codex-explore-agent']).toEqual({
      key: 'codex-explore-agent',
      description: '只读探索代码、文档、网页和长上下文，并整理关键证据。',
      configFile: 'agents/aw-codex-explore-codex-explore-agent.toml',
    });
    await expect(fs.pathExists(skillPath)).resolves.toBe(true);
    await expect(fs.pathExists(skillMetadataPath)).resolves.toBe(true);
    await expect(fs.readFile(skillMetadataPath, 'utf8')).resolves.toContain(
      'allow_implicit_invocation: true',
    );
    expect(skillContent).toContain('探索子代理');
    expect(skillContent).toContain('默认使用 Codex Explore 自带的探索子代理');
    expect(skillContent).toContain('不要改用 Codex 内置 `explorer`');
    expect(skillContent).toContain('agent_type: "codex-explore-agent"');
    expect(skillContent).toContain('默认模型 `gpt-5.5`');
    expect(skillContent).toContain('推理强度 `xhigh`');
    expect(skillContent).toContain('`close_agent` 关闭本 workflow 启动的子代理');
    expect(roleContent).toContain('name = "codex-explore-agent"');
    expect(roleContent).toContain('model = "gpt-5.5"');
    expect(roleContent).toContain('model_reasoning_effort = "xhigh"');
    expect(trackedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'codex-explore-skill',
        target: 'codex.skill',
        state: 'present',
        artifactKey: 'codex-explore',
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({
        id: 'codex-explore-agent-role',
        target: 'codex.agentRole',
        state: 'present',
        artifactKey: 'codex-explore-agent',
        roleKey: 'codex-explore-agent',
        configDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      }),
    ]));

    if (await fs.pathExists(userPaths.configTomlPath)) {
      await expect(fs.readFile(userPaths.configTomlPath, 'utf8')).resolves.not.toContain(
        '[plugins."codex-explore@aw"]',
      );
    }
  });

  it.skip('installs disabled lightweight instruction by removing the managed block and keeping status out of missing state', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    const location = findStatusLocation(parseStatusPayload(result.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const instructionArtifact = findDynamicDiagnosticEntry(location, 'lightweight-instruction');

    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeUndefined();
    expect(instructionArtifact).toMatchObject({
      id: 'lightweight-instruction',
      state: 'disabled',
      disabledReason: 'config',
    });
  });

  it.skip('upgrades a disabled rendered role by removing the managed registration and role layer while keeping status out of missing state', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    await rebuildEmbeddedRoot(repoRoot);

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    await rebuildEmbeddedRoot(repoRoot);

    await upgradeCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    const location = findStatusLocation(parseStatusPayload(result.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const roleArtifact = findDynamicDiagnosticEntry(location, 'codex-explorer-role');

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
      disabledReason: 'config',
    });
  });

  it.skip('fails user install role preflight before config prompt, renderer, native enable, or any writes', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await addRequiredTokenConfigToCodexExplore(repoRoot);
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    await writeCodexExploreLifecycleRecorder(repoRoot, 'lifecycle.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
            ...createCodexExploreRuntime(repoRoot, process.env, nativeCalls),
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
          },
        ),
      ),
    ).rejects.toThrow('最终 role 名为 "codex-explorer"');

    expect(configureCalls).toBe(0);
    expect(nativeCalls.filter((call) => call.args[0] === 'plugin')).toHaveLength(0);
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'lifecycle.log'))).resolves.toBe(false);
  });

  it('keeps $codex-explore auto-triggerable under the default built-in trigger policy on project install', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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

    const location = findStatusLocation(parseStatusPayload(result.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    expect(location.record?.present).toBe(true);
  });

  it('reports artifact health, projectTrust, and session visibility in status JSON for Codex project scope', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    const payload = JSON.parse(result.output) as StatusPayload;
    const plugin = payload.reports[0]?.plugins[0];
    const location = findStatusLocation(payload, {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    const skillArtifact = findDynamicDiagnosticEntry(location, 'codex-explore-skill');
    const roleArtifact = findDynamicDiagnosticEntry(location, 'codex-explore-agent-role');

    expect(plugin?.projectTrust).toBe('unknown');
    expect(location.dynamicDiagnostic?.available).toBe(true);
    expect(location.state).toBe('installed');
    expect(skillArtifact).toMatchObject({
      state: 'present',
    });
    expect(roleArtifact).toMatchObject({
      state: 'present',
      roleKey: 'codex-explore-agent',
    });
    expect(findIssueCodes(location, 'dynamicContentDrift')).toHaveLength(0);
  });

  it.skip('explains invisible reasons in human verbose status for repo trust and higher-priority session layers', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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

    const projectPayload = parseVerboseStatusPayload(projectVerbose.output);
    const projectLocation = findStatusLocation(projectPayload, {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    });
    expect(projectPayload.friendlySummaries?.[0]).toMatchObject({
      pluginName: 'codex-explore',
      status: 'needsAction',
      location: 'Codex（当前项目）',
      issueSummary: '动态内容和上次接受的结果不一致。',
    });
    expect(projectLocation.state).toBe('needsRepair');
    expect(projectLocation.nextSteps).toEqual(expect.arrayContaining([
      'aw repair codex-explore -p codex -s project',
      'aw cleanup codex-explore -p codex -s project',
    ]));

    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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

    const userPayload = parseVerboseStatusPayload(userVerbose.output);
    expect(userPayload.friendlySummaries?.[0]).toMatchObject({
      pluginName: 'codex-explore',
      status: 'needsAction',
      location: 'Codex（个人）',
      issueSummary: '动态内容和上次接受的结果不一致。',
    });
    expect(userPayload.consoleItems?.[0]?.reasonCodes).toContain('artifactDrift');
  });

  it.skip('uninstalls historical Codex project artifacts when tracking can recover roleKey from artifactKey', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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

    await expect(
      uninstallCommand(
        ['codex-explore'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        createCodexExploreRuntime(repoRoot, process.env),
      ),
    ).rejects.toThrow('当前不是健康 installed 状态，请先运行 aw cleanup。');

    const projectConfig = await readCodexConfigFile(projectPaths.configTomlPath);
    const rolePath = path.join(projectPaths.configDir, 'agents', 'aw-codex-explore-codex-explorer.toml');
    const afterTracking = await readTrackingManifest(projectPaths.trackingDir);

    expect(projectConfig.snapshot.developerInstructions.managedBlocks['codex-explore']).toBeDefined();
    expect(projectConfig.snapshot.agents['codex-explorer']).toBeDefined();
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(afterTracking.plugins['codex-explore']).toBeDefined();
  });

  it.skip('re-renders Codex user scope artifacts on upgrade using the latest default+user config, without reading project config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
      createCodexExploreRuntime(repoRoot, process.env),
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

  it.skip('fails user upgrade role preflight before config prompt, renderer, or any writes', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await addRequiredTokenConfigToCodexExplore(repoRoot);
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    await writeCodexExploreLifecycleRecorder(repoRoot, 'lifecycle.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
            ...createCodexExploreRuntime(repoRoot, process.env, nativeCalls),
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
          },
        ),
      ),
    ).rejects.toThrow('最终 role 名为 "codex-explorer"');

    expect(configureCalls).toBe(0);
    expect(nativeCalls.filter((call) => call.args[0] === 'plugin')).toHaveLength(0);
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'lifecycle.log'))).resolves.toBe(false);
  });

  it.skip('re-renders Codex project scope artifacts on upgrade using the latest default+user+project config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
      createCodexExploreRuntime(repoRoot, process.env),
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

  it.skip('refreshes installed user and current-project Codex dynamic artifacts on user config writes', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    expect(result.parseJsonStdout<{
      artifactRefresh: {
        artifacts: Array<{ scope: Scope }>;
        scopeReach?: {
          refreshedUserTarget?: boolean;
          refreshedCurrentProjectTarget?: boolean;
        };
      };
    }>().artifactRefresh).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ scope: 'user' }),
        expect.objectContaining({ scope: 'project' }),
      ]),
      scopeReach: {
        refreshedUserTarget: true,
        refreshedCurrentProjectTarget: true,
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

  it('refreshes only current-project artifacts on project config writes and leaves legacy user sibling artifacts healthy', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await seedLegacyCodexExploreUserHealthySiblingInstall({
      repoRoot,
      awHome,
      codexHome,
      embeddedRoot,
    });

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const userTrackingBefore = await readTrackingManifest(userPaths.trackingDir);

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

    const [userSkillContent, projectSkillContent, userStatus, userTrackingAfter] = await Promise.all([
      fs.readFile(userDynamicSkillPath(awHome), 'utf8'),
      fs.readFile(path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
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
    ]);

    expect(userSkillContent).toContain('推理强度 `medium`');
    expect(projectSkillContent).toContain('推理强度 `low`');
    expect(userTrackingAfter.plugins['codex-explore']).toEqual(userTrackingBefore.plugins['codex-explore']);
    expect(findDynamicDiagnosticEntry(findStatusLocation(parseStatusPayload(userStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    }), 'codex-explore-skill')).toMatchObject({
      state: 'present',
    });
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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

  it('refreshes Codex project artifacts through config set and writes updated digests back to tracking', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const beforeTracking = await readTrackingManifest(projectPaths.trackingDir);
    const beforeSkillDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill')?.configDigest;

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
      updatedKeys: ['modelReasoningEffort'],
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['modelReasoningEffort'],
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            scope: 'project',
            id: 'codex-explore-skill',
          }),
        ]),
      },
    });

    const [skillContent, afterTracking, projectStatus] = await Promise.all([
      fs.readFile(path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
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
    const trackedSkill = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill');

    expect(skillContent).toContain('推理强度 `low`');
    expect(trackedSkill).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(trackedSkill?.configDigest).not.toBe(beforeSkillDigest);
    expect(findDynamicDiagnosticEntry(findStatusLocation(parseStatusPayload(projectStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    }), 'codex-explore-skill')).toMatchObject({
      state: 'present',
    });
  });

  it.skip('re-enables lightweight instruction through config unset and rewrites the managed block from current render config', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    expect(findDynamicDiagnosticEntry(
      findStatusLocation(parseStatusPayload(userStatus.output), {
        plugin: 'codex-explore',
        platform: 'codex',
        scope: 'user',
      }),
      'lightweight-instruction',
    )).toMatchObject({
      state: 'present',
    });
  });

  it('refreshes tracked artifacts through config reset and restores default render output', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const projectPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const beforeTracking = await readTrackingManifest(projectPaths.trackingDir);
    const beforeSkillDigest = beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill')?.configDigest;

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
        triggerKeys: ['explorerModel', 'modelReasoningEffort'],
      },
    });

    const projectStorePath = path.join(repoRoot, '.agent-workflows', 'plugin-config', 'codex-explore', 'config.json');
    const [skillContent, afterTracking, projectStatus] = await Promise.all([
      fs.readFile(path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
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
    const trackedSkill = afterTracking.plugins['codex-explore']?.artifacts.find((artifact) =>
      artifact.id === 'codex-explore-skill');

    await expect(fs.pathExists(projectStorePath)).resolves.toBe(false);
    expect(skillContent).toContain('默认模型 `gpt-5.4-mini`');
    expect(skillContent).toContain('推理强度 `low`');
    expect(trackedSkill).toMatchObject({
      state: 'present',
      lastRefresh: {
        status: 'succeeded',
        event: 'refresh',
        triggerKeys: ['explorerModel', 'modelReasoningEffort'],
      },
    });
    expect(trackedSkill?.configDigest).not.toBe(beforeSkillDigest);
    expect(findDynamicDiagnosticEntry(findStatusLocation(parseStatusPayload(projectStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'project',
    }), 'codex-explore-skill')).toMatchObject({
      state: 'present',
    });
  });

  it('does not run lifecycle scripts during config-triggered refresh', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeCodexExploreLifecycleRecorder(repoRoot);
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const lifecycleLogPath = path.join(awHome, 'lifecycle.log');
    expect((await fs.readFile(lifecycleLogPath, 'utf8')).trim().split('\n').filter(Boolean)).toEqual(['install']);
    installCodexExploreRefreshAppServerOverride(repoRoot, process.env);

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await fs.outputFile(
      path.join(repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
      'shadow project skill\n',
    );
    installCodexExploreRefreshAppServerOverride(repoRoot, process.env);

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

  it.skip('keeps the config store and skips renderer/project artifact writes when project preflight fails during refresh', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
    });
    expect(afterTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')).toMatchObject({
      configDigest: beforeRoleDigest,
    });
  });

  it('records only the current repo in refreshReach while flagging other known legacy project installs as potentially stale', async () => {
    const { repoA, repoB, awHome, codexHome, embeddedRoot } = await makeMultiRepoWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoA,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoA, process.env),
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoB,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoB, process.env),
    );
    await seedLegacyCodexExploreUserHealthySiblingInstall({
      repoRoot: repoA,
      awHome,
      codexHome,
      embeddedRoot,
    });
    installCodexExploreRefreshAppServerOverride(repoA, process.env);

    const repoAUserPaths = resolveCodexPaths(repoA, 'user', process.env);
    const repoAProjectPaths = resolveCodexPaths(repoA, 'project', process.env);
    const repoBProjectPaths = resolveCodexPaths(repoB, 'project', process.env);
    const beforeRepoBTracking = await readTrackingManifest(repoBProjectPaths.trackingDir);
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
      },
    });
    expect(result.parseJsonStdout<{
      artifactRefresh: {
        artifacts: Array<{ scope: Scope }>;
        scopeReach?: {
          refreshedUserTarget?: boolean;
          refreshedCurrentProjectTarget?: boolean;
          historicalProjectTargetsMayBeStale?: boolean;
          knownProjectTargetsOutsideReach?: string[];
        };
      };
    }>().artifactRefresh.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user' }),
      expect.objectContaining({ scope: 'project' }),
    ]));

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
      historicalProjectTargetsMayBeStale: false,
      knownProjectTargetsOutsideReach: [],
    };

    expect(repoAUserTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explore-skill')).toMatchObject({
      refreshReach: expectedReach,
    });
    expect(repoAProjectTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explore-skill')).toMatchObject({
      refreshReach: expectedReach,
    });
    expect(repoBTrackingAfter.plugins['codex-explore']).toEqual(beforeRepoBTracking.plugins['codex-explore']);
    expect(findDynamicDiagnosticEntry(
      findStatusLocation(parseStatusPayload(repoAUserStatus.output), {
        plugin: 'codex-explore',
        platform: 'codex',
        scope: 'user',
      }),
      'codex-explore-skill',
    )).toMatchObject({
      refreshReach: {
        commandScope: 'user',
        refreshedUserTarget: true,
        refreshedCurrentProjectTarget: true,
      },
    });
  });

  it.skip('keeps the config store when refresh fails and records recent refresh failure diagnostics', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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

  it.skip('keeps already-committed user scope refresh artifacts when the current project refresh unit fails later', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
      },
    });
    expect(result.parseJsonStdout<{
      artifactRefresh: {
        artifacts: Array<{ scope: Scope; status: 'succeeded' | 'failed' }>;
      };
    }>().artifactRefresh.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user', status: 'succeeded' }),
      expect.objectContaining({ scope: 'project', status: 'failed' }),
    ]));

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
    expect(userRoleTrackingAfter?.lastRefresh?.status).toBe('succeeded');
    expect(findDynamicDiagnosticEntry(findStatusLocation(parseStatusPayload(userStatus.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    }), 'codex-explorer-role')).toMatchObject({
      state: 'present',
    });
    expect(findIssueCodes(
      findStatusLocation(parseStatusPayload(projectStatus.output), {
        plugin: 'codex-explore',
        platform: 'codex',
        scope: 'project',
      }),
      'dynamicContentDrift',
    )).not.toHaveLength(0);
  });

  it.skip('detects multi-instruction managed block drift before refresh runs the renderer', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await addCodexExploreRoleGuidanceInstructionArtifact(repoRoot);
    await writeMultiInstructionCodexExploreRenderer(repoRoot, 'artifact-render.log');
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
    );

    const userPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const tracking = await readTrackingManifest(userPaths.trackingDir);
    const instructionArtifacts = tracking.plugins['codex-explore']?.artifacts.filter((artifact) =>
      artifact.target === 'codex.developerInstructionsBlock') ?? [];
    const contentDigests = instructionArtifacts.map((artifact) => artifact.contentDigest);
    expect(instructionArtifacts.map((artifact) => artifact.id)).toEqual([
      'lightweight-instruction',
      'role-guidance',
    ]);
    expect(contentDigests.every(Boolean)).toBe(true);
    expect(new Set(contentDigests).size).toBe(1);

    const config = await readCodexConfigFile(userPaths.configTomlPath);
    expect(config.snapshot.developerInstructions.managedBlocks['codex-explore']?.value.trim().split('\n\n')).toEqual([
      expect.stringMatching(/^multi lightweight .+ medium$/),
      'multi role guidance medium',
    ]);

    const baselineConfig = await fs.readFile(userPaths.configTomlPath, 'utf8');
    await fs.writeFile(
      userPaths.configTomlPath,
      baselineConfig.replace('multi role guidance medium', 'multi role guidance medium edited'),
      'utf8',
    );

    const statusResult = await statusCommand(
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
    const statusLocation = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const instructionStatuses = statusLocation.dynamicDiagnostic?.entries?.filter((artifact) =>
      artifact.target === 'codex.developerInstructionsBlock') ?? [];
    expect(instructionStatuses).toHaveLength(2);
    expect(instructionStatuses.map((artifact) => artifact.id)).toEqual([
      'lightweight-instruction',
      'role-guidance',
    ]);
    expect(findIssueCodes(statusLocation, 'dynamicContentDrift').length).toBeGreaterThanOrEqual(2);

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
    await expect(fs.pathExists(path.join(awHome, 'artifact-render.log'))).resolves.toBe(false);
    await expect(fs.readFile(userPaths.configTomlPath, 'utf8')).resolves.toContain(
      'multi role guidance medium edited',
    );
  });

  it.skip('fails refresh on role layer content drift before renderer, keeps the user-edited role file, and records failed refresh metadata', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspaceWithCodexExplore();
    await writeRecordingCodexExploreRenderer(repoRoot, { logFileName: 'artifact-render.log' });
    const embeddedRoot = await rebuildEmbeddedRoot(repoRoot);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    const statusLocation = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const roleStatus = findDynamicDiagnosticEntry(statusLocation, 'codex-explorer-role');

    expect(roleArtifact).toMatchObject({
      configDigest: beforeTracking.plugins['codex-explore']?.artifacts.find((artifact) => artifact.id === 'codex-explorer-role')?.configDigest,
      lastRefresh: {
        status: 'failed',
        event: 'refresh',
        triggerKeys: ['modelReasoningEffort'],
      },
    });
    expect(findIssueCodes(statusLocation, 'dynamicContentDrift')).not.toHaveLength(0);
    expect(roleStatus.lastRefresh).toMatchObject({
      status: 'failed',
      event: 'config',
      error: expect.stringContaining('tracking contentDigest 不一致'),
    });
  });

  it.skip('keeps the config store and reports recent refresh failure when renderer returns an invalid refresh plan', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    activateCliEmbeddedRoot(refreshedEmbeddedRoot, 'codex explore refreshed embedded root');

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
    const statusLocation = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const roleStatus = findDynamicDiagnosticEntry(statusLocation, 'codex-explorer-role');

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
    expect(findIssueCodes(statusLocation, 'dynamicRefreshFailed')).not.toHaveLength(0);
    expect(roleStatus.lastRefresh).toMatchObject({
      status: 'failed',
      event: 'config',
      error: expect.stringContaining('expected "codex-explorer" from static metadata'),
    });
  });

  it.skip('rolls back already-written role artifacts when refresh apply fails mid-flight and keeps status diagnosable', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
      createCodexExploreRuntime(repoRoot, process.env),
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
    const statusLocation = findStatusLocation(parseStatusPayload(statusResult.output), {
      plugin: 'codex-explore',
      platform: 'codex',
      scope: 'user',
    });
    const roleStatus = findDynamicDiagnosticEntry(statusLocation, 'codex-explorer-role');

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
    expect(findIssueCodes(statusLocation, 'dynamicRefreshFailed')).not.toHaveLength(0);
    expect(roleStatus.lastRefresh).toMatchObject({
      status: 'failed',
      event: 'config',
      error: expect.stringContaining('forced config write failure during refresh'),
    });
  });

  it.skip('reinstalls capabilityChanged Codex project artifacts with new dynamic ids and role identity, and prunes old residues', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspaceWithCodexExplore();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await installCommand(
      ['codex-explore'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      createCodexExploreRuntime(repoRoot, process.env),
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
      createCodexExploreRuntime(repoRoot, process.env),
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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
