import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const localRoot = path.dirname(fileURLToPath(import.meta.url));
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? path.resolve(localRoot, '..');
const repoRoot = path.resolve(sourceRoot, '..', '..');
const checker = context
  ? path.join(
      context.plugin.rootDir,
      context.platform,
      'skills',
      'review-aw',
      'scripts',
      'check-aw-release.mjs',
    )
  : path.join(localRoot, 'check-aw-release.mjs');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const evalEntry = path.join(repoRoot, 'packages', 'agent-skill-eval', 'dist', 'bin.js');
const roots = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), label)));
  roots.push(root);
  return root;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeForwarder(binRoot, name, entry) {
  await mkdir(binRoot, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(
      path.join(binRoot, `${name}.cmd`),
      `@"${process.execPath}" "${entry}" %*\r\n`,
    );
  } else {
    const executable = path.join(binRoot, name);
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`,
    );
    await chmod(executable, 0o755);
  }
}

async function command(file, args, env) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8',
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error),
    };
  }
}

function jsonOutput(result) {
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return JSON.parse(result.stdout);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function digestFile(filePath) {
  return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

function processEvidence(mode = 'managed') {
  if (mode === 'unmanaged-confirmed') {
    return {
      mode,
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      limitation: 'Only the direct provider child can be terminated.',
    };
  }
  return {
    mode: 'managed',
    inspectionAvailable: true,
    userAcknowledged: false,
    descendantCleanupGuaranteed: false,
    limitation: 'Process-tree inspection is not OS-enforced containment.',
  };
}

function resultSummary(runs) {
  const summary = { passed: 0, failed: 0, timeout: 0, error: 0 };
  for (const run of runs) {
    if (run.status === 'timeout') summary.timeout += 1;
    else if (run.status === 'failed') summary.error += 1;
    else if (run.grade?.passed) summary.passed += 1;
    else summary.failed += 1;
  }
  return summary;
}

async function createWorkspace({ requiredEval = false, requiredRuns = 1 } = {}) {
  const root = await tempRoot('aw-release-workspace-');
  const binRoot = path.join(root, 'public-bin');
  await Promise.all([
    writeForwarder(binRoot, 'aw', cliEntry),
    writeForwarder(binRoot, 'aw-skill-eval', evalEntry),
  ]);
  const isolatedHome = path.join(root, 'isolated-home');
  const env = {
    ...process.env,
    PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
  };
  await mkdir(isolatedHome, { recursive: true });
  const initialized = await command('aw', [
    'catalog', 'init', '--workspace-root', root, '--json',
  ], env);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const pluginRoot = path.join(root, 'plugins', 'release-fixture');
  const skillRoot = path.join(pluginRoot, 'skills', 'release-skill');
  const sentinel = path.join(root, 'checker-ran-plugin-script');
  await writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    schemaVersion: 3,
    name: 'release-fixture',
    version: '0.1.0',
    description: 'Release checker public consumer fixture.',
    skills: './skills',
    scripts: { tests: { node: ['./scripts/sentinel.mjs'] } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
  });
  await writeFile(path.join(pluginRoot, 'README.md'), '# Release Fixture\n\nTest fixture.\n');
  await mkdir(path.join(pluginRoot, 'scripts'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'scripts', 'sentinel.mjs'),
    `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(sentinel)}, 'ran\\n');\n`,
  );
  await mkdir(path.join(skillRoot, 'agents'), { recursive: true });
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: release-skill\ndescription: Execute one deterministic release checker fixture task.\n---\n\nReturn the supplied fixture value.\n',
  );
  await writeFile(path.join(skillRoot, 'README.md'), '# Release Skill\n\nTest fixture.\n');
  await writeFile(
    path.join(skillRoot, 'agents', 'openai.yaml'),
    'interface:\n  display_name: "Release Skill"\n  short_description: "Run the release checker fixture"\n  default_prompt: "Use $release-skill for the fixture."\n\npolicy:\n  allow_implicit_invocation: true\n',
  );
  if (requiredEval) {
    const evalRoot = path.join(skillRoot, 'evals');
    await writeJson(path.join(evalRoot, 'manifest.json'), {
      version: 1,
      defaults: { profile: 'project-default', runs: requiredRuns, timeoutMs: 3000 },
      profiles: {
        'project-default': { scope: 'project', plugins: { 'release-fixture': {} } },
      },
      suites: [{
        id: 'release-suite',
        kind: 'custom-process',
        cases: 'cases.json',
        profiles: ['project-default'],
        requiredForRelease: true,
        releaseSplits: ['validation'],
        releaseProcessManagement: 'managed-only',
        provider: { type: 'custom-process', command: ['node', 'provider.mjs'] },
      }],
    });
    await writeJson(path.join(evalRoot, 'cases.json'), {
      version: 1,
      suite: {
        kind: 'custom-process',
        unitUnderTest: 'release-skill',
        runtime: { minimumPassRate: 1 },
      },
      cases: [{
        id: 'release-case',
        split: 'validation',
        tags: [],
        input: { prompt: 'Return the release fixture value.' },
        expected: { value: 'release-fixture' },
        assertions: ['The fixture value is returned.'],
      }],
    });
    await writeFile(
      path.join(evalRoot, 'provider.mjs'),
      'process.stdout.write(JSON.stringify({ usage: null, grade: { passed: true, score: 1 } }));\n',
    );
  }
  return { root, pluginRoot, skillRoot, sentinel, env };
}

async function buildCatalog(fixture) {
  const built = await command('aw', [
    'catalog', 'build', '--workspace-root', fixture.root, '--json',
  ], fixture.env);
  assert.equal(built.code, 0, built.stderr || built.stdout);
}

async function inspect(fixture, target = fixture.pluginRoot, materializations = []) {
  const args = ['review', 'inspect', target];
  for (const receipt of materializations) args.push('--materialization', receipt);
  args.push('--json');
  const inspected = await command('aw', args, fixture.env);
  const value = jsonOutput(inspected);
  assert.equal(value.schemaVersion, 1);
  return value;
}

function reviewSubjects(inspection) {
  const byKey = new Map(inspection.subjects.map((subject) => [subject.key, subject]));
  const subjects = [];
  const addContainer = (key, kind) => {
    const subject = byKey.get(key);
    subjects.push({
      kind,
      path: relative(inspection.workspace.root, subject.path),
      profile: 'none',
      digest: subject.digest,
    });
  };
  if (inspection.target.kind === 'catalog') {
    addContainer('catalog:source', 'catalog');
    for (const plugin of inspection.plugins) addContainer(plugin.sourceContainerKey, 'plugin');
  } else {
    addContainer(inspection.plugins[0].sourceContainerKey, 'plugin');
  }
  for (const final of inspection.requiredFinals) {
    if (final.status !== 'resolved') continue;
    const source = byKey.get(final.sourceSubjectKey);
    for (const finalKey of final.matchedFinalKeys) {
      const current = byKey.get(finalKey);
      const profile = current.materializationProfile
        ? [
            current.materializationProfile.kind,
            current.materializationProfile.id,
            current.materializationProfile.scope,
            current.materializationProfile.inputDigest,
          ].join(':')
        : current.profile;
      subjects.push({
        kind: 'skill',
        path: relative(inspection.workspace.root, source.path),
        profile,
        digest: current.digest,
      });
    }
  }
  return [...new Map(subjects.map((subject) => [
    [subject.kind, subject.path, subject.profile, subject.digest].join('\0'), subject,
  ])).values()];
}

async function writeEvidence(inspection, transform = (subjects) => subjects) {
  const evidenceRoot = await tempRoot('aw-release-evidence-');
  const reportPath = path.join(evidenceRoot, 'report.md');
  const evidencePath = path.join(evidenceRoot, 'evidence.json');
  await writeFile(reportPath, '# Review evidence\n\nThe reviewer assessed each listed subject.\n');
  const reportDigest = await digestFile(reportPath);
  let subjects = reviewSubjects(inspection).map((subject) => ({
    ...subject,
    assessment: 'pass',
    evidenceRefs: [{ path: 'report.md', digest: reportDigest }],
    blockingFindings: [],
  }));
  subjects = transform(subjects);
  const targetKey = inspection.target.kind === 'catalog'
    ? 'catalog:source'
    : inspection.plugins[0].sourceContainerKey;
  const targetSubject = inspection.subjects.find((subject) => subject.key === targetKey);
  await writeJson(evidencePath, {
    version: 1,
    target: {
      kind: inspection.target.kind,
      path: relative(inspection.workspace.root, inspection.target.path),
      digest: targetSubject.digest,
    },
    subjects,
  });
  return { evidencePath, reportPath };
}

async function runChecker(fixture, options) {
  const args = [checker, '--target', options.target ?? fixture.pluginRoot, '--evidence', options.evidencePath];
  for (const receipt of options.materializations ?? []) args.push('--materialization', receipt);
  for (const chain of options.evalChains ?? []) args.push('--eval-chain', chain);
  if (options.output) args.push('--output', options.output);
  if (options.overwrite) args.push('--overwrite');
  if (options.format) args.push('--format', options.format);
  return command(process.execPath, args, fixture.env);
}

async function prepareEval(fixture) {
  const output = path.join(fixture.root, '.aw', 'evals', 'prepared');
  const prepared = await command('aw', [
    'skill', 'eval', 'prepare', 'release-fixture', 'release-skill',
    '--suite', 'release-suite', '--profile', 'project-default',
    '--workspace-root', fixture.root, '--output', output, '--json',
  ], fixture.env);
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  return jsonOutput(prepared);
}

async function createEvalChain(fixture, specPath, options = {}) {
  const chainRoot = await tempRoot('aw-release-chain-');
  const specValidation = await command('aw-skill-eval', ['spec', 'validate', specPath], fixture.env);
  assert.equal(specValidation.code, 0, specValidation.stderr || specValidation.stdout);
  const calculated = jsonOutput(specValidation).calculated;
  const spec = calculated.spec;
  const cases = JSON.parse(await readFile(calculated.paths.cases, 'utf8'));
  const auditPath = path.join(chainRoot, 'audit.json');
  const targets = [{ role: 'current', digest: spec.target.digest }];
  if (spec.baseline.type === 'previous-version') {
    targets.push({ role: 'previous-version', digest: spec.baseline.target.digest });
  }
  const audit = {
    version: 1,
    workspaceDigest: spec.workspace.digest,
    providerDigest: calculated.providerDigest,
    targets,
    caseDigest: spec.cases.digest,
    status: 'pass',
    approvedCaseIds: cases.cases.map((entry) => entry.id),
    blockedCases: [],
    issues: [],
  };
  if (options.auditMutator) options.auditMutator(audit);
  await writeJson(auditPath, audit);
  const auditValidation = await command(
    'aw-skill-eval', ['audit', 'validate', auditPath, '--spec', specPath], fixture.env,
  );
  if (!options.invalidAudit) assert.equal(auditValidation.code, 0, auditValidation.stderr || auditValidation.stdout);
  const auditDigest = options.invalidAudit
    ? await digestFile(auditPath)
    : jsonOutput(auditValidation).calculated.auditDigest;
  const resultPath = path.join(chainRoot, 'result.json');
  const runs = cases.cases.flatMap((entry) => Array.from({ length: spec.runs }, (_, index) => ({
    caseId: entry.id,
    variant: 'current',
    attempt: index + 1,
    status: 'completed',
    durationMs: 1,
    outputDir: `output/${entry.id}/current/${index + 1}`,
    usage: null,
    grade: { passed: true, score: 1 },
    error: null,
  })));
  const result = {
    version: 2,
    specDigest: calculated.specDigest,
    auditDigest,
    targetDigest: calculated.targetDigest,
    caseDigest: calculated.caseDigest,
    provider: spec.provider,
    processManagement: processEvidence(options.processMode),
    startedAt: '2026-09-08T00:00:00Z',
    finishedAt: options.finishedAt ?? '2026-09-08T00:00:01Z',
    runs,
    summary: resultSummary(runs),
  };
  if (options.resultMutator) options.resultMutator(result);
  result.summary = resultSummary(result.runs);
  await writeJson(resultPath, result);
  if (!options.invalidAudit && !options.invalidResult) {
    const resultValidation = await command('aw-skill-eval', [
      'result', 'validate', resultPath, '--spec', specPath, '--audit', auditPath,
    ], fixture.env);
    assert.equal(resultValidation.code, 0, resultValidation.stderr || resultValidation.stdout);
  }
  const chainPath = path.join(chainRoot, 'chain.json');
  await writeJson(chainPath, { spec: specPath, audit: auditPath, result: resultPath });
  return { chainPath, auditPath, resultPath };
}

test('uses current inspection subjects for Plugin and Catalog release states', async () => {
  const fixture = await createWorkspace();
  await buildCatalog(fixture);
  const pluginInspection = await inspect(fixture);
  const readyEvidence = await writeEvidence(pluginInspection);

  const readyRun = await runChecker(fixture, readyEvidence);
  assert.equal(readyRun.code, 0, readyRun.stderr);
  const ready = jsonOutput(readyRun);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, true);
  assert.equal(ready.checkedSubjects.length, 3);
  assert.equal(ready.checkedEvalSelections.length, 0);
  assert.equal(ready.failures.length, 0);
  assert.equal(ready.missing.length, 0);
  assert.equal(await readFile(fixture.sentinel, 'utf8').catch(() => null), null);

  const blockedEvidence = await writeEvidence(pluginInspection, (subjects) =>
    subjects.map((subject) => subject.kind === 'skill' && subject.profile === 'codex-project'
      ? {
          ...subject,
          assessment: 'needs-fixes',
          blockingFindings: [{ id: 'F-1', severity: 'major', owner: 'release-fixture' }],
        }
      : subject));
  const blockedRun = await runChecker(fixture, blockedEvidence);
  assert.equal(blockedRun.code, 1, blockedRun.stderr);
  assert.equal(jsonOutput(blockedRun).status, 'blocked');

  const incompleteEvidence = await writeEvidence(pluginInspection, (subjects) =>
    subjects.filter((subject) => subject.profile !== 'codex-project'));
  const incompleteRun = await runChecker(fixture, incompleteEvidence);
  assert.equal(incompleteRun.code, 3, incompleteRun.stderr);
  assert.equal(jsonOutput(incompleteRun).status, 'incomplete');

  const duplicateEvidence = await writeEvidence(pluginInspection, (subjects) => [...subjects, { ...subjects[0] }]);
  const duplicateRun = await runChecker(fixture, duplicateEvidence);
  assert.equal(duplicateRun.code, 2, duplicateRun.stderr);
  assert.equal(jsonOutput(duplicateRun).status, 'invalid');

  const extraEvidence = await writeEvidence(pluginInspection, (subjects) => [...subjects, {
    ...subjects[0],
    kind: 'workflow',
    path: 'workflows/extra',
  }]);
  const extraRun = await runChecker(fixture, extraEvidence);
  assert.equal(extraRun.code, 0, extraRun.stderr);
  assert.equal(jsonOutput(extraRun).warnings.some((entry) => entry.code === 'unusedSubject'), true);

  const changedReportEvidence = await writeEvidence(pluginInspection);
  await writeFile(changedReportEvidence.reportPath, '\nChanged after assessment.\n', { flag: 'a' });
  const changedReportRun = await runChecker(fixture, changedReportEvidence);
  assert.equal(changedReportRun.code, 2, changedReportRun.stderr);
  assert.equal(jsonOutput(changedReportRun).status, 'invalid');

  const output = path.join(await tempRoot('aw-release-output-'), 'release-check.json');
  await writeFile(output, 'keep\n');
  const protectedRun = await runChecker(fixture, { ...readyEvidence, output });
  assert.equal(protectedRun.code, 2, protectedRun.stderr);
  assert.equal(jsonOutput(protectedRun).status, 'invalid');
  assert.equal(await readFile(output, 'utf8'), 'keep\n');
  const overwriteRun = await runChecker(fixture, { ...readyEvidence, output, overwrite: true });
  assert.equal(overwriteRun.code, 0, overwriteRun.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), jsonOutput(overwriteRun));

  for (const protectedInput of [
    readyEvidence.evidencePath,
    readyEvidence.reportPath,
    path.join(fixture.pluginRoot, 'README.md'),
  ]) {
    const before = await readFile(protectedInput);
    const aliasRun = await runChecker(fixture, {
      ...readyEvidence,
      output: protectedInput,
      overwrite: true,
    });
    assert.equal(aliasRun.code, 2, aliasRun.stderr);
    assert.equal(jsonOutput(aliasRun).status, 'invalid');
    assert.deepEqual(await readFile(protectedInput), before);
  }

  const catalogInspection = await inspect(fixture, fixture.root);
  const catalogEvidence = await writeEvidence(catalogInspection);
  const catalogRun = await runChecker(fixture, {
    target: fixture.root,
    evidencePath: catalogEvidence.evidencePath,
  });
  assert.equal(catalogRun.code, 0, catalogRun.stderr);
  assert.equal(jsonOutput(catalogRun).target.kind, 'catalog');

  await rm(path.join(fixture.root, '.aw', 'catalog'), { recursive: true, force: true });
  const sourceInspection = await inspect(fixture);
  assert.equal(sourceInspection.ok, true);
  assert.equal(sourceInspection.completeness, 'incomplete');
  assert.equal(sourceInspection.issues.some((entry) => entry.blocking), false);
  const sourceEvidence = await writeEvidence(sourceInspection);
  const sourceRun = await runChecker(fixture, sourceEvidence);
  assert.equal(sourceRun.code, 3, sourceRun.stderr);
  assert.equal(jsonOutput(sourceRun).status, 'incomplete');
  assert.equal(jsonOutput(sourceRun).ready, false);
  assert.equal(jsonOutput(sourceRun).missing.some((entry) => entry.code === 'requiredFinalMissing'), true);

  if (process.platform !== 'win32') {
    const linkedEvidence = path.join(await tempRoot('aw-release-symlink-'), 'evidence-link.json');
    await symlink(sourceEvidence.evidencePath, linkedEvidence);
    const linkedRun = await runChecker(fixture, { evidencePath: linkedEvidence });
    assert.equal(linkedRun.code, 2, linkedRun.stderr);
    assert.equal(jsonOutput(linkedRun).status, 'invalid');
  }
});

test('binds required Eval chains through official validators and current materialization facts', async () => {
  const fixture = await createWorkspace({ requiredEval: true, requiredRuns: 3 });
  await buildCatalog(fixture);
  const prepared = await prepareEval(fixture);
  const materializations = [prepared.sourceBindingPath];
  const currentInspection = await inspect(fixture, fixture.pluginRoot, materializations);
  const evidence = await writeEvidence(currentInspection);
  const currentChain = await createEvalChain(fixture, prepared.specPath);

  const readyRun = await runChecker(fixture, {
    ...evidence,
    materializations,
    evalChains: [currentChain.chainPath],
  });
  assert.equal(readyRun.code, 0, readyRun.stderr || readyRun.stdout);
  const ready = jsonOutput(readyRun);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.checkedEvalSelections.length, 1);
  assert.equal(ready.checkedEvalSelections[0].status, 'pass');

  const extendedSpec = JSON.parse(await readFile(prepared.specPath, 'utf8'));
  const extendedSpecPath = path.join(path.dirname(prepared.specPath), 'spec-six-runs.json');
  await writeJson(extendedSpecPath, { ...extendedSpec, runs: 6 });
  const extendedFailedChain = await createEvalChain(fixture, extendedSpecPath, {
    resultMutator(result) {
      for (const run of result.runs.filter((entry) => entry.attempt > 3)) {
        run.grade = { passed: false, score: 0 };
      }
    },
  });
  const extendedFailedRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [extendedFailedChain.chainPath],
  });
  assert.equal(extendedFailedRun.code, 1, extendedFailedRun.stderr);
  assert.equal(
    jsonOutput(extendedFailedRun).failures.some((entry) => entry.code === 'evalPassRateBelowRequirement'),
    true,
  );

  const duplicateReceiptRun = await runChecker(fixture, {
    ...evidence,
    materializations: [prepared.sourceBindingPath, prepared.sourceBindingPath],
    evalChains: [currentChain.chainPath],
  });
  assert.equal(duplicateReceiptRun.code, 0, duplicateReceiptRun.stderr);
  assert.equal(jsonOutput(duplicateReceiptRun).status, 'ready');

  const resultBytes = await readFile(currentChain.resultPath);
  const chainOutputRun = await runChecker(fixture, {
    ...evidence,
    materializations,
    evalChains: [currentChain.chainPath],
    output: currentChain.resultPath,
    overwrite: true,
  });
  assert.equal(chainOutputRun.code, 2, chainOutputRun.stderr);
  assert.equal(jsonOutput(chainOutputRun).status, 'invalid');
  assert.deepEqual(await readFile(currentChain.resultPath), resultBytes);

  const missingRun = await runChecker(fixture, { ...evidence, materializations });
  assert.equal(missingRun.code, 3, missingRun.stderr);
  assert.equal(jsonOutput(missingRun).missing.some((entry) => entry.code === 'requiredEvalMissing'), true);

  const failedChain = await createEvalChain(fixture, prepared.specPath, {
    resultMutator(result) {
      result.runs[0].grade = { passed: false, score: 0 };
    },
  });
  const failedRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [failedChain.chainPath],
  });
  assert.equal(failedRun.code, 1, failedRun.stderr);
  assert.equal(jsonOutput(failedRun).failures.some((entry) => entry.code === 'evalPassRateBelowRequirement'), true);

  const incompleteChain = await createEvalChain(fixture, prepared.specPath, {
    resultMutator(result) { result.runs = []; },
  });
  const incompleteRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [incompleteChain.chainPath],
  });
  assert.equal(incompleteRun.code, 3, incompleteRun.stderr);
  assert.equal(jsonOutput(incompleteRun).missing.some((entry) => entry.code === 'evalRunsMissing'), true);

  const unmanagedChain = await createEvalChain(fixture, prepared.specPath, {
    processMode: 'unmanaged-confirmed',
  });
  const unmanagedRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [unmanagedChain.chainPath],
  });
  assert.equal(unmanagedRun.code, 1, unmanagedRun.stderr);
  assert.equal(jsonOutput(unmanagedRun).failures.some((entry) => entry.code === 'evalProcessManagementRejected'), true);

  const missingProcessChain = await createEvalChain(fixture, prepared.specPath, {
    invalidResult: true,
    resultMutator(result) { delete result.processManagement; },
  });
  const missingProcessRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [missingProcessChain.chainPath],
  });
  assert.equal(missingProcessRun.code, 2, missingProcessRun.stderr);
  assert.equal(jsonOutput(missingProcessRun).failures.some((entry) => entry.code === 'evalResultInvalid'), true);

  const invalidAuditChain = await createEvalChain(fixture, prepared.specPath, {
    invalidAudit: true,
    auditMutator(audit) { audit.workspaceDigest = `sha256:${'0'.repeat(64)}`; },
  });
  const invalidAuditRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [invalidAuditChain.chainPath],
  });
  assert.equal(invalidAuditRun.code, 2, invalidAuditRun.stderr);
  assert.equal(jsonOutput(invalidAuditRun).failures.some((entry) => entry.code === 'evalAuditInvalid'), true);

  const secondChain = await createEvalChain(fixture, prepared.specPath, {
    finishedAt: '2026-09-08T00:00:02Z',
  });
  const conflictRun = await runChecker(fixture, {
    ...evidence,
    materializations,
    evalChains: [currentChain.chainPath, secondChain.chainPath],
  });
  assert.equal(conflictRun.code, 2, conflictRun.stderr);
  assert.equal(jsonOutput(conflictRun).failures.some((entry) => entry.code === 'conflictingEvalResults'), true);

  const spec = JSON.parse(await readFile(prepared.specPath, 'utf8'));
  const providerSpecPath = path.join(path.dirname(prepared.specPath), 'spec-provider.json');
  await writeJson(providerSpecPath, {
    ...spec,
    provider: { type: 'custom-process', command: ['provider', '--json'] },
  });
  const providerChain = await createEvalChain(fixture, providerSpecPath);
  const providerRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [providerChain.chainPath],
  });
  assert.equal(providerRun.code, 1, providerRun.stderr);
  assert.equal(jsonOutput(providerRun).failures.some((entry) => entry.code === 'evalCurrentBindingMismatch'), true);

  const baselineSpecPath = path.join(path.dirname(prepared.specPath), 'spec-baseline.json');
  await writeJson(baselineSpecPath, { ...spec, baseline: { type: 'without-skill' } });
  const baselineChain = await createEvalChain(fixture, baselineSpecPath);
  const baselineRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [baselineChain.chainPath],
  });
  assert.equal(baselineRun.code, 3, baselineRun.stderr);
  assert.equal(jsonOutput(baselineRun).missing.some((entry) => entry.code === 'baselinePolicyMissing'), true);

  const skillBytes = await readFile(path.join(fixture.skillRoot, 'SKILL.md'));
  await writeFile(path.join(fixture.skillRoot, 'SKILL.md'), `${skillBytes.toString()}\nChanged source.\n`);
  const staleRun = await runChecker(fixture, {
    ...evidence, materializations, evalChains: [currentChain.chainPath],
  });
  assert.equal(staleRun.code, 1, staleRun.stderr);
  assert.equal(jsonOutput(staleRun).status, 'blocked');
  await writeFile(path.join(fixture.skillRoot, 'SKILL.md'), skillBytes);
});
