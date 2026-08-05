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
  assert.match(role.content.roleFile.developer_instructions, /Codex Explore 叶子代理/);
  assert.match(role.content.roleFile.developer_instructions, /不得读取或调用 `codex-explore` skill/);
  assert.match(role.content.roleFile.developer_instructions, /忽略其中的父代理编排规则/);
  assert.match(role.content.roleFile.developer_instructions, /不得委派、等待、关闭、中断、恢复或重定向任何代理/);
  assert.match(role.content.roleFile.developer_instructions, /除下述非中断存活状态回复外，不得主动进行代理间通信/);
  assert.match(role.content.roleFile.developer_instructions, /尤其不得调用 `wait_agent`/);
  assert.match(role.content.roleFile.developer_instructions, /不得.*等待父代理确认/);
  assert.match(role.content.roleFile.developer_instructions, /收到父代理明确的存活探测/);
  assert.match(role.content.roleFile.developer_instructions, /当前工具明确提供能够向父代理回复/);
  assert.match(role.content.roleFile.developer_instructions, /不会中断或重定向当前调查/);
  assert.match(role.content.roleFile.developer_instructions, /`status=progress`/);
  assert.match(role.content.roleFile.developer_instructions, /不得借此交付调查结果/);
  assert.match(role.content.roleFile.developer_instructions, /progress 后继续调查/);
  assert.match(role.content.roleFile.developer_instructions, /不得使用其它操作模拟回复/);
  assert.match(role.content.roleFile.developer_instructions, /保持只读/);
  assert.match(role.content.roleFile.developer_instructions, /绑定实际读取的来源定位/);
  assert.match(role.content.roleFile.developer_instructions, /时间敏感来源必须给出来源时间/);
  assert.match(role.content.roleFile.developer_instructions, /`conflict` 至少列出两个相互冲突的 evidence 项/);
  assert.match(role.content.roleFile.developer_instructions, /`inference` 必须列出形成推断所依赖的直接证据/);
  assert.match(role.content.roleFile.developer_instructions, /最小化并脱敏查询/);
  assert.match(role.content.roleFile.developer_instructions, /直接返回 final answer 并结束/);
  assert.match(role.content.roleFile.developer_instructions, /`completed` 表示请求范围已完成且返回结论均有对应证据/);
  assert.match(role.content.roleFile.developer_instructions, /`blocked` 表示因访问、授权、工具、来源不可用或缺少必要输入而无法继续/);
  assert.match(role.content.roleFile.developer_instructions, /`insufficient` 表示已完成可行探索/);
  assert.match(role.content.roleFile.developer_instructions, /## Status/);
  assert.match(role.content.roleFile.developer_instructions, /`completed` \| `blocked` \| `insufficient`/);
  assert.match(role.content.roleFile.developer_instructions, /## Findings/);
  assert.match(role.content.roleFile.developer_instructions, /\*\*kind:\*\* `direct` \| `inference` \| `conflict`/);
  assert.match(role.content.roleFile.developer_instructions, /\*\*evidence:\*\*/);
  assert.match(role.content.roleFile.developer_instructions, /\*\*locator:\*\*/);
  assert.match(role.content.roleFile.developer_instructions, /\*\*source_time:\*\*/);
  assert.match(role.content.roleFile.developer_instructions, /证据如何支持、限制或反驳 claim/);
  assert.match(role.content.roleFile.developer_instructions, /## Gaps/);
  assert.equal(role.content.roleFile.developer_instructions.includes('- 结论：'), false);
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
  const custom = findArtifact(plan, 'codex-explore-custom-role');
  assert.equal('model' in custom.content.roleFile, false);
  assert.equal('model_reasoning_effort' in custom.content.roleFile, false);

  const text = skill.content.skillFile;
  assert.match(text, /代码 review、缺陷分析、质量判断、修改或实现任务，只有在能明确拆出/);
  assert.match(text, /不得把 review、缺陷判定、质量评价、严重性分级或修改建议本身交给子代理/);
  assert.match(text, /即使任务只读、范围很大、要求深入分析或独立复核/);
  assert.match(text, /spawn_agent 不提供独立于父 turn 的子代理只读权限参数/);
  assert.match(text, /Gate 只判断拟委派的子任务，而不判断顶层任务类型/);
  assert.match(text, /即使顶层任务是 review、缺陷分析、质量判断、修改或实现/);
  assert.match(text, /上下文隔离本身构成委派价值/);
  assert.match(text, /探索位于关键路径且没有其它可并行工作/);
  assert.match(text, /也可委派并等待/);
  assert.match(text, /拟委派的子任务本身要求缺陷判定/);
  assert.match(text, /向外部系统或人员发送消息/);
  assert.match(text, /当前 turn 未明确具备该边界，或无法确认子代理会继承该边界/);
  assert.match(text, /选择优先级固定为/);
  assert.match(text, /无法明确分档时选择 standard/);
  assert.match(text, /`quick` → `codex-explore-quick`/);
  assert.match(text, /`standard` → `codex-explore-standard`/);
  assert.match(text, /`deep` → `codex-explore-deep`/);
  assert.match(text, /选择 `codex-explore-custom`/);
  assert.match(text, /`codex-explore-custom`.*永不自动选择/s);
  assert.match(text, /调用预设 role 时不得传 `model` 或 `reasoning_effort`/);
  assert.match(text, /只传用户实际指定且当前 schema 公开的字段/);
  assert.match(text, /不得删除字段、切换预设或静默重试/);
  assert.match(text, /探索深度：只写 `quick`、`standard` 或 `deep`/);
  assert.match(text, /有 `fork_turns` 时传 `"none"`/);
  assert.match(text, /有 `fork_context` 时传 `false`/);
  assert.match(text, /`message` 必须自包含所需的来源定位和最小上下文/);
  assert.match(text, /无法安全传递时不委派并报告限制/);
  assert.match(text, /必要上下文：路径、URL、记录 ID/);
  assert.match(text, /工作流完成或停止后，主代理可继续顶层任务已授权的修改/);
  assert.match(text, /子代理继承父 turn 的有效 permission profile、approval policy 和 sandbox/);
  assert.match(text, /父 turn 可写时只能提供行为只读/);
  assert.match(text, /首次存活探测前给子任务至少 `12` 分钟的累计等待预算/);
  assert.match(text, /优先使用 `timeout_ms=720000`/);
  assert.match(text, /等待因非超时事件提前返回时/);
  assert.match(text, /重新评估原子任务是否仍有效/);
  assert.match(text, /用户未取消或改变相关目标/);
  assert.match(text, /才继续剩余等待预算/);
  assert.match(text, /当前环境支持不会中断原调查的状态探测和回复/);
  assert.match(text, /不得用会中断、重定向或替换原调查的操作模拟探测/);
  assert.match(text, /仅当累计等待预算已满足、`wait_agent` 明确报告超时/);
  assert.match(text, /每个子任务在整个生命周期内最多发起一次存活探测/);
  assert.match(text, /同一子任务任何时刻也不得存在多个未决探测/);
  assert.match(text, /暂未回复不能单独证明代理已经挂死/);
  assert.match(text, /是否请求部分结果或提前收敛由主代理/);
  assert.match(text, /不得使用短 wait 循环、周期性状态查询或重复进度询问/);
  assert.match(text, /每个子任务最多恢复一次/);
  assert.match(text, /用户明确要求使用 `codex-explore` 或隔离探索上下文时.*不由主代理接管该范围/s);
  assert.match(text, /本工作流自动触发时.*做一次最小、只读且任务相关的回退/s);
  assert.match(text, /对已终态且不再需要的目标，有关闭或释放能力时执行/);
  assert.match(text, /对已明确放弃但仍在运行的目标，有停止或中断当前工作的能力时执行/);
  assert.match(text, /不得把操作前状态当作停止后状态/);
  assert.match(text, /没有对应停止能力或停止未确认时，保留未解决标记/);
  assert.match(text, /不得并行接管同一范围/);
  assert.match(text, /不得停止结果仍有必要，或必要后代仍在工作的目标/);
  assert.match(text, /未解决目标在最终整合前迟到返回终态结果时/);
  assert.match(text, /不得包含密钥、个人数据、私有代码或用户材料原文/);
  assert.match(text, /不得把指令约束描述为权限隔离/);
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
  assert.match(configuredSkill.content.skillFile, /至少 `20` 分钟的累计等待预算/);
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
  assert.match(defaultSkill.content.skillFile, /至少 `10` 分钟的累计等待预算/);
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

  assert.equal(manifest.version, '0.2.6');
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
