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
  assert.deepEqual(skill.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(role.state, 'present');
  assert.equal(role.kind, 'codexRole');
  assert.equal(role.target, 'codex.agentRole');
  assert.equal(role.roleKey, 'codex-explore-agent');
  assert.deepEqual(role.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(role.content.registration.description, '只读探索代码、文档、网页和长上下文，并整理关键证据。');
  assert.equal(role.content.roleFile.name, 'codex-explore-agent');
  assert.equal(role.content.roleFile.description, '只读探索代码、文档、网页和长上下文，并整理关键证据。');
  assert.equal(role.content.roleFile.model, 'gpt-5.4');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'high');
  assert.match(role.content.roleFile.developer_instructions, /叶子探索子代理/);
  assert.match(role.content.roleFile.developer_instructions, /只做只读调查/);
  assert.match(role.content.roleFile.developer_instructions, /不得调用任何子代理调度或管理工具/);
  assert.match(role.content.roleFile.developer_instructions, /`send_input`、`send_message`、`followup_task`/);
  assert.match(role.content.roleFile.developer_instructions, /`resume_agent`、`close_agent`、`interrupt_agent`、`list_agents`/);
  assert.match(role.content.roleFile.developer_instructions, /也不得继续拆分/);
  assert.match(role.content.roleFile.developer_instructions, /保持只读/);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'lightweight-instruction'), false);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'codex-explorer-role'), false);
  assert.equal(skill.content.skillFile.includes('codex-explorer'), false);
  assert.match(skill.content.skillFile, /description: 只读证据探索委派 workflow/);
  assert.match(skill.content.skillFile, /用户明确要求使用 codex-explore 做只读探索时优先触发/);
  assert.match(skill.content.skillFile, /容易污染主会话上下文的只读证据探索/);
  assert.match(skill.content.skillFile, /跨 6 个以上文件、3 个以上模块、多来源资料、长日志、官方文档\/网页/);
  assert.match(skill.content.skillFile, /取证范围边界不明确/);
  assert.match(skill.content.skillFile, /陌生、外部、本轮尚未建立上下文/);
  assert.match(skill.content.skillFile, /大量候选文件、搜索结果、日志、网页或用户材料/);
  assert.match(skill.content.skillFile, /明显占用或污染当前会话上下文/);
  assert.match(skill.content.skillFile, /即使最终答案是单个事实/);
  assert.match(skill.content.skillFile, /单个事实查询只有在事实来源已知/);
  assert.match(skill.content.skillFile, /在陌生或外部大型材料中搜索、筛选和核验证据，仍应触发/);
  assert.match(skill.content.skillFile, /普通实现、修改、调试、审查、解释、提交/);
  assert.match(skill.content.skillFile, /上面的取证范围和上下文污染条件/);
  assert.match(skill.content.skillFile, /交叉验证不能单独作为启动子代理的理由/);
  assert.match(skill.content.skillFile, /或只是提到插件名时不要触发/);
  assert.match(skill.content.skillFile, /问题必须先做只读证据探索才能可靠推进/);
  assert.match(skill.content.skillFile, /只是顺带提到 `codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill.content.skillFile, /问题本身不需要隔离探索上下文/);
  assert.match(skill.content.skillFile, /探索 `\/path\/to\/external-project`/);
  assert.match(skill.content.skillFile, /如果正反例与其它阈值发生冲突/);
  assert.match(skill.content.skillFile, /先做 Gate 判断/);
  assert.match(skill.content.skillFile, /优先使用 Codex Explore 自带的探索子代理/);
  assert.match(skill.content.skillFile, /以当前工具实际公开的参数为准/);
  assert.match(skill.content.skillFile, /不得传入 schema 未公开的字段/);
  assert.match(skill.content.skillFile, /task_name: "codex_explore_1"/);
  assert.match(skill.content.skillFile, /agent_type: "codex-explore-agent"/);
  assert.match(skill.content.skillFile, /fork_turns: "none"/);
  assert.match(skill.content.skillFile, /默认模型 `gpt-5\.4`/);
  assert.match(skill.content.skillFile, /推理强度 `high`/);
  assert.match(skill.content.skillFile, /继承父代理模型和推理强度/);
  assert.match(skill.content.skillFile, /配置的 `gpt-5\.4` \/ `high` 不会应用/);
  assert.match(skill.content.skillFile, /不得声称专用 role 已生效/);
  assert.match(skill.content.skillFile, /不要改用 Codex 内置 `explorer`/);
  assert.match(skill.content.skillFile, /立即停止使用本 workflow/);
  assert.match(skill.content.skillFile, /当前会话的工具、联网、官方文档优先和上层安全策略/);
  assert.match(skill.content.skillFile, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill.content.skillFile, /不能凭记忆补事实/);
  assert.match(skill.content.skillFile, /每个子代理的 prompt 至少写清/);
  assert.match(
    skill.content.skillFile,
    /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*委派边界[\s\S]*只读边界[\s\S]*期望输出/,
  );
  assert.match(skill.content.skillFile, /叶子探索代理，不得调用任何子代理调度或管理工具/);
  assert.match(skill.content.skillFile, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill.content.skillFile, /主 agent 不要重复探索同一个问题/);
  assert.match(skill.content.skillFile, /`wait_agent\.timeout_ms`.*任务规模.*资料量.*探索深度.*子代理数量/s);
  assert.match(skill.content.skillFile, /按当前工具实际公开的 schema 传参/);
  assert.match(skill.content.skillFile, /v2 的 `wait_agent` 可能只返回 mailbox 更新摘要/);
  assert.match(skill.content.skillFile, /只有当前工具列表提供 `close_agent` 时/);
  assert.match(skill.content.skillFile, /`interrupt_agent` 只用于取消仍在运行的任务/);
  assert.match(skill.content.skillFile, /`wait_agent` 只负责等待，不等于关闭 agent/);
  assert.match(skill.content.skillFile, /不要静默换到内置 `explorer`/);
  assert.equal(skill.content.skillFile.includes('aw install'), false);
  assert.equal(skill.content.skillFile.includes('aw config'), false);
  assert.match(
    skill.content.skillFile,
    /spawn_agent\(\{\n  task_name: "codex_explore_1",\n  agent_type: "codex-explore-agent",\n  fork_turns: "none",\n  message: "\.\.\."\n\}\)/,
  );
  assert.match(
    skill.content.skillFile,
    /spawn_agent\(\{\n  agent_type: "codex-explore-agent",\n  message: "\.\.\."\n\}\)/,
  );
  assert.match(
    skill.content.skillFile,
    /spawn_agent\(\{\n  task_name: "codex_explore_1",\n  fork_turns: "none",\n  message: "\.\.\."\n\}\)/,
  );
  assert.equal(skill.content.skillFile.includes('\n    ## 何时使用'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /只读证据探索与上下文隔离/);
  assert.match(skill.content.openaiYaml, /使用 \$codex-explore 做只读证据探索，隔离大量候选材料并总结关键证据。/);
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
        },
      },
    }),
  );
  const skill = findArtifact(plan, 'codex-explore-skill');
  const role = findArtifact(plan, 'codex-explore-agent-role');

  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.match(skill.content.skillFile, /默认模型 `gpt-5\.4-mini`/);
  assert.match(skill.content.skillFile, /推理强度 `xhigh`/);
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

    assert.match(skill.content.skillFile, /默认模型 `gpt-5\.4-mini`/);
    assert.match(skill.content.skillFile, /推理强度 `low`/);
    assert.equal(role.content.roleFile.model, 'gpt-5.4-mini');
    assert.equal(role.content.roleFile.model_reasoning_effort, 'low');

    const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.config.schema.explorerModel.default, 'gpt-5.4-mini');
    assert.equal(manifest.config.schema.modelReasoningEffort.default, 'low');
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

  assert.match(skill, /description: 只读证据探索委派 workflow/);
  assert.match(skill, /用户明确要求使用 codex-explore 做只读探索时优先触发/);
  assert.match(skill, /容易污染主会话上下文的只读证据探索/);
  assert.match(skill, /跨 6 个以上文件、3 个以上模块、多来源资料、长日志、官方文档\/网页/);
  assert.match(skill, /取证范围边界不明确/);
  assert.match(skill, /陌生、外部、本轮尚未建立上下文/);
  assert.match(skill, /大量候选文件、搜索结果、日志、网页或用户材料/);
  assert.match(skill, /明显占用或污染当前会话上下文/);
  assert.match(skill, /即使最终答案是单个事实/);
  assert.match(skill, /单个事实查询只有在事实来源已知/);
  assert.match(skill, /在陌生或外部大型材料中搜索、筛选和核验证据，仍应触发/);
  assert.match(skill, /普通实现、修改、调试、审查、解释、提交/);
  assert.match(skill, /上面的取证范围和上下文污染条件/);
  assert.match(skill, /交叉验证不能单独作为启动子代理的理由/);
  assert.match(skill, /或只是提到插件名时不要触发/);
  assert.match(skill, /问题必须先做只读证据探索才能可靠推进/);
  assert.match(skill, /只是顺带提到 `codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill, /问题本身不需要隔离探索上下文/);
  assert.match(skill, /探索 `\/path\/to\/external-project`/);
  assert.match(skill, /如果正反例与其它阈值发生冲突/);
  assert.match(skill, /先做 Gate 判断/);
  assert.match(skill, /自带的探索子代理/);
  assert.match(skill, /\{\{explorerRoleKey\}\}/);
  assert.match(skill, /同时公开 `task_name` 和 `agent_type`/);
  assert.match(skill, /公开 `agent_type` 但不公开 `task_name`/);
  assert.match(skill, /公开 `task_name` 但不公开 `agent_type`/);
  assert.match(skill, /不得传入 schema 未公开的字段/);
  assert.match(skill, /fork_turns: "none"/);
  assert.match(skill, /继承父代理模型和推理强度/);
  assert.match(skill, /不要静默换到内置 `explorer`/);
  assert.match(skill, /当前会话的工具、联网、官方文档优先和上层安全策略/);
  assert.match(skill, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill, /不能凭记忆补事实/);
  assert.match(skill, /只读边界/);
  assert.match(skill, /每个子代理的 prompt 至少写清/);
  assert.match(skill, /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*委派边界[\s\S]*只读边界[\s\S]*期望输出/);
  assert.match(skill, /叶子探索代理，不得调用任何子代理调度或管理工具/);
  assert.match(skill, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill, /主 agent 不要重复探索同一个问题/);
  assert.match(skill, /`wait_agent\.timeout_ms`.*任务规模.*资料量.*探索深度.*子代理数量/s);
  assert.match(skill, /关键结论、证据路径或链接、必要行号、来源时间和不确定点/);
  assert.match(skill, /按当前工具实际公开的 schema 传参/);
  assert.match(skill, /只有当前工具列表提供 `close_agent` 时/);
  assert.match(skill, /`interrupt_agent` 只用于取消仍在运行的任务/);
  assert.match(skill, /`wait_agent` 只负责等待，不等于关闭 agent/);
  assert.match(skill, /不要静默换到内置 `explorer`/);
  assert.equal(skill.includes('codex-explorer'), false);

  assert.match(metadata, /allow_implicit_invocation:\s*true/);
  assert.match(metadata, /short_description: "只读证据探索与上下文隔离"/);
  assert.match(metadata, /使用 \$codex-explore 做只读证据探索，隔离大量候选材料并总结关键证据。/);
  assert.equal(metadata.includes('任务边界不明确'), false);
  assert.equal(metadata.includes('普通实现、修改、调试'), false);
  assert.equal(manifest.skillTriggers?.['codex-explore']?.defaultTrigger, 'auto');
  assert.equal(manifest.skillTriggers?.['codex-explore']?.allowDynamicTrigger, true);
  assert.equal(manifest.version, '0.1.9');
  assert.match(manifest.config.schema.explorerModel.description, /仅在 spawn_agent 公开 agent_type 时生效/);
  assert.match(manifest.config.schema.modelReasoningEffort.description, /否则子代理继承父代理推理强度/);
  assert.deepEqual(manifest.marketplace?.policy?.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);
  assert.match(manifest.extensions.instructions[0].content, /调用 `codex-explore` 技能/);
  assert.match(manifest.extensions.instructions[0].content, /Gate 通过/);
  assert.match(manifest.extensions.instructions[0].content, /用户同意在该 workflow 中启用子代理/);
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
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
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
