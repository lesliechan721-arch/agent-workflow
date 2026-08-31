import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const evalValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'agent-skill-eval', 'dist', 'bin.js');
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));
const reviewSkillRoot = path.join(runtimeRoot, 'skills/review-aw-plugin');
const materializedRuntime = { skip: context ? false : 'requires plugin:test materialization' };
const testBinRoot = await mkdtemp(path.join(tmpdir(), 'aw-review-contract-bin-'));
temps.push(testBinRoot);
await writeFile(path.join(testBinRoot, 'aw'), `#!/bin/sh
if [ "$1" = "plugin" ]; then
  printf '%s\\n' '{"ok":true,"errors":[]}'
  exit 0
fi
exec "${process.execPath}" "${skillValidatorBin}" "$@"
`);
await chmod(path.join(testBinRoot, 'aw'), 0o755);
async function runJson(file, args = []) {
  try {
    return JSON.parse((await execFileAsync(process.execPath, [file, ...args], {
      cwd: runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${testBinRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

async function runPublicJson(args, options = {}) {
  try {
    return JSON.parse((await execFileAsync(process.execPath, [skillValidatorBin, ...args], {
      cwd: options.cwd ?? runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

async function materializeWorkspaceFiles(root, workspaceFiles) {
  for (const [relativePath, content] of Object.entries(workspaceFiles)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

test('non-Publisher Skills preserve an explicit Workspace target across context and commands', async () => {
  const skills = await Promise.all([
    'author-aw-plugin',
    'review-aw-plugin',
    'review-aw-workflow',
  ].map((name) => readFile(path.join(runtimeRoot, 'skills', name, 'SKILL.md'), 'utf8')));

  // Static contract exception: a target outside cwd must reach the first context command and all later public commands unchanged; behavior execution is covered by the explicit-target Eval fixture because this package test only receives final instruction text.
  for (const skill of skills) {
    assert.match(skill, /aw catalog context \[--workspace-root <target-root>\] --json/u);
    assert.match(skill, /用户明确的 Workspace root.*canonical.*上游 handoff.*current Workspace/su);
    assert.match(skill, /receipt 的 `workspace\.root` 必须与所选 target 一致/u);
    assert.match(skill, /canonical targets? 或 handoff paths? 时?与其一致|所有 canonical targets 或 handoff paths 一致/u);
    assert.match(skill, /不一致时停止/u);
    assert.match(skill, /只在 root 缺失或歧义时询问/u);
    assert.match(
      skill,
      /--workspace-root <workspace-root>|--plugin <workspace-root>\/plugins/u,
    );
  }
});

test('Plugin Author keeps a legal degraded Workspace repairable', async () => {
  const author = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'SKILL.md'),
    'utf8',
  );

  // Static contract exception: stopping on a non-blocking Context v3 issue would prevent repair of an already located plugin; behavior execution depends on model routing while this test only receives final instruction text.
  assert.match(author, /合法 marker 使 `workspace\.found` 为 true/u);
  assert.match(author, /`workspace\.health` 为 `degraded`/u);
  assert.match(author, /非阻断的 `workspace-content` 或 `development-source` issue 不阻止插件修复/u);
  assert.match(author, /只有 blocking 的 workspace marker issue 才阻止定位/u);
});

test('Author Eval fixtures report their intended Context v3 Workspace health', async () => {
  const evalRoot = path.join(sourceRoot, 'skills', 'author-aw-plugin', 'evals');
  const behaviorCases = JSON.parse(await readFile(
    path.join(evalRoot, 'behavior-cases.json'),
    'utf8',
  )).cases;
  const lightweightCases = JSON.parse(await readFile(
    path.join(evalRoot, 'lightweight-delta-cases.json'),
    'utf8',
  )).cases;
  const expectedContexts = new Map([
    ['new-plugin-with-two-skills', { identity: 'team-status-new-fixture', health: 'healthy' }],
    ['mcp-and-app-composition', { identity: 'mcp-app-degraded-fixture', health: 'degraded' }],
    ['slash-command-and-readme', { identity: 'release-helper-slash-fixture', health: 'degraded' }],
    ['config-driven-instructions-artifact', { identity: 'incident-policy-artifact-fixture', health: 'degraded' }],
    ['manifest-version-and-build-repair', { identity: 'runtime-card-build-fixture', health: 'degraded' }],
    ['skill-and-eval-assets-handoff', { identity: 'query-tools-skill-eval-fixture', health: 'healthy' }],
    ['portable-static-projection-and-dynamic-skill', { identity: 'portable-observer-projection-fixture', health: 'degraded' }],
    ['existing-skill-small-delta-skips-aw-authoring-context', { identity: 'notes-lightweight-delta-fixture', health: 'healthy' }],
  ]);
  const evalCases = [...behaviorCases, ...lightweightCases]
    .filter((entry) => expectedContexts.has(entry.id));
  assert.equal(evalCases.length, expectedContexts.size);

  for (const evalCase of evalCases) {
    const temp = await mkdtemp(path.join(tmpdir(), `aw-author-context-${evalCase.id}-`));
    temps.push(temp);
    await materializeWorkspaceFiles(temp, evalCase.input.workspaceFiles);
    const result = await execFileAsync(process.execPath, [
      skillValidatorBin,
      'catalog',
      'context',
      '--workspace-root', temp,
      '--json',
    ], {
      cwd: temp,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        AW_HOME: path.join(temp, '.aw-home'),
      },
    });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schemaVersion, 3, evalCase.id);
    assert.equal(receipt.workspace.found, true, evalCase.id);
    assert.equal(receipt.workspace.root, path.resolve(temp), evalCase.id);
    const expected = expectedContexts.get(evalCase.id);
    assert.equal(receipt.workspace.identity, expected.identity, evalCase.id);
    assert.equal(receipt.workspace.health, expected.health, evalCase.id);
    assert.deepEqual(receipt.issues.map((issue) => [issue.scope, issue.blocking]), expected.health === 'degraded'
      ? [['workspace-content', false]]
      : [], evalCase.id);
  }
});

test('new-plugin Eval fixture allows only its source and real build output', async () => {
  const behaviorCases = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills', 'author-aw-plugin', 'evals', 'behavior-cases.json'),
    'utf8',
  )).cases;
  const evalCase = behaviorCases.find((entry) => entry.id === 'new-plugin-with-two-skills');
  assert.ok(evalCase);
  assert.deepEqual(evalCase.expected.allowedWorkspaceChanges, [
    'plugins/team-status/**',
    '.aw/plugins/team-status/**',
  ]);
  assert.ok(evalCase.expected.artifacts.every((artifact) => artifact.path.startsWith('plugins/team-status/')));
  const changeIsAllowed = (relativePath) => evalCase.expected.allowedWorkspaceChanges.some((pattern) => (
    pattern.endsWith('/**')
      ? relativePath === pattern.slice(0, -3) || relativePath.startsWith(pattern.slice(0, -2))
      : relativePath === pattern
  ));

  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'aw-author-new-plugin-fixture-')));
  temps.push(temp);
  await materializeWorkspaceFiles(temp, evalCase.input.workspaceFiles);
  const env = { AW_HOME: path.join(temp, '.aw-home') };

  const status = await runPublicJson([
    'catalog', 'status', '--workspace-root', temp, '--json',
  ], { cwd: temp, env });
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.command, 'catalog:status');
  assert.equal(status.ok, true);

  await execFileAsync(process.execPath, [skillValidatorBin,
    'plugin', 'init', 'team-status', '--description', 'Team status fixture.',
    '--no-skills', '--workspace-root', temp,
  ], {
    cwd: temp,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const manifest = JSON.parse(await readFile(
    path.join(temp, 'plugins', 'team-status', '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'team-status');

  const build = await runPublicJson([
    'plugin', 'build', 'plugins/team-status', '--workspace-root', temp, '--json',
  ], { cwd: temp, env });
  const outputPath = path.relative(temp, build.outputRoot).split(path.sep).join('/');
  assert.equal(build.command, 'plugin:build');
  assert.equal(build.pluginName, 'team-status');
  assert.equal(outputPath, '.aw/plugins/team-status');
  assert.equal(changeIsAllowed(outputPath), true);
  assert.equal(changeIsAllowed('.aw/catalog/catalog-manifest.json'), false);
  assert.equal(changeIsAllowed('.aw/plugins/other-plugin/.aw-generated.json'), false);
  assert.equal(changeIsAllowed('plugins/other-plugin/.agents-plugin/plugin.json'), false);
});

test('Author Eval repairs and handoffs prepare and validate EvalSpec v1 from public commands', async () => {
  const evalRoot = path.join(sourceRoot, 'skills', 'author-aw-plugin', 'evals');
  const behaviorCases = JSON.parse(await readFile(path.join(evalRoot, 'behavior-cases.json'), 'utf8')).cases;
  const lightweightCases = JSON.parse(await readFile(path.join(evalRoot, 'lightweight-delta-cases.json'), 'utf8')).cases;
  const lightweight = lightweightCases.find((entry) => entry.id === 'existing-skill-small-delta-skips-aw-authoring-context');
  const buildRepair = behaviorCases.find((entry) => entry.id === 'manifest-version-and-build-repair');
  const handoff = behaviorCases.find((entry) => entry.id === 'skill-and-eval-assets-handoff');
  assert.ok(lightweight);
  assert.ok(buildRepair);
  assert.ok(handoff);
  assert.match(lightweight.prompt, /\$author-aw-plugin/u);
  assert.ok(lightweight.assertions.some((entry) => entry.includes('先进入被评的 $author-aw-plugin，再 handoff 给 author-agent-skill')));
  assert.equal('package.json' in buildRepair.input.workspaceFiles, false);
  assert.match(buildRepair.prompt, /node plugins\/runtime-card\/scripts\/build-runtime-assets\.mjs/u);
  assert.doesNotMatch(buildRepair.prompt, /pnpm|Corepack/u);
  assert.match(buildRepair.input.workspaceFiles['AGENTS.md'], /offline: do not use pnpm, Corepack/u);
  assert.match(handoff.prompt, /现有 explain-query Skill/u);
  assert.ok(handoff.assertions.some((entry) => entry.includes('最小 trigger suite')));
  assert.ok(handoff.assertions.some((entry) => entry.includes('不修改 manifest、不创建第二个 Skill')));
  // Static contract exception: fixed filenames in the input would reject valid Eval Designer output; behavior test is not suitable because model-generated filenames and contents have allowed variance and this deterministic suite does not run a model Eval.
  assert.deepEqual(handoff.expected.artifacts, [
    { path: 'plugins/query-tools/skills/explain-query/SKILL.md', exists: true },
  ]);
  assert.equal(handoff.expected.artifacts.some((artifact) => (
    artifact.path.endsWith('/manifest.json') || artifact.path.endsWith('/trigger-cases.json')
  )), false);
  assert.ok(handoff.assertions.some((entry) => (
    entry.includes('suite metadata')
      && entry.includes('正例、反例')
      && entry.includes('文件名可按 Eval Designer 合同不同')
      && entry.includes('schema 校验')
  )));

  const workspaceRoot = path.resolve(sourceRoot, '..', '..');
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'aw-author-eval-plan-')));
  temps.push(temp);
  const cases = [
    { suite: 'behavior', id: buildRepair.id },
    { suite: 'behavior', id: handoff.id },
    { suite: 'lightweight-delta', id: lightweight.id },
  ];
  for (const entry of cases) {
    const output = path.join(temp, entry.id);
    const preparation = await runPublicJson([
      'skill', 'eval', 'prepare', 'aw-plugin-development', 'author-aw-plugin',
      '--suite', entry.suite,
      '--profile', 'project-default',
      '--case', entry.id,
      '--workspace-root', workspaceRoot,
      '--output', output,
      '--json',
    ], {
      cwd: workspaceRoot,
      env: { AW_HOME: path.join(temp, `.aw-home-${entry.id}`) },
    });
    assert.ok(preparation.ok, `${entry.id}: ${JSON.stringify(preparation.errors)}`);
    assert.equal(preparation.specPath, path.join(output, 'spec.json'), entry.id);
    const validation = JSON.parse((await execFileAsync(process.execPath, [
      evalValidatorBin,
      'spec', 'validate', preparation.specPath,
    ], { encoding: 'utf8' })).stdout);
    assert.equal(validation.valid, true, entry.id);
    const selectedCases = JSON.parse(await readFile(path.join(output, 'cases.json'), 'utf8'));
    assert.deepEqual(selectedCases.cases.map((caseEntry) => caseEntry.id), [entry.id], entry.id);
  }
});

test('review adapter manifest and runtime contain only current quality and release tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-aw-plugin')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/quality-review-result.schema.json',
    'assets/review-dimensions.json',
    'references/review-publication.md',
    'scripts/check-agent-skill.mjs',
    'scripts/check-aw-plugin-release.mjs',
    'scripts/review-skill-leaf-plan.mjs',
    'scripts/validate-quality-review-result.mjs',
  ]);
  assert.ok((await readFile(path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs'), 'utf8')).length > 100);
});

test('AW reviewer production and materialized closures use registered current dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.buildConfig.runtimeExports ?? [], []);
  assert.deepEqual(manifest.buildConfig.buildImports ?? [], []);
  assert.deepEqual(manifest.buildConfig.generatedSkillRuntimeFiles ?? [], []);
  assert.equal(manifest.scripts.node?.build, undefined);
  assert.ok(!manifest.requires.aw.capabilities.includes('aw.review-publication.v1'));
  assert.deepEqual(
    manifest.buildConfig.skillRuntimeFiles
      .flatMap((entry) => entry.import ? [`${entry.import.plugin}:${entry.import.export}`] : [])
      .sort(),
    [
      'agent-skill-toolkit:check-agent-skill',
      'agent-skill-toolkit:quality-review-result-schema',
      'agent-skill-toolkit:review-dimensions',
      'agent-skill-toolkit:review-publication-reference',
      'agent-skill-toolkit:review-publication-reference',
      'agent-skill-toolkit:skill-design-brief-schema',
      'agent-skill-toolkit:validate-json-contract',
      'agent-skill-toolkit:validate-quality-review-result',
    ],
  );
});

test('target discovery groups identical content by digest and preserves real differences', materializedRuntime, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-light-review-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const sourceSkill = path.join(plugin, 'skills', 'notify');
  const codexSkill = path.join(temp, 'codex', 'notify');
  const claudeSkill = path.join(temp, 'claude', 'notify');
  const skillText = '---\nname: notify\ndescription: Send one approved notice.\n---\n\n# Notify\n\nSend one approved notice.\n';
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'notify-plugin', version: '1.0.0', skills: './skills' }));
  for (const root of [sourceSkill, codexSkill, claudeSkill]) {
    await mkdir(path.join(root, 'agents'), { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), skillText);
    await writeFile(path.join(root, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  }
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  const first = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(first.targets.length, 3);
  assert.equal(first.uniqueReviews.length, 1);
  assert.equal(first.uniqueReviews[0].targetIds.length, 3);

  await writeFile(path.join(claudeSkill, 'SKILL.md'), skillText.replace('one approved notice', 'approved single or batch notices'));
  const second = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(second.uniqueReviews.length, 2);
});

test('target discovery requires real materialized content for build-generated Skill resources', materializedRuntime, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-built-review-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const sourceSkill = path.join(plugin, 'skills', 'generated');
  const finalRoot = path.join(temp, 'final');
  const finalSkill = path.join(finalRoot, 'generated');
  const skillText = '---\nname: generated\ndescription: Read one generated reference.\n---\n\nRead [the generated guide](references/generated.md).\n';
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(finalSkill, 'references'), { recursive: true });
  await mkdir(path.join(finalSkill, 'agents'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'generated-plugin',
    version: '1.0.0',
    skills: './skills',
    scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs', args: [] } } },
  }));
  await writeFile(path.join(sourceSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'references', 'generated.md'), '# Generated\n\nRuntime content.\n');
  await writeFile(path.join(finalSkill, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  await assert.rejects(runJson(discover, [plugin, '--workspace-root', temp, '--format', 'json']), /materialized --final collection/u);
  const result = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${finalRoot}`, '--format', 'json']);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].kind, 'materialized-skill');
  assert.equal(result.targets[0].machineCheck.ok, true);
  assert.equal(result.uniqueReviews.length, 1);
});

test('target discovery surfaces machine errors without review workflow state', materializedRuntime, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-light-review-error-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const skill = path.join(plugin, 'skills', 'broken');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'broken-plugin', version: '1.0.0', skills: './skills' }));
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: broken\ndescription: Broken fixture.\n---\n\nRun `node scripts/missing.mjs`.\n');
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  const result = await runJson(discover, [plugin, '--workspace-root', temp, '--format', 'json']);
  assert.equal(result.targets[0].machineCheck.ok, false);
  assert.ok(result.targets[0].machineCheck.errors.some((entry) => entry.code === 'missing-runtime-resource'));
  assert.equal('providedStages' in result, false);
  assert.equal('profileCoverage' in result, false);
});
