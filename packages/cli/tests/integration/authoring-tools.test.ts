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
      skills: './skills',
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
      'default_prompt: "Use $repo-diagnose to 检查仓库状态并输出诊断结论."',
    );
    expect(openaiYamlContent).not.toContain('display_name: "Automation Suite"');
    expect(openaiYamlContent).not.toContain('short_description: "自动化插件集合"');
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
      'default_prompt: "Use $repo-audit to check \\"repo\\" state: produce report."',
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
    expect(skillDoc).toContain('`--with-mcp` / `--with-apps`');

    expect(manifestSpecDoc).toContain('`plugins/marketplace-source.json`');
    expect(manifestSpecDoc).toContain('不是运行时 marketplace manifest');
    expect(manifestSpecDoc).toContain('packages/cli/plugins-dist/');
    expect(manifestSpecDoc).toContain('禁止手改');
    expect(manifestSpecDoc).not.toContain('npx eslint *');
    expect(manifestSpecDoc).not.toContain('npx prettier *');
    expect(() =>
      validatePluginManifest(
        '/tmp/coding-standards',
        extractJsonFenceAfter(manifestSpecDoc, '## 最小 manifest 示例'),
      ),
    ).not.toThrow();

    expect(triggersDoc).toContain('两个平台的触发开关完全独立');
    expect(triggersDoc).toContain('面向 Codex 时必需');
    expect(triggersDoc).toContain('`when_to_use`');
    expect(triggersDoc).toContain('不会把 `repo-check` 自动转换成 `Repo Check`');
    expect(triggersDoc).not.toContain('自动格式化 kebab-case');
    expect(extensionsSpecDoc).toContain('`command` 是公共 hook contract 的必填字段');
    expect(extensionsSpecDoc).not.toContain('`command` 已从公共 hook contract 移除');

    const authoringDoc = await fs.readFile(path.join(root, 'docs', 'plugin-authoring.md'), 'utf8');
    expect(authoringDoc).toContain('references/plugin-manifest-spec.md');
    expect(authoringDoc).toContain('references/skills-and-triggers.md');
    expect(authoringDoc).not.toContain('references/project-plugin-contract.md');
    expect(authoringDoc).not.toContain('references/skill-trigger-rules.md');

    const exampleDoc = await fs.readFile(
      path.join(refBase, 'comprehensive-example.md'),
      'utf8',
    );
    expect(exampleDoc).toContain('Codex 安装时生成的 repo-managed artifacts');
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

  it('validate_plugin.js enforces Codex skill metadata and YAML shape', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-metadata-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'metadata-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'metadata-test'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
      name: 'metadata-test',
      version: '0.1.0',
      description: 'Test plugin for skill metadata checks.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }, { spaces: 2 });
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

  it('validate_plugin.js treats openai.yaml as optional for non-Codex skills', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-skill-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'claude-only');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginDir, 'skills', 'claude-only'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
      name: 'claude-only',
      version: '0.1.0',
      description: 'Test plugin for Claude-only skill metadata checks.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CLAUDE'],
        },
      },
    }, { spaces: 2 });
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
      name: 'frontmatter-test',
      version: '0.1.0',
      description: 'Test plugin for skill frontmatter checks.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
    }, { spaces: 2 });
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
        'allowed-tools:',
        '  - Bash(git status *)',
        'shell: bash',
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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
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
    });

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
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
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
    }, { spaces: 2 });
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
