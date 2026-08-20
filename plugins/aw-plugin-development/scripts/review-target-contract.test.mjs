import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  temps = [];
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
async function sourceSkillDigest(plugin) {
  const value = JSON.parse(
    (
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [plugin])
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
    final = path.join(t, 'final', 'one');
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
      await run('skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs', [plugin])
    ).stdout,
  ).reviewTargets;
  const skillBundle = targets[0].bundle;
  assert.equal(roleBySuffix(skillBundle, '/one/evals/cases.json').role, 'evidence');
  assert.equal(roleBySuffix(skillBundle, '/one/reports/review.md').role, 'evidence');
  assert.equal(roleBySuffix(skillBundle, '/references/evals/runtime.txt').role, 'source');
  assert.equal(roleBySuffix(skillBundle, '/assets/reports/runtime.txt').role, 'source');
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
    bundle.artifacts.find((artifact) => artifact.path.endsWith(suffix));
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
test('handoff validator rejects missing or forged stage artifacts', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-stage-'));
  temps.push(t);
  const result = {
    schemaVersion: 2,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'a',
    mode: 'preflight',
    targetSkillDigest: 'sha256:' + '1'.repeat(64),
    caseCorpusDigest: 'sha256:' + '2'.repeat(64),
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
    schemaVersion: 4,
    target: {
      kind: 'agent-skill',
      name: 'x',
      profile: null,
      sourceDigest: 'sha256:' + '1'.repeat(64),
    },
    artifacts: [],
    environment: {},
    orchestration: {
      stageOwner: 'caller',
      providedStages: [
        {
          id: 'eval-audit',
          producer: 'audit-agent-skill-evals',
          independentContext: true,
          subjectDigest: 'sha256:' + '1'.repeat(64),
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
