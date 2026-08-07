import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    return {
      sourceRoot: localPluginRoot,
      bundleRoot: localPluginRoot,
      platform: null,
    };
  }

  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'ask-me');
  assert.equal(context.plugin.version, '0.1.0');
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

function assertCoreContract(skill) {
  assert.equal(skill.includes('[TODO:'), false);
  assert.match(skill, /隐式调用.*显著影响目标、范围、行为、接口、数据、兼容性、约束、验收或可行性/s);
  assert.match(skill, /显式调用.*隐藏假设压力测试/s);
  assert.match(skill, /不得创建、修改或删除文件/);
  assert.match(skill, /不得制作原型/);
  assert.match(skill, /不向用户询问能够自行查明的事实/);
  assert.match(skill, /当前“决策前沿”/);
  assert.match(skill, /有依赖关系时，一次只问最关键的一题/);
  assert.match(skill, /彼此独立时，一轮最多问三题/);
  assert.match(skill, /没有固定的总问题数/);
  assert.match(
    skill,
    /优先使用 (?:\{\{questionTool\}\}|`request_user_input`|`AskUserQuestion`)/,
  );
  assert.match(skill, /两个或三个互斥且有效的单选选项/);
  assert.match(skill, /仓库证据、明确成本或通行约束/);
  assert.match(skill, /不静默改写用户意图/);
  assert.match(skill, /用户表示不知道、要求停止或不愿继续时/);
  assert.match(skill, /不得声称需求已经稳定/);
  assert.match(skill, /不要求固定摘要、再次确认或建议下一步/);
  assert.match(skill, /后续行为由外层请求和适用指令决定/);
}

const context = await resolveContext();

test('manifest declares a dual-platform configurable automatic skill', async () => {
  const manifest = await readJson(
    path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'),
  );

  assert.equal(manifest.name, 'ask-me');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.skillTriggers, {
    'ask-me': {
      defaultTrigger: 'auto',
      allowDynamicTrigger: true,
    },
  });
  assert.deepEqual(manifest.marketplace, {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'NONE',
    },
  });
  assert.equal('products' in manifest.marketplace.policy, false);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  assert.deepEqual(manifest.buildConfig, {
    templates: {
      include: ['skills/**/*.md'],
      vars: {
        questionTool: {
          claude: '`AskUserQuestion`',
          codex: '`request_user_input`',
        },
      },
    },
  });
  assert.deepEqual(manifest.scripts.tests.node, ['./scripts/contract.test.mjs']);
  assert.equal('extensions' in manifest, false);
  assert.equal('dependencies' in manifest, false);
  assert.equal('mcpServers' in manifest, false);
  assert.equal('apps' in manifest, false);
  assert.equal('slashCommands' in manifest, false);
});

test('source skill and Codex metadata preserve the clarification-only contract', async () => {
  const [skill, openaiYaml] = await Promise.all([
    readFile(path.join(context.sourceRoot, 'skills', 'ask-me', 'SKILL.md'), 'utf8'),
    readFile(
      path.join(context.sourceRoot, 'skills', 'ask-me', 'agents', 'openai.yaml'),
      'utf8',
    ),
  ]);

  assertCoreContract(skill);
  assert.match(skill, /^name: ask-me$/m);
  assert.match(skill, /^description: .*不要自动使用。"$/m);
  assert.match(skill, /优先使用 \{\{questionTool\}\}/);
  assert.equal(skill.includes('request_user_input'), false);
  assert.equal(skill.includes('AskUserQuestion'), false);
  assert.doesNotMatch(skill, /^user-invocable:\s*false$/m);
  assert.doesNotMatch(skill, /^disable-model-invocation:\s*true$/m);
  assert.match(openaiYaml, /default_prompt: "使用 \$ask-me：/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
});

test('trigger corpus is balanced and split for author evaluation', async () => {
  const document = await readJson(
    path.join(context.sourceRoot, 'evals', 'trigger-cases.json'),
  );
  const { cases } = document;

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'ask-me');
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 20);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 12);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 10);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 10);
  assert.equal(
    cases.filter((entry) => entry.split === 'train' && entry.should_load_skill).length,
    6,
  );
  assert.equal(
    cases.filter((entry) => entry.split === 'validation' && entry.should_load_skill).length,
    4,
  );
  assert.deepEqual(
    new Set(cases.filter((entry) => entry.should_load_skill).flatMap((entry) => entry.tags)),
    new Set(['ambiguous', 'conflict', 'infeasible', 'explicit']),
  );
  assert.deepEqual(
    new Set(cases.filter((entry) => !entry.should_load_skill).flatMap((entry) => entry.tags)),
    new Set(['complete-spec', 'fact-question', 'low-risk']),
  );
  assert.equal(
    cases.filter((entry) => entry.tags.includes('explicit')).every(
      (entry) => entry.query.includes('$ask-me') || entry.query.includes('/ask-me'),
    ),
    true,
  );
});

test('trigger suite delegates execution to the central native driver', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, 'evals', 'manifest.json'));
  const trigger = manifest.suites.find((suite) => suite.id === 'trigger');
  assert.deepEqual(trigger, {
    id: 'trigger',
    kind: 'trigger',
    skill: 'ask-me',
    cases: './evals/trigger-cases.json',
    observeSpawnAgent: false,
    isolation: 'standard',
    strictNegativeSplits: ['validation'],
    profiles: ['project-default'],
    defaultRuns: 3,
    releaseSplits: ['validation'],
    requiredForRelease: true,
    perRunTimeoutMs: 180000,
  });
});

test('behavior corpus stays cross-platform while exposing structured Codex v1 replies', async () => {
  const corpus = await readJson(path.join(context.sourceRoot, 'evals', 'evals.json'));

  assert.equal(corpus.skill_name, 'ask-me');
  assert.deepEqual(
    corpus.evals.map((entry) => entry.id),
    [
      'inspect_then_adapt',
      'challenge_infeasible_requirement',
      'preserve_unknowns_on_stop',
      'explicit_complete_spec_no_question',
    ],
  );
  for (const entry of corpus.evals) {
    assert.ok(entry.prompt.length > 0);
    assert.ok(entry.expected_output.length > 0);
    assert.deepEqual(entry.files, []);
    assert.equal(Array.isArray(entry.scripted_replies), true);
    for (const reply of entry.scripted_replies) {
      assert.equal(Number.isInteger(reply.expected_question_count), true);
      assert.equal(reply.expected_question_count >= 0, true);
      assert.equal(Array.isArray(reply.answers_by_index), true);
      assert.equal(reply.answers_by_index.every((answer) => typeof answer === 'string'), true);
      assert.equal(typeof reply.unexpected_question_answer, 'string');
      assert.ok(reply.unexpected_question_answer.length > 0);
    }
    assert.deepEqual(entry.review.platforms, ['codex', 'claude']);
    assert.equal(entry.review.clean_session, true);
    assert.equal(entry.review.workspace_unchanged, true);
    assert.ok(entry.review.checks.length >= 4);
  }

  const inspectThenAdapt = corpus.evals.find((entry) => entry.id === 'inspect_then_adapt');
  assert.equal(inspectThenAdapt.scripted_replies.length, 2);
  assert.deepEqual(
    inspectThenAdapt.scripted_replies.map((reply) => reply.expected_question_count),
    [1, 1],
  );
  assert.match(inspectThenAdapt.expected_output, /第二轮得到答复后结束澄清/);

  const explicitComplete = corpus.evals.find(
    (entry) => entry.id === 'explicit_complete_spec_no_question',
  );
  assert.match(explicitComplete.prompt, /^\$ask-me /);
  assert.deepEqual(explicitComplete.scripted_replies, []);
  assert.match(explicitComplete.expected_output, /不调用提问工具/);

  const readme = await readFile(
    path.join(context.sourceRoot, 'evals', 'README.md'),
    'utf8',
  );
  assert.match(readme, /不能替代这里的 Codex 行为评测/);
  assert.match(readme, /pnpm plugin:eval ask-me --materialize-only/);
  assert.match(readme, /全新的 Codex app-server 会话/);
  assert.match(readme, /Claude 模型行为暂不在 v1 范围内/);
});

test('prepared bundle exposes automatic and manual entry points on both platforms', async () => {
  if (!context.platform) {
    return;
  }

  const skillRoot = path.join(
    context.bundleRoot,
    context.platform,
    'skills',
    'ask-me',
  );
  const [platformManifest, skill, openaiYaml] = await Promise.all([
    readJson(
      path.join(
        context.bundleRoot,
        `.${context.platform}-plugin`,
        'plugin.json',
      ),
    ),
    readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
    readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
  ]);

  assert.equal(platformManifest.name, 'ask-me');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);
  assertCoreContract(skill);
  const expectedTool = context.platform === 'codex'
    ? '`request_user_input`'
    : '`AskUserQuestion`';
  const otherTool = context.platform === 'codex'
    ? '`AskUserQuestion`'
    : '`request_user_input`';
  assert.match(skill, new RegExp(`优先使用 ${expectedTool}`));
  assert.equal(skill.includes(otherTool), false);
  assert.equal(skill.includes('{{questionTool}}'), false);
  assert.doesNotMatch(skill, /^user-invocable:\s*false$/m);
  assert.doesNotMatch(skill, /^disable-model-invocation:\s*true$/m);
  assert.match(openaiYaml, /default_prompt: "使用 \$ask-me：/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
});
