import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, onTestFailed } from 'vitest';

import { getPluginAuthoringAcceptedValues } from '@lesliechan721/aw-plugin-core/manifest';

import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { nativeToolFixture } from '../helpers/native-tools.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function waitForAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const firstRejection = results.find((result) => result.status === 'rejected');
  if (firstRejection?.status === 'rejected') {
    throw firstRejection.reason;
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<unknown>,
): Promise<void> {
  let nextIndex = 0;
  const failures: Array<{ index: number; reason: unknown }> = [];
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      const value = values[index];
      nextIndex += 1;
      try {
        await task(value!);
      } catch (reason) {
        failures.push({ index, reason });
      }
    }
  });
  await Promise.all(workers);
  failures.sort((left, right) => left.index - right.index);
  if (failures[0]) throw failures[0].reason;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

describe('authoring subprocess batch scheduling', () => {
  it('keeps the observed task peak at two', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
    expect(peak).toBe(2);
  });
});

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function withManifestSchema<T extends Record<string, unknown>>(manifest: T): T {
  return {
    schemaVersion: 4,
    platforms: ['codex', 'claude'],
    ...manifest,
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
    schemaVersion: 4,
    platforms: ['codex', 'claude'],
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
    platforms?: string[] | null;
  } = {},
): Promise<{ pluginDir: string; manifestPath: string }> {
  const rendererRoleKey = options.rendererRoleKey ?? 'codex-explorer';
  return writeSourcePlugin(root, 'dynamic-authoring-test', createBaseManifest('dynamic-authoring-test', {
    ...(options.platforms === null ? {} : { platforms: options.platforms ?? ['codex'] }),
    skills: './skills',
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render-artifacts.mjs' } } },
    config: { fields: {
      enableInstruction: { type: 'boolean', default: true },
      explorerModel: { type: 'string', default: 'gpt-5.4-mini' },
    } },
    artifacts: { configKeys: ['enableInstruction', 'explorerModel'] },
  }), {
    'scripts/render-artifacts.mjs': [
      "import sourceFs from 'node:fs';",
      "const request = JSON.parse(sourceFs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      'const components = [], omitted = [], unmet = [];',
      'const candidates = [{id:"lightweight-instruction",kind:"instruction",name:"lightweight-instruction",content:{title:"Read-only work",content:"Use the explorer for read-only work.",coverage:["main"]}},',
      `{id:"codex-explorer-role",kind:"agent",${options.includeRoleKey === false ? '' : `name:${JSON.stringify(rendererRoleKey)},`}content:{description:"Read-only explorer.",prompt:"Read only. Do not edit files.",model:request.config.values.explorerModel}}];`,
      'for (const component of candidates) {',
      '  if (!request.allowedOutputKinds.includes(component.kind)) continue;',
      '  if (component.kind === "instruction" && !request.config.values.enableInstruction) { omitted.push({id:component.id,kind:component.kind,reason:"config-disabled"}); continue; }',
      '  const requirements = [{feature:`component.kind.${component.kind}`}, ...(component.kind === "agent" ? [{feature:"agent.execution",values:["isolated-context"]},{feature:"agent.prompt-mode",values:["host-default"]},{feature:"agent.model"}] : [{feature:"instruction.coverage",values:["main"]}])];',
      '  const gaps = requirements.filter(requirement => { const fact = requirement.feature.startsWith("component.kind.") ? request.platformCapabilities.kinds[component.kind] : request.platformCapabilities.features[requirement.feature]; return fact?.status !== "supported" || requirement.values?.some(value => !fact.values?.includes(value)); });',
      '  if (component.name === undefined || component.name.includes("/")) components.push(component);',
      '  else if (gaps.length) unmet.push({id:component.id,kind:component.kind,name:component.name,requiredFeatures:gaps,reasonCode:"capability-unverified"});',
      '  else components.push(component);',
      '}',
      'process.stdout.write(JSON.stringify({version:3,components,omitted,unmet}));',
    ].join('\n'),
    'skills/dynamic-authoring-test/SKILL.md': '---\nname: dynamic-authoring-test\ndescription: Validate dynamic artifact authoring.\n---\nRead-only fixture.\n',
    'skills/dynamic-authoring-test/agents/openai.yaml': options.omitCodexInvocationPolicy
      ? 'interface: {}\n' : 'policy:\n  allow_implicit_invocation: false\n',
  });
}

async function writeSlashCommandPlugin(
  root: string,
  options: {
    name: string;
    platforms?: string[] | null;
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
      ...(options.platforms === null ? {} : { platforms: options.platforms ?? ['codex'] }),
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
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
      schemaVersion: 4,
      platforms: ['codex', 'claude'],
      name: 'repo-check',
      version: '0.1.0',
      description: '检查仓库状态并输出诊断结论。',
      skills: './skills',
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
        capabilities: ['Skills'],
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
      version: 1,
      defaults: { profile: 'project-default' },
      profiles: {
        'project-default': {
          platform: 'codex',
          scope: 'project',
          plugins: { 'repo-check': {} },
        },
        'user-default': {
          platform: 'codex',
          scope: 'user',
          plugins: { 'repo-check': {} },
        },
      },
      suites: expect.arrayContaining([
        expect.objectContaining({
          id: 'trigger',
          kind: 'trigger',
          cases: 'trigger-cases.json',
          runs: 3,
          timeoutMs: 180000,
        }),
        expect.objectContaining({
          id: 'behavior',
          kind: 'conversation',
          cases: 'behavior-cases.json',
          runs: 1,
          timeoutMs: 300000,
        }),
      ]),
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
      version: number;
      suite: {
        kind: string;
        unitUnderTest: string;
        policy: {
          optimization: string;
          falseNegativeCost: string;
          falsePositiveCost: string;
        };
        runtime: {
          isolation: string;
          strictNegativeSplits: string[];
        };
      };
      cases: Array<{
        tags: string[];
        input: {
          query: string;
          expectedLoad: boolean;
        };
        audit?: {
          rationale: string;
          minimalCounterexample: string;
        };
      }>;
    };
    expect(modelTriggerCases).toMatchObject({
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'repo-check',
        policy: {
          optimization: 'balanced',
          falseNegativeCost: 'high',
          falsePositiveCost: 'high',
        },
        runtime: {
          isolation: 'strict',
          strictNegativeSplits: ['validation', 'sanity'],
        },
      },
    });
    expect(modelTriggerCases.cases
      .filter((entry) => entry.input.expectedLoad)
      .every((entry) => entry.input.query.includes(
        '检查仓库状态、执行风险核验并生成结构化诊断报告工作流',
      ))).toBe(true);
    expect(modelTriggerCases.cases
      .filter((entry) => entry.input.expectedLoad)
      .every((entry) => entry.audit === undefined)).toBe(true);
    expect(modelTriggerCases.cases
      .filter((entry) => !entry.input.expectedLoad)
      .every((entry) => (
        entry.tags.includes('boundary')
        && typeof entry.audit?.rationale === 'string'
        && typeof entry.audit?.minimalCounterexample === 'string'
      ))).toBe(true);
    for (const entry of modelTriggerCases.cases) {
      expect(entry).not.toHaveProperty('query');
      expect(entry).not.toHaveProperty('should_load_skill');
      expect(entry).not.toHaveProperty('eval_type');
      expect(entry).not.toHaveProperty('scenario_family');
      expect(entry).not.toHaveProperty('preconditions');
      expect(entry).not.toHaveProperty('oracle');
    }
    expect(JSON.stringify(modelTriggerCases)).not.toContain('$repo-check');
    const modelBehaviorCasesPath = path.join(
      tempRepo,
      'plugins',
      'repo-check',
      'skills',
      'repo-check',
      'evals',
      'behavior-cases.json',
    );
    const modelBehaviorCases = await fs.readJson(modelBehaviorCasesPath) as {
      version: number;
      suite: {
        kind: string;
        unitUnderTest: string;
        policy: {
          optimization: string;
          falseNegativeCost: string;
          falsePositiveCost: string;
        };
        runtime: { isolation: string };
      };
      cases: Array<{
        prompt: string;
        assertions: string[];
        expected: Record<string, unknown>;
        audit?: Record<string, unknown>;
      }>;
    };
    expect(modelBehaviorCases).toMatchObject({
      version: 1,
      suite: {
        kind: 'conversation',
        unitUnderTest: 'repo-check',
        policy: {
          optimization: 'precision-first',
          falseNegativeCost: 'medium',
          falsePositiveCost: 'high',
        },
        runtime: { isolation: 'strict' },
      },
      cases: [expect.objectContaining({
        prompt: expect.any(String),
        assertions: expect.any(Array),
        expected: expect.any(Object),
      })],
    });
    expect(modelBehaviorCases.cases[0]?.assertions.length).toBeGreaterThan(0);
    expect(modelBehaviorCases.cases[0]?.audit).toBeUndefined();
    const evalCaseValidatorPath = path.join(
      repoRoot(),
      'plugins',
      'aw-skill-eval-runner',
      'skills',
      'run-aw-skill-evals',
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
        valid: true,
        summary: {
          errors: 0,
        },
      });
    }
    expect(scaffoldManifest).not.toHaveProperty('apps');
    await expect(fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', '.app.json'))).resolves.toBe(false);
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
      suite: {
        policy: {
          optimization: string;
          falseNegativeCost: string;
          falsePositiveCost: string;
        };
      };
      cases: Array<{ input: { query: string; expectedLoad: boolean } }>;
    };
    expect(manualTriggerCases.suite.policy).toMatchObject({
      optimization: 'precision-first',
      falseNegativeCost: 'medium',
      falsePositiveCost: 'high',
    });
    expect(manualTriggerCases.cases
      .filter((entry) => entry.input.expectedLoad)
      .every((entry) => entry.input.query.includes('$manual-workflow'))).toBe(true);
    expect(manualTriggerCases.cases
      .filter((entry) => !entry.input.expectedLoad)
      .every((entry) => !entry.input.query.includes('$manual-workflow'))).toBe(true);

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

    for (const skillRoot of [manualRoot, claudeModelRoot]) {
      const pluginRoot = path.resolve(skillRoot, '..', '..');
      const manifest = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
      expect(manifest.platforms).toEqual(['codex', 'claude']);
      const skillPath = path.join(skillRoot, 'SKILL.md');
      const scaffold = await fs.readFile(skillPath, 'utf8');
      await fs.writeFile(skillPath, scaffold.replace(/\[TODO:[^\]]+\]/gu, '核对平台、输入与输出，并报告验证结果'));
      await expect(runValidatePlugin(pluginRoot)).resolves.toMatchObject({
        stdout: expect.stringContaining('[PASS] All checks passed.'),
      });
    }

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
      'aw dev plugin validate',
      'aw dev plugin test',
      'aw dev plugin build',
      'aw dev catalog build',
      'aw dev catalog publish',
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
    const scaffoldManifest = await fs.readJson(path.join(dualSkillRoot, 'evals', 'manifest.json'));
    expect(scaffoldManifest).toMatchObject({
      version: 1,
      defaults: { profile: 'project-default' },
      profiles: {
        'project-default': {
          platform: 'codex',
          plugins: { 'git-commit': {} },
        },
      },
    });
    expect(scaffoldManifest.suites).toEqual([
      {
        id: 'trigger',
        kind: 'trigger',
        cases: 'trigger-cases.json',
        profiles: ['project-default'],
        runs: 3,
        timeoutMs: 180000,
      },
      {
        id: 'behavior',
        kind: 'conversation',
        cases: 'behavior-cases.json',
        profiles: ['project-default'],
        runs: 1,
        timeoutMs: 300000,
      },
    ]);
    await expect(
      fs.readJson(path.join(dualSkillRoot, 'evals', 'trigger-cases.json')),
    ).resolves.toMatchObject({
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'release-notes',
        policy: {
          optimization: 'precision-first',
          falseNegativeCost: 'medium',
          falsePositiveCost: 'high',
        },
      },
      cases: expect.arrayContaining([
        expect.objectContaining({
          tags: expect.arrayContaining(['boundary']),
          input: expect.objectContaining({ expectedLoad: false }),
          audit: expect.objectContaining({
            rationale: expect.any(String),
            minimalCounterexample: expect.any(String),
          }),
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

    for (const platform of ['codex', 'claude', 'generic'] as const) {
      const pluginName = `${platform}-only-add-skill`;
      const { pluginDir } = await writeSourcePlugin(
        path.join(tempRepo, 'plugins'),
        pluginName,
        createBaseManifest(pluginName, {
          platforms: [platform],
          marketplace: {
            category: 'workflow',
            strict: true,
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
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
      } else if (platform === 'codex') {
        expect(skillMd).not.toContain('disable-model-invocation:');
        await expect(
          fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
        ).resolves.toEqual(expect.stringContaining('allow_implicit_invocation: false'));
        await expect(fs.pathExists(path.join(skillRoot, 'evals', 'manifest.json'))).resolves.toBe(true);
      } else {
        expect(skillMd).not.toContain('user-invocable:');
        expect(skillMd).not.toContain('disable-model-invocation:');
        await expect(fs.pathExists(path.join(skillRoot, 'agents', 'openai.yaml'))).resolves.toBe(false);
        await expect(fs.pathExists(path.join(skillRoot, 'evals'))).resolves.toBe(false);
      }
    }

    const { pluginDir: dynamicRoot } = await writeSourcePlugin(
      path.join(tempRepo, 'plugins'), 'dynamic-names', createBaseManifest('dynamic-names', {
        artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      }), { 'render.mjs': "throw new Error('add-skill must not discover dynamic names by rendering');\n" },
    );
    await execFileAsync('node', [scriptPath, 'dynamic-names', '--skill-name', 'repo-report',
      '--skill-description', 'Add a static Skill without evaluating dynamic component names.',
      '--workspace-root', tempRepo], { cwd: repoRoot(), env: process.env });
    await expect(fs.pathExists(path.join(dynamicRoot, 'skills', 'repo-report', 'SKILL.md'))).resolves.toBe(true);

    for (const removed of [{ schemaVersion: 3 }, { slashCommands: './slash-commands' }, { apps: './.app.json' },
      { artifacts: { targets: [] } }]) {
      const { pluginDir, manifestPath } = await writeSourcePlugin(path.join(tempRepo, 'plugins'),
        'removed-entry', createBaseManifest('removed-entry', removed));
      const before = await fs.readFile(manifestPath, 'utf8');
      await expect(execFileAsync('node', [scriptPath, 'removed-entry', '--skill-name', 'repo-report',
        '--skill-description', 'Reject removed author entries before writing any Skill files.',
        '--workspace-root', tempRepo], { cwd: repoRoot(), env: process.env })).rejects.toMatchObject({
        stderr: expect.stringContaining(Object.hasOwn(removed, 'schemaVersion')
          ? 'Unsupported plugin manifest schemaVersion' : 'Invalid plugin manifest structure'),
      });
      expect(await fs.readFile(manifestPath, 'utf8')).toBe(before);
      expect(await fs.pathExists(path.join(pluginDir, 'skills', 'repo-report'))).toBe(false);
      await fs.remove(pluginDir);
    }

  });

  const externalPluginRootTest = fs.existsSync(
    path.join(repoRoot(), 'packages', 'cli', 'dist'),
  ) ? it : it.skip;
  function canonicalWorkflowTiming() {
    const workflowStarted=performance.now();
    const completed:Array<{stage:string;stageMs:number}>=[];
    let active:{stage:string;started:number}|undefined;
    onTestFailed(()=>{
      process.stderr.write('AW_CANONICAL_STAGE '+JSON.stringify({
        stage:active?.stage??completed.at(-1)?.stage,active:active!==undefined,
        stageMs:active?Math.round(performance.now()-active.started):undefined,
        elapsedMs:Math.round(performance.now()-workflowStarted),completed,
      })+'\n');
    });
    return async function timed<T>(stage:string,run:()=>Promise<T>):Promise<T>{
      const started=performance.now();
      active={stage,started};
      try { return await run(); }
      finally { completed.push({stage,stageMs:Math.round(performance.now()-started)});active=undefined; }
    };
  }

  async function createCanonicalWorkflowFixture(timed:ReturnType<typeof canonicalWorkflowTiming>) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-external-plugin-root-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const pluginRoot = path.join(workspaceRoot, 'plugins', 'demo');
    const cliEntry = path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js');
    await fs.ensureDir(workspaceRoot);
    await timed('catalog:create',()=>execFileAsync('node', [
      cliEntry,
      'dev',
      'catalog',
      'create',
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
    ], { cwd: workspaceRoot, env: process.env }));
    await timed('git:init',()=>runGit(workspaceRoot, ['init']));

    await timed('plugin:create',()=>execFileAsync('node', [
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
    ], { cwd: workspaceRoot, env: process.env }));

    await timed('skill:create',()=>execFileAsync('node', [
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
    ], { cwd: workspaceRoot, env: process.env }));

    for (const skillName of ['demo', 'second-workflow']) {
      const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
      const scaffold = await fs.readFile(skillPath, 'utf8');
      await fs.writeFile(
        skillPath,
        scaffold.replace(/\[TODO:[^\]]+\]/gu, '已完成明确、可验证的作者合同'),
        'utf8',
      );
    }

    await timed('git:add',()=>runGit(workspaceRoot, ['add', 'plugins']));
    await timed('git:baseline',()=>runGit(workspaceRoot, [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'baseline',
    ]));

    return {workspaceRoot,pluginRoot,cliEntry};
  }

  externalPluginRootTest('uses the canonical plugin root through the public authoring workflow', async () => {
    const timed=canonicalWorkflowTiming();
    const {workspaceRoot,pluginRoot,cliEntry}=await createCanonicalWorkflowFixture(timed);
    const sourceFiles=[path.join(pluginRoot,'.agents-plugin/plugin.json'),
      ...['demo','second-workflow'].map(name=>path.join(pluginRoot,'skills',name,'SKILL.md'))];
    const sourceBytes=await Promise.all(sourceFiles.map(file=>fs.readFile(file)));
    const validation = await timed('plugin:validate',()=>execFileAsync('node', [
      path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js'),
      'dev',
      'plugin',
      'validate',
      pluginRoot,
      '--workspace-root',
      workspaceRoot,
      '--json',
    ], { cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 }));
    // A successful validator result must not hide an unavailable version checker.
    expect(JSON.parse(validation.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'dev.plugin.validate',
      status: 'success',
      data: {
        profile: 'aw-source',
        versionCheck: {
          ok: true,
          checks: [{ plugin: 'demo', status: 'unchanged', productionChanged: false }],
        },
      },
      diagnostics: expect.any(Array),
      nextActions: expect.any(Array),
    });
    for (const args of [
      ['dev', 'plugin', 'test', pluginRoot, '--workspace-root', workspaceRoot, '--json'],
      ['dev', 'plugin', 'build', pluginRoot, '--workspace-root', workspaceRoot, '--json'],
      ['dev', 'catalog', 'build', '--workspace-root', workspaceRoot, '--json'],
    ]) {
      const completed = await timed(args.slice(0,3).join('.'),()=>execFileAsync('node', [cliEntry, ...args], {
        cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024,
      }));
      expect(JSON.parse(completed.stdout)).toMatchObject({
        schemaVersion: 1, command: args.slice(0, 3).join('.'), status: 'success',
        data: expect.any(Object), diagnostics: expect.any(Array), nextActions: expect.any(Array),
      });
    }

    expect(await Promise.all(sourceFiles.map(file=>fs.readFile(file)))).toEqual(sourceBytes);
  }, 30_000);

  externalPluginRootTest('compares unchanged and changed canonical plugin sources through the public CLI', async () => {
    const timed=canonicalWorkflowTiming();
    const {workspaceRoot,pluginRoot,cliEntry}=await createCanonicalWorkflowFixture(timed);
    const unchanged = await timed('plugin:status-unchanged',()=>execFileAsync('node', [
      cliEntry,
      'dev',
      'plugin',
      'status',
      '--base',
      'HEAD',
      'demo',
      '--json',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 }));
    expect(JSON.parse(unchanged.stdout)).toMatchObject({
      schemaVersion:1,command:'dev.plugin.status',status:'success',data:{checks:[{
        plugin:'demo',status:'unchanged',baseVersion:'0.1.0',currentVersion:'0.1.0',productionChanged:false,
      }]},
    });
    await fs.appendFile(
      path.join(pluginRoot, 'skills', 'second-workflow', 'SKILL.md'),
      '\nChanged production behavior.\n',
      'utf8',
    );
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.version = '0.1.1';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const versionCheck = await timed('plugin:status',()=>execFileAsync('node', [
      cliEntry,
      'dev',
      'plugin',
      'status',
      '--base',
      'HEAD',
      'demo',
      '--json',
      '--workspace-root',
      workspaceRoot,
    ], { cwd: workspaceRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 }));
    const versionResult = JSON.parse(versionCheck.stdout);
    expect(versionResult).toMatchObject({ schemaVersion: 1, command: 'dev.plugin.status', status: 'success' });
    expect(versionResult.data.checks[0]).toMatchObject({
      plugin: 'demo',
      status: 'versionBumped',
      baseVersion: '0.1.0',
      currentVersion: '0.1.1',
      productionChanged: true,
    });
  }, 30_000);

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
    await mapWithConcurrency(cases, 2, async (pathCase) => {
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
    });
  });

  it('rejects the removed plugin-root option through the public CLI', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-root-escape-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    await fs.ensureDir(workspaceRoot);
    const failure = await execFileAsync('node', [
      path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js'),
      'dev', 'plugin', 'create',
      'demo',
      '--description',
      'Reject an escaped plugin root.',
      '--no-skills',
      '--workspace-root',
      workspaceRoot,
      '--plugin-root',
      '../demo',
      '--json',
    ], { cwd: workspaceRoot, env: process.env }).then(() => null, (error: unknown) => error as { code: number; stdout: string });
    expect(failure?.code).toBe(2);
    expect(JSON.parse(failure!.stdout)).toMatchObject({
      schemaVersion: 1, command: 'dev.plugin.create', status: 'failed', data: {},
      diagnostics: [expect.objectContaining({ code: 'invalidArguments', message: expect.stringContaining('--plugin-root') })],
      nextActions: expect.any(Array),
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
          runtimeExports: [{
            name: 'standard', source: './standard.txt',
            requires: { aw: { capabilities: [] } },
          }],
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
      createBaseManifest('historical-closure', {
        skills: './skills',
        requires: { aw: { capabilities: ['aw.catalog-context.v1'] } },
      }),
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

    const currentManifest = await fs.readJson(manifestPath);
    delete currentManifest.requires;
    await fs.writeJson(manifestPath, currentManifest, { spaces: 2 });

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

  it('scaffolds an explicit manifest v4 without a version compatibility field', async () => {
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
        '用于验证 Manifest v4 的示例插件。',
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
      schemaVersion: 4,
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
      stdout: expect.stringContaining('Unsupported plugin manifest schemaVersion: expected 4'),
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

  it('standard aw-config helper uses only effective AW_PLUGIN_CONTEXT data', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-helper-context-'));
    tempDirs.push(tempRoot);
    const sourceIdentity = `sha256:${'1'.repeat(64)}`;
    const logicalIdentity = 'catalog.example/context-helper';

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
    await fs.writeJson(contextPath, {
      plugin: {
        name: 'context-helper',
        sourceId: 'team',
        sourceIdentity,
        logicalIdentity,
        pluginId: 'team/context-helper',
      },
      config: {
        mode: 'artifact-render',
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
          mode: {
            type: 'string',
            default: 'standard',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'standard', title: 'Standard', value: 'standard' },
                { id: 'strict', title: 'Strict', value: 'strict' },
              ],
            },
          },
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
      pluginId: 'team/context-helper',
      scope: 'effective',
      values: {
        apiKey: '[redacted]',
        mode: 'strict',
      },
      sources: {
        apiKey: 'user',
        mode: 'project',
      },
    });

    await expect(execFileAsync(
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
    )).rejects.toMatchObject({
      stderr: expect.stringMatching(/only supports effective config reads; use aw plugin config.*explicit context/u),
    });
  });

  it('scaffolds config helper, preApply, config schema, and plugin script tests on demand', async () => {
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
        'Plugin with AW config helper and preApply script.',
        '--no-skills',
        '--with-config-api',
        '--with-pre-apply',
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
        preApply: { path: './scripts/preApply.mjs' },
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        tests: {
          node: ['./scripts/**/*.test.mjs'],
        },
      },
      config: {
        fields: {
          apiKey: {
            type: 'string',
            required: true,
            sensitive: true,
          },
        },
      },
    });
    await expect(fs.pathExists(path.join(pluginDir, 'scripts', 'aw-config.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(pluginDir, 'scripts', 're2-wasm'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(pluginDir, 'scripts', 'preApply.mjs'))).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginDir, 'scripts', 'generated-script.test.mjs')),
    ).resolves.toBe(true);
    const generatedTest = await execFileAsync(
      process.execPath,
      ['--test', path.join(pluginDir, 'scripts', 'generated-script.test.mjs')],
      {
        cwd: pluginDir,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(generatedTest.stdout).toContain('pass 2');
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
        postApply: { path: './scripts/lifecycle.mjs' },
      },
    }, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('/scripts must NOT have additional properties'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        preApply: { path: './scripts/lifecycle.mjs', timeoutMs: 1_800_001 },
      },
    }, { spaces: 2 });

    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        '/scripts/preApply/timeoutMs must be <= 1800000',
      ),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.txt',
        },
        preApply: { path: './scripts/lifecycle.mjs' },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        fields: {
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
      stdout: expect.stringContaining('/config/fields/badMin'),
    });

    const helperOnlyManifest = await fs.readJson(manifestPath);
    helperOnlyManifest.config = { fields: { goodKey: { type: 'string' } } };
    await fs.writeJson(manifestPath, helperOnlyManifest, { spaces: 2 });
    await expect(execFileAsync('node', [scriptPath, pluginDir], {
      cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('scripts.helpers.config: expected a Node runnable file extension'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        preApply: { path: './scripts/lifecycle.py' },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        fields: {
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
      stdout: expect.stringContaining('scripts.preApply.path: expected a Node runnable file extension'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      scripts: {
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        preApply: { path: './scripts/lifecycle.mjs' },
        node: {
          packageRoot: './scripts/pkg',
        },
      },
      config: {
        fields: {
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
      stdout: expect.stringContaining('scripts.node.packageRoot: missing pnpm-lock.yaml'),
    });
    await fs.writeFile(path.join(pluginDir, 'scripts', 'pkg', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
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
    const fields = {
      mode: {
        type: 'string',
        choices: {
          allowCustom: false,
          presets: [
            { id: 'safe', title: 'Safe', value: 'safe', recommended: true },
            { id: 'fast', title: 'Fast', value: 'fast' },
          ],
        },
      },
      limit: {
        type: 'number',
        validation: { minimum: 1, maximum: 20 },
      },
      trace: {
        type: 'boolean',
      },
      token: {
        type: 'string',
        sensitive: true,
      },
      rules: {
        type: 'string',
      },
      workspace: {
        type: 'string',
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
      config: { fields },
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
        fields: {
          ...fields,
          token: {
            ...fields.token,
            sensitive: false,
            choices: {
              allowCustom: true,
              presets: [{ id: 'private', title: 'Private', value: 'private' }],
            },
          },
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
        fields,
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode', 'limit'] },
            { id: 'advanced', title: 'Advanced', fields: ['trace'], advanced: true },
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
        fields,
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode', 'missing'] },
            { id: 'general', title: 'Duplicate', fields: ['mode'] },
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
    expect(invalidStdout).toContain('unknown config key "missing"');

    await fs.writeJson(manifestPath, {
      ...manifest,
      config: {
        fields,
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode'] },
            { id: 'general', title: 'Duplicate', fields: ['limit'] },
          ],
        },
      },
    }, { spaces: 2 });
    await expect(execFileAsync(process.execPath, [scriptPath, pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('duplicate group id "general"'),
    });

    await fs.writeJson(manifestPath, {
      ...manifest,
      config: {
        fields,
        presentation: { presets: [] },
      },
    }, { spaces: 2 });
    await expect(execFileAsync(process.execPath, [scriptPath, pluginDir], {
      cwd: repoRoot(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('must NOT have additional properties'),
    });
  });

  it('validate_plugin.mjs scans real Node imports without comment, string, regex, or template-text ghosts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-import-scan-'));
    tempDirs.push(tempRoot);
    const { pluginDir } = await writeSourcePlugin(
      path.join(tempRoot, 'plugins'),
      'import-scan-test',
      createBaseManifest('import-scan-test', {
        scripts: {
          preApply: { path: './scripts/entry.mjs' },
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

  it('validate_plugin.mjs validates v4 renderer declarations and complete v3 component sets', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-artifacts-'));
    tempDirs.push(tempRoot);
    const { pluginDir, manifestPath } = await writeDynamicArtifactPlugin(tempRoot);
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    const validManifest = await fs.readJson(manifestPath);
    for (const artifacts of [
      { configKeys: [], targets: [] },
      { configKeys: ['enableInstruction'], scopes: ['workspace'] },
      { configKeys: ['missingConfigKey'] },
    ]) {
      await fs.writeJson(manifestPath, { ...validManifest, artifacts }, { spaces: 2 });
      await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringMatching(/additional properties|allowed values|unknown config key/u),
      });
    }
    const component = { id: 'computed', kind: 'skill', name: 'computed', content: { files: {
      'SKILL.md': { text: '---\nname: computed\ndescription: Computed Skill.\n---\nRead the result.\n' },
      'README.md': { text: '# Computed\n' },
    } } };
    await fs.writeJson(manifestPath, { ...validManifest, platforms: ['generic'],
      artifacts: { configKeys: [] } }, { spaces: 2 });
    const rendererPath = path.join(pluginDir, 'scripts', 'render-artifacts.mjs');
    const writePlan = (plan: unknown) => fs.writeFile(rendererPath,
      `process.stdout.write(JSON.stringify(${JSON.stringify(plan)}));\n`);
    await writePlan({ version: 3, components: [component], omitted: [], unmet: [] });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    for (const [plan, diagnostic] of [
      [{ version: 2, artifacts: [] }, /version|component plan/u],
      [{ version: 3, components: [component, component], omitted: [], unmet: [] }, /duplicate component ID/u],
      [{ version: 3, components: [{ ...component, id: 'outside', name: '../outside' }], omitted: [], unmet: [] }, /name|path/u],
      [{ version: 3, components: [component], omitted: [{ id: 'computed', kind: 'skill', reason: 'config-disabled' }], unmet: [] }, /duplicate component ID/u],
    ] as const) {
      await writePlan(plan);
      await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({ stdout: expect.stringMatching(diagnostic) });
    }
    // The same dynamic identity is legal in separate fixed profile requests.
    await writePlan({ version: 3, components: [component], omitted: [], unmet: [] });
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
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
        platforms: ['codex', 'generic'],
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL',  },
        },
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] },
        buildConfig: { runtimeExports: [{
          name: 'shared', source: './shared.txt',
          requires: { aw: { capabilities: [] } },
        }] },
      }),
      { 'shared.txt': providerBytes },
    );
    const invalidManifest = createBaseManifest('surface-consumer', {
      schemaVersion: 4,
      platforms: ['codex', 'claude', 'generic'],
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] },
      skills: './skills',
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
    validManifest.buildConfig.skillRuntimeFiles[0].platforms = ['codex', 'generic'];

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
      path.join(validBundle, 'generic', 'skills', 'demo', 'references', 'shared.txt'),
      'utf8',
    )).resolves.toBe(providerBytes);
  });

  it('aw dev plugin validate prepares static and dynamic generic Skills with verified runtime imports', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-authoring-'));
    tempDirs.push(tempRoot);
    await runGit(tempRoot,['init']);
    await writeSourcePlugin(path.join(tempRoot,'plugins'),'portable-provider',createBaseManifest('portable-provider',{
      platforms:['generic'],buildConfig:{runtimeExports:[
        {name:'registry',source:'./registry.json',requires:{aw:{capabilities:[]}}},
        {name:'runtime',source:'./runtime.txt',requires:{aw:{capabilities:[]}}},
      ]},
    }),{'registry.json':'{"profile":"portable-author-validator"}\n','runtime.txt':'Safe provider runtime.\n'});
    const component = {id:'portable-dynamic',kind:'skill',name:'portable-dynamic',content:{files:{
      'SKILL.md':{source:{kind:'bundle',path:'templates/SKILL.md'}},
      'README.md':{source:{kind:'bundle',path:'templates/README.md'}},
      'references/dynamic.txt':{source:{kind:'bundle',path:'templates/dynamic-runtime.txt'}},
      'references/registry.json':{source:{kind:'runtime-import',name:'registry',path:'registry'}},
      'references/provider-runtime.txt':{source:{kind:'runtime-import',name:'runtime',path:'runtime'}},
    }}};
    const renderer = (output:unknown)=>[
      "import fs from 'node:fs';",
      "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      'if(c.surface!=="agent-plugin" || c.platformCapabilities.basis!=="profile" || c.platform!=="generic") throw new Error("wrong profile");',
      'if(c.resources.filter(resource=>resource.kind==="runtime-import").some(resource=>!fs.statSync(resource.root+"/"+resource.name).isFile())) throw new Error("missing runtime import");',
      `console.log(JSON.stringify({version:3,components:[${JSON.stringify(output)}],omitted:[],unmet:[]}));`,
    ].join('\n');
    const manifest = createBaseManifest('portable-authoring',{
      platforms:['generic'],dependencies:['portable-provider'],skills:'./skills',
      buildConfig:{skillRuntimeFiles:[{skill:'portable-static',target:'references/runtime.txt',platforms:['generic'],source:'./runtime.txt'}]},
      config:{fields:{variant:{type:'string',default:'standard'}}},
      artifacts:{configKeys:['variant'],sourceDirs:['./templates'],runtimeImports:[
        {name:'registry',plugin:'portable-provider',export:'registry'},
        {name:'runtime',plugin:'portable-provider',export:'runtime'},
      ]},
      scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
    });
    const {pluginDir}=await writeSourcePlugin(path.join(tempRoot,'plugins'),'portable-authoring',manifest,{
      'runtime.txt':'Portable static runtime.\n',
      'skills/portable-static/SKILL.md':'---\nname: portable-static\ndescription: Static Skill.\n---\nRead references/runtime.txt.\n',
      'templates/SKILL.md':'---\nname: portable-dynamic\ndescription: Dynamic Skill.\n---\nRead references/dynamic.txt.\n',
      'templates/README.md':'# Dynamic Skill\n',
      'templates/dynamic-runtime.txt':'Dynamic runtime projection.\n',
      'scripts/render.mjs':renderer(component),
    });
    await runGit(tempRoot,['add','.']);
    await runGit(tempRoot,['-c','user.name=AW Test','-c','user.email=aw-test@example.invalid','commit','-m','fixture']);
    await expect(runValidatePlugin(pluginDir,['--json'])).resolves.toMatchObject({stdout:expect.stringContaining('"ok": true')});
    const scenarios=['portable-root-file','literal-runtime-text','literal-provider-runtime-text','unresolved-declared-template','missing-provider',
      'missing-export','import-collision','invalid-platform-selector','uppercase-skill-key','wrong-skill-name'] as const;
    await mapWithConcurrency(scenarios,2,async scenario=>{
      const root=path.join(tempRoot,'scenarios',scenario);
      await runGit(tempRoot,['clone','--shared',tempRoot,root]);
      const target=path.join(root,'plugins','portable-authoring');
      const input=structuredClone(manifest) as typeof manifest & {artifacts:{runtimeImports:Array<{name:string;export:string}>};buildConfig:{skillRuntimeFiles:Array<{platforms:string[]}>}};
      const output=structuredClone(component);
      let diagnostic:RegExp|null=null;
      if(scenario==='portable-root-file'){
        await fs.outputFile(path.join(target,'skills','not-a-skill.txt'),'Root file.\n');diagnostic=/skills|Skill directory/u;
      }else if(scenario==='literal-runtime-text'){
        await fs.writeFile(path.join(target,'runtime.txt'),'{{literal-runtime}}\n');
      }else if(scenario==='literal-provider-runtime-text'){
        await fs.writeFile(path.join(root,'plugins','portable-provider','runtime.txt'),'{{literal-provider-runtime}}\n');
      }else if(scenario==='unresolved-declared-template'){
        Object.assign(input.buildConfig,{templates:{include:['skills/**/*.md'],vars:{missing:{codex:'other-platform'}}}});
        await fs.appendFile(path.join(target,'skills/portable-static/SKILL.md'),'{{missing}}\n');
        diagnostic=/Missing template variable.*missing.*generic/u;
      }else if(scenario==='missing-provider'){
        await fs.remove(path.join(root,'plugins','portable-provider'));diagnostic=/portable-provider|provider|dependency/u;
      }else if(scenario==='missing-export'){
        input.artifacts.runtimeImports[0].export='missing-export';diagnostic=/missing-export|export/u;
      }else if(scenario==='import-collision'){
        input.artifacts.runtimeImports[1].name='registry';diagnostic=/duplicate|registry/u;
      }else if(scenario==='invalid-platform-selector'){
        input.buildConfig.skillRuntimeFiles[0].platforms=['agent-skills'];diagnostic=/platform|allowed values/u;
      }else if(scenario==='uppercase-skill-key'){
        output.name='Uppercase';diagnostic=/name|lowercase/u;
      }else{
        output.name='different-name';diagnostic=/name|identity/u;
      }
      await fs.writeJson(path.join(target,'.agents-plugin','plugin.json'),input);
      await fs.writeFile(path.join(target,'scripts','render.mjs'),renderer(output));
      if(scenario==='unresolved-declared-template') {
        const failure=await runValidatePlugin(target,['--json']).then(()=>null,(cause:unknown)=>cause as {stdout:string;stderr:string});
        expect(failure).not.toBeNull();
        const receipt=JSON.parse(failure!.stdout);
        expect(receipt).toMatchObject({ok:false,versionCheck:null});
        expect(receipt.errors.join('\n')).toMatch(diagnostic!);
        expect(failure!.stderr).toBe('');
      } else if(diagnostic) await expect(runValidatePlugin(target,['--json'])).rejects.toMatchObject({stdout:expect.stringMatching(diagnostic)});
      else {
        const literal=JSON.parse((await runValidatePlugin(target,['--json'])).stdout);
        expect(literal).toMatchObject({ok:true,errors:[],versionCheck:{checks:[{status:'unreleasedChanges',productionChanged:true}]}});
        const consumer=await readPluginManifest(target);
        const provider=await readPluginManifest(path.join(root,'plugins','portable-provider'));
        const outputRoot=path.join(root,'literal-bundle');
        await bundleLocalPlugin(consumer,outputRoot,{runtimeResolver:createCatalogRuntimeImportResolver([provider,consumer])});
        const runtime=scenario==='literal-runtime-text'
          ? path.join(outputRoot,'generic/skills/portable-static/references/runtime.txt')
          : path.join(outputRoot,'.agents-plugin/runtime-imports/runtime');
        await expect(fs.readFile(runtime,'utf8')).resolves.toBe(
          scenario==='literal-runtime-text'?'{{literal-runtime}}\n':'{{literal-provider-runtime}}\n');
      }
    });
  });

  it('validates managed command renderer candidates without registering commands', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-managed-'));
    tempDirs.push(tempRoot);
    const trace = path.join(tempRoot, 'requests.jsonl');
    const manifest = createBaseManifest('managed-author', {
      skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      managedCommands: {
        packages: [{ key: 'tools', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './tools', render: true }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic', refreshKeys: [] }],
      },
    });
    const renderer = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'if (c.surface.kind !== "aw" || c.surface.name !== "managed-commands" || c.platform || c.distribution) throw new Error("wrong surface");',
      'if (process.env.AW_PLUGIN_SURFACE !== "managed-commands" || process.env.AW_PLUGIN_PLATFORM || process.env.AW_PLUGIN_DISTRIBUTION) throw new Error("wrong environment");',
      'if (c.commandSources.length !== 1 || c.commandSources[0].packageKey !== "tools" || !path.isAbsolute(c.commandSources[0].sourceDir)) throw new Error("wrong command source");',
      'if (c.artifactSources.length || Object.keys(c.config.values).length) throw new Error("unrelated inputs");',
      `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(c.requestedArtifactIds)+"\\n");`,
      'const artifacts = c.requestedArtifactIds.map(id => id === "command-package.tools"',
      '  ? {id,target:"aw.command-package",kind:"commandPackage",state:"present",refreshKeys:[],files:{"settings.json":"{}"}}',
      '  : {id,target:"aw.command-set",kind:"commandSet",state:"present",refreshKeys:[],entries:[{key:"run",runner:"node",entry:"run.mjs"}]});',
      'process.stdout.write(JSON.stringify({version:2,artifacts}));',
    ].join('\n');
    const { pluginDir } = await writeSourcePlugin(tempRoot, 'managed-author', manifest, {
      'scripts/render.mjs': renderer,
      'tools/run.mjs': 'console.log("ready");\n',
      'skills/helper/SKILL.md': '---\nname: helper\ndescription: Runs the managed helper.\n---\n{{aw.command:tools/run}} check\n',
      'skills/helper/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
    });
    const commandRoot = path.join(process.env.AW_HOME!, 'commands');
    const before = await fs.pathExists(commandRoot);
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({ stdout: expect.stringContaining('[PASS]') });
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await fs.pathExists(commandRoot)).toBe(before);

    for (const [modified, expected] of [
      [renderer.replace('"settings.json":"{}"', '"run.mjs":"changed"'), 'cannot replace'],
      [renderer.replace('kind:"commandSet",state:', 'platform:"codex",kind:"commandSet",state:'), 'Invalid artifacts[1].platform: must match the command request.'],
      [renderer.replace('process.stdout.write(JSON.stringify({version:2,artifacts}))', 'process.stdout.write(JSON.stringify({version:2,artifacts:artifacts.slice(0,1)}))'), 'missing requested artifact \"command-set.tools\"'],
    ]) {
      await fs.writeFile(path.join(pluginDir, 'scripts/render.mjs'), modified);
      await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({ stdout: expect.stringContaining(expected) });
      expect(await fs.pathExists(commandRoot)).toBe(before);
    }
    await fs.writeFile(path.join(pluginDir, 'scripts/render.mjs'), renderer.replace('key:"run",runner:', 'key:"other",runner:'));
    const unavailable=JSON.parse((await runValidatePlugin(pluginDir,['--json'])).stdout);
    expect(unavailable).toMatchObject({ok:true,errors:[]});
    // The public validator uses the production profile. On unqualified hosts,
    // the capability gate precedes managed command dependency resolution.
    const expectedGap = process.platform === 'darwin' && process.arch === 'arm64'
      ? '[dependency-unmet] []'
      : '[capability-unverified] [{"feature":"component.kind.skill"}]';
    expect(unavailable.warnings).toContain(`component unmet (codex/user): skill:helper ${expectedGap}`);
    expect(await fs.pathExists(commandRoot)).toBe(before);
    await fs.writeFile(path.join(pluginDir, 'scripts/render.mjs'), renderer);
    await writeAuthoringPluginManifest(pluginDir, {
      ...manifest,
      platforms: ['codex', 'claude', 'generic'],
    });
    await fs.outputFile(path.join(pluginDir, 'skills/helper/SKILL.md'),
      '---\nname: helper\ndescription: Runs the managed helper.\n---\n{{aw.command:tools/run}} check\n');
    await fs.outputFile(path.join(pluginDir, 'skills/helper/README.md'), '# Helper\n');
    await expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({ stdout: expect.stringContaining('Generic Skills cannot bind native') });
  });

  // Test Value Gate: the source validator must generate only the declared native reader
  // in its temporary package candidate, without hiding other missing runtime imports.
  it('validates an uncommitted native reader in the managed package candidate without writing to source', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-native-reader-'));
    tempDirs.push(tempRoot);
    const protocol = nativeToolFixture().closure.definitions[0]!.protocol;
    const manifest = createBaseManifest('native-reader-author', {
      requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.native-tools.v2'] } },
      nativeTools: {
        reader: './command/native-reader.mjs',
        definitions: [{ key: 'job', protocol }],
        consumers: [{ kind: 'managed-command-set', key: 'tools', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] }],
      },
      managedCommands: {
        packages: [{ key: 'command', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './command' }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'command' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'entry.mjs' }] }],
      },
    });
    const entry = 'import { readNativeTool } from "./native-reader.mjs";\nexport { readNativeTool };\n';
    const { pluginDir } = await writeSourcePlugin(tempRoot, 'native-reader-author', manifest, {
      'command/entry.mjs': entry,
    });
    await expect(runValidatePlugin(pluginDir, ['--json'])).resolves.toMatchObject({ stdout: expect.stringContaining('"ok": true') });
    expect(await fs.readdir(path.join(pluginDir, 'command'))).toEqual(['entry.mjs']);
    expect(await fs.readFile(path.join(pluginDir, 'command/entry.mjs'), 'utf8')).toBe(entry);
    await fs.appendFile(path.join(pluginDir, 'command/entry.mjs'), 'import "./missing.mjs";\n');
    await expect(runValidatePlugin(pluginDir, ['--json'])).rejects.toMatchObject({ stdout: expect.stringContaining('Unable to resolve relative import \\"./missing.mjs\\"') });
    expect(await fs.readdir(path.join(pluginDir, 'command'))).toEqual(['entry.mjs']);
  });

  // Test Value Gate: shared native commands must stay user-scoped while project
  // consumers can resolve them and retain their separate AW-owned command scope.
  it('retains shared Claude user-scope command capability gaps without registering unavailable producers', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aw-author-claude-shared-'));
    tempDirs.push(root);
    const trace=path.join(root,'requests.jsonl');
    const fixture=await writeSourcePlugin(root,'claude-shared-author',createBaseManifest('claude-shared-author',{
      platforms:['claude'],skills:'./skills',requires:{aw:{capabilities:['aw.managed-commands.v1']}},
      artifacts:{configKeys:[]},scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
      managedCommands:{packages:[{key:'project-tools',scope:'project',platforms:['claude'],sourceDir:'./project-tools'}],sets:[
        {set:'native',producer:{kind:'static-skill',platform:'claude',skillKey:'native-helper'},mode:'dynamic',refreshKeys:[]},
        {set:'scoped',producer:{kind:'artifact',platform:'claude',artifactId:'scoped-skill'},mode:'dynamic',refreshKeys:[]},
        {set:'project-tools',producer:{kind:'package',packageKey:'project-tools'},mode:'static',entries:[{key:'run',runner:'node',entry:'run.mjs'}]},
      ]},extensions:{permissions:[{name:'shared-native',allow:[{command:{set:'native',key:'run',variant:'default'}}]}]},
    }),{
      'skills/native-helper/SKILL.md':'---\nname: native-helper\ndescription: Shared native commands.\n---\n{{aw.command:native/run}}\n',
      'skills/native-helper/scripts/run.mjs':'console.log("native");\n',
      'project-tools/run.mjs':'console.log("project");\n',
      'scripts/render.mjs':[
        "import fs from 'node:fs';",
        "const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({surface:c.surface,scope:c.scope})+'\\n');`,
        'if(c.surface!=="agent-plugin" || c.scope!=="user") throw new Error("unavailable shared commands must not run");',
        'console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:c.allowedOutputKinds.includes("skill")?[{id:"scoped-skill",kind:"skill",name:"scoped-helper",requiredFeatures:[{feature:"component.kind.skill"}],reasonCode:"capability-unverified"}]:[]}));',
      ].join('\n'),
    });
    const result=await runValidatePlugin(fixture.pluginDir).catch((cause:unknown)=>{
      const failure=cause as {stdout?:string;stderr?:string};
      throw new Error(`Controlled Claude author fixture failed. stdout=${failure.stdout ?? ''} stderr=${failure.stderr ?? ''}`);
    });
    expect(result.stdout).toContain('[PASS]');
    expect(result.stdout).toContain('component unmet (claude/user)');
    const calls=(await fs.readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call=>call.surface==='agent-plugin' && call.scope==='user')).toBe(true);
    // The shared-user rejection of project packages with available producers is exercised
    // through the actual command preparation boundary in skill-materialization.test.ts.
    // A fixed profile with no usable producer must retain that capability gap here.
    await fs.appendFile(path.join(fixture.pluginDir,'skills/native-helper/SKILL.md'),'{{aw.command:project-tools/run}}\n');
    await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({stdout:expect.stringContaining('component unmet (claude/user)')});
  });


  it('validate_plugin.mjs isolates the dynamic artifact renderer fixture environment', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-artifact-env-'));
    tempDirs.push(tempRoot);
    const { pluginDir } = await writeDynamicArtifactPlugin(tempRoot);
    const rendererPath = path.join(pluginDir, 'scripts', 'render-artifacts.mjs');
    const rendererHomeProbesPath = path.join(tempRoot, 'renderer-home-probes.jsonl');
    const renderer = await fs.readFile(rendererPath, 'utf8');
    await fs.writeFile(
      rendererPath,
      [
        'if (process.env.AW_VALIDATOR_SECRET_SENTINEL) throw new Error("parent secret leaked");',
        'if (!process.env.AW_PLUGIN_CONTEXT) throw new Error("missing renderer context");',
        'if (process.env.AW_PLUGIN_NAME !== "dynamic-authoring-test") throw new Error("missing plugin identity");',
        'if (process.env.AW_PLUGIN_EVENT !== "materialize") throw new Error("missing fixture event");',
        'const fs = await import("node:fs");',
        'const path = await import("node:path");',
        'if (process.env.AW_CODEX_HOME || process.env.AW_CLAUDE_HOME) throw new Error("test home variable leaked");',
        'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'if (context.schemaVersion !== 1 || context.surface !== "agent-plugin" || Object.hasOwn(context, "paths")) throw new Error("wrong public renderer context");',
        'if (!process.env.HOME || process.env.HOME !== process.env.USERPROFILE) throw new Error("missing isolated user home");',
        'const rendererHomes = [process.env.AW_HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.HOME, ...["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"].map((key) => process.env[key])];',
        'if (rendererHomes.some((home) => !home || !path.isAbsolute(home))) throw new Error("missing isolated state home");',
        'for (const rendererHome of rendererHomes) fs.mkdirSync(rendererHome, { recursive: true });',
        'for (const rendererHome of rendererHomes) fs.writeFileSync(path.join(rendererHome, "probe"), "probe");',
        `fs.appendFileSync(${JSON.stringify(rendererHomeProbesPath)}, JSON.stringify(rendererHomes) + "\\n");`,
        'if (!context.config.schema || !context.config.sources) throw new Error("missing config schema or sources");',
        'if (context.config.values.explorerModel !== "gpt-5.4-mini") throw new Error("missing config values");',
        'if (context.renderConfig || context.artifactRenderConfig) throw new Error("validator-only context alias");',
        renderer,
      ].join('\n'),
      'utf8',
    );

    const parentEnv = {
      ...process.env,
      AW_VALIDATOR_SECRET_SENTINEL: 'must-not-reach-renderer',
      ...Object.fromEntries([
        'AW_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME',
        'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
        'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
      ].map((key) => [key, path.join(tempRoot, 'parent', key)])),
    };
    await expect(runValidatePlugin(pluginDir, [], parentEnv)).resolves.toMatchObject({
      stdout: expect.stringContaining('[PASS] All checks passed.'),
    });
    const rendererHomes = (await fs.readFile(rendererHomeProbesPath, 'utf8'))
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line) as string[]);
    const actualHomes = [
      os.homedir(),
      ...Object.values(parentEnv),
    ].filter((home): home is string => typeof home === 'string' && home !== '');
    expect(rendererHomes).not.toHaveLength(0);
    for (const rendererHome of rendererHomes) {
      expect(actualHomes).not.toContain(rendererHome);
      expect(await fs.pathExists(rendererHome)).toBe(false);
    }
  });

  it('validate_plugin.mjs supplies compiled v3 fields and inherited defaults to renderer fixtures', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-config-v3-'));
    tempDirs.push(tempRoot);
    const { pluginDir, manifestPath } = await writeDynamicArtifactPlugin(tempRoot);
    const manifest = await fs.readJson(manifestPath);
    manifest.config = { schemaVersion: 3, definitions: {
      model: { type: 'string', default: 'gpt-5.4-mini', validation: { minLength: 1 } },
    }, fields: { enableInstruction: { type: 'boolean', default: true }, explorerModel: { $ref: '#/config/definitions/model' } } };
    await fs.writeJson(manifestPath, manifest);
    const rendererPath = path.join(pluginDir, 'scripts', 'render-artifacts.mjs');
    const renderer = await fs.readFile(rendererPath, 'utf8');
    await fs.writeFile(rendererPath, [
      'const context = JSON.parse((await import("node:fs")).readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const field = context.config.schema.fields.explorerModel;',
      'if (field.$ref || field.type !== "string" || field.validation.minLength !== 1) throw new Error("config schema was not compiled");',
      'if (context.config.values.explorerModel !== "gpt-5.4-mini") throw new Error("definition default was lost");',
      renderer,
    ].join('\n'));
    await expect(runValidatePlugin(pluginDir)).resolves.toMatchObject({ stdout: expect.stringContaining('[PASS] All checks passed.') });
  });

  it('validate_plugin.mjs supplies an empty public config schema when the manifest has none', async () => {
    const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'aw-no-config-renderer-'));
    tempDirs.push(tempRoot);
    const fixture=await writeSourcePlugin(tempRoot,'no-config-renderer',createBaseManifest('no-config-renderer',{
      platforms:['generic'],artifacts:{configKeys:[]},scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
    }),{'scripts/render.mjs':[
      "import fs from 'node:fs';",
      "const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      'if(Object.keys(c.config.schema.fields).length || Object.keys(c.config.values).length || Object.keys(c.config.sources).length) throw new Error("unexpected config input");',
      'console.log(JSON.stringify({version:3,components:[{id:"no-config-renderer",kind:"skill",name:"no-config-renderer",content:{files:{"SKILL.md":{text:"---\\nname: no-config-renderer\\ndescription: Render without config.\\n---\\n"},"README.md":{text:"# No config\\n"}}}}],omitted:[],unmet:[]}));',
    ].join('\n')});
    await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({stdout:expect.stringContaining('[PASS]')});
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

  it('validate_plugin.mjs validates fixed profiles and dynamic resource closure', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-artifact-platforms-'));
    tempDirs.push(tempRoot);
    for (const platforms of [null, [], ['claude']] as const) {
      const fixture = await writeDynamicArtifactPlugin(path.join(tempRoot, `platforms-${JSON.stringify(platforms)}`),
        { platforms: platforms === null ? null : [...platforms] });
      if (platforms === null) {
        const manifest = await fs.readJson(fixture.manifestPath);
        delete manifest.platforms;
        await fs.writeJson(fixture.manifestPath, manifest);
      }
      await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({
        stdout: expect.stringContaining('[PASS] All checks passed.'),
      });
    }
    const manifest = createBaseManifest('resource-closure', { platforms: ['generic'],
      artifacts: { configKeys: [], sourceDirs: ['./templates'] },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    });
    const component = { id: 'computed', kind: 'skill', name: 'computed', content: { files: {
      'SKILL.md': { source: { kind: 'bundle', path: 'templates/SKILL.md' } },
      'README.md': { source: { kind: 'bundle', path: 'templates/README.md' } },
      'references/runtime.md': { text: 'Runtime content.\n' },
      'assets/icon.bin': { source: { kind: 'bundle', path: 'templates/icon.bin' } },
    } } };
    const renderer = (components: unknown[]) => `process.stdout.write(JSON.stringify(${JSON.stringify({version:3,components,omitted:[],unmet:[]})}));\n`;
    const fixture = await writeSourcePlugin(tempRoot, 'resource-closure', manifest, {
      'templates/SKILL.md': '---\nname: computed\ndescription: Resource closure.\n---\nRead references/runtime.md.\n',
      'templates/README.md': '# Computed\n',
      'templates/icon.bin': 'binary-placeholder',
      'scripts/render.mjs': renderer([component]),
    });
    await fs.writeFile(path.join(fixture.pluginDir, 'templates/icon.bin'), Buffer.from([0,255,1]));
    await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({ stdout: expect.stringContaining('[PASS]') });
    const variants = ['duplicate-source','noncanonical-reference','missing-skill','path-collision',
      'missing-skill-entry','author-only-output','runtime-evals-source','symlink-source','duplicate-owner','wrong-skill-name'] as const;
    await mapWithConcurrency(variants, 2, async (variant) => {
      const root = path.join(tempRoot, 'variants', variant, 'resource-closure');
      await fs.copy(fixture.pluginDir, root);
      const input = structuredClone(manifest) as typeof manifest & { artifacts: {configKeys:string[];sourceDirs:string[]} };
      const output = structuredClone(component) as {id:string;kind:string;name:string;content:{files:Record<string,unknown>}};
      let expected: RegExp | null = null;
      if (variant === 'duplicate-source') {
        input.artifacts.sourceDirs = ['./templates','./templates']; expected = /duplicate/u;
      } else if (variant === 'noncanonical-reference') {
        output.content.files['SKILL.md'] = {source:{kind:'bundle',path:'templates/../templates/SKILL.md'}}; expected = /path|relative|canonical|\.\./u;
      } else if (variant === 'missing-skill') {
        await fs.remove(path.join(root, 'templates/SKILL.md')); expected = /SKILL\.md|ENOENT|missing/u;
      } else if (variant === 'path-collision') {
        output.content.files.references = {text:'A file cannot also be a directory.\n'}; expected = /EEXIST.*references/u;
      } else if (variant === 'missing-skill-entry') {
        delete output.content.files['SKILL.md']; expected = /SKILL\.md/u;
      } else if (variant === 'author-only-output') {
        await fs.outputFile(path.join(root, 'templates/private.md'), 'Author-only output.\n');
        output.content.files['evals/private.md'] = {source:{kind:'bundle',path:'templates/private.md'}};
        expected = /author-only|evals|reserved/u;
      } else if (variant === 'runtime-evals-source') {
        await fs.outputFile(path.join(root, 'templates/references/evals/contract.md'), 'Runtime eval contract.\n');
        output.content.files['references/evals/contract.md'] = {source:{kind:'bundle',path:'templates/references/evals/contract.md'}};
      } else if (variant === 'symlink-source') {
        await fs.symlink('.', path.join(root, 'templates/source-link'));
        input.artifacts.sourceDirs = ['./templates/source-link']; expected = /symbolic link|symlink/u;
      } else if (variant === 'duplicate-owner') {
        expected = /duplicate component name/u;
      } else {
        await fs.writeFile(path.join(root, 'templates/SKILL.md'), '---\nname: wrong\ndescription: Wrong identity.\n---\n');
        expected = /name|identity/u;
      }
      await fs.writeJson(path.join(root, '.agents-plugin/plugin.json'), input);
      const components = variant === 'duplicate-owner' ? [output,{...output,id:'duplicate'}] : [output];
      await fs.writeFile(path.join(root, 'scripts/render.mjs'), renderer(components));
      if (expected) await expect(runValidatePlugin(root)).rejects.toMatchObject({stdout:expect.stringMatching(expected)});
      else await expect(runValidatePlugin(root)).resolves.toMatchObject({stdout:expect.stringContaining('[PASS]')});
    });
  });

  it('validate_plugin.mjs uses production component batches and excludes sensitive Skill inputs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-renderer-partitions-'));
    tempDirs.push(tempRoot);
    const trace = path.join(tempRoot, 'requests.jsonl');
    const secret = 'partition-only-secret-value';
    const fixture = await writeSourcePlugin(tempRoot, 'renderer-partitions', createBaseManifest('renderer-partitions', {
      platforms:['codex'],
      config:{fields:{nativeMode:{type:'string',default:'native-default'},otherMode:{type:'string',default:'other-default'},secret:{type:'string',sensitive:true}}},
      artifacts:{configKeys:['nativeMode','otherMode','secret'],sourceDirs:['./templates']},
      scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
    }), {
      'templates/input.md':'Declared resource.\n',
      'scripts/render.mjs':[
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({scope:c.scope,kinds:c.allowedOutputKinds,schemaKeys:Object.keys(c.config.schema.fields),valueKeys:Object.keys(c.config.values),previousComponents:c.previousComponents,resources:c.resources.map(resource=>({kind:resource.kind,exists:fs.existsSync(resource.root)})),awHome:process.env.AW_HOME})+'\\n');`,
        'if (c.surface !== "agent-plugin" || c.platformCapabilities.basis !== "profile") throw new Error("wrong context");',
        'const components = [], unmet = [];',
        'if (c.allowedOutputKinds.includes("skill")) {',
        ' if (Object.hasOwn(c.config.schema.fields,"secret") || Object.hasOwn(c.config.values,"secret")) throw new Error("sensitive Skill input");',
        ' if (c.scope !== "user") throw new Error("shared Skill scope drift");',
        ' for (const id of ["native-shared","other-shared"]) {',
        '  if(c.platformCapabilities.kinds.skill.status!=="supported") unmet.push({id,kind:"skill",name:id,requiredFeatures:[{feature:"component.kind.skill"}],reasonCode:"capability-unverified"});',
        '  else components.push({id,kind:"skill",name:id,content:{files:{"SKILL.md":{text:`---\\nname: ${id}\\ndescription: Shared Skill.\\n---\\n`},"README.md":{text:`# ${id}\\n`}}}});',
        ' }',
        '}',
        'if (c.allowedOutputKinds.includes("agent")) unmet.push({id:"unavailable-role",kind:"agent",requiredFeatures:[{feature:"component.kind.agent"}],reasonCode:"capability-unverified"});',
        'process.stdout.write(JSON.stringify({version:3,components,omitted:[],unmet}));',
      ].join('\n'),
    });
    await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({stdout:expect.stringContaining('[PASS]')});
    const calls = (await fs.readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls.some(call=>call.kinds.includes('skill'))).toBe(true);
    expect(calls.some(call=>!call.kinds.includes('skill'))).toBe(true);
    for (const call of calls) {
      const expectedKeys = call.kinds.includes('skill') ? ['nativeMode','otherMode'] : ['nativeMode','otherMode','secret'];
      expect([...call.schemaKeys].sort()).toEqual(expectedKeys);
      expect([...call.valueKeys].sort()).toEqual(['nativeMode','otherMode']);
      expect(call.previousComponents).toEqual([]);
      expect(call.resources).toEqual([{kind:'bundle',exists:true}]);
      expect(call.awHome).not.toBe(process.env.AW_HOME);
      expect(await fs.pathExists(call.awHome)).toBe(false);
    }
    // A renderer cannot escape its kind batch even when its JSON is structurally valid.
    await fs.writeFile(path.join(fixture.pluginDir,'scripts/render.mjs'),
      'console.log(JSON.stringify({version:3,components:[{id:"wrong-kind",kind:"agent",name:"wrong-kind",content:{description:"Wrong batch.",prompt:"Read only."}}],omitted:[],unmet:[]}));\n');
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('outside allowedOutputKinds')});
    const leaked = {id:'leaked',kind:'skill',name:'leaked',content:{files:{
      'SKILL.md':{text:`---\nname: leaked\ndescription: A leak.\n---\n${secret}\n`},'README.md':{text:'# Leak\n'},
    }}};
    await fs.writeFile(path.join(fixture.pluginDir,'scripts/render.mjs'), [
      "import fs from 'node:fs';",
      "const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[${JSON.stringify(leaked)}]:[],omitted:[],unmet:[]}));`,
    ].join('\n'));
    // Source validation uses author defaults; sensitive fields cannot have defaults.
    // Exercise a real configured value through the same candidate's store/resolve/prepare path.
    const distUrl=(file:string)=>pathToFileURL(path.join(repoRoot(),'packages/cli/dist/src',file)).href;
    const [candidateRenderer,candidateConfig,candidateProfiles,candidateDigests]=await Promise.all([
      import(distUrl('utils/artifact-renderer.js')) as Promise<typeof import('../../src/utils/artifact-renderer.js')>,
      import(distUrl('utils/plugin-config.js')) as Promise<typeof import('../../src/utils/plugin-config.js')>,
      import(distUrl('review/platform-profile.js')) as Promise<typeof import('../../src/review/platform-profile.js')>,
      import(distUrl('utils/catalog-digests.js')) as Promise<typeof import('../../src/utils/catalog-digests.js')>,
    ]);
    const plugin={...await readPluginManifest(fixture.pluginDir),sourceId:'fixture',
      sourceIdentity:await candidateDigests.calculateCatalogEntryArtifactDigest(fixture.pluginDir)};
    const configOptions={sourceId:plugin.sourceId,sourceIdentity:plugin.sourceIdentity,pluginName:plugin.manifest.name,
      scope:'user' as const,platform:'codex' as const,cwd:tempRoot,env:process.env};
    await candidateConfig.writePluginConfigStore({...configOptions,values:{secret}});
    const config=await candidateRenderer.resolveArtifactRenderConfig({...configOptions,manifest:plugin.manifest});
    expect(config.values.secret).toBe(secret);
    expect(config.sources.secret).toBe('platform');
    // This explicit lower-boundary fact tests resource scanning, not client qualification.
    const capabilities=candidateProfiles.getAuthoringPlatformCapabilities('codex','user');
    capabilities.profileId='authoring-sensitive-fixture';
    capabilities.kinds.skill={status:'supported',reasonCodes:[],delivery:['native-package']};
    const failure=await candidateRenderer.preparePlatformComponents({plugin,platform:'codex',renderScope:'user',
      kinds:['skill','agent'],capabilities,
      config,cwd:tempRoot,commandEnv:process.env}).then(()=>null,(error:unknown)=>error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/sensitive/iu);
    expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain(secret);
  });

  it('validate_plugin.mjs rejects conflicting static and dynamic Skill identities', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(),'aw-native-dynamic-contract-'));
    tempDirs.push(tempRoot);
    const fixture = await writeSourcePlugin(tempRoot,'native-dynamic-contract',createBaseManifest('native-dynamic-contract',{
      platforms:['generic'],skills:'./skills',artifacts:{configKeys:[]},
      scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
    }),{
      'skills/review/SKILL.md':'---\nname: review\ndescription: Review.\n---\nRead only.\n',
      'scripts/render.mjs':'console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));\n',
    });
    const component = {id:'dynamic-review',kind:'skill',name:'review',content:{files:{
      'SKILL.md':{text:'---\nname: review\ndescription: Review.\n---\n'},'README.md':{text:'# Review\n'},
    }}};
    const writePlan = (components:unknown[])=>fs.writeFile(path.join(fixture.pluginDir,'scripts/render.mjs'),
      `console.log(JSON.stringify(${JSON.stringify({version:3,components,omitted:[],unmet:[]})}));\n`);
    await writePlan([component]);
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringMatching(/duplicate|conflict/u)});
    const manifest = await fs.readJson(fixture.manifestPath);
    delete manifest.skills;
    await fs.writeJson(fixture.manifestPath,manifest);
    await fs.remove(path.join(fixture.pluginDir,'skills'));
    await writePlan([component,{...component,id:'other-review'}]);
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('duplicate component name')});
    await writePlan([component,{...component,name:'other-review'}]);
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('duplicate component ID')});
  });

  it('accepts shared user Skills when a common Hook explicitly disables Codex', async () => {
    const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'aw-codex-null-hook-authoring-'));
    tempDirs.push(tempRoot);
    const fixture=await writeSourcePlugin(tempRoot,'codex-null-hook-authoring',createBaseManifest('codex-null-hook-authoring',{
      platforms:['codex','claude'],skills:'./skills',
      extensions:{hooks:[{id:'claude-only',event:'before_tool',feedback:'notify',matcher:'*',command:'echo claude only',agentOverrides:{codex:null}}]},
      artifacts:{configKeys:[],scopes:['user']},scripts:{artifacts:{render:{runner:'node',path:'./scripts/render.mjs'}}},
    }),{
      'skills/user-native/SKILL.md':'---\nname: user-native\ndescription: User native Skill.\n---\nRead the fixture.\n',
      'skills/user-native/agents/openai.yaml':'policy:\n  allow_implicit_invocation: true\n',
      'scripts/render.mjs':'console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));\n',
    });
    await expect(readPluginManifest(fixture.pluginDir)).resolves.toMatchObject({manifest:{name:'codex-null-hook-authoring'}});
    await expect(runValidatePlugin(fixture.pluginDir)).resolves.toMatchObject({stdout:expect.stringContaining('[PASS]')});
  });

  it('validate_plugin.mjs rejects invalid computed Agent names and malformed Codex invocation policy', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-role-'));
    tempDirs.push(tempRoot);

    const roleValidations: Array<() => Promise<unknown>> = [
      () => writeDynamicArtifactPlugin(
        path.join(tempRoot, 'missing-role'),
        { includeRoleKey: false },
      ).then(({ pluginDir }) => expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringContaining('name'),
      })),
      () => writeDynamicArtifactPlugin(
        path.join(tempRoot, 'mismatched-role'),
        { rendererRoleKey: '../outside' },
      ).then(({ pluginDir }) => expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringContaining('name'),
      })),
      () => writeDynamicArtifactPlugin(
        path.join(tempRoot, 'missing-policy'),
        { omitCodexInvocationPolicy: true },
      ).then(({ pluginDir }) => expect(runValidatePlugin(pluginDir)).rejects.toMatchObject({
        stdout: expect.stringContaining('[missing-policy]'),
      })),
    ];
    await mapWithConcurrency(roleValidations, 2, (validation) => validation());
  });

  it('validate_plugin.mjs accepts native hooks and rejects hook contract mistakes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-hooks-authoring-'));
    tempDirs.push(tempRoot);

    const scriptPath = validatePluginScriptPath();
    const pluginDir = await writeManifestOnlyPlugin(tempRoot, 'native-hook-demo', {
      hooks: [
        { id: 'fixture-hook-1', feedback: 'notify',
          event: 'session_start',
          command: 'echo portable start',
        },
      ],
      nativeHooks: {
        claude: [
          { id: 'fixture-hook-2', feedback: 'notify',
            event: 'SessionStart',
            matcher: 'compact',
            command: 'echo claude compact',
          },
          { id: 'fixture-hook-3', feedback: 'notify',
            event: 'Stop',
            command: 'echo claude stop',
          },
        ],
        codex: [
          { id: 'fixture-hook-4', feedback: 'notify',
            event: 'UserPromptSubmit',
            command: 'echo codex prompt',
          },
          { id: 'fixture-hook-5', feedback: 'notify',
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
              { id: 'fixture-hook-6', feedback: 'notify',
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
      stdout: expect.stringContaining('/extensions/nativeHooks/codex/0/event'),
    });

    await fs.writeJson(
      manifestPath,
      {
        ...validManifest,
        extensions: {
          nativeHooks: {
            codex: [
              { id: 'fixture-hook-7', feedback: 'notify',
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
            { id: 'fixture-hook-8', feedback: 'notify',
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
      stdout: expect.stringContaining('/extensions/hooks/0/event'),
    });
  });

  it('validate_plugin.mjs enforces platform-scoped authoring contracts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-platform-conflicts-'));
    tempDirs.push(tempRoot);

    const cases: Array<{
      name: string;
      platforms: string[];
      extra: Record<string, unknown>;
      files?: Record<string, string | Record<string, unknown>>;
      expected?: string;
    }> = [
      {
        name: 'codex-only-file-rules',
        platforms: ['codex'],
        extra: {
          buildConfig: {
            fileRules: {
              claude: {
                include: ['skills/**'],
                exclude: [],
              },
            },
          },
        },
        expected: 'buildConfig.fileRules.claude requires claude support',
      },
      {
        name: 'claude-only-manifest-overrides',
        platforms: ['claude'],
        extra: {
          buildConfig: {
            manifestOverrides: {
              codex: {},
            },
          },
        },
        expected: 'additional properties',
      },
      {
        name: 'claude-only-apps',
        platforms: ['claude'],
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
        expected: 'additional properties',
      },
      {
        name: 'claude-only-native-hooks',
        platforms: ['claude'],
        extra: {
          extensions: {
            nativeHooks: {
              codex: [
                { id: 'fixture-hook-9', feedback: 'notify',
                  event: 'Stop',
                  command: 'echo codex stop',
                },
              ],
            },
          },
        },
        expected: 'extensions.nativeHooks.codex requires codex support',
      },
      {
        name: 'claude-only-agent-overrides',
        platforms: ['claude'],
        extra: {
          extensions: {
            hooks: [
              { id: 'fixture-hook-10', feedback: 'notify',
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
        expected: 'extensions.hooks[0].agentOverrides.codex requires codex support',
      },
      {
        name: 'claude-only-null-agent-overrides',
        platforms: ['claude'],
        extra: {
          extensions: {
            hooks: [
              { id: 'fixture-hook-11', feedback: 'notify',
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

    await mapWithConcurrency(cases, 2, async (testCase) => {
      const { pluginDir } = await writeSourcePlugin(
        tempRoot,
        testCase.name,
        createBaseManifest(testCase.name, {
          platforms: testCase.platforms,
          marketplace: {
            category: 'workflow',
            strict: true,
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',

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
    });
  });

  it('validate_plugin.mjs rejects the removed slashCommands declaration before executing author scripts', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aw-removed-slash-commands-'));
    tempDirs.push(root);
    const marker=path.join(root,'executed');
    const fixture=await writeSlashCommandPlugin(root,{name:'removed-slash',platforms:['codex'],
      commandContent:'---\ndescription: Historical standalone command.\n---\nReview the repository.\n'});
    const manifest=await fs.readJson(fixture.manifestPath);
    manifest.scripts={node:{build:{runner:'node',path:'./build.mjs'}}};
    await fs.writeJson(fixture.manifestPath,manifest);
    await fs.outputFile(path.join(fixture.pluginDir,'build.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('additional properties')});
    expect(await fs.pathExists(marker)).toBe(false);
  });

  it('validate_plugin.mjs rejects removed slashCommands for every explicit platform profile', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aw-removed-slash-platforms-'));
    tempDirs.push(root);
    for(const platforms of [['codex'],['claude'],['generic'],['codex','claude']]){
      const fixture=await writeSlashCommandPlugin(path.join(root,platforms.join('-')),{name:'removed-command',platforms,
        commandContent:'---\ndescription: Historical command.\n---\nUse $ARGUMENTS.\n'});
      await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('additional properties')});
    }
  });

  it('validate_plugin.mjs preserves removed command bytes while rejecting the declaration', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aw-removed-slash-frontmatter-'));
    tempDirs.push(root);
    const fixture=await writeSlashCommandPlugin(root,{name:'removed-frontmatter',platforms:['codex'],
      commandContent:'---\r\ndescription: Historical bytes.\r\nclaude:\r\n  shell: fish\r\n---\r\nReview.\r\n'});
    const command=path.join(fixture.pluginDir,'slash-commands','review.md');
    const before=await fs.readFile(command);
    await expect(runValidatePlugin(fixture.pluginDir)).rejects.toMatchObject({stdout:expect.stringContaining('additional properties')});
    expect(await fs.readFile(command)).toEqual(before);
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

  it('validate_plugin.mjs validates canonical platforms and registry marketplace policy values', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-products-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'manifest-products-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), withManifestSchema({
      name: 'manifest-products-test',
      version: '0.1.0',
      description: 'Test plugin for manifest product checks.',
      platforms: ['codex', 'browser'],
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',

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
      stdout: expect.stringContaining('/platforms/1'),
    });

    const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.platforms = ['codex', 'claude'];
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
      platforms: ['codex', 'claude'],
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
      platforms: ['claude'],
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',

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
        'user-invocable: "sometimes"',
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
    const currentSource=await execFileAsync('node',[scriptPath,pluginDir],{
      cwd:repoRoot(),env:process.env,maxBuffer:10*1024*1024,
    });
    expect(currentSource.stdout).toContain('[PASS] All checks passed.');
    expect(currentSource.stdout).toContain('component unmet');
    expect(currentSource.stdout).toContain('skill.background');
    let minimumProfileStdout = '';
    try {
      await execFileAsync('node', [scriptPath, pluginDir, '--claude-skill-profile', 'minimum'], {
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

    const profileManifestPath=path.join(pluginDir,'.agents-plugin/plugin.json');
    const profileManifest=await fs.readJson(profileManifestPath);
    await fs.writeJson(profileManifestPath,{...profileManifest,buildConfig:{templates:{include:['skills/**/*.md'],vars:{}}}});
    await expect(execFileAsync('node',[scriptPath,pluginDir,'--claude-skill-profile','minimum'],{
      cwd:repoRoot(),env:process.env,maxBuffer:10*1024*1024,
    })).rejects.toMatchObject({stdout:expect.stringContaining('[known-field-not-supported-by-target-version] field "background"')});
    await fs.writeJson(profileManifestPath,{...profileManifest,platforms:['codex']});
    await expect(execFileAsync('node',[scriptPath,pluginDir,'--claude-skill-profile','minimum'],{
      cwd:repoRoot(),env:process.env,maxBuffer:10*1024*1024,
    })).resolves.toMatchObject({stdout:expect.stringContaining('[PASS] All checks passed.')});
    await fs.writeJson(profileManifestPath,profileManifest);

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
      await execFileAsync('node', [scriptPath, pluginDir, '--strict-agent-skills', '--claude-skill-profile', 'current'], {
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
    codexOnlyManifest.platforms = ['codex'];
    await fs.writeJson(manifestPath, codexOnlyManifest, { spaces: 2 });

    const codexSource = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: repoRoot(), env: process.env, maxBuffer: 10 * 1024 * 1024,
    });
    expect(codexSource.stdout).toContain('[PASS] All checks passed.');
    expect(codexSource.stdout).toContain('component unmet');

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
        schemaVersion: 4,
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
      stdout: expect.stringMatching(/Plugin manifest contract v\d+ is unavailable/u),
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
        schemaVersion: 4,
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] },
        platforms: ['generic'], skills: './skills',
      }),
      fs.outputFile(path.join(pluginDir, 'README.md'), '# Stale portable\n'),
      fs.outputFile(
        path.join(pluginDir, 'skills', 'portable', 'SKILL.md'),
        '---\nname: portable\ndescription: Stale runtime fixture.\n---\n',
      ),
      fs.outputFile(path.join(pluginDir, 'skills', 'portable', 'README.md'), '# Portable\n'),
    ]);

    const validator = path.join(authoringRoot, 'scripts', 'validate-plugin.mjs');
    await expect(execFileAsync('node', [validator, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringMatching(/Plugin manifest contract v\d+ is unavailable/u),
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
      stdout: expect.stringMatching(/Plugin manifest contract v\d+ is unavailable/u),
    });
  });

});
