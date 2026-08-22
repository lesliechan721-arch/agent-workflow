import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const execFileAsync = promisify(execFile),
  local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  ctx = process.env.AW_PLUGIN_CONTEXT
    ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
    : null,
  sourceRoot = ctx?.sourceRoot ?? local,
  runtimeRoot = ctx?.platform ? path.join(local, ctx.platform) : local,
  repo = path.resolve(sourceRoot, '..', '..'),
  temps = [];
after(async () => Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }))));
async function run(script, args = [], cwd = repo) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}
async function createValidatedReviewEvidence(directory) {
  const plugin = path.join(directory, 'plugins', 'target-plugin');
  const skill = path.join(plugin, 'skills', 'target-skill');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'target-plugin',
    version: '1.0.0',
    skills: './skills',
  }));
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: target-skill\ndescription: Review target.\n---\n',
  );
  const prepared = JSON.parse((await run(
    path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs'),
    [
      plugin,
      '--repo-root',
      directory,
      '--output-root',
      path.join(directory, 'handoff'),
    ],
  )).stdout);
  const target = prepared.reviewTargets[0];
  const result = JSON.parse(await readFile(path.join(
    sourceRoot,
    '..',
    'agent-skill-toolkit',
    'skills',
    'review-agent-skill',
    'assets',
    'review-result-template.json',
  ), 'utf8'));
  result.target = {
    kind: target.kind,
    name: target.targetName,
    profile: target.profile,
    digest: target.digest,
  };
  const resultPath = path.join(directory, 'review-result.json');
  await writeFile(resultPath, JSON.stringify(result));
  return { plugin, target, result, resultPath, bundlePath: target.bundlePath };
}
test('canonical contracts are materialized without committed Skill copies', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.ok(manifest.buildConfig.skillRuntimeFiles.length > 0);
  for (const projection of manifest.buildConfig.skillRuntimeFiles) {
    const relative = path.join('skills', projection.skill, projection.target);
    await assert.rejects(readFile(path.join(sourceRoot, relative), 'utf8'));
    assert.ok((await readFile(path.join(runtimeRoot, relative), 'utf8')).length > 0, relative);
    if (projection.source) {
      assert.ok(
        (await readFile(path.join(sourceRoot, projection.source), 'utf8')).length > 0,
        projection.source,
      );
    }
  }
  for (const relative of [
    'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md',
    'skills/review-aw-plugin/assets/review-result-rules.generated.json',
  ]) {
    await assert.rejects(readFile(path.join(sourceRoot, relative), 'utf8'));
    assert.ok((await readFile(path.join(runtimeRoot, relative), 'utf8')).length > 200, relative);
  }
});
test('final Author Skill uses only stable CLI authoring commands', async () => {
  const skillRoot = path.join(runtimeRoot, 'skills/author-aw-plugin');
  const removedCopies = [
    'scripts/init_plugin.mjs',
    'scripts/add_skill.mjs',
    'scripts/validate_plugin.mjs',
    'scripts/check_plugin_versions.mjs',
    'scripts/lib/javascript-import-scanner.mjs',
    'scripts/lib/plugin-version-check.mjs',
    'scripts/lib/semver.mjs',
    'scripts/lib/skill-scaffold.mjs',
  ];
  for (const relative of removedCopies) {
    await assert.rejects(readFile(path.join(skillRoot, relative), 'utf8'), relative);
  }
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  // Static contract exception: installed agents must discover every public authoring command and must not execute an undeclared fallback; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  for (const command of ['init', 'add-skill', 'validate', 'status']) {
    assert.match(skill, new RegExp(`aw plugin ${command} --help`, 'u'));
    assert.match(skill, new RegExp(`aw plugin ${command}(?: <| --)`, 'u'));
  }
  assert.match(skill, /aw --version/u);
  assert.match(skill, /不得使用 `npx`/u);
  assert.match(skill, /不得猜测仓库路径/u);
  assert.match(skill, /不得回退到本 Skill 的本地工具副本/u);
});
test('built CLI performs representative Author Skill operations', async () => {
  const cli = path.join(repo, 'packages', 'cli', 'dist', 'index.js');
  const fixture = path.join(
    repo,
    'packages',
    'cli',
    'tests',
    'fixtures',
    'repo-template',
  );
  const tRoot = await mkdtemp(path.join(tmpdir(), 'aw-plugin-cli-authoring-'));
  temps.push(tRoot);
  const workspace = path.join(tRoot, 'workspace');
  await cp(fixture, workspace, { recursive: true });
  const runAw = (args, cwd = repo) => run(cli, args, cwd);

  const version = await runAw(['--version']);
  assert.match(version.stdout, /\d+\.\d+\.\d+/u);
  for (const command of ['init', 'add-skill', 'validate', 'status']) {
    const help = await runAw(['plugin', command, '--help']);
    assert.match(help.stdout, new RegExp(`aw plugin ${command}`, 'u'));
    if (command === 'init' || command === 'add-skill') {
      assert.match(help.stdout, /keep the current stable target/u);
      assert.match(help.stdout, /pnpm release:target -- --plugin <name>=patch/u);
      assert.match(help.stdout, /release:prepare.*candidate identity/u);
      assert.match(help.stdout, /another workspace.*release workflow/u);
    }
  }

  const addSkill = await runAw([
    'plugin',
    'init',
    'cli-authoring-fixture',
    '--description',
    'Fixture plugin for the stable authoring command contract.',
    '--skill-description',
    'Create and maintain the fixture plugin through the stable AW authoring command.',
    '--skill-short-description',
    'Maintain a fixture plugin with stable AW commands.',
    '--skill-invocation',
    'manual',
    '--repo-root',
    workspace,
    '--plugin-root',
    'tools/cli-authoring-fixture',
  ]);
  assert.match(addSkill.stdout, /Keep the current stable target during development/u);
  assert.match(
    addSkill.stdout,
    /pnpm release:target -- --plugin cli-authoring-fixture=patch/u,
  );
  assert.match(addSkill.stdout, /release:prepare.*candidate identity/u);
  await runAw([
    'plugin',
    'add-skill',
    'cli-authoring-fixture',
    '--skill-name',
    'second-workflow',
    '--skill-description',
    'Run a second deterministic fixture workflow after explicit user invocation.',
    '--skill-short-description',
    'Run the second deterministic fixture workflow.',
    '--skill-invocation',
    'manual',
    '--repo-root',
    workspace,
    '--plugin-root',
    'tools/cli-authoring-fixture',
  ]);
  const pluginRoot = path.join(workspace, 'tools', 'cli-authoring-fixture');
  for (const skillName of ['cli-authoring-fixture', 'second-workflow']) {
    const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    const scaffold = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      scaffold.replace(/\[TODO:[^\]]+\]/gu, 'Complete and verify the deterministic fixture task'),
      'utf8',
    );
  }
  const validation = await runAw(['plugin', 'validate', pluginRoot, '--json']);
  assert.equal(JSON.parse(validation.stdout).ok, true);

  const versionCheck = JSON.parse((await runAw([
    'plugin',
    'status',
    'aw-plugin-development',
    '--base',
    'HEAD',
    '--repo-root',
    repo,
    '--json',
  ])).stdout);
  assert.equal(versionCheck.schemaVersion, 3);
  assert.equal(versionCheck.policy, 'development');
  assert.equal(versionCheck.ok, true);
  assert.ok(versionCheck.checks.some((entry) => entry.plugin === 'aw-plugin-development'));
});
test('cacheable build is reproducible outside the repository cwd', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.buildConfig.cacheable, true);
  const buildRoot = await mkdtemp(path.join(tmpdir(), 'aw-cacheable-build-'));
  temps.push(buildRoot);
  const declaredImports = {
    AW_PLUGIN_IMPORT_SKILL_FRONTMATTER_CAPABILITIES: path.join(
      repo,
      'packages/cli/src/utils/skill-frontmatter-capabilities.json',
    ),
    AW_PLUGIN_IMPORT_SKILL_RULES: path.join(
      repo,
      'plugins/agent-skill-toolkit/standards/skill-rules.json',
    ),
    AW_PLUGIN_IMPORT_REVIEW_DIMENSIONS: path.join(
      repo,
      'plugins/agent-skill-toolkit/standards/review-dimensions.json',
    ),
  };
  async function materialize(id) {
    const target = path.join(buildRoot, id, 'plugin');
    const cwd = path.join(buildRoot, id, 'unrelated-cwd');
    await cp(sourceRoot, target, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await execFileAsync(process.execPath, [path.join(target, 'scripts/build-runtime-assets.mjs')], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...declaredImports,
        AW_PLUGIN_UNDECLARED_BUILD_NOISE: id,
      },
    });
    return Promise.all([
      readFile(
        path.join(
          target,
          'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md',
        ),
      ),
      readFile(
        path.join(target, 'skills/review-aw-plugin/assets/review-result-rules.generated.json'),
      ),
    ]);
  }
  const [first, second] = await Promise.all([materialize('first'), materialize('second')]);
  assert.deepEqual(second, first);
});
test('review inspection expands related globs with the CLI production dependency closure', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-related-glob-'));
  temps.push(t);
  const cleanRepo = path.join(t, 'repository'),
    cleanCli = path.join(cleanRepo, 'packages', 'cli'),
    modules = path.join(cleanCli, 'node_modules'),
    cliPackage = JSON.parse(
      await readFile(path.join(repo, 'packages', 'cli', 'package.json'), 'utf8'),
    );
  await mkdir(modules, { recursive: true });
  await writeFile(
    path.join(cleanCli, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: cliPackage.dependencies }),
  );
  for (const dependency of Object.keys(cliPackage.dependencies)) {
    const destination = path.join(modules, dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(
      path.join(repo, 'packages', 'cli', 'node_modules', dependency),
      destination,
      'junction',
    );
  }
  const target = path.join(cleanRepo, 'target'),
    roles = path.join(target, 'roles');
  await mkdir(roles, { recursive: true });
  await writeFile(path.join(target, 'SKILL.md'), '---\nname: target\ndescription: target\n---\n');
  await writeFile(
    path.join(roles, 'reader.toml'),
    'name = "reader"\ninstructions = "Read evidence."\n',
  );
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/inspect-aw-target.mjs'),
        [
          target,
          '--repo-root',
          cleanRepo,
          '--related',
          path.join(roles, '*.toml'),
          '--format',
          'json',
        ],
        cleanRepo,
      )
    ).stdout,
  );
  assert.deepEqual(
    result.related_toml.files.map((entry) => entry.path),
    [path.join(roles, 'reader.toml')],
  );
});
test('author keeps README policy in plugin bundle', async () => {
  const [skill, ref] = await Promise.all([
    readFile(path.join(runtimeRoot, 'skills/author-aw-plugin/SKILL.md'), 'utf8'),
    readFile(
      path.join(runtimeRoot, 'skills/author-aw-plugin/references/aw-readme-authoring.md'),
      'utf8',
    ),
  ]);
  assert.match(skill, /references\/aw-readme-authoring\.md/u);
  assert.doesNotMatch(skill, /docs\/readme-standard\.md/u);
  assert.match(ref, /\.agents-plugin\/plugin\.json/u);
});
test('authoring context supports external workspace', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-author-'));
  temps.push(t);
  const ws = path.join(t, 'workspace'),
    target = path.join(ws, 'packages', 'p');
  await mkdir(path.join(target, '.agents-plugin'), { recursive: true });
  await writeFile(
    path.join(target, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'p', marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } } }),
  );
  const components = path.join(t, 'components.json');
  await writeFile(
    components,
    JSON.stringify([
      {
        id: 'skill',
        type: 'skill',
        operation: 'change',
        paths: ['skills/skill'],
        profiles: ['CLAUDE'],
        skillInvocation: 'claude-model-only',
      },
    ]),
  );
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/author-aw-plugin/scripts/prepare-aw-authoring-context.mjs'),
        [
          target,
          '--repo-root',
          ws,
          '--components',
          components,
        ],
      )
    ).stdout,
  );
  assert.equal(result.repository, 'workspace');
  assert.deepEqual(result.products, ['CODEX', 'CLAUDE']);
  assert.deepEqual(result.components[0].profiles, ['CLAUDE']);
});
test('starter adapter documents satisfy schemas', async () => {
  const validator = path.join(
    runtimeRoot,
    'skills/author-aw-plugin/scripts/validate-json-contract.mjs',
  );
  for (const [s, v] of [
    [
      'skills/author-aw-plugin/assets/aw-authoring-context.schema.json',
      'skills/author-aw-plugin/assets/aw-authoring-context.json',
    ],
    [
      'skills/review-aw-plugin/assets/aw-review-summary.schema.json',
      'skills/review-aw-plugin/assets/aw-review-summary.json',
    ],
    [
      'skills/review-aw-plugin/assets/review-input-bundle.schema.json',
      'skills/review-aw-plugin/assets/review-input-bundle.json',
    ],
  ])
    await run(validator, [path.join(runtimeRoot, s), path.join(runtimeRoot, v)]);
});
test('AW summary decision follows generic reviews and project gates', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-summary-'));
  temps.push(t);
  const v = JSON.parse(
    await readFile(
      path.join(runtimeRoot, 'skills/review-aw-plugin/assets/aw-review-summary.json'),
      'utf8',
    ),
  );
  const plan = {
    schemaVersion: 1,
    producer: 'prepare-aw-review-target-plan',
    plugin: v.target.plugin,
    pluginSourceDigest: v.target.sourceDigest,
    mode: 'quick',
    releaseScope: { kind: 'all-supported', profiles: [] },
    expectedTargets: [{
      id: 'aw-plugin-skill:target-skill',
      targetName: 'target-skill',
      kind: 'aw-plugin-skill',
      profile: null,
      digest: v.genericReviews[0].digest,
      status: 'present',
    }],
  };
  const planContent = JSON.stringify(plan) + '\n';
  const planPath = path.join(t, 'plan.json');
  await writeFile(planPath, planContent);
  v.targetPlanDigest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  v.design = 'pass';
  const p = path.join(t, 'summary.json');
  await writeFile(p, JSON.stringify(v));
  await assert.rejects(
    run(
      path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/validate-aw-review-summary.mjs'),
      [p, '--plan', planPath],
    ),
    /Command failed/u,
  );
});
test('source-only summary cannot claim complete release profile coverage', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-summary-coverage-'));
  temps.push(t);
  const summary = JSON.parse(
    await readFile(
      path.join(runtimeRoot, 'skills/review-aw-plugin/assets/aw-review-summary.json'),
      'utf8',
    ),
  );
  summary.genericReviews[0].design = 'pass';
  summary.genericReviews[0].releaseReadiness = 'ready';
  for (const gate of Object.values(summary.projectGates)) {
    gate.status = 'pass';
    gate.reason = 'claimed pass';
  }
  summary.design = 'pass';
  summary.releaseReadiness = 'ready';
  const plan = {
    schemaVersion: 1,
    producer: 'prepare-aw-review-target-plan',
    plugin: summary.target.plugin,
    pluginSourceDigest: summary.target.sourceDigest,
    mode: 'release-quality',
    releaseScope: { kind: 'all-supported', profiles: ['codex-project'] },
    expectedTargets: [
      {
        id: 'aw-plugin-skill:target-skill',
        targetName: 'target-skill',
        kind: 'aw-plugin-skill',
        profile: null,
        digest: summary.genericReviews[0].digest,
        status: 'present',
      },
      {
        id: 'materialized-skill:target-skill:codex-project',
        targetName: 'target-skill',
        kind: 'materialized-skill',
        profile: 'codex-project',
        digest: null,
        status: 'missing',
      },
    ],
  };
  const planContent = JSON.stringify(plan) + '\n';
  const planPath = path.join(t, 'plan.json');
  await writeFile(planPath, planContent);
  summary.targetPlanDigest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  const summaryPath = path.join(t, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary));
  await assert.rejects(
    run(
      path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/validate-aw-review-summary.mjs'),
      [summaryPath, '--plan', planPath],
    ),
    /Command failed/u,
  );
});
test('AW summary rejects self-reported profile reviews without validated evidence', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-summary-evidence-'));
  temps.push(t);
  const evidence = await createValidatedReviewEvidence(t);
  const summary = JSON.parse(
    await readFile(
      path.join(runtimeRoot, 'skills/review-aw-plugin/assets/aw-review-summary.json'),
      'utf8',
    ),
  );
  summary.target.sourceDigest = 'sha256:' + '1'.repeat(64);
  summary.genericReviews = [{
    reviewEvidenceId: 'source-review',
    targetName: evidence.target.targetName,
    kind: evidence.target.kind,
    profile: evidence.target.profile,
    digest: evidence.target.digest,
    design: evidence.result.design,
    releaseReadiness: evidence.result.releaseReadiness,
  }];
  const plan = {
    schemaVersion: 1,
    producer: 'prepare-aw-review-target-plan',
    plugin: summary.target.plugin,
    pluginSourceDigest: summary.target.sourceDigest,
    mode: 'quick',
    releaseScope: { kind: 'source-only', profiles: [] },
    expectedTargets: [{
      id: 'aw-plugin-skill:target-skill',
      targetName: evidence.target.targetName,
      kind: evidence.target.kind,
      profile: evidence.target.profile,
      digest: evidence.target.digest,
      status: 'present',
    }],
  };
  const planPath = path.join(t, 'plan.json');
  let planContent = JSON.stringify(plan) + '\n';
  await writeFile(planPath, planContent);
  summary.targetPlanDigest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  const summaryPath = path.join(t, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary));
  const validator = path.join(
    runtimeRoot,
    'skills/review-aw-plugin/scripts/validate-aw-review-summary.mjs',
  );
  assert.equal(JSON.parse((await run(validator, [
    summaryPath,
    '--plan',
    planPath,
    '--plugin-root',
    evidence.plugin,
    '--evidence',
    'source-review',
    evidence.resultPath,
    evidence.bundlePath,
    '--format',
    'json',
  ])).stdout).valid, true);

  plan.releaseScope.profiles = ['codex-project'];
  plan.expectedTargets.push({
    id: 'materialized-skill:target-skill:codex-project',
    targetName: evidence.target.targetName,
    kind: 'materialized-skill',
    profile: 'codex-project',
    digest: evidence.target.digest,
    status: 'present',
  });
  summary.genericReviews.push({
    reviewEvidenceId: 'self-reported-final',
    targetName: evidence.target.targetName,
    kind: 'materialized-skill',
    profile: 'codex-project',
    digest: evidence.target.digest,
    design: evidence.result.design,
    releaseReadiness: evidence.result.releaseReadiness,
  });
  planContent = JSON.stringify(plan) + '\n';
  await writeFile(planPath, planContent);
  summary.targetPlanDigest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  await writeFile(summaryPath, JSON.stringify(summary));
  await assert.rejects(run(validator, [
    summaryPath,
    '--plan',
    planPath,
    '--plugin-root',
    evidence.plugin,
    '--evidence',
    'source-review',
    evidence.resultPath,
    evidence.bundlePath,
  ]), /Command failed/u);

  plan.releaseScope = { kind: 'source-only', profiles: [] };
  plan.expectedTargets = plan.expectedTargets.slice(0, 1);
  summary.genericReviews = summary.genericReviews.slice(0, 1);
  planContent = JSON.stringify(plan) + '\n';
  await writeFile(planPath, planContent);
  summary.targetPlanDigest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  await writeFile(summaryPath, JSON.stringify(summary));
  const omittedSkill = path.join(evidence.plugin, 'skills', 'omitted-skill');
  await mkdir(omittedSkill, { recursive: true });
  await writeFile(
    path.join(omittedSkill, 'SKILL.md'),
    '---\nname: omitted-skill\ndescription: Omitted target.\n---\n',
  );
  await assert.rejects(run(validator, [
    summaryPath,
    '--plan',
    planPath,
    '--plugin-root',
    evidence.plugin,
    '--evidence',
    'source-review',
    evidence.resultPath,
    evidence.bundlePath,
  ]), /Command failed/u);
});
test('release target plan derives all product scopes and records explicit narrowing', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-plan-'));
  temps.push(t);
  const plugin = path.join(t, 'plugins/demo');
  const sourceSkill = path.join(plugin, 'skills/check');
  const finalRoot = path.join(t, 'materialized/codex-project');
  const finalSkill = path.join(finalRoot, 'check');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(finalSkill, { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin/plugin.json'),
    JSON.stringify({
      name: 'demo',
      skills: './skills',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    }),
  );
  const skill = '---\nname: check\ndescription: Check the target.\n---\n';
  await writeFile(path.join(sourceSkill, 'SKILL.md'), skill);
  await writeFile(path.join(finalSkill, 'SKILL.md'), skill);
  const bundlePath = path.join(t, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify({
    target: {
      kind: 'aw-plugin',
      name: 'demo',
      sourceDigest: 'sha256:' + '1'.repeat(64),
    },
  }));
  const script = path.join(
    runtimeRoot,
    'skills/review-aw-plugin/scripts/prepare-aw-review-target-plan.mjs',
  );
  const fullPath = path.join(t, 'full-plan.json');
  const full = JSON.parse((await run(script, [
    plugin,
    '--bundle',
    bundlePath,
    '--output',
    fullPath,
    '--final',
    'codex-project=' + finalRoot,
  ])).stdout);
  assert.deepEqual(full.releaseScope.profiles, [
    'codex-user',
    'codex-project',
    'claude-user',
    'claude-project',
  ]);
  assert.equal(full.expectedTargets.length, 5);
  assert.equal(full.expectedTargets.filter((target) => target.status === 'present').length, 2);

  const narrowPath = path.join(t, 'narrow-plan.json');
  const narrow = JSON.parse((await run(script, [
    plugin,
    '--bundle',
    bundlePath,
    '--output',
    narrowPath,
    '--profile',
    'codex-project',
    '--final',
    'codex-project=' + finalRoot,
  ])).stdout);
  assert.equal(narrow.releaseScope.kind, 'explicit');
  assert.deepEqual(narrow.releaseScope.profiles, ['codex-project']);
  assert.equal(narrow.expectedTargets.length, 2);
  assert.ok(narrow.expectedTargets.every((target) => target.status === 'present'));
});
test('final artifacts remain materials rather than completed review stages', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-final-stage-'));
  temps.push(t);
  const repository = path.join(t, 'repository'),
    plugin = path.join(repository, 'plugins', 'agent-content-toolkit'),
    final = path.join(repository, '.tmp', 'final');
  await cp(path.join(repo, 'plugins', 'agent-content-toolkit'), plugin, { recursive: true });
  await mkdir(final, { recursive: true });
  await writeFile(path.join(final, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs'),
        [
          plugin,
          '--repo-root',
          repository,
          '--final',
          'codex=' + final,
        ],
      )
    ).stdout,
  );
  assert.ok(result.artifacts.some((a) => a.role === 'final'));
  assert.deepEqual(result.orchestration.providedStages, []);
});
