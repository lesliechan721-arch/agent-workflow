import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runPluginEvals } from '../../scripts/eval-plugin-skills.js';
import { computeAuthorSourceDigest } from '../../scripts/skill-reporting.js';
import {
  assertPublishSkillTarget,
  assertScorecardSkillName,
  assertStructuredReviewTarget,
  buildStructuredReviewPublication,
  resolveReviewDraftPath,
  resolveReviewSourceRoots,
} from '../../scripts/publish-skill-review.js';
import {
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function skillScript(name: string): string {
  return path.join(repoRoot(), '.agents', 'skills', 'skill-review', 'scripts', name);
}

function staticEvalRunner(): string {
  return skillScript('run_static_skill_evals.mjs');
}

function testEvalLayout(outputRoot: string) {
  return async (options: {
    plugin: string;
    skill: string;
    batchName?: string;
    batchId?: string;
    runId?: string;
    source: { digest: string; gitHead: string | null; inScopeDirty: boolean };
    environmentDigest: string;
    modelEnvironmentDigest?: string | null;
    harnessDigest: string;
    requiredTargets: string[];
    targetCompositions?: Record<string, string[]>;
  }) => {
    const runId = options.runId ?? '20260811T000000Z-00000001';
    const batchId = options.batchId ?? '20260811T000000Z-test-batch-00000000';
    const batchRoot = path.join(outputRoot, options.plugin, options.skill, batchId);
    const reportRoot = path.join(batchRoot, 'evals', 'runs', runId);
    const rawRoot = path.join(reportRoot, 'raw');
    const workRoot = path.join(outputRoot, '.tmp', runId);
    await Promise.all([fs.ensureDir(rawRoot), fs.ensureDir(workRoot)]);
    await fs.writeJson(path.join(batchRoot, 'batch.json'), {
      schemaVersion: 1,
      batchId,
      name: options.batchName ?? 'test-batch',
      owner: { kind: 'plugin-skill', plugin: options.plugin, skill: options.skill },
      status: 'open',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      source: options.source,
      environmentDigest: options.environmentDigest,
      modelEnvironmentDigest: options.modelEnvironmentDigest ?? null,
      harnessDigest: options.harnessDigest,
      requiredTargets: options.requiredTargets,
      targetCompositions: options.targetCompositions ?? {},
    }, { spaces: 2 });
    return {
      batchId,
      batchRoot,
      reportBoundaryRoot: outputRoot,
      runId,
      reportRoot,
      rawRoot,
      workRoot,
      startedAt: '2026-08-11T00:00:00.000Z',
      pid: process.pid,
      host: os.hostname(),
      cleanupWork: () => fs.remove(workRoot),
    };
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill-review author tools', () => {
  it('uses the publication source digest contract for AW review bundles', async () => {
    const root = repoRoot();
    const roots = await resolveReviewSourceRoots(root, {
      kind: 'plugin-skill',
      plugin: 'aw-plugin-development',
      skill: 'review-aw-plugin',
    });
    const expectedDigest = await computeAuthorSourceDigest(roots);
    const script = path.join(
      root,
      '.agents',
      'legacy',
      'plugin-development-review',
      'scripts',
      'prepare-aw-review-bundle.mjs',
    );
    const { stdout } = await execFileAsync(process.execPath, [
      script,
      path.join(root, 'plugins', 'aw-plugin-development'),
      '--source',
      `agent-content-toolkit=${path.join(root, 'plugins', 'agent-content-toolkit')}`,
      '--source',
      `agent-skill-toolkit=${path.join(root, 'plugins', 'agent-skill-toolkit')}`,
      '--source',
      `aw-skill-eval-runner=${path.join(root, 'plugins', 'aw-skill-eval-runner')}`,
    ], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(stdout).target.sourceDigest).toBe(expectedDigest);
  });

  it('changes publication source identity for executable mode changes', async () => {
    if (process.platform === 'win32') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-source-mode-'));
    tempDirs.push(root);
    const script = path.join(root, 'scripts', 'run.sh');
    await fs.ensureDir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const regularDigest = await computeAuthorSourceDigest([{ name: 'demo', root }]);

    await fs.chmod(script, 0o755);
    const executableDigest = await computeAuthorSourceDigest([{ name: 'demo', root }]);
    expect(executableDigest).not.toBe(regularDigest);
  });

  it('requires review publication targets to be real documented Skills', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-publish-target-'));
    tempDirs.push(root);
    const skillRoot = path.join(root, 'plugins', 'demo', 'skills', 'real-skill');
    await fs.ensureDir(skillRoot);
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# Skill\n', 'utf8');
    await fs.writeFile(path.join(skillRoot, 'README.md'), '# Readme\n', 'utf8');

    await expect(assertPublishSkillTarget(root, {
      kind: 'plugin-skill',
      plugin: 'demo',
      skill: 'real-skill',
    })).resolves.toBeUndefined();
    await expect(assertPublishSkillTarget(root, {
      kind: 'plugin-skill',
      plugin: 'demo',
      skill: 'missing-skill',
    })).rejects.toThrow('missing SKILL.md');
    expect(() => assertScorecardSkillName('other-skill', 'real-skill')).toThrow(
      'does not match --skill',
    );
    const reviewResult = {
      schemaVersion: 4 as const,
      mode: 'quick' as const,
      target: {
        kind: 'aw-plugin-skill',
        name: 'real-skill',
        digest: `sha256:${'1'.repeat(64)}`,
      },
      design: 'not-assessed',
      releaseReadiness: 'not-assessed',
      complexity: 'not-assessed',
      composition: 'not-assessed',
      weightedScore: null,
      coverage: 0,
      confidence: 'unknown',
      findings: [],
      unknowns: [],
      gates: {},
      actions: [],
    };
    const awSummary = {
      schemaVersion: 2 as const,
      target: {
        plugin: 'demo',
        skill: 'real-skill',
        sourceDigest: `sha256:${'2'.repeat(64)}`,
      },
      targetPlanDigest: `sha256:${'4'.repeat(64)}`,
      genericReviews: [{
        reviewEvidenceId: 'source-review',
        targetName: 'real-skill',
        kind: 'aw-plugin-skill',
        profile: null,
        digest: `sha256:${'1'.repeat(64)}`,
        design: 'not-assessed',
        releaseReadiness: 'not-assessed',
      }],
      projectGates: {},
      evalAudit: null,
      design: 'not-assessed',
      releaseReadiness: 'not-assessed',
      actions: [],
    };
    expect(() => assertStructuredReviewTarget(
      reviewResult,
      awSummary,
      'demo',
      'real-skill',
    )).not.toThrow();
    expect(() => assertStructuredReviewTarget(
      reviewResult,
      {
        ...awSummary,
        target: { ...awSummary.target, plugin: 'other' },
      },
      'demo',
      'real-skill',
    )).toThrow('does not match --plugin');
    const structuredPublication = buildStructuredReviewPublication(
      {
        ...reviewResult,
        mode: 'release-quality',
        design: 'pass',
        releaseReadiness: 'provisional',
        weightedScore: 88,
        coverage: 100,
        confidence: 'high',
      },
      {
        ...awSummary,
        design: 'pass',
        releaseReadiness: 'provisional',
        genericReviews: [{
          ...awSummary.genericReviews[0],
          design: 'pass',
          releaseReadiness: 'provisional',
        }],
      },
      'demo',
      'real-skill',
    );
    expect(structuredPublication).toMatchObject({
      calculated: {
        mode: 'release',
        weightedScore: 88,
        coverage: 100,
        confidence: 'high',
        release: 'provisional',
      },
      scorecard: {
        review: { skill_name: 'real-skill', mode: 'release' },
        decision: { design: 'pass', release_readiness: 'provisional' },
      },
    });
    const staticPublication = buildStructuredReviewPublication(
      {
        ...reviewResult,
        target: {
          kind: 'repo-skill',
          name: 'real-skill',
          digest: `sha256:${'3'.repeat(64)}`,
        },
      },
      undefined,
      undefined,
      'real-skill',
      `sha256:${'3'.repeat(64)}`,
    );
    expect(staticPublication.calculated.release).toBe('not-assessed');
    expect(staticPublication.scorecard).toMatchObject({
      schemaVersion: 'review-result-projection-v1',
    });
    expect(resolveReviewDraftPath(root, '.tmp/review.md')).toBe(
      path.join(root, '.tmp', 'review.md'),
    );
    expect(resolveReviewDraftPath(root, path.join(root, 'absolute-review.md'))).toBe(
      path.join(root, 'absolute-review.md'),
    );
  });

  it('uses every static suite participant when publishing review evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-static-participants-'));
    tempDirs.push(root);
    const ownerRoot = path.join(root, '.agents', 'skills', 'owner-skill');
    const companionRoot = path.join(root, '.agents', 'skills', 'companion-skill');
    await Promise.all([
      fs.outputFile(path.join(ownerRoot, 'SKILL.md'), '# Owner\n'),
      fs.outputFile(path.join(ownerRoot, 'README.md'), '# Owner\n'),
      fs.outputJson(path.join(ownerRoot, 'evals', 'manifest.json'), {
        schemaVersion: 1,
        skill: 'owner-skill',
        suites: [
          { id: 'one', skills: ['owner-skill'] },
          { id: 'two', skills: ['companion-skill', 'owner-skill'] },
        ],
      }),
      fs.outputFile(path.join(companionRoot, 'SKILL.md'), '# Companion\n'),
      fs.outputFile(path.join(companionRoot, 'README.md'), '# Companion\n'),
    ]);

    await expect(resolveReviewSourceRoots(root, {
      kind: 'static-skill',
      skill: 'owner-skill',
    })).resolves.toEqual([
      { name: 'owner-skill', root: ownerRoot },
      { name: 'companion-skill', root: companionRoot },
    ]);
  });

  it('parses a quoted YAML Skill name as its scalar value', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?quoted-name`);
    const inspector = await import(
      `${pathToFileURL(skillScript('inspect_skill_target.mjs')).href}?author-only-paths`,
    );
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'quoted-skill');

    expect(runner.parseSkillName([
      '---',
      'name: "quoted-skill"',
      'description: Quoted YAML scalar fixture.',
      '---',
      '',
      '# Quoted Skill',
    ].join('\n'), skillRoot)).toBe('quoted-skill');
    expect(runner.applyRunCountCoverage({
      outcome: 'passed',
      complete: true,
      diagnostics: [],
    }, { defaultRuns: 3 }, 1)).toMatchObject({
      outcome: 'incomplete',
      complete: false,
      diagnostics: [expect.stringContaining('below the declared default 3')],
    });
    expect(runner.staticEvalHarnessRoots('/repo')).toEqual([
      { name: 'packages/cli/dist/scripts', root: '/repo/packages/cli/dist/scripts' },
      { name: 'packages/cli/dist/src', root: '/repo/packages/cli/dist/src' },
      {
        name: '.agents/skills/skill-review/scripts',
        root: '/repo/.agents/skills/skill-review/scripts',
      },
    ]);
    for (const [relativePath, authorOnly] of [
      ['evals/cases.json', true],
      ['reports/review.md', true],
      ['assets/reports/template.md', false],
      ['references/evals/contract.md', false],
    ] as const) {
      expect(runner.isSkillAuthorOnlyPath(relativePath)).toBe(authorOnly);
      expect(inspector.isSkillAuthorOnlyPath(relativePath)).toBe(authorOnly);
    }
  });

  it('materializes static participant Skills without author-only directories', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?participants`);
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-participants-'));
    tempDirs.push(outputRoot);

    const subjectRoot = await runner.prepareSubject({
      participantSkills: ['skill-review', 'create-aw-plugin'],
      workspace: [],
    }, outputRoot);

    for (const skillName of ['skill-review', 'create-aw-plugin']) {
      await expect(fs.pathExists(path.join(
        subjectRoot,
        '.agents',
        'skills',
        skillName,
        'SKILL.md',
      ))).resolves.toBe(true);
      await expect(fs.pathExists(path.join(
        subjectRoot,
        '.agents',
        'skills',
        skillName,
        'evals',
      ))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(
        subjectRoot,
        '.agents',
        'skills',
        skillName,
        'reports',
      ))).resolves.toBe(false);
    }

    const materializedReviewRoot = path.join(
      subjectRoot,
      '.agents',
      'skills',
      'skill-review',
    );
    for (const scriptName of [
      'inspect_skill_target.mjs',
      'run_static_skill_evals.mjs',
      'validate_eval_cases.mjs',
      'validate_scorecard.mjs',
    ]) {
      const result = await execFileAsync('node', [
        path.join(materializedReviewRoot, 'scripts', scriptName),
        '--help',
      ], { cwd: subjectRoot, env: process.env });
      expect(result.stdout, scriptName).toContain('Usage:');
    }
  });

  it('materializes the shared Eval Audit validator required by create-aw-plugin cases', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?create-plugin-audit`);
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'create-aw-plugin');
    const manifest = await runner.readManifest(skillRoot, 'create-aw-plugin');
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-create-plugin-audit-'));
    tempDirs.push(outputRoot);

    expect(manifest.participantSkills).toEqual(['create-aw-plugin']);
    const subjectRoot = await runner.prepareSubject(manifest, outputRoot);
    const validator = path.join(
      subjectRoot,
      '.agents',
      'skills',
      'skill-review',
      'scripts',
      'validate_eval_cases.mjs',
    );
    await expect(fs.pathExists(validator)).resolves.toBe(true);
    const result = await execFileAsync('node', [validator, '--help'], {
      cwd: subjectRoot,
      env: process.env,
    });
    expect(result.stdout).toContain('Usage: validate_eval_cases.mjs');
  });

  it('validates admitted release case files and audit diagnostics', async () => {
    const root = repoRoot();
    const validator = skillScript('validate_eval_cases.mjs');
    const runValidator = async (filePath: string, strict = false) => {
      const args = [validator, filePath, '--format', 'json'];
      if (strict) args.push('--strict');
      const execution = await execFileAsync('node', args, { cwd: root, env: process.env }).then(
        (result) => result,
        (error: { stdout?: string }) => {
          if (!error.stdout) throw error;
          return { stdout: error.stdout };
        },
      );
      return JSON.parse(execution.stdout);
    };

    const example = await runValidator(path.join(
      root,
      '.agents',
      'skills',
      'skill-review',
      'assets',
      'eval-case-example.json',
    ));
    expect(example).toMatchObject({
      valid: true,
      mode: 'compatible',
      summary: { cases: 1, scenario_families: 1, errors: 0, warnings: 0 },
    });

    const triggerCases = await runValidator(path.join(
      root,
      '.agents',
      'skills',
      'skill-review',
      'evals',
      'trigger-cases.json',
    ));
    expect(triggerCases).toMatchObject({
      valid: true,
      summary: { errors: 0, warnings: 0 },
    });

    const strictTriggerCases = await runValidator(path.join(
      root,
      '.agents',
      'skills',
      'skill-review',
      'evals',
      'trigger-cases.json',
    ), true);
    expect(strictTriggerCases).toMatchObject({
      valid: true,
      summary: { errors: 0, warnings: 0 },
    });

    const strictBehaviorCases = await runValidator(path.join(
      root,
      '.agents',
      'skills',
      'skill-review',
      'evals',
      'evals.json',
    ), true);
    expect(strictBehaviorCases).toMatchObject({
      valid: true,
      summary: { errors: 0, warnings: 0 },
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-case-audit-'));
    tempDirs.push(tempRoot);
    const invalidPath = path.join(tempRoot, 'invalid.json');
    await fs.writeJson(invalidPath, {
      policy: {
        optimization: 'balanced',
        false_negative_cost: 'high',
        false_positive_cost: 'high',
        rationale: 'Both errors affect the target workflow.',
      },
      evals: [
        {
          id: 'mixed-layer',
          eval_type: 'trigger',
          split: 'validation',
          case_role: 'representative',
          provenance: 'derived',
          scenario_family: 'fixture',
          unit_under_test: 'description',
          preconditions: {},
          expected: { should_load_skill: true, outcome: 'complete' },
          oracle: {
            rationale: 'Fixture oracle.',
            rule_refs: ['SKILL.md description'],
            confidence: 'high',
            allowed_variance: 'Only loading is under test.',
          },
        },
        { id: 'mixed-layer' },
      ],
    });
    const invalid = await runValidator(invalidPath);
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'case.layer-mixing' }),
      expect.objectContaining({ code: 'case.duplicate-id' }),
    ]));

    const invalidEnumsPath = path.join(tempRoot, 'invalid-enums.json');
    await fs.writeJson(invalidEnumsPath, {
      policy: {
        optimization: 'unsupported',
        false_negative_cost: 'high',
        false_positive_cost: 'high',
        rationale: 'Both errors affect the target workflow.',
      },
      cases: [
        {
          id: 'invalid-enums',
          eval_type: 'trigger',
          split: 'production',
          case_role: 'representative',
          provenance: 'derived',
          scenario_family: 'fixture',
          unit_under_test: 'description',
          preconditions: {},
          should_load_skill: true,
          oracle: {
            rationale: 'Fixture oracle.',
            rule_refs: ['SKILL.md description'],
            confidence: 'high',
            allowed_variance: 'Only loading is under test.',
          },
        },
      ],
    });
    const invalidEnums = await runValidator(invalidEnumsPath);
    expect(invalidEnums).toMatchObject({
      valid: false,
      mode: 'compatible',
      summary: { errors: 2 },
    });
    expect(invalidEnums.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', code: 'suite.policy-optimization' }),
      expect.objectContaining({ level: 'error', code: 'case.split' }),
    ]));
  });

  it('allows only the draft artifact and its required parent directories', async () => {
    const cases = await fs.readJson(path.join(
      repoRoot(),
      '.agents',
      'skills',
      'skill-review',
      'evals',
      'evals.json',
    ));
    const draftCase = cases.evals.find(
      (entry: { id: string }) => entry.id === 'draft-persistence-does-not-publish',
    );

    expect(draftCase.review.allowed_workspace_changes).toEqual([
      '.tmp/',
      '.tmp/agent-workflows/',
      '.tmp/agent-workflows/reviews/',
      '.tmp/agent-workflows/reviews/draft-only-helper.md',
    ]);
    expect(draftCase.review.artifacts).toEqual([
      expect.objectContaining({
        path: '.tmp/agent-workflows/reviews/draft-only-helper.md',
        exists: true,
        contains: expect.arrayContaining(['quick', 'unknown']),
      }),
    ]);
  });

  it('keeps the near-miss Skill outside repo discovery and materializes it as a fixture', async () => {
    const root = repoRoot();
    const skillsRoot = path.join(root, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'skill-review');
    const fixtureSource = path.join(
      root,
      '.agents',
      'fixtures',
      'skill-review',
      'near-miss-skill',
    );
    const oldDiscoveryPath = path.join(
      skillRoot,
      'evals',
      'workspace',
      'near-miss-skill',
      'SKILL.md',
    );

    expect(path.relative(skillsRoot, fixtureSource).startsWith(`..${path.sep}`)).toBe(true);
    await expect(fs.pathExists(oldDiscoveryPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(fixtureSource, 'SKILL.md'))).resolves.toBe(true);

    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?near-miss-fixture`);
    const manifest = await runner.readManifest(skillRoot, 'skill-review');
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-near-miss-'));
    tempDirs.push(outputRoot);
    const subjectRoot = await runner.prepareSubject(manifest, outputRoot);

    await expect(fs.pathExists(path.join(
      subjectRoot,
      'fixtures',
      'near-miss-skill',
      'SKILL.md',
    ))).resolves.toBe(true);
  });

  it('prepares an isolated authoring subject whose scaffold passes its bundled validator', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?authoring-subject`);
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-authoring-subject-'));
    tempDirs.push(outputRoot);
    const skillName = 'create-aw-plugin';
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', skillName);
    const manifest = await runner.readManifest(skillRoot, skillName);
    const subjectRoot = await runner.prepareSubject(manifest, outputRoot);
    await expect(fs.pathExists(path.join(subjectRoot, 'node_modules', 'yaml', 'package.json')))
      .resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      subjectRoot,
      'packages',
      'cli',
      'src',
      'utils',
      'skill-frontmatter-capabilities.json',
    ))).resolves.toBe(true);

    const childEnv = { ...process.env };
    delete childEnv.NODE_PATH;
    const cliPath = path.join(repoRoot(), 'packages', 'cli', 'dist', 'index.js');
    await execFileAsync('node', [
      cliPath,
      'plugin',
      'init',
      'release-notes',
      '--description',
      'Generate release notes from repository changes.',
      '--skill-description',
      'Generate structured release notes from the current repository change set.',
      '--skill-short-description',
      'Generate structured notes from repository changes.',
      '--skill-invocation',
      'model',
      '--repo-root',
      subjectRoot,
    ], { cwd: subjectRoot, env: childEnv });

    const pluginRoot = path.join(subjectRoot, 'plugins', 'release-notes');
    const skillMdPath = path.join(pluginRoot, 'skills', 'release-notes', 'SKILL.md');
    const skillMd = await fs.readFile(skillMdPath, 'utf8');
    await fs.writeFile(
      skillMdPath,
      skillMd.replace(/\[TODO:[^\]]+\]/gu, '已完成并可检查的作者内容'),
      'utf8',
    );
    const result = await execFileAsync('node', [
      cliPath,
      'plugin',
      'validate',
      pluginRoot,
    ], {
      cwd: subjectRoot,
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout).toContain('[PASS] All checks passed.');
  });

  it('inspects dynamic source and materialized final artifacts together', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-inspect-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';
    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-explore',
      '--materialize-only',
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      createRunLayout: testEvalLayout(outputRoot),
    });
    expect(exitCode, stderr).toBe(0);
    const evalResult = JSON.parse(stdout);
    const evaluationPath = path.join(
      path.resolve(root, evalResult.reportDir),
      'raw',
      'evaluation.json',
    );

    const result = await execFileAsync('node', [
      skillScript('inspect_skill_target.mjs'),
      'codex-enhance',
      '--evaluation',
      evaluationPath,
      '--format',
      'json',
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const report = JSON.parse(result.stdout);

    expect(report.target).toMatchObject({ kind: 'aw-plugin', name: 'codex-enhance' });
    expect(report.plugin.dynamic_targets).toHaveLength(10);
    expect(report.source_skills).toHaveLength(2);
    expect(report.source_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'skills/codex-explore/SKILL.md' }),
      expect.objectContaining({ path: 'skills/codex-subagent-guide/SKILL.md' }),
    ]));
    expect(report.eval_manifest).toMatchObject({
      schemaVersion: 2,
      plugin: 'codex-enhance',
      skill: 'codex-explore',
    });
    expect(report.eval_manifests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skill: 'codex-explore',
        path: 'skills/codex-explore/evals/manifest.json',
      }),
      expect.objectContaining({
        skill: 'codex-subagent-guide',
        path: 'skills/codex-subagent-guide/evals/manifest.json',
      }),
    ]));
    expect(report.evaluation.profiles).toHaveLength(5);
    expect(report.evaluation.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profile: 'project-nondefault',
        evidence_level: 'runtime-project',
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'skill' }),
          expect.objectContaining({ kind: 'agent' }),
        ]),
      }),
    ]));
    await expect(
      fs.pathExists(report.evaluation.profiles[0].root),
    ).resolves.toBe(true);
    expect(report.final_skills).toHaveLength(10);
    expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
  });

  it('reviews itself and another project-local static Skill without treating nested examples as targets', async () => {
    const root = repoRoot();
    for (const skillName of ['skill-review', 'create-aw-plugin']) {
      const result = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        skillName,
        '--format',
        'json',
      ], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      const report = JSON.parse(result.stdout);

      expect(report.target).toMatchObject({
        kind: 'static-skill',
        name: skillName,
      });
      expect(report.skill.frontmatter.name).toBe(skillName);
      expect(report.skill.codex_metadata.allow_implicit_invocation).toBe(false);
      expect(report.evals.parse_errors).toEqual([]);
      expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
      if (skillName === 'skill-review') {
        expect(report.evals.trigger).toEqual({ total: 32, positive: 16, negative: 16 });
        expect(report.evals.behavior_cases).toBe(21);
        expect(report.evals.conversation_cases).toBe(21);
        expect(report.evals.portable_behavior_specs).toBe(39);
        expect(report.evals.behavior_evidence_note).toContain('not executable release evidence');
        expect(report.evals.scoring_cases).toBe(20);
        expect(report.scripts.count).toBe(4);
        expect(report.references.missing).toEqual([]);
        expect(report.pointers).toMatchObject({
          total: 9,
          conditional_signals: 8,
          weak_signal_lines: [],
        });
      } else {
        expect(report.issues.map((issue: { code: string }) => issue.code))
          .not.toContain('pointer.weak-signal');
      }
    }
  });

  it.runIf(process.platform !== 'win32')(
    'runs and consumes a static Skill evaluation bundle',
    async () => {
      const root = repoRoot();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-skill-eval-'));
      const outputRoot = path.join(tempRoot, 'output');
      const codexBin = path.join(tempRoot, 'fake-codex');
      const sourceCodexHome = path.join(tempRoot, 'source-codex-home');
      tempDirs.push(tempRoot);
      await Promise.all([fs.ensureDir(sourceCodexHome), fs.ensureDir(outputRoot)]);
      await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
        'model = "fixture-model"',
        'model_provider = "fixture-provider"',
        '[model_providers.fixture-provider]',
        'name = "Fixture"',
        'wire_api = "responses"',
        'experimental_bearer_token = "fixture-secret"',
        '[plugins."do-not-copy@local"]',
        'enabled = true',
      ].join('\n'), 'utf8');
      await fs.writeFile(codexBin, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.argv[2] === '--version') { process.stdout.write('fixture-secret\\n'); process.exit(0); }",
        "if (process.argv.includes('--ignore-user-config')) process.exit(9);",
        "const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
        "if (!config.includes('model_provider = \"fixture-provider\"') || config.includes('[plugins.')) process.exit(10);",
        "if (process.argv[2] !== 'app-server') process.exit(3);",
        'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
        "const readline = require('node:readline');",
        'const input = readline.createInterface({ input: process.stdin });',
        "input.on('line', (line) => {",
        '  const frame = JSON.parse(line);',
        "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
        "  else if (frame.method === 'config/read') send({ id: frame.id, result: {",
        "    config: { cli_auth_credentials_store: 'file', mcp_oauth_credentials_store: 'file', include_apps_instructions: false, include_collaboration_mode_instructions: false, mcp_servers: {}, features: { secret_auth_storage: false, default_mode_request_user_input: true, apps: false, plugins: false, remote_plugin: false, plugin_sharing: false, tool_suggest: false, skill_mcp_dependency_install: false }, skills: { bundled: { enabled: false } }, orchestrator: { skills: { enabled: false }, mcp: { enabled: false } } },",
        "    origins: {}, layers: [{ name: { type: 'system', file: '/etc/codex/config.toml' }, version: '1', config: {} }, { name: { type: 'user', file: path.join(process.env.CODEX_HOME, 'config.toml') }, version: '1', config: {} }, { name: { type: 'project', dotCodexFolder: path.join(frame.params.cwd, '.codex') }, version: '1', config: {} }, { name: { type: 'sessionFlags' }, version: '1', config: {} }],",
        '  } });',
        "  else if (frame.method === 'configRequirements/read') send({ id: frame.id, result: { requirements: null } });",
        "  else if (frame.method === 'skills/list') { const cwd = frame.params.cwds[0]; const skillPath = path.join(cwd, '.agents', 'skills', 'skill-review', 'SKILL.md'); send({ id: frame.id, result: { data: [{ cwd, skills: [{ name: 'skill-review', path: skillPath, scope: 'repo', enabled: true }], errors: [] }] } }); }",
        "  else if (frame.method === 'mcpServerStatus/list') send({ id: frame.id, result: { data: [], nextCursor: null } });",
        "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
        "  else if (frame.method === 'turn/start') {",
        "    send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });",
        "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'read-1', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cat .agents/skills/skill-review/SKILL.md' } } });",
        "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 7 } } });",
        "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
        '  }',
        '});',
        'process.on("SIGTERM", () => process.exit(0));',
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      await fs.chmod(codexBin, 0o755);

      const execution = await execFileAsync('node', [
        staticEvalRunner(),
        'skill-review',
        '--batch-name',
        'test-run',
        '--suite',
        'trigger',
        '--case',
        'full_skill_package',
        '--runs',
        '3',
        '--codex-bin',
        codexBin,
        '--allow-unmanaged-processes',
      ], {
        cwd: root,
        env: {
          ...process.env,
          CODEX_HOME: sourceCodexHome,
          CODEX_PERMISSION_PROFILE: ':workspace',
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      const executionReport = JSON.parse(execution.stdout);
      expect(executionReport).toMatchObject({ ok: true, outcome: 'passed' });
      expect(execution.stderr).toContain('use the longest responsive wait that the tool allows');
      expect(execution.stderr).toContain('A wait timeout is not an eval failure');
      const persistedBatchRoot = path.resolve(root, executionReport.batchDir);
      const persistedReportRoot = path.resolve(root, executionReport.reportDir);
      tempDirs.push(persistedBatchRoot);

      const evaluationPath = path.join(persistedReportRoot, 'raw', 'evaluation.json');
      expect(await fs.readFile(evaluationPath, 'utf8')).not.toContain('fixture-secret');
      const result = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        evaluationPath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 });
      const report = JSON.parse(result.stdout);
      expect(report.target).toMatchObject({ kind: 'static-skill', name: 'skill-review' });
      expect(report.evaluation).toMatchObject({
        target: { kind: 'static-skill', name: 'skill-review' },
        outcome: 'passed',
        model_provider: 'fixture-provider',
        credential_source: 'embedded',
      });
      expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);

      const validEvaluation = await fs.readJson(evaluationPath);
      expect(validEvaluation.processManagement).toMatchObject({
        mode: 'unmanaged-confirmed',
        inspectionAvailable: false,
        userAcknowledged: true,
        descendantCleanupGuaranteed: false,
      });
      const failedEvidencePath = path.join(outputRoot, 'failed-evidence.json');
      await fs.writeJson(failedEvidencePath, {
        ...validEvaluation,
        outcome: 'failed',
        mechanicalPassed: false,
      });
      const failedEvidence = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        failedEvidencePath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(failedEvidence?.stdout).toBeTruthy();
      expect(JSON.parse(failedEvidence!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.failed', level: 'error' }),
      ]));

      const malformedSuitePath = path.join(outputRoot, 'malformed-suite.json');
      await fs.writeJson(malformedSuitePath, { ...validEvaluation, suites: [{}] });
      const malformedSuite = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        malformedSuitePath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(malformedSuite?.stdout).toBeTruthy();
      expect(JSON.parse(malformedSuite!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.suite-contract', level: 'error' }),
      ]));

      const inconsistentSuitePath = path.join(outputRoot, 'inconsistent-suite.json');
      await fs.writeJson(inconsistentSuitePath, {
        ...validEvaluation,
        suites: [{
          ...validEvaluation.suites[0],
          outcome: 'failed',
          complete: true,
          mechanicalPassed: false,
        }],
      });
      const inconsistentSuite = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        inconsistentSuitePath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(inconsistentSuite?.stdout).toBeTruthy();
      expect(JSON.parse(inconsistentSuite!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.suite-summary', level: 'error' }),
      ]));

      for (const qualitativeReview of ['required', 'failed']) {
        const qualitativePath = path.join(outputRoot, `qualitative-${qualitativeReview}.json`);
        await fs.writeJson(qualitativePath, {
          ...validEvaluation,
          suites: [{ ...validEvaluation.suites[0], qualitativeReview }],
        });
        const qualitative = await execFileAsync('node', [
          skillScript('inspect_skill_target.mjs'),
          'skill-review',
          '--evaluation',
          qualitativePath,
          '--format',
          'json',
        ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
          () => null,
          (error: { stdout?: string }) => error,
        );
        expect(qualitative?.stdout).toBeTruthy();
        expect(JSON.parse(qualitative!.stdout!).issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'evaluation.suite-contract', level: 'error' }),
        ]));
      }

      const swappedKindsPath = path.join(outputRoot, 'swapped-suite-kinds.json');
      await fs.writeJson(swappedKindsPath, {
        ...validEvaluation,
        suites: [
          { ...validEvaluation.suites[0], id: 'trigger', kind: 'conversation' },
          { ...validEvaluation.suites[0], id: 'behavior', kind: 'trigger' },
        ],
      });
      const swappedKinds = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        swappedKindsPath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(swappedKinds?.stdout).toBeTruthy();
      expect(JSON.parse(swappedKinds!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.suite-manifest', level: 'error' }),
      ]));

      const missingEvidencePath = path.join(outputRoot, 'missing-evidence.json');
      await fs.writeJson(missingEvidencePath, {
        ...validEvaluation,
        subjects: [],
        suites: [],
      });
      const missingEvidence = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        missingEvidencePath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(missingEvidence?.stdout).toBeTruthy();
      expect(JSON.parse(missingEvidence!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.static-subject', level: 'error' }),
        expect.objectContaining({ code: 'evaluation.static-package-evidence', level: 'error' }),
        expect.objectContaining({ code: 'evaluation.suites-missing', level: 'error' }),
      ]));

      const subjectReference = path.join(
        persistedReportRoot,
        'raw',
        'subject',
        '.agents',
        'skills',
        'skill-review',
        'references',
        'static-skill-evaluation.md',
      );
      await fs.appendFile(subjectReference, '\nTampered after evaluation.\n');
      const tampered = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        'skill-review',
        '--evaluation',
        evaluationPath,
        '--format',
        'json',
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 }).then(
        () => null,
        (error: { stdout?: string }) => error,
      );
      expect(tampered?.stdout).toBeTruthy();
      expect(JSON.parse(tampered!.stdout!).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'evaluation.package-digest', level: 'error' }),
      ]));
    },
  );

  it('rejects nested static targets, protected workspace destinations, symlinks, and invalid behavior cases', async () => {
    const root = repoRoot();
    const nestedTarget = path.join(
      root,
      '.agents',
      'skills',
      'create-aw-plugin',
      'references',
      '.examples',
      'code-review',
      'skills',
      'review-workflow',
    );
    await expect(execFileAsync('node', [
      staticEvalRunner(),
      nestedTarget,
      '--validate-only',
    ], { cwd: root, env: process.env })).rejects.toMatchObject({
      stderr: expect.stringContaining('direct .agents/skills/<name> directory'),
    });

    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-eval-contract-'));
    tempDirs.push(fixtureRoot);
    await fs.ensureDir(path.join(fixtureRoot, 'evals'));
    await fs.writeJson(path.join(fixtureRoot, 'evals', 'cases.json'), {
      skill_name: 'fixture',
      evals: [{
        id: 'invalid',
        prompt: 42,
        scripted_replies: [],
        expected_output: 'Expected.',
        review: { checks: ['Check.'] },
      }],
    });
    const baseManifest = {
      schemaVersion: 1,
      skill: 'fixture',
      suites: [{
        id: 'behavior',
        kind: 'conversation',
        skill: 'fixture',
        skills: ['fixture'],
        cases: './evals/cases.json',
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: true,
        perRunTimeoutMs: 1_000,
      }],
    };
    const runner = await import(pathToFileURL(staticEvalRunner()).href);

    await fs.writeJson(path.join(fixtureRoot, 'evals', 'manifest.json'), baseManifest);
    await expect(runner.readManifest(fixtureRoot, 'fixture')).rejects.toThrow(
      'behavior.evals[0].prompt must be a non-empty string',
    );

    await fs.writeJson(path.join(fixtureRoot, 'evals', 'cases.json'), {
      skill_name: 'fixture',
      evals: [{
        id: 'valid',
        prompt: 'Prompt.',
        scripted_replies: [],
        expected_output: 'Expected.',
        review: { checks: ['Check.'] },
      }],
    });
    await fs.writeJson(path.join(fixtureRoot, 'evals', 'manifest.json'), {
      ...baseManifest,
      workspace: { copy: [{ from: 'package.json', to: './.codex/config.toml' }] },
    });
    await expect(runner.readManifest(fixtureRoot, 'fixture')).rejects.toThrow(
      'cannot replace Codex config or the target Skill',
    );

    await fs.writeJson(path.join(fixtureRoot, 'evals', 'manifest.json'), {
      ...baseManifest,
      workspace: { copy: [{ from: 'CLAUDE.md', to: 'fixture.md' }] },
    });
    await expect(runner.readManifest(fixtureRoot, 'fixture')).rejects.toThrow(
      'cannot contain symlinks',
    );

    await fs.writeJson(path.join(fixtureRoot, 'evals', 'manifest.json'), {
      schemaVersion: 1,
      skill: 'fixture',
      suites: [{
        id: 'trigger',
        kind: 'trigger',
        skill: 'fixture',
        skills: ['fixture'],
        cases: './evals/cases.json',
        fixtureModule: './evals/trigger-fixture.mjs',
        observeSpawnAgent: false,
        defaultRuns: 1,
        releaseSplits: ['validation'],
        requiredForRelease: true,
        perRunTimeoutMs: 1_000,
      }],
    });
    await expect(runner.readManifest(fixtureRoot, 'fixture')).rejects.toThrow(
      'fixtureModule is not supported for static Skill evals',
    );

    await fs.writeJson(path.join(fixtureRoot, 'evals', 'cases.json'), {
      schemaVersion: 1,
      skill: 'fixture',
      cases: [{
        id: 'workspace_fixture',
        split: 'validation',
        query: 'Review the fixture.',
        should_load_skill: true,
        workspace_fixture: 'repository_state',
      }],
    });
    await fs.writeJson(path.join(fixtureRoot, 'evals', 'manifest.json'), {
      schemaVersion: 1,
      skill: 'fixture',
      suites: [{
        id: 'trigger',
        kind: 'trigger',
        skill: 'fixture',
        skills: ['fixture'],
        cases: './evals/cases.json',
        observeSpawnAgent: false,
        defaultRuns: 1,
        releaseSplits: ['validation'],
        requiredForRelease: true,
        perRunTimeoutMs: 1_000,
      }],
    });
    await expect(runner.readManifest(fixtureRoot, 'fixture')).rejects.toThrow(
      'workspace_fixture is not supported for static Skill evals',
    );
  });

  it('reports standard static Skill contract errors without promoting nested fixture Skills', async () => {
    const root = repoRoot();
    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-skill-review-'));
    tempDirs.push(skillRoot);
    await fs.ensureDir(path.join(skillRoot, 'agents'));
    await fs.ensureDir(path.join(skillRoot, 'evals'));
    await fs.ensureDir(path.join(skillRoot, 'references', 'fixture'));
    await fs.writeJson(path.join(skillRoot, 'evals', 'present.json'), []);
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: wrong-name',
      'description: Review an invalid static Skill fixture.',
      '---',
      '',
      'See references/missing.md.',
      'Use evals/present.json and evals/missing.json.',
      'If validation fails, you must stop.',
      '**Gate completion:** verify the result.',
      '```text',
      'Result: <value>',
      '```',
    ].join('\n'), 'utf8');
    await fs.writeFile(
      path.join(skillRoot, 'references', 'fixture', 'SKILL.md'),
      '---\nname: nested\ndescription: Nested fixture only.\n---\n',
      'utf8',
    );
    await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), [
      'interface:',
      '  display_name: "Wrong Name"',
      '  short_description: "too short"',
      '  default_prompt: "Use $wrong-name."',
      'policy:',
      '  allow_implicit_invocation: false',
    ].join('\n'), 'utf8');

    const failure = await execFileAsync('node', [
      skillScript('inspect_skill_target.mjs'),
      path.join(skillRoot, 'SKILL.md'),
      '--format',
      'json',
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    }).then(
      () => null,
      (error: { stdout?: string }) => error,
    );
    expect(failure?.stdout).toBeTruthy();
    const report = JSON.parse(failure!.stdout!);

    expect(report.target.kind).toBe('static-skill');
    expect(report.skill.frontmatter.name).toBe('wrong-name');
    expect(report.references.reachable).toContain('evals/present.json');
    expect(report.skill.body_metrics).toMatchObject({
      mandatory_modal_count: 1,
      conditional_branch_count: 1,
      named_completion_gate_count: 1,
      fixed_output_field_count: 1,
    });
    expect(report.references.missing.map((entry: { target: string }) => entry.target)).toEqual(
      expect.arrayContaining(['references/missing.md', 'evals/missing.json']),
    );
    expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        'frontmatter.directory-name',
        'reference.missing',
        'pointer.weak-signal',
        'codex.short-description',
      ]),
    );
  });

  it('validates traceable scores, admitted blockers, and mode-specific verdicts', async () => {
    const root = repoRoot();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-scorecard-'));
    tempDirs.push(tempRoot);
    const base = await fs.readJson(
      path.join(root, '.agents', 'skills', 'skill-review', 'assets', 'scorecard-template.json'),
    );
    base.review = {
      skill_name: 'fixture',
      mode: 'release',
      direction: 'aligned',
      notes: '',
    };
    base.complexity = {
      verdict: 'proportionate',
      reducibility: 'minor',
      minimal_behavior_contract: [
        'Apply only the controls required by the evidenced target workflow.',
      ],
    };
    for (const key of Object.keys(base.artifacts)) {
      base.artifacts[key] = true;
    }
    base.artifacts.eval_known_invalid_oracle = false;
    base.dimensions = base.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: 5,
      confidence: 'high',
      evidence: ['fixture evidence'],
    }));
    base.gates = base.gates.map((gate: Record<string, unknown>) => ({
      ...gate,
      status: 'pass',
      reason: '',
    }));
    const scorecardPath = path.join(tempRoot, 'scorecard.json');
    const validate = async (scorecard: Record<string, unknown>) => {
      await fs.writeJson(scorecardPath, scorecard, { spaces: 2 });
      const execution = await execFileAsync('node', [
        skillScript('validate_scorecard.mjs'),
        scorecardPath,
        '--format',
        'json',
      ], { cwd: root, env: process.env }).then(
        (result) => result,
        (error: { stdout?: string }) => {
          if (!error.stdout) throw error;
          return { stdout: error.stdout };
        },
      );
      return JSON.parse(execution.stdout);
    };
    const scoreAllWithUnknowns = (score: number, confidence = 'medium') => {
      const scorecard = structuredClone(base);
      scorecard.unknowns = scorecard.dimensions.map((dimension: { id: string }) => ({
        id: `U-${dimension.id}`,
        dimension: dimension.id,
        description: `The ${dimension.id} quality gap is not yet verified by behavior evidence.`,
        required_evidence: `Run the ${dimension.id} verification case.`,
      }));
      scorecard.dimensions = scorecard.dimensions.map((dimension: { id: string }) => ({
        ...dimension,
        score,
        confidence,
        unknown_ids: [`U-${dimension.id}`],
      }));
      scorecard.dimensions.find(
        (dimension: { id: string }) => dimension.id === 'minimum_control',
      ).score = Math.max(score, 4);
      return scorecard;
    };

    const passedReport = await validate(base);
    expect(passedReport).toMatchObject({
      decision: {
        design: 'pass',
        release_readiness: 'ready',
        complexity: 'proportionate',
      },
      score: {
        weighted_score: 100,
        quality_band: 'excellent',
        coverage_percent: 100,
      },
      valid: true,
    });
    expect(Object.fromEntries(
      passedReport.dimensions.map((dimension: { id: string; weight: number }) =>
        [dimension.id, dimension.weight]),
    )).toMatchObject({
      specification: 6,
      scope_composition: 8,
      instruction_design: 10,
      minimum_control: 14,
      context_disclosure: 10,
    });

    const noEvalAudit = structuredClone(base);
    for (const field of [
      'trigger_eval_results',
      'behavior_eval_results',
      'regression_eval_results',
      'eval_audit_applicable',
      'eval_case_audit',
      'eval_error_cost_policy',
      'eval_baseline_assessed',
      'eval_variance_assessed',
      'eval_failure_triage',
      'eval_driven_change',
      'eval_change_regressions',
      'eval_known_invalid_oracle',
    ]) noEvalAudit.artifacts[field] = false;
    for (const gateId of ['eval-validity', 'eval-change-safety']) {
      const gate = noEvalAudit.gates.find((entry: { id: string }) => entry.id === gateId);
      gate.status = 'not_applicable';
      gate.reason = gateId === 'eval-validity'
        ? 'No eval evidence is in review scope.'
        : 'No eval-driven change is in review scope.';
    }
    expect(await validate(noEvalAudit)).toMatchObject({ valid: true });

    const unauditedEval = structuredClone(base);
    unauditedEval.artifacts.eval_case_audit = false;
    for (const gateId of ['eval-validity', 'eval-change-safety']) {
      const gate = unauditedEval.gates.find((entry: { id: string }) => entry.id === gateId);
      gate.status = 'unknown';
      gate.reason = 'Case Admission evidence is incomplete.';
    }
    expect(await validate(unauditedEval)).toMatchObject({
      valid: true,
      decision: { design: 'pass', release_readiness: 'provisional' },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cap.evals-case-audit' }),
      ]),
    });

    const missingErrorCostPolicy = structuredClone(base);
    missingErrorCostPolicy.artifacts.eval_error_cost_policy = false;
    expect(await validate(missingErrorCostPolicy)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'gate.eval-validity-evidence' }),
      ]),
    });

    const unsafeEvalChange = structuredClone(base);
    unsafeEvalChange.artifacts.eval_change_regressions = false;
    expect(await validate(unsafeEvalChange)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'gate.eval-change-safety-evidence' }),
      ]),
    });

    const invalidOracleChange = structuredClone(base);
    invalidOracleChange.artifacts.eval_known_invalid_oracle = true;
    expect(await validate(invalidOracleChange)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cap.evals-invalid-oracle' }),
        expect.objectContaining({ code: 'gate.eval-validity-known-invalid' }),
      ]),
    });

    const invalidSkillName = structuredClone(base);
    invalidSkillName.review.skill_name = '../wrong-skill';
    expect(await validate(invalidSkillName)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'review.skill-name' }),
      ]),
    });

    const missingComplexity = structuredClone(base);
    missingComplexity.complexity = undefined;
    expect(await validate(missingComplexity)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'complexity.mode-required' }),
      ]),
    });

    const missingHierarchy = structuredClone(base);
    missingHierarchy.artifacts.information_hierarchy_map = false;
    expect(await validate(missingHierarchy)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cap.information-hierarchy' }),
      ]),
      valid: true,
    });

    const missingMinimumControlAudit = structuredClone(base);
    missingMinimumControlAudit.artifacts.minimum_effective_control_audit = false;
    expect(await validate(missingMinimumControlAudit)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'complexity.audit-required' }),
      ]),
      valid: false,
    });

    const overSpecified = structuredClone(base);
    overSpecified.review.direction = 'at-risk';
    overSpecified.complexity = {
      verdict: 'over-specified',
      reducibility: 'significant',
      minimal_behavior_contract: [
        'Preserve the evidenced safety and behavior invariants.',
        'Validate the final integrated result before completion.',
      ],
    };
    overSpecified.findings = [{
      id: 'F-control',
      severity: 'P2',
      evidence_types: ['heuristic'],
      dimension: 'minimum_control',
      location: 'SKILL.md:20',
      problem: 'Mandatory bookkeeping exceeds the evidenced behavior contract.',
    }];
    const overSpecifiedDimension = overSpecified.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'minimum_control',
    );
    overSpecifiedDimension.score = 3;
    overSpecifiedDimension.finding_ids = ['F-control'];
    expect(await validate(overSpecified)).toMatchObject({
      complexity: { verdict: 'over-specified', reducibility: 'significant' },
      decision: { design: 'needs-fixes', release_readiness: 'provisional' },
      score: {
        weighted_score: 94.4,
        quality_band: 'excellent',
        effective_quality_band: 'adequate',
        quality_cap_reason: 'over-specified',
      },
      valid: true,
    });

    for (const [verdict, reducibility] of [
      ['minimal', 'almost-none'],
      ['proportionate', 'minor'],
    ] as const) {
      const mislabeled = structuredClone(overSpecified);
      mislabeled.review.direction = 'aligned';
      mislabeled.complexity.verdict = verdict;
      mislabeled.complexity.reducibility = reducibility;
      expect(await validate(mislabeled)).toMatchObject({
        valid: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'complexity.score' }),
        ]),
      });
    }

    const overEngineered = structuredClone(overSpecified);
    overEngineered.review.direction = 'drifted';
    overEngineered.complexity.verdict = 'over-engineered';
    overEngineered.complexity.reducibility = 'redesign';
    const overEngineeredDimension = overEngineered.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'minimum_control',
    );
    overEngineeredDimension.score = 2;
    expect(await validate(overEngineered)).toMatchObject({
      decision: { design: 'redesign', release_readiness: 'blocked' },
      score: {
        weighted_score: 91.6,
        effective_quality_band: 'weak',
      },
      valid: true,
    });

    const alignedOverSpecified = structuredClone(overSpecified);
    alignedOverSpecified.review.direction = 'aligned';
    expect(await validate(alignedOverSpecified)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'complexity.direction' }),
      ]),
    });

    const lowQuality = scoreAllWithUnknowns(2.5);
    expect(await validate(lowQuality)).toMatchObject({
      decision: { design: 'pass', release_readiness: 'ready' },
      score: {
        weighted_score: 54.2,
        quality_band: 'poor',
      },
      valid: true,
    });

    for (const [score, qualityBand] of [
      [3, 'weak'],
      [3.5, 'adequate'],
      [4, 'strong'],
      [4.5, 'excellent'],
    ] as const) {
      expect(await validate(scoreAllWithUnknowns(score))).toMatchObject({
        decision: { design: 'pass', release_readiness: 'ready' },
        score: {
          weighted_score: score * 20 + Math.max(0, 4 - score) * 2.8,
          quality_band: qualityBand,
        },
        valid: true,
      });
    }

    const missingEvidence = structuredClone(base);
    for (const dimension of missingEvidence.dimensions) dimension.evidence = [''];
    expect(await validate(missingEvidence)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dimension.evidence' }),
        expect.objectContaining({ code: 'dimension.no-evidence' }),
      ]),
    });

    const unlinkedGate = structuredClone(base);
    unlinkedGate.gates[0].status = 'fail';
    unlinkedGate.gates[0].reason = 'Invalid package.';
    expect(await validate(unlinkedGate)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'gate.finding-required' }),
      ]),
    });

    const blocked = structuredClone(base);
    blocked.findings = [{
      id: 'F-package',
      severity: 'P0',
      evidence_types: ['structural'],
      dimension: 'specification',
      location: 'SKILL.md:1',
      problem: 'The package name is invalid.',
      material_premises: [
        {
          premise: 'The declared name contains an invalid character.',
          source_role: 'target frontmatter',
          evidence: 'SKILL.md:1 declares the invalid name.',
          status: 'supported',
        },
        {
          premise: 'The target schema rejects that character.',
          source_role: 'target schema',
          evidence: 'The applicable schema permits no exception.',
          status: 'supported',
        },
      ],
      affected_scenario: 'The target client rejects the package before loading the Skill.',
      reachability: {
        kind: 'entry-gate',
        path: 'The target client validates frontmatter before loading the Skill.',
        evidence: 'The package validator rejects the declared name.',
        status: 'supported',
      },
      impact: 'The package cannot load in the target client.',
      evidence: ['The declared name contains an invalid character.'],
      counterevidence: ['The target schema was checked and defines no exception for this character.'],
      correct_owner: 'Skill',
      minimal_change: 'Replace the invalid character in the name.',
      validation: 'Run the package validator again.',
    }];
    blocked.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'specification',
    ).score = 4.5;
    blocked.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'specification',
    ).finding_ids = ['F-package'];
    blocked.gates[0].status = 'fail';
    blocked.gates[0].reason = 'The package name is invalid.';
    blocked.gates[0].finding_ids = ['F-package'];
    expect(await validate(blocked)).toMatchObject({
      decision: { design: 'fail', release_readiness: 'blocked' },
      valid: true,
    });

    const invalidOwner = structuredClone(blocked);
    invalidOwner.findings[0].correct_owner = 'Banana';
    expect(await validate(invalidOwner)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.owner' }),
      ]),
    });

    const unsupportedPremise = structuredClone(blocked);
    unsupportedPremise.findings[0].material_premises[0].status = 'unknown';
    expect(await validate(unsupportedPremise)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.admission-premise-support' }),
      ]),
    });

    const unreachable = structuredClone(blocked);
    unreachable.findings[0].reachability.status = 'unknown';
    expect(await validate(unreachable)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.admission-reachability' }),
      ]),
    });

    const missingImpact = structuredClone(blocked);
    missingImpact.findings[0].impact = '';
    expect(await validate(missingImpact)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'finding.required-field',
          message: expect.stringContaining('impact'),
        }),
      ]),
    });

    const weakAuthority = structuredClone(base);
    weakAuthority.review.mode = 'full';
    weakAuthority.findings = [{
      id: 'F-heuristic',
      severity: 'P1',
      evidence_types: ['heuristic'],
      dimension: 'triggering',
      location: 'SKILL.md:1',
      problem: 'A heuristic-only complaint.',
      material_premises: [
        {
          premise: 'A third-party guide prefers another phrase.',
          source_role: 'third-party heuristic',
          evidence: 'The cited guide contains that preference.',
          status: 'supported',
        },
      ],
      affected_scenario: 'A future query could fail to load the Skill.',
      reachability: {
        kind: 'execution-path',
        path: 'A future query reaches the target description.',
        evidence: 'The target client uses the description for routing.',
        status: 'supported',
      },
      impact: 'The Skill could fail to load for that future query.',
      evidence: ['A third-party writing guide prefers another phrase.'],
      counterevidence: ['No target trace or official rule supports the complaint.'],
      correct_owner: 'Skill',
      minimal_change: 'No change without stronger evidence.',
      validation: 'Run a behavior eval.',
    }];
    const weakTriggering = weakAuthority.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'triggering',
    );
    weakTriggering.score = 4.5;
    weakTriggering.finding_ids = ['F-heuristic'];
    expect(await validate(weakAuthority)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.authority-severity' }),
      ]),
    });

    const missingAdmission = structuredClone(base);
    missingAdmission.review.mode = 'full';
    missingAdmission.findings = [{
      id: 'F-incomplete',
      severity: 'P1',
      evidence_types: ['structural'],
      dimension: 'architecture',
      location: 'SKILL.md:20',
      problem: 'The lifecycle rule is internally inconsistent.',
      correct_owner: 'Skill',
      minimal_change: 'Remove the conflicting rule.',
      validation: 'Run the lifecycle fixture.',
    }];
    const incompleteArchitecture = missingAdmission.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'architecture',
    );
    incompleteArchitecture.score = 4.5;
    incompleteArchitecture.finding_ids = ['F-incomplete'];
    expect(await validate(missingAdmission)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.required-field' }),
        expect.objectContaining({ code: 'finding.admission-premises' }),
        expect.objectContaining({ code: 'finding.admission-reachability' }),
        expect.objectContaining({ code: 'finding.admission-evidence' }),
        expect.objectContaining({ code: 'finding.admission-counterevidence' }),
      ]),
    });

    const untraceableScore = structuredClone(base);
    untraceableScore.review.mode = 'full';
    untraceableScore.dimensions[0].score = 4.5;
    expect(await validate(untraceableScore)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dimension.untraceable-score' }),
      ]),
    });

    const duplicatePenalty = structuredClone(base);
    duplicatePenalty.review.mode = 'full';
    duplicatePenalty.findings = [{
      id: 'F-shared',
      severity: 'P2',
      evidence_types: ['heuristic'],
      dimension: 'triggering',
    }];
    duplicatePenalty.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'triggering',
    ).finding_ids = ['F-shared'];
    duplicatePenalty.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'context_disclosure',
    ).finding_ids = ['F-shared'];
    expect(await validate(duplicatePenalty)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dimension.finding-dimension' }),
        expect.objectContaining({ code: 'finding.multiple-dimensions' }),
      ]),
    });

    const legacyEvidence = structuredClone(base);
    legacyEvidence.review.mode = 'full';
    legacyEvidence.findings = [{
      id: 'F-legacy',
      severity: 'P2',
      evidence_types: null,
      evidence_type: 'heuristic',
      dimension: 'triggering',
    }];
    legacyEvidence.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'triggering',
    ).finding_ids = ['F-legacy'];
    expect(await validate(legacyEvidence)).toMatchObject({
      findings: [{
        id: 'F-legacy',
        evidence_types: ['heuristic'],
      }],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.legacy-evidence-type' }),
      ]),
      valid: true,
    });

    const quick = structuredClone(base);
    quick.review.mode = 'quick';
    quick.complexity = {
      verdict: null,
      reducibility: null,
      minimal_behavior_contract: [],
    };
    quick.dimensions = quick.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: null,
      confidence: 'unknown',
      evidence: [],
      finding_ids: [],
      unknown_ids: [],
    }));
    for (const id of ['specification', 'problem_value', 'triggering']) {
      const dimension = quick.dimensions.find((entry: { id: string }) => entry.id === id);
      dimension.score = 5;
      dimension.confidence = 'high';
      dimension.evidence = ['quick fixture evidence'];
    }
    expect(await validate(quick)).toMatchObject({
      decision: { design: 'not-assessed', release_readiness: 'not-assessed' },
      score: {
        weighted_score: null,
        quality_band: null,
        coverage_percent: 24,
      },
      valid: true,
    });

    const quickMissingAudit = structuredClone(base);
    quickMissingAudit.review.mode = 'quick';
    quickMissingAudit.artifacts.minimum_effective_control_audit = false;
    quickMissingAudit.dimensions = quickMissingAudit.dimensions.map(
      (dimension: Record<string, unknown>) => ({
        ...dimension,
        score: null,
        confidence: 'unknown',
        evidence: [],
        finding_ids: [],
        unknown_ids: [],
      }),
    );
    for (const id of ['specification', 'problem_value', 'minimum_control']) {
      const dimension = quickMissingAudit.dimensions.find(
        (entry: { id: string }) => entry.id === id,
      );
      dimension.score = 5;
      dimension.confidence = 'high';
      dimension.evidence = ['quick audit fixture evidence'];
    }
    expect(await validate(quickMissingAudit)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cap.minimum-control' }),
      ]),
      decision: { design: 'not-assessed', release_readiness: 'not-assessed' },
      valid: true,
    });

    const delta = structuredClone(base);
    delta.review.mode = 'delta';
    delta.complexity = {
      verdict: null,
      reducibility: null,
      minimal_behavior_contract: [],
    };
    delta.artifacts.previous_version = true;
    delta.dimensions = delta.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: null,
      confidence: 'unknown',
      evidence: [],
      finding_ids: [],
      unknown_ids: [],
    }));
    const affectedArchitecture = delta.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'architecture',
    );
    affectedArchitecture.score = 5;
    affectedArchitecture.confidence = 'high';
    affectedArchitecture.evidence = ['delta fixture evidence'];
    expect(await validate(delta)).toMatchObject({
      decision: { design: 'pass', release_readiness: 'not-assessed' },
      score: {
        weighted_score: null,
        quality_band: null,
        coverage_percent: 10,
      },
      valid: true,
    });

    const orphanReducibility = structuredClone(delta);
    orphanReducibility.complexity.reducibility = 'redesign';
    expect(await validate(orphanReducibility)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'complexity.verdict-required' }),
      ]),
    });

    const emptyDelta = structuredClone(delta);
    emptyDelta.dimensions = emptyDelta.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: null,
      confidence: 'unknown',
      evidence: [],
    }));
    expect(await validate(emptyDelta)).toMatchObject({
      decision: { design: 'not-assessed', release_readiness: 'not-assessed' },
      score: { weighted_score: null, coverage_percent: 0 },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'mode.delta-scope' }),
      ]),
    });

    const missingPrevious = structuredClone(delta);
    missingPrevious.artifacts.previous_version = false;
    expect(await validate(missingPrevious)).toMatchObject({
      decision: { design: 'not-assessed', release_readiness: 'not-assessed' },
      valid: true,
    });

    const incompleteFull = structuredClone(base);
    incompleteFull.review.mode = 'full';
    incompleteFull.dimensions[0] = {
      ...incompleteFull.dimensions[0],
      score: null,
      confidence: 'unknown',
      evidence: [],
    };
    expect(await validate(incompleteFull)).toMatchObject({
      decision: { design: 'not-assessed', release_readiness: 'provisional' },
      score: { weighted_score: null },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dimension.mode-required' }),
      ]),
    });

    const staleSources = structuredClone(base);
    staleSources.artifacts.current_sources_checked = false;
    expect(await validate(staleSources)).toMatchObject({
      decision: { design: 'pass', release_readiness: 'provisional' },
      valid: true,
    });

    const stringArtifact = structuredClone(base);
    stringArtifact.artifacts.current_sources_checked = 'false';
    expect(await validate(stringArtifact)).toMatchObject({
      decision: { design: 'pass', release_readiness: 'provisional' },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'artifacts.value' }),
      ]),
    });

    const lowConfidence = structuredClone(base);
    for (const dimension of lowConfidence.dimensions) dimension.confidence = 'low';
    expect(await validate(lowConfidence)).toMatchObject({
      decision: { design: 'not-assessed', release_readiness: 'provisional' },
      score: { confidence: 'low' },
      valid: true,
    });

    const missingOptional = structuredClone(base);
    missingOptional.review.mode = 'full';
    missingOptional.findings = undefined;
    missingOptional.unknowns = undefined;
    const omittedFields = await validate(missingOptional);
    expect(omittedFields).toMatchObject({ valid: true });
    expect(omittedFields.diagnostics.map(
      (entry: { code: string }) => entry.code,
    )).not.toEqual(expect.arrayContaining([
      'findings.type',
      'unknowns.type',
    ]));

    const explicitNulls = structuredClone(base);
    explicitNulls.review.mode = 'full';
    explicitNulls.findings = [{
      id: null,
      severity: 'P2',
      evidence_types: ['heuristic'],
      dimension: 'triggering',
    }];
    explicitNulls.dimensions[0].confidence = null;
    explicitNulls.dimensions[0].evidence = null;
    explicitNulls.dimensions[0].summary = null;
    explicitNulls.gates[0].reason = null;
    expect((await validate(explicitNulls)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dimension.confidence' }),
      expect.objectContaining({ code: 'dimension.evidence' }),
      expect.objectContaining({ code: 'dimension.summary' }),
      expect.objectContaining({ code: 'gate.reason' }),
      expect.objectContaining({ code: 'finding.id' }),
    ]));

    const confidenceBoundary = structuredClone(base);
    confidenceBoundary.review.mode = 'full';
    for (const dimension of confidenceBoundary.dimensions) {
      dimension.confidence = ['specification', 'problem_value', 'architecture']
        .includes(dimension.id) ? 'medium' : 'high';
    }
    expect(await validate(confidenceBoundary)).toMatchObject({
      score: {
        confidence_index: 0.93,
      },
      valid: true,
    });

    for (const [confidences, label, expectedIndex] of [
      [[
        'high', 'high', 'high', 'high', 'high', 'low',
        'low', 'low', 'high', 'unknown', 'unknown', 'unknown',
      ], 'medium', 0.63],
      [[
        'high', 'high', 'high', 'high', 'high', 'high',
        'high', 'low', 'high', 'unknown', 'medium', 'unknown',
      ], 'high', 0.8],
    ] as const) {
      const boundary = structuredClone(base);
      boundary.dimensions.forEach((dimension: Record<string, unknown>, index: number) => {
        dimension.confidence = confidences[index];
      });
      expect(await validate(boundary)).toMatchObject({
        decision: { design: 'pass', release_readiness: 'ready' },
        score: {
          confidence_index: expectedIndex,
          confidence: label,
        },
        valid: true,
      });
    }
  });
});
