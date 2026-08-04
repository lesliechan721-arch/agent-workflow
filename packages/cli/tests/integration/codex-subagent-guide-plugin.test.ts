import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { resolveCodexPaths, setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { createCliTestWorkspace } from '../helpers/workspace.js';

const ROLE_DEVELOPER_INSTRUCTIONS = '完成父代理在初始 message 中委派的任务。严格遵守用户、项目、适用技能和当前工具 schema，保持在给定目标、范围与成功标准内；不要自行扩大任务或替父代理处理未委派工作。仅在收到父代理显式存活探测时，可以只回复一次 `status=progress` 和必要进度，或 `status=blocked` 和阻塞原因；不得主动或例行汇报。回复 progress 后继续原任务，不要为探测缩减范围、提前收敛或结束当前 turn。完成后返回可直接整合的结果、关键证据、已执行验证及仍未解决的问题。';
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
    description: '只读探索、事实检索、信息整理、运行已有检查、边界清晰的简单代码及其他简单任务',
    model: 'gpt-5.6-luna',
    effort: 'max',
  },
  {
    id: 'codex-subagent-general-role',
    key: 'codex-subagent-general',
    description: '超出简单任务范围的常规代码或文档实现，以及写作、转换、协调等通用交付',
    model: 'gpt-5.6-sol',
    effort: 'medium',
  },
  {
    id: 'codex-subagent-complex-role',
    key: 'codex-subagent-complex',
    description: '跨模块实现、未知根因调试、并发、生命周期、性能或高风险修改',
    model: 'gpt-5.6-sol',
    effort: 'high',
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
    const repoRoot = await fs.realpath(workspace.repoRoot);

    await writePluginConfigStore({
      pluginName: 'codex-subagent-guide',
      scope: 'project',
      cwd: repoRoot,
      env: workspace.env,
      values: {
        minimumInitialWaitMinutes: 12,
      },
    });

    await installCommand(
      ['codex-subagent-guide'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      { env: workspace.env },
    );

    const codexPaths = resolveCodexPaths(repoRoot, 'project', workspace.env);
    const config = await readCodexConfigFile(codexPaths.configTomlPath);
    const skillRoot = path.join(
      repoRoot,
      '.agents',
      'skills',
      'codex-subagent-guide',
    );
    const skill = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const metadata = await fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');

    expect(skill).toContain('完整历史、按轮次继承或其它非干净模式都统一视为继承上下文');
    expect(skill).toContain('首次探测前至少等待 `12` 分钟（`timeout_ms=720000`）');
    expect(skill).toContain('任务专用 skill 明确提供首次存活探测下限时优先使用');
    expect(metadata).toContain('allow_implicit_invocation: true');
    expect(metadata).toContain(
      'short_description: 子代理任务分类、参数选择、上下文继承、等待与生命周期管理',
    );

    const roleContents = new Map<string, string>();
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
      roleContents.set(role.key, roleContent);
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
        refreshKeys: ['minimumInitialWaitMinutes'],
      }),
      ...ROLE_EXPECTATIONS.map((role) => expect.objectContaining({
        id: role.id,
        target: 'codex.agentRole',
        artifactKey: role.key,
        roleKey: role.key,
      })),
    ]));

    const refresh = await runCliEntry(
      [
        'config',
        'set',
        'codex-subagent-guide',
        'minimumInitialWaitMinutes',
        '15',
        '-s',
        'project',
        '--json',
      ],
      {
        cwd: repoRoot,
        env: workspace.env,
      },
    );
    expect(refresh.exitCode, refresh.stderr).toBe(0);
    const refreshPayload = refresh.parseJsonStdout<{
      artifactRefresh: { error?: string };
    }>();
    expect(refreshPayload, refreshPayload.artifactRefresh.error).toMatchObject({
      ok: true,
      command: 'config:set',
      scope: 'project',
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['minimumInitialWaitMinutes'],
      },
    });
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toContain(
      '首次探测前至少等待 `15` 分钟（`timeout_ms=900000`）',
    );
    for (const role of ROLE_EXPECTATIONS) {
      await expect(fs.readFile(
        path.join(
          codexPaths.configDir,
          'agents',
          `aw-codex-subagent-guide-${role.key}.toml`,
        ),
        'utf8',
      )).resolves.toBe(roleContents.get(role.key));
    }
  });
});
