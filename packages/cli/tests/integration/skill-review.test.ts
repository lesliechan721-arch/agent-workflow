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
  assertPublishSkillTarget,
  assertScorecardSkillName,
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

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
  });

  it('materializes static participant Skills without author-only directories', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?participants`);
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-participants-'));
    tempDirs.push(outputRoot);

    const subjectRoot = await runner.prepareSubject({
      participantSkills: ['skill-review', 'create-agent-workflows-plugin'],
      workspace: [],
    }, outputRoot);

    for (const skillName of ['skill-review', 'create-agent-workflows-plugin']) {
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
  });

  it('prepares an isolated authoring subject whose scaffold passes its bundled validator', async () => {
    const runner = await import(`${pathToFileURL(staticEvalRunner()).href}?authoring-subject`);
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-authoring-subject-'));
    tempDirs.push(outputRoot);
    const skillName = 'create-agent-workflows-plugin';
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', skillName);
    const manifest = await runner.readManifest(skillRoot, skillName);
    const subjectRoot = await runner.prepareSubject(manifest, outputRoot);
    const subjectSkillRoot = path.join(subjectRoot, '.agents', 'skills', skillName);

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
    await execFileAsync('node', [
      path.join(subjectSkillRoot, 'scripts', 'init_plugin.mjs'),
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
      path.join(subjectSkillRoot, 'scripts', 'validate_plugin.mjs'),
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
      'codex-explore',
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
    expect(report.source_skills).toHaveLength(1);
    expect(report.source_skills[0].path).toBe('skills/codex-explore/SKILL.md');
    expect(report.eval_manifest).toMatchObject({
      schemaVersion: 2,
      plugin: 'codex-explore',
      skill: 'codex-explore',
    });
    expect(report.eval_manifests).toEqual([
      expect.objectContaining({
        skill: 'codex-explore',
        path: 'skills/codex-explore/evals/manifest.json',
      }),
    ]);
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
    expect(report.final_skills).toHaveLength(5);
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
        expect(report.evals.behavior_cases).toBe(6);
        expect(report.evals.conversation_cases).toBe(6);
        expect(report.evals.portable_behavior_specs).toBe(25);
        expect(report.evals.behavior_evidence_note).toContain('not executable release evidence');
        expect(report.evals.scoring_cases).toBe(11);
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
        env: { ...process.env, CODEX_HOME: sourceCodexHome },
        maxBuffer: 10 * 1024 * 1024,
      });
      const executionReport = JSON.parse(execution.stdout);
      expect(executionReport).toMatchObject({ ok: true, outcome: 'passed' });
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
      'create-agent-workflows-plugin',
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
    for (const key of Object.keys(base.artifacts)) {
      base.artifacts[key] = true;
    }
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
      return scorecard;
    };

    const passedReport = await validate(base);
    expect(passedReport).toMatchObject({
      score: {
        weighted_score: 100,
        quality_band: 'excellent',
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

    const invalidSkillName = structuredClone(base);
    invalidSkillName.review.skill_name = '../wrong-skill';
    expect(await validate(invalidSkillName)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'review.skill-name' }),
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

    const lowQuality = scoreAllWithUnknowns(2.5);
    expect(await validate(lowQuality)).toMatchObject({
      score: {
        weighted_score: 50,
        quality_band: 'poor',
        release: 'pass',
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
        score: {
          weighted_score: score * 20,
          quality_band: qualityBand,
          release: 'pass',
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
      affected_scenario: 'The target client rejects the package before loading the Skill.',
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
      score: {
        release: 'fail',
      },
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

    const weakAuthority = structuredClone(base);
    weakAuthority.review.mode = 'full';
    weakAuthority.findings = [{
      id: 'F-heuristic',
      severity: 'P1',
      evidence_types: ['heuristic'],
      dimension: 'triggering',
      location: 'SKILL.md:1',
      problem: 'A heuristic-only complaint.',
      affected_scenario: 'A future query could fail to load the Skill.',
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
      (dimension: { id: string }) => dimension.id === 'resources',
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
      score: {
        weighted_score: null,
        quality_band: null,
        coverage_percent: 27,
        release: 'provisional',
      },
      valid: true,
    });

    const delta = structuredClone(base);
    delta.review.mode = 'delta';
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
      score: {
        weighted_score: null,
        quality_band: null,
        coverage_percent: 10,
        release: 'pass',
      },
      valid: true,
    });

    const emptyDelta = structuredClone(delta);
    emptyDelta.dimensions = emptyDelta.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: null,
      confidence: 'unknown',
      evidence: [],
    }));
    expect(await validate(emptyDelta)).toMatchObject({
      score: { weighted_score: null, coverage_percent: 0, release: 'provisional' },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'mode.delta-scope' }),
      ]),
    });

    const missingPrevious = structuredClone(delta);
    missingPrevious.artifacts.previous_version = false;
    expect(await validate(missingPrevious)).toMatchObject({
      score: { release: 'provisional' },
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
      score: { weighted_score: null, release: 'provisional' },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dimension.mode-required' }),
      ]),
    });

    const staleSources = structuredClone(base);
    staleSources.artifacts.current_sources_checked = false;
    expect(await validate(staleSources)).toMatchObject({
      score: { release: 'provisional' },
      valid: true,
    });

    const stringArtifact = structuredClone(base);
    stringArtifact.artifacts.current_sources_checked = 'false';
    expect(await validate(stringArtifact)).toMatchObject({
      score: { release: 'provisional' },
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'artifacts.value' }),
      ]),
    });

    const lowConfidence = structuredClone(base);
    for (const dimension of lowConfidence.dimensions) dimension.confidence = 'low';
    expect(await validate(lowConfidence)).toMatchObject({
      score: { confidence: 'low', release: 'provisional' },
      valid: true,
    });

    const missingOptional = structuredClone(base);
    missingOptional.review.mode = 'full';
    missingOptional.findings = undefined;
    missingOptional.unknowns = undefined;
    missingOptional.artifacts = undefined;
    const omittedFields = await validate(missingOptional);
    expect(omittedFields).toMatchObject({ valid: true });
    expect(omittedFields.diagnostics.map(
      (entry: { code: string }) => entry.code,
    )).not.toEqual(expect.arrayContaining([
      'artifacts.type',
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

    for (const [confidences, label] of [
      [[
        'high', 'high', 'high', 'high', 'high', 'low',
        'unknown', 'low', 'high', 'unknown', 'unknown', 'unknown',
      ], 'medium'],
      [[
        'high', 'high', 'high', 'high', 'high', 'high',
        'high', 'low', 'high', 'unknown', 'medium', 'unknown',
      ], 'high'],
    ] as const) {
      const boundary = structuredClone(base);
      boundary.dimensions.forEach((dimension: Record<string, unknown>, index: number) => {
        dimension.confidence = confidences[index];
      });
      expect(await validate(boundary)).toMatchObject({
        score: {
          confidence_index: label === 'medium' ? 0.6 : 0.8,
          confidence: label,
          release: 'pass',
        },
        valid: true,
      });
    }
  });

  it('keeps evaluated upstream content unchanged outside documented project adapters', async () => {
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'skill-review');
    const exactHashes: Record<string, string> = {
      'CHANGELOG.md': 'f380791fdd80918874ddf3ac39bbc42beeb919e81e31314289229a77bfe3a5ca',
      'assets/report-template.md': '89f7045e8174d0a5c2238b1224c2f14c763329324f5ac8d0db4e4c8c42f73111',
      'assets/scorecard-template.json': 'b61488ecef58b49dca4cb8fd86e37b3eb4378f9f1f0f460391cb49d88630ebb4',
      'evals/behavior_cases.json': '72c90f0a3d577487bfd641b45bb1486f5e0aa8699dcc47292cc7c32de97e0053',
      'evals/scoring_cases.json': '031edafd2728e7731169d505390e84f47f3b10c7e7484a6fda4881b214932cdc',
      'evals/trigger-cases.json': 'aff2212cc2b6f73f9203d5193cc5be6e7a20a15c9180096feeca2fee35588b94',
      'references/architecture-boundaries.md': '73546c91c0219892c584c5ff64fd192814eb080137c744b2f72fbcd62119eb15',
      'references/delta-review.md': 'a4827eb63b62f98725821daede648eae27c4fef43c10aae89ee1d981645fb356',
      'references/review-dimensions.md': '5f9ec995612818326925b653fe184391ccb1f502f4c2bf898eeea680858c8a89',
      'references/scripts-and-resources.md': '1f1c30e5201e1bdc8a0728fc0207a002ffb93d2d8c5115c097fbcda09c3ff7b7',
      'references/source-map.md': '48567b80f7f10b4793926016d14a3288135039636d6842db00fd9845f9c2188f',
    };
    for (const [relative, expected] of Object.entries(exactHashes)) {
      expect(contentDigest(await fs.readFile(path.join(skillRoot, relative), 'utf8'))).toBe(expected);
    }
    const reportTemplate = await fs.readFile(
      path.join(skillRoot, 'assets', 'report-template.md'),
      'utf8',
    );
    expect(reportTemplate).toContain('# Skill 评审报告');
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
        'pnpm review:publish -- --skill <skill> [--plugin <plugin>] --batch-id <id> \\\n  --report <report.md> --scorecard <scorecard.json>\n',
        '',
      )
      .replace(
        '\n\n当前仓库静态 Skill 的真实模型 eval 先运行 `pnpm build`，再由 `run_static_skill_evals.mjs` 生成证据；它不是 `plugin:eval` 的别名。\n',
        '\n',
      )
      .replace(
        '\n静态 Skill 的报告保存在 `.agents/reports/<skill>/<batch-id>/`。插件 Skill 的报告保存在 `plugins/<plugin>/reports/<skill>/<batch-id>/`。临时工作目录统一使用项目 `.tmp/agent-workflows/`。\n',
        '',
      )
      .replace(
        '\nSkill README 中的最近 eval/review 摘要、仓库相对报告路径和被评估 Git commit 由作者或 agent 在批次完成后人工更新。程序不写 marker、不自动同步，也不把该段内容作为发布门禁。\n',
        '',
      );
    expect(contentDigest(readme)).toBe(
      'ec3182e53968bb1af37c598c9535c1629e1688843cc56b67d408878f8f6c3963',
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
      )
      .replace(
        '8. release 模式或用户明确要求持久化时，用 `pnpm review:publish -- --skill <skill> [--plugin <plugin>] (--batch-id <id>|--batch-name <name>) --report <report.md> --scorecard <scorecard.json>` 发布；中间草稿只放项目 `.tmp/agent-workflows/reviews/`。\n',
        '',
      )
      .replace(
        '9. 发布后人工更新 Skill README 的最近摘要、报告路径和被评估 Git commit；不要添加机器 marker。\n',
        '',
      )
      .replace(
        '- 需要持久化时，review、eval 引用和 Skill README 已归入正确批次。\n',
        '',
      );
    expect(contentDigest(skill)).toBe(
      '86b37cfb9fb4b031c13246244278fc6f8950a9d11e53c57f9bfb6f6b3e534000',
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
        '7. release 模式未核对 current-check 来源 → `provisional`。\n',
        '',
      );
    expect(contentDigest(scoringModel)).toBe(
      'ffdc996293ea30e6502562acfcb6af7cd2ccbec24ae6c9951404e1ff2d16a468',
    );
  });
});
