import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { acquireProcessLock } from '../src/utils/process-lock.js';

const BATCH_SCHEMA_VERSION = 1 as const;
const PUBLISHED_SUMMARY_SCHEMA_VERSION = 2 as const;
const BATCH_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9](?:[a-z0-9-]{0,47})-[0-9a-f]{8}$/u;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u;

export type SkillReportOwner =
  | { kind: 'plugin-skill'; plugin: string; skill: string }
  | { kind: 'static-skill'; skill: string };

export interface SkillReportSourceIdentity {
  digest: string;
  gitHead: string | null;
  gitHeads?: string[];
  inScopeDirty: boolean;
}

interface SkillReportBatch {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  name: string;
  owner: SkillReportOwner;
  status: 'open' | 'sealed';
  createdAt: string;
  updatedAt: string;
  sealedAt?: string;
  source: SkillReportSourceIdentity;
  environmentDigest: string;
  modelEnvironmentDigest?: string | null;
  harnessDigest?: string;
  requiredTargets: string[];
  targetCompositions?: SkillReportTargetCompositions;
}

export type SkillReportTargetCompositions = Record<string, string[]>;

export interface SkillEvalRunLayout {
  batchId: string;
  batchRoot: string;
  reportBoundaryRoot: string;
  runId: string;
  workRoot: string;
  reportRoot: string;
  rawRoot: string;
  startedAt: string;
  pid: number;
  host: string;
  cleanupWork(): Promise<void>;
}

interface EvaluationSubjectLike {
  profile: string;
  scope: string;
  configDigest?: string;
  bundleDigest?: string;
  contentDigest?: string;
  artifacts?: Array<{ kind: string; key?: string; contentDigest: string }>;
}

interface EvaluationSuiteLike {
  id: string;
  kind: 'trigger' | 'conversation' | 'command';
  profile?: string;
  split?: string | null;
  outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete';
  complete: boolean;
  mechanicalPassed: boolean;
  qualitativeReview?: string;
  reportPath?: string;
  caseResults?: Array<{
    id: string;
    outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete';
    complete: boolean;
    mechanicalPassed: boolean;
    qualitativeReview?: string;
    reportPath?: string;
    sourceRunId?: string;
    reused?: boolean;
    summary?: Record<string, unknown>;
    diagnostics?: string[];
  }>;
  summary?: Record<string, unknown>;
  diagnostics?: string[];
}

export interface EvaluationLike {
  generatedAt: string;
  outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete';
  complete: boolean;
  mechanicalPassed: boolean;
  subjects: EvaluationSubjectLike[];
  suites: EvaluationSuiteLike[];
  diagnostics: string[];
  model?: string | null;
  modelProvider?: string | null;
  codexVersion?: string | null;
}

export interface SkillEvalTargetSummary {
  schemaVersion: 1;
  target: string;
  kind: 'materialization' | 'trigger' | 'conversation' | 'command';
  runId: string;
  generatedAt: string;
  profile: string;
  suite: string | null;
  split: string;
  case: string;
  outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete';
  complete: boolean;
  mechanicalPassed: boolean;
  qualitativeReview: string;
  requiredForRelease: boolean;
  reportPath: string | null;
  summary: Record<string, unknown>;
  diagnostics: string[];
}

type TargetSummary = SkillEvalTargetSummary;

export interface SkillEvalTargetPlan {
  pending: string[];
  reusable: SkillEvalTargetSummary[];
}

interface ReviewSummary {
  mode: string;
  reviewId: string;
  completedAt: string;
  reportPath: string;
  scorecardPath: string;
  weightedScore: number | null;
  coverage: number | null;
  confidence: string | null;
  release: string | null;
}

interface RunSummary {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  completedAt: string | null;
  outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete' | null;
  complete: boolean;
  mechanicalPassed: boolean;
  reportPath: string;
}

interface BatchSummary {
  schemaVersion: 1;
  batchId: string;
  name: string;
  owner: SkillReportOwner;
  status: 'open' | 'sealed';
  createdAt: string;
  updatedAt: string;
  latestCompletedAt: string | null;
  source: SkillReportSourceIdentity;
  eval: {
    runCount: number;
    runs: RunSummary[];
    targetCount: number;
    attemptCount: number;
    outcome: 'passed' | 'failed' | 'needs_review' | 'incomplete' | 'not_run';
    complete: boolean;
    mechanicalPassed: boolean;
    releaseRequired: number;
    releaseCovered: number;
    releaseOutcome: 'passed' | 'failed' | 'needs_review' | 'incomplete' | 'not_run';
    missingTargets: string[];
    targets: TargetSummary[];
    targetAttempts: TargetSummary[];
  };
  review: ReviewSummary | null;
  diagnostics: string[];
}

interface SkillReviewCalculation {
  mode: string;
  weightedScore: number | null;
  coverage: number | null;
  confidence: string | null;
  release: string | null;
}

export interface PublishedSkillReportSummary {
  schemaVersion: typeof PUBLISHED_SUMMARY_SCHEMA_VERSION;
  batchId: string;
  name: string;
  owner: SkillReportOwner;
  publishedAt: string;
  source: {
    commits: string[];
    inScopeDirty: boolean;
  };
  eval: {
    releaseOutcome: BatchSummary['eval']['releaseOutcome'];
    covered: number;
    required: number;
  };
  review: {
    reviewId: string;
    mode: string;
    verdict: string | null;
    weightedScore: number | null;
    coveragePercent: number | null;
    confidence: string | null;
    findings: {
      p0: number;
      p1: number;
      p2: number;
      advisory: number;
    };
  };
  reportPath: 'report.md';
}

function publishedSummaryFromReview(options: {
  batchSummary: BatchSummary;
  reviewId: string;
  publishedAt: string;
  scorecard: unknown;
  calculated: SkillReviewCalculation;
}): PublishedSkillReportSummary {
  const counts = { p0: 0, p1: 0, p2: 0, advisory: 0 };
  if (options.scorecard && typeof options.scorecard === 'object') {
    const findings = (options.scorecard as { findings?: unknown }).findings;
    if (Array.isArray(findings)) {
      for (const finding of findings) {
        const severity = finding && typeof finding === 'object'
          ? (finding as { severity?: unknown }).severity
          : null;
        if (severity === 'P0') counts.p0 += 1;
        else if (severity === 'P1') counts.p1 += 1;
        else if (severity === 'P2') counts.p2 += 1;
        else if (severity === 'Advisory') counts.advisory += 1;
      }
    }
  }
  const commits = [...new Set([
    ...(options.batchSummary.source.gitHeads ?? []),
    ...(options.batchSummary.source.gitHead ? [options.batchSummary.source.gitHead] : []),
  ])];
  return {
    schemaVersion: PUBLISHED_SUMMARY_SCHEMA_VERSION,
    batchId: options.batchSummary.batchId,
    name: options.batchSummary.name,
    owner: options.batchSummary.owner,
    publishedAt: options.publishedAt,
    source: {
      commits,
      inScopeDirty: options.batchSummary.source.inScopeDirty,
    },
    eval: {
      releaseOutcome: options.batchSummary.eval.releaseOutcome,
      covered: options.batchSummary.eval.releaseCovered,
      required: options.batchSummary.eval.releaseRequired,
    },
    review: {
      reviewId: options.reviewId,
      mode: options.calculated.mode,
      verdict: options.calculated.release,
      weightedScore: options.calculated.weightedScore,
      coveragePercent: options.calculated.coverage,
      confidence: options.calculated.confidence,
      findings: counts,
    },
    reportPath: 'report.md',
  };
}

function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function assertSegment(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${label} must use lowercase kebab-case.`);
  }
}

export function createSkillReportBatchId(name: string, date = new Date()): string {
  assertSegment(name, 'Batch name');
  if (name.length > 48) throw new Error('Batch name must contain at most 48 characters.');
  return `${timestampId(date)}-${name}-${randomUUID().slice(0, 8)}`;
}

function validateBatchId(value: string): string {
  if (!BATCH_ID_PATTERN.test(value)) {
    throw new Error(
      '--batch-id must use YYYYMMDDTHHMMSSZ-<kebab-name>-xxxxxxxx.',
    );
  }
  return value;
}

function createRunId(date = new Date()): string {
  return `${timestampId(date)}-${randomUUID().slice(0, 8)}`;
}

function validateRunId(value: string, label = '--run-id'): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYYMMDDTHHMMSSZ-xxxxxxxx.`);
  }
  return value;
}

export function resolveSkillReportRoot(repoRoot: string, owner: SkillReportOwner): string {
  return owner.kind === 'plugin-skill'
    ? path.join(repoRoot, 'plugins', owner.plugin, 'reports', owner.skill)
    : path.join(repoRoot, '.agents', 'reports', owner.skill);
}

export function resolveSkillEvalRoot(repoRoot: string, owner: SkillReportOwner): string {
  return owner.kind === 'plugin-skill'
    ? path.join(
        repoRoot,
        '.tmp',
        'agent-workflows',
        'evals',
        'plugin',
        owner.plugin,
        owner.skill,
      )
    : path.join(
        repoRoot,
        '.tmp',
        'agent-workflows',
        'evals',
        'static',
        owner.skill,
      );
}

async function assertSafeSkillReportPath(repoRoot: string, candidatePath: string): Promise<void> {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Skill report path must stay inside the repository: ${candidate}.`);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats?.isSymbolicLink()) {
      throw new Error(`Skill report path cannot contain a symbolic link: ${current}.`);
    }
  }
}

function ownerKey(owner: SkillReportOwner): string {
  return owner.kind === 'plugin-skill'
    ? `plugin:${owner.plugin}:${owner.skill}`
    : `static:${owner.skill}`;
}

function sameOwner(left: SkillReportOwner, right: SkillReportOwner): boolean {
  return ownerKey(left) === ownerKey(right);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeJson(temporary, value, { spaces: 2 });
  await fs.rename(temporary, filePath);
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, value, 'utf8');
  await fs.rename(temporary, filePath);
}

async function acquireBatchLock(batchRoot: string): Promise<() => Promise<void>> {
  const lease = await acquireProcessLock({
    lockPath: path.join(batchRoot, '.batch.lock'),
    timeoutMs: 30_000,
    pollMs: 50,
  });
  return () => lease.release();
}

async function withBatchLock<T>(batchRoot: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireBatchLock(batchRoot);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function readBatch(batchRoot: string): Promise<SkillReportBatch> {
  const batch = await fs.readJson(path.join(batchRoot, 'batch.json')) as SkillReportBatch;
  if (batch.schemaVersion !== BATCH_SCHEMA_VERSION) {
    throw new Error(`Unsupported report batch schema: ${batch.schemaVersion}.`);
  }
  return batch;
}

function batchNameFromId(batchId: string): string {
  return batchId.replace(/^\d{8}T\d{6}Z-/u, '').replace(/-[0-9a-f]{8}$/u, '');
}

export async function createSkillEvalRunLayout(options: {
  repoRoot: string;
  owner: SkillReportOwner;
  batchName?: string;
  batchId?: string;
  runId?: string;
  source: SkillReportSourceIdentity;
  environmentDigest: string;
  modelEnvironmentDigest?: string | null;
  harnessDigest: string;
  requiredTargets: string[];
  targetCompositions?: SkillReportTargetCompositions;
}): Promise<SkillEvalRunLayout> {
  if ((options.batchName ? 1 : 0) + (options.batchId ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --batch-name or --batch-id.');
  }
  if (options.owner.kind === 'plugin-skill') assertSegment(options.owner.plugin, 'Plugin name');
  assertSegment(options.owner.skill, 'Skill name');
  const requiredTargets = [...new Set(options.requiredTargets)].sort();
  const targetCompositions = normalizeTargetCompositions(
    options.targetCompositions,
    requiredTargets,
  );
  const batchId = options.batchId
    ? validateBatchId(options.batchId)
    : createSkillReportBatchId(options.batchName!);
  const runId = validateRunId(options.runId ?? createRunId());
  const reportRootBase = resolveSkillEvalRoot(options.repoRoot, options.owner);
  const batchRoot = path.join(reportRootBase, batchId);
  const publishedBatchRoot = path.join(
    resolveSkillReportRoot(options.repoRoot, options.owner),
    batchId,
  );
  await assertSafeSkillReportPath(options.repoRoot, batchRoot);
  if (await fs.pathExists(publishedBatchRoot)) {
    throw new Error(`Report batch ${batchId} is already published.`);
  }
  const now = new Date().toISOString();
  if (options.batchName) {
    await fs.ensureDir(reportRootBase);
    await assertSafeSkillReportPath(options.repoRoot, reportRootBase);
    await fs.mkdir(batchRoot);
    await assertSafeSkillReportPath(options.repoRoot, batchRoot);
    const batch: SkillReportBatch = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId,
      name: options.batchName,
      owner: options.owner,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      source: options.source,
      environmentDigest: options.environmentDigest,
      modelEnvironmentDigest: options.modelEnvironmentDigest ?? null,
      harnessDigest: options.harnessDigest,
      requiredTargets,
      targetCompositions,
    };
    await writeJsonAtomic(path.join(batchRoot, 'batch.json'), batch);
  } else if (!(await fs.pathExists(batchRoot))) {
    throw new Error(`Report batch does not exist: ${batchId}.`);
  }

  const reportRoot = path.join(batchRoot, 'evals', 'runs', runId);
  const workRoot = path.join(
    batchRoot,
    'work',
    runId,
  );
  const startedAt = new Date().toISOString();
  const host = hostname();
  await withBatchLock(batchRoot, async () => {
    const batch = await readBatch(batchRoot);
    await recoverInterruptedRunsUnlocked(batchRoot);
    if (!sameOwner(batch.owner, options.owner)) {
      throw new Error(`Report batch ${batchId} belongs to another Skill.`);
    }
    if (batch.status === 'sealed') {
      throw new Error(`Report batch ${batchId} is sealed.`);
    }
    if (batch.source.digest !== options.source.digest) {
      throw new Error(`Report batch ${batchId} uses a different source digest.`);
    }
    if (batch.environmentDigest !== options.environmentDigest) {
      throw new Error(`Report batch ${batchId} uses a different materialization environment.`);
    }
    if (!batch.harnessDigest || batch.harnessDigest !== options.harnessDigest) {
      throw new Error(`Report batch ${batchId} uses a different eval harness.`);
    }
    const modelEnvironmentDigest = options.modelEnvironmentDigest ?? null;
    if (
      modelEnvironmentDigest &&
      batch.modelEnvironmentDigest &&
      batch.modelEnvironmentDigest !== modelEnvironmentDigest
    ) {
      throw new Error(`Report batch ${batchId} uses a different model environment.`);
    }
    if (JSON.stringify(batch.requiredTargets) !== JSON.stringify(requiredTargets)) {
      throw new Error(`Report batch ${batchId} uses a different release target contract.`);
    }
    const batchTargetCompositions = normalizeTargetCompositions(
      batch.targetCompositions,
      batch.requiredTargets,
    );
    if (JSON.stringify(batchTargetCompositions) !== JSON.stringify(targetCompositions)) {
      throw new Error(`Report batch ${batchId} uses a different release composition contract.`);
    }
    await fs.ensureDir(path.dirname(reportRoot));
    await fs.mkdir(reportRoot, { recursive: false });
    try {
      await fs.mkdir(path.join(reportRoot, 'raw'));
      await fs.ensureDir(workRoot);
      await writeJsonAtomic(path.join(reportRoot, 'run.json'), {
        schemaVersion: 1,
        runId,
        status: 'running',
        startedAt,
        pid: process.pid,
        host,
        modelEnvironmentDigest,
      });
      if (modelEnvironmentDigest && !batch.modelEnvironmentDigest) {
        batch.modelEnvironmentDigest = modelEnvironmentDigest;
        batch.updatedAt = startedAt;
        await writeJsonAtomic(path.join(batchRoot, 'batch.json'), batch);
      }
    } catch (error) {
      await Promise.all([fs.remove(reportRoot), fs.remove(workRoot)]);
      throw error;
    }
  });
  return {
    batchId,
    batchRoot,
    reportBoundaryRoot: options.repoRoot,
    runId,
    workRoot,
    reportRoot,
    rawRoot: path.join(reportRoot, 'raw'),
    startedAt,
    pid: process.pid,
    host,
    cleanupWork: () => fs.remove(workRoot),
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      if (relative === 'reports' || relative.startsWith('reports/')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Author source cannot contain a symlink: ${absolute}`);
      }
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await visit(root);
  return files;
}

export async function computeAuthorSourceDigest(
  roots: Array<{ name: string; root: string }>,
): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of [...roots].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(entry.name);
    hash.update('\0');
    for (const relative of await listSourceFiles(entry.root)) {
      const contents = await fs.readFile(path.join(entry.root, relative));
      hash.update(relative);
      hash.update('\0');
      hash.update(contents);
      hash.update('\0');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

export function createEnvironmentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function pluginReleaseTargets(manifest: {
  profiles: Array<{ id: string; requiredForRelease: boolean }>;
  suites: Array<{
    id: string;
    kind: string;
    profiles: string[];
    releaseSplits: string[];
    requiredForRelease: boolean;
  }>;
}): string[] {
  const targets = manifest.profiles
    .filter((profile) => profile.requiredForRelease)
    .map((profile) => `materialization/${profile.id}`);
  for (const suite of manifest.suites.filter((entry) => entry.requiredForRelease)) {
    for (const profile of suite.profiles) {
      for (const split of suite.releaseSplits.length > 0 ? suite.releaseSplits : ['all']) {
        targets.push(`${suite.kind}/${suite.id}/${profile}/${split}/all`);
      }
    }
  }
  return [...new Set(targets)].sort();
}

export function staticReleaseTargets(manifest: {
  suites: Array<{
    id: string;
    kind: string;
    releaseSplits: string[];
    requiredForRelease: boolean;
  }>;
}): string[] {
  const targets = ['materialization/project-default'];
  for (const suite of manifest.suites.filter((entry) => entry.requiredForRelease)) {
    for (const split of suite.releaseSplits.length > 0 ? suite.releaseSplits : ['all']) {
      targets.push(`${suite.kind}/${suite.id}/project-default/${split}/all`);
    }
  }
  return targets.sort();
}

export function validateSkillReportTargetSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`${label} must be one safe report path segment.`);
  }
  return value;
}

function validateTarget(value: string, label: string): string {
  const parts = value.split('/');
  if (parts.length === 0) throw new Error(`${label} must be a report target.`);
  return parts.map((part, index) =>
    validateSkillReportTargetSegment(part, `${label} segment ${index + 1}`)).join('/');
}

function normalizeTargetCompositions(
  value: SkillReportTargetCompositions | undefined,
  requiredTargets: readonly string[],
): SkillReportTargetCompositions {
  const required = new Set(requiredTargets);
  const normalized: SkillReportTargetCompositions = {};
  for (const target of Object.keys(value ?? {}).sort()) {
    const normalizedTarget = validateTarget(target, 'Composition target');
    if (!required.has(normalizedTarget)) {
      throw new Error(`Composition target is not required for release: ${normalizedTarget}.`);
    }
    const components = value?.[target];
    if (!Array.isArray(components) || components.length === 0) {
      throw new Error(`Composition target ${normalizedTarget} must have components.`);
    }
    const normalizedComponents = [...new Set(components.map((component, index) =>
      validateTarget(component, `Composition target ${normalizedTarget} component ${index + 1}`)))].sort();
    if (normalizedComponents.includes(normalizedTarget)) {
      throw new Error(`Composition target cannot include itself: ${normalizedTarget}.`);
    }
    normalized[normalizedTarget] = normalizedComponents;
  }
  return normalized;
}

export function createSkillEvalTargetKey(
  parts: Array<string | null | undefined>,
): string {
  return parts.map((part, index) => validateSkillReportTargetSegment(
    part || 'all',
    `Eval target segment ${index + 1}`,
  )).join('/');
}

const targetKey = createSkillEvalTargetKey;

async function writeTargetReport(options: {
  batchRoot: string;
  summary: TargetSummary;
  allowExistingMaterialization?: boolean;
  allowDuplicate?: boolean;
}): Promise<void> {
  const evalRoot = path.resolve(options.batchRoot, 'evals');
  const parent = path.resolve(evalRoot, options.summary.target);
  const relativeParent = path.relative(evalRoot, parent);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(`Eval target escapes the report batch: ${options.summary.target}.`);
  }
  if (await fs.pathExists(parent)) {
    const existing = await fs.readdir(parent);
    if (!options.allowExistingMaterialization && !options.allowDuplicate && existing.length > 0) {
      throw new Error(`Eval target already exists in this batch: ${options.summary.target}.`);
    }
  }
  const root = path.join(parent, options.summary.runId);
  if (await fs.pathExists(root)) {
    if (options.allowExistingMaterialization) {
      const current = await fs.readJson(path.join(root, 'summary.json')) as TargetSummary;
      if (
        current.kind === 'materialization' &&
        options.summary.kind === 'materialization' &&
        current.target === options.summary.target &&
        current.profile === options.summary.profile &&
        stableJson(current.summary) === stableJson(options.summary.summary)
      ) return;
    }
    throw new Error(
      `Eval target attempt already exists for run ${options.summary.runId}: ` +
      options.summary.target,
    );
  }
  const markdown = [
    '# Eval Target Report',
    '',
    `- Target: \`${options.summary.target}\``,
    `- Run: \`${options.summary.runId}\``,
    `- Outcome: \`${options.summary.outcome}\``,
    `- Complete: \`${options.summary.complete}\``,
    `- Mechanical passed: \`${options.summary.mechanicalPassed}\``,
    `- Required for release: \`${options.summary.requiredForRelease}\``,
    '',
    options.summary.reportPath
      ? `原始目标报告位于运行目录的 \`${options.summary.reportPath}\`。`
      : '该目标没有独立原始报告。',
    '',
  ].join('\n');
  await fs.ensureDir(parent);
  const staging = `${root}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(staging);
  try {
    await writeJsonAtomic(path.join(staging, 'summary.json'), options.summary);
    await writeTextAtomic(path.join(staging, 'report.md'), markdown);
    await fs.rename(staging, root);
  } catch (error) {
    await fs.remove(staging);
    throw error;
  }
}

async function assertSuiteTargetsAvailable(options: {
  batchRoot: string;
  evaluation: EvaluationLike;
  caseId?: string;
  allowDuplicateTargets?: boolean;
}): Promise<Set<string>> {
  const targets = options.evaluation.suites.flatMap((suite) => {
    const base = [
      suite.kind,
      suite.id,
      suite.profile ?? 'project-default',
      suite.split ?? 'all',
    ];
    return [
      targetKey([...base, options.caseId ?? 'all']),
      ...(options.caseId
        ? []
        : (suite.caseResults ?? []).map((caseResult) =>
          targetKey([...base, caseResult.id]))),
    ];
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error('An eval run cannot publish the same suite target more than once.');
  }
  if (options.allowDuplicateTargets) return new Set(targets);
  const attempts = await collectTargetSummaries(options.batchRoot);
  const latestByTarget = latestTargetAttempts(attempts);
  const retryable = new Set<string>();
  for (const target of targets) {
    const existing = latestByTarget.get(target);
    if (!existing) continue;
    if (!existing.complete || existing.outcome === 'incomplete') {
      retryable.add(target);
      continue;
    }
    throw new Error(`Eval target already has terminal evidence in this batch: ${target}.`);
  }
  return retryable;
}

async function collectTargetSummaries(batchRoot: string): Promise<TargetSummary[]> {
  const evalRoot = path.join(batchRoot, 'evals');
  if (!(await fs.pathExists(evalRoot))) return [];
  const summaries: TargetSummary[] = [];
  async function visit(current: string, relative = ''): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (nextRelative === 'runs' || nextRelative.startsWith('runs/')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.tmp')) continue;
      if (entry.isDirectory()) await visit(absolute, nextRelative);
      else if (entry.isFile() && entry.name === 'summary.json') {
        summaries.push(await fs.readJson(absolute) as TargetSummary);
      }
    }
  }
  await visit(evalRoot);
  return summaries.sort((left, right) => left.target.localeCompare(right.target));
}

function compareTargetAttempts(left: TargetSummary, right: TargetSummary): number {
  return left.generatedAt.localeCompare(right.generatedAt) || left.runId.localeCompare(right.runId);
}

function latestTargetAttempts(attempts: readonly TargetSummary[]): Map<string, TargetSummary> {
  const latest = new Map<string, TargetSummary>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.target);
    if (!current || compareTargetAttempts(current, attempt) < 0) {
      latest.set(attempt.target, attempt);
    }
  }
  return latest;
}

function composedTargetSummary(
  target: string,
  components: readonly TargetSummary[],
): TargetSummary {
  const latest = [...components].sort(compareTargetAttempts).at(-1)!;
  const outcomes = components.map((component) => component.outcome);
  const qualitativeReview = components.some((component) => component.qualitativeReview === 'required')
    ? 'required'
    : 'not_required';
  return {
    schemaVersion: 1,
    target,
    kind: latest.kind,
    runId: latest.runId,
    generatedAt: latest.generatedAt,
    profile: latest.profile,
    suite: latest.suite,
    split: latest.split,
    case: 'all',
    outcome: combineOutcomes(outcomes) as TargetSummary['outcome'],
    complete: components.every((component) => component.complete),
    mechanicalPassed: components.every((component) => component.mechanicalPassed),
    qualitativeReview,
    requiredForRelease: true,
    reportPath: null,
    summary: {
      composition: components.map((component) => ({
        target: component.target,
        runId: component.runId,
        generatedAt: component.generatedAt,
      })),
    },
    diagnostics: components.flatMap((component) => component.diagnostics),
  };
}

function effectiveTargetSummaries(
  attempts: readonly TargetSummary[],
  compositions: SkillReportTargetCompositions,
): TargetSummary[] {
  const effective = latestTargetAttempts(attempts);
  for (const [target, componentTargets] of Object.entries(compositions)) {
    const direct = effective.get(target);
    if (direct?.complete && direct.outcome !== 'incomplete') continue;
    const components = componentTargets.map((component) => effective.get(component));
    if (components.some((component) => !component)) continue;
    effective.set(target, composedTargetSummary(target, components as TargetSummary[]));
  }
  return [...effective.values()].sort((left, right) => left.target.localeCompare(right.target));
}

function materializationSummary(subject: EvaluationSubjectLike): Record<string, unknown> {
  return {
    scope: subject.scope,
    ...(subject.configDigest ? { configDigest: subject.configDigest } : {}),
    ...(subject.bundleDigest ? { bundleDigest: subject.bundleDigest } : {}),
    ...(subject.contentDigest ? { contentDigest: subject.contentDigest } : {}),
    artifacts: [...(subject.artifacts ?? [])].sort((left, right) =>
      `${left.kind}:${left.key ?? ''}:${left.contentDigest}`.localeCompare(
        `${right.kind}:${right.key ?? ''}:${right.contentDigest}`,
      )),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

async function assertMaterializedSubjectsCompatible(
  batchRoot: string,
  subjects: readonly EvaluationSubjectLike[],
): Promise<void> {
  const existing = latestTargetAttempts(await collectTargetSummaries(batchRoot));
  for (const subject of subjects) {
    const target = targetKey(['materialization', subject.profile]);
    const previous = existing.get(target);
    if (!previous) continue;
    const currentIdentity = materializationSummary(subject);
    if (stableJson(previous.summary) !== stableJson(currentIdentity)) {
      throw new Error(`Materialized subject differs from earlier batch evidence: ${target}.`);
    }
  }
}

function combineOutcomes(
  values: Array<'passed' | 'failed' | 'needs_review' | 'incomplete'>,
): 'passed' | 'failed' | 'needs_review' | 'incomplete' | 'not_run' {
  if (values.length === 0) return 'not_run';
  if (values.includes('failed')) return 'failed';
  if (values.includes('incomplete')) return 'incomplete';
  if (values.includes('needs_review')) return 'needs_review';
  return 'passed';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function recoverInterruptedRunsUnlocked(batchRoot: string): Promise<void> {
  const runsRoot = path.join(batchRoot, 'evals', 'runs');
  if (!(await fs.pathExists(runsRoot))) return;
  const currentHost = hostname();
  for (const runId of await fs.readdir(runsRoot)) {
    const runPath = path.join(runsRoot, runId, 'run.json');
    if (!(await fs.pathExists(runPath))) continue;
    const run = await fs.readJson(runPath) as Record<string, unknown>;
    if (
      run.status !== 'running' ||
      run.host !== currentHost ||
      !Number.isInteger(run.pid) ||
      isProcessAlive(run.pid as number)
    ) continue;
    await writeJsonAtomic(runPath, {
      ...run,
      status: 'failed',
      completedAt: new Date().toISOString(),
      outcome: 'failed',
      failureReason: 'The eval process ended before it published a terminal result.',
    });
  }
}

async function readRunSummaries(batchRoot: string): Promise<RunSummary[]> {
  const runsRoot = path.join(batchRoot, 'evals', 'runs');
  if (!(await fs.pathExists(runsRoot))) return [];
  const values: RunSummary[] = [];
  for (const runId of await fs.readdir(runsRoot)) {
    const runPath = path.join(runsRoot, runId, 'run.json');
    if (!(await fs.pathExists(runPath))) continue;
    const run = await fs.readJson(runPath) as {
      status?: 'running' | 'completed' | 'failed';
      completedAt?: string;
      outcome?: 'passed' | 'failed' | 'needs_review' | 'incomplete';
    };
    const summaryPath = path.join(runsRoot, runId, 'summary.json');
    const summary = await fs.pathExists(summaryPath)
      ? await fs.readJson(summaryPath) as {
          outcome?: 'passed' | 'failed' | 'needs_review' | 'incomplete';
          complete?: boolean;
          mechanicalPassed?: boolean;
        }
      : null;
    const status = run.status ?? (run.completedAt ? 'completed' : 'running');
    values.push({
      runId,
      status,
      completedAt: run.completedAt ?? null,
      outcome: status === 'failed' ? 'failed' : summary?.outcome ?? run.outcome ?? null,
      complete: status === 'completed' && summary?.complete === true,
      mechanicalPassed: status === 'completed' && summary?.mechanicalPassed === true,
      reportPath: `evals/runs/${runId}/report.md`,
    });
  }
  return values.sort((left, right) => left.runId.localeCompare(right.runId));
}

async function readReview(batchRoot: string): Promise<ReviewSummary | null> {
  const reviewsRoot = path.join(batchRoot, 'reviews');
  if (!(await fs.pathExists(reviewsRoot))) return null;
  const reports: ReviewSummary[] = [];
  for (const mode of await fs.readdir(reviewsRoot)) {
    const modeRoot = path.join(reviewsRoot, mode);
    for (const reviewId of await fs.readdir(modeRoot)) {
      const root = path.join(modeRoot, reviewId);
      const scorecardPath = path.join(root, 'scorecard.json');
      const reportPath = path.join(root, 'report.md');
      if (!(await fs.pathExists(scorecardPath)) || !(await fs.pathExists(reportPath))) continue;
      const reviewSummaryPath = path.join(root, 'review-summary.json');
      const calculated = await fs.pathExists(reviewSummaryPath)
        ? await fs.readJson(reviewSummaryPath) as Record<string, unknown>
        : {};
      const stats = await fs.stat(reportPath);
      const completedAt = typeof calculated.completedAt === 'string'
        ? calculated.completedAt
        : stats.mtime.toISOString();
      reports.push({
        mode,
        reviewId,
        completedAt,
        reportPath: path.relative(batchRoot, reportPath).split(path.sep).join('/'),
        scorecardPath: path.relative(batchRoot, scorecardPath).split(path.sep).join('/'),
        weightedScore: typeof calculated.weightedScore === 'number'
          ? calculated.weightedScore
          : null,
        coverage: typeof calculated.coverage === 'number' ? calculated.coverage : null,
        confidence: typeof calculated.confidence === 'string' ? calculated.confidence : null,
        release: typeof calculated.release === 'string' ? calculated.release : null,
      });
    }
  }
  return reports.sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0] ?? null;
}

async function refreshBatchSummary(batchRoot: string): Promise<BatchSummary> {
  const batch = await readBatch(batchRoot);
  const targetAttempts = await collectTargetSummaries(batchRoot);
  const targetCompositions = normalizeTargetCompositions(
    batch.targetCompositions,
    batch.requiredTargets,
  );
  const targets = effectiveTargetSummaries(targetAttempts, targetCompositions);
  const required = new Set(batch.requiredTargets);
  const covered = new Set(targets.filter((target) => required.has(target.target)).map((target) => target.target));
  const missingTargets = batch.requiredTargets.filter((target) => !covered.has(target));
  const requiredTargets = targets.filter((target) => required.has(target.target));
  const runs = await readRunSummaries(batchRoot);
  const completedRuns = runs.filter((run) => run.completedAt !== null);
  const completionTimes = completedRuns.map((run) => run.completedAt!);
  const failedRuns = completedRuns.filter((run) => run.status === 'failed');
  const review = await readReview(batchRoot);
  const latestCompletedAt = [...completionTimes, ...(review ? [review.completedAt] : [])]
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const summary: BatchSummary = {
    schemaVersion: 1,
    batchId: batch.batchId,
    name: batch.name,
    owner: batch.owner,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: new Date().toISOString(),
    latestCompletedAt,
    source: batch.source,
    eval: {
      runCount: completedRuns.length,
      runs,
      targetCount: targets.length,
      attemptCount: targetAttempts.length,
      outcome: targets.length > 0
        ? combineOutcomes(targets.map((target) => target.outcome))
        : failedRuns.length > 0
          ? 'failed'
          : 'not_run',
      complete: targets.length > 0 && targets.every((target) => target.complete),
      mechanicalPassed: targets.length > 0 &&
        targets.every((target) => target.mechanicalPassed),
      releaseRequired: required.size,
      releaseCovered: covered.size,
      releaseOutcome: missingTargets.length > 0
        ? 'incomplete'
        : combineOutcomes(requiredTargets.map((target) => target.outcome)),
      missingTargets,
      targets,
      targetAttempts,
    },
    review,
    diagnostics: failedRuns.map((run) => `Eval run ${run.runId} failed before publication.`),
  };
  await writeJsonAtomic(path.join(batchRoot, 'summary.json'), summary);
  await writeJsonAtomic(path.join(batchRoot, 'evals', 'evaluation.json'), {
    schemaVersion: 1,
    generatedAt: summary.updatedAt,
    batchId: summary.batchId,
    owner: summary.owner,
    source: summary.source,
    outcome: summary.eval.releaseOutcome,
    complete: summary.eval.runCount > 0 &&
      summary.eval.releaseOutcome === 'passed' &&
      summary.eval.releaseCovered === summary.eval.releaseRequired &&
      summary.eval.targets.filter((target) => target.requiredForRelease).every((target) => target.complete),
    mechanicalPassed: summary.eval.releaseRequired > 0 &&
      summary.eval.releaseCovered === summary.eval.releaseRequired &&
      summary.eval.targets
      .filter((target) => target.requiredForRelease)
      .every((target) => target.mechanicalPassed),
    targets: summary.eval.targets,
    targetAttempts: summary.eval.targetAttempts,
    diagnostics: summary.diagnostics,
  });
  const runRows = runs.map((run) =>
    `| ${run.runId} | ${run.status} | ${run.outcome ?? '-'} | ${run.complete} |`,
  );
  const targetRows = targets.map((target) =>
    `| ${target.target} | ${target.runId} | ${target.outcome} | ${target.complete} |`,
  );
  await writeTextAtomic(path.join(batchRoot, 'report.md'), [
    '# Skill Verification Batch Report',
    '',
    `- Batch: \`${summary.batchId}\``,
    `- Name: \`${summary.name}\``,
    `- Owner: \`${ownerKey(summary.owner)}\``,
    `- Status: \`${summary.status}\``,
    `- Eval outcome: \`${summary.eval.outcome}\``,
    `- Release outcome: \`${summary.eval.releaseOutcome}\``,
    `- Release coverage: \`${summary.eval.releaseCovered}/${summary.eval.releaseRequired}\``,
    `- Target attempts: \`${summary.eval.attemptCount}\``,
    `- Source: \`${summary.source.digest}\``,
    '',
    '| Run | Status | Outcome | Complete |',
    '| --- | --- | --- | --- |',
    ...runRows,
    '',
    '| Target | Run | Outcome | Complete |',
    '| --- | --- | --- | --- |',
    ...targetRows,
    '',
    summary.review
      ? `Review: \`${summary.review.mode}\`, release \`${summary.review.release ?? 'unknown'}\`.`
      : 'Review: 尚未发布。',
    '',
  ].join('\n'));
  batch.updatedAt = summary.updatedAt;
  await writeJsonAtomic(path.join(batchRoot, 'batch.json'), batch);
  return summary;
}

async function readRunningEvalRun(
  layout: SkillEvalRunLayout,
): Promise<{ runPath: string; run: Record<string, unknown> }> {
  const runPath = path.join(layout.reportRoot, 'run.json');
  const run = await fs.readJson(runPath) as Record<string, unknown>;
  if (run.status !== 'running') {
    throw new Error(`Eval run ${layout.runId} is not running.`);
  }
  return { runPath, run };
}

async function publishEvaluationTargetsUnlocked(options: {
  layout: SkillEvalRunLayout;
  evaluation: EvaluationLike;
  batch: SkillReportBatch;
  caseId?: string;
  allowDuplicateTargets?: boolean;
}): Promise<void> {
  await assertMaterializedSubjectsCompatible(
    options.layout.batchRoot,
    options.evaluation.subjects,
  );
  const retryableTargets = await assertSuiteTargetsAvailable({
    batchRoot: options.layout.batchRoot,
    evaluation: options.evaluation,
    caseId: options.caseId,
    allowDuplicateTargets: options.allowDuplicateTargets,
  });
  const required = new Set(options.batch.requiredTargets);
  for (const subject of options.evaluation.subjects) {
    const target = targetKey(['materialization', subject.profile]);
    await writeTargetReport({
      batchRoot: options.layout.batchRoot,
      allowExistingMaterialization: true,
      summary: {
        schemaVersion: 1,
        target,
        kind: 'materialization',
        runId: options.layout.runId,
        generatedAt: options.evaluation.generatedAt,
        profile: subject.profile,
        suite: null,
        split: 'all',
        case: 'all',
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
        qualitativeReview: 'not_required',
        requiredForRelease: required.has(target),
        reportPath: null,
        summary: materializationSummary(subject),
        diagnostics: [],
      },
    });
  }
  for (const suite of options.evaluation.suites) {
    const target = targetKey([
      suite.kind,
      suite.id,
      suite.profile ?? 'project-default',
      suite.split ?? 'all',
      options.caseId ?? 'all',
    ]);
    await writeTargetReport({
      batchRoot: options.layout.batchRoot,
      allowDuplicate: options.allowDuplicateTargets || retryableTargets.has(target),
      summary: {
        schemaVersion: 1,
        target,
        kind: suite.kind,
        runId: options.layout.runId,
        generatedAt: options.evaluation.generatedAt,
        profile: suite.profile ?? 'project-default',
        suite: suite.id,
        split: suite.split ?? 'all',
        case: options.caseId ?? 'all',
        outcome: suite.outcome,
        complete: suite.complete,
        mechanicalPassed: suite.mechanicalPassed,
        qualitativeReview: suite.qualitativeReview ?? 'not_required',
        requiredForRelease: required.has(target),
        reportPath: suite.reportPath ?? null,
        summary: suite.summary ?? {},
        diagnostics: suite.diagnostics ?? [],
      },
    });
    if (!options.caseId) {
      for (const caseResult of suite.caseResults ?? []) {
        const caseTarget = targetKey([
          suite.kind,
          suite.id,
          suite.profile ?? 'project-default',
          suite.split ?? 'all',
          caseResult.id,
        ]);
        await writeTargetReport({
          batchRoot: options.layout.batchRoot,
          allowDuplicate: options.allowDuplicateTargets || retryableTargets.has(caseTarget),
          summary: {
            schemaVersion: 1,
            target: caseTarget,
            kind: suite.kind,
            runId: options.layout.runId,
            generatedAt: options.evaluation.generatedAt,
            profile: suite.profile ?? 'project-default',
            suite: suite.id,
            split: suite.split ?? 'all',
            case: caseResult.id,
            outcome: caseResult.outcome,
            complete: caseResult.complete,
            mechanicalPassed: caseResult.mechanicalPassed,
            qualitativeReview:
              caseResult.qualitativeReview ?? suite.qualitativeReview ?? 'not_required',
            requiredForRelease: required.has(caseTarget),
            reportPath: caseResult.reportPath ?? suite.reportPath ?? null,
            summary: caseResult.summary ?? {},
            diagnostics: caseResult.diagnostics ?? [],
          },
        });
      }
    }
  }
}

export async function resolveSkillEvalTargetPlan(options: {
  layout: SkillEvalRunLayout;
  targets: string[];
}): Promise<SkillEvalTargetPlan> {
  await assertSafeSkillReportPath(options.layout.reportBoundaryRoot, options.layout.batchRoot);
  return withBatchLock(options.layout.batchRoot, async () => {
    const batch = await readBatch(options.layout.batchRoot);
    if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
    await readRunningEvalRun(options.layout);
    const requested = [...new Set(options.targets.map((target, index) =>
      validateTarget(target, `Requested eval target ${index + 1}`)))];
    const effective = new Map(effectiveTargetSummaries(
      await collectTargetSummaries(options.layout.batchRoot),
      normalizeTargetCompositions(batch.targetCompositions, batch.requiredTargets),
    ).map((target) => [target.target, target]));
    const pending: string[] = [];
    const reusable: TargetSummary[] = [];
    for (const target of requested) {
      const existing = effective.get(target);
      if (existing?.complete && existing.outcome !== 'incomplete') {
        reusable.push(existing);
      } else {
        pending.push(target);
      }
    }
    return { pending, reusable };
  });
}

export async function publishEvalRunCheckpoint(options: {
  layout: SkillEvalRunLayout;
  evaluation: EvaluationLike;
  caseId?: string;
  allowDuplicateTargets?: boolean;
}): Promise<BatchSummary> {
  await assertSafeSkillReportPath(options.layout.reportBoundaryRoot, options.layout.batchRoot);
  return withBatchLock(options.layout.batchRoot, async () => {
    const batch = await readBatch(options.layout.batchRoot);
    if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
    await readRunningEvalRun(options.layout);
    await publishEvaluationTargetsUnlocked({ ...options, batch });
    return refreshBatchSummary(options.layout.batchRoot);
  });
}

export async function completeSkillEvalRun(options: {
  layout: SkillEvalRunLayout;
  evaluation: EvaluationLike;
}): Promise<BatchSummary> {
  await assertSafeSkillReportPath(options.layout.reportBoundaryRoot, options.layout.batchRoot);
  return withBatchLock(options.layout.batchRoot, async () => {
    const batch = await readBatch(options.layout.batchRoot);
    if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
    const { runPath, run } = await readRunningEvalRun(options.layout);
    await writeJsonAtomic(runPath, {
      ...run,
      status: 'completed',
      completedAt: new Date().toISOString(),
      outcome: options.evaluation.outcome,
    });
    return refreshBatchSummary(options.layout.batchRoot);
  });
}

export async function publishEvalRunToBatch(options: {
  repoRoot: string;
  layout: SkillEvalRunLayout;
  evaluation: EvaluationLike;
  caseId?: string;
  requiredTargets: string[];
  allowDuplicateTargets?: boolean;
}): Promise<BatchSummary> {
  await assertSafeSkillReportPath(options.layout.reportBoundaryRoot, options.layout.batchRoot);
  return withBatchLock(options.layout.batchRoot, async () => {
    const batch = await readBatch(options.layout.batchRoot);
    if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
    const { runPath, run } = await readRunningEvalRun(options.layout);
    await publishEvaluationTargetsUnlocked({ ...options, batch });
    await writeJsonAtomic(runPath, {
      ...run,
      status: 'completed',
      completedAt: new Date().toISOString(),
      outcome: options.evaluation.outcome,
    });
    return refreshBatchSummary(options.layout.batchRoot);
  });
}

export async function failSkillEvalRun(options: {
  layout: SkillEvalRunLayout;
  message?: string;
}): Promise<BatchSummary> {
  await assertSafeSkillReportPath(options.layout.reportBoundaryRoot, options.layout.batchRoot);
  return withBatchLock(options.layout.batchRoot, async () => {
    const batch = await readBatch(options.layout.batchRoot);
    if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
    const runPath = path.join(options.layout.reportRoot, 'run.json');
    const run = await fs.readJson(runPath) as Record<string, unknown>;
    await writeJsonAtomic(runPath, {
      ...run,
      status: 'failed',
      completedAt: new Date().toISOString(),
      outcome: 'failed',
      ...(options.message ? { failureReason: options.message } : {}),
    });
    return refreshBatchSummary(options.layout.batchRoot);
  });
}

export async function refreshSkillReportBatch(options: {
  repoRoot: string;
  owner: SkillReportOwner;
  batchId: string;
}): Promise<BatchSummary> {
  const batchRoot = path.join(
    resolveSkillEvalRoot(options.repoRoot, options.owner),
    validateBatchId(options.batchId),
  );
  await assertSafeSkillReportPath(options.repoRoot, batchRoot);
  const summary = await withBatchLock(batchRoot, async () => {
    const batch = await readBatch(batchRoot);
    if (!sameOwner(batch.owner, options.owner)) throw new Error('Report batch owner mismatch.');
    await recoverInterruptedRunsUnlocked(batchRoot);
    return refreshBatchSummary(batchRoot);
  });
  return summary;
}

async function sealBatchUnlocked(
  batchRoot: string,
  owner: SkillReportOwner,
): Promise<BatchSummary> {
  const batch = await readBatch(batchRoot);
  if (!sameOwner(batch.owner, owner)) throw new Error('Review batch owner mismatch.');
  if (batch.status === 'sealed') throw new Error(`Report batch ${batch.batchId} is sealed.`);
  await recoverInterruptedRunsUnlocked(batchRoot);
  const runs = await readRunSummaries(batchRoot);
  if (runs.some((run) => run.status === 'running')) {
    throw new Error(`Report batch ${batch.batchId} still has a running eval.`);
  }
  batch.status = 'sealed';
  batch.sealedAt = new Date().toISOString();
  batch.updatedAt = batch.sealedAt;
  await writeJsonAtomic(path.join(batchRoot, 'batch.json'), batch);
  return refreshBatchSummary(batchRoot);
}

export async function sealSkillReportBatch(options: {
  repoRoot: string;
  owner: SkillReportOwner;
  batchId: string;
}): Promise<BatchSummary> {
  const batchRoot = path.join(
    resolveSkillEvalRoot(options.repoRoot, options.owner),
    validateBatchId(options.batchId),
  );
  await assertSafeSkillReportPath(options.repoRoot, batchRoot);
  const summary = await withBatchLock(
    batchRoot,
    () => sealBatchUnlocked(batchRoot, options.owner),
  );
  return summary;
}

export async function publishSkillReviewToBatch(options: {
  repoRoot: string;
  owner: SkillReportOwner;
  batchName?: string;
  batchId?: string;
  source: SkillReportSourceIdentity;
  report: string;
  scorecard: unknown;
  reviewResult?: unknown;
  awReviewSummary?: unknown;
  calculated: SkillReviewCalculation;
  reviewId?: string;
}): Promise<PublishedSkillReportSummary> {
  if ((options.batchName ? 1 : 0) + (options.batchId ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --batch-name or --batch-id.');
  }
  assertSegment(options.owner.skill, 'Skill name');
  if (options.owner.kind === 'plugin-skill') assertSegment(options.owner.plugin, 'Plugin name');
  if (options.report.trim() === '') throw new Error('Review report must not be empty.');
  const evalRoot = resolveSkillEvalRoot(options.repoRoot, options.owner);
  const reportRoot = resolveSkillReportRoot(options.repoRoot, options.owner);
  const batchId = options.batchId
    ? validateBatchId(options.batchId)
    : createSkillReportBatchId(options.batchName!);
  const reviewId = validateRunId(options.reviewId ?? createRunId(), '--review-id');
  const batchRoot = path.join(evalRoot, batchId);
  const publishedBatchRoot = path.join(reportRoot, batchId);
  await assertSafeSkillReportPath(options.repoRoot, batchRoot);
  await assertSafeSkillReportPath(options.repoRoot, publishedBatchRoot);
  const now = new Date().toISOString();
  if (options.batchName) {
    await fs.ensureDir(evalRoot);
    await assertSafeSkillReportPath(options.repoRoot, evalRoot);
    await fs.mkdir(batchRoot);
    await assertSafeSkillReportPath(options.repoRoot, batchRoot);
    await writeJsonAtomic(path.join(batchRoot, 'batch.json'), {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId,
      name: options.batchName,
      owner: options.owner,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      source: options.source,
      environmentDigest: createEnvironmentDigest({ reviewOnly: true }),
      requiredTargets: [],
    } satisfies SkillReportBatch);
  } else if (!(await fs.pathExists(batchRoot))) {
    throw new Error(`Report batch does not exist: ${batchId}.`);
  }
  return withBatchLock(batchRoot, async () => {
    const batch = await readBatch(batchRoot);
    if (!sameOwner(batch.owner, options.owner)) throw new Error('Review batch owner mismatch.');
    if (batch.status === 'sealed') throw new Error(`Report batch ${batchId} is sealed.`);
    if (batch.source.digest !== options.source.digest) {
      throw new Error(`Report batch ${batchId} uses a different source digest.`);
    }
    await recoverInterruptedRunsUnlocked(batchRoot);
    const runs = await readRunSummaries(batchRoot);
    if (runs.some((run) => run.status === 'running')) {
      throw new Error(`Report batch ${batch.batchId} still has a running eval.`);
    }
    if (await fs.pathExists(publishedBatchRoot)) {
      throw new Error(`Report batch ${batchId} is already published.`);
    }
    const reviewRoot = path.join(batchRoot, 'reviews', options.calculated.mode, reviewId);
    const stagingRoot = path.join(
      reportRoot,
      `.${batchId}.${process.pid}.${randomUUID()}.tmp`,
    );
    if (await fs.pathExists(reviewRoot)) {
      throw new Error(`Review ${reviewId} already exists in report batch ${batchId}.`);
    }
    let reviewCreated = false;
    let sealed = false;
    try {
      const batchSummary = await refreshBatchSummary(batchRoot);
      const publishedSummary = publishedSummaryFromReview({
        batchSummary,
        reviewId,
        publishedAt: now,
        scorecard: options.scorecard,
        calculated: options.calculated,
      });
      await assertSafeSkillReportPath(options.repoRoot, reportRoot);
      await fs.ensureDir(reportRoot);
      await assertSafeSkillReportPath(options.repoRoot, reportRoot);
      await fs.mkdir(stagingRoot);
      await writeTextAtomic(path.join(stagingRoot, 'report.md'), options.report);
      await writeJsonAtomic(path.join(stagingRoot, 'summary.json'), publishedSummary);
      if (options.reviewResult !== undefined) {
        await writeJsonAtomic(path.join(stagingRoot, 'review-result.json'), options.reviewResult);
      }
      if (options.awReviewSummary !== undefined) {
        await writeJsonAtomic(
          path.join(stagingRoot, 'aw-review-summary.json'),
          options.awReviewSummary,
        );
      }
      await fs.ensureDir(path.dirname(reviewRoot));
      await fs.mkdir(reviewRoot, { recursive: false });
      reviewCreated = true;
      await writeTextAtomic(path.join(reviewRoot, 'report.md'), options.report);
      await writeJsonAtomic(path.join(reviewRoot, 'scorecard.json'), options.scorecard);
      if (options.reviewResult !== undefined) {
        await writeJsonAtomic(path.join(reviewRoot, 'review-result.json'), options.reviewResult);
      }
      if (options.awReviewSummary !== undefined) {
        await writeJsonAtomic(
          path.join(reviewRoot, 'aw-review-summary.json'),
          options.awReviewSummary,
        );
      }
      await writeJsonAtomic(path.join(reviewRoot, 'review-summary.json'), {
        schemaVersion: 1,
        completedAt: now,
        ...options.calculated,
      });
      await refreshBatchSummary(batchRoot);
      sealed = true;
      await sealBatchUnlocked(batchRoot, options.owner);
      await fs.rename(stagingRoot, publishedBatchRoot);
      return publishedSummary;
    } catch (error) {
      try {
        await fs.remove(stagingRoot);
        if (reviewCreated) await fs.remove(reviewRoot);
        if (sealed) {
          const current = await readBatch(batchRoot);
          current.status = 'open';
          delete current.sealedAt;
          current.updatedAt = new Date().toISOString();
          await writeJsonAtomic(path.join(batchRoot, 'batch.json'), current);
        }
        if (reviewCreated) await refreshBatchSummary(batchRoot);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Review publication failed and rollback did not complete for batch ${batchId}.`,
        );
      }
      throw error;
    }
  });
}

export function reportBatchName(batchId: string): string {
  return batchNameFromId(validateBatchId(batchId));
}
