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
  assert.equal(role.content.registration.description, '只读探索代码库、文档、网络资料和长上下文，并返回证据摘要。');
  assert.equal(role.content.roleFile.name, 'codex-explore-agent');
  assert.equal(role.content.roleFile.description, '只读探索代码库、文档、网络资料和长上下文，并返回证据摘要。');
  assert.equal(role.content.roleFile.model, 'gpt-5.4');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'high');
  assert.match(role.content.roleFile.developer_instructions, /只读探索子代理/);
  assert.match(role.content.roleFile.developer_instructions, /叶子只读探索子代理/);
  assert.match(role.content.roleFile.developer_instructions, /不得调用 `spawn_agent`、`wait_agent`、`close_agent`/);
  assert.match(role.content.roleFile.developer_instructions, /不得把任务再拆给任何子代理/);
  assert.match(role.content.roleFile.developer_instructions, /严格保持只读/);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'lightweight-instruction'), false);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'codex-explorer-role'), false);
  assert.equal(skill.content.skillFile.includes('codex-explorer'), false);
  assert.match(skill.content.skillFile, /description: 只读大范围探索委派 workflow/);
  assert.match(skill.content.skillFile, /用户明确要求使用 codex-explore\/\$codex-explore 做只读探索时优先触发/);
  assert.match(skill.content.skillFile, /大范围只读证据探索/);
  assert.match(skill.content.skillFile, /跨 6 个以上文件、3 个以上模块、多来源材料、长日志、网页\/官方文档/);
  assert.match(skill.content.skillFile, /任务边界不明确，需要大量探查、筛选和排除材料/);
  assert.match(skill.content.skillFile, /直接由主 agent 探查会明显占用上下文时触发/);
  assert.match(skill.content.skillFile, /普通实现、修改、调试、审查、解释、提交/);
  assert.match(skill.content.skillFile, /交叉验证不能单独作为启动子代理的理由/);
  assert.match(skill.content.skillFile, /或只是提到 codex-explore\/\$codex-explore\/plugins\/codex-explore 时不要触发/);
  assert.match(skill.content.skillFile, /任务需要只读证据探查才能可靠推进/);
  assert.match(skill.content.skillFile, /只是顺带提到 `codex-explore`、`\$codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill.content.skillFile, /先只做 Gate 判断/);
  assert.match(skill.content.skillFile, /默认使用 Codex Explore 受管子代理/);
  assert.match(skill.content.skillFile, /agent_type: "codex-explore-agent"/);
  assert.match(skill.content.skillFile, /默认模型 `gpt-5\.4`/);
  assert.match(skill.content.skillFile, /推理强度 `high`/);
  assert.match(skill.content.skillFile, /不要改用 Codex 内置 `explorer`/);
  assert.match(skill.content.skillFile, /立即停止使用本 workflow/);
  assert.match(skill.content.skillFile, /当前会话工具可用性、联网要求、官方文档优先和上层安全策略/);
  assert.match(skill.content.skillFile, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill.content.skillFile, /不能凭记忆补事实/);
  assert.match(skill.content.skillFile, /每个子代理的 prompt 必须包含/);
  assert.match(
    skill.content.skillFile,
    /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*委派边界[\s\S]*只读边界[\s\S]*期望输出/,
  );
  assert.match(skill.content.skillFile, /叶子探索代理，不得调用 `spawn_agent`、`wait_agent`、`close_agent` 或再拆子任务/);
  assert.match(skill.content.skillFile, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill.content.skillFile, /主 agent 不要重复调查同一个问题/);
  assert.match(skill.content.skillFile, /`wait_agent`.*timeout.*任务规模.*资料量.*探索深度.*子代理数量/s);
  assert.match(skill.content.skillFile, /读取并整合结果后，立即用 `close_agent`/);
  assert.match(skill.content.skillFile, /`wait_agent` 不等于关闭 agent/);
  assert.match(skill.content.skillFile, /不要静默换到内置 `explorer`/);
  assert.equal(skill.content.skillFile.includes('aw install'), false);
  assert.equal(skill.content.skillFile.includes('aw config'), false);
  assert.match(
    skill.content.skillFile,
    /spawn_agent\(\{[\s\S]*agent_type: "codex-explore-agent"[\s\S]*message: "\.\.\."[\s\S]*\}\)/,
  );
  assert.equal(skill.content.skillFile.includes('\n    ## 何时使用'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /大范围材料探查与证据筛选的只读委派/);
  assert.match(skill.content.openaiYaml, /用户明确要求使用 \$codex-explore 做只读探索时优先触发/);
  assert.match(skill.content.openaiYaml, /任务边界不明确，需要大量探查、筛选和排除材料/);
  assert.match(skill.content.openaiYaml, /跨 6 个以上文件、3 个以上模块、多来源、长日志、网页\/官方文档或大段用户材料/);
  assert.match(skill.content.openaiYaml, /直接由主 agent 探查会明显占用上下文时才委派子代理/);
  assert.match(skill.content.openaiYaml, /普通实现、修改、调试、审查、解释、提交、2 到 3 个文件定位、单纯交叉验证或只是顺带提到插件名都不要触发/);
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
    assert.match(skill.content.skillFile, /推理强度 `medium`/);
    assert.equal(role.content.roleFile.model, 'gpt-5.4-mini');
    assert.equal(role.content.roleFile.model_reasoning_effort, 'medium');

    const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.config.schema.explorerModel.default, 'gpt-5.4-mini');
    assert.equal(manifest.config.schema.modelReasoningEffort.default, 'medium');
    assert.equal('enableLightweightInstruction' in manifest.config.schema, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testStaticSkillContracts() {
  const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
  const [skill, metadata] = await Promise.all([
    readFirstExisting([
      new URL('../skills/codex-explore/SKILL.md', import.meta.url),
      new URL('../codex/skills/codex-explore/SKILL.md', import.meta.url),
    ]),
    readFirstExisting([
      new URL('../skills/codex-explore/agents/openai.yaml', import.meta.url),
      new URL('../codex/skills/codex-explore/agents/openai.yaml', import.meta.url),
    ]),
  ]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.match(skill, /description: 只读大范围探索委派 workflow/);
  assert.match(skill, /用户明确要求使用 codex-explore\/\$codex-explore 做只读探索时优先触发/);
  assert.match(skill, /大范围只读证据探索/);
  assert.match(skill, /跨 6 个以上文件、3 个以上模块、多来源材料、长日志、网页\/官方文档/);
  assert.match(skill, /任务边界不明确，需要大量探查、筛选和排除材料/);
  assert.match(skill, /直接由主 agent 探查会明显占用上下文时触发/);
  assert.match(skill, /普通实现、修改、调试、审查、解释、提交/);
  assert.match(skill, /交叉验证不能单独作为启动子代理的理由/);
  assert.match(skill, /或只是提到 codex-explore\/\$codex-explore\/plugins\/codex-explore 时不要触发/);
  assert.match(skill, /任务需要只读证据探查才能可靠推进/);
  assert.match(skill, /只是顺带提到 `codex-explore`、`\$codex-explore` 或 `plugins\/codex-explore`/);
  assert.match(skill, /先只做 Gate 判断/);
  assert.match(skill, /受管子代理/);
  assert.match(skill, /\{\{explorerRoleKey\}\}/);
  assert.match(skill, /不要静默换到内置 `explorer`/);
  assert.match(skill, /当前会话工具可用性、联网要求、官方文档优先和上层安全策略/);
  assert.match(skill, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill, /不能凭记忆补事实/);
  assert.match(skill, /只读边界/);
  assert.match(skill, /每个子代理的 prompt 必须包含/);
  assert.match(skill, /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*委派边界[\s\S]*只读边界[\s\S]*期望输出/);
  assert.match(skill, /叶子探索代理，不得调用 `spawn_agent`、`wait_agent`、`close_agent` 或再拆子任务/);
  assert.match(skill, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill, /主 agent 不要重复调查同一个问题/);
  assert.match(skill, /`wait_agent`.*timeout.*任务规模.*资料量.*探索深度.*子代理数量/s);
  assert.match(skill, /关键结论、证据路径或链接、必要行号、来源时间和不确定点/);
  assert.match(skill, /`wait_agent` 不等于关闭 agent/);
  assert.match(skill, /不要静默换到内置 `explorer`/);
  assert.equal(skill.includes('codex-explorer'), false);

  assert.match(metadata, /allow_implicit_invocation:\s*true/);
  assert.match(metadata, /short_description: "大范围材料探查与证据筛选的只读委派"/);
  assert.match(metadata, /用户明确要求使用 \$codex-explore 做只读探索时优先触发/);
  assert.match(metadata, /任务边界不明确，需要大量探查、筛选和排除材料/);
  assert.match(metadata, /普通实现、修改、调试、审查、解释、提交、2 到 3 个文件定位、单纯交叉验证或只是顺带提到插件名都不要触发/);
  assert.equal(manifest.skillTriggers?.['codex-explore']?.allowInstallOverride, true);
  assert.deepEqual(manifest.marketplace?.policy?.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);
  assert.match(manifest.extensions.instructions[0].content, /只有主 agent 可以/);
  assert.match(manifest.extensions.instructions[0].content, /第一层 Codex Explore 子代理/);
  assert.match(manifest.extensions.instructions[0].content, /授权不传递给探索子代理/);
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
  assert.equal('buildConfig' in manifest, false);
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
