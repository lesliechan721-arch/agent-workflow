import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { getPluginAuthoringAcceptedValues } from '@lesliechan721/aw-plugin-core/manifest';

import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

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

function withManifestSchema<T extends Record<string, unknown>>(manifest: T): T {
  if (Object.prototype.hasOwnProperty.call(manifest, 'schemaVersion')) {
    return manifest;
  }

  return {
    ...manifest,
    schemaVersion: 2,
  };
}

async function writeManifestOnlyPlugin(
  root: string,
  name: string,
  extensions: Record<string, unknown>,
): Promise<string> {
  const pluginDir = path.join(root, name);
  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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
    'packages',
    'cli',
    'dist',
    'authoring',
    'scripts',
    'validate-plugin.mjs',
  );
}

function authoringScriptPath(scriptName: string): string {
  return path.join(
    repoRoot(),
    'packages',
    'cli',
    'dist',
    'authoring',
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
  await fs.writeJson(manifestPath, withManifestSchema(manifest), { spaces: 2 });

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
    schemaVersion: 2,
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
    ...extra,
  };
}

async function writeAuthoringPluginManifest(
  pluginDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginDir, '.agents-plugin', 'plugin.json'),
    withManifestSchema(manifest),
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
  await fs.writeJson(manifestPath, withManifestSchema({
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
      ? 'interface: {}\n'
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
    const scriptPath = authoringScriptPath('init-plugin.mjs');
    const initHelp = await execFileAsync('node', [scriptPath, '--help'], {
      cwd: repoRoot(),
      env: process.env,
    });
    expect(initHelp.stdout).toContain(
      'During development, keep the current stable target',
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
          '--workspace-root',
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
          '--workspace-root',
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
        '--workspace-root',
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
      schemaVersion: 2,
      name: 'repo-check',
      version: '0.1.0',
      description: '检查仓库状态并输出诊断结论。',
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
    // Static contract exception: the generated production README must not point users to excluded author-only Eval files; behavior test is not suitable because the README text is the published artifact.
    )).resolves.not.toContain('evals/');
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
      'plugins',
      'agent-skill-toolkit',
      'skills',
      'audit-agent-skill-evals',
      'scripts',
      'validate-eval-cases.mjs',
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
    const scriptPath = authoringScriptPath('init-plugin.mjs');

    await expect(execFileAsync('node', [
      scriptPath,
      'missing-skill-description',
      '--description',
      'Plugin-level description must not become a Skill discovery description.',
      '--workspace-root',
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
      '--workspace-root',
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
      '--workspace-root',
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
      '--workspace-root',
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
    const scriptPath = authoringScriptPath('add-skill.mjs');

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
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });

    const dualManifest = await fs.readJson(
      path.join(dualPluginRoot, '.agents-plugin', 'plugin.json'),
    );
    expect(dualManifest.version).toBe('0.1.0');
    expect(dualManifest.skills).toBe('./skills');
    expect(dualManifest.interface.capabilities).toContain('Skills');
    expect(dualAdded.stdout).toContain('Keep the current stable target during development');
    for (const command of [
      'aw plugin validate',
      'aw plugin test',
      'aw plugin build',
      'aw catalog build',
      'aw catalog publish',
    ]) expect(dualAdded.stdout).toContain(command);
    expect(dualAdded.stdout).not.toContain('pnpm release');
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
      '--workspace-root',
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
        '--workspace-root',
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
      '--workspace-root',
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
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('conflicts with slash command'),
    });
    await expect(fs.pathExists(path.join(commandConflictRoot, 'skills', 'repo-report')))
      .resolves.toBe(false);
  });

  const externalPluginRootTest = fs.existsSync(
    path.join(repoRoot(), 'packages', 'cli', 'dist'),
  ) ? it : it.skip;
  externalPluginRootTest('uses the canonical plugin root through the public authoring workflow', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-external-plugin-root-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const pluginRoot = path.join(workspaceRoot, 'plugins', 'demo');
    const cliEntry = path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js');
    await fs.ensureDir(workspaceRoot);
    await execFileAsync('node', [
      cliEntry,
      'catalog',
      'init',
      '--owner-name',
      'Fixture',
      '--owner-url',
      'https://example.invalid/fixture',
      '--display-name',
      'Fixture',
      '--catalog-version',
      '1.0.0',
      '--workspace-root',
      workspaceRoot,
      '--json',
    ], { cwd: workspaceRoot, env: process.env });
    await runGit(workspaceRoot, ['init']);

    await execFileAsync('node', [
      authoringScriptPath('init-plugin.mjs'),
      'demo',
      '--description',
      'Create a plugin in an explicit compatible workspace root.',
      '--skill-description',
      'Create and maintain a deterministic explicit-root plugin workflow.',
      '--skill-short-description',
      'Maintain an explicit-root plugin workflow.',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env });

    await execFileAsync('node', [
      authoringScriptPath('add-skill.mjs'),
      'demo',
      '--skill-name',
      'second-workflow',
      '--skill-description',
      'Add a second deterministic workflow inside the explicit plugin root.',
      '--skill-short-description',
      'Add an explicit-root workflow Skill.',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env });

    for (const skillName of ['demo', 'second-workflow']) {
      const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
      const scaffold = await fs.readFile(skillPath, 'utf8');
      await fs.writeFile(
        skillPath,
        scaffold.replace(/\[TODO:[^\]]+\]/gu, '已完成明确、可验证的作者合同'),
        'utf8',
      );
    }

    await runGit(workspaceRoot, ['add', 'plugins']);
    await runGit(workspaceRoot, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'baseline',
    ]);

    const validation = await execFileAsync('node', [
      path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js'),
      'plugin',
      'validate',
      pluginRoot,
      '--workspace-root',
      workspaceRoot,
      '--json',
    ], { cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(validation.stdout)).toMatchObject({ ok: true, profile: 'aw-source' });
    for (const args of [
      ['plugin', 'test', pluginRoot, '--workspace-root', workspaceRoot, '--json'],
      ['plugin', 'build', pluginRoot, '--workspace-root', workspaceRoot, '--json'],
      ['catalog', 'build', '--workspace-root', workspaceRoot, '--json'],
    ]) {
      const completed = await execFileAsync('node', [cliEntry, ...args], {
        cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024,
      });
      expect(JSON.parse(completed.stdout)).toMatchObject({ ok: true });
    }

    await fs.appendFile(
      path.join(pluginRoot, 'skills', 'second-workflow', 'SKILL.md'),
      '\nChanged production behavior.\n',
      'utf8',
    );
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.version = '0.1.1';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const versionCheck = await execFileAsync('node', [
      authoringScriptPath('plugin-status.mjs'),
      '--base',
      'HEAD',
      'demo',
      '--json',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(versionCheck.stdout).checks[0]).toMatchObject({
      plugin: 'demo',
      status: 'versionBumped',
      baseVersion: '0.1.0',
      currentVersion: '0.1.1',
      productionChanged: true,
    });
  });

  externalPluginRootTest('rejects add-skill path redirection without changing external bytes', async () => {
    const cases = [
      'plugin-root',
      'manifest-directory',
      'manifest',
      'skills',
      'skill-target-symlink',
      'skill-target-file',
      'skill-target-directory',
    ] as const;
    for (const pathCase of cases) {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aw-add-skill-${pathCase}-`));
      tempDirs.push(tempRoot);
      const workspaceRoot = path.join(tempRoot, 'workspace');
      const toolsRoot = path.join(workspaceRoot, 'plugins');
      const victimRoot = path.join(tempRoot, 'victim');
      const victimManifestPath = path.join(victimRoot, 'plugin.json');
      const victimMarkerPath = path.join(victimRoot, 'marker.txt');
      await fs.ensureDir(toolsRoot);
      await fs.ensureDir(victimRoot);
      await fs.writeFile(victimMarkerPath, 'victim-bytes\n', 'utf8');

      let pluginRoot = path.join(toolsRoot, 'demo');
      if (pathCase === 'plugin-root') {
        await writeSourcePlugin(victimRoot, 'demo', createBaseManifest('demo'));
        const externalPluginRoot = path.join(victimRoot, 'demo');
        await fs.symlink(externalPluginRoot, pluginRoot, 'dir');
      } else {
        await writeSourcePlugin(toolsRoot, 'demo', createBaseManifest('demo'));
        if (pathCase === 'manifest-directory') {
          const manifestDirectory = path.join(pluginRoot, '.agents-plugin');
          const externalManifestDirectory = path.join(victimRoot, '.agents-plugin');
          await fs.copy(manifestDirectory, externalManifestDirectory);
          await fs.remove(manifestDirectory);
          await fs.symlink(externalManifestDirectory, manifestDirectory, 'dir');
        } else if (pathCase === 'manifest') {
          const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
          await fs.copyFile(manifestPath, victimManifestPath);
          await fs.remove(manifestPath);
          await fs.symlink(victimManifestPath, manifestPath, 'file');
        } else if (pathCase === 'skills') {
          const externalSkillsRoot = path.join(victimRoot, 'skills');
          await fs.ensureDir(externalSkillsRoot);
          await fs.symlink(externalSkillsRoot, path.join(pluginRoot, 'skills'), 'dir');
        } else if (pathCase === 'skill-target-symlink') {
          const targetRoot = path.join(pluginRoot, 'skills', 'redirected-skill');
          await fs.ensureDir(path.dirname(targetRoot));
          await fs.symlink(victimRoot, targetRoot, 'dir');
        } else if (pathCase === 'skill-target-file') {
          await fs.outputFile(
            path.join(pluginRoot, 'skills', 'redirected-skill'),
            'existing target\n',
          );
        } else {
          await fs.ensureDir(path.join(pluginRoot, 'skills', 'redirected-skill'));
        }
      }

      const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
      const manifestBefore = await fs.readFile(manifestPath);
      const victimBefore = await fs.readFile(victimMarkerPath);
      const expectedDiagnostic = {
        'plugin-root': 'must not contain symbolic links',
        'manifest-directory': 'must be a non-symbolic-link directory',
        manifest: 'must be a regular non-symbolic-link file',
        skills: 'must be a non-symbolic-link directory',
        'skill-target-symlink': 'Skill already exists',
        'skill-target-file': 'Skill already exists',
        'skill-target-directory': 'Skill already exists',
      }[pathCase];
      await expect(execFileAsync('node', [
        authoringScriptPath('add-skill.mjs'),
        'demo',
        '--skill-name',
        'redirected-skill',
        '--skill-description',
        'Reject redirected authoring paths without changing external victim bytes.',
        '--skill-short-description',
        'Reject redirected authoring paths safely.',
        '--workspace-root',
        workspaceRoot,
      ], { cwd: workspaceRoot, env: process.env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(expectedDiagnostic),
      });

      await expect(fs.readFile(manifestPath)).resolves.toEqual(manifestBefore);
      await expect(fs.readFile(victimMarkerPath)).resolves.toEqual(victimBefore);
      const pluginEntries = await fs.readdir(pluginRoot).catch(() => []);
      expect(pluginEntries.some((entry) => entry.startsWith('.aw-add-skill-'))).toBe(false);
      const manifestEntries = await fs.readdir(path.join(pluginRoot, '.agents-plugin')).catch(() => []);
      expect(manifestEntries.some((entry) => entry.includes('.aw-tmp-'))).toBe(false);
    }
  });

  externalPluginRootTest('rejects the removed plugin-root option', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-root-escape-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    await fs.ensureDir(workspaceRoot);
    await expect(execFileAsync('node', [
      authoringScriptPath('init-plugin.mjs'),
      'demo',
      '--description',
      'Reject an escaped plugin root.',
      '--no-skills',
      '--workspace-root',
      workspaceRoot,
      '--plugin-root',
      '../demo',
      '--json',
    ], { cwd: workspaceRoot, env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown option: --plugin-root'),
    });
    await expect(fs.pathExists(path.join(tempRoot, 'demo'))).resolves.toBe(false);
  });

  externalPluginRootTest('rejects redirected plugin roots and manifests before authoring reads', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-root-fence-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const victimRoot = path.join(tempRoot, 'victim');
    const checkerPath = authoringScriptPath('plugin-status.mjs');
    const defaultPluginRoot = path.join(workspaceRoot, 'plugins', 'default-demo');
    const explicitPluginRoot = path.join(workspaceRoot, 'tools', 'explicit-demo');
    const victimDefaultRoot = path.join(victimRoot, 'default-demo');
    const victimManifestPath = path.join(victimRoot, 'explicit-plugin.json');

    await writeSourcePlugin(
      path.join(workspaceRoot, 'plugins'),
      'default-demo',
      createBaseManifest('default-demo'),
    );
    await writeSourcePlugin(
      path.join(workspaceRoot, 'tools'),
      'explicit-demo',
      createBaseManifest('explicit-demo'),
    );
    await runGit(workspaceRoot, ['init']);
    await runGit(workspaceRoot, ['add', 'plugins', 'tools']);
    await runGit(workspaceRoot, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'authoring fence baseline',
    ]);

    await writeSourcePlugin(victimRoot, 'default-demo', createBaseManifest('default-demo'));
    await fs.copyFile(
      path.join(explicitPluginRoot, '.agents-plugin', 'plugin.json'),
      victimManifestPath,
    );
    await fs.remove(defaultPluginRoot);
    await fs.symlink(victimDefaultRoot, defaultPluginRoot, 'dir');
    const explicitManifestPath = path.join(explicitPluginRoot, '.agents-plugin', 'plugin.json');
    await fs.remove(explicitManifestPath);
    await fs.symlink(victimManifestPath, explicitManifestPath, 'file');

    const defaultCheck = execFileAsync('node', [
      checkerPath,
      'default-demo',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env });
    await expect(defaultCheck).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(defaultPluginRoot),
    });
    await expect(defaultCheck).rejects.not.toMatchObject({
      stderr: expect.stringContaining(victimDefaultRoot),
    });

    const explicitCheck = execFileAsync('node', [
      checkerPath,
      'explicit-demo',
      '--workspace-root',
      workspaceRoot,
      '--plugin-root',
      'tools/explicit-demo',
    ], { cwd: workspaceRoot, env: process.env });
    await expect(explicitCheck).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown option: --plugin-root'),
    });
    await expect(explicitCheck).rejects.not.toMatchObject({
      stderr: expect.stringContaining(victimManifestPath),
    });

    const validation = execFileAsync('node', [
      validatePluginScriptPath(),
      defaultPluginRoot,
      '--json',
    ], { cwd: workspaceRoot, env: process.env });
    await expect(validation).rejects.toMatchObject({ code: 1 });
    try {
      await validation;
    } catch (validationError) {
      const result = JSON.parse((validationError as { stdout: string }).stdout);
      expect(result).toMatchObject({
        ok: false,
        errors: [expect.stringContaining(defaultPluginRoot)],
      });
      expect(JSON.stringify(result)).not.toContain(victimDefaultRoot);
    }

    const allCheck = execFileAsync('node', [
      checkerPath,
      '--all',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env });
    await expect(allCheck).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(defaultPluginRoot),
    });
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

    const checkerPath = authoringScriptPath('plugin-status.mjs');
    const skillMdPath = path.join(pluginDir, 'skills', 'versioned-skill', 'SKILL.md');
    await expect(execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'versioned-plugin',
      '--mode',
      'author',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown option: --mode'),
    });
    await fs.appendFile(skillMdPath, '\nChanged production behavior.\n', 'utf8');

    const developmentStatus = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'versioned-plugin',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    const developmentReport = JSON.parse(developmentStatus.stdout);
    expect(developmentReport.ok).toBe(true);
    expect(developmentReport).toMatchObject({
      schemaVersion: 3,
      policy: 'development',
      base: {
        requested: 'HEAD',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      },
    });
    expect(developmentReport).not.toHaveProperty('mode');
    expect(developmentReport.checks[0]).toMatchObject({
      status: 'unreleasedChanges',
      productionChanged: true,
      currentTarget: '0.1.0',
      warnings: [expect.stringContaining('release target may need adjustment')],
    });
    expect(developmentReport.checks[0]).not.toHaveProperty('plannedBump');
    expect(developmentReport.checks[0]).not.toHaveProperty('targetVersion');
    expect(developmentReport.checks[0]).not.toHaveProperty('releaseIntentFiles');
    expect(developmentReport.checks[0].changedPaths).toContain(
      'codex/skills/versioned-skill/SKILL.md',
    );

    const changedManifest = await fs.readJson(manifestPath);
    changedManifest.version = '0.2.0';
    await fs.writeJson(manifestPath, changedManifest, { spaces: 2 });
    const bumped = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'versioned-plugin',
      '--json',
      '--workspace-root',
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
      '--base',
      'HEAD',
      'versioned-plugin',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(authorOnly.stdout).checks[0]).toMatchObject({
      status: 'unchanged',
      productionChanged: false,
    });

    const skillReadmePath = path.join(pluginDir, 'skills', 'versioned-skill', 'README.md');
    await fs.appendFile(skillReadmePath, '\nPublished documentation change.\n', 'utf8');
    const readmeChange = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'versioned-plugin',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    expect(readmeChange.stdout).toContain('unreleasedChanges');

    await fs.writeFile(skillReadmePath, '# Versioned Skill\n', 'utf8');
    for (const invalidVersion of ['0.2.1-beta.1', '0.2.0+metadata']) {
      const invalidManifest = await fs.readJson(manifestPath);
      invalidManifest.version = invalidVersion;
      await fs.writeJson(manifestPath, invalidManifest, { spaces: 2 });
      await expect(execFileAsync('node', [
        checkerPath,
        '--base',
        'HEAD',
        'versioned-plugin',
        '--workspace-root',
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
      '--base',
      'HEAD',
      'versioned-plugin',
      '--json',
      '--workspace-root',
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
      '--base',
      'HEAD',
      'new-plugin',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    const newPluginReport = JSON.parse(newPlugin.stdout);
    expect(newPluginReport.schemaVersion).toBe(3);
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
      '--base',
      'HEAD',
      '--all',
      '--',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    expect(JSON.parse(allChanged.stdout).checks.map((check: { plugin: string }) => check.plugin))
      .toEqual(['new-plugin', 'versioned-plugin']);

    await fs.remove(path.join(tempRepo, 'packages', 'cli', 'dist'));
    const publishedRuntimeResult = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      '--all',
      '--',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    expect(JSON.parse(publishedRuntimeResult.stdout)).toMatchObject({
      schemaVersion: 3,
      ok: true,
    });

    await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'deleted-plugin',
      createBaseManifest('deleted-plugin'),
    );
    await runGit(tempRepo, ['add', 'plugins/deleted-plugin']);
    await runGit(tempRepo, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'add plugin for deletion check',
    ]);
    await fs.remove(path.join(tempRepo, 'plugins', 'deleted-plugin'));
    const deletedPluginResult = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      '--all',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env });
    expect(JSON.parse(deletedPluginResult.stdout).checks).toContainEqual(
      expect.objectContaining({
        plugin: 'deleted-plugin',
        status: 'deleted',
      }),
    );
  });

  productionVersionCheckTest('resolves version-check runtime imports from isolated base and current source sets', async () => {
    const distRoot = path.join(repoRoot(), 'packages', 'cli', 'dist');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-version-imports-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    const checkerTempRoot = path.join(tempRoot, 'checker-tmp');
    await fs.ensureDir(tempRepo);
    await fs.ensureDir(checkerTempRoot);
    await fs.ensureSymlink(distRoot, path.join(tempRepo, 'packages', 'cli', 'dist'), 'dir');

    const providerBytes = `${'base-provider-bytes-'.repeat(512 * 1024)}\n`;
    const { pluginDir: providerRoot } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'runtime-provider',
      createBaseManifest('runtime-provider', {
        buildConfig: {
          runtimeExports: [{ name: 'standard', source: './standard.txt' }],
        },
      }),
      { 'standard.txt': providerBytes },
    );
    const { manifestPath: consumerManifestPath } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'runtime-consumer',
      createBaseManifest('runtime-consumer', {
        skills: './skills',
        buildConfig: {
          skillRuntimeFiles: [{
            skill: 'consumer-skill',
            target: 'references/standard.txt',
            import: { plugin: 'runtime-provider', export: 'standard' },
          }],
        },
      }),
      {
        'skills/consumer-skill/SKILL.md': [
          '---',
          'name: consumer-skill',
          'description: Validate isolated catalog runtime imports.',
          '---',
          '',
          '# Consumer Skill',
        ].join('\n'),
        'skills/consumer-skill/agents/openai.yaml': [
          'interface:',
          '  display_name: "Consumer Skill"',
          '  short_description: "Validate isolated runtime imports"',
          'policy:',
          '  allow_implicit_invocation: true',
        ].join('\n'),
      },
    );
    await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'runtime-build-consumer',
      createBaseManifest('runtime-build-consumer', {
        skills: './skills',
        buildConfig: {
          buildImports: [{
            plugin: 'runtime-provider',
            export: 'standard',
            env: 'AW_PLUGIN_IMPORT_STANDARD',
          }],
          skillRuntimeFiles: [{
            skill: 'build-consumer-skill',
            target: 'references/standard.txt',
            source: './generated-standard.txt',
          }],
        },
        scripts: {
          node: {
            build: { runner: 'node', path: './build.mjs' },
          },
        },
      }),
      {
        'build.mjs': [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "import { fileURLToPath } from 'node:url';",
          '',
          "const pluginRoot = path.dirname(fileURLToPath(import.meta.url));",
          "fs.copyFileSync(process.env.AW_PLUGIN_IMPORT_STANDARD, path.join(pluginRoot, 'generated-standard.txt'));",
        ].join('\n'),
        'skills/build-consumer-skill/SKILL.md': [
          '---',
          'name: build-consumer-skill',
          'description: Validate a plugin runtime export build import.',
          '---',
          '',
          '# Build Consumer Skill',
        ].join('\n'),
        'skills/build-consumer-skill/agents/openai.yaml': [
          'interface:',
          '  display_name: "Build Consumer Skill"',
          '  short_description: "Validate a runtime export build import"',
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
      'runtime import baseline',
    ]);

    await fs.writeFile(
      path.join(providerRoot, 'standard.txt'),
      `${'current-provider-bytes-'.repeat(512 * 1024)}\n`,
      'utf8',
    );
    const checkerPath = authoringScriptPath('plugin-status.mjs');
    const allConsumers = await execFileAsync('node', [
        checkerPath,
        '--base',
        'HEAD',
        '--all',
        '--json',
        '--workspace-root',
        tempRepo,
      ], {
        cwd: repoRoot(),
        env: { ...process.env, TMPDIR: checkerTempRoot },
        maxBuffer: 20 * 1024 * 1024,
      });
    const allConsumerChecks = JSON.parse(allConsumers.stdout).checks;
    expect(allConsumerChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'runtime-build-consumer',
        status: 'unreleasedChanges',
        productionChanged: true,
      }),
      expect.objectContaining({
        plugin: 'runtime-consumer',
        status: 'unreleasedChanges',
        productionChanged: true,
      }),
    ]));

    const consumerManifest = await fs.readJson(consumerManifestPath);
    consumerManifest.version = '0.2.0';
    await fs.writeJson(consumerManifestPath, consumerManifest, { spaces: 2 });

    const isolated = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'runtime-consumer',
      '--json',
      '--workspace-root',
      tempRepo,
    ], {
      cwd: repoRoot(),
      env: { ...process.env, TMPDIR: checkerTempRoot },
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(JSON.parse(isolated.stdout).checks[0]).toMatchObject({
      status: 'versionBumped',
      productionChanged: true,
      changedPaths: expect.arrayContaining([
        'codex/skills/consumer-skill/references/standard.txt',
        'claude/skills/consumer-skill/references/standard.txt',
      ]),
    });

    await fs.remove(providerRoot);
    let missingProviderError: { stdout?: string; stderr?: string } | undefined;
    try {
      await execFileAsync('node', [
        checkerPath,
        '--base',
        'HEAD',
        'runtime-consumer',
        '--json',
        '--workspace-root',
        tempRepo,
      ], {
        cwd: repoRoot(),
        env: { ...process.env, TMPDIR: checkerTempRoot },
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      missingProviderError = error as { stdout?: string; stderr?: string };
    }
    const missingProviderReport = JSON.parse(missingProviderError!.stdout!);
    expect(missingProviderReport.checks[0]).toMatchObject({
      status: 'error',
      errors: [expect.stringContaining('provider plugin "runtime-provider" is unavailable')],
    });
    expect(`${missingProviderError?.stdout ?? ''}${missingProviderError?.stderr ?? ''}`)
      .not.toContain('ENOTEMPTY');
    await expect(fs.readdir(checkerTempRoot)).resolves.toEqual([]);

    consumerManifest.buildConfig.skillRuntimeFiles[0].import.plugin = 'base-missing-provider';
    await fs.writeJson(consumerManifestPath, consumerManifest, { spaces: 2 });
    await runGit(tempRepo, ['add', 'plugins']);
    await runGit(tempRepo, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'missing base provider',
    ]);
    consumerManifest.buildConfig.skillRuntimeFiles[0].import.plugin = 'current-missing-provider';
    await fs.writeJson(consumerManifestPath, consumerManifest, { spaces: 2 });

    let twoSidedError: { stdout?: string } | undefined;
    try {
      await execFileAsync('node', [
        checkerPath,
        '--base',
        'HEAD',
        'runtime-consumer',
        '--json',
        '--workspace-root',
        tempRepo,
      ], {
        cwd: repoRoot(),
        env: { ...process.env, TMPDIR: checkerTempRoot },
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      twoSidedError = error as { stdout?: string };
    }
    expect(JSON.parse(twoSidedError!.stdout!).checks[0].errors).toEqual([
      expect.stringContaining('base: Invalid catalog runtime import: provider plugin "base-missing-provider" is unavailable'),
      expect.stringContaining('Secondary bundle failure: current: Invalid catalog runtime import: provider plugin "current-missing-provider" is unavailable'),
    ]);
    await expect(fs.readdir(checkerTempRoot)).resolves.toEqual([]);
  });

  productionVersionCheckTest('validates new plugin runtime imports before reporting new', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-new-import-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    await fs.ensureDir(tempRepo);
    await fs.ensureSymlink(
      path.join(repoRoot(), 'packages', 'cli', 'dist'),
      path.join(tempRepo, 'packages', 'cli', 'dist'),
      'dir',
    );
    const { pluginDir } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'new-import-consumer',
      createBaseManifest('new-import-consumer', {
        skills: './skills',
        buildConfig: {
          skillRuntimeFiles: [{
            skill: 'consumer-skill',
            target: 'references/provider.txt',
            import: { plugin: 'missing-provider', export: 'provider-file' },
          }],
        },
      }),
      {
        'skills/consumer-skill/SKILL.md': [
          '---',
          'name: consumer-skill',
          'description: Validate a new plugin runtime import.',
          '---',
          '',
          '# Consumer Skill',
        ].join('\n'),
        'skills/consumer-skill/agents/openai.yaml': [
          'interface:',
          '  display_name: "Consumer Skill"',
          '  short_description: "Validate a new runtime import"',
          'policy:',
          '  allow_implicit_invocation: true',
        ].join('\n'),
      },
    );
    await runGit(tempRepo, ['init']);
    await runGit(tempRepo, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'empty baseline',
    ]);

    const checker = execFileAsync('node', [
      authoringScriptPath('plugin-status.mjs'),
      '--base',
      'HEAD',
      'new-import-consumer',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    await expect(checker).rejects.toMatchObject({ code: 1 });
    try {
      await checker;
    } catch (error) {
      const output = error as { stdout: string; stderr: string };
      if (!output.stdout) throw new Error(output.stderr);
      expect(JSON.parse(output.stdout).checks[0]).toMatchObject({
        status: 'error',
        errors: [expect.stringContaining('provider plugin "missing-provider" is unavailable')],
      });
    }

    const validation = execFileAsync('node', [
      validatePluginScriptPath(),
      pluginDir,
      '--json',
    ], { cwd: tempRepo, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    await expect(validation).rejects.toMatchObject({ code: 1 });
    try {
      await validation;
    } catch (error) {
      const errors = JSON.parse((error as { stdout: string }).stdout).errors as string[];
      expect(errors).toEqual([
        expect.stringContaining(
          'Cannot resolve buildConfig.skillRuntimeFiles[0].import from provider "missing-provider" export "provider-file"',
        ),
      ]);
      expect(errors.join('\n')).not.toContain(tempRoot);
    }
  });

  productionVersionCheckTest('uses historical closure mode only for the Git base bundle', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-historical-closure-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    await fs.ensureDir(tempRepo);
    await fs.ensureSymlink(
      path.join(repoRoot(), 'packages', 'cli', 'dist'),
      path.join(tempRepo, 'packages', 'cli', 'dist'),
      'dir',
    );
    const { pluginDir, manifestPath } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'),
      'historical-closure',
      createBaseManifest('historical-closure', { skills: './skills' }),
      {
        'skills/historical/SKILL.md': [
          '---',
          'name: historical',
          'description: Validate a historical plugin closure.',
          '---',
          '',
          '[policy](POLICY.md)',
        ].join('\n'),
        'skills/historical/agents/openai.yaml': [
          'interface:',
          '  display_name: "Historical Closure"',
          '  short_description: "Validate a historical closure"',
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
      'historical invalid closure',
    ]);

    const policyPath = path.join(pluginDir, 'skills', 'historical', 'POLICY.md');
    await fs.writeFile(policyPath, 'current policy\n', 'utf8');
    const checkerPath = authoringScriptPath('plugin-status.mjs');

    const developmentStatus = await execFileAsync('node', [
        checkerPath,
        '--base',
        'HEAD',
        'historical-closure',
        '--json',
        '--workspace-root',
        tempRepo,
      ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(developmentStatus.stdout).checks[0]).toMatchObject({
      status: 'unreleasedChanges',
      productionChanged: true,
    });

    const manifest = await fs.readJson(manifestPath);
    manifest.version = '0.0.9';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const downgrade = execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'historical-closure',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    await expect(downgrade).rejects.toMatchObject({ code: 1 });
    try {
      await downgrade;
    } catch (error) {
      expect(JSON.parse((error as { stdout: string }).stdout).checks[0].status)
        .toBe('versionDowngrade');
    }

    manifest.version = '0.2.0';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const bumped = await execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'historical-closure',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(bumped.stdout).checks[0]).toMatchObject({
      status: 'versionBumped',
      productionChanged: true,
    });

    await fs.remove(policyPath);
    const invalidCurrent = execFileAsync('node', [
      checkerPath,
      '--base',
      'HEAD',
      'historical-closure',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
    await expect(invalidCurrent).rejects.toMatchObject({ code: 1 });
    try {
      await invalidCurrent;
    } catch (error) {
      expect(JSON.parse((error as { stdout: string }).stdout).checks[0]).toMatchObject({
        status: 'error',
        errors: [expect.stringContaining('current: Invalid runtime Skill closure')],
      });
    }
  });

  productionVersionCheckTest('uses one verified external CLI provider when neither tree owns CLI source', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-external-cli-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const checkerTempRoot = path.join(tempRoot, 'checker-tmp');
    await fs.ensureDir(checkerTempRoot);
    await writeSourcePlugin(
      path.join(workspaceRoot, 'plugins'),
      'external-cli-demo',
      createBaseManifest('external-cli-demo'),
    );
    await runGit(workspaceRoot, ['init']);
    await runGit(workspaceRoot, ['add', 'plugins']);
    await runGit(workspaceRoot, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'external CLI provider baseline',
    ]);

    const result = await execFileAsync('node', [
      authoringScriptPath('plugin-status.mjs'),
      '--base',
      'HEAD',
      'external-cli-demo',
      '--json',
      '--workspace-root',
      workspaceRoot,
    ], {
      cwd: workspaceRoot,
      env: { ...process.env, TMPDIR: checkerTempRoot },
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(JSON.parse(result.stdout).checks[0]).toMatchObject({
      status: 'unchanged',
      productionChanged: false,
      baseDigest: expect.stringMatching(/^sha256:/u),
      currentDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(JSON.parse(result.stdout).checks[0].baseDigest)
      .toBe(JSON.parse(result.stdout).checks[0].currentDigest);
    await expect(fs.readdir(checkerTempRoot)).resolves.toEqual([]);
  });

  it('scaffolds an explicit manifest v2 without a version compatibility field', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-version-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const scriptPath = authoringScriptPath('init-plugin.mjs');

    await execFileAsync(
      'node',
      [
        scriptPath,
        'catalog-aware',
        '--description',
        '用于验证 Manifest v2 的示例插件。',
        '--no-skills',
        '--workspace-root',
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
      schemaVersion: 2,
    });
    await expect(fs.readJson(
      path.join(tempRepo, 'plugins', 'catalog-aware', '.agents-plugin', 'plugin.json'),
    )).resolves.not.toHaveProperty('compatibility');
  });

  it('validate_plugin.mjs rejects v1 and reports unsupported declared capabilities', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-version-contracts-'));
    tempDirs.push(tempRoot);
    const pluginsRoot = path.join(tempRoot, 'plugins');

    const oldSchemaDir = path.join(pluginsRoot, 'old-schema');
    await writeAuthoringPluginManifest(
      oldSchemaDir,
      {
        schemaVersion: 1,
        name: 'old-schema',
        version: '0.1.0',
        description: 'Old schema contract.',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      },
    );
    await expect(runValidatePlugin(oldSchemaDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('Unsupported plugin manifest schemaVersion: expected 2'),
    });

    const futureCapabilityDir = path.join(pluginsRoot, 'future-capability');
    await writeAuthoringPluginManifest(futureCapabilityDir, {
      ...createBaseManifest('future-capability'),
      requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
    });
    await expect(runValidatePlugin(futureCapabilityDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('awCapabilityUnsupported'),
    });

    const invalidPluginVersionDir = path.join(pluginsRoot, 'invalid-plugin-version');
    await writeAuthoringPluginManifest(invalidPluginVersionDir, {
      ...createBaseManifest('invalid-plugin-version'),
      version: 'v0.1.0',
    });
    await expect(runValidatePlugin(invalidPluginVersionDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('/version must match pattern'),
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
        '/marketplace/policy/authentication must be equal to one of the allowed values',
      ),
    });

  });

  it('supports explicit skill UI metadata without changing the trigger description', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-skill-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const scriptPath = authoringScriptPath('init-plugin.mjs');

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
        '--workspace-root',
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
      'packages',
      'cli',
      'dist',
      'authoring',
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
      'packages',
      'cli',
      'dist',
      'authoring',
      'assets',
      'aw-config.mjs',
    );
    const contextPath = path.join(tempRoot, 'context.json');
    const sourceIdentity = `sha256:${'1'.repeat(64)}`;
    const userStorePath = path.join(tempRoot, 'user-config.json');
    const projectStorePath = path.join(tempRoot, 'project-config.json');
    await fs.writeJson(userStorePath, {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'context-helper',
      values: {
        apiKey: 'user-store-secret',
        mode: 'standard',
        ignored: true,
      },
    });
    await fs.writeJson(projectStorePath, {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'context-helper',
      values: { mode: 'strict' },
    });
    await fs.writeJson(contextPath, {
      plugin: { name: 'context-helper', sourceId: 'team', sourceIdentity },
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
      sourceId: 'team',
      sourceIdentity,
      pluginId: 'team/context-helper',
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

    const awHome = path.join(tempRoot, 'aw-home');
    const sourceId = 'team';
    const sourceIdentity = `sha256:${'2'.repeat(64)}`;
    const marketplaceRoot = path.join(awHome, 'marketplaces', sourceId);
    const bundleRoot = path.join(marketplaceRoot, 'plugins', 'config-demo');
    await fs.ensureDir(path.join(bundleRoot, '.agents-plugin'));
    await fs.ensureDir(path.join(bundleRoot, 'scripts'));
    await fs.copyFile(
      path.join(
        repoRoot(),
        'packages',
        'cli',
        'dist',
        'authoring',
        'assets',
        'aw-config.mjs',
      ),
      path.join(bundleRoot, 'scripts', 'aw-config.mjs'),
    );
    await fs.writeJson(path.join(bundleRoot, '.agents-plugin', 'plugin.json'), withManifestSchema({
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
    await fs.writeJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId,
      sourceIdentity,
      marketplaceName: `aw-${sourceId}`,
    });
    await fs.ensureDir(projectSubdir);
    await fs.writeFile(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'config.txt'), 'ok\n', 'utf8');
    await fs.ensureDir(path.join(awHome, 'plugin-config', sourceId, 'config-demo'));
    await fs.writeJson(
      path.join(awHome, 'plugin-config', sourceId, 'config-demo', 'config.json'),
      {
        schemaVersion: 2,
        sourceId,
        sourceIdentity,
        pluginName: 'config-demo',
        values: {
          token: 'user-secret',
          staleUserSecret: 'do-not-print-user',
        },
      },
      { spaces: 2 },
    );
    await fs.ensureDir(
      path.join(projectRoot, '.agent-workflows', 'plugin-config', sourceId, 'config-demo'),
    );
    await fs.writeJson(
      path.join(projectRoot, '.agent-workflows', 'plugin-config', sourceId, 'config-demo', 'config.json'),
      {
        schemaVersion: 2,
        sourceId,
        sourceIdentity,
        pluginName: 'config-demo',
        values: {
          token: 'project-secret',
          mode: 'strict',
          staleProjectSecret: 'do-not-print-project',
        },
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
    expect(payload).toMatchObject({
      pluginName: 'config-demo',
      sourceId,
      sourceIdentity,
      pluginId: `${sourceId}/config-demo`,
    });
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

    await fs.writeJson(
      path.join(projectRoot, '.agent-workflows', 'plugin-config', sourceId, 'config-demo', 'config.json'),
      {
        schemaVersion: 2,
        sourceId,
        sourceIdentity: `sha256:${'3'.repeat(64)}`,
        pluginName: 'config-demo',
        values: { token: 'wrong-source-secret' },
      },
      { spaces: 2 },
    );
    await expect(execFileAsync(
      'node',
      [path.join(bundleRoot, 'scripts', 'aw-config.mjs'), 'json'],
      {
        cwd: projectSubdir,
        env: { ...process.env, AW_HOME: awHome, AW_PLUGIN_CONTEXT: '' },
      },
    )).rejects.toMatchObject({
      stderr: expect.stringContaining('schema 2 source identity'),
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
        'packages',
        'cli',
        'dist',
        'authoring',
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

    const initScriptPath = authoringScriptPath('init-plugin.mjs');
    const validateScriptPath = validatePluginScriptPath();

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
        '--workspace-root',
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

    const initScriptPath = authoringScriptPath('init-plugin.mjs');
    const validateScriptPath = validatePluginScriptPath();

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
        '--workspace-root',
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
      withManifestSchema({
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
        stdout: expect.stringContaining('Invalid plugin input tree: symbolic links are not supported'),
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

    const scriptPath = validatePluginScriptPath();
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

  it('the shipped author validator enforces config presentation contracts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-presentation-authoring-'));
    tempDirs.push(tempRoot);
    const pluginDir = await writeManifestOnlyPlugin(tempRoot, 'presentation-contract', {});
    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    const schema = {
      mode: {
        type: 'enum',
        values: ['safe', 'fast'],
      },
      limit: {
        type: 'number',
        min: 1,
        max: 20,
      },
      trace: {
        type: 'boolean',
      },
      token: {
        type: 'string',
        sensitive: true,
      },
      rules: {
        type: 'file',
      },
      workspace: {
        type: 'directory',
      },
    };
    const scriptPath = path.join(
      repoRoot(),
      'packages',
      'cli',
      'authoring',
      'scripts',
      'validate-plugin.mjs',
    );

    await fs.writeJson(manifestPath, {
      ...manifest,
      config: { schema },
    }, { spaces: 2 });
    await expect(execFileAsync(process.execPath, [scriptPath, pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    for (const [key, value] of [
      ['token', 'private'],
      ['rules', '/private/rules'],
      ['workspace', '/private/workspace'],
    ] as const) {
      await fs.writeJson(manifestPath, {
        ...manifest,
        config: {
          schema,
          presentation: {
            presets: [{ id: 'private', title: 'Private', values: { [key]: value } }],
          },
        },
      }, { spaces: 2 });
      await expect(execFileAsync(process.execPath, [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      })).rejects.toMatchObject({
        stdout: expect.stringContaining('cannot contain sensitive, file, or directory config values'),
      });
    }

    await fs.writeJson(manifestPath, {
      ...manifest,
      config: {
        schema,
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode', 'limit'] },
          ],
          fields: {
            mode: {
              valueLabels: { safe: 'Safe', fast: 'Fast' },
              recommendedValue: 'safe',
            },
            limit: {
              recommendedValue: 10,
              unit: 'minutes',
              advanced: true,
            },
          },
          presets: [
            { id: 'fast', title: 'Fast', values: { mode: 'fast' } },
          ],
        },
      },
    }, { spaces: 2 });
    await expect(execFileAsync(process.execPath, [scriptPath, pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      config: {
        schema,
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode', 'missing'] },
            { id: 'general', title: 'Duplicate', fields: ['mode'] },
          ],
          fields: {
            missing: { advanced: true },
            mode: {
              valueLabels: { balanced: 'Balanced' },
              recommendedValue: 'balanced',
            },
            limit: { recommendedValue: 21 },
          },
          presets: [
            { id: 'bad', title: 'Bad', values: { trace: 'yes', missing: true } },
            { id: 'bad', title: 'Duplicate', values: {} },
          ],
        },
      },
    }, { spaces: 2 });
    let invalidStdout = '';
    try {
      await execFileAsync(process.execPath, [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (caught) {
      invalidStdout = (caught as { stdout?: string }).stdout ?? '';
    }
    expect(invalidStdout).toContain('references unknown config key "missing"');
    expect(invalidStdout).toContain('duplicate group id "general"');
    expect(invalidStdout).toContain('unknown enum token "balanced"');
    expect(invalidStdout).toContain('recommendedValue must be less than or equal to 20');
    expect(invalidStdout).toContain('values.trace must be a boolean');
    expect(invalidStdout).toContain('duplicate preset id "bad"');
  });

  it('validate_plugin.mjs scans real Node imports without comment, string, regex, or template-text ghosts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-import-scan-'));
    tempDirs.push(tempRoot);
    const { pluginDir } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'import-scan-test',
      createBaseManifest('import-scan-test', {
        scripts: {
          lifecycle: {
            install: './scripts/entry.mjs',
          },
        },
      }),
      {
        'scripts/entry.mjs': [
          'import /* side effect */ "./shared.mjs";',
          'export { value } /* binding */ from /* source */ "./value.mjs";',
          'const lazy = import(/* boundary */ "./lazy.mjs");',
          'const helper = require(/* boundary */ "./helper.cjs");',
          'const resolved = require.resolve(/* boundary */ "./resolved.cjs");',
          'const stringGhost = \'require("ghost-string")\';',
          '// import "ghost-comment";',
          '/* export { ghost } from "ghost-block-comment"; */',
          'const regexGhost = /require("ghost-regex")|import("ghost-dynamic-regex")/u;',
          'const templateGhost = `require("ghost-template")`;',
          'const expression = `${import("./template-expression.mjs")}`;',
        ].join('\n'),
        'scripts/shared.mjs': 'export const shared = true;\n',
        'scripts/value.mjs': 'export const value = true;\n',
        'scripts/lazy.mjs': 'export default true;\n',
        'scripts/helper.cjs': 'module.exports = true;\n',
        'scripts/resolved.cjs': 'module.exports = true;\n',
        'scripts/template-expression.mjs': 'export default true;\n',
      },
    );
    await expect(execFileAsync(process.execPath, [validatePluginScriptPath(), pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });

    await fs.appendFile(path.join(pluginDir, 'scripts', 'entry.mjs'), '\nimport "undeclared-package";\n');
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'bare import "undeclared-package" from "scripts/entry.mjs" requires scripts.node.packageRoot',
      ),
    });

    await fs.writeFile(
      path.join(pluginDir, 'scripts', 'entry.mjs'),
      'require.resolve("../../outside.cjs");\n',
      'utf8',
    );
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'relative import "../../outside.cjs" from "scripts/entry.mjs" escapes the plugin root',
      ),
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

  it('keeps author validation aligned with Catalog build across native and portable runtime surfaces', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-runtime-surfaces-'));
    tempDirs.push(tempRoot);
    await execFileAsync('git', ['init'], { cwd: tempRoot });
    const providerBytes = 'author-surface-private-bytes\n';
    const { pluginDir: providerDir } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'surface-provider',
      createBaseManifest('surface-provider', {
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
        },
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
        buildConfig: { runtimeExports: [{ name: 'shared', source: './shared.txt' }] },
      }),
      { 'shared.txt': providerBytes },
    );
    const invalidManifest = createBaseManifest('surface-consumer', {
      schemaVersion: 2,
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      skills: './skills',
      distributions: { agentSkills: { skills: './portable-skills' } },
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/shared.txt',
          import: { plugin: 'surface-provider', export: 'shared' },
        }],
      },
    });
    const { pluginDir: consumerDir, manifestPath } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'surface-consumer',
      invalidManifest,
      {
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: Native demo.\n---\n',
        'skills/demo/agents/openai.yaml': [
          'interface:',
          '  display_name: Demo',
          'policy:',
          '  allow_implicit_invocation: true',
        ].join('\n'),
        'portable-skills/demo/SKILL.md': '---\nname: demo\ndescription: Portable demo.\n---\n',
        'portable-skills/demo/README.md': '# Portable demo\n',
      },
    );
    await execFileAsync('git', ['add', '.'], { cwd: tempRoot });
    await execFileAsync(
      'git',
      ['-c', 'user.name=AW Test', '-c', 'user.email=aw-test@example.invalid', 'commit', '-m', 'fixture'],
      { cwd: tempRoot },
    );

    const invalidValidation = await runValidatePlugin(consumerDir).catch(
      (failure: unknown) => failure as { stdout: string; stderr: string },
    );
    expect(invalidValidation.stdout).toContain('Cannot resolve buildConfig.skillRuntimeFiles[0].import');
    expect(`${invalidValidation.stdout}${invalidValidation.stderr}`).not.toContain(tempRoot);
    expect(`${invalidValidation.stdout}${invalidValidation.stderr}`).not.toContain(providerBytes.trim());
    const invalidProvider = await readPluginManifest(providerDir);
    const invalidConsumer = await readPluginManifest(consumerDir);
    await expect(bundleLocalPlugin(invalidConsumer, path.join(tempRoot, 'invalid-bundle'), {
      runtimeResolver: createCatalogRuntimeImportResolver([invalidProvider, invalidConsumer]),
    })).rejects.toThrow('unavailable for platform "claude"');

    const validManifest = structuredClone(invalidManifest);
    validManifest.buildConfig.skillRuntimeFiles[0].platforms = ['codex'];
    validManifest.buildConfig.skillRuntimeFiles[0].distributions = ['agent-skills'];
    await fs.writeJson(manifestPath, validManifest, { spaces: 2 });
    await execFileAsync('git', ['add', '.'], { cwd: tempRoot });
    await execFileAsync(
      'git',
      ['-c', 'user.name=AW Test', '-c', 'user.email=aw-test@example.invalid', 'commit', '-m', 'valid surfaces'],
      { cwd: tempRoot },
    );
    await expect(runValidatePlugin(consumerDir, ['--json'])).resolves.toMatchObject({
      stdout: expect.stringContaining('"ok": true'),
    });
    const validProvider = await readPluginManifest(providerDir);
    const validConsumer = await readPluginManifest(consumerDir);
    const validBundle = path.join(tempRoot, 'valid-bundle');
    await expect(bundleLocalPlugin(validConsumer, validBundle, {
      runtimeResolver: createCatalogRuntimeImportResolver([validProvider, validConsumer]),
    })).resolves.toMatchObject({ outputRoot: validBundle });
    await expect(fs.readFile(
      path.join(validBundle, 'codex', 'skills', 'demo', 'references', 'shared.txt'),
      'utf8',
    )).resolves.toBe(providerBytes);
    await expect(fs.readFile(
      path.join(validBundle, 'agent-skills', 'skills', 'demo', 'references', 'shared.txt'),
      'utf8',
    )).resolves.toBe(providerBytes);
  });

  it('aw plugin validate accepts mixed portable static and dynamic synthetic authoring contracts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-authoring-'));
    tempDirs.push(tempRoot);
    await execFileAsync('git', ['init'], { cwd: tempRoot });
    const providerBytes = '{"profile":"portable-author-validator"}\n';
    await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'portable-provider',
      createBaseManifest('portable-provider', {
        extensions: {
          instructions: [{ name: 'native', title: 'Native provider', content: 'Native provider.' }],
        },
        buildConfig: {
          runtimeExports: [
            { name: 'registry', source: './registry.json' },
            { name: 'unsafe-runtime', source: './unsafe-runtime.txt' },
          ],
        },
      }),
      {
        'registry.json': providerBytes,
        'unsafe-runtime.txt': 'safe runtime bytes\n',
      },
    );
    const { pluginDir } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'portable-authoring',
      createBaseManifest('portable-authoring', {
        schemaVersion: 2,
        extensions: {
          instructions: [{ name: 'native', title: 'Native surface', content: 'Native.' }],
        },
        distributions: { agentSkills: { skills: './portable-skills' } },
        buildConfig: {
          skillRuntimeFiles: [
            {
              skill: 'portable-static',
              target: 'references/runtime.txt',
              distributions: ['agent-skills'],
              source: './runtime.txt',
            },
            {
              skill: 'portable-dynamic',
              target: 'references/dynamic.txt',
              distributions: ['agent-skills'],
              source: './dynamic-runtime.txt',
            },
          ],
        },
        scripts: {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        },
        config: {
          schema: { variant: { type: 'string', default: 'standard' } },
        },
        artifacts: {
          targets: [{
            id: 'portable-dynamic',
            distribution: 'agent-skills',
            scopes: ['user', 'project'],
            target: 'agent-skills.skill',
            states: ['present', 'disabled'],
            refreshKeys: ['variant'],
            skillKey: 'portable-dynamic',
            sourceDirs: ['./portable-source'],
            runtimeImports: [{ name: 'registry', plugin: 'portable-provider', export: 'registry' }],
          }],
        },
      }),
      {
        'runtime.txt': 'portable runtime projection\n',
        'dynamic-runtime.txt': 'dynamic runtime projection\n',
        'portable-skills/portable-static/SKILL.md': '---\nname: portable-static\ndescription: Static portable Skill.\n---\n\n# Static\n',
        'portable-skills/portable-static/README.md': '# Static portable Skill\n',
        'portable-skills/portable-dynamic/SKILL.md': '---\nname: portable-dynamic\ndescription: Dynamic owner placeholder.\n---\n',
        'portable-skills/portable-dynamic/README.md': '# Dynamic owner placeholder\n',
        'portable-source/SKILL.md': '---\nname: portable-dynamic\ndescription: Dynamic portable Skill.\n---\n\n# Dynamic\n',
        'portable-source/README.md': '# Dynamic portable Skill\n',
        'scripts/render.mjs': [
          'const fs = await import("node:fs");',
          'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'if (context.surface.kind === "platform" && context.surface.name === "codex") {',
          '  if (context.distribution !== undefined || process.env.AW_PLUGIN_PLATFORM !== "codex") process.exit(2);',
          '  process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
          '    id: "native-capability", platform: "codex", target: "codex.developerInstructionsBlock", kind: "instruction",',
          '    state: "present", refreshKeys: [], content: "Native capability."',
          '  }] }));',
          '} else {',
          '  if (context.surface.kind !== "distribution" || context.surface.name !== "agent-skills") process.exit(3);',
          '  if (context.platform !== undefined || context.distribution !== "agent-skills") process.exit(4);',
          '  if (process.env.AW_PLUGIN_PLATFORM !== undefined || process.env.AW_PLUGIN_DISTRIBUTION !== "agent-skills") process.exit(5);',
          '  if (context.runtimeImports[0]?.artifactId !== "portable-dynamic") process.exit(6);',
          '  if (!fs.statSync(context.runtimeImports[0].path).isFile()) process.exit(7);',
          '  const registry = JSON.parse(fs.readFileSync(context.runtimeImports[0].path, "utf8"));',
          '  if (registry.profile !== "portable-author-validator") process.exit(8);',
          '  process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
          '    id: "portable-dynamic", distribution: "agent-skills", target: "agent-skills.skill", kind: "skill",',
          '    state: "present", refreshKeys: ["variant"], skillKey: "portable-dynamic",',
          '    content: { files: { "references/rendered.txt": "rendered\\n" } }',
          '  }] }));',
          '}',
        ].join('\n'),
      },
    );
    await execFileAsync('git', ['add', '.'], { cwd: tempRoot });
    await execFileAsync(
      'git',
      ['-c', 'user.name=AW Test', '-c', 'user.email=aw-test@example.invalid', 'commit', '-m', 'fixture'],
      { cwd: tempRoot },
    );

    const result = await runValidatePlugin(pluginDir, ['--json']).catch((failure: unknown) => {
      const output = failure as { stdout?: string; stderr?: string };
      throw new Error(`${output.stdout ?? ''}${output.stderr ?? ''}`);
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, profile: 'aw-source' });

    await fs.writeFile(path.join(pluginDir, 'portable-skills', 'README.md'), '# Invalid root file\n');
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('直接子节点必须是普通目录'),
    });
    await fs.remove(path.join(pluginDir, 'portable-skills', 'README.md'));

    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    await fs.writeFile(path.join(pluginDir, 'dynamic-runtime.txt'), '{{unresolvedRuntime}}\n', 'utf8');
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('final file tree contains an unresolved template'),
    });
    await fs.writeFile(path.join(pluginDir, 'dynamic-runtime.txt'), 'dynamic runtime projection\n', 'utf8');

    const importedFinalTreeManifest = structuredClone(manifest);
    importedFinalTreeManifest.buildConfig.skillRuntimeFiles[1] = {
      skill: 'portable-dynamic',
      target: 'references/dynamic.txt',
      distributions: ['agent-skills'],
      import: { plugin: 'portable-provider', export: 'unsafe-runtime' },
    };
    await fs.writeFile(
      path.join(tempRoot, 'plugins', 'portable-provider', 'unsafe-runtime.txt'),
      '{{unresolvedProviderTemplate}}\n',
      'utf8',
    );
    await fs.writeJson(manifestPath, importedFinalTreeManifest, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('final file tree contains an unresolved template'),
    });
    await fs.writeFile(
      path.join(tempRoot, 'plugins', 'portable-provider', 'unsafe-runtime.txt'),
      'safe runtime bytes\n',
      'utf8',
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    for (const reference of [
      { plugin: 'missing-provider', export: 'registry' },
      { plugin: 'portable-provider', export: 'missing-export' },
    ]) {
      const unresolvedManifest = structuredClone(manifest);
      unresolvedManifest.artifacts.targets[0].runtimeImports[0] = {
        name: 'registry',
        ...reference,
      };
      await fs.writeJson(manifestPath, unresolvedManifest, { spaces: 2 });
      const failure = await runValidatePlugin(pluginDir).catch((error: unknown) => error as { stdout: string });
      expect(failure.stdout).toContain('Cannot resolve artifacts target');
      expect(failure.stdout).not.toContain(tempRoot);
      expect(failure.stdout).not.toContain(providerBytes.trim());
    }
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const importCollisionManifest = structuredClone(manifest);
    importCollisionManifest.buildConfig.skillRuntimeFiles[0] = {
      skill: 'portable-static',
      target: 'references/runtime.txt',
      distributions: ['agent-skills'],
      import: { plugin: 'portable-provider', export: 'registry' },
    };
    await fs.writeFile(
      path.join(pluginDir, 'portable-skills', 'portable-static', 'references'),
      'file blocks imported child\n',
      'utf8',
    );
    await fs.writeJson(manifestPath, importCollisionManifest, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('final file tree path "references" conflicts with "references/runtime.txt"'),
    });
    await fs.remove(path.join(pluginDir, 'portable-skills', 'portable-static', 'references'));

    const withoutDistribution = structuredClone(manifest);
    delete withoutDistribution.distributions;
    await fs.writeJson(manifestPath, withoutDistribution, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('agent-skills targets require distributions.agentSkills'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      extensions: {},
      artifacts: {
        targets: [...manifest.artifacts.targets, {
          id: 'native-capability',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.developerInstructionsBlock',
          states: ['disabled'],
          refreshKeys: [],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('portable-only plugins are not supported'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      extensions: {},
      artifacts: {
        targets: [...manifest.artifacts.targets, {
          id: 'native-capability',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.developerInstructionsBlock',
          states: ['present'],
          refreshKeys: [],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir, ['--json'])).resolves.toMatchObject({
      stdout: expect.stringContaining('"ok": true'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      buildConfig: {
        skillRuntimeFiles: [{
          ...manifest.buildConfig.skillRuntimeFiles[0],
          distributions: ['native'],
        }],
      },
    }, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('/buildConfig/skillRuntimeFiles/0/distributions/0'),
    });

    const uppercaseDynamicKey = structuredClone(manifest);
    uppercaseDynamicKey.artifacts.targets[0].skillKey = 'Foo';
    await fs.writeJson(manifestPath, uppercaseDynamicKey, { spaces: 2 });
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('ASCII lowercase hyphen-case'),
    });

    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeFile(
      path.join(pluginDir, 'portable-skills', 'portable-static', 'SKILL.md'),
      '---\nname: wrong-name\ndescription: Invalid portable Skill.\n---\n',
      'utf8',
    );
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('name 必须与 Skill 目录一致'),
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

    const rendererOnlyClaude = await writeSourcePlugin(
      path.join(tempRoot, 'renderer-only-claude'),
      'renderer-only-claude',
      createBaseManifest('renderer-only-claude', {
        skills: './skills',
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
            id: 'claude-quality-gate',
            platform: 'claude',
            scopes: ['user', 'project'],
            target: 'claude.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'claude-quality-gate',
          }],
        },
      }),
      {
        'skills/common-skill/SKILL.md': '---\nname: common-skill\ndescription: Common static Skill.\n---\n\n# Common\n',
        'skills/common-skill/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
        'scripts/render-artifacts.mjs': [
          'process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
          '  id: "claude-quality-gate", platform: "claude", target: "claude.skill", kind: "skill",',
          '  state: "present", refreshKeys: [], skillKey: "claude-quality-gate",',
          '  content: { files: {',
          '    "SKILL.md": "---\\nname: claude-quality-gate\\ndescription: Claude-only quality gate.\\n---\\n\\n# Quality Gate\\n",',
          '    "README.md": "# Claude Quality Gate\\n"',
          '  } }',
          '}] }));',
        ].join('\n'),
      },
    );
    expect(await fs.readdir(path.join(rendererOnlyClaude.pluginDir, 'skills'))).toEqual([
      'common-skill',
    ]);
    await expect(runValidatePlugin(rendererOnlyClaude.pluginDir)).resolves.toMatchObject({
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

    const dynamicCodex = await writeSourcePlugin(
      path.join(tempRoot, 'codex-dynamic'),
      'codex-dynamic',
      createBaseManifest('codex-dynamic', {
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
            products: ['CODEX'],
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
            id: 'codex-dynamic-skill',
            platform: 'codex',
            scopes: ['project'],
            target: 'codex.skill',
            projectManagedKind: 'skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'codex-dynamic',
            sourceDirs: ['./skills/codex-dynamic'],
          }],
        },
      }),
      {
        'skills/codex-dynamic/SKILL.md': '---\nname: codex-dynamic\ndescription: Dynamic Codex skill.\n---\n\n# Dynamic Codex\n',
        'skills/codex-dynamic/README.md': '# Dynamic Codex\n',
        'skills/codex-dynamic/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
        'scripts/render-artifacts.mjs': [
          'process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
          '  id: "codex-dynamic-skill", platform: "codex", target: "codex.skill", kind: "skill",',
          '  state: "present", refreshKeys: [], skillKey: "codex-dynamic",',
          '  content: { files: {} }',
          '}] }));',
        ].join('\n'),
      },
    );
    await expect(runValidatePlugin(dynamicCodex.pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    const dynamicEvalDir = path.join(dynamicCodex.pluginDir, 'skills', 'codex-dynamic', 'evals');
    await fs.ensureDir(dynamicEvalDir);
    await fs.writeJson(path.join(dynamicEvalDir, 'trigger-cases.json'), {
      schemaVersion: 1,
      skill: 'codex-dynamic',
      cases: [{
        id: 'dynamic_release',
        split: 'validation',
        query: 'Run the dynamic Skill.',
        should_load_skill: true,
      }],
    });
    await fs.writeJson(path.join(dynamicEvalDir, 'manifest.json'), {
      schemaVersion: 2,
      plugin: 'codex-dynamic',
      skill: 'codex-dynamic',
      profiles: [{
        id: 'project-default',
        scope: 'project',
        plugins: [{ name: 'codex-dynamic', config: {} }],
        runModel: true,
        requiredForRelease: false,
      }],
      suites: [{
        id: 'trigger',
        kind: 'trigger',
        skills: ['codex-dynamic'],
        cases: './trigger-cases.json',
        observeSpawnAgent: false,
        isolation: 'strict',
        strictNegativeSplits: [],
        profiles: ['project-default'],
        defaultRuns: 1,
        releaseSplits: ['validation'],
        requiredForRelease: false,
        perRunTimeoutMs: 10_000,
      }],
    });
    await expect(runValidatePlugin(dynamicCodex.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining(
        'must include at least one release-required suite for dynamic Skill "codex-dynamic"',
      ),
    });
    await fs.remove(dynamicEvalDir);
    await fs.writeFile(
      path.join(dynamicCodex.pluginDir, 'skills', 'codex-dynamic', 'SKILL.md'),
      '---\nname: codex-dynamic\ndescription: Dynamic Codex skill.\nuser-invocable: true\n---\n\n# Dynamic Codex\n',
    );
    await expect(runValidatePlugin(dynamicCodex.pluginDir)).rejects.toMatchObject({
      stdout: expect.stringContaining('[portable-profile-platform-extension]'),
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
      stdout: expect.stringContaining('Invalid plugin input tree: symbolic links are not supported'),
    });
    await fs.remove(sourceLink);

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
      stdout: expect.stringContaining('[missing-policy]'),
    });
  });

  it('validate_plugin.mjs accepts native hooks and rejects hook contract mistakes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-hooks-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = validatePluginScriptPath();
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

  it('validate_plugin.mjs validates public slashCommands source contracts', async () => {
    const scriptPath = validatePluginScriptPath();
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
    await fs.writeJson(manifestPath, withManifestSchema({
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    expect(invalidOpenAiYamlStdout).toContain('interface.display_name [invalid-string]');
    expect(invalidOpenAiYamlStdout).toContain('interface.short_description [string-too-long]');
    expect(invalidOpenAiYamlStdout).toContain('interface.default_prompt [invalid-string]');
    expect(invalidOpenAiYamlStdout).toContain('interface.icon_small [invalid-asset-path]');
    expect(invalidOpenAiYamlStdout).toContain('interface.icon_large [invalid-asset-path]');
    expect(invalidOpenAiYamlStdout).toContain('interface.brand_color [invalid-brand-color]');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].type [invalid-string]');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].value [invalid-string]');
    expect(invalidOpenAiYamlStdout).toContain('dependencies.tools[0].transport [invalid-transport]');

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
      stdout: expect.stringContaining('interface.default_prompt [default-prompt-skill-reference]'),
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
      stdout: expect.stringContaining('interface.short_description [string-too-short]'),
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
      stdout: expect.stringContaining('[invalid-yaml]'),
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
      stdout: expect.stringContaining('[invalid-yaml]'),
    });
  });

  it('validate_plugin.mjs follows registry marketplace policy values', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'manifest-products-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    for (const installation of getPluginAuthoringAcceptedValues(
      'manifest',
      'marketplace.policy.installation',
    )) {
      manifest.marketplace.policy.installation = installation;
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
    }

    manifest.marketplace.policy.installation = 'UNKNOWN';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('/marketplace/policy/installation'),
    });
  });

  it('validate_plugin.mjs accepts and validates Codex policy products', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-policy-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'policy-products-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'policy-products-test', 'agents'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();

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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
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
    expect(invalidFrontmatterStdout).toContain(
      'SKILL.md#license [known-field-invalid-type-value]',
    );
    expect(invalidFrontmatterStdout).toContain(
      'SKILL.md#compatibility [known-field-invalid-type-value]',
    );
    expect(invalidFrontmatterStdout).toContain(
      '[known-field-invalid-type-value] field "user-invocable"',
    );
    expect(invalidFrontmatterStdout).toContain(
      'SKILL.md#metadata.short-description [known-field-invalid-type-value]',
    );
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
      '---\r\nname: frontmatter-test\r\ndescription: Validate CRLF frontmatter.\r\n---\r\n\r\n# CRLF\r\n',
      'utf8',
    );
    await expect(execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 },
    )).resolves.toMatchObject({ stdout: expect.stringContaining('"ok": true') });

    await fs.writeFile(
      skillMdPath,
      '---\nname: frontmatter-test\ndescription: Validate EOF closing frontmatter.\n---',
      'utf8',
    );
    await expect(execFileAsync(
      'node',
      [scriptPath, pluginDir, '--strict-agent-skills', '--json'],
      { cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024 },
    )).resolves.toMatchObject({ stdout: expect.stringContaining('"ok": true') });

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
      'SKILL.md#description [string-too-long]',
    );
    expect(unicodeLimitReport?.errors.join('\n')).toContain(
      'SKILL.md#compatibility [string-too-long]',
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
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

    const scriptPath = validatePluginScriptPath();
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toBeDefined();
  });

  it('fails closed without the installed manifest contract even at the default AW floor', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-dependency-floor-'));
    tempDirs.push(tempRoot);
    const authoringRoot = path.join(tempRoot, 'packages', 'cli', 'authoring');
    await fs.ensureDir(path.join(tempRoot, 'packages', 'cli'));
    await Promise.all([
      fs.copy(
        path.join(repoRoot(), 'packages', 'cli', 'authoring', 'scripts'),
        path.join(authoringRoot, 'scripts'),
      ),
      fs.symlink(
        path.join(repoRoot(), 'packages', 'cli', 'node_modules'),
        path.join(tempRoot, 'packages', 'cli', 'node_modules'),
        'dir',
      ),
    ]);
    const pluginDir = path.join(tempRoot, 'plugins', 'fallback-dependency');
    await Promise.all([
      fs.outputJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
        name: 'fallback-dependency',
        version: '1.0.0',
        description: 'Fallback dependency fixture.',
        schemaVersion: 2,
        dependencies: ['shared'],
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      }),
      fs.outputFile(path.join(pluginDir, 'README.md'), '# Fallback dependency\n'),
    ]);

    await expect(execFileAsync('node', [
      path.join(authoringRoot, 'scripts', 'validate-plugin.mjs'),
      pluginDir,
    ], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('Plugin manifest contract v8 is unavailable'),
    });
  });

  it('fails closed for all manifests when only a stale runtime validator is available', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-stale-v4-'));
    tempDirs.push(tempRoot);
    const authoringRoot = path.join(tempRoot, 'packages', 'cli', 'authoring');
    await fs.ensureDir(path.join(tempRoot, 'packages', 'cli'));
    await Promise.all([
      fs.copy(
        path.join(repoRoot(), 'packages', 'cli', 'authoring', 'scripts'),
        path.join(authoringRoot, 'scripts'),
      ),
      fs.symlink(
        path.join(repoRoot(), 'packages', 'cli', 'node_modules'),
        path.join(tempRoot, 'packages', 'cli', 'node_modules'),
        'dir',
      ),
      fs.outputFile(
        path.join(tempRoot, 'packages', 'cli', 'dist', 'src', 'utils', 'manifest.js'),
        [
          'exports.SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION = 4;',
          'exports.validateSourcePluginManifest = async () => { throw new Error("stale v4 validator was trusted"); };',
        ].join('\n'),
      ),
    ]);
    const pluginDir = path.join(tempRoot, 'plugins', 'stale-portable');
    await Promise.all([
      fs.outputJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
        ...createBaseManifest('stale-portable'),
        schemaVersion: 2,
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
        distributions: { agentSkills: { skills: './portable-skills' } },
      }),
      fs.outputFile(path.join(pluginDir, 'README.md'), '# Stale portable\n'),
      fs.outputFile(
        path.join(pluginDir, 'portable-skills', 'portable', 'SKILL.md'),
        '---\nname: portable\ndescription: Stale runtime fixture.\n---\n',
      ),
      fs.outputFile(path.join(pluginDir, 'portable-skills', 'portable', 'README.md'), '# Portable\n'),
    ]);

    const validator = path.join(authoringRoot, 'scripts', 'validate-plugin.mjs');
    await expect(execFileAsync('node', [validator, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('Plugin manifest contract v8 is unavailable'),
    });

    const legacyDir = path.join(tempRoot, 'plugins', 'legacy-native');
    await Promise.all([
      fs.outputJson(path.join(legacyDir, '.agents-plugin', 'plugin.json'), createBaseManifest('legacy-native')),
      fs.outputFile(path.join(legacyDir, 'README.md'), '# Legacy native\n'),
    ]);
    await expect(execFileAsync('node', [validator, legacyDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('Plugin manifest contract v8 is unavailable'),
    });
  });

});
