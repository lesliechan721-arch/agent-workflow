import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import { readPluginEvalManifest } from './plugin-eval-contract.js';
import {
  computeAuthorSourceDigest,
  publishSkillReviewToBatch,
  releasePublishedSkillReview,
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
  ].join('\n');
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--') continue;
    if (flag === '-h' || flag === '--help') {
      parsed.help = true;
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
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (parsed.help) return parsed;
  if (!parsed.skill || !parsed.report || !parsed.scorecard) throw new Error(usage());
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = resolveRepoRoot();
  const reportPath = resolveReviewDraftPath(repoRoot, parsed.report!);
  const scorecardPath = resolveReviewDraftPath(repoRoot, parsed.scorecard!);
  const owner: SkillReportOwner = parsed.plugin
    ? { kind: 'plugin-skill', plugin: parsed.plugin, skill: parsed.skill! }
    : { kind: 'static-skill', skill: parsed.skill! };
  await assertPublishSkillTarget(repoRoot, owner);
  const roots = await resolveReviewSourceRoots(repoRoot, owner);
  const [report, scorecard, revision, digest] = await Promise.all([
    fs.readFile(reportPath, 'utf8'),
    fs.readJson(scorecardPath),
    sourceRevision(repoRoot, owner),
    computeAuthorSourceDigest(roots),
  ]);
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
    score: {
      weighted_score: number | null;
      coverage_percent: number | null;
      confidence: string | null;
      release: string | null;
    };
  };
  if (!result.valid || !result.review.mode) throw new Error('Scorecard validation failed.');
  assertScorecardSkillName(result.review.skill_name, parsed.skill!);
  const summary = await publishSkillReviewToBatch({
    repoRoot,
    owner,
    batchName: parsed.batchName,
    batchId: parsed.batchId,
    reviewId: parsed.reviewId,
    source: { digest, ...revision },
    report,
    scorecard,
    calculated: {
      mode: result.review.mode,
      weightedScore: result.score.weighted_score,
      coverage: result.score.coverage_percent,
      confidence: result.score.confidence,
      release: result.score.release,
    },
  });
  const reportDir = path.relative(
    repoRoot,
    path.join(resolveSkillReportRoot(repoRoot, owner), summary.batchId),
  ).split(path.sep).join('/');
  let released: Awaited<ReturnType<typeof releasePublishedSkillReview>> | null = null;
  if (result.review.mode === 'release') {
    try {
      released = await releasePublishedSkillReview({
        repoRoot,
        owner,
        batchId: summary.batchId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Review was published and the batch was sealed at ${reportDir}, ` +
          `but Skill README release failed: ${detail}. ` +
          `Retry with pnpm review:release -- --skill ${owner.skill}` +
          `${owner.kind === 'plugin-skill' ? ` --plugin ${owner.plugin}` : ''} ` +
          `--batch-id ${summary.batchId}.`,
      );
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    batchId: summary.batchId,
    reportDir,
    released,
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
