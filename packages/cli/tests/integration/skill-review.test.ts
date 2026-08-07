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
        expect(report.evals.behavior_cases).toBe(16);
        expect(report.evals.scoring_cases).toBe(5);
        expect(report.scripts.count).toBe(3);
        expect(report.references.missing).toEqual([]);
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
    await fs.ensureDir(path.join(skillRoot, 'references', 'fixture'));
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: wrong-name',
      'description: Review an invalid static Skill fixture.',
      '---',
      '',
      'Read references/missing.md before continuing.',
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
    expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        'frontmatter.directory-name',
        'reference.missing',
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
    expect(JSON.parse(passed.stdout)).toMatchObject({
      score: {
        weighted_score: 100,
        coverage_percent: 100,
        release: 'pass',
      },
      valid: true,
    });

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
  });

  it('keeps evaluated upstream content unchanged outside documented project adapters', async () => {
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'skill-review');
    const exactHashes: Record<string, string> = {
      'assets/report-template.md': '945dcf02599d5d029c8741a200d4e3086c0f180ef1ab4a1a5888a29034b2e900',
      'assets/scorecard-template.json': 'f3d5a76e6433ff4cccf18ee1a6b2966962fd15ef747269e4abe8c78a01718394',
      'evals/behavior_cases.json': '97e25eb610d7340241a5e547cd2e0db6043e80339a61746a0551e8ec1226f3ed',
      'evals/scoring_cases.json': '051eea73afb9ae69997092e9f1b3f2a18a166e2178c45a02a12916a5b29647df',
      'evals/trigger-cases.json': 'a3372fb3665299517d4777bad775452d415202553585011109d3158d07d0168c',
      'references/architecture-boundaries.md': 'ce8bdd8039a4677fcd4b91562456c2d45f886ede8480745c784b63c46f799285',
      'references/delta-review.md': '57615d644f21362a43f758d85fbb758147c78862a2da17542f1e885ed58c6361',
      'references/evals-and-triggering.md': '9a764f102e4f687c8504f1c9af1a4ad7c65b69a04e3cc0322e86d7716af6b81e',
      'references/official-agent-skills-basis.md': 'de97ada70c914ac12c7136cc9365cff131d963e12a08edac3a0003f59981738a',
      'references/review-dimensions.md': '43c53ecfcf26de5523977108e0b726142da8da0105f89940f4089d7e3cce96a3',
      'references/scripts-and-resources.md': '3a3ca84008513249efc072e8c0450fe7d995929cbf8d50a50ff78bead915d83e',
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
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py');
    expect(contentDigest(readme)).toBe(
      'ef56afa6f4eccf1ceef807bf794eab662394f816cacf17870fade9fd185c0ecf',
    );

    const skill = (await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'))
      .replace(
        'compatibility: Requires the agent-workflows repository, Node.js 20+, and installed workspace dependencies.\n',
        '',
      )
      .replace(
        '角色配置、完整技能包或当前 agent-workflows 项目的插件 Skill 时使用',
        '角色配置或完整技能包时使用',
      )
      .replace(
        'node scripts/inspect_skill_target.mjs <skill-dir-or-SKILL.md-or-plugin>',
        'python3 scripts/inspect_skill.py <skill-dir-or-SKILL.md>',
      )
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py')
      .replace(
        '   - 当前仓库的 AW 插件或动态 Skill：`references/agent-workflows-plugin.md`\n',
        '',
      );
    expect(contentDigest(skill)).toBe(
      'cb7bc251f6a2fe5f0ebbff802587d4783755338b80f73332c9289d0fbb7effc0',
    );

    const scoringModel = (
      await fs.readFile(path.join(skillRoot, 'references', 'scoring-model.md'), 'utf8')
    ).replace('validate_scorecard.mjs', 'validate_scorecard.py');
    expect(contentDigest(scoringModel)).toBe(
      'c1dff4c6c8316197c6b2127ff29c7da1c73a54cece5eb58234871ff5aac0a0d7',
    );
  });
});
