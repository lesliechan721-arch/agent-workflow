import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderArtifactPlan } from './render-artifacts.mjs';

// plugin:test runs the real bundle, whose Skill roots exclude author-only evals and reports.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const testContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : undefined;
const sourceManifest = testContext
  ? JSON.parse(await readFile(path.join(testContext.sourceRoot, '.agents-plugin/plugin.json'), 'utf8'))
  : manifest;
const platforms = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok', 'generic'];
const manualSkills = ['dev-workflow', 'dev-design', 'dev-correct', 'dev-verify-author'];
const skillNames = [...manualSkills, 'dev-investigate', 'dev-debug', 'dev-architect', 'dev-arena', 'dev-tdd', 'dev-review', 'dev-verify', 'dev-benchmark'];
const fields = ['arenaRunners', 'arenaCrossJudge', 'reviewAdversaries'];
const configured = {
  arenaRunners: [
    { model: 'fixture-candidate-native' },
    { executor: 'fixture-external', model: 'fixture-candidate-external', reasoningEffort: 'high' },
  ],
  arenaCrossJudge: { executor: 'fixture-judge', model: 'fixture-judge-model', reasoningEffort: 'max' },
  reviewAdversaries: [
    { executor: 'native', model: 'fixture-review-native', reasoningEffort: 'medium' },
    { executor: 'fixture-review-external' },
  ],
};
const kinds = ['skill', 'agent', 'mcp', 'hook', 'instruction'];

// Offline V3 profile fixture, not a claim of native-client execution qualification.
function context(platform, values, allowedOutputKinds = ['skill'], scope = 'user') {
  const generic = platform === 'generic';
  const agentNamingMode = ['opencode', 'generic'].includes(platform) ? 'unsupported' : platform === 'claude' ? 'host-plugin' : 'aw-prefix';
  const filePrefix = agentNamingMode === 'aw-prefix' ? 'aw-fixture-dev-workflow-' : '';
  const supported = { status: 'supported', reasonCodes: [] };
  const unsupported = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
  const kindFacts = Object.fromEntries(kinds.map((kind) => {
    if ((generic && kind !== 'skill') || (platform === 'opencode' && kind === 'agent')) {
      return [kind, { ...unsupported, delivery: [] }];
    }
    const supplement = (platform === 'codex' && kind === 'agent') || (platform === 'grok' && kind === 'instruction');
    const delivery = generic ? 'generic-files' : supplement ? 'managed-host-resource'
      : ['opencode', 'pi'].includes(platform) ? 'native-extension' : 'native-package';
    return [kind, { ...supported, delivery: [delivery] }];
  }));
  return {
    schemaVersion: 3, surface: 'agent-plugin', platform, scope, allowedOutputKinds,
    plugin: { pluginId: 'fixture/dev-workflow', name: 'dev-workflow', version: manifest.version },
    config: {
      schema: manifest.config, values,
      sources: Object.fromEntries(fields.map((field) => [field, Object.hasOwn(values, field) ? 'platform' : 'missing'])),
      issues: [],
    },
    changedConfigKeys: [], previousComponents: [],
    resources: ['./shared', ...skillNames.map((name) => `./skills/${name}`)].map((name) => ({
      kind: 'bundle', name, root: path.join(root, name), digest: `sha256:${'0'.repeat(64)}`,
    })),
    agentNaming: { mode: agentNamingMode, filePrefix, invocationPrefix: agentNamingMode === 'host-plugin' ? 'dev-workflow:' : filePrefix },
    platformCapabilities: {
      schemaVersion: 3, platform, scope, basis: 'profile', agentNamingMode,
      kinds: kindFacts,
      features: {
        'skill.invocation.manual': generic ? unsupported : { ...supported, values: ['claude', 'copilot', 'grok'].includes(platform) ? ['false', 'true'] : ['true'] },
        'skill.invocation.model': generic ? unsupported : { ...supported, values: ['false', 'true'] },
      },
    },
  };
}

// Test Value Gate: configuration consumers depend on the public manifest profile contract.
test('declares the 12-Skill dynamic plugin and three optional platform-only panel controls', () => {
  assert.deepEqual(manifest.platforms, platforms);
  assert.deepEqual(manifest.dependencies, ['decision-kit', 'human-content', 'agent-subagent']);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  assert.equal(manifest.skills, undefined);
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.config.schemaVersion, 5);
  assert.deepEqual(manifest.artifacts.configKeys, fields);
  assert.deepEqual(Object.keys(manifest.config.fields), fields);
  const { definitions } = sourceManifest.config;
  const { fields: declared } = manifest.config;
  for (const field of Object.values(declared)) {
    assert.equal(field.platformOnly, true);
    assert.notEqual(field.required, true);
    assert.equal(field.default, undefined);
  }
  assert.deepEqual(definitions.agentExecutor.valueRef, {
    plugin: 'agent-subagent', field: 'subagentCommands', key: 'key', include: ['native'],
  });
  assert.deepEqual(definitions.agentExecutor.clearsOnChange, ['model', 'reasoningEffort']);
  for (const [key, hint] of [['arenaRunners', 'strong'], ['arenaCrossJudge', 'deep'], ['reviewAdversaries', 'strong']]) {
    const field = declared[key];
    if (key !== 'arenaCrossJudge') assert.equal(field.validation.maxItems, 8);
    const { plugin, provider, hint: actualHint, dependsOn, targets } = (field.items ?? field).suggestions;
    assert.deepEqual({ plugin, provider, hint: actualHint, dependsOn, targets }, {
      plugin: 'agent-subagent', provider: 'executor-model-profile', hint, dependsOn: ['executor'], targets: ['model', 'reasoningEffort'],
    });
    // The installed bundle has expanded the author's local $refs.
    if (testContext) {
      const { executor, model, reasoningEffort } = (field.items ?? field).properties;
      assert.deepEqual(executor.valueRef, definitions.agentExecutor.valueRef);
      assert.deepEqual(executor.clearsOnChange, definitions.agentExecutor.clearsOnChange);
      assert.deepEqual(model.suggestions, definitions.agentModel.suggestions);
      assert.deepEqual(reasoningEffort.suggestions, definitions.agentReasoningEffort.suggestions);
    }
  }
});

async function materializedFiles(component) {
  return Object.fromEntries(await Promise.all(Object.entries(component.content.files).map(async ([name, resource]) => {
    assert.ok(!path.posix.isAbsolute(name) && !name.includes('\\') && !name.split('/').some((segment) => segment === '..' || segment === ''), name);
    assert.ok(!/^(?:evals|reports)\//u.test(name), `${component.name} -> author-only ${name}`);
    if ('text' in resource) {
      assert.equal(typeof resource.text, 'string');
      return [name, resource.text];
    }
    assert.equal(resource.source.kind, 'bundle');
    const source = resource.source.path;
    assert.ok(manifest.artifacts.sourceDirs.some((directory) => source.startsWith(`${directory.replace(/^\.\//u, '')}/`)), source);
    assert.ok(!path.posix.isAbsolute(source) && !source.includes('\\') && !source.split('/').includes('..'), source);
    return [name, await readFile(path.join(root, source), 'utf8')];
  })));
}

function assertSkillClosure(skillName, files) {
  assert.ok(Object.hasOwn(files, 'README.md'), skillName);
  for (const [name, body] of Object.entries(files)) {
    if (!name.endsWith('.md')) continue;
    if (!name.includes('/')) assert.ok(['SKILL.md', 'README.md'].includes(name), `${skillName}/${name}`);
    // Static contract exception: unresolved placeholders or internal routing details in a published Skill can break its instructions; behavior test is not suitable because consumers read the rendered Markdown itself.
    assert.doesNotMatch(body, /<!--|@@[A-Z0-9_]+@@|\{\{aw\.agent:|--instructions-file|worker-instructions|workerProfile|arenaRunners|arenaCrossJudge|reviewAdversaries/u, `${skillName}/${name}`);
    // Static contract exception: a published instruction must not direct an Agent to retired capabilities; behavior test is not suitable because absence of stale references is a contract of the delivered text.
    assert.doesNotMatch(body, /\b(?:verify-project|measure-performance|author-project-verification|dev-worker|dev-build|dev-implement|dev-breakdown|dev-spec|dev-review-code|dev-review-spec|dev-review-loop|dev-simplify-code|decision-shape|project-context|source-fidelity|decisions-template)\b/u, `${skillName}/${name}`);
    for (const [, reference] of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) || reference.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference.split('#', 1)[0]));
      assert.ok(Object.hasOwn(files, target), `${skillName}/${name} -> ${reference}`);
    }
    // Prompt reading pointers are relative to the Skill root, including inside a playbook.
    for (const [, reference] of body.matchAll(/`((?:references|assets|principles|playbooks|scripts)\/[\w./-]+\.(?:md|mjs))`/gu)) {
      assert.ok(Object.hasOwn(files, reference), `${skillName}/${name} -> ${reference}`);
    }
  }
}

function fieldValue(text, name) {
  const value = text.split('\n').map((line) => line.trim()).find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  if (value?.startsWith('"')) return JSON.parse(value);
  return value?.replace(/^'(.*)'$/u, '$1');
}

function yamlSection(text, name) {
  return text.match(new RegExp(`^${name}:\\s*\\r?\\n((?:[ \\t]+[^\\r\\n]*\\r?\\n?)+)`, 'mu'))?.[1] ?? '';
}

function assertMetadata(skillName, files, platform) {
  const frontmatter = files['SKILL.md']?.match(/^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  assert.ok(frontmatter, skillName);
  assert.equal(fieldValue(frontmatter, 'name'), skillName);
  assert.ok(fieldValue(frontmatter, 'description'));
  assert.ok(fieldValue(frontmatter, 'compatibility'));
  assert.ok(fieldValue(yamlSection(frontmatter, 'metadata'), 'short-description'));
  const manual = manualSkills.includes(skillName);
  if (manual) {
    assert.equal(fieldValue(frontmatter, 'user-invocable'), 'true', skillName);
    assert.equal(fieldValue(frontmatter, 'disable-model-invocation'), 'true', skillName);
  } else {
    assert.notEqual(fieldValue(frontmatter, 'user-invocable'), 'false', skillName);
    assert.notEqual(fieldValue(frontmatter, 'disable-model-invocation'), 'true', skillName);
  }
  if (platform === 'generic') {
    assert.ok(!Object.keys(files).some((file) => file.startsWith('agents/')), skillName);
  } else {
    const metadata = files['agents/openai.yaml'];
    assert.ok(metadata, skillName);
    assert.equal(fieldValue(yamlSection(metadata, 'policy'), 'allow_implicit_invocation'), manual ? 'false' : 'true', skillName);
    const ui = yamlSection(metadata, 'interface');
    assert.match(fieldValue(ui, 'default_prompt') ?? '', new RegExp(`\\$${skillName}(?![a-z0-9-])`, 'u'), skillName);
    const description = fieldValue(ui, 'short_description');
    assert.ok(description?.trim() && [...description].length <= 64, skillName);
  }
  if (['dev-arena', 'dev-review'].includes(skillName)) {
    assert.match(fieldValue(frontmatter, 'compatibility'), platform === 'generic' ? /通用 Agent Skills/u : /AW 支持的宿主/u);
  }
}

const coreDiscipline = (await readFile(path.join(root, 'shared/core-discipline.md'), 'utf8')).trimEnd();
const principleFiles = (await readdir(path.join(root, 'shared/principles'))).map((name) => `principles/${name}`).sort();
const designSupport = [
  'references/spec.md', 'references/workspace.md', 'references/recovery.md', 'assets/shape-template.md', 'assets/spec-template.md',
];
const sharedFiles = Object.fromEntries(await Promise.all([...principleFiles, ...designSupport].map(async (name) => [name,
  await readFile(path.join(root, name.startsWith('principles/') ? 'shared' : 'shared/design', name), 'utf8')])));
const sharedDesign = await readFile(path.join(root, 'shared/design/playbooks/design.md'), 'utf8');
const formalCheck = await readFile(path.join(root, 'shared/formal-check.md'), 'utf8');

function assertSharedProjection(outputs) {
  const workflow = outputs['dev-workflow'];
  const design = outputs['dev-design'];
  for (const files of [workflow, design]) {
    assert.ok(files['SKILL.md'].includes(coreDiscipline), 'shared core must be injected verbatim');
    assert.equal(principleFiles.length, 14);
    assert.deepEqual(Object.keys(files).filter((name) => name.startsWith('principles/')).sort(), principleFiles);
    const pointers = [...files['SKILL.md'].matchAll(/`(principles\/[\w-]+\.md)`/gu)].map((match) => match[1]);
    assert.deepEqual(pointers.sort(), principleFiles, 'one distinct one-hop pointer per principle');
  }
  for (const file of [...principleFiles, ...designSupport]) {
    assert.equal(workflow[file], sharedFiles[file], file);
    assert.equal(design[file], sharedFiles[file], file);
  }
  assert.equal(Object.keys(workflow).filter((name) => name.startsWith('playbooks/')).length, 7);
  assert.ok(!Object.hasOwn(design, 'playbooks/design.md'));
  assert.equal(workflow['playbooks/design.md'], sharedDesign);
  const designBody = sharedDesign.slice(sharedDesign.indexOf('\n') + 1).trim();
  assert.ok(design['SKILL.md'].includes(designBody), 'independent design entry is inlined, not a second hop');
  assert.ok(outputs['dev-verify-author']['SKILL.md'].includes('`references/formal-check.md`'));
  assert.equal(outputs['dev-verify']['references/formal-check.md'], formalCheck);
  assert.equal(outputs['dev-verify-author']['references/formal-check.md'], formalCheck);
}

function row(body, label) {
  return body.split('\n').find((line) => line.startsWith(`| ${label} |`))?.split('|').slice(2, -1).map((cell) => cell.trim());
}

function assertRouting(outputs, platform, values) {
  const generic = platform === 'generic';
  const arena = outputs['dev-arena']['SKILL.md'];
  const review = outputs['dev-review']['references/adversarial-interrogate.md'];
  if (Object.keys(values).length === 0) {
    assert.equal(row(arena, 'candidate-1'), undefined);
    assert.equal(row(arena, 'cross-judge'), undefined);
    assert.equal(row(review, 'adversary-1'), undefined);
    return;
  }
  assert.deepEqual(row(arena, 'candidate-1'), [
    '`"native"`', '`"fixture-candidate-native"`', platform === 'antigravity' ? '—（由模型 ID 编码）' : '宿主默认',
  ]);
  assert.deepEqual(row(review, 'adversary-1'), ['`"native"`', '`"fixture-review-native"`', '`"medium"`']);
  for (const [body, label, executor, model, effort] of [
    [arena, 'candidate-2', 'fixture-external', '`"fixture-candidate-external"`', '`"high"`'],
    [arena, 'cross-judge', 'fixture-judge', '`"fixture-judge-model"`', '`"max"`'],
    [review, 'adversary-2', 'fixture-review-external', generic ? '—' : '后端默认（按需 inspect 选型）', generic ? '—' : '后端默认（按需 inspect 选型）'],
  ]) {
    const [execution, actualModel, actualEffort] = row(body, label);
    if (generic) {
      assert.ok(execution.startsWith(`\`"${executor}"\``));
      assert.match(execution, /不支持 AW 托管外部执行器[^]*回退宿主原生/u);
    } else {
      assert.equal(execution, `\`"${executor}"\``);
    }
    assert.deepEqual([actualModel, actualEffort], [model, effort]);
  }
  assert.equal(row(arena, 'candidate-3'), undefined);
  assert.equal(row(review, 'adversary-3'), undefined);
}

test('source renderer excludes top-level author-only files but keeps runtime resources', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-dev-workflow-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillRoot = path.join(directory, 'dev-debug');
  await cp(path.join(root, 'skills/dev-debug'), skillRoot, { recursive: true });
  for (const file of ['evals/manifest.json', 'reports/result.json', 'references/reports/runtime.md']) {
    await mkdir(path.dirname(path.join(skillRoot, file)), { recursive: true });
    await writeFile(path.join(skillRoot, file), 'fixture\n');
  }
  const input = context('codex', {});
  input.resources.find(({ name }) => name === './skills/dev-debug').root = skillRoot;
  const plan = await renderArtifactPlan(input);
  const files = plan.components.find(({ name }) => name === 'dev-debug').content.files;
  assert.ok(!Object.keys(files).some((file) => /^(?:evals|reports)\//u.test(file)));
  assert.ok(Object.hasOwn(files, 'references/reports/runtime.md'));
  await assert.rejects(
    renderArtifactPlan(context('codex', { arenaCrossJudge: 'invalid-profile' })),
    /Config field "arenaCrossJudge" must be an object\./u,
  );
});

// Test Value Gate: actual renderer results are the public components read by AW and installed Skills.
for (const platform of platforms) {
  for (const [profile, values] of [['default', {}], ['configured', configured]]) {
    test(`${platform}/${profile}: produces twelve closed Skills with the expected invocation metadata and panel routing`, async () => {
      const plan = await renderArtifactPlan(context(platform, values));
      assert.equal(plan.version, 3);
      assert.deepEqual(plan.omitted, []);
      assert.deepEqual(plan.unmet, []);
      assert.deepEqual(plan.components.map(({ name }) => name).sort(), [...skillNames].sort());
      assert.equal(new Set(plan.components.map(({ id }) => id)).size, skillNames.length);
      const outputs = {};
      for (const component of plan.components) {
        assert.equal(component.kind, 'skill');
        const files = await materializedFiles(component);
        outputs[component.name] = files;
        assertMetadata(component.name, files, platform);
        assertSkillClosure(component.name, files);
      }
      assertSharedProjection(outputs);
      assertRouting(outputs, platform, values);
    });
  }
  test(`${platform}: non-Skill batch produces no components`, async () => {
    assert.deepEqual(await renderArtifactPlan(context(platform, configured, kinds.filter((kind) => kind !== 'skill'), 'project')),
      { version: 3, components: [], omitted: [], unmet: [] });
  });
}

// Test Value Gate: execute the shipped append-only decision ledger, checking its file and exit status.
test('rendered decision ledger accepts literal flag values, preserves history and rejects an invalid log', async (t) => {
  const plan = await renderArtifactPlan(context('generic', {}));
  const output = await materializedFiles(plan.components.find((component) => component.name === 'dev-workflow'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aw-dev-workflow-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'decision-log.mjs');
  const log = path.join(directory, 'decisions.tsv');
  await writeFile(script, output['scripts/decision-log.mjs']);
  const invoke = (command, ...args) => spawnSync(process.execPath, [script, command, log, ...args, '--json'], { encoding: 'utf8' });
  const success = (command, ...args) => {
    const result = invoke(command, ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(success('init').created, true);
  const ts = '--ts=2026-01-01T00:00:00Z';
  const first = success('append', '--phase=hillclimb', '--decision=--help', '--why', '--literal-argument', '--evidence=observed', '--result=-10%', ts);
  // These non-numeric '-' prefixes must be escaped as literal spreadsheet cells, not parsed as flags.
  assert.equal(first.row.decision, "'--help");
  assert.equal(first.row.why, "'--literal-argument");
  assert.equal(first.row.result, '-10%');
  const literalHelp = success('append', '--phase=compose', '--decision', '--help', '--why', '-h', '--evidence=observed', '--result=ok', ts);
  assert.equal(literalHelp.row.decision, "'--help");
  assert.equal(literalHelp.row.why, "'-h");
  for (const args of [['--help'], ['append', '--help']]) {
    const help = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage:/u);
  }
  const previous = await readFile(log, 'utf8');
  assert.equal(success('init').created, false);
  const second = success('append', '--phase=compose', '--decision=metric', '--why=measured', '--evidence=observed', '--result=+15ms', ts);
  assert.equal(second.row.result, '+15ms');
  const third = success('append', '--phase=compose', '--decision=literal', '--why=recorded', '--evidence=observed', '--result==1+1', ts);
  assert.equal(third.row.result, "'=1+1");
  assert.ok((await readFile(log, 'utf8')).startsWith(previous));
  assert.equal(success('check').rowCount, 4);
  assert.deepEqual(success('tail', '--n=2').rows, [second.row, third.row]);
  const beforeFailure = await readFile(log, 'utf8');
  assert.equal(invoke('append', '--phase=missing-required').status, 2);
  assert.equal(await readFile(log, 'utf8'), beforeFailure);
  await writeFile(log, `${beforeFailure}invalid\n`);
  assert.equal(invoke('check').status, 1);

  const headerWithoutNewline = beforeFailure.split('\n', 1)[0];
  await writeFile(log, headerWithoutNewline);
  assert.equal(success('check').rowCount, 0);
  success('append', '--phase=compose', '--decision=first', '--why=recorded', '--evidence=observed', '--result=ok', ts);
  assert.equal(success('check').rowCount, 1);
  const rowWithoutNewline = (await readFile(log, 'utf8')).slice(0, -1);
  await writeFile(log, rowWithoutNewline);
  assert.equal(success('check').rowCount, 1);
  success('append', '--phase=compose', '--decision=second', '--why=recorded', '--evidence=observed', '--result=ok', ts);
  assert.equal(success('check').rowCount, 2);
  assert.ok((await readFile(log, 'utf8')).startsWith(`${rowWithoutNewline}\n`));

  for (const command of ['tail', 'check']) {
    const ioError = spawnSync(process.execPath, [script, command, directory, '--json'], { encoding: 'utf8' });
    assert.equal(ioError.status, 1);
    const payload = JSON.parse(ioError.stderr);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.error, 'string');
  }
});
