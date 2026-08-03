import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { resolveCodexPaths, setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import { createCliTestWorkspace } from '../helpers/workspace.js';

const ROLE_DEVELOPER_INSTRUCTIONS = '完成父代理在初始 message 中委派的任务。严格遵守用户、项目、适用技能和当前工具 schema，保持在给定目标、范围与成功标准内；不要自行扩大任务或替父代理处理未委派工作。完成后返回可直接整合的结果、关键证据、已执行验证及仍未解决的问题。';
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const ROLE_EXPECTATIONS = [
  {
    id: 'codex-subagent-simple-role',
    key: 'codex-subagent-simple',
    description: '只读探索、事实检索、信息整理、运行已有检查或验证结果',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  {
    id: 'codex-subagent-general-role',
    key: 'codex-subagent-general',
    description: '常规代码或文档实现，以及写作、转换、协调等通用交付',
    model: 'gpt-5.6-luna',
    effort: 'max',
  },
  {
    id: 'codex-subagent-complex-role',
    key: 'codex-subagent-complex',
    description: '跨模块实现、未知根因调试、并发、生命周期、性能或高风险修改',
    model: 'gpt-5.6-terra',
    effort: 'max',
  },
  {
    id: 'codex-subagent-plan-review-role',
    key: 'codex-subagent-plan-review',
    description: '代码、安全、质量或方案审核，以及架构设计和实施计划',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  },
];

const tempDirs: string[] = [];

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('codex-subagent-guide dynamic artifacts', () => {
  it('installs the rendered skill and four valid Codex roles in project scope', async () => {
    const workspace = await createCliTestWorkspace({
      rootDirPrefix: 'aw-codex-subagent-guide-',
      mutateRepo: async (repoRoot) => {
        await fs.copy(
          path.join(repositoryRoot, 'plugins', 'codex-subagent-guide'),
          path.join(repoRoot, 'plugins', 'codex-subagent-guide'),
        );
      },
    });
    tempDirs.push(workspace.rootDir, workspace.embeddedRoot!);

    await installCommand(
      ['codex-subagent-guide'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      { env: workspace.env },
    );

    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    const config = await readCodexConfigFile(codexPaths.configTomlPath);
    const skillRoot = path.join(
      workspace.repoRoot,
      '.agents',
      'skills',
      'codex-subagent-guide',
    );
    const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const metadata = await fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');

    expect(skill).toContain('完整历史、按轮次继承或其它非干净模式都统一视为继承上下文');
    expect(metadata).toContain('allow_implicit_invocation: true');

    for (const role of ROLE_EXPECTATIONS) {
      expect(config.snapshot.agents[role.key]).toEqual({
        key: role.key,
        description: role.description,
        configFile: `agents/aw-codex-subagent-guide-${role.key}.toml`,
      });
      const roleContent = await fs.readFile(
        path.join(
          codexPaths.configDir,
          'agents',
          `aw-codex-subagent-guide-${role.key}.toml`,
        ),
        'utf8',
      );
      expect(roleContent).toContain(`name = ${JSON.stringify(role.key)}`);
      expect(roleContent).toContain(`description = ${JSON.stringify(role.description)}`);
      expect(roleContent).toContain(
        `developer_instructions = ${JSON.stringify(ROLE_DEVELOPER_INSTRUCTIONS)}`,
      );
      expect(roleContent).toContain(`model = ${JSON.stringify(role.model)}`);
      expect(roleContent).toContain(
        `model_reasoning_effort = ${JSON.stringify(role.effort)}`,
      );
    }

    const tracking = await readTrackingManifest(codexPaths.trackingDir);
    const artifacts = tracking.plugins['codex-subagent-guide']?.artifacts ?? [];
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'codex-subagent-guide-skill',
        target: 'codex.skill',
        artifactKey: 'codex-subagent-guide',
      }),
      ...ROLE_EXPECTATIONS.map((role) => expect.objectContaining({
        id: role.id,
        target: 'codex.agentRole',
        artifactKey: role.key,
        roleKey: role.key,
      })),
    ]));
  });
});
