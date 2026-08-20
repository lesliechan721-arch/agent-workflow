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
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
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
    schemaVersion: 3,
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
