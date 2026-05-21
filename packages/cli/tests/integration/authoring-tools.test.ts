import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';
import {
  createDependencySiblingManifest,
  pluginDependencyValidatorParityCases,
} from '../support/plugin-dependency-validator-parity.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const DEFAULT_AUTHORING_PLUGIN_AW_MIN_VERSION = '0.0.0';

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

function extractJsonFenceAfter(document: string, heading: string): unknown {
  const headingIndex = document.indexOf(heading);
  expect(headingIndex).toBeGreaterThanOrEqual(0);
  const fenceStart = document.indexOf('```json', headingIndex);
  expect(fenceStart).toBeGreaterThanOrEqual(0);
  const jsonStart = document.indexOf('\n', fenceStart) + 1;
  const fenceEnd = document.indexOf('```', jsonStart);
  expect(fenceEnd).toBeGreaterThanOrEqual(0);
  return JSON.parse(document.slice(jsonStart, fenceEnd));
}

function withDefaultCompatibility<T extends Record<string, unknown>>(manifest: T): T {
  if (Object.prototype.hasOwnProperty.call(manifest, 'compatibility')) {
    return manifest;
  }

  return {
    ...manifest,
    compatibility: {
      aw: {
        minVersion: DEFAULT_AUTHORING_PLUGIN_AW_MIN_VERSION,
      },
    },
  };
}

async function writeManifestOnlyPlugin(
  root: string,
  name: string,
  extensions: Record<string, unknown>,
): Promise<string> {
  const pluginDir = path.join(root, name);
  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
    name,
    version: '0.1.0',
    description: `${name} test plugin.`,
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    extensions,
  }), { spaces: 2 });
  return pluginDir;
}

function validatePluginScriptPath(): string {
  return path.join(
    repoRoot(),
    '.agents',
    'skills',
    'create-agent-workflows-plugin',
    'scripts',
    'validate_plugin.js',
  );
}

async function runValidatePlugin(pluginDir: string, extraArgs: string[] = []) {
  return execFileAsync('node', [validatePluginScriptPath(), pluginDir, ...extraArgs], {
    cwd: repoRoot(),
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function writeSourcePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string | Record<string, unknown>> = {},
): Promise<{ pluginDir: string; manifestPath: string }> {
  const pluginDir = path.join(root, name);
  const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');

  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.writeJson(manifestPath, withDefaultCompatibility(manifest), { spaces: 2 });

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(pluginDir, relativePath);
    await fs.ensureDir(path.dirname(absolutePath));
    if (typeof content === 'string') {
      await fs.writeFile(absolutePath, content, 'utf8');
    } else {
      await fs.writeJson(absolutePath, content, { spaces: 2 });
    }
  }

  return { pluginDir, manifestPath };
}

function createBaseManifest(
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    version: '0.1.0',
    description: `${name} test plugin.`,
    compatibility: {
      aw: {
        minVersion: DEFAULT_AUTHORING_PLUGIN_AW_MIN_VERSION,
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    ...extra,
  };
}

async function writeAuthoringPluginManifest(
  pluginDir: string,
  manifest: Record<string, unknown>,
  options: { preserveCompatibility?: boolean } = {},
): Promise<void> {
  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginDir, '.agents-plugin', 'plugin.json'),
    options.preserveCompatibility ? manifest : withDefaultCompatibility(manifest),
    { spaces: 2 },
  );
}

async function writeDynamicArtifactPlugin(
  root: string,
  options: {
    rendererRoleKey?: string;
    includeRoleKey?: boolean;
    omitSkillPolicy?: boolean;
    products?: string[] | null;
  } = {},
): Promise<{ pluginDir: string; manifestPath: string }> {
  const pluginDir = path.join(root, 'dynamic-authoring-test');
  const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
  const roleKey = 'codex-explorer';
  const rendererRoleKey = options.rendererRoleKey ?? roleKey;

  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginDir, 'scripts'));
  await fs.ensureDir(path.join(pluginDir, 'skills', 'dynamic-authoring-test', 'agents'));
  await fs.writeJson(manifestPath, withDefaultCompatibility({
    name: 'dynamic-authoring-test',
    version: '0.1.0',
    description: 'Test dynamic artifact authoring contracts.',
    skills: './skills',
    skillTriggers: {
      'dynamic-authoring-test': {
        defaultTrigger: 'manual',
        allowDynamicTrigger: false,
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
        ...(options.products === null ? {} : { products: options.products ?? ['CODEX'] }),
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
    config: {
      schema: {
        enableInstruction: {
          type: 'boolean',
          default: true,
        },
        explorerModel: {
          type: 'string',
          default: 'gpt-5.4-mini',
        },
      },
    },
    artifacts: {
      targets: [
        {
          id: 'lightweight-instruction',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.developerInstructionsBlock',
          projectManagedKind: 'instruction',
          states: ['present', 'disabled'],
          refreshKeys: ['enableInstruction', 'explorerModel'],
          requiresCodexProjectConfig: true,
        },
        {
          id: 'codex-explorer-role',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.agentRole',
          projectManagedKind: 'agent',
          states: ['present'],
          refreshKeys: ['explorerModel'],
          requiresCodexProjectConfig: true,
          ...(options.includeRoleKey === false ? {} : { roleKey }),
        },
      ],
    },
  }), { spaces: 2 });

  await fs.writeFile(
    path.join(pluginDir, 'scripts', 'render-artifacts.mjs'),
    [
      'const roleKey = process.env.TEST_RENDERER_ROLE_KEY ?? ' + JSON.stringify(rendererRoleKey) + ';',
      'process.stdout.write(JSON.stringify({',
      '  version: 1,',
      '  artifacts: [',
      '    {',
      '      id: "lightweight-instruction",',
      '      kind: "instruction",',
      '      platform: "codex",',
      '      target: "codex.developerInstructionsBlock",',
      '      state: "present",',
      '      refreshKeys: ["enableInstruction", "explorerModel"],',
      '      content: "Use the explorer role for read-only codebase exploration."',
      '    },',
      '    {',
      '      id: "codex-explorer-role",',
      '      kind: "codexRole",',
      '      platform: "codex",',
      '      target: "codex.agentRole",',
      '      state: "present",',
      '      roleKey,',
      '      refreshKeys: ["explorerModel"],',
      '      content: {',
      '        registration: { description: "Read-only explorer role." },',
      '        roleFile: {',
      '          name: roleKey,',
      '          description: "Read-only explorer role.",',
      '          developer_instructions: "Read only. Do not edit files."',
      '        }',
      '      }',
      '    }',
      '  ]',
      '}));',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(pluginDir, 'skills', 'dynamic-authoring-test', 'SKILL.md'),
    [
      '---',
      'name: dynamic-authoring-test',
      'description: Validate dynamic artifact authoring.',
      'disable-model-invocation: true',
      '---',
      '',
      '# Dynamic Authoring Test',
      '',
      'Validate dynamic artifact authoring contracts.',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(pluginDir, 'skills', 'dynamic-authoring-test', 'agents', 'openai.yaml'),
    options.omitSkillPolicy
      ? ''
      : [
          'policy:',
          '  allow_implicit_invocation: false',
        ].join('\n'),
    'utf8',
  );

  return { pluginDir, manifestPath };
}

async function writeSlashCommandPlugin(
  root: string,
  options: {
    name: string;
    products?: string[] | null;
    commandFileName?: string;
    commandContent: string;
  },
): Promise<{ pluginDir: string; manifestPath: string }> {
  const { name, commandFileName = 'review.md', commandContent } = options;
  return writeSourcePlugin(
    root,
    name,
    createBaseManifest(name, {
      slashCommands: './slash-commands',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          ...(options.products === null ? {} : { products: options.products ?? ['CODEX'] }),
        },
      },
      interface: {
        displayName: name,
        shortDescription: `${name} slash command fixture`,
        capabilities: ['Slash Commands'],
      },
    }),
    {
      [path.posix.join('slash-commands', commandFileName)]: commandContent,
    },
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('authoring tools', () => {
  it('keeps fixtures on the source manifest + embedded bundle model', async () => {
    const fixtureRoot = fixturePath('repo-template');

    await expect(
      fs.pathExists(path.join(fixtureRoot, 'plugins', 'marketplace-source.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(fixtureRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(fixtureRoot, '.agents', 'plugins', 'marketplace.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(
        path.join(fixtureRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json'),
      ),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(
        path.join(fixtureRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json'),
      ),
    ).resolves.toBe(false);
  });

  it('scaffolds a source-only plugin and preserves marketplace-source metadata', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const marketplaceSourcePath = path.join(tempRepo, 'plugins', 'marketplace-source.json');
    const beforeMarketplaceSource = await fs.readFile(marketplaceSourcePath, 'utf8');
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        scriptPath,
        'repo-check',
        '--description',
        '检查仓库状态并输出诊断结论。',
        '--display-name',
        'Repo Check',
        '--short-description',
        '检查仓库状态',
        '--skill-name',
        'repo-check',
        '--skill-description',
        '手动触发这个 skill，执行仓库检查工作流',
        '--with-apps',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const scaffoldManifest = await fs.readJson(
      path.join(tempRepo, 'plugins', 'repo-check', '.agents-plugin', 'plugin.json'),
    );
    expect(scaffoldManifest).toMatchObject({
      name: 'repo-check',
      version: '0.1.0',
      description: '检查仓库状态并输出诊断结论。',
      compatibility: {
        aw: {
          minVersion: DEFAULT_AUTHORING_PLUGIN_AW_MIN_VERSION,
        },
      },
      skills: './skills',
      skillTriggers: {
        'repo-check': {
          defaultTrigger: 'manual',
          allowDynamicTrigger: false,
        },
      },
      apps: './.app.json',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
      interface: {
        displayName: 'Repo Check',
        shortDescription: '检查仓库状态',
        capabilities: ['Skills', 'Apps'],
      },
      extensions: {
        instructions: [],
        permissions: [],
        hooks: [],
        agents: [],
      },
    });
    expect(scaffoldManifest.marketplace.policy).not.toHaveProperty('products');
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md')),
    ).resolves.toBe(true);
    const skillMdContent = await fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md'),
      'utf8',
    );
    expect(skillMdContent).toContain('user-invocable: true');
    expect(skillMdContent).toContain('disable-model-invocation: true');
    expect(skillMdContent).toContain('metadata:\n  short-description: "手动触发这个 skill，执行仓库检查工作流"');
    await expect(
      fs.pathExists(
        path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'agents', 'openai.yaml'),
      ),
    ).resolves.toBe(true);
    const openaiYamlContent = await fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'agents', 'openai.yaml'),
      'utf8',
    );
    expect(openaiYamlContent).toContain('display_name: "Repo Check"');
    expect(openaiYamlContent).toContain(
      'short_description: "手动触发这个 skill，执行仓库检查工作流"',
    );
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'repo-check', '.app.json')),
    ).resolves.toMatchObject({
      apps: {
        example: {
          id: 'replace-with-real-connector-id',
        },
      },
    });
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(fs.readFile(marketplaceSourcePath, 'utf8')).resolves.toBe(beforeMarketplaceSource);
  });

  it('scaffolds compatibility.aw.minVersion and blocks values above the target catalog minimum', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-version-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        scriptPath,
        'catalog-aware',
        '--description',
        '带 catalog 最低版本上下文的插件。',
        '--catalog-min-version',
        '0.8.0',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'catalog-aware', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      compatibility: {
        aw: {
          minVersion: '0.8.0',
        },
      },
    });

    await expect(
      execFileAsync(
        'node',
        [
          scriptPath,
          'too-new-for-catalog',
          '--description',
          '插件最低版本高于 catalog 门槛。',
          '--min-version',
          '0.9.0',
          '--catalog-min-version',
          '0.8.0',
          '--repo-root',
          tempRepo,
        ],
        {
          cwd: repoRoot(),
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('target catalog minimum'),
    });
  });

  it('validate_plugin.js rejects invalid authoring version contracts and catalog gates', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-version-contracts-'));
    tempDirs.push(tempRoot);
    const pluginsRoot = path.join(tempRoot, 'plugins');

    const missingCompatibilityDir = path.join(pluginsRoot, 'missing-compatibility');
    await writeAuthoringPluginManifest(
      missingCompatibilityDir,
      {
        name: 'missing-compatibility',
        version: '0.1.0',
        description: 'Missing compatibility contract.',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      { preserveCompatibility: true },
    );
    await expect(runValidatePlugin(missingCompatibilityDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'Invalid compatibility.aw.minVersion: expected a strict SemVer 2.0.0 string. Received undefined.',
      ),
    });

    const invalidMinVersionDir = path.join(pluginsRoot, 'invalid-min-version');
    await writeAuthoringPluginManifest(invalidMinVersionDir, {
      ...createBaseManifest('invalid-min-version'),
      compatibility: {
        aw: {
          minVersion: 'latest',
        },
      },
    });
    await expect(runValidatePlugin(invalidMinVersionDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'Invalid compatibility.aw.minVersion: expected a strict SemVer 2.0.0 string. Received "latest".',
      ),
    });

    const invalidPluginVersionDir = path.join(pluginsRoot, 'invalid-plugin-version');
    await writeAuthoringPluginManifest(invalidPluginVersionDir, {
      ...createBaseManifest('invalid-plugin-version'),
      version: 'v0.1.0',
    });
    await expect(runValidatePlugin(invalidPluginVersionDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('strict SemVer 2.0.0'),
    });

    const aboveCatalogMinDir = path.join(pluginsRoot, 'above-catalog-min');
    await writeAuthoringPluginManifest(aboveCatalogMinDir, {
      ...createBaseManifest('above-catalog-min'),
      compatibility: {
        aw: {
          minVersion: '0.9.0',
        },
      },
    });
    await expect(
      runValidatePlugin(aboveCatalogMinDir, ['--catalog-min-version', '0.8.0']),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('target catalog minimum "0.8.0"'),
    });

    const perAgentVersionDir = path.join(pluginsRoot, 'per-agent-version');
    await writeAuthoringPluginManifest(
      perAgentVersionDir,
      {
        ...createBaseManifest('per-agent-version'),
        compatibility: {
          aw: {
            minVersion: DEFAULT_AUTHORING_PLUGIN_AW_MIN_VERSION,
          },
          codex: {
            minVersion: '0.131.0',
          },
        },
      },
      { preserveCompatibility: true },
    );
    await expect(runValidatePlugin(perAgentVersionDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('compatibility has unknown field "codex"'),
    });
  });

  it('scaffolds skill metadata from the skill name and description when they differ from plugin metadata', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-skill-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        scriptPath,
        'automation-suite',
        '--description',
        '提供多种自动化工作流。',
        '--display-name',
        'Automation Suite',
        '--short-description',
        '自动化插件集合',
        '--skill-name',
        'repo-diagnose',
        '--skill-description',
        '检查仓库状态并输出诊断结论',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const scaffoldManifest = await fs.readJson(
      path.join(tempRepo, 'plugins', 'automation-suite', '.agents-plugin', 'plugin.json'),
    );
    expect(scaffoldManifest.interface).toMatchObject({
      displayName: 'Automation Suite',
      shortDescription: '自动化插件集合',
      capabilities: ['Skills'],
    });

    const skillMdContent = await fs.readFile(
      path.join(tempRepo, 'plugins', 'automation-suite', 'skills', 'repo-diagnose', 'SKILL.md'),
      'utf8',
    );
    expect(skillMdContent).toContain('name: repo-diagnose');
    expect(skillMdContent).toContain('description: "检查仓库状态并输出诊断结论"');
    expect(skillMdContent).toContain('metadata:\n  short-description: "检查仓库状态并输出诊断结论"');

    const openaiYamlContent = await fs.readFile(
      path.join(
        tempRepo,
        'plugins',
        'automation-suite',
        'skills',
        'repo-diagnose',
        'agents',
        'openai.yaml',
      ),
      'utf8',
    );
    expect(openaiYamlContent).toContain('display_name: "Repo Diagnose"');
    expect(openaiYamlContent).toContain('short_description: "检查仓库状态并输出诊断结论"');
    expect(openaiYamlContent).toContain(
      'default_prompt: "使用 $repo-diagnose：检查仓库状态并输出诊断结论。"',
    );
    expect(openaiYamlContent).not.toContain('display_name: "Automation Suite"');
    expect(openaiYamlContent).not.toContain('short_description: "自动化插件集合"');
  });

  it('standard aw-config helper prefers AW_PLUGIN_CONTEXT without manifest or store discovery', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-helper-context-'));
    tempDirs.push(tempRoot);

    const helperPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'assets',
      'aw-config.mjs',
    );
    const contextPath = path.join(tempRoot, 'context.json');
    const userStorePath = path.join(tempRoot, 'user-config.json');
    const projectStorePath = path.join(tempRoot, 'project-config.json');
    await fs.writeJson(userStorePath, {
      apiKey: 'user-store-secret',
      mode: 'standard',
      ignored: true,
    });
    await fs.writeJson(projectStorePath, {
      mode: 'strict',
    });
    await fs.writeJson(contextPath, {
      plugin: { name: 'context-helper' },
      config: {
        values: {
          apiKey: 'context-secret',
          mode: 'strict',
        },
        sources: {
          apiKey: 'user',
          mode: 'project',
        },
        schema: {
          apiKey: { type: 'string', required: true, sensitive: true },
          mode: { type: 'enum', values: ['standard', 'strict'], default: 'standard' },
        },
      },
      paths: {
        configStores: {
          user: userStorePath,
          project: projectStorePath,
        },
      },
    });

    const { stdout } = await execFileAsync(
      'node',
      [helperPath, 'json'],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          AW_PLUGIN_CONTEXT: contextPath,
          AW_HOME: path.join(tempRoot, 'unused-aw-home'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      pluginName: 'context-helper',
      scope: 'effective',
      values: {
        apiKey: 'context-secret',
        mode: 'strict',
      },
      sources: {
        apiKey: 'user',
        mode: 'project',
      },
    });

    const { stdout: scopedStdout } = await execFileAsync(
      'node',
      [helperPath, 'json', '--scope', 'user'],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          AW_PLUGIN_CONTEXT: contextPath,
          AW_HOME: path.join(tempRoot, 'unused-aw-home'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const scopedPayload = JSON.parse(scopedStdout);
    expect(scopedPayload).toMatchObject({
      pluginName: 'context-helper',
      scope: 'user',
      values: {
        apiKey: 'user-store-secret',
        mode: 'standard',
      },
      diagnostics: {
        ignoredUnknownKeys: [{ scope: 'user', key: 'ignored' }],
      },
    });
  });

  it('standard aw-config helper fallback reads adjacent bundle manifest and filters unknown store keys', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-helper-fallback-'));
    tempDirs.push(tempRoot);

    const bundleRoot = path.join(tempRoot, 'bundle');
    await fs.ensureDir(path.join(bundleRoot, '.agents-plugin'));
    await fs.ensureDir(path.join(bundleRoot, 'scripts'));
    await fs.copyFile(
      path.join(
        repoRoot(),
        '.agents',
        'skills',
        'create-agent-workflows-plugin',
        'assets',
        'aw-config.mjs',
      ),
      path.join(bundleRoot, 'scripts', 'aw-config.mjs'),
    );
    await fs.writeJson(path.join(bundleRoot, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'config-demo',
      version: '0.1.0',
      description: 'Config helper fallback fixture.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      scripts: {
        helpers: { config: './scripts/aw-config.mjs' },
      },
      config: {
        schema: {
          token: { type: 'string', sensitive: true, required: true },
          mode: { type: 'enum', values: ['standard', 'strict'], default: 'standard' },
          configFile: { type: 'file', default: './config.txt' },
        },
      },
    }), { spaces: 2 });

    const projectRoot = path.join(tempRoot, 'project');
    const projectSubdir = path.join(projectRoot, 'nested');
    const awHome = path.join(tempRoot, 'aw-home');
    await fs.ensureDir(projectSubdir);
    await fs.writeFile(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'config.txt'), 'ok\n', 'utf8');
    await fs.ensureDir(path.join(awHome, 'plugin-config', 'config-demo'));
    await fs.writeJson(
      path.join(awHome, 'plugin-config', 'config-demo', 'config.json'),
      {
        token: 'user-secret',
        staleUserSecret: 'do-not-print-user',
      },
      { spaces: 2 },
    );
    await fs.ensureDir(
      path.join(projectRoot, '.agent-workflows', 'plugin-config', 'config-demo'),
    );
    await fs.writeJson(
      path.join(projectRoot, '.agent-workflows', 'plugin-config', 'config-demo', 'config.json'),
      {
        token: 'project-secret',
        mode: 'strict',
        staleProjectSecret: 'do-not-print-project',
      },
      { spaces: 2 },
    );

    const { stdout } = await execFileAsync(
      'node',
      [path.join(bundleRoot, 'scripts', 'aw-config.mjs'), 'json'],
      {
        cwd: projectSubdir,
        env: {
          ...process.env,
          AW_HOME: awHome,
          AW_PLUGIN_CONTEXT: '',
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    expect(stdout).not.toContain('do-not-print-user');
    expect(stdout).not.toContain('do-not-print-project');
    const payload = JSON.parse(stdout);
    const expectedConfigFile = await fs.realpath(path.join(projectRoot, 'config.txt'));
    expect(payload.values).toMatchObject({
      token: 'project-secret',
      mode: 'strict',
      configFile: expectedConfigFile,
    });
    expect(payload.sources).toMatchObject({
      token: 'projectShared',
      mode: 'projectShared',
      configFile: 'default',
    });
    expect(payload.diagnostics.ignoredUnknownKeys).toEqual(
      expect.arrayContaining([
        { scope: 'user', key: 'staleUserSecret' },
        { scope: 'projectShared', key: 'staleProjectSecret' },
      ]),
    );

    await expect(
      execFileAsync(
        'node',
        [path.join(bundleRoot, 'scripts', 'aw-config.mjs'), 'get', 'token'],
        {
          cwd: projectSubdir,
          env: {
            ...process.env,
            AW_HOME: awHome,
            AW_PLUGIN_CONTEXT: '',
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    ).resolves.toMatchObject({
      stdout: 'project-secret\n',
    });
  });

  it('standard aw-config helper fails closed without bundle manifest or schema', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-helper-fail-'));
    tempDirs.push(tempRoot);
    const bundleRoot = path.join(tempRoot, 'bundle');
    const awHome = path.join(tempRoot, 'aw-home');
    await fs.ensureDir(path.join(bundleRoot, 'scripts'));
    await fs.copyFile(
      path.join(
        repoRoot(),
        '.agents',
        'skills',
        'create-agent-workflows-plugin',
        'assets',
        'aw-config.mjs',
      ),
      path.join(bundleRoot, 'scripts', 'aw-config.mjs'),
    );
    await fs.ensureDir(path.join(awHome, 'plugin-config', 'missing-manifest'));
    await fs.writeJson(
      path.join(awHome, 'plugin-config', 'missing-manifest', 'config.json'),
      {
        token: 'store-secret-must-not-leak',
      },
      { spaces: 2 },
    );

    await expect(
      execFileAsync(
        'node',
        [path.join(bundleRoot, 'scripts', 'aw-config.mjs'), 'json'],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            AW_HOME: awHome,
            AW_PLUGIN_CONTEXT: '',
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.not.stringContaining('store-secret-must-not-leak'),
    });
  });

  it('scaffolds config helper, lifecycle, config schema, and plugin script tests on demand', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-scripts-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const initScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );
    const validateScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        initScriptPath,
        'script-ready',
        '--description',
        'Plugin with AW config helper and lifecycle scripts.',
        '--no-skills',
        '--with-config-api',
        '--with-lifecycle',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const pluginDir = path.join(tempRepo, 'plugins', 'script-ready');
    const manifest = await fs.readJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'));
    expect(manifest).toMatchObject({
      scripts: {
        lifecycle: {
          install: './scripts/lifecycle.mjs',
          upgrade: './scripts/lifecycle.mjs',
          uninstall: './scripts/lifecycle.mjs',
        },
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        tests: {
          node: ['./scripts/**/*.test.mjs'],
        },
      },
      config: {
        schema: {
          apiKey: {
            type: 'string',
            required: true,
            sensitive: true,
          },
        },
      },
    });
    await expect(fs.pathExists(path.join(pluginDir, 'scripts', 'aw-config.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(pluginDir, 'scripts', 'lifecycle.mjs'))).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginDir, 'scripts', 'generated-script.test.mjs')),
    ).resolves.toBe(true);
    await expect(
      execFileAsync('node', [validateScriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('scaffolds YAML-safe skill metadata when descriptions contain quotes and colons', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-yaml-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const initScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );
    const validateScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        initScriptPath,
        'repo-audit',
        '--description',
        'Summarize "repo" state: quick view',
        '--display-name',
        'Quote "Test"',
        '--short-description',
        'Summarize "repo" state: quick view',
        '--skill-description',
        'Check "repo" state: produce report',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const pluginDir = path.join(tempRepo, 'plugins', 'repo-audit');
    const skillMdPath = path.join(pluginDir, 'skills', 'repo-audit', 'SKILL.md');
    const openaiYamlPath = path.join(pluginDir, 'skills', 'repo-audit', 'agents', 'openai.yaml');

    const skillMdContent = await fs.readFile(skillMdPath, 'utf8');
    expect(skillMdContent).toContain('description: "Check \\"repo\\" state: produce report"');
    expect(skillMdContent).toContain(
      'metadata:\n  short-description: "Check \\"repo\\" state: produce report"',
    );

    const openaiYamlContent = await fs.readFile(openaiYamlPath, 'utf8');
    expect(openaiYamlContent).toContain('display_name: "Repo Audit"');
    expect(openaiYamlContent).toContain(
      'short_description: "Check \\"repo\\" state: produce report"',
    );
    expect(openaiYamlContent).toContain(
      'default_prompt: "使用 $repo-audit：Check \\"repo\\" state: produce report。"',
    );

    await fs.writeFile(
      skillMdPath,
      skillMdContent
        .replace('[TODO: 写清楚这个插件实际要完成的工作流]', '检查仓库状态。')
        .replace('[TODO: 第一步]', '收集状态')
        .replace('[TODO: 第二步]', '分析风险')
        .replace('[TODO: 第三步]', '输出报告')
        .replace('[TODO: 不要扩大修改范围]', '不要扩大修改范围')
        .replace('[TODO: 遇到高风险操作时先停下来说明]', '遇到高风险操作时先停下来说明'),
      'utf8',
    );

    await expect(
      execFileAsync('node', [validateScriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('keeps authoring docs aligned with the build-bundle model', async () => {
    const root = repoRoot();
    const refBase = path.join(
      root,
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'references',
    );
    const skillDoc = await fs.readFile(
      path.join(root, '.agents', 'skills', 'create-agent-workflows-plugin', 'SKILL.md'),
      'utf8',
    );
    const manifestSpecDoc = await fs.readFile(
      path.join(refBase, 'plugin-manifest-spec.md'),
      'utf8',
    );
    const triggersDoc = await fs.readFile(
      path.join(refBase, 'skills-and-triggers.md'),
      'utf8',
    );
    const extensionsSpecDoc = await fs.readFile(
      path.join(refBase, 'extensions-spec.md'),
      'utf8',
    );
    const slashCommandsDoc = await fs.readFile(
      path.join(refBase, 'slash-commands.md'),
      'utf8',
    );
    const claudeOnlyDoc = await fs.readFile(
      path.join(refBase, 'claude-only-capabilities.md'),
      'utf8',
    );
    const buildConfigDoc = await fs.readFile(
      path.join(refBase, 'build-config-spec.md'),
      'utf8',
    );
    const mcpAppsDoc = await fs.readFile(
      path.join(refBase, 'mcp-and-apps.md'),
      'utf8',
    );

    expect(skillDoc).toContain('`plugins/marketplace-source.json`');
    expect(skillDoc).toContain('`pnpm build`');
    expect(skillDoc).toContain('`.claude-plugin/plugin.json`');
    expect(skillDoc).toContain('`.codex-plugin/plugin.json`');
    expect(skillDoc).toContain('所有插件都必须有 `.agents-plugin/plugin.json`');
    expect(skillDoc).not.toContain('唯一必需的文件始终只有 `.agents-plugin/plugin.json`');
    expect(skillDoc).not.toContain('同步 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json`');
    expect(skillDoc).not.toContain('默认把插件注册到两份 marketplace manifest');
    expect(skillDoc).toContain(
      '场景 A 或 B 的路径 + `references/mcp-and-apps.md` + `references/build-config-spec.md`',
    );
    expect(skillDoc).toContain('`references/slash-commands.md`');
    expect(skillDoc).toContain('`--with-mcp` / `--with-apps`');
    expect(skillDoc).toContain('不要在 manifest 中声明最低 Codex 或 Claude Code 版本字段');
    expect(skillDoc).toContain('codex plugin add/remove');
    expect(skillDoc).not.toContain('`plugin/install`');
    expect(skillDoc).not.toContain('`plugin/uninstall`');

    expect(manifestSpecDoc).toContain('`plugins/marketplace-source.json`');
    expect(manifestSpecDoc).toContain('不是运行时 marketplace manifest');
    expect(manifestSpecDoc).toContain('packages/cli/plugins-dist/');
    expect(manifestSpecDoc).toContain('`skillTriggers`');
    expect(manifestSpecDoc).toContain('`defaultTrigger`');
    expect(manifestSpecDoc).toContain('`allowDynamicTrigger`');
    expect(manifestSpecDoc).toContain('禁止手改');
    expect(manifestSpecDoc).not.toContain('allowInstallOverride');
    expect(manifestSpecDoc).not.toContain('npx eslint *');
    expect(manifestSpecDoc).not.toContain('npx prettier *');
    expect(manifestSpecDoc).toContain('插件 manifest 不声明 per-plugin 宿主 agent 版本');
    expect(manifestSpecDoc).toContain('Codex `>= 0.131.0`、Claude Code `>= 2.1.88`');
    expect(() =>
      validatePluginManifest(
        '/tmp/coding-standards',
        extractJsonFenceAfter(manifestSpecDoc, '## 最小 manifest 示例'),
      ),
    ).not.toThrow();

    expect(triggersDoc).toContain('两个平台的触发开关完全独立');
    expect(triggersDoc).toContain('aw config set <plugin> aw.skillTriggers.<skill>.trigger manual');
    expect(triggersDoc).toContain('allowDynamicTrigger: true');
    expect(triggersDoc).toContain('面向 Codex 时必需');
    expect(triggersDoc).toContain('`when_to_use`');
    expect(triggersDoc).toContain(
      '公共 `slashCommands` 在 Codex 侧生成的 manual-only skill 不要求作者手写 entry',
    );
    expect(triggersDoc).toContain('不会把 `repo-check` 自动转换成 `Repo Check`');
    expect(triggersDoc).toContain('`command`：`stdio` 场景下启动本地 MCP server 的命令');
    expect(triggersDoc).toContain('`allowed-tools` 可写单个字符串');
    expect(triggersDoc).toContain('`brand_color`：可选；填写时必须是 `#RRGGBB`');
    expect(triggersDoc).toContain('缺失或空值会被 Codex loader 丢弃');
    expect(triggersDoc).not.toContain('--skill-trigger');
    expect(triggersDoc).not.toContain('allowInstallOverride');
    expect(triggersDoc).not.toContain('自动格式化 kebab-case');
    expect(extensionsSpecDoc).toContain('`command` 是公共 hook contract 的必填字段');
    expect(extensionsSpecDoc).toContain('`extensions.hooks` 不是 Claude Code / Codex 原生 hook 事件全集');
    expect(extensionsSpecDoc).toContain('公共 `session_start` 只覆盖 `startup / resume / clear`');
    expect(extensionsSpecDoc).toContain('`extensions.nativeHooks.<platform>`');
    expect(extensionsSpecDoc).toContain('matcherless 事件不要写 `matcher`');
    expect(extensionsSpecDoc).toContain('`agentOverrides` 不用于 `nativeHooks`');
    expect(extensionsSpecDoc).toContain('`session_stop` 已从公共 hook 中移除');
    expect(extensionsSpecDoc).toContain('`.codex-plugin/plugin.json` 的 `hooks` 字段');
    expect(extensionsSpecDoc).toContain('| Codex project scope | `.codex/hooks.json` |');
    expect(extensionsSpecDoc).not.toContain('`command` 已从公共 hook contract 移除');

    expect(slashCommandsDoc).toMatch(/公共 `slashCommands` 是源码层唯一的(?:跨平台)?手动命令作者入口/);
    expect(
      slashCommandsDoc.includes('Claude runtime 得到 generated `claude/commands/<name>.md`')
      || slashCommandsDoc.includes('支持 Claude 时得到原生 `/command`'),
    ).toBe(true);
    expect(slashCommandsDoc).toContain('Codex generated skill 会固定写入 `policy.allow_implicit_invocation: false`');
    expect(claudeOnlyDoc).toContain('公共 `slashCommands` 不是 Claude 专属能力');
    expect(claudeOnlyDoc).not.toContain('## 公共 slashCommands');
    expect(buildConfigDoc).toContain('不会排除 manifest 已声明的能力路径');
    expect(mcpAppsDoc).toContain('`${user_config.KEY}` 是 Claude runtime 的原生占位符');

    const authoringDoc = await fs.readFile(path.join(root, 'docs', 'plugin-authoring.md'), 'utf8');
    expect(authoringDoc).toContain('references/plugin-manifest-spec.md');
    expect(authoringDoc).toContain('references/skills-and-triggers.md');
    expect(authoringDoc).toContain(
      '`skillTriggers` 为每个显式受管 skill 声明 `defaultTrigger` 和 `allowDynamicTrigger`',
    );
    expect(authoringDoc).toContain('作者不需要、也不能在插件 manifest 中声明最低 Codex 或 Claude Code 版本');
    expect(authoringDoc).not.toContain('--skill-trigger');
    expect(authoringDoc).not.toContain('references/project-plugin-contract.md');
    expect(authoringDoc).not.toContain('references/skill-trigger-rules.md');

    const exampleDoc = await fs.readFile(
      path.join(refBase, 'comprehensive-example.md'),
      'utf8',
    );
    expect(exampleDoc).toContain('Codex 安装时生成的 repo-managed artifacts');
    expect(exampleDoc).toContain('`extensions.nativeHooks.codex`');
    expect(exampleDoc).toContain('codex plugin marketplace add/list');
    expect(exampleDoc).toContain('写入前仍要求本机 Codex `>= 0.131.0`');
    expect(exampleDoc).toContain(
      '`skillTriggers.review-workflow.{defaultTrigger, allowDynamicTrigger}`',
    );
    expect(exampleDoc).not.toContain('`plugin/install`');
    expect(exampleDoc).not.toContain('allowInstallOverride');
    expect(exampleDoc).toContain('`slash-commands/`');
    expect(exampleDoc).toContain('`${REVIEW_SERVICE_API_KEY}`');
  });

  it('validate_plugin.js validates skillTriggers authoring contract', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-triggers-authoring-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'trigger-demo');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'trigger-demo', 'agents'));
    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    await fs.writeJson(manifestPath, withDefaultCompatibility({
      name: 'trigger-demo',
      version: '0.1.0',
      description: 'Test plugin for install-time trigger override policy.',
      skills: './skills',
      skillTriggers: {
        'trigger-demo': {
          defaultTrigger: 'manual',
          allowDynamicTrigger: true,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'trigger-demo', 'SKILL.md'),
      [
        '---',
        'name: trigger-demo',
        'description: Validate install-time trigger override policy.',
        'user-invocable: true',
        'disable-model-invocation: true',
        '---',
        '',
        '# Trigger Demo',
        '',
        'Validate install-time trigger override policy.',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'trigger-demo', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const dynamicSkillPlugin = await writeSourcePlugin(
      tempRoot,
      'dynamic-trigger-demo',
      createBaseManifest('dynamic-trigger-demo', {
        skillTriggers: {
          'dynamic-trigger-demo': {
            defaultTrigger: 'manual',
            allowDynamicTrigger: true,
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
            {
              id: 'dynamic-trigger-demo',
              platform: 'codex',
              scopes: ['user', 'project'],
              target: 'codex.skill',
              states: ['present'],
              refreshKeys: [],
              skillKey: 'dynamic-trigger-demo',
            },
          ],
        },
      }),
      {
        'scripts/render-artifacts.mjs': [
          'process.stdout.write(JSON.stringify({',
          '  version: 1,',
          '  artifacts: [',
          '    {',
          '      id: "dynamic-trigger-demo",',
          '      platform: "codex",',
          '      target: "codex.skill",',
          '      kind: "skill",',
          '      state: "present",',
          '      refreshKeys: [],',
          '      skillKey: "dynamic-trigger-demo",',
          '      content: {',
          '        skillFile: "---\\nname: dynamic-trigger-demo\\ndescription: Dynamic trigger demo.\\n---\\n\\n# Dynamic Trigger Demo\\n",',
          '        openaiYaml: "policy:\\n  allow_implicit_invocation: false\\n"',
          '      }',
          '    }',
          '  ]',
          '}));',
        ].join('\n'),
      },
    );
    await expect(runValidatePlugin(dynamicSkillPlugin.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const validManifest = await fs.readJson(manifestPath);
    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        skillTriggers: {
          missing: {
            defaultTrigger: 'manual',
            allowDynamicTrigger: true,
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'Invalid skillTriggers.missing: expected a declared static skill or codex.skill artifact.',
      ),
    });

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        skillTriggers: {
          'trigger-demo': {
            defaultTrigger: 'manual',
            allowDynamicTrigger: 'yes',
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'skillTriggers.trigger-demo.allowDynamicTrigger must be a boolean',
      ),
    });

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        skillTriggers: {
          'trigger-demo': {
            defaultTrigger: 'manual',
            allowInstallOverride: true,
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'Invalid skillTriggers.trigger-demo: unknown field "allowInstallOverride".',
      ),
    });
  });

  it('validate_plugin.js rejects bad scripts/config authoring contracts without package-manager staging', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-scripts-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const pluginDir = await writeManifestOnlyPlugin(tempRoot, 'script-contract-demo', {});
    await fs.ensureDir(path.join(pluginDir, 'scripts', 'pkg'));
    await fs.writeFile(
      path.join(pluginDir, 'scripts', 'aw-config.txt'),
      'not a node helper\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'scripts', 'aw-config.mjs'),
      'import yaml from "yaml";\nconsole.log(yaml);\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'scripts', 'lifecycle.mjs'),
      'console.log("ok");\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'scripts', 'lifecycle.py'),
      'print("ok")\n',
      'utf8',
    );
    await fs.writeJson(path.join(pluginDir, 'scripts', 'pkg', 'package.json'), {
      dependencies: {
        yaml: '^2.0.0',
        local: 'file:../local.tgz',
      },
    }, { spaces: 2 });

    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.txt',
        },
        lifecycle: {
          install: {
            linux: { runner: 'node', path: './scripts/lifecycle.mjs' },
          },
        },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        schema: {
          badMin: {
            type: 'string',
            min: 1,
          },
        },
      },
    }, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('scripts.helpers.config must use a Node runnable extension'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        lifecycle: {
          install: {
            linux: { runner: 'auto', path: './scripts/lifecycle.py' },
            darwin: { runner: 'node', path: './scripts/lifecycle.mjs' },
            win32: { runner: 'node', path: './scripts/lifecycle.mjs' },
          },
        },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        schema: {
          goodKey: {
            type: 'string',
          },
        },
      },
    }, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('runner "auto"'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        lifecycle: {
          install: {
            linux: { runner: 'node', path: './scripts/lifecycle.mjs' },
          },
        },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        schema: {
          goodKey: {
            type: 'string',
          },
        },
      },
    }, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('scripts.lifecycle.install must include an entry that resolves on win32'),
    });
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('scripts.node.packageRoot is missing pnpm-lock.yaml'),
    });
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('file:../local.tgz'),
    });
  });

  it('validate_plugin.js validates dynamic Codex artifact renderer contracts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-artifacts-'));
    tempDirs.push(tempRoot);

    const { pluginDir, manifestPath } = await writeDynamicArtifactPlugin(tempRoot);

    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const validManifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, {
      ...validManifest,
      artifacts: {
        targets: [
          {
            ...validManifest.artifacts.targets[0],
            target: 'codex.unknownTarget',
          },
        ],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('unsupported artifact target "codex.unknownTarget"'),
    });

    await fs.writeJson(manifestPath, {
      ...validManifest,
      artifacts: {
        targets: [
          {
            ...validManifest.artifacts.targets[0],
            states: ['archived'],
          },
        ],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('unsupported artifact state "archived"'),
    });

    await fs.writeJson(manifestPath, {
      ...validManifest,
      artifacts: {
        targets: [
          {
            ...validManifest.artifacts.targets[0],
            refreshKeys: ['missingConfigKey'],
          },
        ],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('unknown config key "missingConfigKey"'),
    });
  });

  it('validate_plugin.js validates artifact target platforms against supported products', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-artifact-platforms-'));
    tempDirs.push(tempRoot);

    const omittedProducts = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'omitted-products'),
      { products: null },
    );
    await expect(runValidatePlugin(omittedProducts.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const emptyProducts = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'empty-products'),
      { products: [] },
    );
    await expect(runValidatePlugin(emptyProducts.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const claudeOnly = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'claude-only-products'),
      { products: ['claude'] },
    );
    await expect(runValidatePlugin(claudeOnly.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'artifacts.targets[0].platform requires CODEX support',
      ),
    });
  });

  it('validate_plugin.js rejects dynamic role metadata and skill trigger policy mistakes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-role-'));
    tempDirs.push(tempRoot);

    const missingRole = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'missing-role'),
      { includeRoleKey: false },
    );
    await expect(runValidatePlugin(missingRole.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('codex.agentRole targets must declare a static roleKey'),
    });

    const mismatchedRole = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'mismatched-role'),
      { rendererRoleKey: 'other-explorer' },
    );
    await expect(runValidatePlugin(mismatchedRole.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('expected "codex-explorer" from static metadata'),
    });

    const missingPolicy = await writeDynamicArtifactPlugin(
      path.join(tempRoot, 'missing-policy'),
      { omitSkillPolicy: true },
    );
    await expect(runValidatePlugin(missingPolicy.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('policy is required for Codex-targeted skills'),
    });
  });

  it('validate_plugin.js accepts native hooks and rejects hook contract mistakes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-hooks-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const pluginDir = await writeManifestOnlyPlugin(tempRoot, 'native-hook-demo', {
      hooks: [
        {
          event: 'session_start',
          command: 'echo portable start',
        },
      ],
      nativeHooks: {
        claude: [
          {
            event: 'SessionStart',
            matcher: 'compact',
            command: 'echo claude compact',
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
          {
            event: 'Stop',
            command: 'echo codex stop',
          },
        ],
      },
    });
    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const validManifest = await fs.readJson(manifestPath);

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'Notification',
                command: 'echo wrong platform',
              },
            ],
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('unsupported codex hook event "Notification"'),
    });

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'Stop',
                matcher: '*',
                command: 'echo invalid matcher',
              },
            ],
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('does not allow matcher'),
    });

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        extensions: {
          hooks: [
            {
              event: 'session_stop',
              command: 'echo old stop',
            },
          ],
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('public event "session_stop" has been removed'),
    });
  });

  it('validate_plugin.js enforces platform-scoped authoring contracts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-platform-conflicts-'));
    tempDirs.push(tempRoot);

    const cases: Array<{
      name: string;
      products: string[];
      extra: Record<string, unknown>;
      files?: Record<string, string | Record<string, unknown>>;
      expected?: string;
    }> = [
      {
        name: 'codex-only-file-rules',
        products: ['codex'],
        extra: {
          buildConfig: {
            fileRules: {
              claude: {
                include: ['skills/**'],
              },
            },
          },
        },
        expected: 'buildConfig.fileRules.claude requires CLAUDE support',
      },
      {
        name: 'claude-only-manifest-overrides',
        products: ['claude'],
        extra: {
          buildConfig: {
            manifestOverrides: {
              codex: {},
            },
          },
        },
        expected: 'buildConfig.manifestOverrides.codex requires CODEX support',
      },
      {
        name: 'claude-only-apps',
        products: ['claude'],
        extra: {
          apps: './.app.json',
        },
        files: {
          '.app.json': {
            apps: {
              example: {
                id: 'replace-with-real-connector-id',
              },
            },
          },
        },
        expected: 'apps requires CODEX support',
      },
      {
        name: 'claude-only-native-hooks',
        products: ['claude'],
        extra: {
          extensions: {
            nativeHooks: {
              codex: [
                {
                  event: 'Stop',
                  command: 'echo codex stop',
                },
              ],
            },
          },
        },
        expected: 'extensions.nativeHooks.codex requires CODEX support',
      },
      {
        name: 'claude-only-agent-overrides',
        products: ['claude'],
        extra: {
          extensions: {
            hooks: [
              {
                event: 'before_tool',
                matcher: '*',
                command: 'echo shared hook',
                agentOverrides: {
                  codex: {
                    command: 'echo codex-only hook',
                  },
                },
              },
            ],
          },
        },
        expected: 'extensions.hooks[0].agentOverrides.codex requires CODEX support',
      },
      {
        name: 'claude-only-null-agent-overrides',
        products: ['claude'],
        extra: {
          extensions: {
            hooks: [
              {
                event: 'before_tool',
                matcher: '*',
                command: 'echo shared hook',
                agentOverrides: {
                  codex: null,
                },
              },
            ],
          },
        },
      },
    ];

    for (const testCase of cases) {
      const { pluginDir } = await writeSourcePlugin(
        tempRoot,
        testCase.name,
        createBaseManifest(testCase.name, {
          marketplace: {
            category: 'workflow',
            strict: true,
            policy: {
              installation: 'AVAILABLE',
              authentication: 'NONE',
              products: testCase.products,
            },
          },
          ...testCase.extra,
        }),
        testCase.files,
      );

      if (testCase.expected) {
        await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
          stdout: expect.stringContaining(testCase.expected),
        });
      } else {
        await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
          stdout: expect.stringContaining('[PASS] All checks passed.'),
        });
      }
    }
  });

  it('validate_plugin.js passes on the reference code-review example', async () => {
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const pluginDir = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'references',
      '.examples',
      'code-review',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toBeDefined();
  });

  it('validate_plugin.js validates public slashCommands source contracts', async () => {
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-authoring-'));
    tempDirs.push(tempRoot);
    const validPluginDir = path.join(tempRoot, 'slash-commands-only');
    await fs.copy(
      fixturePath(
        'codex-project-repo-managed',
        'plugins',
        'slashCommands-only',
      ),
      validPluginDir,
    );
    await expect(
      execFileAsync('node', [scriptPath, validPluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toBeDefined();

    const explicitTriggerPluginDir = path.join(tempRoot, 'slash-commands-explicit-trigger');
    await fs.copy(validPluginDir, explicitTriggerPluginDir);
    const validManifestPath = path.join(explicitTriggerPluginDir, '.agents-plugin', 'plugin.json');
    const validManifest = await fs.readJson(validManifestPath);
    await fs.writeJson(
      validManifestPath,
      {
        ...validManifest,
        skillTriggers: {
          review: {
            defaultTrigger: 'manual',
            allowDynamicTrigger: false,
          },
        },
      },
      { spaces: 2 },
    );
    await expect(
      execFileAsync('node', [scriptPath, explicitTriggerPluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'slashCommands "review" uses an implicit fixed/manual trigger entry and must not be declared explicitly.',
      ),
    });

    const invalidPromptPluginDir = path.join(tempRoot, 'slash-commands-invalid-prompt');
    await fs.copy(validPluginDir, invalidPromptPluginDir);
    const reviewCommandPath = path.join(invalidPromptPluginDir, 'slash-commands', 'review.md');
    const reviewCommand = await fs.readFile(reviewCommandPath, 'utf8');
    await fs.writeFile(
      reviewCommandPath,
      reviewCommand.replace(
        'Use $review to inspect the current change set.',
        'Use this command to inspect the current change set.',
      ),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, invalidPromptPluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('codex.interface.default_prompt must explicitly mention "$review"'),
    });

    const invalidPluginDir = fixturePath(
      'codex-project-repo-managed',
      'negative',
      'slashCommands-invalid-icon',
    );
    await expect(
      execFileAsync('node', [scriptPath, invalidPluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('codex.interface.icon_small'),
    });
  });

  it('validate_plugin.js scopes slashCommands validation to the final supported platforms', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'slash-commands-products');
    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'slash-commands'));
    await fs.writeJson(manifestPath, withDefaultCompatibility({
      name: 'slash-commands-products',
      version: '0.1.0',
      description: 'Test plugin for slash command platform gating.',
      slashCommands: './slash-commands',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CLAUDE'],
        },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'slash-commands', 'review.md'),
      [
        '---',
        'description: Review the repository state.',
        'claude:',
        '  argument-hint: "[path]"',
        '---',
        '',
        'Use $ARGUMENTS to narrow the review scope.',
      ].join('\n'),
      'utf8',
    );

    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const manifest = await fs.readJson(manifestPath);
    manifest.marketplace.policy.products = ['CODEX'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('Codex render still contains Claude-only syntax "$ARGUMENTS"'),
    });
  });

  it('validate_plugin.js only validates slash command frontmatter for supported platforms', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-frontmatter-'));
    tempDirs.push(tempRoot);

    const codexOnly = await writeSlashCommandPlugin(path.join(tempRoot, 'codex-only'), {
      name: 'slash-codex-only',
      products: ['codex'],
      commandContent: [
        '---',
        'description: Validate Codex-only slash command rendering.',
        'claude:',
        '  shell: fish',
        'codex:',
        '  description: Manual Codex workflow.',
        '---',
        '',
        '# Review',
        '',
        'Run `git status` and summarize the current change set.',
      ].join('\n'),
    });

    await expect(runValidatePlugin(codexOnly.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const manifest = await fs.readJson(codexOnly.manifestPath);
    manifest.marketplace.policy.products = ['claude', 'codex'];
    await fs.writeJson(codexOnly.manifestPath, manifest, { spaces: 2 });

    await expect(runValidatePlugin(codexOnly.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'slash-commands/review.md frontmatter.claude.shell must be "bash" or "powershell"',
      ),
    });
  });

  it('validate_plugin.js enforces Codex skill metadata and YAML shape', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-metadata-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'metadata-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'metadata-test'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'metadata-test',
      version: '0.1.0',
      description: 'Test plugin for skill metadata checks.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'SKILL.md'),
      [
        '---',
        'name: metadata-test',
        'description: Validate metadata handling.',
        '---',
        '',
        '# Metadata Test',
        '',
        'Run the metadata validation workflow.',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('openai.yaml not found'),
    });

    await fs.ensureDir(path.join(pluginDir, 'skills', 'metadata-test', 'agents'));
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: "false"',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('allow_implicit_invocation must be a boolean'),
    });

    const overlongCodexText = 'x'.repeat(1025);
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: "   "',
        `  short_description: "${overlongCodexText}"`,
        '  default_prompt: ""',
        '  icon_small: "../icon.png"',
        '  icon_large: "./images/icon.png"',
        '  brand_color: "3B82F6"',
        'dependencies:',
        '  tools:',
        '    - description: "Missing tool identifiers"',
        '      transport: "websocket"',
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );
    let invalidOpenAiYamlStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      invalidOpenAiYamlStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(invalidOpenAiYamlStdout).toContain('interface.display_name must not be empty');
    expect(invalidOpenAiYamlStdout).toContain('interface.short_description must be <= 1024 characters');
    expect(invalidOpenAiYamlStdout).toContain('interface.default_prompt must not be empty');
    expect(invalidOpenAiYamlStdout).toContain('interface.icon_small must be a relative path under assets/');
    expect(invalidOpenAiYamlStdout).toContain('interface.icon_large must be a relative path under assets/');
    expect(invalidOpenAiYamlStdout).toContain('interface.brand_color must match #RRGGBB');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].type is required');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].value is required');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].transport must be "streamable_http" or "stdio"');

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  default_prompt: "Use this skill to validate metadata."',
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('interface.default_prompt must explicitly mention "$metadata-test"'),
    });

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'SKILL.md'),
      [
        '---',
        'name: metadata-test',
        'description: "unterminated',
        '---',
        '',
        '# Metadata Test',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('invalid YAML frontmatter'),
    });

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'metadata-test', 'SKILL.md'),
      [
        '---',
        'name: metadata-test',
        'description: Check "repo" state: produce report',
        '---',
        '',
        '# Metadata Test',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('plain scalar values containing ": " must be quoted'),
    });
  });

  it('validate_plugin.js validates manifest marketplace policy products', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'manifest-products-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'manifest-products-test',
      version: '0.1.0',
      description: 'Test plugin for manifest product checks.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX', 'BROWSER'],
        },
      },
    }), { spaces: 2 });

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('marketplace.policy.products[1]'),
    });

    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.marketplace.policy.products = ['codex', 'claude'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.js accepts and validates Codex policy products', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-policy-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'policy-products-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'policy-products-test', 'agents'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'policy-products-test',
      version: '0.1.0',
      description: 'Test plugin for Codex policy product checks.',
      skills: './skills',
      skillTriggers: {
        'policy-products-test': {
          defaultTrigger: 'manual',
          allowDynamicTrigger: false,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'policy-products-test', 'SKILL.md'),
      [
        '---',
        'name: policy-products-test',
        'description: Validate Codex policy product handling.',
        '---',
        '',
        '# Policy Products Test',
        '',
        'Run the policy product validation workflow.',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'policy-products-test', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: false',
        '  products: codex',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('policy.products must be an array'),
    });

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'policy-products-test', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: false',
        '  products:',
        '    - codex',
        '    - CHATGPT',
        '    - atlas',
      ].join('\n'),
      'utf8',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.js accepts runtime-compatible YAML block scalars and tool commands', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-yaml-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'runtime-yaml-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'runtime-yaml-test', 'agents'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'runtime-yaml-test',
      version: '0.1.0',
      description: 'Test plugin for runtime-compatible YAML metadata.',
      skills: './skills',
      skillTriggers: {
        'runtime-yaml-test': {
          defaultTrigger: 'manual',
          allowDynamicTrigger: false,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }), { spaces: 2 });

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'runtime-yaml-test', 'SKILL.md'),
      [
        '---',
        'name: runtime-yaml-test',
        'description: >',
        '  Validate metadata handling with',
        '  folded YAML scalars.',
        'metadata:',
        '  short-description: |',
        '    Runtime-compatible YAML metadata.',
        '---',
        '',
        '# Runtime YAML Test',
        '',
        'Run the runtime-compatible YAML validation workflow.',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'runtime-yaml-test', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: "Runtime YAML Test"',
        '  short_description: >',
        '    Validate block scalar',
        '    metadata.',
        '  default_prompt: >',
        '    Use $runtime-yaml-test to validate',
        '    runtime-compatible YAML.',
        'dependencies:',
        '  tools:',
        '    - type: "mcp"',
        '      value: "local-gh"',
        '      description: >',
        '        Local GitHub MCP server.',
        '      transport: "stdio"',
        '      command: "gh-mcp"',
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.js validates rendered templated skill metadata', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-templated-metadata-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'templated-metadata-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'templated-metadata-test', 'agents'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'templated-metadata-test',
      version: '0.1.0',
      description: 'Test plugin for templated skill metadata.',
      skills: './skills',
      skillTriggers: {
        'templated-metadata-test': {
          defaultTrigger: 'manual',
          allowDynamicTrigger: false,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      buildConfig: {
        templates: {
          include: ['skills/**/*.md', 'skills/**/*.yaml'],
          vars: {
            skillDescription: {
              claude: 'Run Claude metadata workflow',
              codex: 'Run Codex metadata workflow',
            },
            shortDescription: {
              claude: 'Claude metadata workflow',
              codex: 'Codex metadata workflow',
            },
            displayName: {
              claude: 'Claude Metadata',
              codex: 'Codex Metadata',
            },
            defaultPrompt: {
              claude: 'Use the Claude metadata workflow',
              codex: 'Use $templated-metadata-test to run the Codex metadata workflow',
            },
            disableModelInvocation: {
              claude: true,
              codex: true,
            },
            allowImplicitInvocation: {
              claude: false,
              codex: false,
            },
          },
        },
      },
    }), { spaces: 2 });

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'templated-metadata-test', 'SKILL.md'),
      [
        '---',
        'name: templated-metadata-test',
        'description: {{skillDescription}}',
        'disable-model-invocation: {{disableModelInvocation}}',
        'metadata:',
        '  short-description: {{shortDescription}}',
        '---',
        '',
        '# Templated Metadata Test',
        '',
        'Run the {{displayName}} workflow.',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(pluginDir, 'skills', 'templated-metadata-test', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: {{displayName}}',
        '  short_description: {{shortDescription}}',
        '  default_prompt: {{defaultPrompt}}',
        'policy:',
        '  allow_implicit_invocation: {{allowImplicitInvocation}}',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.js treats openai.yaml as optional for non-Codex skills', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-skill-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'claude-only');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'claude-only'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'claude-only',
      version: '0.1.0',
      description: 'Test plugin for Claude-only skill metadata checks.',
      skills: './skills',
      skillTriggers: {
        'claude-only': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CLAUDE'],
        },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'claude-only', 'SKILL.md'),
      [
        '---',
        'name: claude-only',
        'description: Validate Claude-only metadata handling.',
        '---',
        '',
        '# Claude Only',
        '',
        'Run the Claude-only validation workflow.',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.js checks skill frontmatter fields used by Codex and Claude', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-frontmatter-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'frontmatter-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'frontmatter-test', 'agents'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'frontmatter-test',
      version: '0.1.0',
      description: 'Test plugin for skill frontmatter checks.',
      skills: './skills',
      skillTriggers: {
        'frontmatter-test': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }), { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'frontmatter-test', 'agents', 'openai.yaml'),
      [
        'policy:',
        '  allow_implicit_invocation: false',
      ].join('\n'),
      'utf8',
    );

    const skillMdPath = path.join(pluginDir, 'skills', 'frontmatter-test', 'SKILL.md');
    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate frontmatter handling.',
        'user-invocable: "true"',
        'disable-model-invocation: false',
        'metadata:',
        '  short-description: false',
        'allowed-tools:',
        '  - Bash(git status *)',
        '  - false',
        'shell: zsh',
        '---',
        '',
        '# Frontmatter Test',
      ].join('\n'),
      'utf8',
    );

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    let invalidFrontmatterStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      invalidFrontmatterStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(invalidFrontmatterStdout).toContain('frontmatter.user-invocable must be a boolean');
    expect(invalidFrontmatterStdout).toContain('frontmatter.metadata.short-description must be a string');
    expect(invalidFrontmatterStdout).toContain('frontmatter.allowed-tools[1] must be a string');
    expect(invalidFrontmatterStdout).toContain('frontmatter.shell must be "bash" or "powershell"');

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate frontmatter handling.',
        'user-invocable: true',
        'disable-model-invocation: false',
        'metadata:',
        '  short-description: Frontmatter validation',
        'allowed-tools: Bash(git status *)',
        'shell: PowerShell',
        '---',
        '',
        '# Frontmatter Test',
      ].join('\n'),
      'utf8',
    );

    const result = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(result.stdout).toContain('when_to_use is recommended');
    expect(result.stdout).toContain('[PASS] All checks passed.');
  });

  it('validate_plugin.js rejects out-of-bounds skills path when CLI is built', async () => {
    const distPath = path.join(repoRoot(), 'packages', 'cli', 'dist');
    if (!fs.existsSync(distPath)) return;

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-boundary-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'boundary-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'boundary-test',
      version: '0.1.0',
      description: 'Test plugin for boundary check.',
      skills: './../shared-skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      interface: { displayName: 'Boundary Test', shortDescription: 'Test' },
    }), { spaces: 2 });

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toBeDefined();
  });

  it('validate_plugin.js stays in parity with CLI dependency validation fixtures', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dependency-parity-'));
    tempDirs.push(tempRoot);
    const pluginsRoot = path.join(tempRoot, 'plugins');

    for (const testCase of pluginDependencyValidatorParityCases) {
      await fs.remove(pluginsRoot);
      const pluginDir = path.join(pluginsRoot, 'dependency-parent');
      await writeAuthoringPluginManifest(pluginDir, testCase.manifest);

      for (const siblingName of testCase.siblingPluginNames ?? []) {
        await writeAuthoringPluginManifest(
          path.join(pluginsRoot, siblingName),
          createDependencySiblingManifest(siblingName),
        );
      }

      if (testCase.expectedError) {
        await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
          stdout: expect.stringContaining(testCase.expectedError),
        });
      } else {
        await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
          stdout: expect.stringContaining('[PASS] All checks passed.'),
        });
      }
    }
  });

  it('validate_plugin.js fallback warns that it is lightweight and skips templated native asset shape checks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-fallback-'));
    tempDirs.push(tempRoot);

    const scriptSource = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const scriptPath = path.join(
      tempRoot,
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.copy(scriptSource, scriptPath);

    const pluginDir = path.join(tempRoot, 'plugins', 'fallback-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withDefaultCompatibility({
      name: 'fallback-test',
      version: '0.1.0',
      description: 'Test plugin for fallback validation.',
      mcpServers: './.mcp.json',
      apps: './.app.json',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      buildConfig: {
        templates: {
          include: ['.mcp.json', '.app.json'],
        },
      },
    }), { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.mcp.json'), { template: true }, { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.app.json'), { template: true }, { spaces: 2 });

    const result = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout).toContain('仅执行轻量预检');
    expect(result.stdout).toContain('[PASS] All checks passed.');
  });

});
