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

async function readFirstExisting(urls) {
  let lastError;
  for (const url of urls) {
    try {
      return await readFile(fileURLToPath(url), 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createContext(overrides = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-explore',
      version: '0.1.0',
    },
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values: {
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'high',
        minimumInitialWaitMinutes: 12,
        convergenceWaitMinutes: 6,
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

async function testPresentSkillArtifact() {
  const { trimBlock } = await import(scriptModuleUrl);
  const plan = await runRenderer(createContext());
  const skill = findArtifact(plan, 'codex-explore-skill');
  const role = findArtifact(plan, 'codex-explore-agent-role');

  assert.equal(plan.version, 1);
  assert.equal(plan.artifacts.length, 2);
  assert.equal(skill.state, 'present');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, [
    'explorerModel',
    'modelReasoningEffort',
    'minimumInitialWaitMinutes',
    'convergenceWaitMinutes',
  ]);
  assert.equal(role.state, 'present');
  assert.equal(role.kind, 'codexRole');
  assert.equal(role.target, 'codex.agentRole');
  assert.equal(role.roleKey, 'codex-explore-agent');
  assert.deepEqual(role.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(role.content.registration.description, '只读探索代码、文档、网页、日志和大段材料，并整理关键证据。');
  assert.equal(role.content.roleFile.name, 'codex-explore-agent');
  assert.equal(role.content.roleFile.description, '只读探索代码、文档、网页、日志和大段材料，并整理关键证据。');
  assert.equal(role.content.roleFile.model, 'gpt-5.4');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'high');
  assert.match(role.content.roleFile.developer_instructions, /叶子探索子代理/);
  assert.match(role.content.roleFile.developer_instructions, /只做只读调查/);
  assert.match(role.content.roleFile.developer_instructions, /不得调用任何子代理调度或管理工具/);
  assert.match(role.content.roleFile.developer_instructions, /`send_input`、`send_message`、`followup_task`/);
  assert.match(role.content.roleFile.developer_instructions, /`resume_agent`、`close_agent`、`interrupt_agent`、`list_agents`/);
  assert.match(role.content.roleFile.developer_instructions, /也不得继续拆分/);
  assert.match(role.content.roleFile.developer_instructions, /保持只读/);
  assert.match(role.content.roleFile.developer_instructions, /完成标准是回答具体问题/);
  assert.match(role.content.roleFile.developer_instructions, /每个关键结论都能由实际读取的证据核验/);
  assert.match(role.content.roleFile.developer_instructions, /只引用实际读取的来源/);
  assert.match(role.content.roleFile.developer_instructions, /每个关键结论紧跟可核验的来源定位/);
  assert.match(role.content.roleFile.developer_instructions, /用户材料的段落或行号/);
  assert.match(role.content.roleFile.developer_instructions, /命令或工具名称及可识别的输出片段或记录 ID/);
  assert.match(role.content.roleFile.developer_instructions, /明确标记直接证据与推断/);
  assert.match(role.content.roleFile.developer_instructions, /来源冲突、证据缺失/);
  assert.match(role.content.roleFile.developer_instructions, /证据不足时缩小结论，不要猜测/);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'lightweight-instruction'), false);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'codex-explorer-role'), false);
  assert.equal(skill.content.skillFile.includes('codex-explorer'), false);
  assert.match(skill.content.skillFile, /description: 只读证据探索委派工作流/);
  assert.match(skill.content.skillFile, /用户明确要求使用 codex-explore 时加载，但仍须通过 Gate 才能启动子代理/);
  assert.match(skill.content.skillFile, /目标是把会明显占用或污染主会话上下文的只读证据探索交给专用子代理/);
  assert.match(skill.content.skillFile, /完成标准：每个委派问题得到符合证据合同的结果或明确的缺失说明/);
  assert.match(skill.content.skillFile, /已标记为未解决且没有并行接管/);
  assert.match(skill.content.skillFile, /跨 6 个以上文件、3 个以上模块、多来源资料、长日志、需要跨多个官方文档或网页检索/);
  assert.match(skill.content.skillFile, /候选材料范围较大、边界未知/);
  assert.match(skill.content.skillFile, /陌生、外部、本轮尚未建立上下文/);
  assert.match(skill.content.skillFile, /大量可能无关的候选内容/);
  assert.match(skill.content.skillFile, /明显占用或污染当前会话上下文/);
  assert.match(skill.content.skillFile, /最终答案只有一个事实并不是停止理由/);
  assert.match(skill.content.skillFile, /需要搜索、筛选和核验证据/);
  assert.match(skill.content.skillFile, /任务目标本身是实现、修改、格式化、提交或其它写操作/);
  assert.match(skill.content.skillFile, /无法清楚分离出只读证据探索/);
  assert.match(skill.content.skillFile, /数量只作辅助判断/);
  assert.match(skill.content.skillFile, /能把探索工作写成具体问题/);
  assert.match(skill.content.skillFile, /交叉验证或独立核对假设不能单独触发本工作流/);
  assert.match(skill.content.skillFile, /问题必须先做只读证据探索才能可靠推进/);
  assert.match(skill.content.skillFile, /只是顺带提到 `codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill.content.skillFile, /问题本身不需要隔离探索上下文/);
  assert.equal(skill.content.skillFile.includes('/path/to/external-project'), false);
  assert.match(skill.content.skillFile, /任务特征与数量阈值冲突时/);
  assert.match(skill.content.skillFile, /先做委派价值 Gate/);
  assert.match(skill.content.skillFile, /不满足价值条件时交回主代理，按普通任务处理/);
  assert.match(skill.content.skillFile, /价值 Gate 通过后再检查运行能力/);
  assert.match(skill.content.skillFile, /只使用 Codex Explore 自带的探索 role/);
  assert.match(skill.content.skillFile, /以当前 `spawn_agent` 工具实际公开的 schema 为准/);
  assert.match(skill.content.skillFile, /不得传入 schema 未公开的字段/);
  assert.match(skill.content.skillFile, /公开 `task_name` 时/);
  assert.match(skill.content.skillFile, /概括具体探索目的，如 `trace_wait_agent`/);
  assert.match(skill.content.skillFile, /重名时才追加 `_2`、`_3`/);
  assert.equal(skill.content.skillFile.includes('codex_explore_1'), false);
  assert.match(skill.content.skillFile, /agent_type: "codex-explore-agent"/);
  assert.match(skill.content.skillFile, /公开 `fork_turns` 时，传 `"none"`/);
  assert.match(skill.content.skillFile, /默认模型是 `gpt-5\.4`/);
  assert.match(skill.content.skillFile, /推理强度是 `high`/);
  assert.match(skill.content.skillFile, /工具不公开 `agent_type`/);
  assert.match(skill.content.skillFile, /schema 明确不允许 `codex-explore-agent`/);
  assert.match(skill.content.skillFile, /把该范围视为委派失败，按后文的失败回退规则处理/);
  assert.match(skill.content.skillFile, /developer instructions 由专用 role 提供/);
  assert.match(skill.content.skillFile, /不得启动默认子代理或改用内置 `explorer`、其它 role/);
  assert.match(skill.content.skillFile, /当前会话的工具、联网、官方文档优先和上层安全策略/);
  assert.match(skill.content.skillFile, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill.content.skillFile, /不能凭记忆补事实/);
  assert.match(skill.content.skillFile, /每个子代理的 prompt 只写本次任务需要的内容/);
  assert.match(
    skill.content.skillFile,
    /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*期望输出/,
  );
  assert.match(skill.content.skillFile, /不要在 prompt 中重复专用 role 已提供的叶子代理、只读和通用证据规则/);
  assert.equal(skill.content.skillFile.includes('`send_input`'), false);
  assert.match(skill.content.skillFile, /子代理未终态且未确认停止期间.*不再同步调查同一个问题或同一批候选材料/s);
  assert.match(skill.content.skillFile, /以当前会话中已有的工具返回和完成通知为准/);
  assert.match(skill.content.skillFile, /无需为此创建额外文件、清单或外部状态/);
  assert.equal(skill.content.skillFile.includes('主代理记录每个子任务'), false);
  assert.match(skill.content.skillFile, /要求 `targets` 且返回 `status`/);
  assert.match(skill.content.skillFile, /不接受 `targets` 且只返回消息或 activity 摘要/);
  assert.match(skill.content.skillFile, /不按 Codex 版本号或配置猜测/);
  assert.match(skill.content.skillFile, /同一终态可能同时出现在等待结果和完成通知中/);
  assert.match(skill.content.skillFile, /按子任务引用去重/);
  assert.match(skill.content.skillFile, /“常规等待”和“催促后等待”/);
  assert.match(skill.content.skillFile, /首次最小等待为 `12` 分钟（`timeout_ms=720000`）/);
  assert.match(skill.content.skillFile, /催促后等待为 `6` 分钟（`timeout_ms=360000`）/);
  assert.match(skill.content.skillFile, /单次调用窗口，不是整批子代理的总时限/);
  assert.match(skill.content.skillFile, /首次常规等待优先使用用户指定的单次时长/);
  assert.match(skill.content.skillFile, /后续默认复用.*每次调用重新计时/s);
  assert.match(skill.content.skillFile, /不计算剩余批次时间，也不承诺精确总时限/);
  assert.match(skill.content.skillFile, /`timed_out: true`.*才算真正超时/);
  assert.match(skill.content.skillFile, /向未完成代理发送一次非中断收敛请求/);
  assert.match(skill.content.skillFile, /公开 `interrupt` 参数时显式传 `false`/);
  assert.match(skill.content.skillFile, /催促后等待固定使用配置窗口/);
  assert.match(skill.content.skillFile, /有停止能力时.*确认其不再运行后.*对应子任务标记为失败/s);
  assert.match(skill.content.skillFile, /没有停止能力或无法确认终态时.*标记为未解决.*不接管或重新委派该范围/s);
  assert.match(skill.content.skillFile, /最终答复前成功终止时按正常结果校验，否则只报告缺失/);
  assert.match(skill.content.skillFile, /没有创建子代理的委派失败，或已确认终态或停止的失败子任务，适用以下回退/);
  assert.match(
    skill.content.skillFile,
    /把该范围视为委派失败[\s\S]*没有创建子代理的委派失败，或已确认终态或停止的失败子任务[\s\S]*用户明确要求使用 `codex-explore`[\s\S]*本工作流自动触发时/,
  );
  assert.match(skill.content.skillFile, /用户明确要求使用 `codex-explore` 或隔离探索上下文时.*不由主代理接管该范围/s);
  assert.match(skill.content.skillFile, /本工作流自动触发时.*做一次最小、只读且任务相关的回退/s);
  assert.match(skill.content.skillFile, /用户没有取消或替换原任务.*回到原等待阶段/s);
  assert.match(skill.content.skillFile, /只传 schema 公开的参数/);
  assert.match(skill.content.skillFile, /`list_agents` 可用于状态对账，不能代替结果内容/);
  assert.match(skill.content.skillFile, /剩余结果无论为何都不会改变结论.*不属于用户要求的覆盖范围/);
  assert.match(skill.content.skillFile, /只有当前工具列表提供 `close_agent` 时/);
  assert.match(skill.content.skillFile, /`interrupt_agent` 若只中断当前 turn.*不能当作正常关闭/s);
  assert.match(skill.content.skillFile, /`wait_agent` 也不等于关闭 agent/);
  assert.match(skill.content.skillFile, /不降级到其它代理/);
  assert.match(skill.content.skillFile, /启动重试、异常重试、空输出补问和缺失项补问合计最多一次/);
  assert.match(skill.content.skillFile, /`spawn_agent` 没有创建子代理/);
  assert.match(skill.content.skillFile, /子代理进入异常终态/);
  assert.match(skill.content.skillFile, /成功终态但没有输出/);
  assert.match(skill.content.skillFile, /输出不符合任务或证据合同/);
  assert.match(skill.content.skillFile, /失败或无效内容不得整合/);
  assert.match(skill.content.skillFile, /关键结论是否绑定实际读取且可核验的来源定位/);
  assert.match(skill.content.skillFile, /用户材料的段落或行号/);
  assert.match(skill.content.skillFile, /命令或工具名称及可识别的输出片段或记录 ID/);
  assert.match(skill.content.skillFile, /直接证据、推断、来源冲突和证据缺失是否明确区分/);
  assert.match(skill.content.skillFile, /补读子代理指出的最小必要上下文/);
  assert.match(skill.content.skillFile, /只保留通过校验的关键结论、对应证据/);
  assert.match(skill.content.skillFile, /不得超过当前可用并发槽位/);
  assert.match(skill.content.skillFile, /正常结束并读取结果后/);
  assert.equal(skill.content.skillFile.includes('阻塞决策'), false);
  assert.equal(skill.content.skillFile.includes('软截止'), false);
  assert.equal(skill.content.skillFile.includes('硬截止'), false);
  assert.equal(skill.content.skillFile.includes('探索深度'), false);
  assert.equal(skill.content.skillFile.includes('`quick`'), false);
  assert.equal(skill.content.skillFile.includes('aw install'), false);
  assert.equal(skill.content.skillFile.includes('aw config'), false);
  assert.equal(skill.content.skillFile.includes('Codex v1'), false);
  assert.equal(skill.content.skillFile.includes('Codex v2'), false);
  assert.equal(skill.content.skillFile.includes('同时公开 `task_name` 和 `agent_type`'), false);
  assert.equal(skill.content.skillFile.includes('\n    ## 何时使用'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /只读证据探索与上下文隔离/);
  assert.match(skill.content.openaiYaml, /使用 \$codex-explore 委派只读证据探索，并整理关键证据。/);
  assert.equal(skill.content.openaiYaml.includes('任务边界不明确'), false);
  assert.equal(skill.content.openaiYaml.includes('普通实现、修改、调试'), false);
}

async function testCustomConfigOverridesSkillTemplates() {
  const plan = await runRenderer(
    createContext({
      config: undefined,
      renderConfig: {
        values: {
          explorerModel: 'gpt-5.4-mini',
          modelReasoningEffort: 'xhigh',
          minimumInitialWaitMinutes: 20,
          convergenceWaitMinutes: 8,
        },
      },
    }),
  );
  const skill = findArtifact(plan, 'codex-explore-skill');
  const role = findArtifact(plan, 'codex-explore-agent-role');

  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, [
    'explorerModel',
    'modelReasoningEffort',
    'minimumInitialWaitMinutes',
    'convergenceWaitMinutes',
  ]);
  assert.match(skill.content.skillFile, /默认模型是 `gpt-5\.4-mini`/);
  assert.match(skill.content.skillFile, /推理强度是 `xhigh`/);
  assert.match(skill.content.skillFile, /首次最小等待为 `20` 分钟（`timeout_ms=1200000`）/);
  assert.match(skill.content.skillFile, /催促后等待为 `8` 分钟（`timeout_ms=480000`）/);
  assert.equal(role.content.roleFile.model, 'gpt-5.4-mini');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'xhigh');
}

async function testDefaultsComeFromManifestSchema() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-manifest-'));

  try {
    const contextPath = path.join(tempDir, 'context.json');
    await writeFile(
      contextPath,
      JSON.stringify(
        {
          event: 'refresh',
          platform: 'codex',
          scope: 'project',
          config: {
            mode: 'artifact-render',
            targetScope: 'project',
            values: {},
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
      },
      cwd: path.dirname(scriptPath),
    });
    const plan = JSON.parse(stdout);
    const skill = findArtifact(plan, 'codex-explore-skill');
    const role = findArtifact(plan, 'codex-explore-agent-role');

    assert.match(skill.content.skillFile, /默认模型是 `gpt-5\.6-terra`/);
    assert.match(skill.content.skillFile, /推理强度是 `low`/);
    assert.match(skill.content.skillFile, /首次最小等待为 `10` 分钟（`timeout_ms=600000`）/);
    assert.match(skill.content.skillFile, /催促后等待为 `5` 分钟（`timeout_ms=300000`）/);
    assert.equal(role.content.roleFile.model, 'gpt-5.6-terra');
    assert.equal(role.content.roleFile.model_reasoning_effort, 'low');

    const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.config.schema.explorerModel.default, 'gpt-5.6-terra');
    assert.equal(manifest.config.schema.modelReasoningEffort.default, 'low');
    assert.equal(manifest.config.schema.minimumInitialWaitMinutes.default, 10);
    assert.equal(manifest.config.schema.convergenceWaitMinutes.default, 5);
    assert.equal('enableLightweightInstruction' in manifest.config.schema, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testStaticSkillContracts() {
  const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
  const [skill, metadata] = await Promise.all([
    readFirstExisting([
      new URL('../templates/codex-explore/SKILL.md', import.meta.url),
      new URL('../codex/templates/codex-explore/SKILL.md', import.meta.url),
    ]),
    readFirstExisting([
      new URL('../templates/codex-explore/agents/openai.yaml', import.meta.url),
      new URL('../codex/templates/codex-explore/agents/openai.yaml', import.meta.url),
    ]),
  ]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.match(skill, /description: 只读证据探索委派工作流/);
  assert.match(skill, /用户明确要求使用 codex-explore 时加载，但仍须通过 Gate 才能启动子代理/);
  assert.match(skill, /目标是把会明显占用或污染主会话上下文的只读证据探索交给专用子代理/);
  assert.match(skill, /完成标准：每个委派问题得到符合证据合同的结果或明确的缺失说明/);
  assert.match(skill, /已标记为未解决且没有并行接管/);
  assert.match(skill, /跨 6 个以上文件、3 个以上模块、多来源资料、长日志、需要跨多个官方文档或网页检索/);
  assert.match(skill, /候选材料范围较大、边界未知/);
  assert.match(skill, /陌生、外部、本轮尚未建立上下文/);
  assert.match(skill, /大量可能无关的候选内容/);
  assert.match(skill, /明显占用或污染当前会话上下文/);
  assert.match(skill, /最终答案只有一个事实并不是停止理由/);
  assert.match(skill, /需要搜索、筛选和核验证据/);
  assert.match(skill, /任务目标本身是实现、修改、格式化、提交或其它写操作/);
  assert.match(skill, /无法清楚分离出只读证据探索/);
  assert.match(skill, /数量只作辅助判断/);
  assert.match(skill, /能把探索工作写成具体问题/);
  assert.match(skill, /交叉验证或独立核对假设不能单独触发本工作流/);
  assert.match(skill, /问题必须先做只读证据探索才能可靠推进/);
  assert.match(skill, /只是顺带提到 `codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill, /问题本身不需要隔离探索上下文/);
  assert.equal(skill.includes('/path/to/external-project'), false);
  assert.match(skill, /任务特征与数量阈值冲突时/);
  assert.match(skill, /先做委派价值 Gate/);
  assert.match(skill, /不满足价值条件时交回主代理，按普通任务处理/);
  assert.match(skill, /价值 Gate 通过后再检查运行能力/);
  assert.match(skill, /自带的探索 role/);
  assert.match(skill, /\{\{explorerRoleKey\}\}/);
  assert.match(skill, /调用 `spawn_agent` 时始终传 `agent_type/);
  assert.match(skill, /公开 `task_name` 时/);
  assert.match(skill, /概括具体探索目的，如 `trace_wait_agent`/);
  assert.match(skill, /重名时才追加 `_2`、`_3`/);
  assert.equal(skill.includes('codex_explore_1'), false);
  assert.match(skill, /公开 `fork_turns` 时/);
  assert.match(skill, /不得传入 schema 未公开的字段/);
  assert.match(skill, /模型、推理强度和 developer instructions 由专用 role 提供/);
  assert.match(skill, /不得启动默认子代理或改用内置 `explorer`、其它 role/);
  assert.match(skill, /把该范围视为委派失败，按后文的失败回退规则处理/);
  assert.match(skill, /当前会话的工具、联网、官方文档优先和上层安全策略/);
  assert.match(skill, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill, /不能凭记忆补事实/);
  assert.match(skill, /每个子代理的 prompt 只写本次任务需要的内容/);
  assert.match(skill, /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*期望输出/);
  assert.match(skill, /不要在 prompt 中重复专用 role 已提供的叶子代理、只读和通用证据规则/);
  assert.equal(skill.includes('`send_input`'), false);
  assert.match(skill, /子代理未终态且未确认停止期间.*不再同步调查同一个问题或同一批候选材料/s);
  assert.match(skill, /以当前会话中已有的工具返回和完成通知为准/);
  assert.match(skill, /无需为此创建额外文件、清单或外部状态/);
  assert.equal(skill.includes('主代理记录每个子任务'), false);
  assert.match(skill, /要求 `targets` 且返回 `status`/);
  assert.match(skill, /不接受 `targets` 且只返回消息或 activity 摘要/);
  assert.match(skill, /不按 Codex 版本号或配置猜测/);
  assert.match(skill, /同一终态可能同时出现在等待结果和完成通知中/);
  assert.match(skill, /按子任务引用去重/);
  assert.match(skill, /“常规等待”和“催促后等待”/);
  assert.match(skill, /首次最小等待为 `\{\{minimumInitialWaitMinutes\}\}` 分钟/);
  assert.match(skill, /`timeout_ms=\{\{minimumInitialWaitTimeoutMs\}\}`/);
  assert.match(skill, /催促后等待为 `\{\{convergenceWaitMinutes\}\}` 分钟/);
  assert.match(skill, /`timeout_ms=\{\{convergenceWaitTimeoutMs\}\}`/);
  assert.match(skill, /单次调用窗口，不是整批子代理的总时限/);
  assert.match(skill, /首次常规等待优先使用用户指定的单次时长/);
  assert.match(skill, /后续默认复用.*每次调用重新计时/s);
  assert.match(skill, /不计算剩余批次时间，也不承诺精确总时限/);
  assert.match(skill, /`timed_out: true`.*才算真正超时/);
  assert.match(skill, /向未完成代理发送一次非中断收敛请求/);
  assert.match(skill, /公开 `interrupt` 参数时显式传 `false`/);
  assert.match(skill, /催促后等待固定使用配置窗口/);
  assert.match(skill, /有停止能力时.*确认其不再运行后.*对应子任务标记为失败/s);
  assert.match(skill, /没有停止能力或无法确认终态时.*标记为未解决.*不接管或重新委派该范围/s);
  assert.match(skill, /最终答复前成功终止时按正常结果校验，否则只报告缺失/);
  assert.match(skill, /没有创建子代理的委派失败，或已确认终态或停止的失败子任务，适用以下回退/);
  assert.match(
    skill,
    /把该范围视为委派失败[\s\S]*没有创建子代理的委派失败，或已确认终态或停止的失败子任务[\s\S]*用户明确要求使用 `codex-explore`[\s\S]*本工作流自动触发时/,
  );
  assert.match(skill, /用户明确要求使用 `codex-explore` 或隔离探索上下文时.*不由主代理接管该范围/s);
  assert.match(skill, /本工作流自动触发时.*做一次最小、只读且任务相关的回退/s);
  assert.match(skill, /用户没有取消或替换原任务.*回到原等待阶段/s);
  assert.match(skill, /关键结论是否绑定实际读取且可核验的来源定位/);
  assert.match(skill, /用户材料的段落或行号/);
  assert.match(skill, /命令或工具名称及可识别的输出片段或记录 ID/);
  assert.match(skill, /直接证据、推断、来源冲突和证据缺失是否明确区分/);
  assert.match(skill, /只传 schema 公开的参数/);
  assert.match(skill, /`list_agents` 可用于状态对账，不能代替结果内容/);
  assert.match(skill, /剩余结果无论为何都不会改变结论.*不属于用户要求的覆盖范围/);
  assert.match(skill, /只有当前工具列表提供 `close_agent` 时/);
  assert.match(skill, /`interrupt_agent` 若只中断当前 turn.*不能当作正常关闭/s);
  assert.match(skill, /`wait_agent` 也不等于关闭 agent/);
  assert.match(skill, /启动重试、异常重试、空输出补问和缺失项补问合计最多一次/);
  assert.match(skill, /成功终态但没有输出/);
  assert.match(skill, /输出不符合任务或证据合同/);
  assert.match(skill, /补读子代理指出的最小必要上下文/);
  assert.match(skill, /只保留通过校验的关键结论、对应证据/);
  assert.match(skill, /不得超过当前可用并发槽位/);
  assert.match(skill, /正常结束并读取结果后/);
  assert.equal(skill.includes('Codex v1'), false);
  assert.equal(skill.includes('Codex v2'), false);
  assert.equal(skill.includes('软截止'), false);
  assert.equal(skill.includes('硬截止'), false);
  assert.equal(skill.includes('探索深度'), false);
  assert.equal(skill.includes('`quick`'), false);
  assert.equal(skill.includes('阻塞决策'), false);
  assert.equal(skill.includes('codex-explorer'), false);

  assert.match(metadata, /allow_implicit_invocation:\s*true/);
  assert.match(metadata, /short_description: "只读证据探索与上下文隔离"/);
  assert.match(metadata, /使用 \$codex-explore 委派只读证据探索，并整理关键证据。/);
  assert.equal(metadata.includes('任务边界不明确'), false);
  assert.equal(metadata.includes('普通实现、修改、调试'), false);
  assert.equal(manifest.skillTriggers?.['codex-explore']?.defaultTrigger, 'auto');
  assert.equal(manifest.skillTriggers?.['codex-explore']?.allowDynamicTrigger, true);
  assert.equal(manifest.version, '0.1.16');
  assert.equal(manifest.config.schema.explorerModel.description, 'Codex Explore 专用 role 使用的默认模型。');
  assert.equal(manifest.config.schema.modelReasoningEffort.description, 'Codex Explore 专用 role 使用的推理强度。');
  assert.equal(manifest.config.schema.minimumInitialWaitMinutes.min, 1);
  assert.equal(manifest.config.schema.minimumInitialWaitMinutes.max, 60);
  assert.equal(manifest.config.schema.convergenceWaitMinutes.min, 1);
  assert.equal(manifest.config.schema.convergenceWaitMinutes.max, 30);
  assert.deepEqual(
    manifest.config.schema.modelReasoningEffort.values,
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(manifest.marketplace?.policy?.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);
  assert.match(manifest.extensions.instructions[0].content, /调用 `codex-explore` 技能/);
  assert.match(manifest.extensions.instructions[0].content, /Gate 通过/);
  assert.match(manifest.extensions.instructions[0].content, /用户同意在该工作流中启用子代理/);
  assert.match(manifest.extensions.instructions[0].content, /Gate 未通过时不得启动子代理/);
  assert.equal(manifest.artifacts.targets.length, 2);
  if (manifest.artifacts.targets.some((target) => 'kind' in target)) {
    assert.deepEqual(
      manifest.artifacts.targets.map((target) => target.kind),
      ['skill', 'codexRole'],
    );
  }
  const normalizedTargets = manifest.artifacts.targets.map((target) => {
    const normalized = { ...target };
    delete normalized.kind;
    return normalized;
  });
  assert.deepEqual(normalizedTargets, [
    {
      id: 'codex-explore-skill',
      platform: 'codex',
      scopes: ['user', 'project'],
      target: 'codex.skill',
      projectManagedKind: 'skill',
      states: ['present'],
      refreshKeys: [
        'explorerModel',
        'modelReasoningEffort',
        'minimumInitialWaitMinutes',
        'convergenceWaitMinutes',
      ],
      skillKey: 'codex-explore',
    },
    {
      id: 'codex-explore-agent-role',
      platform: 'codex',
      scopes: ['user', 'project'],
      target: 'codex.agentRole',
      projectManagedKind: 'agent',
      states: ['present'],
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      requiresCodexProjectConfig: true,
      roleKey: 'codex-explore-agent',
    },
  ]);
  assert.deepEqual(manifest.buildConfig, {
    fileRules: {
      codex: {
        include: ['templates/**'],
        exclude: [],
      },
    },
  });
}

async function testTrimBlockDedentsWithoutLeakingIndentation() {
  const { trimBlock } = await import(scriptModuleUrl);

  const result = trimBlock(`
        第一行
          第二行

        - 列表项
          - 子项
  `);

  assert.equal(
    result,
    ['第一行', '  第二行', '', '- 列表项', '  - 子项'].join('\n'),
  );
}

async function main() {
  await testPresentSkillArtifact();
  await testCustomConfigOverridesSkillTemplates();
  await testDefaultsComeFromManifestSchema();
  await testStaticSkillContracts();
  await testTrimBlockDedentsWithoutLeakingIndentation();
  console.log('render-artifacts tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
