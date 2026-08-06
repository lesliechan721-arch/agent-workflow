import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./render-artifacts.mjs', import.meta.url));
const scriptModuleUrl = pathToFileURL(scriptPath).href;
const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
const expectedRoles = [
  {
    id: 'codex-explore-quick-role',
    key: 'codex-explore-quick',
    modelKey: 'quickModel',
    effortKey: 'quickReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'medium',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    modelKey: 'standardModel',
    effortKey: 'standardReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    modelKey: 'deepModel',
    effortKey: 'deepReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
  },
];

function createContext(overrides = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-explore',
      version: '0.2.0',
    },
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values: {
        minimumInitialWaitMinutes: 12,
      },
    },
    ...overrides,
  };
}

async function runRenderer(context) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-render-'));
  const contextPath = path.join(tempDir, 'context.json');

  try {
    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
      },
      cwd: path.dirname(scriptPath),
    });

    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function findArtifact(plan, id) {
  const artifact = plan.artifacts.find((entry) => entry.id === id);
  assert.ok(artifact, `Missing artifact ${id}`);
  return artifact;
}

function assertRoleArtifact(plan, expected) {
  const role = findArtifact(plan, expected.id);
  assert.equal(role.kind, 'codexRole');
  assert.equal(role.target, 'codex.agentRole');
  assert.equal(role.state, 'present');
  assert.equal(role.roleKey, expected.key);
  assert.deepEqual(
    role.refreshKeys,
    expected.modelKey ? [expected.modelKey, expected.effortKey] : [],
  );
  assert.equal(role.content.roleFile.name, expected.key);
  assert.equal(role.content.roleFile.model, expected.model);
  assert.equal(role.content.roleFile.model_reasoning_effort, expected.effort);
  assert.equal(role.content.registration.description, role.content.roleFile.description);
  const instructions = role.content.roleFile.developer_instructions;
  assert.ok([...instructions].length <= 1_000);
  assert.ok(instructions.split('\n').length <= 30);
  assert.match(instructions, /只读事实调查，不做最终判断、建议或修改/);
  assert.match(instructions, /不得读取或调用 `codex-explore` skill/);
  assert.match(instructions, /不得委派或管理代理/);
  assert.match(instructions, /存活探测.*不打断调查/s);
  assert.match(instructions, /`status=progress`.*`status=blocked`/s);
  assert.match(instructions, /保持只读/);
  assert.match(instructions, /关键 claim.*实际读取、可核验的来源定位/s);
  assert.match(instructions, /`direct`.*`inference`.*`conflict`/s);
  assert.match(instructions, /`completed`.*`blocked`.*`insufficient`/s);
  for (const heading of ['## Status', '## Findings', '## Gaps']) {
    assert.match(instructions, new RegExp(heading));
  }
  for (const field of ['**kind:**', '**claim:**', '**evidence:**', '**locator:**']) {
    assert.ok(instructions.includes(field));
  }
}

async function testRenderedArtifactsAndSkillContract() {
  const plan = await runRenderer(createContext());
  const skill = findArtifact(plan, 'codex-explore-skill');

  assert.equal(plan.version, 1);
  assert.equal(plan.artifacts.length, 5);
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, ['minimumInitialWaitMinutes']);

  for (const role of expectedRoles) {
    assertRoleArtifact(plan, role);
  }
  assert.equal(
    new Set(expectedRoles.map((role) =>
      findArtifact(plan, role.id).content.roleFile.developer_instructions)).size,
    1,
  );
  const custom = findArtifact(plan, 'codex-explore-custom-role');
  assert.equal('model' in custom.content.roleFile, false);
  assert.equal('model_reasoning_effort' in custom.content.roleFile, false);

  const text = skill.content.skillFile;
  assert.ok([...text].length <= 4_000);
  assert.ok(text.split('\n').length <= 80);
  for (const heading of ['## Gate', '## 委派', '## 不变量', '## 等待与整合']) {
    assert.match(text, new RegExp(heading));
  }
  assert.match(text, /spawn_agent 不提供独立于父 turn 的子代理只读权限参数/);
  assert.match(text, /Gate 只判断拟委派的子任务，不判断顶层任务类型/);
  assert.match(text, /上下文隔离本身构成委派价值/);
  assert.match(text, /少量已知来源.*定向读取/s);
  assert.match(text, /权限级只读.*无法确认/s);
  assert.match(text, /无法明确分档时选择 standard/);
  assert.match(text, /`quick` → `codex-explore-quick`/);
  assert.match(text, /`standard` → `codex-explore-standard`/);
  assert.match(text, /`deep` → `codex-explore-deep`/);
  assert.match(text, /`codex-explore-custom`.*永不自动选择/s);
  assert.match(text, /无法满足时不得删除、替换、降级或改用预设 role/);
  assert.match(text, /有 `fork_turns` 时传 `"none"`/);
  assert.match(text, /有 `fork_context` 时传 `false`/);
  assert.match(text, /`message` 必须自包含范围、来源、具体问题、探索深度/);
  assert.match(text, /默认启动一个子代理/);
  assert.match(text, /子代理继承父 turn 的 permission profile、approval policy 和 sandbox/);
  assert.match(text, /子代理仍可能处理某范围时，主代理不得重复调查或接管/);
  assert.match(text, /首次存活探测前给子任务至少 `12` 分钟累计等待预算/);
  assert.match(text, /优先使用 `timeout_ms=720000`/);
  assert.match(text, /`timeout` 不等于失败/);
  assert.match(text, /才最多探测一次/);
  assert.match(text, /不得使用短 wait 循环、周期性查询/);
  assert.match(text, /只校验明确终态的结果/);
  assert.match(text, /关键 claim.*可核验的来源/s);
  assert.match(text, /每个子任务最多恢复一次/);
  assert.match(text, /明确要求使用 `codex-explore`.*不由主代理接管/s);
  assert.match(text, /自动触发时.*一次最小、只读回退/s);
  assert.match(text, /停止未确认时保留未解决标记，不接管同一范围/);
  assert.match(text, /不发送密钥、个人数据、私有代码或用户材料原文/);
  assert.equal(text.includes('要求 `targets` 且返回 `status`'), false);
  assert.equal(text.includes('`timed_out: true`'), false);
  assert.equal(text.includes('公开 `interrupt` 参数时'), false);
  for (const toolName of [
    'close_agent',
    'followup_task',
    'send_input',
    'send_message',
    'resume_agent',
    'interrupt_agent',
    'list_agents',
  ]) {
    assert.equal(text.includes(toolName), false);
  }
  assert.equal(text.includes('{{'), false);
  assert.equal(text.includes('codex-explore-agent'), false);
  assert.equal(text.includes('插件默认值'), false);
  assert.equal(text.includes('gpt-5.6-luna'), false);
  assert.equal(text.includes('role 固定使用'), false);
  assert.equal(text.includes('催促后等待'), false);
  assert.equal(text.includes('非中断收敛请求'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /使用 \$codex-explore/);
  assert.match(
    skill.content.openaiYaml,
    /从大型或边界不明的材料中进行行为只读的证据探索与核验/,
  );
}

async function testConfigSourcesAndManifestDefaults() {
  const configured = await runRenderer(
    createContext({
      config: undefined,
      renderConfig: {
        values: {
          minimumInitialWaitMinutes: 20,
          standardModel: 'configured-standard',
          standardReasoningEffort: 'max',
        },
      },
    }),
  );
  const configuredSkill = findArtifact(configured, 'codex-explore-skill');
  const configuredStandard = findArtifact(configured, 'codex-explore-standard-role');
  const configuredQuick = findArtifact(configured, 'codex-explore-quick-role');
  assert.match(configuredSkill.content.skillFile, /至少 `20` 分钟累计等待预算/);
  assert.match(configuredSkill.content.skillFile, /优先使用 `timeout_ms=1200000`/);
  assert.equal(configuredStandard.content.roleFile.model, 'configured-standard');
  assert.equal(configuredStandard.content.roleFile.model_reasoning_effort, 'max');
  assert.equal(configuredQuick.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(configuredQuick.content.roleFile.model_reasoning_effort, 'medium');

  const defaults = await runRenderer(
    createContext({
      config: {
        mode: 'artifact-render',
        targetScope: 'project',
        values: {},
      },
    }),
  );
  const defaultSkill = findArtifact(defaults, 'codex-explore-skill');
  const defaultStandard = findArtifact(defaults, 'codex-explore-standard-role');
  assert.match(defaultSkill.content.skillFile, /至少 `10` 分钟累计等待预算/);
  assert.match(defaultSkill.content.skillFile, /优先使用 `timeout_ms=600000`/);
  assert.equal(defaultStandard.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(defaultStandard.content.roleFile.model_reasoning_effort, 'high');
}

async function testStaticManifestContract() {
  const [manifestText, rendererSource] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(scriptPath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, '0.2.7');
  assert.deepEqual(Object.keys(manifest.config.schema), [
    'quickModel',
    'quickReasoningEffort',
    'standardModel',
    'standardReasoningEffort',
    'deepModel',
    'deepReasoningEffort',
    'minimumInitialWaitMinutes',
  ]);
  for (const role of expectedRoles.filter((entry) => entry.modelKey)) {
    assert.equal(manifest.config.schema[role.modelKey].default, role.model);
    assert.equal(manifest.config.schema[role.effortKey].default, role.effort);
    assert.deepEqual(
      manifest.config.schema[role.effortKey].values,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    );
  }
  assert.equal(manifest.config.schema.minimumInitialWaitMinutes.default, 10);
  assert.match(manifest.config.schema.minimumInitialWaitMinutes.title, /存活探测/);
  assert.equal(manifest.skillTriggers['codex-explore'].defaultTrigger, 'auto');
  assert.equal(manifest.skillTriggers['codex-explore'].allowDynamicTrigger, true);
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);
  assert.match(manifest.extensions.instructions[0].content, /Gate 通过/);

  assert.deepEqual(
    manifest.artifacts.targets.map((target) => ({
      id: target.id,
      target: target.target,
      refreshKeys: target.refreshKeys,
      key: target.skillKey ?? target.roleKey,
    })),
    [
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        refreshKeys: ['minimumInitialWaitMinutes'],
        key: 'codex-explore',
      },
      ...expectedRoles.map((role) => ({
        id: role.id,
        target: 'codex.agentRole',
        refreshKeys: role.modelKey ? [role.modelKey, role.effortKey] : [],
        key: role.key,
      })),
    ],
  );
  assert.equal(rendererSource.includes('explorerModel'), false);
  assert.equal(rendererSource.includes("'modelReasoningEffort'"), false);
  assert.equal(rendererSource.includes("model: 'gpt-5.6-luna'"), false);
}

async function testTrimBlockAndUnsupportedPlatform() {
  const { trimBlock, renderArtifactPlan } = await import(scriptModuleUrl);
  assert.equal(
    trimBlock(`
        第一行
          第二行

        - 列表项
    `),
    ['第一行', '  第二行', '', '- 列表项'].join('\n'),
  );
  await assert.rejects(
    () => renderArtifactPlan({ platform: 'claude' }),
    /Unsupported platform: claude/,
  );
}

async function main() {
  await testRenderedArtifactsAndSkillContract();
  await testConfigSourcesAndManifestDefaults();
  await testStaticManifestContract();
  await testTrimBlockAndUnsupportedPlatform();
  console.log('render-artifacts tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
