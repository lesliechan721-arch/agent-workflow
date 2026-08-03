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
  return (await Promise.all(relativePaths.map((file) => readRepoFile(file)))).join('\n');
}

async function readUserFacingDocs(): Promise<string> {
  return readCombinedFiles([
    'README.md',
    'docs/architecture.md',
    'docs/plugin-installation.md',
    'docs/plugin-installation-technical-details.md',
    'docs/plugin-authoring.md',
    'docs/coding-conventions.md',
    'docs/testing.md',
  ]);
}

describe('public docs', () => {
  it('keeps the README codex-explore description aligned with the public contract', async () => {
    const readme = await readRepoFile('README.md');

    expect(readme).toContain('| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |');
    expect(readme).toContain('`codex-explore` 是 Codex 通用只读探索 workflow');
    expect(readme).toContain('代码库、文档、网络资料、日志和用户材料');
    expect(readme).toContain('每档 role 的 model 和 reasoning effort 都能独立配置');
    expect(readme).not.toContain('为 Codex 提供只读代码库探索流程');
  });

  it('documents consoleItems V3 without leaking page-only fields into the public JSON contract', async () => {
    const architecture = await readRepoFile('docs/architecture.md');

    expect(architecture).toContain('statusSchemaVersion: 2');
    expect(architecture).toContain('consoleItemsSchemaVersion: 3');
    expect(architecture).toContain('configSchemaVersion: 2');
    expect(architecture).toContain('receiptSchemaVersion: 2');
    expect(architecture).toContain('nextStepsSchemaVersion: 1');
    expect(architecture).toContain('`PluginConsoleSummary.features`：功能菜单 summary');
    expect(architecture).toContain('只表达“可以进入哪些功能”和目标选择策略');
    expect(architecture).toContain('这些字段不进入 `status --json.consoleItems`');
    expect(architecture).toContain('`loadConsoleItems({ includeCatalogOnly: true })`');
    expect(architecture).toContain('V3 `consoleItems` 是公开 summary 合同');

    const legacyReasonCodes = [
      'missingRecord',
      'adoptExisting',
      'ownerConflict',
      'dependencyProtected',
      'requiredConfigMissing',
      'invalidConfig',
      'unreadableConfig',
      'nativeResidue',
      'artifactDrift',
    ];
    for (const legacyCode of legacyReasonCodes) {
      expect(architecture).not.toContain(legacyCode);
    }
  });

  it('documents cleanup, reinstall, and config removal without reintroducing legacy recovery entries', async () => {
    const publicDocs = await readCombinedFiles([
      'README.md',
      'docs/plugin-installation.md',
      'docs/plugin-installation-technical-details.md',
    ]);

    expect(publicDocs).not.toContain('uninstall --force');
    expect(publicDocs).not.toContain('cleanup --plan');
    expect(publicDocs).not.toContain('cleanupPlanSchemaVersion');
    expect(publicDocs).not.toContain('aw repair');
    expect(publicDocs).not.toContain('repair --dependency-index');
    expect(publicDocs).toContain('aw cleanup git-commit -p codex -s project');
    expect(publicDocs).toContain('aw cleanup --dependency-index --prune-stale <token> --yes');
    expect(publicDocs).toContain('aw reinstall git-commit -p codex -s user');
    expect(publicDocs).toContain('--remove-config');
    expect(publicDocs).toContain('`reset` 是单纯的 config store 级删除');
  });

  it('documents consoleItems V3 grouping and schema boundaries', async () => {
    const installation = await readRepoFile('docs/plugin-installation.md');

    expect(installation).toContain('`statusSchemaVersion` | `2`');
    expect(installation).toContain('`consoleItemsSchemaVersion` | `3`');
    expect(installation).toContain('`configSchemaVersion` | `2`');
    expect(installation).toContain('`receiptSchemaVersion` | `2`');
    expect(installation).toContain('`nextStepsSchemaVersion` | `1`');
    expect(installation).toContain('| `异常` | `cleanupRequired`、普通 `external`');
    expect(installation).toContain('| `可升级` | 顶层仍为 `installed`');
    expect(installation).toContain('| `已安装` | 顶层为 `installed`');
    expect(installation).toContain('| `未安装` | 顶层为 `notInstalled`');
    expect(installation).toContain('功能入口放在 `features`');
    expect(installation).toContain('不输出旧 `locations[].actions[]`、命令数组、确认文案或 TUI 页面字段');
    expect(installation).toContain('详情页承载 install、upgrade、uninstall、cleanup、reinstall、adopt existing 和 reapply config 等动作');
    expect(installation).toContain('暴露 `nextSteps` 的对象必须同时带 `nextStepsSchemaVersion: 1`');
  });

  it('keeps removed public CLI entry points out of README and public docs', async () => {
    const publicDocs = await readUserFacingDocs();

    expect(publicDocs).not.toContain('aw diagnose');
    expect(publicDocs).not.toContain('diagnose --deep');
    expect(publicDocs).not.toContain('aw repair');
    expect(publicDocs).not.toContain('repair --dependency-index');
    expect(publicDocs).not.toContain('cleanup --plan');
    expect(publicDocs).not.toContain('--takeover-shared-runtime');
    expect(publicDocs).not.toContain('status/diagnose/repair');
    expect(publicDocs).not.toContain('status / diagnose / repair');
    expect(publicDocs).not.toContain('`status` / `diagnose`');
    expect(publicDocs).not.toContain('重新运行 diagnose');
    expect(publicDocs).toContain('aw status --verbose');
    expect(publicDocs).toContain('aw install --adopt-existing');
    expect(publicDocs).toContain('aw cleanup --dependency-index --prune-stale <token> --yes');
    expect(publicDocs).toContain('aw reinstall');
  });

  it('documents the SkillTrigger author contract without install-time override fields', async () => {
    const authorDocs = [
      'docs/plugin-authoring.md',
      '.agents/skills/create-agent-workflows-plugin/SKILL.md',
      '.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md',
      '.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md',
      '.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md',
    ];

    const combined = (await Promise.all(authorDocs.map((file) => readRepoFile(file)))).join('\n');

    expect(combined).toContain('defaultTrigger');
    expect(combined).toContain('allowDynamicTrigger');
    expect(combined).not.toContain('allowInstallOverride');
    expect(combined).not.toContain('--skill-trigger');
    expect(combined).not.toContain('skillTriggerPreference');
  });

  it('documents authoring version contracts and scaffold catalog gate inputs', async () => {
    const skillDoc = await readRepoFile('.agents/skills/create-agent-workflows-plugin/SKILL.md');
    const manifestSpec = await readRepoFile(
      '.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md',
    );

    expect(skillDoc).toContain('--min-version');
    expect(skillDoc).toContain('--catalog-min-version');
    expect(skillDoc).toContain('CLI version、catalog version 和 plugin version 是三套身份');
    expect(skillDoc).toContain('`@yiliang/aw-plugins-manifest` sidecar 包');
    expect(skillDoc).toContain('`@yiliang/aw-plugins` full catalog 包');

    expect(manifestSpec).toContain('`compatibility.aw.minVersion`');
    expect(manifestSpec).toContain('插件最低 CLI 版本不能高于 catalog 级 `compatibility.aw.minVersion`');
    expect(manifestSpec).toContain('不支持旧式 `version`、`range`');
    expect(manifestSpec).toContain('catalog history 记录历史 catalog version、插件 version、插件最低 CLI 版本、`artifactDigest` 和 `manifestDigest`');
  });

  it('documents the Codex 0.144 and Claude 2.1.88 host contracts without old write paths', async () => {
    const docs = [
      'docs/plugin-authoring.md',
      'docs/plugin-installation.md',
      'docs/plugin-installation-technical-details.md',
      'docs/architecture.md',
      'docs/testing.md',
      '.agents/skills/create-agent-workflows-plugin/SKILL.md',
      '.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md',
      '.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md',
      '.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md',
    ];
    const combined = (await Promise.all(docs.map((file) => readRepoFile(file)))).join('\n');

    expect(combined).toContain('Codex `>= 0.145.0`');
    expect(combined).toContain('Claude Code `>= 2.1.88`');
    expect(combined).toContain('codex plugin add/remove');
    expect(combined).toContain('codex plugin marketplace add/list/remove');
    expect(combined).toContain('`plugin/list`、`plugin/installed`、`plugin/read` 只用于');
    expect(combined).toContain('`.codex-plugin/plugin.json` 的 `hooks` 字段');
    expect(combined).toContain('`.codex/hooks.json`');
    expect(combined).toContain('写入前仍要求本机 Codex `>= 0.145.0`');
    expect(combined).toContain('不声明 per-plugin 宿主 agent 版本');

    expect(combined).not.toContain('`plugin/install`');
    expect(combined).not.toContain('`plugin/uninstall`');
    expect(combined).not.toContain('缺少 `codex` 可执行文件时，project 安装仍应可工作');
    expect(combined).not.toContain('缺少 `codex` 可执行文件时，repo-managed project 安装仍可进行');
    expect(combined).not.toContain('即使 PATH 缺少 `codex` 可执行文件');
    expect(combined).not.toContain('Codex user native install/uninstall 用 `createFakeCodexAppServerHarness()`');
  });
});
