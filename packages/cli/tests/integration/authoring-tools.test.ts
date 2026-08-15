import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';

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
        authentication: 'ON_INSTALL',
      },
    },
    extensions,
  }), { spaces: 2 });
  await fs.writeFile(path.join(pluginDir, 'README.md'), '# Test Plugin\n', 'utf8');
  return pluginDir;
}

function validatePluginScriptPath(): string {
  return path.join(
    repoRoot(),
    '.agents',
    'skills',
    'create-aw-plugin',
    'scripts',
    'validate_plugin.mjs',
  );
}

function createAwPluginScriptPath(scriptName: string): string {
  return path.join(
    repoRoot(),
    '.agents',
    'skills',
    'create-aw-plugin',
    'scripts',
    scriptName,
  );
}

async function runGit(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd: root,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function ensureFixtureReadmes(pluginDir: string): Promise<void> {
  const pluginReadme = path.join(pluginDir, 'README.md');
  if (!(await fs.pathExists(pluginReadme))) {
    await fs.writeFile(pluginReadme, '# Test Plugin\n', 'utf8');
  }
  const skillsRoot = path.join(pluginDir, 'skills');
  if (!(await fs.pathExists(skillsRoot))) return;
  for (const entry of await fs.readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillReadme = path.join(skillsRoot, entry.name, 'README.md');
    if (!(await fs.pathExists(skillReadme))) {
      await fs.writeFile(
        skillReadme,
        '# Test Skill\n',
        'utf8',
      );
    }
  }
}

async function runValidatePlugin(
  pluginDir: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  await ensureFixtureReadmes(pluginDir);
  return execFileAsync('node', [validatePluginScriptPath(), pluginDir, ...extraArgs], {
    cwd: repoRoot(),
    env,
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

  await ensureFixtureReadmes(pluginDir);

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
        authentication: 'ON_INSTALL',
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
    omitCodexInvocationPolicy?: boolean;
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
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
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
      '  version: 2,',
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
    options.omitCodexInvocationPolicy
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
          authentication: 'ON_INSTALL',
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
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
    );
    const initHelp = await execFileAsync('node', [scriptPath, '--help'], {
      cwd: repoRoot(),
      env: process.env,
    });
    expect(initHelp.stdout).toContain(
      'New plugin scaffolds keep the initial stable version.',
    );

    for (const [pluginName, version] of [
      ['prerelease-version', '1.2.3-beta.1'],
      ['build-version', '1.2.3+build.1'],
    ]) {
      await expect(execFileAsync(
        'node',
        [
          scriptPath,
          pluginName,
          '--description',
          '用于验证源码插件稳定版本约束的示例插件。',
          '--no-skills',
          '--version',
          version,
          '--repo-root',
          tempRepo,
        ],
        { cwd: repoRoot(), env: process.env },
      )).rejects.toMatchObject({
        stderr: expect.stringContaining(
          '--version must be a stable SemVer without prerelease or build metadata.',
        ),
      });
      await expect(
        fs.pathExists(path.join(tempRepo, 'plugins', pluginName)),
      ).resolves.toBe(false);
    }

    await expect(
      execFileAsync(
        'node',
        [
          scriptPath,
          'invalid-skill-metadata',
          '--description',
          '用于验证 skill UI metadata 长度约束的示例插件。',
          '--skill-description',
          '检查仓库状态、配置、依赖与风险并输出可执行的诊断结论',
          '--skill-short-description',
          '仓库诊断',
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
      stderr: expect.stringContaining('--skill-short-description must be 25-64 characters'),
    });
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'invalid-skill-metadata')),
    ).resolves.toBe(false);

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
        '检查仓库状态、执行风险核验并生成结构化诊断报告工作流',
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
      apps: './.app.json',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
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
      fs.pathExists(path.join(tempRepo, '.changes', 'plugins')),
    ).resolves.toBe(false);
    await expect(fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'README.md'),
      'utf8',
    )).resolves.toContain('检查仓库状态并输出诊断结论。');
    await expect(fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'README.md'),
      'utf8',
    )).resolves.toContain('主要指令见 `SKILL.md`');
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md')),
    ).resolves.toBe(true);
    const skillMdContent = await fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md'),
      'utf8',
    );
    expect(skillMdContent).not.toContain('user-invocable:');
    expect(skillMdContent).not.toContain('disable-model-invocation:');
    expect(skillMdContent).toContain(
      'metadata:\n  short-description: "检查仓库状态、执行风险核验并生成结构化诊断报告工作流"',
    );
    expect(skillMdContent).toContain('完成标准：');
    expect(skillMdContent).toContain('## 验证');
    expect(skillMdContent).toContain('## 输出');
    expect(skillMdContent).toContain('## Gotchas / 边界');
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
      'short_description: "检查仓库状态、执行风险核验并生成结构化诊断报告工作流"',
    );
    expect(openaiYamlContent).toContain('allow_implicit_invocation: true');
    await expect(
      fs.readJson(
        path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'evals', 'manifest.json'),
      ),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      plugin: 'repo-check',
      skill: 'repo-check',
    });
    const modelTriggerCasesPath = path.join(
      tempRepo,
      'plugins',
      'repo-check',
      'skills',
      'repo-check',
      'evals',
      'trigger-cases.json',
    );
    await expect(fs.pathExists(modelTriggerCasesPath)).resolves.toBe(true);
    const modelTriggerCases = await fs.readJson(modelTriggerCasesPath) as {
      policy: {
        optimization: string;
        false_negative_cost: string;
        false_positive_cost: string;
      };
      cases: Array<{
        query: string;
        should_load_skill: boolean;
        eval_type: string;
        case_role: string;
        provenance: string;
        scenario_family: string;
        unit_under_test: string;
        preconditions: Record<string, unknown>;
        oracle: {
          rationale: string;
          rule_refs: string[];
          confidence: string;
          allowed_variance: string;
          minimal_counterexample?: string;
        };
      }>;
    };
    expect(modelTriggerCases.policy).toMatchObject({
      optimization: 'balanced',
      false_negative_cost: 'high',
      false_positive_cost: 'high',
    });
    expect(modelTriggerCases.cases
      .filter((entry) => entry.should_load_skill)
      .every((entry) => entry.query.includes(
        '检查仓库状态、执行风险核验并生成结构化诊断报告工作流',
      ))).toBe(true);
    expect(modelTriggerCases.cases.every((entry) => (
      entry.eval_type === 'trigger'
      && entry.scenario_family === 'primary-invocation-boundary'
      && Object.keys(entry.preconditions).length > 0
      && entry.oracle.rationale.length > 0
      && entry.oracle.rule_refs.length > 0
      && entry.oracle.allowed_variance.length > 0
    ))).toBe(true);
    expect(modelTriggerCases.cases
      .filter((entry) => !entry.should_load_skill)
      .every((entry) => (
        entry.case_role === 'boundary'
        && entry.provenance === 'boundary'
        && typeof entry.oracle.minimal_counterexample === 'string'
      ))).toBe(true);
    expect(JSON.stringify(modelTriggerCases)).not.toContain('$repo-check');
    const modelBehaviorCasesPath = path.join(
      tempRepo,
      'plugins',
      'repo-check',
      'skills',
      'repo-check',
      'evals',
      'evals.json',
    );
    const modelBehaviorCases = await fs.readJson(modelBehaviorCasesPath) as {
      policy: {
        optimization: string;
        false_negative_cost: string;
        false_positive_cost: string;
      };
      evals: Array<{
        eval_type: string;
        case_role: string;
        provenance: string;
        scenario_family: string;
        unit_under_test: string;
        preconditions: Record<string, unknown>;
        oracle: {
          confidence: string;
          rule_refs: string[];
        };
      }>;
    };
    expect(modelBehaviorCases.policy).toMatchObject({
      optimization: 'precision-first',
      false_negative_cost: 'medium',
      false_positive_cost: 'high',
    });
    expect(modelBehaviorCases.evals[0]).toMatchObject({
      eval_type: 'outcome',
      case_role: 'diagnostic',
      provenance: 'representative-synthetic',
      scenario_family: 'primary-workflow-outcome',
      unit_under_test: 'full-skill',
      oracle: {
        confidence: 'low',
      },
    });
    const evalCaseValidatorPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'skill-review',
      'scripts',
      'validate_eval_cases.mjs',
    );
    for (const evalCasesPath of [modelTriggerCasesPath, modelBehaviorCasesPath]) {
      const validation = await execFileAsync(
        'node',
        [evalCaseValidatorPath, evalCasesPath, '--strict', '--format', 'json'],
        { cwd: repoRoot(), env: process.env },
      );
      expect(JSON.parse(validation.stdout)).toMatchObject({
        mode: 'strict',
        valid: true,
        summary: {
          errors: 0,
          warnings: 0,
        },
      });
    }
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

  it('requires a Skill-specific description and maps explicit invocation modes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-invocation-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
    );

    await expect(execFileAsync('node', [
      scriptPath,
      'missing-skill-description',
      '--description',
      'Plugin-level description must not become a Skill discovery description.',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('--skill-description is required'),
    });

    await execFileAsync('node', [
      scriptPath,
      'manual-workflow',
      '--description',
      'Manual workflow plugin.',
      '--skill-description',
      'Run a side-effecting release workflow only after explicit user invocation.',
      '--skill-short-description',
      'Run a controlled release workflow after explicit user approval.',
      '--skill-invocation',
      'manual',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    const manualRoot = path.join(tempRepo, 'plugins', 'manual-workflow', 'skills', 'manual-workflow');
    await expect(fs.readFile(path.join(manualRoot, 'SKILL.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('user-invocable: true\ndisable-model-invocation: true'),
    );
    await expect(fs.readFile(path.join(manualRoot, 'agents', 'openai.yaml'), 'utf8')).resolves.toEqual(
      expect.stringContaining('allow_implicit_invocation: false'),
    );
    const manualTriggerCases = await fs.readJson(
      path.join(manualRoot, 'evals', 'trigger-cases.json'),
    ) as {
      policy: {
        optimization: string;
        false_negative_cost: string;
        false_positive_cost: string;
      };
      cases: Array<{ query: string; should_load_skill: boolean }>;
    };
    expect(manualTriggerCases.policy).toMatchObject({
      optimization: 'precision-first',
      false_negative_cost: 'medium',
      false_positive_cost: 'high',
    });
    expect(manualTriggerCases.cases
      .filter((entry) => entry.should_load_skill)
      .every((entry) => entry.query.includes('$manual-workflow'))).toBe(true);
    expect(manualTriggerCases.cases
      .filter((entry) => !entry.should_load_skill)
      .every((entry) => !entry.query.includes('$manual-workflow'))).toBe(true);

    await execFileAsync('node', [
      scriptPath,
      'claude-model-workflow',
      '--description',
      'Claude model-only workflow plugin.',
      '--skill-description',
      'Provide background knowledge to the model without a Claude picker entry.',
      '--skill-short-description',
      'Provide model-only background knowledge for repository tasks.',
      '--skill-invocation',
      'claude-model-only',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    const claudeModelRoot = path.join(
      tempRepo,
      'plugins',
      'claude-model-workflow',
      'skills',
      'claude-model-workflow',
    );
    await expect(fs.readFile(path.join(claudeModelRoot, 'SKILL.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('user-invocable: false'),
    );
    await expect(
      fs.readFile(path.join(claudeModelRoot, 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toEqual(expect.stringContaining('allow_implicit_invocation: true'));

    await expect(execFileAsync('node', [
      scriptPath,
      'invalid-invocation',
      '--description',
      'Invalid invocation plugin.',
      '--skill-description',
      'This description is long enough for the generated Skill UI metadata.',
      '--skill-short-description',
      'Validate an unsupported invocation mode for this initial Skill.',
      '--skill-invocation',
      'sometimes',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('--skill-invocation must be one of'),
    });
  });

  it('adds one static Skill to existing dual, Codex-only, and Claude-only plugins', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-add-skill-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const scriptPath = createAwPluginScriptPath('add_skill.mjs');

    const dualPluginRoot = path.join(tempRepo, 'plugins', 'git-commit');
    const dualReadmePath = path.join(dualPluginRoot, 'README.md');
    await fs.writeFile(dualReadmePath, '# Git Commit\n\nExisting documentation.\n', 'utf8');
    const dualReadmeBefore = await fs.readFile(dualReadmePath, 'utf8');
    const dualAdded = await execFileAsync('node', [
      scriptPath,
      'git-commit',
      '--skill-name',
      'release-notes',
      '--skill-description',
      '根据当前分支变更生成结构化发布说明并核对风险与遗漏',
      '--skill-invocation',
      'manual',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });

    const dualManifest = await fs.readJson(
      path.join(dualPluginRoot, '.agents-plugin', 'plugin.json'),
    );
    expect(dualManifest.version).toBe('0.1.0');
    expect(dualManifest.skills).toBe('./skills');
    expect(dualManifest.interface.capabilities).toContain('Skills');
    expect(dualAdded.stdout).toContain('Increase the stable version directly');
    await expect(fs.pathExists(path.join(tempRepo, '.changes'))).resolves.toBe(false);
    const dualSkillRoot = path.join(dualPluginRoot, 'skills', 'release-notes');
    await expect(fs.readFile(path.join(dualSkillRoot, 'SKILL.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('disable-model-invocation: true'),
    );
    await expect(
      fs.readFile(path.join(dualSkillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toEqual(expect.stringContaining('allow_implicit_invocation: false'));
    await expect(
      fs.readJson(path.join(dualSkillRoot, 'evals', 'manifest.json')),
    ).resolves.toMatchObject({ plugin: 'git-commit', skill: 'release-notes' });
    await expect(
      fs.readJson(path.join(dualSkillRoot, 'evals', 'trigger-cases.json')),
    ).resolves.toMatchObject({
      policy: {
        optimization: 'precision-first',
        false_negative_cost: 'medium',
        false_positive_cost: 'high',
      },
      cases: expect.arrayContaining([
        expect.objectContaining({
          eval_type: 'trigger',
          scenario_family: 'primary-invocation-boundary',
          oracle: expect.objectContaining({ confidence: 'medium' }),
        }),
      ]),
    });
    await expect(fs.readFile(dualReadmePath, 'utf8')).resolves.toBe(dualReadmeBefore);

    const manifestBeforeCollision = await fs.readFile(
      path.join(dualPluginRoot, '.agents-plugin', 'plugin.json'),
      'utf8',
    );
    await expect(execFileAsync('node', [
      scriptPath,
      'git-commit',
      '--skill-name',
      'commit',
      '--skill-description',
      '验证已有 Skill 名称冲突不会产生任何部分写入或版本变化',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Skill already exists'),
    });
    await expect(fs.readFile(
      path.join(dualPluginRoot, '.agents-plugin', 'plugin.json'),
      'utf8',
    )).resolves.toBe(manifestBeforeCollision);

    for (const platform of ['codex', 'claude'] as const) {
      const pluginName = `${platform}-only-add-skill`;
      const products = [platform.toUpperCase()];
      const { pluginDir } = await writeSourcePlugin(
        path.join(tempRepo, 'plugins'),
        pluginName,
        createBaseManifest(pluginName, {
          marketplace: {
            category: 'workflow',
            strict: true,
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
              products,
            },
          },
          interface: {
            displayName: pluginName,
            shortDescription: `${platform} only plugin`,
            capabilities: [],
          },
        }),
      );
      await execFileAsync('node', [
        scriptPath,
        pluginName,
        '--skill-name',
        'repo-report',
        '--skill-description',
        '检查仓库状态、核对配置和风险并生成可执行的结构化诊断报告',
        '--skill-invocation',
        platform === 'claude' ? 'claude-model-only' : 'manual',
        '--repo-root',
        tempRepo,
      ], { cwd: repoRoot(), env: process.env });

      const skillRoot = path.join(pluginDir, 'skills', 'repo-report');
      const skillMd = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
      if (platform === 'claude') {
        expect(skillMd).toContain('user-invocable: false');
        await expect(fs.pathExists(path.join(skillRoot, 'agents', 'openai.yaml'))).resolves.toBe(false);
        await expect(fs.pathExists(path.join(skillRoot, 'evals'))).resolves.toBe(false);
      } else {
        expect(skillMd).not.toContain('disable-model-invocation:');
        await expect(
          fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
        ).resolves.toEqual(expect.stringContaining('allow_implicit_invocation: false'));
        await expect(fs.pathExists(path.join(skillRoot, 'evals', 'manifest.json'))).resolves.toBe(true);
      }
    }

    const { pluginDir: dynamicConflictRoot } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'dynamic-conflict',
      createBaseManifest('dynamic-conflict', {
        artifacts: {
          targets: [
            {
              id: 'repo-report',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.skill',
              states: ['present'],
              refreshKeys: [],
              skillKey: 'repo-report',
            },
          ],
        },
      }),
    );
    await expect(execFileAsync('node', [
      scriptPath,
      'dynamic-conflict',
      '--skill-name',
      'repo-report',
      '--skill-description',
      '验证动态 Skill 所有权冲突会在写入前失败且不会产生部分源码',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('conflicts with dynamic artifact'),
    });
    await expect(fs.pathExists(path.join(dynamicConflictRoot, 'skills', 'repo-report')))
      .resolves.toBe(false);

    const { pluginDir: commandConflictRoot } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'command-conflict',
      createBaseManifest('command-conflict', { slashCommands: './slash-commands' }),
      { 'slash-commands/repo-report.md': '# Existing command\n' },
    );
    await expect(execFileAsync('node', [
      scriptPath,
      'command-conflict',
      '--skill-name',
      'repo-report',
      '--skill-description',
      '验证公共命令名称冲突会在写入前失败且不会产生部分源码',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('conflicts with slash command'),
    });
    await expect(fs.pathExists(path.join(commandConflictRoot, 'skills', 'repo-report')))
      .resolves.toBe(false);
  });

  const productionVersionCheckTest = fs.existsSync(
    path.join(repoRoot(), 'packages', 'cli', 'dist'),
  ) ? it : it.skip;
  productionVersionCheckTest('exercises detailed production version checks when a built CLI is present', async () => {
    const distRoot = path.join(repoRoot(), 'packages', 'cli', 'dist');

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-version-check-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    await fs.ensureDir(tempRepo);
    await fs.ensureSymlink(distRoot, path.join(tempRepo, 'packages', 'cli', 'dist'), 'dir');

    const { pluginDir, manifestPath } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'versioned-plugin',
      createBaseManifest('versioned-plugin', {
        skills: './skills',
        interface: {
          displayName: 'Versioned Plugin',
          shortDescription: 'Versioned plugin fixture',
          capabilities: ['Skills'],
        },
      }),
      {
        'skills/versioned-skill/SKILL.md': [
          '---',
          'name: versioned-skill',
          'description: Validate plugin version checks.',
          '---',
          '',
          '# Versioned Skill',
          '',
          'Baseline behavior.',
        ].join('\n'),
        'skills/versioned-skill/README.md': '# Versioned Skill\n',
        'skills/versioned-skill/agents/openai.yaml': [
          'interface:',
          '  display_name: "Versioned Skill"',
          '  short_description: "Validate plugin production version changes"',
          'policy:',
          '  allow_implicit_invocation: true',
        ].join('\n'),
      },
    );
    await runGit(tempRepo, ['init']);
    await runGit(tempRepo, ['add', 'plugins']);
    await runGit(tempRepo, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'baseline',
    ]);

    const checkerPath = createAwPluginScriptPath('check_plugin_versions.mjs');
    const skillMdPath = path.join(pluginDir, 'skills', 'versioned-skill', 'SKILL.md');
    await expect(execFileAsync('node', [
      checkerPath,
      'versioned-plugin',
      '--mode',
      'author',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown option: --mode'),
    });
    await fs.appendFile(skillMdPath, '\nChanged production behavior.\n', 'utf8');

    let missingBumpError: { stdout?: string } | undefined;
    try {
      await execFileAsync('node', [
        checkerPath,
        'versioned-plugin',
        '--json',
        '--repo-root',
        tempRepo,
      ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      missingBumpError = error as { stdout?: string };
    }
    expect(missingBumpError?.stdout).toBeTruthy();
    const missingBumpReport = JSON.parse(missingBumpError!.stdout!);
    expect(missingBumpReport.ok).toBe(false);
    expect(missingBumpReport.schemaVersion).toBe(2);
    expect(missingBumpReport).not.toHaveProperty('mode');
    expect(missingBumpReport.checks[0]).toMatchObject({
      status: 'missingVersionBump',
      productionChanged: true,
    });
    expect(missingBumpReport.checks[0]).not.toHaveProperty('plannedBump');
    expect(missingBumpReport.checks[0]).not.toHaveProperty('targetVersion');
    expect(missingBumpReport.checks[0]).not.toHaveProperty('releaseIntentFiles');
    expect(missingBumpReport.checks[0].changedPaths).toContain(
      'codex/skills/versioned-skill/SKILL.md',
    );

    const changedManifest = await fs.readJson(manifestPath);
    changedManifest.version = '0.2.0';
    await fs.writeJson(manifestPath, changedManifest, { spaces: 2 });
    const bumped = await execFileAsync('node', [
      checkerPath,
      'versioned-plugin',
      '--json',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(bumped.stdout).checks[0]).toMatchObject({
      status: 'versionBumped',
      baseVersion: '0.1.0',
      currentVersion: '0.2.0',
      productionChanged: true,
    });
    await runGit(tempRepo, ['add', 'plugins']);
    await runGit(tempRepo, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'versioned production change',
    ]);
    await fs.outputFile(
      path.join(pluginDir, 'skills', 'versioned-skill', 'evals', 'cases.json'),
      '{}\n',
    );
    await fs.outputFile(path.join(pluginDir, 'reports', 'run', 'summary.json'), '{}\n');
    const authorOnly = await execFileAsync('node', [
      checkerPath,
      'versioned-plugin',
      '--json',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(authorOnly.stdout).checks[0]).toMatchObject({
      status: 'unchanged',
      productionChanged: false,
    });

    const skillReadmePath = path.join(pluginDir, 'skills', 'versioned-skill', 'README.md');
    await fs.appendFile(skillReadmePath, '\nPublished documentation change.\n', 'utf8');
    await expect(execFileAsync('node', [
      checkerPath,
      'versioned-plugin',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stdout: expect.stringContaining('missingVersionBump'),
    });

    await fs.writeFile(skillReadmePath, '# Versioned Skill\n', 'utf8');
    for (const invalidVersion of ['0.2.1-beta.1', '0.2.0+metadata']) {
      const invalidManifest = await fs.readJson(manifestPath);
      invalidManifest.version = invalidVersion;
      await fs.writeJson(manifestPath, invalidManifest, { spaces: 2 });
      await expect(execFileAsync('node', [
        checkerPath,
        'versioned-plugin',
        '--repo-root',
        tempRepo,
      ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
        stdout: expect.stringContaining('stable SemVer'),
      });
    }

    const versionOnlyManifest = await fs.readJson(manifestPath);
    versionOnlyManifest.version = '0.2.1';
    await fs.writeJson(manifestPath, versionOnlyManifest, { spaces: 2 });
    const versionOnly = await execFileAsync('node', [
      checkerPath,
      'versioned-plugin',
      '--json',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(versionOnly.stdout).checks[0]).toMatchObject({
      status: 'versionOnly',
      currentVersion: '0.2.1',
      warnings: [expect.stringContaining('production bundle is unchanged')],
    });

    await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'new-plugin',
      createBaseManifest('new-plugin'),
    );
    const newPlugin = await execFileAsync('node', [
      checkerPath,
      'new-plugin',
      '--json',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    const newPluginReport = JSON.parse(newPlugin.stdout);
    expect(newPluginReport.schemaVersion).toBe(2);
    const newPluginCheck = newPluginReport.checks[0];
    expect(newPluginCheck).toMatchObject({
      status: 'new',
      currentVersion: '0.1.0',
      productionChanged: true,
    });

    await fs.writeJson(
      path.join(tempRepo, 'plugins', 'marketplace-source.json'),
      { owner: { name: 'Test' } },
      { spaces: 2 },
    );
    const allChanged = await execFileAsync('node', [
      checkerPath,
      '--all',
      '--',
      '--json',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    expect(JSON.parse(allChanged.stdout).checks.map((check: { plugin: string }) => check.plugin))
      .toEqual(['new-plugin', 'versioned-plugin']);

    await fs.remove(path.join(tempRepo, 'packages', 'cli', 'dist'));
    await expect(execFileAsync('node', [
      checkerPath,
      '--all',
      '--',
      '--repo-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('requires a built CLI'),
    });
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
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
    );

    await execFileAsync(
      'node',
      [
        scriptPath,
        'catalog-aware',
        '--description',
        '用于验证 catalog 最低版本上下文与兼容性约束的示例插件。',
        '--no-skills',
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
          '--no-skills',
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

  it('validate_plugin.mjs rejects invalid authoring version contracts and catalog gates', async () => {
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
            authentication: 'ON_INSTALL',
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

    const invalidAuthenticationDir = path.join(pluginsRoot, 'invalid-authentication');
    await writeAuthoringPluginManifest(invalidAuthenticationDir, {
      ...createBaseManifest('invalid-authentication'),
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
    });
    await expect(runValidatePlugin(invalidAuthenticationDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'Invalid marketplace.policy.authentication: expected "ON_INSTALL" or "ON_USE".',
      ),
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
            minVersion: '0.145.0',
          },
        },
      },
      { preserveCompatibility: true },
    );
    await expect(runValidatePlugin(perAgentVersionDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('compatibility has unknown field "codex"'),
    });
  });

  it('supports explicit skill UI metadata without changing the trigger description', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-skill-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
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
        '--skill-short-description',
        '检查仓库状态、配置、依赖与风险并输出可执行的诊断结论',
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
    expect(skillMdContent).toContain(
      'metadata:\n  short-description: "检查仓库状态、配置、依赖与风险并输出可执行的诊断结论"',
    );

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
    expect(openaiYamlContent).toContain(
      'short_description: "检查仓库状态、配置、依赖与风险并输出可执行的诊断结论"',
    );
    expect(openaiYamlContent).toContain(
      'default_prompt: "使用 $repo-diagnose：检查仓库状态、配置、依赖与风险并输出可执行的诊断结论。"',
    );
    expect(openaiYamlContent).not.toContain('display_name: "Automation Suite"');
    expect(openaiYamlContent).not.toContain(
      'short_description: "检查仓库状态并输出诊断结论"',
    );
    expect(openaiYamlContent).not.toContain('short_description: "自动化插件集合"');

    const helpResult = await execFileAsync('node', [scriptPath, '--help'], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(helpResult.stdout).toContain('--skill-short-description');
    expect(helpResult.stdout).toContain('--skill-invocation <mode>');
  });

  it('standard aw-config helper exposes help without manifest or store discovery', async () => {
    const helperPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'assets',
      'aw-config.mjs',
    );

    const [shortHelp, longHelp] = await Promise.all([
      execFileAsync('node', [helperPath, '-h'], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync('node', [helperPath, '--help'], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);

    for (const result of [shortHelp, longHelp]) {
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('get <key>');
      expect(result.stdout).toContain('json');
      expect(result.stdout).toContain('--scope <scope>');
      expect(result.stderr).toBe('');
    }
  });

  it('standard aw-config helper prefers AW_PLUGIN_CONTEXT without manifest or store discovery', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-helper-context-'));
    tempDirs.push(tempRoot);

    const helperPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
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
        'create-aw-plugin',
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
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
        'create-aw-plugin',
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
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
    );
    const validateScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
      'create-aw-plugin',
      'scripts',
      'init_plugin.mjs',
    );
    const validateScriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
        '--skill-short-description',
        'Summarize "repo" state: quick view',
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
      'metadata:\n  short-description: "Summarize \\"repo\\" state: quick view"',
    );

    const openaiYamlContent = await fs.readFile(openaiYamlPath, 'utf8');
    expect(openaiYamlContent).toContain('display_name: "Repo Audit"');
    expect(openaiYamlContent).toContain(
      'short_description: "Summarize \\"repo\\" state: quick view"',
    );
    expect(openaiYamlContent).toContain(
      'default_prompt: "使用 $repo-audit：Summarize \\"repo\\" state: quick view。"',
    );

    await fs.writeFile(
      skillMdPath,
      skillMdContent
        .replace(
          '[TODO: 写清用户要完成的结果，以及没有本 skill 时 agent 容易做错什么]',
          '检查仓库状态并避免遗漏风险',
        )
        .replace('[TODO: 可观察、可验证的成功结果]', '输出包含风险和证据的报告')
        .replace('[TODO: 需要读取的输入、状态或授权边界]', '先读取仓库状态且不扩大范围')
        .replace('[TODO: 第一步，以及为什么需要这一步]', '收集状态，建立事实基础')
        .replace('[TODO: 可检查的第一步结果]', '已记录仓库状态和检查范围')
        .replace('[TODO: 第二步]', '分析风险')
        .replace('[TODO: 可检查的第二步结果]', '已列出有证据的风险')
        .replace('[TODO: 运行验证；失败时修复并重跑]', '校验报告；发现遗漏时补齐并重跑')
        .replace('[TODO: 验证通过，或失败已修复并重验]', '报告检查通过')
        .replace('[TODO: 验证命令、检查表或输出断言]', '检查报告包含状态、风险和证据')
        .replace('[TODO: 交付文件、数据或回复结构]', '输出结构化检查报告')
        .replace(
          '[TODO: 没有明确说明时 agent 容易误判的项目事实]',
          '不要把未跟踪文件误判为用户允许删除',
        )
        .replace(
          '[TODO: 禁止、需要确认或不能扩大范围的操作]',
          '遇到高风险操作时先停下来说明',
        ),
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

  it('validates the documented minimum plugin manifest example', async () => {
    const root = repoRoot();
    const manifestSpecDoc = await fs.readFile(
      path.join(
        root,
        '.agents',
        'skills',
        'create-aw-plugin',
        'references',
        'plugin-manifest-spec.md',
      ),
      'utf8',
    );

    expect(() =>
      validatePluginManifest(
        path.join(os.tmpdir(), 'documented-plugin'),
        extractJsonFenceAfter(manifestSpecDoc, '## 最小 manifest 示例'),
      ),
    ).not.toThrow();
  });

  it('keeps the generated Skill frontmatter reference current', async () => {
    await execFileAsync(
      'node',
      [
        createAwPluginScriptPath('generate_skill_frontmatter_reference.mjs'),
        '--check',
      ],
      { cwd: repoRoot(), env: process.env },
    );
  });

  it('validates the create-aw-plugin static eval contract', async () => {
    const root = repoRoot();
    const result = await execFileAsync(
      'node',
      [
        path.join(
          root,
          '.agents',
          'skills',
          'skill-review',
          'scripts',
          'run_static_skill_evals.mjs',
        ),
        'create-aw-plugin',
        '--validate-only',
      ],
      { cwd: root, env: process.env },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      skill: 'create-aw-plugin',
      suites: ['trigger', 'behavior'],
    });
  });

  it('validates the checked-in authoring eval corpora with the shared validator', async () => {
    const root = repoRoot();
    const creatorSkillRoot = path.join(
      root,
      '.agents',
      'skills',
      'create-aw-plugin',
    );
    const validatorPath = path.join(
      root,
      '.agents',
      'skills',
      'skill-review',
      'scripts',
      'validate_eval_cases.mjs',
    );
    const cases = [
      {
        path: path.join(creatorSkillRoot, 'evals', 'trigger-cases.json'),
        strict: false,
      },
      {
        path: path.join(creatorSkillRoot, 'evals', 'evals.json'),
        strict: false,
      },
      {
        path: path.join(
          creatorSkillRoot,
          'references',
          '.examples',
          'code-review',
          'skills',
          'review-workflow',
          'evals',
          'evals.json',
        ),
        strict: true,
      },
    ];

    for (const evalCase of cases) {
      const result = await execFileAsync(
        'node',
        [
          validatorPath,
          evalCase.path,
          ...(evalCase.strict ? ['--strict'] : []),
          '--format',
          'json',
        ],
        { cwd: root, env: process.env },
      );

      expect(JSON.parse(result.stdout), evalCase.path).toMatchObject({ valid: true });
    }
  });

  it('validate_plugin.mjs validates optional plugin eval manifests', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-authoring-'));
    tempDirs.push(tempRoot);
    const pluginDir = path.join(tempRoot, 'eval-demo');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'eval-demo', 'agents'));
    const evalDir = path.join(pluginDir, 'skills', 'eval-demo', 'evals');
    await fs.ensureDir(evalDir);
    await fs.writeJson(
      path.join(pluginDir, '.agents-plugin', 'plugin.json'),
      withDefaultCompatibility({
        name: 'eval-demo',
        version: '0.1.0',
        description: 'Test the plugin eval authoring contract.',
        skills: './skills',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      }),
      { spaces: 2 },
    );
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'eval-demo', 'SKILL.md'),
      [
        '---',
        'name: eval-demo',
        'description: Run the eval manifest authoring contract fixture.',
        'user-invocable: true',
        'disable-model-invocation: true',
        '---',
        '',
        '# Eval Demo',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginDir, 'skills', 'eval-demo', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
      'utf8',
    );
    await fs.writeJson(path.join(evalDir, 'trigger-cases.json'), {
      schemaVersion: 1,
      skill: 'eval-demo',
      cases: [{
        id: 'explicit_eval_demo',
        split: 'validation',
        query: '$eval-demo inspect the fixture.',
        should_load_skill: true,
      }],
    }, { spaces: 2 });

    const evalManifestPath = path.join(evalDir, 'manifest.json');
    const validEvalManifest = {
      schemaVersion: 2,
      plugin: 'eval-demo',
      skill: 'eval-demo',
      profiles: [
        {
          id: 'project-default',
          scope: 'project',
          plugins: [{ name: 'eval-demo', config: {} }],
          runModel: true,
          requiredForRelease: true,
        },
        {
          id: 'user-default',
          scope: 'user',
          plugins: [{ name: 'eval-demo', config: {} }],
          runModel: false,
          requiredForRelease: true,
        },
      ],
      suites: [
        {
          id: 'trigger',
          kind: 'trigger',
          skills: ['eval-demo'],
          cases: './trigger-cases.json',
          observeSpawnAgent: false,
          isolation: 'standard',
          strictNegativeSplits: ['validation'],
          profiles: ['project-default'],
          defaultRuns: 1,
          releaseSplits: ['validation'],
          requiredForRelease: true,
          perRunTimeoutMs: 10_000,
        },
      ],
    };
    await fs.writeJson(evalManifestPath, validEvalManifest, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const routeCasesPath = path.join(evalDir, 'trigger-cases.json');
    const routeCases = await fs.readJson(routeCasesPath);
    delete routeCases.cases[0].should_load_skill;
    routeCases.cases[0].expected_loaded_skills = [];
    await fs.writeJson(routeCasesPath, routeCases, { spaces: 2 });
    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      suites: [{
        ...validEvalManifest.suites[0],
        minimumPassRate: 0.9,
        forbidMultipleSkillLoads: true,
      }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    delete routeCases.cases[0].expected_loaded_skills;
    routeCases.cases[0].should_load_skill = true;
    await fs.writeJson(routeCasesPath, routeCases, { spaces: 2 });
    await fs.writeJson(evalManifestPath, validEvalManifest, { spaces: 2 });

    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      profiles: validEvalManifest.profiles.map((profile, index) =>
        index === 0 ? { ...profile, unsupportedField: true } : profile),
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'skills/eval-demo/evals/manifest.json.profiles[0] has unknown field "unsupportedField"',
      ),
    });
    await fs.writeJson(evalManifestPath, validEvalManifest, { spaces: 2 });

    if (process.platform !== 'win32') {
      const casesPath = path.join(evalDir, 'trigger-cases.json');
      const outsideCasesPath = path.join(tempRoot, 'outside-trigger-cases.json');
      await fs.copyFile(casesPath, outsideCasesPath);
      await fs.remove(casesPath);
      await fs.symlink(outsideCasesPath, casesPath);
      await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringContaining('must stay inside the Skill eval directory'),
      });
      await fs.remove(casesPath);
      await fs.copyFile(outsideCasesPath, casesPath);
    }

    const conversationCasesPath = path.join(evalDir, 'conversation-cases.json');
    const conversationSuite = {
      id: 'behavior',
      kind: 'conversation',
      skills: ['eval-demo'],
      cases: './conversation-cases.json',
      isolation: 'strict',
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
    };
    const conversationManifest = {
      ...validEvalManifest,
      suites: [conversationSuite],
    };
    const validConversationCase = {
      id: 'behavior_case',
      prompt: 'Review the fixture.',
      scripted_replies: [],
      expected_output: 'Return a review.',
      workspace_files: {
        'docs/eval-context.md': 'Known project fact.\n',
      },
      review: { checks: ['Reviews the fixture.'], workspace_unchanged: true },
    };
    await fs.writeJson(conversationCasesPath, {
      skill_name: 'eval-demo',
      evals: [validConversationCase],
    }, { spaces: 2 });
    await fs.writeJson(evalManifestPath, conversationManifest, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const invalidWorkspaceFiles = [
      {
        workspaceFiles: {},
        expectedError: 'workspace_files must contain at least one file',
      },
      {
        workspaceFiles: { '../escape.md': 'escape' },
        expectedError: 'must be a normalized POSIX path inside the eval workspace',
      },
      {
        workspaceFiles: { '.agents/escape.md': 'escape' },
        expectedError: 'must not target an eval control directory',
      },
      {
        workspaceFiles: { 'docs/empty.md': '   ' },
        expectedError: 'workspace_files.docs/empty.md must not be empty',
      },
    ];
    for (const { workspaceFiles, expectedError } of invalidWorkspaceFiles) {
      await fs.writeJson(conversationCasesPath, {
        skill_name: 'eval-demo',
        evals: [{ ...validConversationCase, workspace_files: workspaceFiles }],
      }, { spaces: 2 });
      await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringContaining(expectedError),
      });
    }
    await fs.writeJson(conversationCasesPath, {
      skill_name: 'eval-demo',
      evals: [validConversationCase],
    }, { spaces: 2 });

    await fs.writeJson(evalManifestPath, {
      ...conversationManifest,
      suites: [{ ...conversationSuite, isolation: 'partial' }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('isolation must be standard or strict'),
    });
    await fs.writeJson(evalManifestPath, conversationManifest, { spaces: 2 });

    await fs.writeJson(evalManifestPath, {
      ...conversationManifest,
      suites: [{ ...conversationSuite, releaseSplits: ['validation'] }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'cannot declare releaseSplits because conversation cases do not support split filtering',
      ),
    });
    await fs.writeJson(evalManifestPath, conversationManifest, { spaces: 2 });

    await fs.writeJson(conversationCasesPath, {
      skill_name: 'eval-demo',
      evals: [],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('evals must be a non-empty array'),
    });

    await fs.writeJson(conversationCasesPath, {
      skill_name: 'other-skill',
      evals: [validConversationCase],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('skill_name must match "eval-demo"'),
    });

    await fs.writeJson(conversationCasesPath, {
      skill_name: 'eval-demo',
      evals: [validConversationCase, { ...validConversationCase, id: ' behavior_case ' }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('duplicate case id "behavior_case"'),
    });

    await fs.writeJson(conversationCasesPath, {
      skill_name: 'eval-demo',
      evals: [{ ...validConversationCase, prompt: 42 }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('prompt must be a string'),
    });

    await fs.writeFile(
      path.join(evalDir, 'domain-runner.mjs'),
      'process.stdout.write(JSON.stringify({ complete: true, passed: true }));\n',
      'utf8',
    );
    const commandSuite = {
      id: 'domain',
      kind: 'command',
      skills: ['eval-demo'],
      entry: './domain-runner.mjs',
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
      suiteTimeoutMs: 30_000,
      supports: [],
    };
    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      suites: [commandSuite],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    await fs.writeJson(path.join(evalDir, 'command-cases.json'), {
      skill_name: 'eval-demo',
      evals: [{ id: 'selected_case' }],
    }, { spaces: 2 });
    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      suites: [{
        ...commandSuite,
        cases: './command-cases.json',
        supports: ['case'],
      }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      suites: [{ ...commandSuite, supports: ['case'] }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('cases is required when supports includes case'),
    });

    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      suites: [{ ...commandSuite, suiteTimeoutMs: 9_999 }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'suiteTimeoutMs must be greater than or equal to perRunTimeoutMs',
      ),
    });

    await fs.writeJson(evalManifestPath, {
      ...validEvalManifest,
      profiles: validEvalManifest.profiles.map((profile) =>
        profile.id === 'user-default' ? { ...profile, runModel: true } : profile),
      suites: [{
        ...validEvalManifest.suites[0],
        cases: '../outside.json',
        profiles: ['user-default', 'missing-profile'],
      }],
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('does not allow real model execution for user scope'),
    });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('references unknown profile "missing-profile"'),
    });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('must stay inside the Skill eval directory'),
    });
  });

  it('validate_plugin.mjs rejects bad scripts/config authoring contracts without package-manager staging', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-scripts-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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

  it('validate_plugin.mjs validates dynamic Codex artifact renderer contracts', async () => {
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

  it('validate_plugin.mjs isolates the dynamic artifact renderer fixture environment', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-artifact-env-'));
    tempDirs.push(tempRoot);
    const { pluginDir } = await writeDynamicArtifactPlugin(tempRoot);
    const rendererPath = path.join(pluginDir, 'scripts', 'render-artifacts.mjs');
    const renderer = await fs.readFile(rendererPath, 'utf8');
    await fs.writeFile(
      rendererPath,
      [
        'if (process.env.AW_VALIDATOR_SECRET_SENTINEL) throw new Error("parent secret leaked");',
        'if (!process.env.AW_PLUGIN_CONTEXT) throw new Error("missing renderer context");',
        'if (process.env.AW_PLUGIN_NAME !== "dynamic-authoring-test") throw new Error("missing plugin identity");',
        'if (process.env.AW_PLUGIN_EVENT !== "install") throw new Error("missing fixture event");',
        'const context = JSON.parse((await import("node:fs")).readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'if (context.config.mode !== "artifact-render") throw new Error("missing config mode");',
        'if (context.config.values.explorerModel !== "gpt-5.4-mini") throw new Error("missing config values");',
        'if (context.renderConfig || context.artifactRenderConfig) throw new Error("validator-only context alias");',
        renderer,
      ].join('\n'),
      'utf8',
    );

    await expect(runValidatePlugin(pluginDir, [], {
      ...process.env,
      AW_VALIDATOR_SECRET_SENTINEL: 'must-not-reach-renderer',
    })).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.mjs requires non-empty plugin and Skill README files only', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-readme-authoring-'));
    tempDirs.push(tempRoot);
    const { pluginDir } = await writeDynamicArtifactPlugin(tempRoot);
    await ensureFixtureReadmes(pluginDir);
    const pluginReadme = path.join(pluginDir, 'README.md');
    const skillReadme = path.join(
      pluginDir,
      'skills',
      'dynamic-authoring-test',
      'README.md',
    );
    const runDirect = () => execFileAsync('node', [validatePluginScriptPath(), pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    await fs.remove(pluginReadme);
    await expect(runDirect()).rejects.toMatchObject({
      stdout: expect.stringContaining('Plugin root README.md is required'),
    });
    await fs.writeFile(pluginReadme, '\n', 'utf8');
    await expect(runDirect()).rejects.toMatchObject({
      stdout: expect.stringContaining('Plugin root README.md must not be empty'),
    });
    await fs.writeFile(pluginReadme, '# Dynamic Authoring Test\n', 'utf8');
    await fs.remove(skillReadme);
    await expect(runDirect()).rejects.toMatchObject({
      stdout: expect.stringContaining('skills/dynamic-authoring-test/README.md is required'),
    });
    await fs.writeFile(skillReadme, '\n', 'utf8');
    await expect(runDirect()).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'skills/dynamic-authoring-test/README.md must not be empty',
      ),
    });
    await fs.writeFile(skillReadme, '# Dynamic Skill\n', 'utf8');
    await expect(runDirect()).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
  });

  it('validate_plugin.mjs validates artifact target platforms against supported products', async () => {
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

    const dynamicClaude = await writeSourcePlugin(
      path.join(tempRoot, 'claude-dynamic'),
      'claude-dynamic',
      createBaseManifest('claude-dynamic', {
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
            products: ['CLAUDE'],
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
          targets: [{
            id: 'claude-dynamic-skill',
            platform: 'claude',
            scopes: ['user', 'project'],
            target: 'claude.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'claude-dynamic',
            sourceDirs: ['./skills/claude-dynamic'],
          }],
        },
      }),
      {
        'skills/claude-dynamic/SKILL.md': '---\nname: claude-dynamic\ndescription: Dynamic Claude skill.\n---\n\n# Dynamic Claude\n',
        'scripts/render-artifacts.mjs': [
          'const context = JSON.parse(await (await import("node:fs/promises")).readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
          '  id: "claude-dynamic-skill", platform: "claude", target: "claude.skill", kind: "skill",',
          '  state: "present", refreshKeys: [], skillKey: "claude-dynamic",',
          '  content: { files: { "references/runtime.md": `scope=${context.scope}\\n` } }',
          '}] }));',
        ].join('\n'),
      },
    );
    await fs.outputFile(
      path.join(dynamicClaude.pluginDir, 'skills', 'claude-dynamic', 'assets', 'icon.bin'),
      Buffer.from([0, 255, 1]),
    );
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    const dynamicClaudeManifest = await fs.readJson(dynamicClaude.manifestPath);
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: [
            './skills/claude-dynamic',
            './skills/claude-dynamic',
          ],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('sourceDirs must not contain duplicate directories'),
    });
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: [
            './skills/claude-dynamic',
            './skills/claude-dynamic/../claude-dynamic',
          ],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('sourceDirs must not contain duplicate directories'),
    });
    await fs.writeJson(dynamicClaude.manifestPath, dynamicClaudeManifest, { spaces: 2 });

    const dynamicClaudeSource = path.join(
      dynamicClaude.pluginDir,
      'skills',
      'claude-dynamic',
    );
    const skillPath = path.join(dynamicClaudeSource, 'SKILL.md');
    const skillContent = await fs.readFile(skillPath);
    await fs.remove(skillPath);
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('final file tree must contain a non-empty SKILL.md'),
    });

    await fs.writeFile(skillPath, skillContent);
    await fs.outputFile(path.join(dynamicClaudeSource, 'references'), 'static file\n');
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('final file tree path "references" conflicts with "references/runtime.md"'),
    });
    await fs.remove(path.join(dynamicClaudeSource, 'references'));

    await fs.ensureDir(path.join(dynamicClaudeSource, 'evals'));
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: ['./skills/claude-dynamic/assets'],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'sourceDirs must include "./skills/claude-dynamic" so README.md is published',
      ),
    });
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: [
            './skills/claude-dynamic',
            './skills/claude-dynamic/evals',
          ],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('must not point inside an author-only Skill directory'),
    });
    await fs.outputFile(
      path.join(dynamicClaudeSource, 'references', 'evals', 'contract.md'),
      '# Runtime eval contract\n',
    );
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: [
            './skills/claude-dynamic',
            './skills/claude-dynamic/references/evals',
          ],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    await fs.writeJson(dynamicClaude.manifestPath, dynamicClaudeManifest, { spaces: 2 });

    const sourceLink = path.join(dynamicClaudeSource, 'source-link');
    await fs.symlink('.', sourceLink);
    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [{
          ...dynamicClaudeManifest.artifacts.targets[0],
          sourceDirs: ['./skills/claude-dynamic/source-link'],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('sourceDirs[0] must point to an existing directory'),
    });

    await fs.writeJson(dynamicClaude.manifestPath, {
      ...dynamicClaudeManifest,
      artifacts: {
        targets: [
          dynamicClaudeManifest.artifacts.targets[0],
          {
            ...dynamicClaudeManifest.artifacts.targets[0],
            id: 'claude-dynamic-skill-copy',
          },
        ],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(dynamicClaude.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('duplicate skill ownership "claude:user:claude-dynamic"'),
    });
  });

  it('validate_plugin.mjs rejects dynamic role metadata and missing Codex invocation policy', async () => {
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
      { omitCodexInvocationPolicy: true },
    );
    await expect(runValidatePlugin(missingPolicy.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('policy is required for Codex-targeted skills'),
    });
  });

  it('validate_plugin.mjs accepts native hooks and rejects hook contract mistakes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-hooks-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
    await ensureFixtureReadmes(pluginDir);

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

  it('validate_plugin.mjs enforces platform-scoped authoring contracts', async () => {
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
              authentication: 'ON_INSTALL',
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

  it('validate_plugin.mjs passes on the reference code-review example', async () => {
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    const pluginDir = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
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

  it('validate_plugin.mjs validates public slashCommands source contracts', async () => {
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
    await ensureFixtureReadmes(validPluginDir);
    await expect(
      execFileAsync('node', [scriptPath, validPluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toBeDefined();

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

  it('validate_plugin.mjs scopes slashCommands validation to the final supported platforms', async () => {
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
          authentication: 'ON_INSTALL',
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

  it('validate_plugin.mjs only validates slash command frontmatter for supported platforms', async () => {
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

  it('validate_plugin.mjs enforces Codex skill metadata and YAML shape', async () => {
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
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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

    const overlongCodexText = 'x'.repeat(65);
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
    expect(invalidOpenAiYamlStdout).toContain('interface.short_description must be <= 64 characters');
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
        'interface:',
        '  short_description: "Too short"',
        '  default_prompt: "Use $metadata-test to validate metadata."',
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
      stdout: expect.stringContaining('interface.short_description must be >= 25 characters'),
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

  it('validate_plugin.mjs validates manifest marketplace policy products', async () => {
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
          authentication: 'ON_INSTALL',
          products: ['CODEX', 'BROWSER'],
        },
      },
    }), { spaces: 2 });

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await ensureFixtureReadmes(pluginDir);

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

  it('validate_plugin.mjs accepts and validates Codex policy products', async () => {
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
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
    await ensureFixtureReadmes(pluginDir);
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

  it('validate_plugin.mjs accepts runtime-compatible YAML block scalars and tool commands', async () => {
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
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await ensureFixtureReadmes(pluginDir);
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

  it('validate_plugin.mjs validates rendered templated skill metadata', async () => {
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
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
              codex: 'Codex metadata validation workflow',
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await ensureFixtureReadmes(pluginDir);
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

  it('validate_plugin.mjs treats openai.yaml as optional for non-Codex skills', async () => {
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
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await ensureFixtureReadmes(pluginDir);
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

  it('validate_plugin.mjs separates Agent Skills core fields from target platform extensions', async () => {
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
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
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
    await ensureFixtureReadmes(pluginDir);
    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate frontmatter handling.',
        'when_to_use: false',
        'when_to_uses: Typo must remain unknown.',
        'license: false',
        'compatibility: []',
        'user-invocable: "TRUE"',
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
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
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
    expect(invalidFrontmatterStdout).toContain(
      '[known-field-invalid-type-value] field "when_to_use"',
    );
    expect(invalidFrontmatterStdout).toContain('[unknown-field] field "when_to_uses"');
    expect(invalidFrontmatterStdout).toContain('frontmatter.license must be a string');
    expect(invalidFrontmatterStdout).toContain('frontmatter.compatibility must be a string');
    expect(invalidFrontmatterStdout).toContain(
      '[known-field-invalid-type-value] field "user-invocable"',
    );
    expect(invalidFrontmatterStdout).toContain('frontmatter.metadata.short-description must be a string');
    expect(invalidFrontmatterStdout).toContain(
      '[known-field-invalid-type-value] field "allowed-tools"',
    );
    expect(invalidFrontmatterStdout).toContain(
      '[known-field-invalid-type-value] field "shell" must be one of "bash", "powershell"',
    );

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate frontmatter handling.',
        'when_to_use: Use for Claude Code frontmatter validation.',
        'argument-hint: "[path]"',
        'arguments:',
        '  - path',
        'version: 0.1.0',
        'user-invocable: "true"',
        'disable-model-invocation: "false"',
        'model: sonnet',
        'effort: high',
        'context: fork',
        'agent: Explore',
        'hooks: {}',
        'paths:',
        '  - packages/cli/**',
        'metadata:',
        '  short-description: Frontmatter validation',
        'allowed-tools:',
        '  - Bash(git status *)',
        '  - Read',
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
    expect(result.stdout).toContain('[PASS] All checks passed.');

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate current Claude Code frontmatter.',
        'metadata:',
        '  owner:',
        '    team: agent-workflows',
        '  priority: 1',
        'user-invocable: "YES"',
        'context: fork',
        'background: ON',
        'disallowed-tools: Bash(rm *)',
        '---',
        '',
        '# Current Claude Frontmatter',
      ].join('\n'),
      'utf8',
    );
    let minimumProfileStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      minimumProfileStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(minimumProfileStdout).toContain(
      '[known-field-not-supported-by-target-version] field "background"',
    );
    expect(minimumProfileStdout).toContain('Claude Code 2.1.218');
    expect(minimumProfileStdout).toContain(
      '[known-field-not-supported-by-target-version] field "disallowed-tools"',
    );

    await expect(
      execFileAsync(
        'node',
        [scriptPath, pluginDir, '--claude-skill-profile', 'current'],
        {
          cwd: repoRoot(),
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('[PASS] All checks passed.') });

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate related current Claude Code fields.',
        'background: true',
        '---',
        '',
        '# Related Current Claude Frontmatter',
      ].join('\n'),
      'utf8',
    );
    let relatedFieldStdout = '';
    try {
      await execFileAsync(
        'node',
        [scriptPath, pluginDir, '--claude-skill-profile', 'current'],
        {
          cwd: repoRoot(),
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (error) {
      relatedFieldStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(relatedFieldStdout).toContain(
      '[known-field-requires-related-field] field "background" requires "context"="fork"',
    );

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate frontmatter handling.',
        'user-invocable: true',
        'disable-model-invocation: false',
        'allowed-tools:',
        '  - Bash(git status *)',
        '  - Read',
        'shell: PowerShell',
        '---',
        '',
        '# Frontmatter Test',
      ].join('\n'),
      'utf8',
    );

    let strictExtensionStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir, '--strict-agent-skills'], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      strictExtensionStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(strictExtensionStdout).toContain(
      '[portable-profile-platform-extension] field "user-invocable"',
    );
    expect(strictExtensionStdout).toContain(
      '[portable-profile-platform-extension] field "disable-model-invocation"',
    );
    expect(strictExtensionStdout).toContain(
      '[portable-profile-platform-extension] field "shell"',
    );
    expect(strictExtensionStdout).toContain(
      '[known-field-invalid-type-value] field "allowed-tools"',
    );

    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const codexOnlyManifest = await fs.readJson(manifestPath);
    codexOnlyManifest.marketplace.policy.products = ['CODEX'];
    await fs.writeJson(manifestPath, codexOnlyManifest, { spaces: 2 });

    let codexOnlyExtensionStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      codexOnlyExtensionStdout = (error as { stdout?: string }).stdout ?? '';
    }
    expect(codexOnlyExtensionStdout).toContain(
      '[portable-profile-platform-extension] field "user-invocable"',
    );
    expect(codexOnlyExtensionStdout).toContain(
      '[known-field-invalid-type-value] field "allowed-tools"',
    );

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        'description: Validate portable Agent Skills frontmatter.',
        'license: Apache-2.0',
        'compatibility: Requires Node.js 20+.',
        'metadata:',
        '  owner: agent-workflows',
        'allowed-tools: Read Grep Glob',
        '---',
        '',
        '# Frontmatter Test',
      ].join('\n'),
      'utf8',
    );

    const portableResult = await execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(JSON.parse(portableResult.stdout)).toMatchObject({
      ok: true,
      profile: 'agent-skills-portable-core',
      pluginDirectory: pluginDir,
      errors: [],
    });

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        `description: ${JSON.stringify('😀'.repeat(600))}`,
        `compatibility: ${JSON.stringify('🧪'.repeat(300))}`,
        '---',
        '',
        '# Unicode Length Test',
      ].join('\n'),
      'utf8',
    );
    const unicodeResult = await execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(JSON.parse(unicodeResult.stdout)).toMatchObject({
      ok: true,
      errors: [],
    });

    await fs.writeFile(
      skillMdPath,
      [
        '---',
        'name: frontmatter-test',
        `description: ${JSON.stringify('😀'.repeat(1025))}`,
        `compatibility: ${JSON.stringify('🧪'.repeat(501))}`,
        '---',
        '',
        '# Unicode Limit Test',
      ].join('\n'),
      'utf8',
    );
    let unicodeLimitReport: { errors: string[] } | null = null;
    try {
      await execFileAsync(
        'node',
        [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
        {
          cwd: repoRoot(),
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (error) {
      unicodeLimitReport = JSON.parse((error as { stdout?: string }).stdout ?? '{}');
    }
    expect(unicodeLimitReport?.errors.join('\n')).toContain(
      'frontmatter.description must be <= 1024 characters',
    );
    expect(unicodeLimitReport?.errors.join('\n')).toContain(
      'frontmatter.compatibility must be <= 500 characters',
    );

    const lineBoundarySkill = [
      '---',
      'name: frontmatter-test',
      'description: Validate the SKILL.md line-count recommendation.',
      '---',
      '',
      '# Line Count Test',
    ];
    while (lineBoundarySkill.length < 500) {
      lineBoundarySkill.push(`Instruction ${lineBoundarySkill.length}`);
    }
    await fs.writeFile(skillMdPath, `${lineBoundarySkill.join('\n')}\n`, 'utf8');
    const lineBoundaryResult = await execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const lineBoundaryReport = JSON.parse(lineBoundaryResult.stdout);
    expect(lineBoundaryReport.ok).toBe(true);
    expect(lineBoundaryReport.warnings).toContain(
      'skills/frontmatter-test/SKILL.md has 500 lines; Agent Skills recommends keeping SKILL.md under 500 lines',
    );

    await fs.writeFile(
      skillMdPath,
      `${lineBoundarySkill.slice(0, 499).join('\n')}\n`,
      'utf8',
    );
    const underLineBoundaryResult = await execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(
      JSON.parse(underLineBoundaryResult.stdout).warnings.some(
        (warning: string) => warning.includes('skills/frontmatter-test/SKILL.md has'),
      ),
    ).toBe(false);

    const helpResult = await execFileAsync('node', [scriptPath, '--help'], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(helpResult.stdout).toContain('--strict-agent-skills');
    expect(helpResult.stdout).toContain('--claude-skill-profile');
    expect(helpResult.stdout).toContain('--version-base');
    expect(helpResult.stdout).toContain('--json');
  });

  it('validate_plugin.mjs rejects out-of-bounds skills path when CLI is built', async () => {
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
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      interface: { displayName: 'Boundary Test', shortDescription: 'Test' },
    }), { spaces: 2 });

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toBeDefined();
  });

  it('validate_plugin.mjs rejects a stale CLI manifest contract and uses lightweight fallback', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-stale-dist-'));
    tempDirs.push(tempRoot);

    const scriptPath = path.join(
      tempRoot,
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.copy(validatePluginScriptPath(), scriptPath);
    await fs.copy(
      path.join(repoRoot(), '.agents', 'skills', 'create-aw-plugin', 'scripts', 'lib'),
      path.join(path.dirname(scriptPath), 'lib'),
    );
    await fs.copy(
      path.join(
        repoRoot(),
        'packages',
        'cli',
        'src',
        'utils',
        'skill-frontmatter-capabilities.json',
      ),
      path.join(
        tempRoot,
        'packages',
        'cli',
        'src',
        'utils',
        'skill-frontmatter-capabilities.json',
      ),
    );

    const staleManifestModulePath = path.join(
      tempRoot,
      'packages',
      'cli',
      'dist',
      'src',
      'utils',
      'manifest.js',
    );
    await fs.outputFile(
      staleManifestModulePath,
      [
        'exports.validatePluginManifest = () => {};',
        'exports.validateSourcePluginManifest = async (_pluginDir, manifest) => {',
        '  if (!manifest.skillTriggers) throw new Error("stale validator requires skillTriggers");',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const { pluginDir, manifestPath } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'stale-dist-test',
      createBaseManifest('stale-dist-test'),
    );
    const result = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout).toContain('仅执行轻量预检');
    expect(result.stdout).toContain('[PASS] All checks passed.');

    const manifest = await fs.readJson(manifestPath);
    for (const invalidVersion of ['1.2.3-', '1.2.3-+meta']) {
      manifest.version = invalidVersion;
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await expect(
        execFileAsync('node', [scriptPath, pluginDir], {
          cwd: tempRoot,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining(
          'manifest.version must be a strict SemVer 2.0.0 string',
        ),
      });
    }

    manifest.version = '0.1.0';
    manifest.marketplace.policy.authentication = 'NONE';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: tempRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'marketplace.policy.authentication must be "ON_INSTALL" or "ON_USE"',
      ),
    });
  });

  it('validate_plugin.mjs fallback warns that it is lightweight and skips templated native asset shape checks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-fallback-'));
    tempDirs.push(tempRoot);

    const scriptSource = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    const scriptPath = path.join(
      tempRoot,
      '.agents',
      'skills',
      'create-aw-plugin',
      'scripts',
      'validate_plugin.mjs',
    );
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.copy(scriptSource, scriptPath);
    await fs.copy(
      path.join(repoRoot(), '.agents', 'skills', 'create-aw-plugin', 'scripts', 'lib'),
      path.join(path.dirname(scriptPath), 'lib'),
    );

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
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      buildConfig: {
        templates: {
          include: ['.mcp.json', '.app.json'],
        },
      },
    }), { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.mcp.json'), { template: true }, { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.app.json'), { template: true }, { spaces: 2 });
    await ensureFixtureReadmes(pluginDir);

    const result = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout).toContain('仅执行轻量预检');
    expect(result.stdout).toContain('[PASS] All checks passed.');
  });

});
