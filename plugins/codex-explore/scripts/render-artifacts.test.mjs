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

  assert.equal(plan.version, 1);
  assert.equal(plan.artifacts.length, 1);
  assert.equal(skill.state, 'present');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'lightweight-instruction'), false);
  assert.equal(plan.artifacts.some((entry) => entry.id === 'codex-explorer-role'), false);
  assert.equal(skill.content.skillFile.includes('codex-explorer'), false);
  assert.match(skill.content.skillFile, /Codex 内置 `explorer`/);
  assert.match(skill.content.skillFile, /agent_type: "explorer"/);
  assert.match(skill.content.skillFile, /model: "gpt-5\.4"/);
  assert.match(skill.content.skillFile, /reasoning_effort: "high"/);
  assert.match(skill.content.skillFile, /代码库、文档、网络、长日志和用户提供的材料/);
  assert.match(skill.content.skillFile, /当前会话工具可用性、联网要求、官方文档优先和上层安全策略/);
  assert.match(skill.content.skillFile, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill.content.skillFile, /不能凭记忆补事实/);
  assert.match(skill.content.skillFile, /每个 explorer 的 prompt 必须包含/);
  assert.match(
    skill.content.skillFile,
    /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*只读边界[\s\S]*期望输出/,
  );
  assert.match(skill.content.skillFile, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill.content.skillFile, /主 agent 不要重复调查同一个问题/);
  assert.match(skill.content.skillFile, /`wait_agent`.*timeout.*任务规模.*资料量.*探索深度.*explorer 数量/s);
  assert.match(skill.content.skillFile, /读取并整合结果后，立即用 `close_agent`/);
  assert.match(skill.content.skillFile, /`wait_agent` 不等于关闭 agent/);
  assert.match(skill.content.skillFile, /不要静默换模型/);
  assert.equal(skill.content.skillFile.includes('aw install'), false);
  assert.equal(skill.content.skillFile.includes('aw config'), false);
  assert.match(
    skill.content.skillFile,
    /spawn_agent\(\{[\s\S]*agent_type: "explorer"[\s\S]*model: "gpt-5\.4"[\s\S]*reasoning_effort: "high"[\s\S]*message: "\.\.\."[\s\S]*\}\)/,
  );
  assert.equal(skill.content.skillFile.includes('\n    ## 何时使用'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /代码库、文档、网络和大上下文的只读探索与多源证据总结/);
  assert.match(skill.content.openaiYaml, /使用 \$codex-explore 对这个问题做只读探索/);
  assert.match(skill.content.openaiYaml, /代码、文档、网络资料或用户提供的数据/);
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

  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.match(skill.content.skillFile, /model: "gpt-5\.4-mini"/);
  assert.match(skill.content.skillFile, /reasoning_effort: "xhigh"/);
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

    assert.match(skill.content.skillFile, /model: "gpt-5\.4-mini"/);
    assert.match(skill.content.skillFile, /reasoning_effort: "medium"/);

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

  assert.match(skill, /Codex 内置 `explorer`/);
  assert.match(skill, /代码库、文档、网络、长日志和用户提供的材料/);
  assert.match(skill, /当前会话工具可用性、联网要求、官方文档优先和上层安全策略/);
  assert.match(skill, /子代理继承当前会话可用的工具和权限/);
  assert.match(skill, /不能凭记忆补事实/);
  assert.match(skill, /只读边界/);
  assert.match(skill, /每个 explorer 的 prompt 必须包含/);
  assert.match(skill, /范围[\s\S]*资料来源[\s\S]*具体问题[\s\S]*探索深度[\s\S]*只读边界[\s\S]*期望输出/);
  assert.match(skill, /`quick`.*`medium`.*`very thorough`/s);
  assert.match(skill, /主 agent 不要重复调查同一个问题/);
  assert.match(skill, /`wait_agent`.*timeout.*任务规模.*资料量.*探索深度.*explorer 数量/s);
  assert.match(skill, /关键结论、证据路径或链接、必要行号、来源时间和不确定点/);
  assert.match(skill, /`wait_agent` 不等于关闭 agent/);
  assert.match(skill, /不要静默换模型/);
  assert.equal(skill.includes('codex-explorer'), false);

  assert.match(metadata, /allow_implicit_invocation:\s*true/);
  assert.match(metadata, /short_description: "代码库、文档、网络和大上下文的只读探索与多源证据总结"/);
  assert.match(metadata, /使用 \$codex-explore 对这个问题做只读探索/);
  assert.equal(manifest.skillTriggers?.['codex-explore']?.allowInstallOverride, true);
  assert.deepEqual(manifest.marketplace?.policy?.products, ['CODEX']);
  assert.equal(manifest.artifacts.targets.length, 1);
  assert.deepEqual(manifest.artifacts.targets[0], {
    id: 'codex-explore-skill',
    platform: 'codex',
    scopes: ['user', 'project'],
    target: 'codex.skill',
    projectManagedKind: 'skill',
    states: ['present'],
    refreshKeys: ['explorerModel', 'modelReasoningEffort'],
    skillKey: 'codex-explore',
  });
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
