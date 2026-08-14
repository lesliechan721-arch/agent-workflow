import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

async function readCombinedFiles(relativePaths: string[]): Promise<string> {
  return (await Promise.all(relativePaths.map(readRepoFile))).join('\n');
}

async function listMarkdownFiles(relativeRoot: string): Promise<string[]> {
  const root = path.join(repoRoot, relativeRoot);
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.relative(repoRoot, entryPath));
      }
    }
  }
  return files.sort();
}

async function readPublicContractFiles(): Promise<Array<{ file: string; content: string }>> {
  const docs = (await listMarkdownFiles('docs'))
    .filter((file) => !file.startsWith('docs/dev/'));
  const authorReferences = await listMarkdownFiles(
    '.agents/skills/create-aw-plugin/references',
  );
  const files = [
    'README.md',
    '.agents/skills/create-aw-plugin/SKILL.md',
    ...docs,
    ...authorReferences,
  ];
  return Promise.all(files.map(async (file) => ({ file, content: await readRepoFile(file) })));
}

const runtimeDocs = [
  'README.md',
  'docs/architecture.md',
  'docs/testing.md',
];

describe('public docs', () => {
  it('exposes the current author Skills through valid Claude links', async () => {
    const entries = [
      ['create-aw-plugin', '../../.agents/skills/create-aw-plugin'],
      ['skill-review', '../../.agents/skills/skill-review'],
    ];

    for (const [name, target] of entries) {
      const sourceRoot = path.join(repoRoot, '.agents', 'skills', name);
      const claudeLink = path.join(repoRoot, '.claude', 'skills', name);
      expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(claudeLink)).resolves.toBe(target);
      await expect(fs.pathExists(sourceRoot)).resolves.toBe(true);
      await expect(fs.pathExists(claudeLink)).resolves.toBe(true);
    }

    await expect(fs.readdir(path.join(repoRoot, '.claude', 'skills')))
      .resolves.not.toContain('create-agent-workflows-plugin');
  });

  it('keeps removed state architecture out of all public docs and author references', async () => {
    const files = await readPublicContractFiles();
    const forbidden = [
      /dependencies\.plugins/u,
      /install-state/iu,
      /\binstall records?\b/iu,
      /project-artifacts/iu,
      /project artifact (?:identity|shared identity)/iu,
      /(?:dynamic )?diagnostic cache/iu,
      /dependency[- ]index/iu,
      /adopt[- ]existing/iu,
      /historical (?:bundle|runtime)/iu,
      /tracking manifest/iu,
      /installed\.json/iu,
    ];
    for (const { file, content } of files) {
      for (const pattern of forbidden) {
        expect(content, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps removed catalog history keys out of public docs and author references', async () => {
    const files = await readPublicContractFiles();
    const forbidden = [
      /catalog[ -]?history/iu,
      /catalogHistoryUnavailable/u,
      /historyCompatibleCatalog/u,
      /historyLookup/u,
      /sidecar history/iu,
    ];
    for (const { file, content } of files) {
      for (const pattern of forbidden) {
        expect(content, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('does not claim a global historical plugin identity release guarantee', async () => {
    const files = await readPublicContractFiles();
    const forbidden = [
      /同一 `plugin@version` 发布后不可变/u,
      /发布(?:流程|门禁)(?:会|可|能够)(?:证明|保证)全部(?:历史|已发布) `?plugin@version`?.{0,10}不可变/u,
      /Published plugin .+ is immutable/iu,
    ];
    for (const { file, content } of files) {
      for (const pattern of forbidden) {
        expect(content, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('documents only the v3 write, status, and config JSON contracts', async () => {
    const docs = await readCombinedFiles(runtimeDocs);

    expect(docs).toContain('receiptSchemaVersion: 3');
    expect(docs).toContain('schemaVersion: 3');
    expect(docs).toContain('configSchemaVersion: 3');
    expect(docs).not.toMatch(/statusSchemaVersion:\s*2/u);
    expect(docs).not.toMatch(/configSchemaVersion:\s*2/u);
    expect(docs).not.toMatch(/receiptSchemaVersion:\s*2/u);
    expect(docs).not.toContain('consoleItemsSchemaVersion');
  });

  it('documents the four live target states without the removed state model', async () => {
    const architecture = await readRepoFile('docs/architecture.md');

    for (const state of ['`present`', '`absent`', '`partial`', '`error`']) {
      expect(architecture).toContain(state);
    }
    expect(architecture).toContain('`partial` | 只存在部分组件');
    expect(architecture).toContain('`error` | catalog、发现或组件检查失败');
    expect(architecture).not.toMatch(
      /cleanupRequired|notInstalled|installedHistorical|recordCorrupted|nativeMarker|dependencyProtected/u,
    );
  });

  it('keeps cleanup, reinstall, config retention, and lifecycle active boundaries explicit', async () => {
    const docs = await readCombinedFiles(['README.md', 'docs/architecture.md']);

    expect(docs).toContain('`cleanup` 不运行 uninstall lifecycle');
    expect(docs).toContain('`reinstall`：清理 AW-owned 组件');
    expect(docs).toContain('只有 `aw config reset` 删除 config store');
    expect(docs).toContain('lifecycle active snapshot');
    expect(docs).toContain('它不决定插件是否存在');
    expect(docs).not.toMatch(/--remove-config|--adopt-existing|aw repair|dependency-index/u);
  });

  it('documents strict current-only catalog cache and direct compatibility failure', async () => {
    const docs = await readCombinedFiles(['docs/architecture.md', 'docs/testing.md']);

    expect(docs).toContain('immutable entry');
    expect(docs).toContain('原子 selector publication');
    expect(docs).toContain('registry source identity');
    expect(docs).toContain('schema 2');
    expect(docs).toContain('awVersionTooLow');
    expect(docs).toContain('explicitCatalogIncompatible');
    expect(docs).toContain('`artifactDigest` 和 `manifestDigest`');
    expect(docs).not.toContain('catalogHistoryUnavailable');
  });

  it('documents plugin dependencies as unsupported in runtime and author contracts', async () => {
    const docs = await readCombinedFiles([
      'docs/architecture.md',
      '.agents/skills/create-aw-plugin/references/plugin-manifest-spec.md',
      '.agents/skills/create-aw-plugin/references/comprehensive-example.md',
    ]);

    expect(docs).toContain('不支持顶层 `dependencies`');
    expect(docs).not.toContain('dependencies.plugins');
    expect(docs).not.toContain('缺失依赖会自动安装');
  });

  it('keeps native Skill invocation metadata and platform versions public', async () => {
    const docs = await readCombinedFiles([
      'README.md',
      'docs/architecture.md',
      '.agents/skills/create-aw-plugin/references/skills-and-triggers.md',
    ]);

    expect(docs).toContain('allow_implicit_invocation');
    expect(docs).toContain('disable-model-invocation');
    expect(docs).toContain('user-invocable');
    expect(docs).toContain('Codex `>= 0.145.0`');
    expect(docs).toContain('Claude Code `>= 2.1.88`');
  });

  it('documents the model eval permission, resume, and long-wait controls', async () => {
    const [authoringSkill, reviewSkill, reviewEvalReferences] = await Promise.all([
      readRepoFile('.agents/skills/create-aw-plugin/SKILL.md'),
      readRepoFile('.agents/skills/skill-review/SKILL.md'),
      readCombinedFiles([
        '.agents/skills/skill-review/references/static-skill-evaluation.md',
        '.agents/skills/skill-review/references/agent-workflows-plugin.md',
      ]),
    ]);
    for (const contract of [authoringSkill, reviewEvalReferences]) {
      expect(contract).toMatch(/用户未选择时(?:必须)?停下询问/u);
      expect(contract).toContain('不得自行添加该参数');
      expect(contract).toContain('不得请求单次提权');
      expect(contract).toContain('最长响应式等待时间');
    }
    expect(reviewSkill).toContain('references/static-skill-evaluation.md');
    expect(reviewSkill).toContain('references/agent-workflows-plugin.md');
    expect(reviewSkill).not.toContain('启动真实模型 eval 前');
    expect(reviewSkill).not.toContain('真实模型 eval 启动后');

    const docs = await readCombinedFiles([
      '.agents/skills/create-aw-plugin/references/skill-evaluation.md',
      '.agents/skills/skill-review/references/static-skill-evaluation.md',
      '.agents/skills/skill-review/references/agent-workflows-plugin.md',
      'docs/testing.md',
    ]);
    expect(docs).toContain('`CODEX_PERMISSION_PROFILE`');
    expect(docs).toContain('单次 `sandbox_permissions=require_escalated` 不等于');
    expect(docs).toContain('CLI 不能证明参数由人添加');
    expect(docs).toContain('人工确认必须由 Codex 审批或 UI 层保证');
    expect(docs).toContain('terminal case');
    expect(docs).toContain('incomplete 或 missing case');
    expect(docs).toContain('等待超时不表示 eval 失败');
    expect(docs).toContain('不要使用短周期 wait');
  });

  it('keeps the README codex-enhance description aligned with the public contract', async () => {
    const readme = await readRepoFile('README.md');

    expect(readme).toContain('| `codex-enhance` | 通过通用只读探索和已授权子代理编排两个 Skill 增强 Codex | Codex |');
    expect(readme).toContain('`codex-explore` 和 `codex-subagent-guide` 两个 Skill');
    expect(readme).toContain('代码库、文档、网络资料、日志和用户材料');
    expect(readme).toContain('每档 role 的 model 和 reasoning effort 都能独立配置');
  });
});
