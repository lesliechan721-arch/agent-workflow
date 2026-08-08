import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runPluginEvals } from '../../scripts/eval-plugin-skills.js';
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

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill-review author tools', () => {
  it('parses a quoted YAML Skill name as its scalar value', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?quoted-name`);
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'quoted-skill');

    expect(runner.parseSkillName([
      '---',
      'name: "quoted-skill"',
      'description: Quoted YAML scalar fixture.',
      '---',
      '',
      '# Quoted Skill',
    ].join('\n'), skillRoot)).toBe('quoted-skill');
  });

  it('inspects dynamic source and materialized final artifacts together', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-inspect-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    const exitCode = await runPluginEvals([
      'codex-explore',
      '--materialize-only',
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    const evaluationPath = path.join(outputRoot, 'codex-explore', 'evaluation.json');

    const result = await execFileAsync('node', [
      skillScript('inspect_skill_target.mjs'),
      'codex-explore',
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

    expect(report.target).toMatchObject({ kind: 'aw-plugin', name: 'codex-explore' });
    expect(report.plugin.dynamic_targets).toHaveLength(5);
    expect(report.source_skills[0].path).toBe('templates/codex-explore/SKILL.md');
    expect(report.evaluation.profiles).toHaveLength(4);
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
    expect(report.final_skills).toHaveLength(4);
    expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
  });

  it('reviews itself and another project-local static Skill without treating nested examples as targets', async () => {
    const root = repoRoot();
    for (const skillName of ['skill-review', 'create-agent-workflows-plugin']) {
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
      expect(report.skill.codex_metadata.allow_implicit_invocation).toBe(true);
      expect(report.evals.parse_errors).toEqual([]);
      expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
      if (skillName === 'skill-review') {
        expect(report.evals.trigger).toEqual({ total: 24, positive: 12, negative: 12 });
        expect(report.evals.behavior_cases).toBe(5);
        expect(report.evals.conversation_cases).toBe(5);
        expect(report.evals.portable_behavior_specs).toBe(21);
        expect(report.evals.behavior_evidence_note).toContain('not executable release evidence');
        expect(report.evals.scoring_cases).toBe(8);
        expect(report.scripts.count).toBe(3);
        expect(report.references.missing).toEqual([]);
        expect(report.pointers).toMatchObject({
          total: 7,
          conditional_signals: 7,
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
      await fs.ensureDir(sourceCodexHome);
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
        'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
        'send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: "cat .agents/skills/skill-review/SKILL.md" } });',
        'send({ type: "turn.completed", usage: { total_tokens: 7 } });',
        'process.on("SIGTERM", () => process.exit(0));',
        'setTimeout(() => process.exit(0), 100);',
      ].join('\n'), 'utf8');
      await fs.chmod(codexBin, 0o755);

      const execution = await execFileAsync('node', [
        staticEvalRunner(),
        'skill-review',
        '--suite',
        'trigger',
        '--case',
        'full_skill_package',
        '--runs',
        '1',
        '--codex-bin',
        codexBin,
        '--output-dir',
        outputRoot,
      ], {
        cwd: root,
        env: { ...process.env, CODEX_HOME: sourceCodexHome },
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(JSON.parse(execution.stdout)).toMatchObject({ ok: true, outcome: 'passed' });

      const evaluationPath = path.join(outputRoot, 'evaluation.json');
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
        outputRoot,
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
      'create-agent-workflows-plugin',
      'references',
      '.examples',
      'code-review',
      'review-skills',
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

  it('computes release gates without score overrides or quick-mode passes', async () => {
    const root = repoRoot();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-scorecard-'));
    tempDirs.push(tempRoot);
    const template = await fs.readJson(
      path.join(root, '.agents', 'skills', 'skill-review', 'assets', 'scorecard-template.json'),
    );
    template.review = {
      skill_name: 'fixture',
      mode: 'release',
      direction: 'aligned',
      notes: '',
    };
    for (const key of Object.keys(template.artifacts)) {
      template.artifacts[key] = true;
    }
    template.dimensions = template.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: 5,
      confidence: 'high',
      evidence: ['fixture evidence'],
    }));
    template.gates = template.gates.map((gate: Record<string, unknown>) => ({
      ...gate,
      status: 'pass',
      reason: '',
    }));
    const scorecardPath = path.join(tempRoot, 'scorecard.json');
    await fs.writeJson(scorecardPath, template, { spaces: 2 });

    const passed = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    const passedReport = JSON.parse(passed.stdout);
    expect(passedReport).toMatchObject({
      score: {
        weighted_score: 100,
        coverage_percent: 100,
        release: 'pass',
      },
      valid: true,
    });
    expect(Object.fromEntries(
      passedReport.dimensions.map((dimension: { id: string; weight: number }) =>
        [dimension.id, dimension.weight]),
    )).toMatchObject({
      specification: 7,
      scope_composition: 8,
      instruction_design: 12,
      context_disclosure: 12,
      resources: 5,
    });

    template.artifacts.information_hierarchy_map = false;
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const missingHierarchy = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(missingHierarchy.stdout)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cap.information-hierarchy' }),
      ]),
      valid: true,
    });
    template.artifacts.information_hierarchy_map = true;

    template.gates[0].status = 'fail';
    template.gates[0].reason = 'Invalid package.';
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const failedGate = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(failedGate.stdout)).toMatchObject({
      score: {
        weighted_score: 100,
        release: 'fail',
      },
      valid: true,
    });

    template.review.mode = 'quick';
    template.gates[0].status = 'pass';
    template.gates[0].reason = '';
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const quick = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(quick.stdout)).toMatchObject({
      score: {
        weighted_score: 100,
        release: 'provisional',
      },
      valid: true,
    });

    template.review.mode = 'release';
    template.artifacts.current_sources_checked = [];
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const staleSources = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(staleSources.stdout)).toMatchObject({
      score: { release: 'provisional' },
      valid: true,
    });

    template.review.mode = 'delta';
    template.artifacts.current_sources_checked = true;
    template.artifacts.previous_version = {};
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const missingPrevious = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(missingPrevious.stdout)).toMatchObject({
      score: { release: 'provisional' },
      valid: true,
    });

    template.review.mode = 'full';
    template.artifacts.previous_version = true;
    template.findings = [{
      id: 'F-heuristic',
      severity: 'P1',
      evidence_types: ['heuristic'],
      dimension: 'triggering',
      location: 'SKILL.md:1',
      problem: 'A heuristic-only complaint.',
      correct_owner: 'Skill',
      minimal_change: 'No change without stronger evidence.',
      validation: 'Run a behavior eval.',
    }];
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const weakAuthority = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env }).then(
      () => null,
      (error: { stdout?: string }) => error,
    );
    expect(weakAuthority?.stdout).toBeTruthy();
    expect(JSON.parse(weakAuthority!.stdout!)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.authority-severity' }),
      ]),
    });

    template.findings = [{
      id: 'F-legacy',
      severity: 'P2',
      evidence_types: null,
      evidence_type: 'heuristic',
      dimension: 'triggering',
    }];
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const legacyEvidence = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(legacyEvidence.stdout)).toMatchObject({
      findings: [{
        id: 'F-legacy',
        evidence_types: ['heuristic'],
      }],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'finding.legacy-evidence-type' }),
      ]),
      valid: true,
    });

    const missingOptional = structuredClone(template);
    missingOptional.review.mode = 'full';
    missingOptional.findings = undefined;
    missingOptional.artifacts = undefined;
    await fs.writeJson(scorecardPath, missingOptional, { spaces: 2 });
    const omittedFields = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(omittedFields.stdout)).toMatchObject({ valid: true });
    expect(JSON.parse(omittedFields.stdout).diagnostics.map(
      (entry: { code: string }) => entry.code,
    )).not.toEqual(expect.arrayContaining(['artifacts.type', 'findings.type']));

    const explicitNulls = structuredClone(template);
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
    await fs.writeJson(scorecardPath, explicitNulls, { spaces: 2 });
    const invalidNulls = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env }).then(
      () => null,
      (error: { stdout?: string }) => error,
    );
    expect(invalidNulls?.stdout).toBeTruthy();
    expect(JSON.parse(invalidNulls!.stdout!).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dimension.confidence' }),
      expect.objectContaining({ code: 'dimension.evidence' }),
      expect.objectContaining({ code: 'dimension.summary' }),
      expect.objectContaining({ code: 'gate.reason' }),
      expect.objectContaining({ code: 'finding.id' }),
    ]));

    const halfEven = structuredClone(template);
    halfEven.review.mode = 'full';
    halfEven.findings = [];
    halfEven.dimensions = halfEven.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: null,
      confidence: 'unknown',
      evidence: [],
    }));
    for (const [id, score] of [
      ['specification', 0],
      ['triggering', 0],
      ['resources', 1.5],
    ] as const) {
      const dimension = halfEven.dimensions.find(
        (entry: { id: string }) => entry.id === id,
      );
      dimension.score = score;
      dimension.confidence = 'high';
      dimension.evidence = ['rounding fixture'];
    }
    await fs.writeJson(scorecardPath, halfEven, { spaces: 2 });
    const rounded = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(rounded.stdout)).toMatchObject({
      score: {
        weighted_score: 6.2,
        coverage_percent: 24,
      },
      valid: true,
    });

    const confidenceBoundary = structuredClone(template);
    confidenceBoundary.review.mode = 'full';
    confidenceBoundary.findings = [];
    for (const dimension of confidenceBoundary.dimensions) {
      dimension.confidence = ['specification', 'problem_value', 'architecture']
        .includes(dimension.id) ? 'medium' : 'high';
    }
    await fs.writeJson(scorecardPath, confidenceBoundary, { spaces: 2 });
    const confidenceRounded = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(confidenceRounded.stdout)).toMatchObject({
      score: {
        confidence_index: 0.93,
      },
      valid: true,
    });
  });

  it('keeps evaluated upstream content unchanged outside documented project adapters', async () => {
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'skill-review');
    const exactHashes: Record<string, string> = {
      'CHANGELOG.md': 'e46024c71eb030a91be37f494044ef4d3622046c4ca46ecf97cc34efdca33177',
      'assets/report-template.md': 'e3df054e886822baa603d92be723089e53468c1d9905160cb242886b47c5ecca',
      'assets/scorecard-template.json': 'd74d149b70e2fc361aa23dd5b56f3fbd5cec81f3d0c64f8b2ae43d9e6338cc3b',
      'evals/behavior_cases.json': '860360e3ddeaa55d8ffac1497d4876a1f964fb0d30f29c793e35568f0bbb3993',
      'evals/scoring_cases.json': 'a35d91811b07d235a315a5a79ca18009aa99cd370f0299fdcd2f24038681a40f',
      'evals/trigger-cases.json': 'aff2212cc2b6f73f9203d5193cc5be6e7a20a15c9180096feeca2fee35588b94',
      'references/architecture-boundaries.md': '73546c91c0219892c584c5ff64fd192814eb080137c744b2f72fbcd62119eb15',
      'references/delta-review.md': '664b18af9bb388a44f009d099e4790572e1103aafa6830efbd41365fffd9d54e',
      'references/review-dimensions.md': '9665063f4e22ef0a365bac3ff3d578275b3236db08851b6a244f442e346931d7',
      'references/scripts-and-resources.md': '4cbdc68a638d26df6ac78d18cec5f27c8d0f27bf230c4ff514544fb02cce98db',
      'references/source-map.md': '48567b80f7f10b4793926016d14a3288135039636d6842db00fd9845f9c2188f',
    };
    for (const [relative, expected] of Object.entries(exactHashes)) {
      expect(contentDigest(await fs.readFile(path.join(skillRoot, relative), 'utf8'))).toBe(expected);
    }
    const triggerCorpus = await fs.readJson(path.join(skillRoot, 'evals', 'trigger-cases.json'));
    expect(triggerCorpus.cases).toHaveLength(24);
    expect(triggerCorpus.cases.filter((entry: { should_load_skill: boolean }) =>
      entry.should_load_skill)).toHaveLength(12);
    expect(new Set(triggerCorpus.cases.map((entry: { split: string }) => entry.split))).toEqual(
      new Set(['train', 'validation']),
    );

    const readme = (await fs.readFile(path.join(skillRoot, 'README.md'), 'utf8'))
      .replace('node scripts/inspect_skill_target.mjs', 'python3 scripts/inspect_skill.py')
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py')
      .replace(
        'node scripts/run_static_skill_evals.mjs <skill-name-or-dir> --validate-only\n',
        '',
      )
      .replace(
        '\n\n当前仓库静态 Skill 的真实模型 eval 先运行 `pnpm build`，再由 `run_static_skill_evals.mjs` 生成证据；它不是 `plugin:eval` 的别名。\n',
        '\n',
      );
    expect(contentDigest(readme)).toBe(
      '46353b81f9ed65b9f436d356d554a88d6f9ec739d7d46f67da0e246c27cb015e',
    );

    const skill = (await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'))
      .replace(
        [
          'description: >-',
          '  当用户的主要目标是评估已有的静态或 agent-workflows 插件 Agent Skill、',
          '  草稿或修订版的质量、风险或发布就绪性时使用；适用于快速、完整或发布',
          '  审核、差量复核、质量比较、触发边界诊断和多维评分。即使只提供',
          '  SKILL.md、一个 Skill 组件、执行 trace 或 eval 结果，也仅在用户需要',
          '  finding、评分、风险、发布门禁、问题关闭情况或最小改进集时使用。若',
          '  主要目标仅是从零创建、直接改写或修复 Skill、实现脚本或 eval、运行',
          '  Skill 或脚本、做语法或解析检查、查询规范、解释流程，或普通代码/文档',
          '  review，不要使用。',
          '',
        ].join('\n'),
        'description: 当需要审核、评分、发布检查、比较或重构 Agent Skill 及其 SKILL.md、description、references、scripts、assets、evals 或相关角色配置时使用；评估调用与触发、范围、程序与完成边界、信息层级与渐进式披露、架构职责、脚本、资源、行为证据、安全和维护性，给出发布门禁、分数及最小改进集。不要用于普通代码或文档 review。\n',
      )
      .replace(
        'compatibility: Requires the agent-workflows repository, Node.js 20+, installed workspace dependencies, and current Agent Skills documentation access for release reviews.\n',
        'compatibility: Bundled validators require Python 3.11+; release reviews should be able to access the current Agent Skills documentation.\n',
      )
      .replace(
        'node scripts/inspect_skill_target.mjs <skill-dir-or-SKILL.md-or-plugin>',
        'python3 scripts/inspect_skill.py <skill-dir-or-SKILL.md>',
      )
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py')
      .replace(
        '   - 当前仓库静态 Skill 的 release 评审或用户明确要求真实 eval：读取 `references/static-skill-evaluation.md` 和 `evals/manifest.json`；先运行 `node scripts/run_static_skill_evals.mjs <skill-dir-or-name> --validate-only`。\n',
        '',
      )
      .replace(
        '   - 当前仓库的 AW 插件或动态 Skill：`references/agent-workflows-plugin.md`\n',
        '',
      );
    expect(contentDigest(skill)).toBe(
      '1cbae6df82e51919f1e8e8005c21e75be135abae645ed5047c527b9d712fb4de',
    );

    const scoringModel = (
      await fs.readFile(path.join(skillRoot, 'references', 'scoring-model.md'), 'utf8')
    )
      .replace('validate_scorecard.mjs', 'validate_scorecard.py')
      .replace(
        '- 没有 information-hierarchy map，`context_disclosure` 通常不高于 4。\n',
        '',
      )
      .replace(
        '4. release 模式 coverage 不足、关键 gate 为 unknown 或未核对 current-check 来源 → `provisional`。',
        '4. release 模式 coverage 不足或关键 gate 为 unknown → `provisional`。',
      );
    expect(contentDigest(scoringModel)).toBe(
      '724f35ee3eba304271aaa40d1593725bd79c093d6d3dcea5ded820ebc234bb68',
    );
  });
});
