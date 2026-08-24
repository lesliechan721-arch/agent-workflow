import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const execFileAsync = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  pluginContext = process.env.AW_PLUGIN_CONTEXT
    ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
    : null,
  runtimeRoot = pluginContext?.platform ? path.join(root, pluginContext.platform) : root,
  sourceRoot = pluginContext?.sourceRoot ?? root,
  temps = [];
async function computeSkillDigest(skillRoot) {
  return (
    await execFileAsync(
      process.execPath,
      [
        path.resolve(sourceRoot, '../../packages/agent-skill-eval/dist/bin.js'),
        'digest',
        'skill',
        skillRoot,
      ],
      { encoding: 'utf8' },
    )
  ).stdout.trim();
}
after(async () => Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }))));
async function run(rel, args = []) {
  return execFileAsync(process.execPath, [path.join(runtimeRoot, rel), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}
async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
}
async function prepareBundle(plugin, repoRoot, args = []) {
  return JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs', [
        plugin,
        '--repo-root',
        repoRoot,
        ...args,
      ])
    ).stdout,
  );
}
async function validatePreparedBundle(bundle, directory, name) {
  const bundlePath = path.join(directory, name);
  await writeFile(bundlePath, JSON.stringify(bundle));
  return run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
    bundlePath,
    '--format',
    'json',
  ]);
}
async function sourceSkillDigest(plugin) {
  const value = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        path.dirname(plugin),
      ])
    ).stdout,
  );
  return value.reviewTargets.find((target) => target.kind === 'aw-plugin-skill').digest;
}
test('review metadata and target projection support an external workspace', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-portable-'));
  temps.push(t);
  const ws = path.join(t, 'workspace'),
    plugin = path.join(ws, 'packages', 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    final = path.join(ws, '.tmp', 'final', 'one');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(final, { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(path.join(final, 'SKILL.md'), '---\nname: one\ndescription: final\n---\n');
  const bundle = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs', [
        plugin,
        '--repo-root',
        ws,
      ])
    ).stdout,
  );
  assert.equal(bundle.environment.repository, 'workspace');
  assert.ok(bundle.artifacts.every((artifact) => !path.isAbsolute(artifact.path)));
  assert.ok(bundle.artifacts.every((artifact) => ['100644', '100755'].includes(artifact.mode)));
  const targets = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        ws,
        '--final',
        'codex=' + path.dirname(final),
      ])
    ).stdout,
  ).reviewTargets;
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((x) => [x.kind, x.targetName, x.profile]),
    [
      ['aw-plugin-skill', 'one', null],
      ['materialized-skill', 'one', 'codex'],
    ],
  );
  const handoffRoot = path.join(t, 'handoff');
  const materialized = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        ws,
        '--final',
        'codex=' + path.dirname(final),
        '--output-root',
        handoffRoot,
      ])
    ).stdout,
  );
  for (const target of materialized.reviewTargets) {
    const targetBundle = JSON.parse(await readFile(target.bundlePath, 'utf8'));
    const inspectionStages = targetBundle.orchestration.providedStages.filter(
      (stage) => stage.id === 'package-inspection',
    );
    assert.equal(inspectionStages.length, 1);
    assert.equal(inspectionStages[0].subjectDigest, target.digest);
    assert.equal(
      JSON.parse(
        (
          await run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
            target.bundlePath,
            '--handoff-root',
            handoffRoot,
            '--format',
            'json',
          ])
        ).stdout,
      ).valid,
      true,
    );
  }
  const outsideFinal = path.join(t, 'outside-final', 'one');
  await mkdir(outsideFinal, { recursive: true });
  await writeFile(
    path.join(outsideFinal, 'SKILL.md'),
    '---\nname: one\ndescription: outside\n---\n',
  );
  await assert.rejects(
    prepareBundle(plugin, ws, ['--final', `codex=${path.dirname(outsideFinal)}`]),
    /Command failed/u,
  );
});
test('review digests distinguish binary content that encodes a following legacy record', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-record-digest-'));
  temps.push(t);
  async function createPlugin(name, splitRecord) {
    const plugin = path.join(t, name),
      skill = path.join(plugin, 'skills', 'one');
    await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(plugin, '.agents-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills' }),
    );
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
    if (splitRecord) {
      await writeFile(path.join(skill, 'a'), 'payload');
      await writeFile(path.join(skill, 'b'), 'tail');
    } else {
      await writeFile(
        path.join(skill, 'a'),
        Buffer.concat([
          Buffer.from('payload'),
          Buffer.from([0]),
          Buffer.from('b'),
          Buffer.from([0]),
          Buffer.from('100644'),
          Buffer.from([0]),
          Buffer.from('tail'),
        ]),
      );
    }
    return plugin;
  }

  const singleRecord = await createPlugin('single', false);
  const twoRecords = await createPlugin('two', true);
  const [singleBundle, twoBundle] = await Promise.all([
    prepareBundle(singleRecord, t),
    prepareBundle(twoRecords, t),
  ]);
  assert.notEqual(singleBundle.target.sourceDigest, twoBundle.target.sourceDigest);
  assert.notEqual(await sourceSkillDigest(singleRecord), await sourceSkillDigest(twoRecords));
});
test('prepare and target projection use globally sorted POSIX production records', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-global-sort-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.join(skill, 'a'), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(path.join(skill, 'a', 'x.txt'), 'nested\n');
  await writeFile(path.join(skill, 'a.txt'), 'sibling\n');

  const pluginBundle = await prepareBundle(plugin, t);
  const pluginBundlePath = path.join(t, 'plugin-bundle.json');
  await writeFile(pluginBundlePath, JSON.stringify(pluginBundle));
  assert.equal(
    JSON.parse(
      (
        await run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
          pluginBundlePath,
          '--handoff-root',
          t,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );

  const projected = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        t,
        '--bundle',
        pluginBundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  const projectedPath = path.join(t, 'projected-bundle.json');
  await writeFile(projectedPath, JSON.stringify(projected));
  assert.equal(
    JSON.parse(
      (
        await run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
          projectedPath,
          '--handoff-root',
          t,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );
});
test('review digests exclude only direct Skill author evidence', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-digest-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    evalFile = path.join(skill, 'evals', 'cases.json'),
    reportFile = path.join(skill, 'reports', 'review.md'),
    runtimeEvalFile = path.join(skill, 'references', 'evals', 'runtime.txt'),
    runtimeReportFile = path.join(skill, 'assets', 'reports', 'runtime.txt'),
    referenceFile = path.join(skill, 'references', 'runtime.md');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.dirname(evalFile), { recursive: true });
  await mkdir(path.dirname(reportFile), { recursive: true });
  await mkdir(path.dirname(runtimeEvalFile), { recursive: true });
  await mkdir(path.dirname(runtimeReportFile), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(evalFile, '{"case":1}\n');
  await writeFile(reportFile, 'report 1\n');
  await writeFile(runtimeEvalFile, 'runtime eval 1\n');
  await writeFile(runtimeReportFile, 'runtime report 1\n');
  await writeFile(referenceFile, 'reference 1\n');

  const initial = await prepareBundle(plugin, t);
  const initialSkillDigest = await sourceSkillDigest(plugin);
  const roleBySuffix = (bundle, suffix) =>
    bundle.artifacts.find((artifact) => artifact.path.endsWith(suffix));
  assert.equal(roleBySuffix(initial, '/skills/one/evals/cases.json').role, 'evidence');
  assert.equal(roleBySuffix(initial, '/skills/one/reports/review.md').role, 'evidence');
  assert.equal(roleBySuffix(initial, '/references/evals/runtime.txt').role, 'source');
  assert.equal(roleBySuffix(initial, '/assets/reports/runtime.txt').role, 'source');

  await writeFile(evalFile, '{"case":2}\n');
  const evalChanged = await prepareBundle(plugin, t);
  assert.equal(evalChanged.target.sourceDigest, initial.target.sourceDigest);
  assert.equal(await sourceSkillDigest(plugin), initialSkillDigest);
  assert.notEqual(
    roleBySuffix(evalChanged, '/skills/one/evals/cases.json').digest,
    roleBySuffix(initial, '/skills/one/evals/cases.json').digest,
  );

  await writeFile(reportFile, 'report 2\n');
  const reportChanged = await prepareBundle(plugin, t);
  assert.equal(reportChanged.target.sourceDigest, initial.target.sourceDigest);
  assert.equal(await sourceSkillDigest(plugin), initialSkillDigest);
  assert.notEqual(
    roleBySuffix(reportChanged, '/skills/one/reports/review.md').digest,
    roleBySuffix(initial, '/skills/one/reports/review.md').digest,
  );

  await writeFile(runtimeEvalFile, 'runtime eval 2\n');
  const nestedEvalChanged = await prepareBundle(plugin, t);
  assert.notEqual(nestedEvalChanged.target.sourceDigest, initial.target.sourceDigest);
  const nestedEvalSkillDigest = await sourceSkillDigest(plugin);
  assert.notEqual(nestedEvalSkillDigest, initialSkillDigest);

  await writeFile(runtimeReportFile, 'runtime report 2\n');
  const nestedReportChanged = await prepareBundle(plugin, t);
  assert.notEqual(nestedReportChanged.target.sourceDigest, nestedEvalChanged.target.sourceDigest);
  const nestedReportSkillDigest = await sourceSkillDigest(plugin);
  assert.notEqual(nestedReportSkillDigest, nestedEvalSkillDigest);

  await writeFile(referenceFile, 'reference 2\n');
  const referenceChanged = await prepareBundle(plugin, t);
  assert.notEqual(referenceChanged.target.sourceDigest, nestedReportChanged.target.sourceDigest);

  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: changed\n---\n');
  const skillChanged = await prepareBundle(plugin, t);
  assert.notEqual(skillChanged.target.sourceDigest, referenceChanged.target.sourceDigest);

  const targets = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        t,
      ])
    ).stdout,
  ).reviewTargets;
  const skillBundle = targets[0].bundle;
  assert.equal(roleBySuffix(skillBundle, '/one/evals/cases.json').role, 'evidence');
  assert.equal(roleBySuffix(skillBundle, '/one/reports/review.md').role, 'evidence');
  assert.equal(roleBySuffix(skillBundle, '/references/evals/runtime.txt').role, 'source');
  assert.equal(roleBySuffix(skillBundle, '/assets/reports/runtime.txt').role, 'source');
});
test('Skills named evals or reports remain review targets with root-relative author evidence', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-special-skill-names-'));
  temps.push(t);
  const plugin = path.join(t, 'demo');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  for (const name of ['evals', 'reports']) {
    const skill = path.join(plugin, 'skills', name);
    await mkdir(path.join(skill, 'evals'), { recursive: true });
    await mkdir(path.join(skill, 'reports'), { recursive: true });
    await mkdir(path.join(skill, 'references', 'evals'), { recursive: true });
    await mkdir(path.join(skill, 'assets', 'reports'), { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: source\n---\n`,
    );
    await writeFile(path.join(skill, 'evals', 'cases.json'), '{"case":1}\n');
    await writeFile(path.join(skill, 'reports', 'review.md'), 'review\n');
    await writeFile(path.join(skill, 'references', 'evals', 'runtime.md'), 'runtime eval\n');
    await writeFile(path.join(skill, 'assets', 'reports', 'runtime.md'), 'runtime report\n');
  }

  const initial = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--repo-root',
        t,
      ])
    ).stdout,
  ).reviewTargets;
  assert.deepEqual(initial.map((entry) => entry.targetName), ['evals', 'reports']);
  for (const entry of initial) {
    const bundle = entry.bundle,
      role = (suffix) => bundle.artifacts.find((artifact) => artifact.path.endsWith(suffix)).role;
    assert.equal(role(`/${entry.targetName}/evals/cases.json`), 'evidence');
    assert.equal(role(`/${entry.targetName}/reports/review.md`), 'evidence');
    assert.equal(role(`/${entry.targetName}/references/evals/runtime.md`), 'source');
    assert.equal(role(`/${entry.targetName}/assets/reports/runtime.md`), 'source');
  }

  const evalsRoot = path.join(plugin, 'skills', 'evals'),
    evalsDigest = await computeSkillDigest(evalsRoot),
    bundlePath = path.join(t, 'plugin-bundle.json');
  await writeFile(
    bundlePath,
    JSON.stringify({
      environment: { repositoryRoot: t },
      orchestration: {
        providedStages: [{
          id: 'eval-execution',
          producer: 'run-agent-skill-evals',
          independentContext: true,
          subjectDigest: evalsDigest,
          resultPath: 'eval-run.json',
          resultDigest: `sha256:${'1'.repeat(64)}`,
          schema: 'EvalRunBundle',
          profile: null,
        }],
      },
      evalResults: [{ targetSkillDigest: evalsDigest }],
    }),
  );
  const projected = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets.find((entry) => entry.targetName === 'evals').bundle;
  assert.equal(projected.target.sourceDigest, evalsDigest);
  assert.equal(projected.orchestration.providedStages.length, 1);
  assert.equal(projected.evalResults.length, 1);

  await writeFile(path.join(evalsRoot, 'evals', 'cases.json'), '{"case":2}\n');
  const authorOnlyChanged = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets.find((entry) => entry.targetName === 'evals').bundle;
  assert.equal(authorOnlyChanged.target.sourceDigest, evalsDigest);
  assert.equal(authorOnlyChanged.orchestration.providedStages.length, 1);

  await writeFile(path.join(evalsRoot, 'references', 'evals', 'runtime.md'), 'changed runtime\n');
  const productionChanged = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets.find((entry) => entry.targetName === 'evals').bundle;
  assert.notEqual(productionChanged.target.sourceDigest, evalsDigest);
  assert.equal(productionChanged.orchestration.providedStages.length, 0);
});
test('plugin review identity binds regular-file mode without changing content digest semantics', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-plugin-mode-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    executable = path.join(plugin, 'scripts', 'run.sh');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o644);
  await git(t, ['init', '-q']);
  await git(t, ['config', 'user.name', 'AW Test']);
  await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(t, ['config', 'core.fileMode', 'true']);
  await git(t, ['add', '.']);
  await git(t, ['commit', '-qm', 'fixture']);

  const regular = await prepareBundle(plugin, t);
  const regularArtifact = regular.artifacts.find((artifact) =>
    artifact.path.endsWith('/scripts/run.sh'),
  );
  assert.equal(regularArtifact.mode, '100644');
  assert.equal(regularArtifact.digest, sha('#!/bin/sh\nexit 0\n'));
  assert.equal(regular.target.currentness, 'current');
  assert.equal(
    JSON.parse((await validatePreparedBundle(regular, t, 'regular-review.json')).stdout).valid,
    true,
  );

  await chmod(executable, 0o755);
  const executableBundle = await prepareBundle(plugin, t);
  const executableArtifact = executableBundle.artifacts.find((artifact) =>
    artifact.path.endsWith('/scripts/run.sh'),
  );
  assert.equal(executableArtifact.mode, '100755');
  assert.equal(executableArtifact.digest, regularArtifact.digest);
  assert.equal(executableArtifact.currentness, 'dirty');
  assert.equal(executableBundle.target.currentness, 'dirty');
  assert.notEqual(executableBundle.target.sourceDigest, regular.target.sourceDigest);
  assert.equal(
    JSON.parse((await validatePreparedBundle(executableBundle, t, 'dirty-review.json')).stdout)
      .valid,
    true,
  );

  await symlink(path.join(skill, 'SKILL.md'), path.join(plugin, 'linked-skill.md'));
  await assert.rejects(prepareBundle(plugin, t), /Command failed/u);
});
test('Git index mode keeps currentness accurate when core.fileMode is false', async () => {
  if (process.platform === 'win32') return;
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-filemode-false-'));
  temps.push(t);
  const workspace = path.join(t, 'external-workspace'),
    plugin = path.join(workspace, 'packages', 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    executable = path.join(plugin, 'scripts', 'run.sh'),
    relativeExecutable = path.relative(workspace, executable);
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o644);
  await git(workspace, ['init', '-q']);
  await git(workspace, ['config', 'user.name', 'AW Test']);
  await git(workspace, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(workspace, ['config', 'core.fileMode', 'false']);
  await git(workspace, ['add', '.']);
  await git(workspace, ['commit', '-qm', 'fixture']);

  const clean = await prepareBundle(plugin, workspace);
  assert.equal(clean.target.currentness, 'current');

  await chmod(executable, 0o755);
  assert.equal((await git(workspace, ['status', '--porcelain=v1', '--', relativeExecutable])).stdout, '');
  const dirty = await prepareBundle(plugin, workspace);
  const dirtyArtifact = dirty.artifacts.find((artifact) =>
    artifact.path.endsWith('/scripts/run.sh'),
  );
  assert.equal(dirtyArtifact.mode, '100755');
  assert.equal(dirtyArtifact.currentness, 'dirty');
  assert.equal(
    dirtyArtifact.currentnessReason,
    'working mode 100755 differs from Git index mode 100644',
  );
  assert.equal(dirty.target.currentness, 'dirty');
  assert.ok(dirty.target.dirtyReasons.some((reason) => reason.includes(dirtyArtifact.currentnessReason)));
  assert.equal(
    JSON.parse((await validatePreparedBundle(dirty, workspace, 'mode-review.json')).stdout).valid,
    true,
  );

  await chmod(executable, 0o644);
  const restored = await prepareBundle(plugin, workspace);
  assert.equal(restored.target.currentness, 'current');

  await git(workspace, ['update-index', '--chmod=+x', relativeExecutable]);
  const indexChanged = await prepareBundle(plugin, workspace);
  const indexChangedArtifact = indexChanged.artifacts.find((artifact) =>
    artifact.path.endsWith('/scripts/run.sh'),
  );
  assert.equal(
    indexChangedArtifact.currentnessReason,
    'working mode 100644 differs from Git index mode 100755',
  );
  assert.ok(indexChanged.target.dirtyReasons.some((reason) => reason.includes('Git index mode 100755')));
});
test('ignored production is dirty while ignored author evidence does not pollute source currentness', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-ignored-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    ignoredProduction = path.join(skill, 'references', 'ignored.md'),
    ignoredEvidence = path.join(skill, 'evals', 'ignored.json'),
    globalIgnore = path.join(t, 'global-ignore.conf');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.dirname(ignoredProduction), { recursive: true });
  await mkdir(path.dirname(ignoredEvidence), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(globalIgnore, 'ignored.md\n');
  await writeFile(path.join(skill, '.gitignore'), 'evals/ignored.json\n');
  await git(t, ['init', '-q']);
  await git(t, ['config', 'user.name', 'AW Test']);
  await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(t, ['config', 'core.excludesFile', globalIgnore]);
  await git(t, ['add', '.']);
  await git(t, ['commit', '-qm', 'fixture']);
  await writeFile(ignoredProduction, 'workspace-only production\n');
  await writeFile(ignoredEvidence, '{"workspaceOnly":true}\n');

  const dirty = await prepareBundle(plugin, t);
  const productionArtifact = dirty.artifacts.find((artifact) =>
      artifact.path.endsWith('/references/ignored.md'),
    ),
    evidenceArtifact = dirty.artifacts.find((artifact) =>
      artifact.path.endsWith('/evals/ignored.json'),
    );
  assert.equal(productionArtifact.currentness, 'dirty');
  assert.equal(productionArtifact.currentnessReason, 'ignored source file');
  assert.equal(evidenceArtifact.currentness, 'historical');
  assert.equal(dirty.target.currentness, 'dirty');
  assert.ok(
    dirty.target.dirtyReasons.includes(
      `ignored production source file: ${ignoredProduction}`,
    ),
  );
  assert.equal(
    JSON.parse((await validatePreparedBundle(dirty, t, 'ignored-review.json')).stdout).valid,
    true,
  );
  const bundlePath = path.join(t, 'ignored-bundle.json');
  await writeFile(bundlePath, JSON.stringify(dirty));
  const projected = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(projected.target.currentness, 'dirty');
  assert.ok(
    projected.target.dirtyReasons.some((reason) =>
      reason.includes('ignored source file: demo/skills/one/references/ignored.md'),
    ),
  );

  await rm(ignoredProduction);
  const authorOnly = await prepareBundle(plugin, t);
  assert.equal(authorOnly.target.currentness, 'current');
  assert.equal(authorOnly.target.dirtyReasons, undefined);
});
test('.DS_Store is ignored across review artifacts, digest, currentness, and Skill runtime identity', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-ds-store-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    dsStore = path.join(skill, '.DS_Store'),
    nestedDsStore = path.join(skill, 'references', '.DS_Store', 'metadata'),
    hiddenRuntime = path.join(skill, '.runtime-hidden');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await git(t, ['init', '-q']);
  await git(t, ['config', 'user.name', 'AW Test']);
  await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(t, ['add', '.']);
  await git(t, ['commit', '-qm', 'fixture']);

  const baseline = await prepareBundle(plugin, t);
  const baselineSkillDigest = await computeSkillDigest(skill);
  await writeFile(dsStore, 'finder metadata\n');
  await mkdir(path.dirname(nestedDsStore), { recursive: true });
  await writeFile(nestedDsStore, 'nested finder metadata\n');
  const bundle = await prepareBundle(plugin, t);
  assert.equal(bundle.artifacts.some((artifact) => artifact.path.split('/').includes('.DS_Store')), false);
  assert.equal(bundle.target.sourceDigest, baseline.target.sourceDigest);
  assert.equal(bundle.target.currentness, 'current');
  assert.equal(bundle.target.dirtyReasons, undefined);
  assert.equal(
    JSON.parse((await validatePreparedBundle(bundle, t, 'ds-store-review.json')).stdout).valid,
    true,
  );

  const runtimeDigest = await computeSkillDigest(skill);
  assert.equal(runtimeDigest, baselineSkillDigest);
  assert.equal(await sourceSkillDigest(plugin), runtimeDigest);

  await writeFile(hiddenRuntime, 'hidden production file\n');
  const hiddenBundle = await prepareBundle(plugin, t);
  assert.ok(hiddenBundle.artifacts.some((artifact) =>
    artifact.path.endsWith('/skills/one/.runtime-hidden')));
  assert.notEqual(hiddenBundle.target.sourceDigest, baseline.target.sourceDigest);
  assert.notEqual(await computeSkillDigest(skill), baselineSkillDigest);
});
test('Skill target projection uses the shared Eval digest and retains matching stages', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-shared-digest-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    executable = path.join(skill, 'scripts', 'run.sh'),
    authorEvidence = path.join(skill, 'evals', 'cases.json');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.dirname(authorEvidence), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: source\n---\n');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  await writeFile(authorEvidence, '{"case":1}\n');

  const sharedDigest = await computeSkillDigest(skill);
  const bundlePath = path.join(t, 'plugin-bundle.json');
  await writeFile(
    bundlePath,
    JSON.stringify({
      environment: { repositoryRoot: t },
      orchestration: {
        providedStages: [{
          id: 'eval-execution',
          producer: 'run-agent-skill-evals',
          independentContext: true,
          subjectDigest: sharedDigest,
          resultPath: 'eval-run.json',
          resultDigest: `sha256:${'1'.repeat(64)}`,
          schema: 'EvalRunBundle',
          profile: null,
        }],
      },
      evalResults: [{ targetSkillDigest: sharedDigest }],
    }),
  );

  const first = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(first.target.sourceDigest, sharedDigest);
  assert.equal(first.orchestration.providedStages.length, 1);
  assert.equal(first.evalResults.length, 1);

  await writeFile(authorEvidence, '{"case":2}\n');
  const authorOnlyChanged = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(authorOnlyChanged.target.sourceDigest, sharedDigest);
  assert.equal(authorOnlyChanged.orchestration.providedStages.length, 1);

  await chmod(executable, 0o644);
  const modeChangedDigest = await computeSkillDigest(skill);
  assert.notEqual(modeChangedDigest, sharedDigest);
  const modeChanged = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(modeChanged.target.sourceDigest, modeChangedDigest);
  assert.equal(modeChanged.orchestration.providedStages.length, 0);

  await symlink(path.join(skill, 'SKILL.md'), path.join(skill, 'linked-skill.md'));
  await assert.rejects(computeSkillDigest(skill), /Command failed/u);
  await assert.rejects(
    run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [plugin]),
    /Command failed/u,
  );
});
test('Skill targets inherit matching artifact currentness and default unmatched artifacts to unknown', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-currentness-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    finalRoot = path.join(t, 'final'),
    finalSkill = path.join(finalRoot, 'one'),
    skillFile = path.join(skill, 'SKILL.md'),
    currentFile = path.join(skill, 'README.md'),
    unmatchedFile = path.join(skill, 'references', 'runtime.md'),
    evidenceFile = path.join(skill, 'evals', 'cases.json'),
    finalFile = path.join(finalSkill, 'SKILL.md');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.dirname(unmatchedFile), { recursive: true });
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await mkdir(finalSkill, { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(skillFile, '---\nname: one\ndescription: source\n---\n');
  await writeFile(currentFile, 'current\n');
  await writeFile(unmatchedFile, 'unmatched\n');
  await writeFile(evidenceFile, '{"case":1}\n');
  await writeFile(finalFile, '---\nname: one\ndescription: final\n---\n');
  await git(t, ['init', '-q']);
  await git(t, ['config', 'user.name', 'AW Test']);
  await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(t, ['add', '.']);
  await git(t, ['commit', '-qm', 'fixture']);
  await writeFile(skillFile, '---\nname: one\ndescription: dirty\n---\n');

  const bundle = await prepareBundle(plugin, t, ['--final', `codex=${finalRoot}`]);
  const findByPath = (suffix) =>
    bundle.artifacts.find((artifact) => artifact.path.endsWith(suffix.replace(/^\//u, '')));
  assert.equal(findByPath('/skills/one/README.md').currentness, 'current');
  assert.equal(findByPath('/skills/one/SKILL.md').currentness, 'dirty');
  assert.equal(findByPath('/skills/one/evals/cases.json').currentness, 'historical');
  assert.equal(findByPath('/final/one/SKILL.md').currentness, 'unknown');

  findByPath('/skills/one/references/runtime.md').digest = `sha256:${'0'.repeat(64)}`;
  findByPath('/final/one/SKILL.md').currentness = 'current';
  const bundlePath = path.join(t, 'plugin-bundle.json');
  await writeFile(bundlePath, JSON.stringify(bundle));
  const targets = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--final',
        `codex=${finalRoot}`,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets;
  const source = targets.find((target) => target.kind === 'aw-plugin-skill').bundle,
    final = targets.find((target) => target.kind === 'materialized-skill').bundle,
    currentnessBySuffix = (target, suffix) =>
      target.artifacts.find((artifact) => artifact.path.endsWith(suffix)).currentness;
  assert.equal(currentnessBySuffix(source, '/one/README.md'), 'current');
  assert.equal(currentnessBySuffix(source, '/one/SKILL.md'), 'dirty');
  assert.equal(currentnessBySuffix(source, '/one/evals/cases.json'), 'historical');
  assert.equal(currentnessBySuffix(source, '/one/references/runtime.md'), 'unknown');
  assert.equal(currentnessBySuffix(final, '/one/SKILL.md'), 'current');
});
test('production deletions dirty targets while author evidence deletions do not dirty source', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-deletion-'));
  temps.push(t);
  const plugin = path.join(t, 'demo'),
    skill = path.join(plugin, 'skills', 'one'),
    runtimeFile = path.join(skill, 'references', 'runtime.md'),
    reportFile = path.join(skill, 'reports', 'nested', 'review.md');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', skills: './skills' }),
  );
  await writeFile(skill + '/SKILL.md', '---\nname: one\ndescription: source\n---\n');
  await writeFile(runtimeFile, 'runtime\n');
  await writeFile(reportFile, 'report\n');
  await git(t, ['init', '-q']);
  await git(t, ['config', 'user.name', 'AW Test']);
  await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(t, ['add', '.']);
  await git(t, ['commit', '-qm', 'fixture']);

  const baseline = await prepareBundle(plugin, t);
  await rm(runtimeFile);
  const runtimeDeleted = await prepareBundle(plugin, t);
  assert.equal(runtimeDeleted.target.currentness, 'dirty');
  assert.ok(
    runtimeDeleted.target.dirtyReasons.some(
      (reason) => reason === `deleted production source file: ${runtimeFile}`,
    ),
  );
  assert.ok(!runtimeDeleted.artifacts.some((artifact) => artifact.path === runtimeFile));

  const bundlePath = path.join(t, 'runtime-deleted.json');
  await writeFile(bundlePath, JSON.stringify(runtimeDeleted));
  const projected = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        plugin,
        '--bundle',
        bundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(projected.target.currentness, 'dirty');
  assert.ok(projected.target.dirtyReasons.some((reason) => reason.endsWith(runtimeFile)));

  await writeFile(runtimeFile, 'runtime\n');
  await rm(reportFile);
  const reportDeleted = await prepareBundle(plugin, t);
  assert.equal(reportDeleted.target.currentness, 'current');
  assert.equal(reportDeleted.target.sourceDigest, baseline.target.sourceDigest);
  assert.ok(!reportDeleted.artifacts.some((artifact) => artifact.path === reportFile));
  assert.equal(
    reportDeleted.artifacts.filter((artifact) => artifact.role === 'evidence').length,
    baseline.artifacts.filter((artifact) => artifact.role === 'evidence').length - 1,
  );
});
test('renames and copies preserve production currentness without dirtying author-only moves', async () => {
  async function createFixture(prefix, files) {
    const t = await mkdtemp(path.join(tmpdir(), prefix));
    temps.push(t);
    const plugin = path.join(t, 'demo');
    await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
    await writeFile(
      path.join(plugin, '.agents-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills' }),
    );
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(plugin, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    }
    await git(t, ['init', '-q']);
    await git(t, ['config', 'user.name', 'AW Test']);
    await git(t, ['config', 'user.email', 'aw-test@example.invalid']);
    await git(t, ['add', '.']);
    await git(t, ['commit', '-qm', 'fixture']);
    return { t, plugin };
  }

  const productionMove = await createFixture('aw-review-production-rename-', {
    'skills/one/SKILL.md': '---\nname: one\ndescription: source\n---\n',
    'skills/one/references/runtime file.md': 'runtime\n',
    'skills/one/assets/report source.txt': 'report source\n',
  });
  const productionBaseline = await prepareBundle(productionMove.plugin, productionMove.t);
  const productionOld = path.join(
      productionMove.plugin,
      'skills',
      'one',
      'references',
      'runtime file.md',
    ),
    productionNew = path.join(
      productionMove.plugin,
      'skills',
      'one',
      'evals',
      'runtime file.md',
    ),
    reportSourceOld = path.join(
      productionMove.plugin,
      'skills',
      'one',
      'assets',
      'report source.txt',
    ),
    reportSourceNew = path.join(
      productionMove.plugin,
      'skills',
      'one',
      'reports',
      'report source.txt',
    );
  await mkdir(path.dirname(productionNew), { recursive: true });
  await mkdir(path.dirname(reportSourceNew), { recursive: true });
  await git(productionMove.t, ['mv', productionOld, productionNew]);
  await git(productionMove.t, ['mv', reportSourceOld, reportSourceNew]);
  const productionRenamed = await prepareBundle(productionMove.plugin, productionMove.t);
  assert.equal(productionRenamed.target.currentness, 'dirty');
  assert.ok(
    productionRenamed.target.dirtyReasons.includes(
      `deleted production source file: ${productionOld}`,
    ),
  );
  assert.ok(
    productionRenamed.target.dirtyReasons.includes(
      `deleted production source file: ${reportSourceOld}`,
    ),
  );
  assert.notEqual(productionRenamed.target.sourceDigest, productionBaseline.target.sourceDigest);
  assert.equal(
    productionRenamed.artifacts.find((artifact) =>
      artifact.path.endsWith('/skills/one/evals/runtime file.md'),
    ).currentness,
    'historical',
  );
  assert.equal(
    productionRenamed.artifacts.find((artifact) =>
      artifact.path.endsWith('/skills/one/reports/report source.txt'),
    ).currentness,
    'historical',
  );
  assert.ok(
    !productionRenamed.artifacts.some((artifact) =>
      artifact.path.endsWith('/skills/one/references/runtime file.md'),
    ),
  );
  const productionBundlePath = path.join(productionMove.t, 'production-renamed.json');
  await writeFile(productionBundlePath, JSON.stringify(productionRenamed));
  const productionTarget = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        productionMove.plugin,
        '--bundle',
        productionBundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(productionTarget.target.currentness, 'dirty');
  assert.ok(
    productionTarget.target.dirtyReasons.includes(
      `deleted production source file: ${productionOld}`,
    ),
  );

  const skillMove = await createFixture('aw-review-skill-rename-', {
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source\n---\n',
  });
  const skillBaseline = await prepareBundle(skillMove.plugin, skillMove.t);
  const oldSkill = path.join(skillMove.plugin, 'skills', 'alpha'),
    newSkill = path.join(skillMove.plugin, 'skills', 'beta'),
    oldSkillFile = path.join(oldSkill, 'SKILL.md'),
    newSkillFile = path.join(newSkill, 'SKILL.md');
  await git(skillMove.t, ['mv', oldSkill, newSkill]);
  await writeFile(newSkillFile, '---\nname: beta\ndescription: source\n---\n');
  const skillRenamed = await prepareBundle(skillMove.plugin, skillMove.t);
  assert.equal(skillRenamed.target.currentness, 'dirty');
  assert.ok(
    skillRenamed.target.dirtyReasons.includes(
      `deleted production source file: ${oldSkillFile}`,
    ),
  );
  assert.ok(
    skillRenamed.target.dirtyReasons.includes(
      `added production source file: ${newSkillFile}`,
    ),
  );
  assert.notEqual(skillRenamed.target.sourceDigest, skillBaseline.target.sourceDigest);
  const renamedSkillArtifact = skillRenamed.artifacts.find(
    (artifact) => artifact.path.endsWith('/skills/beta/SKILL.md'),
  );
  assert.equal(renamedSkillArtifact.currentness, 'dirty');
  assert.equal(renamedSkillArtifact.currentnessReason, 'added source file');
  const skillBundlePath = path.join(skillMove.t, 'skill-renamed.json');
  await writeFile(skillBundlePath, JSON.stringify(skillRenamed));
  const renamedSkillTarget = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [
        skillMove.plugin,
        '--bundle',
        skillBundlePath,
      ])
    ).stdout,
  ).reviewTargets[0].bundle;
  assert.equal(renamedSkillTarget.target.name, 'beta');
  assert.equal(renamedSkillTarget.target.currentness, 'dirty');
  assert.equal(
    renamedSkillTarget.artifacts.find(
      (artifact) => artifact.path === path.relative(skillMove.t, newSkillFile),
    ).currentness,
    'dirty',
  );

  const evidenceMove = await createFixture('aw-review-evidence-rename-', {
    'skills/one/SKILL.md': '---\nname: one\ndescription: source\n---\n',
    'skills/one/evals/case a.json': '{"case":1}\n',
  });
  const evidenceBaseline = await prepareBundle(evidenceMove.plugin, evidenceMove.t);
  const evidenceOld = path.join(evidenceMove.plugin, 'skills', 'one', 'evals', 'case a.json'),
    evidenceNew = path.join(evidenceMove.plugin, 'skills', 'one', 'reports', 'case b.json');
  await mkdir(path.dirname(evidenceNew), { recursive: true });
  await git(evidenceMove.t, ['mv', evidenceOld, evidenceNew]);
  const evidenceRenamed = await prepareBundle(evidenceMove.plugin, evidenceMove.t);
  assert.equal(evidenceRenamed.target.currentness, 'current');
  assert.equal(evidenceRenamed.target.dirtyReasons, undefined);
  assert.equal(evidenceRenamed.target.sourceDigest, evidenceBaseline.target.sourceDigest);
  assert.equal(
    evidenceRenamed.artifacts.find((artifact) =>
      artifact.path.endsWith('/skills/one/reports/case b.json'),
    ).currentness,
    'historical',
  );
  assert.ok(
    !evidenceRenamed.artifacts.some((artifact) =>
      artifact.path.endsWith('/skills/one/evals/case a.json'),
    ),
  );

  const evidenceCopy = await createFixture('aw-review-evidence-copy-', {
    'skills/one/SKILL.md': '---\nname: one\ndescription: source\n---\n',
    'skills/one/evals/case source.json': '{"case":1}\n',
  });
  const copyBaseline = await prepareBundle(evidenceCopy.plugin, evidenceCopy.t);
  const copySource = path.join(
      evidenceCopy.plugin,
      'skills',
      'one',
      'evals',
      'case source.json',
    ),
    copyTarget = path.join(
      evidenceCopy.plugin,
      'skills',
      'one',
      'reports',
      'case copy.json',
    );
  await mkdir(path.dirname(copyTarget), { recursive: true });
  await copyFile(copySource, copyTarget);
  await git(evidenceCopy.t, ['config', 'status.renames', 'copies']);
  await git(evidenceCopy.t, ['add', copyTarget]);
  const evidenceCopied = await prepareBundle(evidenceCopy.plugin, evidenceCopy.t);
  assert.equal(evidenceCopied.target.currentness, 'current');
  assert.equal(evidenceCopied.target.dirtyReasons, undefined);
  assert.equal(evidenceCopied.target.sourceDigest, copyBaseline.target.sourceDigest);
  assert.equal(
    evidenceCopied.artifacts.find((artifact) =>
      artifact.path.endsWith('/skills/one/reports/case copy.json'),
    ).currentness,
    'historical',
  );
});
test('handoff validator rejects missing or forged stage artifacts', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-stage-'));
  temps.push(t);
  const skillRaw = '---\nname: x\ndescription: fixture\n---\n';
  await mkdir(path.join(t, 'skill'), { recursive: true });
  await writeFile(path.join(t, 'skill', 'SKILL.md'), skillRaw);
  const skillDigest = await computeSkillDigest(path.join(t, 'skill'));
  const result = {
    schemaVersion: 3,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'a',
    mode: 'preflight',
    targetSkillDigest: skillDigest,
    caseCorpusDigest: 'sha256:' + '2'.repeat(64),
    runBundleDigest: null,
    validity: 'unknown',
    optimizationPolicy: 'balanced',
    cases: [],
    blockedCases: [],
    releaseEligible: false,
    failureTriage: [],
    recommendedAction: 'collect-more-data',
  };
  const rp = path.join(t, 'audit.json'),
    raw = JSON.stringify(result);
  await writeFile(rp, raw);
  const bundle = {
    schemaVersion: 5,
    target: {
      kind: 'agent-skill',
      name: 'x',
      profile: null,
      sourceDigest: skillDigest,
      currentness: 'unknown',
    },
    artifacts: [{
      role: 'source',
      path: 'skill/SKILL.md',
      profile: null,
      digest: sha(skillRaw),
      mode: '100644',
      owner: 'x',
      currentness: 'unknown',
    }],
    environment: { repositoryRoot: t },
    orchestration: {
      stageOwner: 'caller',
      providedStages: [
        {
          id: 'eval-audit',
          producer: 'audit-agent-skill-evals',
          independentContext: true,
          subjectDigest: skillDigest,
          resultPath: 'audit.json',
          resultDigest: sha(raw),
          schema: 'EvalAuditResult',
          profile: null,
        },
      ],
    },
    evalAudit: result,
    evalResults: [],
  };
  const bp = path.join(t, 'bundle.json');
  await writeFile(bp, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (
        await run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
          bp,
          '--handoff-root',
          t,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );
  bundle.orchestration.providedStages[0].resultDigest = 'sha256:' + '0'.repeat(64);
  await writeFile(bp, JSON.stringify(bundle));
  await assert.rejects(
    run('skills/review-aw-plugin/scripts/validate-review-input-bundle.mjs', [
      bp,
      '--handoff-root',
      t,
    ]),
    /Command failed/u,
  );
});
