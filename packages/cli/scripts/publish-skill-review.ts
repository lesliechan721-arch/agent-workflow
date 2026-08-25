import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import { readPluginEvalManifest } from './plugin-eval-contract.js';
import {
  computeAuthorSourceDigest,
  publishSkillReviewToBatch,
  resolveSkillReportRoot,
  type SkillReportOwner,
} from './skill-reporting.js';

const execFileAsync = promisify(execFile);

interface ParsedArgs {
  help?: boolean;
  plugin?: string;
  skill?: string;
  batchName?: string;
  batchId?: string;
  reviewId?: string;
  report?: string;
  scorecard?: string;
  reviewResult?: string;
  reviewBundle?: string;
  awSummary?: string;
  targetPlan?: string;
  reviewEvidence: Array<{ id: string; result: string; bundle: string }>;
}

export interface ReviewResultDocument {
  schemaVersion: 4;
  mode: 'quick' | 'full' | 'release-quality' | 'delta';
  target: {
    kind: string;
    name: string;
    profile?: string | null;
    digest?: string | null;
  };
  design: string;
  releaseReadiness: string;
  complexity: string;
  composition: string;
  weightedScore: number | null;
  coverage: number;
  confidence: string;
  findings: unknown[];
  unknowns: unknown[];
  gates: Record<string, unknown>;
  actions: string[];
}

export interface AwReviewSummaryDocument {
  schemaVersion: 2;
  target: {
    plugin: string;
    skill: string | null;
    sourceDigest: string;
  };
  targetPlanDigest: string;
  genericReviews: Array<{
    reviewEvidenceId: string;
    targetName: string;
    kind: string;
    profile: string | null;
    digest: string;
    design: string;
    releaseReadiness: string;
  }>;
  projectGates: Record<string, unknown>;
  evalAudit: unknown;
  design: string;
  releaseReadiness: string;
  actions: string[];
}

function usage(): string {
  return [
    'Usage: pnpm review:publish -- --skill <name> [--plugin <name>] [OPTIONS]',
    '',
    'Options:',
    '  --batch-name <name>  Create and publish a review-only batch',
    '  --batch-id <id>      Publish from an open temporary eval batch',
    '  --review-id <id>     Use an explicit review id',
    '  --report <path>      Markdown review draft; relative paths use the repository root',
    '  --scorecard <path>   JSON scorecard draft; relative paths use the repository root',
    '  --review-result <path>  Generic ReviewResult JSON; supports static and plugin Skills',
    '  --review-bundle <path>  Required ReviewInputBundle bound to the ReviewResult',
    '  --aw-summary <path>     Required with --review-result for an AW plugin Skill',
    '  --target-plan <path>    Required AWReviewTargetPlan for an AW plugin Skill',
    '  --review-evidence <id> <result> <bundle>  Add validated evidence for another AW target',
    '',
    'Publishes the report and seals the batch. It does not update the Skill README.',
  ].join('\n');
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { reviewEvidence: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--') continue;
    if (flag === '-h' || flag === '--help') {
      parsed.help = true;
      continue;
    }
    if (flag === '--review-evidence') {
      const id = args[index + 1];
      const result = args[index + 2];
      const bundle = args[index + 3];
      if (!id || !result || !bundle || [id, result, bundle].some((value) => value.startsWith('-'))) {
        throw new Error('--review-evidence requires <id> <result> <bundle>.');
      }
      parsed.reviewEvidence.push({ id, result, bundle });
      index += 3;
      continue;
    }
    const value = optionValue(args, index, flag);
    index += 1;
    if (flag === '--plugin') parsed.plugin = value;
    else if (flag === '--skill') parsed.skill = value;
    else if (flag === '--batch-name') parsed.batchName = value;
    else if (flag === '--batch-id') parsed.batchId = value;
    else if (flag === '--review-id') parsed.reviewId = value;
    else if (flag === '--report') parsed.report = value;
    else if (flag === '--scorecard') parsed.scorecard = value;
    else if (flag === '--review-result') parsed.reviewResult = value;
    else if (flag === '--review-bundle') parsed.reviewBundle = value;
    else if (flag === '--aw-summary') parsed.awSummary = value;
    else if (flag === '--target-plan') parsed.targetPlan = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (parsed.help) return parsed;
  if (!parsed.skill || !parsed.report) throw new Error(usage());
  const legacyInput = parsed.scorecard !== undefined;
  const structuredInput = parsed.reviewResult !== undefined
    || parsed.reviewBundle !== undefined
    || parsed.awSummary !== undefined
    || parsed.targetPlan !== undefined
    || parsed.reviewEvidence.length > 0;
  if (legacyInput === structuredInput) {
    throw new Error(
      'Provide either --scorecard or --review-result.',
    );
  }
  if (structuredInput && !parsed.reviewResult) {
    throw new Error('Structured publication requires --review-result.');
  }
  if (parsed.reviewResult && !parsed.reviewBundle) {
    throw new Error('--review-result requires --review-bundle.');
  }
  if (parsed.plugin && parsed.reviewResult && (!parsed.awSummary || !parsed.targetPlan)) {
    throw new Error('Plugin structured publication requires --aw-summary and --target-plan.');
  }
  if (!parsed.plugin && (parsed.awSummary || parsed.targetPlan)) {
    throw new Error('--aw-summary and --target-plan require --plugin.');
  }
  if (!parsed.plugin && parsed.reviewEvidence.length > 0) {
    throw new Error('--review-evidence requires --plugin.');
  }
  if ((parsed.batchName ? 1 : 0) + (parsed.batchId ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --batch-name or --batch-id.');
  }
  return parsed;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export function resolveReviewDraftPath(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

async function sourceRevision(repoRoot: string, owner: SkillReportOwner): Promise<{
  gitHead: string | null;
  inScopeDirty: boolean;
}> {
  const roots = await resolveReviewSourceRoots(repoRoot, owner);
  try {
    const sourcePaths = roots.map((entry) => path.relative(repoRoot, entry.root));
    const [head, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }),
      execFileAsync('git', [
        'status', '--porcelain=v1', '--', ...sourcePaths,
        ':(exclude)plugins/*/reports/**',
        ':(exclude).agents/reports/**',
      ], { cwd: repoRoot, encoding: 'utf8' }),
    ]);
    return {
      gitHead: head.stdout.trim() || null,
      inScopeDirty: status.stdout.trim() !== '',
    };
  } catch {
    return { gitHead: null, inScopeDirty: true };
  }
}

export async function resolveReviewSourceRoots(
  repoRoot: string,
  owner: SkillReportOwner,
): Promise<Array<{ name: string; root: string }>> {
  if (owner.kind === 'plugin-skill') {
    const ownerRoot = path.join(repoRoot, 'plugins', owner.plugin);
    const evalManifest = path.join(
      ownerRoot,
      'skills',
      owner.skill,
      'evals',
      'manifest.json',
    );
    if (await fs.pathExists(evalManifest)) {
      const manifest = await readPluginEvalManifest(ownerRoot, owner.skill, owner.plugin);
      const pluginNames = [...new Set(manifest.profiles.flatMap((profile) =>
        profile.plugins.map((plugin) => plugin.name)))];
      return pluginNames.map((plugin) => ({
        name: plugin,
        root: path.join(repoRoot, 'plugins', plugin),
      }));
    }
    return [{ name: owner.plugin, root: ownerRoot }];
  }
  const ownerRoot = path.join(repoRoot, '.agents', 'skills', owner.skill);
  const evalManifest = path.join(ownerRoot, 'evals', 'manifest.json');
  if (await fs.pathExists(evalManifest)) {
    const manifest = await fs.readJson(path.join(ownerRoot, 'evals', 'manifest.json')) as {
      suites?: Array<{ skills?: unknown }>;
    };
    const participantSkills = [...new Set([
      owner.skill,
      ...(Array.isArray(manifest.suites) ? manifest.suites.flatMap((suite) =>
        Array.isArray(suite.skills)
          ? suite.skills.filter((skill): skill is string => typeof skill === 'string')
          : []) : []),
    ])];
    if (participantSkills.length > 0) {
      return participantSkills.map((skill) => ({
        name: skill,
        root: path.join(repoRoot, '.agents', 'skills', skill),
      }));
    }
  }
  return [{ name: owner.skill, root: ownerRoot }];
}

export async function assertPublishSkillTarget(
  repoRoot: string,
  owner: SkillReportOwner,
): Promise<void> {
  for (const [label, value] of [
    ['Skill name', owner.skill],
    ...(owner.kind === 'plugin-skill' ? [['Plugin name', owner.plugin]] : []),
  ] as Array<[string, string]>) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
      throw new Error(`${label} must use lowercase kebab-case.`);
    }
  }
  const skillRoot = owner.kind === 'plugin-skill'
    ? path.join(repoRoot, 'plugins', owner.plugin, 'skills', owner.skill)
    : path.join(repoRoot, '.agents', 'skills', owner.skill);
  for (const fileName of ['SKILL.md', 'README.md']) {
    const filePath = path.join(skillRoot, fileName);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Review target is missing ${fileName}: ${skillRoot}.`);
    }
    if ((await fs.readFile(filePath, 'utf8')).trim() === '') {
      throw new Error(`Review target ${fileName} must not be empty: ${skillRoot}.`);
    }
  }
}

export function assertScorecardSkillName(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `Scorecard review.skill_name ${JSON.stringify(actual)} ` +
        `does not match --skill ${JSON.stringify(expected)}.`,
    );
  }
}

export function assertStructuredReviewTarget(
  reviewResult: ReviewResultDocument,
  awSummary: AwReviewSummaryDocument | undefined,
  expectedPlugin: string | undefined,
  expectedSkill: string,
  expectedSourceDigest?: string,
): void {
  if (reviewResult.target.name !== expectedSkill) {
    throw new Error(
      'ReviewResult target.name ' + JSON.stringify(reviewResult.target.name) +
        ' does not match --skill ' + JSON.stringify(expectedSkill) + '.',
    );
  }
  if (!reviewResult.target.digest) throw new Error('ReviewResult target.digest is required.');
  if (!expectedPlugin) {
    if (!['agent-skill', 'repo-skill'].includes(reviewResult.target.kind)) {
      throw new Error('Static structured publication requires an agent-skill or repo-skill target.');
    }
    if (expectedSourceDigest && reviewResult.target.digest !== expectedSourceDigest) {
      throw new Error('ReviewResult target.digest does not match the current source digest.');
    }
    return;
  }
  if (!awSummary) throw new Error('Plugin structured publication requires AWReviewSummary.');
  if (!['aw-plugin-skill', 'materialized-skill'].includes(reviewResult.target.kind)) {
    throw new Error('Plugin structured publication requires an AW plugin Skill target.');
  }
  if (awSummary.target.plugin !== expectedPlugin) {
    throw new Error(
      'AW summary target.plugin ' + JSON.stringify(awSummary.target.plugin) +
        ' does not match --plugin ' + JSON.stringify(expectedPlugin) + '.',
    );
  }
  if (awSummary.target.skill !== null && awSummary.target.skill !== expectedSkill) {
    throw new Error(
      'AW summary target.skill ' + JSON.stringify(awSummary.target.skill) +
        ' does not match --skill ' + JSON.stringify(expectedSkill) + '.',
    );
  }
  if (expectedSourceDigest && awSummary.target.sourceDigest !== expectedSourceDigest) {
    throw new Error('AW summary target.sourceDigest does not match the current source digest.');
  }
  const matchingGenericReview = awSummary.genericReviews.find((entry) =>
    entry.targetName === reviewResult.target.name
    && entry.kind === reviewResult.target.kind
    && entry.profile === (reviewResult.target.profile ?? null)
    && entry.digest === reviewResult.target.digest
    && entry.design === reviewResult.design
    && entry.releaseReadiness === reviewResult.releaseReadiness);
  if (!matchingGenericReview) {
    throw new Error('AW summary genericReviews does not bind the supplied ReviewResult target.');
  }
}

function compatibilityReviewMode(mode: ReviewResultDocument['mode']): string {
  return mode === 'release-quality' ? 'release' : mode;
}

export function buildStructuredReviewPublication(
  reviewResult: ReviewResultDocument,
  awSummary: AwReviewSummaryDocument | undefined,
  expectedPlugin: string | undefined,
  expectedSkill: string,
  expectedSourceDigest?: string,
): {
  scorecard: unknown;
  calculated: {
    mode: string;
    weightedScore: number | null;
    coverage: number;
    confidence: string;
    release: string;
  };
} {
  assertStructuredReviewTarget(
    reviewResult,
    awSummary,
    expectedPlugin,
    expectedSkill,
    expectedSourceDigest,
  );
  const mode = compatibilityReviewMode(reviewResult.mode);
  return {
    calculated: {
      mode,
      weightedScore: reviewResult.weightedScore,
      coverage: reviewResult.coverage,
      confidence: reviewResult.confidence,
      release: awSummary?.releaseReadiness ?? reviewResult.releaseReadiness,
    },
    scorecard: {
      schemaVersion: 'review-result-projection-v1',
      review: {
        skill_name: expectedSkill,
        mode,
      },
      decision: {
        design: awSummary?.design ?? reviewResult.design,
        release_readiness: awSummary?.releaseReadiness ?? reviewResult.releaseReadiness,
      },
      score: {
        weighted_score: reviewResult.weightedScore,
        coverage_percent: reviewResult.coverage,
        confidence: reviewResult.confidence,
      },
      complexity: reviewResult.complexity,
      composition: reviewResult.composition,
      findings: reviewResult.findings,
      unknowns: reviewResult.unknowns,
      gates: {
        generic: reviewResult.gates,
        ...(awSummary ? { aw: awSummary.projectGates } : {}),
      },
    },
  };
}

async function validateReviewResult(
  repoRoot: string,
  valuePath: string,
  bundlePath: string,
): Promise<void> {
  const validator = path.join(
    repoRoot,
    'plugins',
    'agent-skill-toolkit',
    'scripts',
    'validate-review-result.mjs',
  );
  try {
    await execFileAsync(process.execPath, [
      validator,
      valuePath,
      '--bundle',
      bundlePath,
      '--format',
      'json',
    ], { cwd: repoRoot, encoding: 'utf8' });
  } catch (error) {
    const output = error && typeof error === 'object'
      ? String((error as { stdout?: unknown }).stdout ?? '')
      : '';
    throw new Error(
      'ReviewResult validation failed for ' + valuePath + '.' +
        (output ? '\n' + output.trim() : ''),
    );
  }
}

export async function validateAwReviewSummary(
  repoRoot: string,
  pluginRoot: string,
  valuePath: string,
  planPath: string,
  evidence: Array<{ id: string; resultPath: string; bundlePath: string }>,
): Promise<void> {
  const validator = path.join(
    repoRoot,
    'plugins',
    'aw-plugin-development',
    'scripts',
    'validate-aw-review-summary.mjs',
  );
  try {
    const args = [
      validator,
      valuePath,
      '--plan',
      planPath,
      '--plugin-root',
      pluginRoot,
      ...evidence.flatMap((entry) => [
        '--evidence',
        entry.id,
        entry.resultPath,
        entry.bundlePath,
      ]),
      '--format',
      'json',
    ];
    await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    const output = error && typeof error === 'object'
      ? String((error as { stdout?: unknown }).stdout ?? '')
      : '';
    throw new Error('AWReviewSummary validation failed for ' + valuePath + '.' +
      (output ? '\n' + output.trim() : ''));
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = resolveRepoRoot();
  const reportPath = resolveReviewDraftPath(repoRoot, parsed.report!);
  const owner: SkillReportOwner = parsed.plugin
    ? { kind: 'plugin-skill', plugin: parsed.plugin, skill: parsed.skill! }
    : { kind: 'static-skill', skill: parsed.skill! };
  await assertPublishSkillTarget(repoRoot, owner);
  const roots = await resolveReviewSourceRoots(repoRoot, owner);
  const [report, revision, digest] = await Promise.all([
    fs.readFile(reportPath, 'utf8'),
    sourceRevision(repoRoot, owner),
    computeAuthorSourceDigest(roots),
  ]);
  let scorecard: unknown;
  let reviewResult: ReviewResultDocument | undefined;
  let awReviewSummary: AwReviewSummaryDocument | undefined;
  let awReviewTargetPlan: unknown;
  let calculated: {
    mode: string;
    weightedScore: number | null;
    coverage: number | null;
    confidence: string | null;
    release: string | null;
  };

  if (parsed.scorecard) {
    const scorecardPath = resolveReviewDraftPath(repoRoot, parsed.scorecard);
    scorecard = await fs.readJson(scorecardPath);
    const validator = path.join(
      repoRoot,
      '.agents',
      'skills',
      'skill-review',
      'scripts',
      'validate_scorecard.mjs',
    );
    const validation = await execFileAsync(process.execPath, [
      validator,
      scorecardPath,
      '--format',
      'json',
    ], { cwd: repoRoot, encoding: 'utf8' });
    const result = JSON.parse(validation.stdout) as {
      valid: boolean;
      review: { skill_name?: string; mode?: string };
      decision: { release_readiness: string | null };
      score: {
        weighted_score: number | null;
        coverage_percent: number | null;
        confidence: string | null;
      };
    };
    if (!result.valid || !result.review.mode) throw new Error('Scorecard validation failed.');
    assertScorecardSkillName(result.review.skill_name, parsed.skill!);
    calculated = {
      mode: result.review.mode,
      weightedScore: result.score.weighted_score,
      coverage: result.score.coverage_percent,
      confidence: result.score.confidence,
      release: result.decision.release_readiness,
    };
  } else {
    const reviewResultPath = resolveReviewDraftPath(repoRoot, parsed.reviewResult!);
    const reviewBundlePath = resolveReviewDraftPath(repoRoot, parsed.reviewBundle!);
    const awSummaryPath = parsed.awSummary
      ? resolveReviewDraftPath(repoRoot, parsed.awSummary)
      : undefined;
    const targetPlanPath = parsed.targetPlan
      ? resolveReviewDraftPath(repoRoot, parsed.targetPlan)
      : undefined;
    reviewResult = await fs.readJson(reviewResultPath) as ReviewResultDocument;
    awReviewSummary = awSummaryPath
      ? await fs.readJson(awSummaryPath) as AwReviewSummaryDocument
      : undefined;
    if (awReviewSummary && targetPlanPath) {
      const matchingEvidence = awReviewSummary.genericReviews.filter((entry) =>
        entry.targetName === reviewResult!.target.name
        && entry.kind === reviewResult!.target.kind
        && entry.profile === (reviewResult!.target.profile ?? null)
        && entry.digest === reviewResult!.target.digest
        && entry.design === reviewResult!.design
        && entry.releaseReadiness === reviewResult!.releaseReadiness);
      if (matchingEvidence.length !== 1) {
        throw new Error('AW summary must bind the primary ReviewResult to exactly one reviewEvidenceId.');
      }
      await validateAwReviewSummary(
        repoRoot,
        path.join(repoRoot, 'plugins', parsed.plugin!),
        awSummaryPath!,
        targetPlanPath,
        [
          {
            id: matchingEvidence[0]!.reviewEvidenceId,
            resultPath: reviewResultPath,
            bundlePath: reviewBundlePath,
          },
          ...parsed.reviewEvidence.map((entry) => ({
            id: entry.id,
            resultPath: resolveReviewDraftPath(repoRoot, entry.result),
            bundlePath: resolveReviewDraftPath(repoRoot, entry.bundle),
          })),
        ],
      );
      awReviewTargetPlan = await fs.readJson(targetPlanPath);
    } else {
      await validateReviewResult(repoRoot, reviewResultPath, reviewBundlePath);
    }
    const structuredPublication = buildStructuredReviewPublication(
      reviewResult,
      awReviewSummary,
      parsed.plugin,
      parsed.skill!,
      digest,
    );
    calculated = structuredPublication.calculated;
    scorecard = structuredPublication.scorecard;
  }
  const summary = await publishSkillReviewToBatch({
    repoRoot,
    owner,
    batchName: parsed.batchName,
    batchId: parsed.batchId,
    reviewId: parsed.reviewId,
    source: { digest, ...revision },
    report,
    scorecard,
    reviewResult,
    awReviewSummary,
    awReviewTargetPlan,
    calculated,
  });
  const reportDir = path.relative(
    repoRoot,
    path.join(resolveSkillReportRoot(repoRoot, owner), summary.batchId),
  ).split(path.sep).join('/');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    batchId: summary.batchId,
    reportDir,
    summary,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
