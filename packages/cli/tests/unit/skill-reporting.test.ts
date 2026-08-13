import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAuthorSourceDigest,
  createSkillEvalRunLayout,
  publishEvalRunToBatch,
  publishSkillReviewToBatch,
  refreshSkillReportBatch,
  releasePublishedSkillReview,
  type EvaluationLike,
  type SkillEvalRunLayout,
  type SkillReportOwner,
  type SkillReportSourceIdentity,
} from '../../scripts/skill-reporting.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const tempDirs: string[] = [];
const owner: SkillReportOwner = {
  kind: 'plugin-skill',
  plugin: 'demo-plugin',
  skill: 'demo-skill',
};
const source: SkillReportSourceIdentity = {
  digest: 'sha256:source',
  gitHead: '0123456789abcdef',
  inScopeDirty: false,
};
const environmentDigest = 'sha256:environment';
const modelEnvironmentDigest = 'sha256:model-environment';
const harnessDigest = 'sha256:harness';
const requiredTargets = [
  'materialization/project-default',
  'trigger/trigger/project-default/validation/all',
];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-reporting-'));
  tempDirs.push(root);
  registerCurrentTestWritableStateRoot(root);
  const pluginRoot = path.join(root, 'plugins', 'demo-plugin');
  const skillRoot = path.join(pluginRoot, 'skills', 'demo-skill');
  await fs.ensureDir(skillRoot);
  await fs.writeFile(
    path.join(pluginRoot, 'README.md'),
    '# Demo Plugin\n\nPlugin documentation only.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(skillRoot, 'README.md'),
    [
      '# Demo Skill',
      '',
      'Skill documentation.',
      '',
      '## 最近验证',
      '',
      '- 最近正式报告：暂无。',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# Demo Skill\n', 'utf8');
  return root;
}

async function completeRun(
  layout: SkillEvalRunLayout,
  evaluation: EvaluationLike,
  _completedAt: string,
): Promise<void> {
  await fs.writeJson(path.join(layout.reportRoot, 'summary.json'), evaluation, { spaces: 2 });
  await fs.writeFile(path.join(layout.reportRoot, 'report.md'), '# Eval Run\n', 'utf8');
}

function evaluation(options: {
  generatedAt: string;
  includeTrigger?: boolean;
}): EvaluationLike {
  return {
    generatedAt: options.generatedAt,
    outcome: 'passed',
    complete: true,
    mechanicalPassed: true,
    subjects: [{ profile: 'project-default', scope: 'project' }],
    suites: options.includeTrigger
      ? [{
          id: 'trigger',
          kind: 'trigger',
          profile: 'project-default',
          split: 'validation',
          outcome: 'passed',
          complete: true,
          mechanicalPassed: true,
        }]
      : [],
    diagnostics: [],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fs.remove(root)));
});

describe('Skill report batches', () => {
  it('aggregates runs by target, publishes one summary, and does not modify README files', async () => {
    const repoRoot = await makeRepo();
    const pluginReadmePath = path.join(repoRoot, 'plugins', 'demo-plugin', 'README.md');
    const skillReadmePath = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'skills',
      'demo-skill',
      'README.md',
    );
    const pluginReadme = await fs.readFile(pluginReadmePath, 'utf8');
    const skillReadme = await fs.readFile(skillReadmePath, 'utf8');
    const first = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'release-check',
      runId: '20260812T010000Z-00000001',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const firstEvaluation = evaluation({ generatedAt: '2026-08-12T01:01:00.000Z' });
    await completeRun(first, firstEvaluation, '2026-08-12T01:01:00.000Z');
    const firstSummary = await publishEvalRunToBatch({
      repoRoot,
      layout: first,
      evaluation: firstEvaluation,
      requiredTargets,
    });
    expect(firstSummary.eval).toMatchObject({
      runCount: 1,
      releaseCovered: 1,
      releaseRequired: 2,
      releaseOutcome: 'incomplete',
    });
    expect(first.batchRoot).toBe(path.join(
      repoRoot,
      '.tmp',
      'agent-workflows',
      'evals',
      'plugin',
      'demo-plugin',
      'demo-skill',
      first.batchId,
    ));
    await expect(fs.pathExists(path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
    ))).resolves.toBe(false);

    const second = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      runId: '20260812T010200Z-00000002',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const secondEvaluation = evaluation({
      generatedAt: '2026-08-12T01:03:00.000Z',
      includeTrigger: true,
    });
    await completeRun(second, secondEvaluation, '2026-08-12T01:03:00.000Z');
    const secondSummary = await publishEvalRunToBatch({
      repoRoot,
      layout: second,
      evaluation: secondEvaluation,
      requiredTargets,
    });
    expect(secondSummary.eval).toMatchObject({
      runCount: 2,
      targetCount: 2,
      attemptCount: 3,
      releaseCovered: 2,
      releaseRequired: 2,
      releaseOutcome: 'passed',
    });
    expect(secondSummary.eval.runs.map((run) => run.runId)).toEqual([
      first.runId,
      second.runId,
    ]);
    await expect(fs.pathExists(path.join(
      first.batchRoot,
      'evals',
      'trigger',
      'trigger',
      'project-default',
      'validation',
      'all',
      second.runId,
      'report.md',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(first.batchRoot, 'summary.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(first.batchRoot, 'report.md'))).resolves.toBe(true);

    const published = await publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchId: first.batchId,
      reviewId: '20260812T010400Z-00000003',
      source,
      report: '# Review\n',
      scorecard: {
        review: { mode: 'release' },
        findings: [
          { severity: 'P2' },
          { severity: 'Advisory' },
        ],
      },
      calculated: {
        mode: 'release',
        weightedScore: 92,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    });
    expect(published).toEqual(expect.objectContaining({
      schemaVersion: 2,
      batchId: first.batchId,
      name: 'release-check',
      owner,
      source: {
        commits: [source.gitHead],
        inScopeDirty: false,
      },
      eval: {
        releaseOutcome: 'passed',
        covered: 2,
        required: 2,
      },
      review: expect.objectContaining({
        reviewId: '20260812T010400Z-00000003',
        mode: 'release',
        verdict: 'pass',
        weightedScore: 92,
        coveragePercent: 100,
        confidence: 'high',
        findings: { p0: 0, p1: 0, p2: 1, advisory: 1 },
      }),
      reportPath: 'report.md',
    }));
    const publishedRoot = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
      first.batchId,
    );
    await expect(fs.readdir(publishedRoot)).resolves.toEqual(['report.md', 'summary.json']);
    await expect(fs.readFile(path.join(publishedRoot, 'report.md'), 'utf8'))
      .resolves.toBe('# Review\n');
    await expect(fs.readJson(path.join(publishedRoot, 'summary.json')))
      .resolves.toEqual(published);
    await expect(fs.pathExists(path.join(
      first.batchRoot,
      'reviews',
      'release',
      '20260812T010400Z-00000003',
      'scorecard.json',
    ))).resolves.toBe(true);
    await expect(fs.readJson(path.join(first.batchRoot, 'batch.json'))).resolves.toMatchObject({
      status: 'sealed',
    });
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow('already published');

    await expect(fs.readFile(pluginReadmePath, 'utf8')).resolves.toBe(pluginReadme);
    await expect(fs.readFile(skillReadmePath, 'utf8')).resolves.toBe(skillReadme);
  });

  it('releases an existing full review to Skill README without changing the formal report', async () => {
    const repoRoot = await makeRepo();
    const readmePath = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'skills',
      'demo-skill',
      'README.md',
    );
    const originalReadme = await fs.readFile(readmePath, 'utf8');
    const published = await publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchName: 'full-review',
      reviewId: '20260812T010500Z-00000004',
      source,
      report: '# Full Review\n',
      scorecard: { review: { mode: 'full' }, findings: [] },
      calculated: {
        mode: 'full',
        weightedScore: 84.5,
        coverage: 100,
        confidence: 'high',
        release: 'pass-after-fixes',
      },
    });
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toBe(originalReadme);
    const formalReportPath = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
      published.batchId,
      'report.md',
    );
    const formalReport = await fs.readFile(formalReportPath, 'utf8');

    const released = await releasePublishedSkillReview({
      repoRoot,
      owner,
      batchId: published.batchId,
    });
    expect(released).toMatchObject({
      changed: true,
      sourceChanged: true,
      pluginReleaseIntentMayBeRequired: true,
      readmePath: 'plugins/demo-plugin/skills/demo-skill/README.md',
      reportPath: `plugins/demo-plugin/reports/demo-skill/${published.batchId}/report.md`,
    });
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      '- 最近正式报告：`full`，结论 `pass-after-fixes`，加权分 `84.5`',
    );
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      `plugins/demo-plugin/reports/demo-skill/${published.batchId}/report.md`,
    );
    await expect(fs.readFile(formalReportPath, 'utf8')).resolves.toBe(formalReport);

    await expect(releasePublishedSkillReview({
      repoRoot,
      owner,
      batchId: published.batchId,
    })).resolves.toMatchObject({ changed: false, sourceChanged: false });
  });

  it('does not release a quick or delta report to Skill README', async () => {
    const repoRoot = await makeRepo();
    const published = await publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchName: 'delta-review',
      source,
      report: '# Delta Review\n',
      scorecard: { review: { mode: 'delta' }, findings: [] },
      calculated: {
        mode: 'delta',
        weightedScore: null,
        coverage: 50,
        confidence: 'medium',
        release: 'provisional',
      },
    });
    await expect(releasePublishedSkillReview({
      repoRoot,
      owner,
      batchId: published.batchId,
    })).rejects.toThrow('Only a published full or release review');
  });

  it('retries incomplete targets while preserving every attempt', async () => {
    const repoRoot = await makeRepo();
    const first = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'retry-incomplete',
      runId: '20260812T011000Z-00000011',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const incomplete: EvaluationLike = {
      ...evaluation({ generatedAt: '2026-08-12T01:11:00.000Z', includeTrigger: true }),
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      suites: [{
        id: 'trigger',
        kind: 'trigger',
        profile: 'project-default',
        split: 'validation',
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: false,
      }],
    };
    await completeRun(first, incomplete, '2026-08-12T01:11:00.000Z');
    const firstSummary = await publishEvalRunToBatch({
      repoRoot,
      layout: first,
      evaluation: incomplete,
      requiredTargets,
    });
    expect(firstSummary.eval.releaseOutcome).toBe('incomplete');

    const retry = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      runId: '20260812T011200Z-00000012',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const passed = evaluation({
      generatedAt: '2026-08-12T01:13:00.000Z',
      includeTrigger: true,
    });
    await completeRun(retry, passed, '2026-08-12T01:13:00.000Z');
    const retriedSummary = await publishEvalRunToBatch({
      repoRoot,
      layout: retry,
      evaluation: passed,
      requiredTargets,
    });
    expect(retriedSummary.eval).toMatchObject({
      targetCount: 2,
      attemptCount: 4,
      releaseCovered: 2,
      releaseOutcome: 'passed',
      complete: true,
      mechanicalPassed: true,
    });
    expect(retriedSummary.eval.targetAttempts.filter((attempt) =>
      attempt.target === 'trigger/trigger/project-default/validation/all')).toHaveLength(2);
    expect(retriedSummary.eval.targets.find((target) =>
      target.target === 'trigger/trigger/project-default/validation/all')).toMatchObject({
      runId: retry.runId,
      outcome: 'passed',
      complete: true,
    });
  });

  it('composes complete command cases and does not let an interrupted run poison release', async () => {
    const repoRoot = await makeRepo();
    const commandRequiredTargets = [
      'materialization/project-default',
      'command/routing/project-default/all/all',
    ];
    const targetCompositions = {
      'command/routing/project-default/all/all': [
        'command/routing/project-default/all/case_a',
        'command/routing/project-default/all/case_b',
      ],
    };
    const interrupted = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'compose-cases',
      runId: '20260812T012000Z-00000013',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets: commandRequiredTargets,
      targetCompositions,
    });
    await fs.writeJson(path.join(interrupted.reportRoot, 'run.json'), {
      schemaVersion: 1,
      runId: interrupted.runId,
      status: 'failed',
      completedAt: '2026-08-12T01:21:00.000Z',
    }, { spaces: 2 });

    const fullRun = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: interrupted.batchId,
      runId: '20260812T012200Z-00000014',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets: commandRequiredTargets,
      targetCompositions,
    });
    const partialFullEvaluation: EvaluationLike = {
      generatedAt: '2026-08-12T01:22:30.000Z',
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      subjects: [{ profile: 'project-default', scope: 'project' }],
      suites: [{
        id: 'routing',
        kind: 'command',
        profile: 'project-default',
        split: null,
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: false,
        caseResults: [
          { id: 'case_a', outcome: 'passed', complete: true, mechanicalPassed: true },
          { id: 'case_b', outcome: 'incomplete', complete: false, mechanicalPassed: false },
        ],
      }],
      diagnostics: [],
    };
    await completeRun(fullRun, partialFullEvaluation, partialFullEvaluation.generatedAt);
    const partialSummary = await publishEvalRunToBatch({
      repoRoot,
      layout: fullRun,
      evaluation: partialFullEvaluation,
      requiredTargets: commandRequiredTargets,
    });
    expect(partialSummary.eval.releaseOutcome).toBe('incomplete');
    expect(partialSummary.eval.targets.find((target) =>
      target.target === 'command/routing/project-default/all/case_a')).toMatchObject({
      outcome: 'passed',
      complete: true,
    });

    const retry = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: interrupted.batchId,
      runId: '20260812T012300Z-00000015',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets: commandRequiredTargets,
      targetCompositions,
    });
    const retryEvaluation: EvaluationLike = {
      generatedAt: '2026-08-12T01:23:30.000Z',
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: true,
      subjects: [{ profile: 'project-default', scope: 'project' }],
      suites: [{
        id: 'routing',
        kind: 'command',
        profile: 'project-default',
        split: null,
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
      }],
      diagnostics: ['--case selected a debug subset of suite cases.'],
    };
    await completeRun(retry, retryEvaluation, retryEvaluation.generatedAt);
    const summary = await publishEvalRunToBatch({
      repoRoot,
      layout: retry,
      evaluation: retryEvaluation,
      caseId: 'case_b',
      requiredTargets: commandRequiredTargets,
    });
    expect(summary.eval).toMatchObject({
      releaseCovered: 2,
      releaseRequired: 2,
      releaseOutcome: 'passed',
      complete: true,
      mechanicalPassed: true,
    });
    expect(summary.diagnostics).toContain(
      `Eval run ${interrupted.runId} failed before publication.`,
    );
    const composed = summary.eval.targets.find((target) =>
      target.target === 'command/routing/project-default/all/all');
    expect(composed).toMatchObject({
      outcome: 'passed',
      complete: true,
      mechanicalPassed: true,
      requiredForRelease: true,
      summary: {
        composition: [
          { target: 'command/routing/project-default/all/case_a' },
          { target: 'command/routing/project-default/all/case_b' },
        ],
      },
    });
  });

  it('rejects a changed materialized subject before publishing an append', async () => {
    const repoRoot = await makeRepo();
    const first = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'subject-contract',
      runId: '20260812T013000Z-00000016',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const initial: EvaluationLike = {
      ...evaluation({ generatedAt: '2026-08-12T01:31:00.000Z' }),
      subjects: [{ profile: 'project-default', scope: 'project', contentDigest: 'sha256:a' }],
    };
    await completeRun(first, initial, initial.generatedAt);
    await publishEvalRunToBatch({ repoRoot, layout: first, evaluation: initial, requiredTargets });

    const append = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      runId: '20260812T013200Z-00000017',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const changed: EvaluationLike = {
      ...evaluation({ generatedAt: '2026-08-12T01:33:00.000Z' }),
      subjects: [{ profile: 'project-default', scope: 'project', contentDigest: 'sha256:b' }],
    };
    await completeRun(append, changed, changed.generatedAt);
    await expect(publishEvalRunToBatch({
      repoRoot,
      layout: append,
      evaluation: changed,
      requiredTargets,
    })).rejects.toThrow('Materialized subject differs from earlier batch evidence');
  });

  it('records a failed invocation as the latest completed eval', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'failed-run',
      runId: '20260812T020000Z-00000004',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    await fs.writeJson(path.join(layout.reportRoot, 'run.json'), {
      schemaVersion: 1,
      runId: layout.runId,
      status: 'failed',
      completedAt: '2026-08-12T02:01:00.000Z',
    }, { spaces: 2 });
    const summary = await refreshSkillReportBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
    });
    expect(summary.eval).toMatchObject({
      runCount: 1,
      outcome: 'failed',
      complete: false,
      mechanicalPassed: false,
      releaseOutcome: 'incomplete',
    });
    expect(summary.diagnostics).toContain(
      `Eval run ${layout.runId} failed before publication.`,
    );
    await expect(fs.readFile(
      path.join(repoRoot, 'plugins', 'demo-plugin', 'skills', 'demo-skill', 'README.md'),
      'utf8',
    )).resolves.toContain('- 最近正式报告：暂无。');
  });

  it('rejects incompatible appends and duplicate suite targets before publishing target files', async () => {
    const repoRoot = await makeRepo();
    const first = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'append-contract',
      runId: '20260812T030000Z-00000005',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const firstEvaluation = evaluation({
      generatedAt: '2026-08-12T03:01:00.000Z',
      includeTrigger: true,
    });
    await completeRun(first, firstEvaluation, '2026-08-12T03:01:00.000Z');
    await publishEvalRunToBatch({
      repoRoot,
      layout: first,
      evaluation: firstEvaluation,
      requiredTargets,
    });

    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source: { ...source, digest: 'sha256:different' },
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow('different source digest');
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest: 'sha256:different',
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow('different materialization environment');
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets: ['materialization/project-default'],
    })).rejects.toThrow('different release target contract');
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
      targetCompositions: {
        'trigger/trigger/project-default/validation/all': [
          'trigger/trigger/project-default/validation/case_a',
        ],
      },
    })).rejects.toThrow('different release composition contract');
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest,
      modelEnvironmentDigest: 'sha256:different-model',
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow('different model environment');
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest: 'sha256:different-harness',
      requiredTargets,
    })).rejects.toThrow('different eval harness');

    const duplicate = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: first.batchId,
      runId: '20260812T030200Z-00000006',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const duplicateEvaluation = evaluation({
      generatedAt: '2026-08-12T03:03:00.000Z',
      includeTrigger: true,
    });
    await completeRun(duplicate, duplicateEvaluation, '2026-08-12T03:03:00.000Z');
    await expect(publishEvalRunToBatch({
      repoRoot,
      layout: duplicate,
      evaluation: duplicateEvaluation,
      requiredTargets,
    })).rejects.toThrow('Eval target already has terminal evidence in this batch');
    await expect(fs.pathExists(path.join(
      first.batchRoot,
      'evals',
      'materialization',
      'project-default',
      duplicate.runId,
    ))).resolves.toBe(false);
  });

  it('upgrades a materialize-only batch to one fixed model environment', async () => {
    const repoRoot = await makeRepo();
    const materialization = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'materialize-then-model',
      runId: '20260812T033000Z-00000009',
      source,
      environmentDigest,
      modelEnvironmentDigest: null,
      harnessDigest,
      requiredTargets,
    });
    const materializationEvaluation = evaluation({
      generatedAt: '2026-08-12T03:31:00.000Z',
    });
    await completeRun(materialization, materializationEvaluation, '2026-08-12T03:31:00.000Z');
    await publishEvalRunToBatch({
      repoRoot,
      layout: materialization,
      evaluation: materializationEvaluation,
      requiredTargets,
    });

    const modelRun = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: materialization.batchId,
      runId: '20260812T033200Z-0000000a',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    await expect(fs.readJson(path.join(modelRun.batchRoot, 'batch.json'))).resolves.toMatchObject({
      modelEnvironmentDigest,
    });
  });

  it('does not persist invalid ids or fix a model environment before run reservation', async () => {
    const repoRoot = await makeRepo();
    const reportRoot = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
    );
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'invalid-run-id',
      runId: 'invalid',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow('--run-id must use');
    await expect(fs.pathExists(reportRoot)).resolves.toBe(false);

    const materialization = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'reserve-before-model',
      runId: '20260812T033400Z-0000000d',
      source,
      environmentDigest,
      modelEnvironmentDigest: null,
      harnessDigest,
      requiredTargets,
    });
    await expect(createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchId: materialization.batchId,
      runId: materialization.runId,
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    })).rejects.toThrow();
    await expect(fs.readJson(path.join(materialization.batchRoot, 'batch.json'))).resolves.toMatchObject({
      modelEnvironmentDigest: null,
    });
  });

  it('rejects a published report root symlink without blocking temporary eval evidence', async () => {
    const repoRoot = await makeRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-report-outside-'));
    tempDirs.push(outside);
    const pluginRoot = path.join(repoRoot, 'plugins', 'demo-plugin');
    await fs.symlink(outside, path.join(pluginRoot, 'reports'));

    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'symlink-report-root',
      runId: '20260812T033500Z-0000000e',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const result = evaluation({ generatedAt: '2026-08-12T03:35:30.000Z' });
    await completeRun(layout, result, result.generatedAt);
    await publishEvalRunToBatch({
      repoRoot,
      layout,
      evaluation: result,
      requiredTargets,
    });
    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
      source,
      report: '# Review\n',
      scorecard: { review: { mode: 'release' }, findings: [] },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('cannot contain a symbolic link');
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('rejects unsafe target segments before writing outside the batch', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'safe-targets',
      runId: '20260812T033300Z-0000000b',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const unsafeEvaluation = evaluation({
      generatedAt: '2026-08-12T03:34:00.000Z',
      includeTrigger: true,
    });
    await completeRun(layout, unsafeEvaluation, '2026-08-12T03:34:00.000Z');
    await expect(publishEvalRunToBatch({
      repoRoot,
      layout,
      evaluation: unsafeEvaluation,
      caseId: '../../../../escaped',
      requiredTargets,
    })).rejects.toThrow('safe report path segment');
    await expect(fs.pathExists(path.join(repoRoot, 'escaped'))).resolves.toBe(false);
  });

  it('does not publish or seal a review while an eval is running', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'running-eval',
      runId: '20260812T040000Z-00000007',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    await fs.writeJson(path.join(layout.reportRoot, 'run.json'), {
      schemaVersion: 1,
      runId: layout.runId,
      status: 'running',
      startedAt: '2026-08-12T04:00:00.000Z',
    }, { spaces: 2 });
    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
      source,
      report: '# Review\n',
      scorecard: { review: { mode: 'release' } },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('still has a running eval');
    await expect(fs.pathExists(path.join(layout.batchRoot, 'reviews'))).resolves.toBe(false);
    await expect(fs.readJson(path.join(layout.batchRoot, 'batch.json'))).resolves.toMatchObject({
      status: 'open',
    });
  });

  it('recovers a local run whose process no longer exists', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'interrupted-eval',
      runId: '20260812T043000Z-0000000c',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    await fs.writeJson(path.join(layout.reportRoot, 'run.json'), {
      schemaVersion: 1,
      runId: layout.runId,
      status: 'running',
      startedAt: layout.startedAt,
      pid: 2_147_483_647,
      host: layout.host,
    }, { spaces: 2 });
    const summary = await refreshSkillReportBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
    });
    expect(summary.eval.runs).toEqual([
      expect.objectContaining({ runId: layout.runId, status: 'failed', outcome: 'failed' }),
    ]);
  });

  it('keeps review-only eval evidence explicitly not run', async () => {
    const repoRoot = await makeRepo();
    const summary = await publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchName: 'review-only',
      reviewId: '20260812T050000Z-00000008',
      source,
      report: '# Review\n',
      scorecard: { review: { mode: 'release' } },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    });
    expect(summary.eval).toEqual({ releaseOutcome: 'not_run', covered: 0, required: 0 });
    await expect(fs.readdir(path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
      summary.batchId,
    ))).resolves.toEqual(['report.md', 'summary.json']);
    await expect(fs.readJson(path.join(
      repoRoot,
      '.tmp',
      'agent-workflows',
      'evals',
      'plugin',
      'demo-plugin',
      'demo-skill',
      summary.batchId,
      'evals',
      'evaluation.json',
    ))).resolves.toMatchObject({
      outcome: 'not_run',
      complete: false,
      mechanicalPassed: false,
    });
  });

  it('publishes the same compact contract for a static Skill and preserves source commits', async () => {
    const repoRoot = await makeRepo();
    const staticOwner: SkillReportOwner = { kind: 'static-skill', skill: 'static-demo' };
    const staticRoot = path.join(repoRoot, '.agents', 'skills', 'static-demo');
    await fs.ensureDir(staticRoot);
    await fs.writeFile(path.join(staticRoot, 'SKILL.md'), '# Static Demo\n', 'utf8');
    await fs.writeFile(path.join(staticRoot, 'README.md'), '# Static Demo\n', 'utf8');
    const staticSource: SkillReportSourceIdentity = {
      digest: 'sha256:static-source',
      gitHead: 'cccccccccccccccc',
      gitHeads: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      inScopeDirty: true,
    };
    const summary = await publishSkillReviewToBatch({
      repoRoot,
      owner: staticOwner,
      batchName: 'static-review',
      reviewId: '20260812T051000Z-00000009',
      source: staticSource,
      report: '# Static Review\n',
      scorecard: {
        review: { mode: 'quick' },
        findings: [
          { severity: 'P0' },
          { severity: 'P1' },
          { severity: 'P2' },
          { severity: 'Advisory' },
        ],
      },
      calculated: {
        mode: 'quick',
        weightedScore: null,
        coverage: null,
        confidence: null,
        release: 'provisional',
      },
    });
    expect(summary).toMatchObject({
      owner: staticOwner,
      source: {
        commits: [
          'aaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbb',
          'cccccccccccccccc',
        ],
        inScopeDirty: true,
      },
      eval: { releaseOutcome: 'not_run', covered: 0, required: 0 },
      review: {
        mode: 'quick',
        verdict: 'provisional',
        weightedScore: null,
        coveragePercent: null,
        confidence: null,
        findings: { p0: 1, p1: 1, p2: 1, advisory: 1 },
      },
    });
    await expect(fs.readdir(path.join(
      repoRoot,
      '.agents',
      'reports',
      'static-demo',
      summary.batchId,
    ))).resolves.toEqual(['report.md', 'summary.json']);
    await expect(fs.pathExists(path.join(
      repoRoot,
      '.tmp',
      'agent-workflows',
      'evals',
      'static',
      'static-demo',
      summary.batchId,
      'batch.json',
    ))).resolves.toBe(true);
  });

  it('rejects an empty review before allocating a batch', async () => {
    const repoRoot = await makeRepo();
    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchName: 'empty-review',
      source,
      report: ' \n',
      scorecard: { review: { mode: 'release' }, findings: [] },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('must not be empty');
    await expect(fs.pathExists(path.join(
      repoRoot,
      '.tmp',
      'agent-workflows',
      'evals',
      'plugin',
      'demo-plugin',
      'demo-skill',
    ))).resolves.toBe(false);
  });

  it('does not overwrite an existing formal report or seal the temporary batch', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'published-collision',
      runId: '20260812T052000Z-0000000a',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const result = evaluation({ generatedAt: '2026-08-12T05:21:00.000Z' });
    await completeRun(layout, result, result.generatedAt);
    await publishEvalRunToBatch({
      repoRoot,
      layout,
      evaluation: result,
      requiredTargets,
    });
    const publishedRoot = path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
      layout.batchId,
    );
    await fs.ensureDir(publishedRoot);
    await fs.writeFile(path.join(publishedRoot, 'report.md'), '# Existing\n', 'utf8');
    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
      source,
      report: '# Replacement\n',
      scorecard: { review: { mode: 'release' }, findings: [] },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('already published');
    await expect(fs.readFile(path.join(publishedRoot, 'report.md'), 'utf8'))
      .resolves.toBe('# Existing\n');
    await expect(fs.readJson(path.join(layout.batchRoot, 'batch.json'))).resolves.toMatchObject({
      status: 'open',
    });
    await expect(fs.pathExists(path.join(layout.batchRoot, 'reviews'))).resolves.toBe(false);
  });

  it('does not remove an existing review when a review id is reused', async () => {
    const repoRoot = await makeRepo();
    const layout = await createSkillEvalRunLayout({
      repoRoot,
      owner,
      batchName: 'review-id-collision',
      runId: '20260812T052100Z-0000000b',
      source,
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
    });
    const result = evaluation({ generatedAt: '2026-08-12T05:22:00.000Z' });
    await completeRun(layout, result, result.generatedAt);
    await publishEvalRunToBatch({
      repoRoot,
      layout,
      evaluation: result,
      requiredTargets,
    });
    const reviewId = '20260812T052200Z-0000000c';
    const reviewRoot = path.join(layout.batchRoot, 'reviews', 'release', reviewId);
    await fs.ensureDir(reviewRoot);
    await fs.writeFile(path.join(reviewRoot, 'sentinel.txt'), 'keep\n', 'utf8');

    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchId: layout.batchId,
      reviewId,
      source,
      report: '# Replacement\n',
      scorecard: { review: { mode: 'release' }, findings: [] },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('already exists in report batch');
    await expect(fs.readFile(path.join(reviewRoot, 'sentinel.txt'), 'utf8'))
      .resolves.toBe('keep\n');
    await expect(fs.readJson(path.join(layout.batchRoot, 'batch.json'))).resolves.toMatchObject({
      status: 'open',
    });
    await expect(fs.pathExists(path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
      layout.batchId,
    ))).resolves.toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'does not add review evidence when formal staging cannot start',
    async () => {
      const repoRoot = await makeRepo();
      const layout = await createSkillEvalRunLayout({
        repoRoot,
        owner,
        batchName: 'formal-staging-failure',
        runId: '20260812T052300Z-0000000d',
        source,
        environmentDigest,
        modelEnvironmentDigest,
        harnessDigest,
        requiredTargets,
      });
      const result = evaluation({ generatedAt: '2026-08-12T05:24:00.000Z' });
      await completeRun(layout, result, result.generatedAt);
      await publishEvalRunToBatch({
        repoRoot,
        layout,
        evaluation: result,
        requiredTargets,
      });
      const reportRoot = path.join(
        repoRoot,
        'plugins',
        'demo-plugin',
        'reports',
        'demo-skill',
      );
      await fs.ensureDir(reportRoot);
      await fs.chmod(reportRoot, 0o500);
      try {
        await expect(publishSkillReviewToBatch({
          repoRoot,
          owner,
          batchId: layout.batchId,
          reviewId: '20260812T052400Z-0000000e',
          source,
          report: '# Review\n',
          scorecard: { review: { mode: 'release' }, findings: [] },
          calculated: {
            mode: 'release',
            weightedScore: 90,
            coverage: 100,
            confidence: 'high',
            release: 'pass',
          },
        })).rejects.toThrow();
      } finally {
        await fs.chmod(reportRoot, 0o700);
      }
      await expect(fs.pathExists(path.join(layout.batchRoot, 'reviews'))).resolves.toBe(false);
      await expect(fs.readJson(path.join(layout.batchRoot, 'summary.json'))).resolves.toMatchObject({
        status: 'open',
        review: null,
      });
      await expect(fs.readJson(path.join(layout.batchRoot, 'batch.json'))).resolves.toMatchObject({
        status: 'open',
      });
    },
  );

  it('validates a review id before creating a review-only batch', async () => {
    const repoRoot = await makeRepo();
    await expect(publishSkillReviewToBatch({
      repoRoot,
      owner,
      batchName: 'invalid-review-id',
      reviewId: 'invalid',
      source,
      report: '# Review\n',
      scorecard: { review: { mode: 'release' } },
      calculated: {
        mode: 'release',
        weightedScore: 90,
        coverage: 100,
        confidence: 'high',
        release: 'pass',
      },
    })).rejects.toThrow('--review-id must use');
    await expect(fs.pathExists(path.join(
      repoRoot,
      'plugins',
      'demo-plugin',
      'reports',
      'demo-skill',
    ))).resolves.toBe(false);
  });

  it('includes README files but excludes report files from the author source digest', async () => {
    const repoRoot = await makeRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'demo-plugin');
    const readmePath = path.join(pluginRoot, 'skills', 'demo-skill', 'README.md');
    const before = await computeAuthorSourceDigest([{ name: 'demo-plugin', root: pluginRoot }]);
    await fs.outputFile(
      path.join(pluginRoot, 'reports', 'demo-skill', 'batch', 'summary.json'),
      '{}\n',
    );
    await expect(computeAuthorSourceDigest([
      { name: 'demo-plugin', root: pluginRoot },
    ])).resolves.toBe(before);
    const readme = await fs.readFile(readmePath, 'utf8');
    await fs.writeFile(
      readmePath,
      readme.replace(
        '- 最近正式报告：暂无。',
        '- 最近正式报告：`some-batch`，结论 `fail`。',
      ),
      'utf8',
    );
    await expect(computeAuthorSourceDigest([
      { name: 'demo-plugin', root: pluginRoot },
    ])).resolves.not.toBe(before);
  });
});
