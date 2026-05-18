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

describe('public docs', () => {
  it('keeps the README codex-explore description aligned with the public contract', async () => {
    const readme = await readRepoFile('README.md');

    expect(readme).toContain('| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |');
    expect(readme).toContain('`codex-explore` 是 Codex 通用只读探索 workflow');
    expect(readme).toContain('代码库、文档、网络资料、日志和用户材料');
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

  it('documents cleanup planning and remove-config without reintroducing uninstall --force', async () => {
    const publicDocs = [
      await readRepoFile('README.md'),
      await readRepoFile('docs/plugin-installation.md'),
    ].join('\n');

    expect(publicDocs).not.toContain('uninstall --force');
    expect(publicDocs).not.toContain('force` | `uninstall');
    expect(publicDocs).toContain('aw cleanup git-commit -p codex -s project --plan');
    expect(publicDocs).toContain('cleanupPlanSchemaVersion: 1');
    expect(publicDocs).toContain('--remove-config');
    expect(publicDocs).toContain('`reset` 是单纯的 config store 级删除');
  });

  it('documents consoleItems V3 migration mappings for statuses, actions, and reason codes', async () => {
    const installation = await readRepoFile('docs/plugin-installation.md');

    expect(installation).toContain('`statusSchemaVersion` | `2`');
    expect(installation).toContain('`consoleItemsSchemaVersion` | `3`');
    expect(installation).toContain('`configSchemaVersion` | `2`');
    expect(installation).toContain('`receiptSchemaVersion` | `2`');
    expect(installation).toContain('`nextStepsSchemaVersion` | `1`');
    expect(installation).toContain('| `needsAction`、`partial`、`repoManaged`');
    expect(installation).toContain('| `openInstallWizard`、安装入口 | `install` | `runInstall` |');
    expect(installation).toContain('| 状态详情入口 | `status` | 状态页 supplemental action，不属于公开写动作 |');

    const reasonMappings = [
      ['`missingRecord`', '`recordCorrupted`'],
      ['`adoptExisting`', '`adoptableInstall`'],
      ['`ownerConflict`', '`foreignOwnershipConflict`'],
      ['`dependencyProtected`', '`dependencyBlocked`'],
      ['`requiredConfigMissing`', '`missingRequiredConfig`'],
      ['`invalidConfig`', '`missingRequiredConfig`'],
      ['`unreadableConfig`', '`missingRequiredConfig`'],
      ['`nativeResidue`', '`residueDetected`'],
      ['`artifactDrift`', '`artifactRefreshFailed`'],
      ['`externalOwnership`', '`foreignOwnershipConflict`'],
      ['`trackingIdentityBroken`', '`recordCorrupted`'],
      ['`roleOrMcpConflict`', '`foreignOwnershipConflict`'],
      ['`unmanagedArtifactConflict`', '`foreignOwnershipConflict`'],
      ['`catalogCapabilityChanged`', '`recordCorrupted`'],
    ];
    for (const [legacyCode, v2Code] of reasonMappings) {
      expect(installation).toContain(`| ${legacyCode} | ${v2Code} |`);
    }
    expect(installation).toContain('`consoleItemsSchemaVersion: 3` 下不会再输出旧 id');
  });

  it('keeps removed public CLI entry points out of public docs', async () => {
    const diagnoseMigrationDocs = [
      'README.md',
      'docs/plugin-authoring.md',
      'docs/plugin-installation.md',
      'docs/plugin-installation-technical-details.md',
    ];
    const cliFlagDocs = [
      'README.md',
      'docs/plugin-installation.md',
      'docs/plugin-installation-technical-details.md',
    ];

    const combined = (await Promise.all(diagnoseMigrationDocs.map((file) => readRepoFile(file)))).join('\n');
    const cliFlagsCombined = (await Promise.all(cliFlagDocs.map((file) => readRepoFile(file)))).join('\n');

    expect(combined).not.toContain('aw diagnose');
    expect(combined).not.toContain('diagnose --deep');
    expect(combined).not.toContain('status/diagnose/repair');
    expect(combined).not.toContain('status / diagnose / repair');
    expect(combined).not.toContain('`status` / `diagnose`');
    expect(combined).not.toContain('重新运行 diagnose');
    expect(combined).toContain('aw status --verbose');
    expect(combined).toContain('aw repair --dependency-index');
    expect(combined).toContain('aw cleanup --dependency-index --prune-stale <token> --yes');
    expect(cliFlagsCombined).not.toContain('--platform auto');
    expect(cliFlagsCombined).not.toContain('--skill-trigger');
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
});
