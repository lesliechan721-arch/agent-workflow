import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')).sourceRoot
  : localRoot;
const temps = [];
after(async () => Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }))));
async function run(rel, args = []) {
  return execFileAsync(process.execPath, [path.join(root, rel), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
}
async function files(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
test('generic surfaces do not name optional AW adapters', async () => {
  const forbidden =
      /\b(agent-workflows|aw-plugin-development|author-aw-plugin|review-aw-plugin)\b/u,
    violations = [];
  for (const p of await files(root)) {
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (
      !(
        rel.startsWith('standards/') ||
        rel.startsWith('schemas/') ||
        rel.endsWith('/SKILL.md') ||
        rel.endsWith('/README.md') ||
        rel.endsWith('.generated.md')
      )
    )
      continue;
    if (forbidden.test(await readFile(p, 'utf8'))) violations.push(rel);
  }
  assert.deepEqual(violations, []);
});
test('generated standards and contracts are current', async () => {
  await run('scripts/validate-standard-views.mjs');
  await run('scripts/validate-contract-assets.mjs');
});
test('upper rules extend lower canonical content rules without redefining them', async () => {
  const contentPath = path.resolve(root, '..', 'agent-content-toolkit', 'standards', 'rules.json');
  const [raw, skill, manifest] = await Promise.all([
    readFile(contentPath, 'utf8'),
    readFile(path.join(root, 'standards/skill-rules.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'standards/rules.json'), 'utf8').then(JSON.parse),
  ]);
  const ids = new Set(JSON.parse(raw).rules.map((r) => r.id));
  assert.deepEqual(
    skill.rules.filter((r) => ids.has(r.id)),
    [],
  );
  for (const e of skill.contentRuleExtensions) {
    assert.ok(ids.has(e.id));
    assert.deepEqual(
      Object.keys(e).filter(
        (k) =>
          k !== 'id' && !['skill_author', 'skill_review', 'eval_design', 'eval_audit'].includes(k),
      ),
      [],
    );
  }
  const digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
  assert.equal(skill.contentRuleSource.digest, digest);
  assert.equal(manifest.contentRules.digest, digest);
});
test('owned contracts and manifest use release version', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.version, '0.5.0');
  for (const [name, id] of [
    [
      'skill-design-brief.schema.json',
      'https://agent-skill-toolkit.invalid/schemas/skill-design-brief.schema.json',
    ],
    [
      'eval-audit-result.schema.json',
      'https://agent-skill-toolkit.invalid/schemas/eval-audit-result.schema.json',
    ],
  ])
    assert.equal(JSON.parse(await readFile(path.join(root, 'schemas', name), 'utf8')).$id, id);
});
test('starter contracts validate', async () => {
  const pairs = [
    [
      'schemas/skill-design-brief.schema.json',
      'skills/author-agent-skill/assets/skill-design-brief.template.json',
    ],
    [
      'schemas/eval-audit-result.schema.json',
      'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json',
    ],
    [
      'schemas/review-input-bundle.schema.json',
      'skills/review-agent-skill/assets/review-input-bundle.json',
    ],
  ];
  for (const [s, v] of pairs) await run('scripts/validate-json-contract.mjs', [s, v]);
  await run('scripts/validate-review-result.mjs', [
    'skills/review-agent-skill/assets/review-result-template.json',
  ]);
});
test('ReviewInputBundle validator binds a real stage file and digest', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'review-handoff-'));
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
  const raw = JSON.stringify(result),
    rp = path.join(t, 'audit.json');
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
        await run('scripts/validate-review-input-bundle.mjs', [
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
  bundle.schemaVersion = 3;
  await writeFile(bp, JSON.stringify(bundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );
  bundle.schemaVersion = 4;
  bundle.orchestration.providedStages[0].resultPath = 'missing.json';
  await writeFile(bp, JSON.stringify(bundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );
});

async function reviewStageFixture(directory, fileName, profile, name) {
  const value = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  value.target = {
    kind: 'materialized-skill',
    name,
    profile,
    digest: 'sha256:' + '4'.repeat(64),
  };
  const raw = JSON.stringify(value);
  await writeFile(path.join(directory, fileName), raw);
  return {
    id: 'materialized-profile-review',
    producer: 'review-agent-skill',
    independentContext: true,
    subjectDigest: value.target.digest,
    resultPath: fileName,
    resultDigest: sha(raw),
    schema: 'ReviewResult',
    profile,
  };
}

function reviewBundle(stages) {
  return {
    schemaVersion: 4,
    target: {
      kind: 'aw-plugin',
      name: 'fixture',
      profile: null,
      sourceDigest: 'sha256:' + '5'.repeat(64),
    },
    artifacts: [],
    environment: {},
    orchestration: { stageOwner: 'caller', providedStages: stages },
    evalAudit: null,
    evalResults: [],
  };
}

test('ReviewInputBundle rejects conflicting results for one semantic stage slot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-slot-'));
  temps.push(directory);
  const stages = await Promise.all([
    reviewStageFixture(directory, 'first.json', 'project-default', 'first'),
    reviewStageFixture(directory, 'second.json', 'project-default', 'second'),
  ]);
  const bundlePath = path.join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(reviewBundle(stages)));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [
      bundlePath,
      '--handoff-root',
      directory,
    ]),
    /Command failed/u,
  );
});

test('ReviewInputBundle accepts materialized reviews for different profiles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-profiles-'));
  temps.push(directory);
  const stages = await Promise.all([
    reviewStageFixture(directory, 'project.json', 'project-default', 'project'),
    reviewStageFixture(directory, 'user.json', 'user-default', 'user'),
  ]);
  const bundlePath = path.join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(reviewBundle(stages)));
  const result = JSON.parse(
    (
      await run('scripts/validate-review-input-bundle.mjs', [
        bundlePath,
        '--handoff-root',
        directory,
        '--format',
        'json',
      ])
    ).stdout,
  );
  assert.equal(result.valid, true);
});

function evalRunBundle() {
  const run = (configuration, skillMode) => ({
    caseId: 'case-1',
    configuration,
    comparisonId: 'quality',
    skillMode,
    skillDigest: skillMode === 'with-skill' ? 'sha256:' + '1'.repeat(64) : null,
    runIndex: 1,
    status: 'completed',
    exitCode: 0,
    durationMs: 1,
    stdoutPath: `${configuration}/stdout.txt`,
    stdoutDigest: sha(`stdout:${configuration}`),
    stderrPath: `${configuration}/stderr.txt`,
    stderrDigest: sha(`stderr:${configuration}`),
    usage: null,
    grading: { grader: { id: 'fixture', version: '1' }, result: { passed: true } },
    artifacts: [
      {
        role: 'trace',
        path: `${configuration}/trace.json`,
        digest: sha(`trace:${configuration}`),
      },
    ],
  });
  return {
    schemaVersion: 2,
    producer: 'run-agent-skill-evals',
    independentContext: true,
    provider: { id: 'fixture', version: '1' },
    planDigest: 'sha256:' + '4'.repeat(64),
    targetSkillDigest: 'sha256:' + '1'.repeat(64),
    caseCorpusDigest: 'sha256:' + '5'.repeat(64),
    preflightAuditDigest: 'sha256:' + '6'.repeat(64),
    comparisonPlanned: true,
    evidenceLevel: 'comparative',
    runs: [run('with', 'with-skill'), run('baseline', 'without-skill')],
    aggregate: {
      cases: 1,
      configurations: 2,
      runs: 2,
      completed: 2,
      processFailed: 0,
      timedOut: 0,
      comparisons: [
        {
          comparisonId: 'quality',
          caseId: 'case-1',
          runIndex: 1,
          paired: true,
          comparable: true,
        },
      ],
    },
    limitations: [],
  };
}

async function createEvalRunFixture(value = evalRunBundle()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eval-run-bundle-'));
  temps.push(directory);
  const valuePath = path.join(directory, 'bundle.json');
  for (const runValue of value.runs) {
    const evidence = [
      [runValue.stdoutPath, `stdout:${runValue.configuration}`],
      [runValue.stderrPath, `stderr:${runValue.configuration}`],
      ...runValue.artifacts.map((artifact) => [
        artifact.path,
        artifact.path === runValue.stdoutPath
          ? `stdout:${runValue.configuration}`
          : artifact.path === runValue.stderrPath
            ? `stderr:${runValue.configuration}`
            : `trace:${runValue.configuration}`,
      ]),
    ];
    for (const [relative, content] of evidence) {
      if (
        relative.includes('\\') ||
        path.isAbsolute(relative) ||
        relative.split('/').some((segment) => segment === '.' || segment === '..')
      )
        continue;
      const evidencePath = path.join(directory, relative);
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, content);
    }
  }
  await writeFile(valuePath, JSON.stringify(value));
  return { directory, value, valuePath };
}

async function validateEvalRunBundle(value) {
  const { valuePath } = await createEvalRunFixture(value);
  return run('scripts/validate-eval-run-bundle.mjs', [valuePath, '--format', 'json']);
}

test('EvalRunBundle validator rejects old, empty, inconsistent, and duplicate evidence', async () => {
  const old = evalRunBundle();
  old.schemaVersion = 1;
  await assert.rejects(validateEvalRunBundle(old), /Command failed/u);

  const empty = evalRunBundle();
  empty.runs = [];
  empty.aggregate = {
    cases: 0,
    configurations: 0,
    runs: 0,
    completed: 0,
    processFailed: 0,
    timedOut: 0,
    comparisons: [],
  };
  await assert.rejects(validateEvalRunBundle(empty), /Command failed/u);

  const inconsistent = evalRunBundle();
  inconsistent.aggregate.completed = 1;
  await assert.rejects(validateEvalRunBundle(inconsistent), /Command failed/u);

  const duplicate = evalRunBundle();
  duplicate.runs.push({ ...duplicate.runs[0] });
  duplicate.aggregate.runs = 3;
  duplicate.aggregate.completed = 3;
  await assert.rejects(validateEvalRunBundle(duplicate), /Command failed/u);
});

test('EvalRunBundle validator requires real comparable grading for comparative evidence', async () => {
  const value = evalRunBundle();
  value.runs[1].grading.grader.version = '2';
  value.aggregate.comparisons[0].comparable = false;
  await assert.rejects(validateEvalRunBundle(value), /Command failed/u);

  value.evidenceLevel = 'executed';
  value.limitations.push('The planned quality comparison is not comparable.');
  assert.equal(JSON.parse((await validateEvalRunBundle(value)).stdout).valid, true);
});

test('EvalRunBundle validator rejects missing and modified evidence files', async () => {
  const missing = await createEvalRunFixture();
  await rm(path.join(missing.directory, missing.value.runs[0].stdoutPath));
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [missing.valuePath]),
    /Command failed/u,
  );

  const modified = await createEvalRunFixture();
  await writeFile(path.join(modified.directory, modified.value.runs[0].stderrPath), 'modified');
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [modified.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle validator rejects unsafe evidence paths', async () => {
  for (const unsafePath of [
    '/absolute/evidence.txt',
    '../outside.txt',
    './with/stdout.txt',
    'with\\stdout.txt',
  ]) {
    const fixture = await createEvalRunFixture();
    fixture.value.runs[0].stdoutPath = unsafePath;
    await writeFile(fixture.valuePath, JSON.stringify(fixture.value));
    await assert.rejects(
      run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
      /Command failed/u,
    );
  }
});

test('EvalRunBundle validator rejects symlink evidence', async () => {
  const fixture = await createEvalRunFixture();
  const linkedPath = path.join(fixture.directory, fixture.value.runs[0].artifacts[0].path);
  const targetPath = path.join(fixture.directory, fixture.value.runs[1].artifacts[0].path);
  await rm(linkedPath);
  await symlink(targetPath, linkedPath);
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
    /Command failed/u,
  );

  const nonRegular = await createEvalRunFixture();
  const directoryPath = path.join(
    nonRegular.directory,
    nonRegular.value.runs[0].artifacts[0].path,
  );
  await rm(directoryPath);
  await mkdir(directoryPath);
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [nonRegular.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle validator rejects evidence that resolves outside its root', async () => {
  const fixture = await createEvalRunFixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'eval-run-outside-'));
  temps.push(outside);
  await writeFile(path.join(outside, 'stdout.txt'), 'stdout:with');
  await symlink(outside, path.join(fixture.directory, 'linked'));
  fixture.value.runs[0].stdoutPath = 'linked/stdout.txt';
  await writeFile(fixture.valuePath, JSON.stringify(fixture.value));
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle allows repeated file references but checks each declared digest', async () => {
  const repeated = evalRunBundle();
  repeated.runs[0].artifacts.push({
    role: 'output',
    path: repeated.runs[0].stdoutPath,
    digest: repeated.runs[0].stdoutDigest,
  });
  assert.equal(JSON.parse((await validateEvalRunBundle(repeated)).stdout).valid, true);

  repeated.runs[0].artifacts[1].digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(validateEvalRunBundle(repeated), /Command failed/u);
});

test('AW ReviewInputBundle rejects damaged Eval evidence', async () => {
  const fixture = await createEvalRunFixture();
  const raw = await readFile(fixture.valuePath, 'utf8');
  const stage = {
    id: 'eval-execution',
    producer: 'run-agent-skill-evals',
    independentContext: true,
    subjectDigest: fixture.value.targetSkillDigest,
    resultPath: path.basename(fixture.valuePath),
    resultDigest: sha(raw),
    schema: 'EvalRunBundle',
    profile: null,
  };
  const handoff = reviewBundle([stage]);
  handoff.evalResults = [fixture.value];
  const handoffPath = path.join(fixture.directory, 'review-input.json');
  await writeFile(handoffPath, JSON.stringify(handoff));
  assert.equal(
    JSON.parse(
      (
        await run('scripts/validate-review-input-bundle.mjs', [
          handoffPath,
          '--handoff-root',
          fixture.directory,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );

  await writeFile(
    path.join(fixture.directory, fixture.value.runs[0].artifacts[0].path),
    'damaged',
  );
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [
      handoffPath,
      '--handoff-root',
      fixture.directory,
    ]),
    /Command failed/u,
  );
});
function finding(id, severity, evidenceTypes) {
  const strong = ['P0', 'P1'].includes(severity);
  return {
    id,
    severity,
    evidenceTypes,
    evidence: ['fixture'],
    location: 'SKILL.md:1',
    claim: 'fixture claim',
    premises: strong
      ? [{ claim: 'p', source: 'fixture', evidence: 'fixture', status: 'supported' }]
      : [],
    reachability: {
      kind: 'entry-gate',
      status: strong ? 'supported' : 'unknown',
      path: 'fixture',
      evidence: 'fixture',
    },
    impact: 'impact',
    counterevidence: strong ? ['checked'] : [],
    owner: 'Skill',
    action: 'action',
    validation: 'validation',
    dimension: 'scope_composition',
  };
}
async function reviewValue(item, design, release) {
  const v = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  v.composition = 'overloaded';
  v.compositionFindingIds = [item.id];
  v.findings = [item];
  v.design = design;
  v.releaseReadiness = release;
  return v;
}
async function validate(v) {
  const t = await mkdtemp(path.join(tmpdir(), 'review-result-'));
  temps.push(t);
  const p = path.join(t, 'result.json');
  await writeFile(p, JSON.stringify(v));
  return run('scripts/validate-review-result.mjs', [p, '--format', 'json']);
}
test('P2-only overload is needs-fixes while P1 overload is redesign', async () => {
  assert.equal(
    JSON.parse(
      (
        await validate(
          await reviewValue(
            finding('p2', 'P2', ['official-guidance']),
            'needs-fixes',
            'not-assessed',
          ),
        )
      ).stdout,
    ).valid,
    true,
  );
  assert.equal(
    JSON.parse(
      (
        await validate(
          await reviewValue(finding('p1', 'P1', ['structural']), 'redesign', 'blocked'),
        )
      ).stdout,
    ).valid,
    true,
  );
});
test('official guidance alone cannot support P1', async () => {
  await assert.rejects(
    validate(await reviewValue(finding('bad', 'P1', ['official-guidance']), 'redesign', 'blocked')),
    /Command failed/u,
  );
});
test('unlinked heuristic composition cannot force redesign', async () => {
  const value = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  value.composition = 'overloaded';
  value.design = 'redesign';
  await assert.rejects(validate(value), /Command failed/u);
});
test('full result uses every canonical dimension and preserves eval evidence level', async () => {
  const [value, rules] = await Promise.all([
    readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ).then(JSON.parse),
    readFile(path.join(root, 'standards/review-result-rules.generated.json'), 'utf8').then(
      JSON.parse,
    ),
  ]);
  value.mode = 'full';
  value.design = 'pass';
  value.releaseReadiness = 'provisional';
  value.complexity = 'proportionate';
  value.composition = 'coherent';
  value.reducibility = 'minor';
  value.evalEvidenceLevel = 'structural';
  value.compositionFindingIds = [];
  value.complexityFindingIds = [];
  value.dimensions = rules.dimensions.map((d) => ({
    id: d.id,
    weight: d.weight,
    score: 5,
    confidence: 'high',
    findingIds: [],
    unknownIds: [],
  }));
  value.weightedScore = 100;
  value.coverage = 100;
  value.confidence = 'high';
  assert.equal(JSON.parse((await validate(value)).stdout).valid, true);
});
test('inspector still detects invalid frontmatter, missing resources and large references', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'skill-inspector-'));
  temps.push(t);
  const skill = path.join(t, 'fixture-skill');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: wrong-name\ndescription: fixture\n---\n# Fixture\nRead `references/missing.md`.\n',
  );
  await writeFile(path.join(skill, 'references', 'large.md'), '# Large\n' + 'text\n'.repeat(350));
  const result = JSON.parse(
    (
      await run('scripts/inspect-agent-skill.mjs', [skill, '--format', 'json']).catch((e) => ({
        stdout: e.stdout,
      }))
    ).stdout,
  );
  assert.ok(result.issues.some((i) => i.code === 'name-directory-mismatch'));
  assert.ok(result.issues.some((i) => i.code === 'missing-resource'));
  assert.equal(result.references[0].requiresSemanticAudit, true);
});
