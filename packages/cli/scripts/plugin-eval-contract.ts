import path from 'node:path';

import fs from 'fs-extra';

import type { Scope } from '../src/types.js';

export const PLUGIN_EVAL_SCHEMA_VERSION = 2 as const;
export const PLUGIN_EVAL_CASE_SCHEMA_VERSION = 1 as const;

export type PluginEvalSplit = 'train' | 'validation' | 'sanity' | 'all';
export type PluginEvalOutcome = 'passed' | 'failed' | 'needs_review' | 'incomplete';
export type PluginEvalIsolation = 'standard' | 'strict';
export type PluginEvalProcessMode =
  | 'managed'
  | 'observed'
  | 'unmanaged-confirmed'
  | 'not-applicable';

export interface PluginEvalProcessManagementEvidence {
  mode: PluginEvalProcessMode;
  inspectionAvailable: boolean;
  userAcknowledged: boolean;
  descendantCleanupGuaranteed: boolean;
  limitation?: string;
  diagnostic?: string;
}

export interface PluginEvalProfile {
  id: string;
  scope: Scope;
  plugins: PluginEvalPluginInstallation[];
  runModel: boolean;
  requiredForRelease: boolean;
}

export interface PluginEvalPluginInstallation {
  name: string;
  config: Record<string, unknown>;
}

export interface PluginEvalCommandSuite {
  id: string;
  kind: 'command';
  skill: string;
  skills: string[];
  entry: string;
  cases?: string;
  profiles: string[];
  defaultRuns: number;
  releaseSplits: PluginEvalSplit[];
  requiredForRelease: boolean;
  perRunTimeoutMs: number;
  suiteTimeoutMs: number;
  supports: Array<
    'split' |
    'runs' |
    'case' |
    'model' |
    'codexBin' |
    'timeout' |
    'allowEnvironmentSkips'
  >;
}

export interface PluginEvalConversationSuite {
  id: string;
  kind: 'conversation';
  skill: string;
  skills: string[];
  cases: string;
  profiles: string[];
  defaultRuns: number;
  releaseSplits: PluginEvalSplit[];
  requiredForRelease: boolean;
  perRunTimeoutMs: number;
  isolation: PluginEvalIsolation;
}

export interface PluginEvalTriggerSuite {
  id: string;
  kind: 'trigger';
  skill: string;
  skills: string[];
  cases: string;
  fixtureModule?: string;
  observeSpawnAgent: boolean;
  isolation: PluginEvalIsolation;
  strictNegativeSplits: Array<Exclude<PluginEvalSplit, 'all'>>;
  minimumPassRate?: number;
  forbidMultipleSkillLoads: boolean;
  profiles: string[];
  defaultRuns: number;
  releaseSplits: PluginEvalSplit[];
  requiredForRelease: boolean;
  perRunTimeoutMs: number;
}

export interface PluginEvalTriggerCase {
  id: string;
  split: Exclude<PluginEvalSplit, 'all'>;
  query: string;
  should_load_skill?: boolean;
  expected_loaded_skills?: string[];
  should_spawn_agent?: boolean;
  workspace_fixture?: string;
  use_project_rules?: boolean;
  tags?: string[];
}

export interface PluginEvalTriggerCaseDocument {
  schemaVersion: typeof PLUGIN_EVAL_CASE_SCHEMA_VERSION;
  skill: string;
  cases: PluginEvalTriggerCase[];
}

export type PluginEvalSuite =
  | PluginEvalCommandSuite
  | PluginEvalConversationSuite
  | PluginEvalTriggerSuite;

export interface PluginEvalManifest {
  schemaVersion: typeof PLUGIN_EVAL_SCHEMA_VERSION;
  plugin: string;
  skill: string;
  profiles: PluginEvalProfile[];
  suites: PluginEvalSuite[];
}

export interface MaterializedPluginEvalArtifact {
  kind: 'skill' | 'agent' | 'instruction' | 'config';
  key?: string;
  path: string;
  contentDigest: string;
}

export interface MaterializedPluginEvalSubject {
  schemaVersion: typeof PLUGIN_EVAL_SCHEMA_VERSION;
  plugin: string;
  skill: string;
  pluginVersion: string;
  platform: 'codex';
  profile: string;
  scope: Scope;
  modelExecution: boolean;
  evidenceLevel: 'runtime-project' | 'materialized-user';
  root: string;
  configDigest: string;
  bundleDigest: string;
  installedPlugins: Array<{
    name: string;
    version: string;
    configDigest: string;
    bundleDigest: string;
  }>;
  artifacts: MaterializedPluginEvalArtifact[];
}

export interface PluginEvalSuiteReport {
  id: string;
  kind: PluginEvalSuite['kind'];
  skills: string[];
  profile: string;
  split: PluginEvalSplit | null;
  outcome: PluginEvalOutcome;
  complete: boolean;
  mechanicalPassed: boolean;
  qualitativeReview: 'not_required' | 'required' | 'passed' | 'failed';
  reportPath?: string;
  caseResults?: PluginEvalCaseResult[];
  summary: Record<string, unknown>;
  diagnostics: string[];
}

export interface PluginEvalCaseResult {
  id: string;
  outcome: PluginEvalOutcome;
  complete: boolean;
  mechanicalPassed: boolean;
  qualitativeReview?: PluginEvalSuiteReport['qualitativeReview'];
  reportPath?: string;
  sourceRunId?: string;
  reused?: boolean;
  summary?: Record<string, unknown>;
  diagnostics?: string[];
}

export type PluginEvalCommandCaseResult = PluginEvalCaseResult;

export interface PluginEvalCaseCheckpoint {
  caseId: string;
  report: PluginEvalSuiteReport;
}

export interface PluginEvaluationBundle {
  schemaVersion: typeof PLUGIN_EVAL_SCHEMA_VERSION;
  generatedAt: string;
  plugin: string;
  skill: string;
  pluginVersion: string;
  platform: 'codex';
  codexVersion: string | null;
  model: string | null;
  modelProvider: string | null;
  credentialSource: 'embedded' | 'environment' | 'openai-auth' | 'none' | null;
  codexConfigDigest: string | null;
  cliCapsule: {
    packageName: string;
    packageVersion: string;
    contentDigest: string;
  } | null;
  processManagement: PluginEvalProcessManagementEvidence;
  outcome: PluginEvalOutcome;
  complete: boolean;
  mechanicalPassed: boolean;
  subjects: MaterializedPluginEvalSubject[];
  suites: PluginEvalSuiteReport[];
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function expectOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new Error(`${label} has unknown field "${unknownKey}".`);
  }
}

function parseEvalWorkspacePath(
  value: unknown,
  label: string,
  options: { allowTreePattern: boolean },
): string {
  const raw = expectString(value, label);
  const treePattern = options.allowTreePattern && raw.endsWith('/**');
  const candidate = treePattern ? raw.slice(0, -3) : raw;
  if (
    candidate === '' ||
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    candidate.includes('*') ||
    candidate.includes('?') ||
    candidate.includes('[') ||
    candidate.includes(']') ||
    path.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate.split('/').includes('..')
  ) {
    throw new Error(`${label} must be a normalized POSIX path inside the eval workspace.`);
  }
  const firstSegment = candidate.split('/')[0];
  if (firstSegment === '.git' || firstSegment === '.agents' || firstSegment === '.codex') {
    throw new Error(`${label} must not target an eval control directory.`);
  }
  return raw;
}

function workspacePathMatchesPattern(relativePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  return relativePath === pattern;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function expectRate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} must be a number greater than 0 and at most 1.`);
  }
  return value;
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertRealPathInside(
  boundary: string,
  candidate: string,
  label: string,
  boundaryLabel: string,
): void {
  const canonicalBoundary = fs.realpathSync(boundary);
  const canonicalCandidate = fs.realpathSync(candidate);
  if (!isPathInsideOrEqual(canonicalBoundary, canonicalCandidate)) {
    throw new Error(`${label} must stay inside the ${boundaryLabel}.`);
  }
}

function validateEvalRelativeFile(
  pluginRoot: string,
  evalRoot: string,
  value: unknown,
  label: string,
): string {
  const inputPath = expectString(value, label);
  const normalizedInput = inputPath.replace(/^\.\//u, '');
  if (
    path.isAbsolute(normalizedInput) ||
    normalizedInput.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(`${label} must stay inside the Skill eval directory.`);
  }
  const absolutePath = path.resolve(evalRoot, normalizedInput);
  if (!fs.pathExistsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`${label} must reference an existing file: ${inputPath}`);
  }
  assertRealPathInside(
    evalRoot,
    absolutePath,
    label,
    'Skill eval directory',
  );
  const pluginRelative = path.relative(pluginRoot, absolutePath).split(path.sep).join('/');
  return `./${pluginRelative}`;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value.map((entry, index) => expectString(entry, `${label}[${index}]`));
}

function assertUniqueIds(values: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new Error(`Duplicate ${label} id: ${value.id}`);
    }
    seen.add(value.id);
  }
}

function validateConversationReply(value: unknown, label: string): void {
  if (typeof value === 'string') return;
  const reply = expectRecord(value, label);
  if (!Array.isArray(reply.answers_by_index) || reply.answers_by_index.some(
    (entry) => typeof entry !== 'string',
  )) {
    throw new Error(`${label}.answers_by_index must be an array of strings.`);
  }
  if (
    reply.expected_question_count !== undefined &&
    (!Number.isInteger(reply.expected_question_count) ||
      (reply.expected_question_count as number) < 0)
  ) {
    throw new Error(`${label}.expected_question_count must be a non-negative integer.`);
  }
  expectString(reply.unexpected_question_answer, `${label}.unexpected_question_answer`);
}

function validateConversationWorkspaceFiles(value: unknown, label: string): void {
  if (value === undefined) return;
  const files = expectRecord(value, label);
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new Error(`${label} must contain at least one file.`);
  }
  for (const [relativePath, content] of entries) {
    parseEvalWorkspacePath(relativePath, `${label}.${relativePath}`, {
      allowTreePattern: false,
    });
    expectString(content, `${label}.${relativePath}`);
  }
}

export function validatePluginEvalConversationCaseDocument(
  value: unknown,
  expectedSkill: string,
  label = 'conversation cases',
): Array<Record<string, unknown>> {
  const document = expectRecord(value, label);
  const skill = expectString(document.skill_name, `${label}.skill_name`);
  if (skill !== expectedSkill) {
    throw new Error(
      `${label}.skill_name "${skill}" does not match suite skill "${expectedSkill}".`,
    );
  }
  if (!Array.isArray(document.evals) || document.evals.length === 0) {
    throw new Error(`${label}.evals must be a non-empty array.`);
  }
  const ids = new Set<string>();
  return document.evals.map((entry, index) => {
    const row = expectRecord(entry, `${label}.evals[${index}]`);
    const id = expectString(row.id, `${label}.evals[${index}].id`).trim();
    if (ids.has(id)) {
      throw new Error(`${label} has duplicate case id "${id}".`);
    }
    ids.add(id);
    expectString(row.prompt, `${label}.evals[${index}].prompt`);
    const sandbox = row.sandbox === undefined
      ? 'read-only'
      : expectString(row.sandbox, `${label}.evals[${index}].sandbox`);
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw new Error(`${label}.evals[${index}].sandbox must be "read-only" or "workspace-write".`);
    }
    if (!Array.isArray(row.scripted_replies)) {
      throw new Error(`${label}.evals[${index}].scripted_replies must be an array.`);
    }
    row.scripted_replies.forEach((reply, replyIndex) =>
      validateConversationReply(
        reply,
        `${label}.evals[${index}].scripted_replies[${replyIndex}]`,
      ));
    expectString(row.expected_output, `${label}.evals[${index}].expected_output`);
    validateConversationWorkspaceFiles(
      row.workspace_files,
      `${label}.evals[${index}].workspace_files`,
    );
    const review = expectRecord(row.review, `${label}.evals[${index}].review`);
    parseStringArray(review.checks, `${label}.evals[${index}].review.checks`);
    if (review.workspace_unchanged !== undefined) {
      expectBoolean(
        review.workspace_unchanged,
        `${label}.evals[${index}].review.workspace_unchanged`,
      );
    }
    const allowedWorkspaceChanges = review.allowed_workspace_changes === undefined
      ? []
      : parseStringArray(
          review.allowed_workspace_changes,
          `${label}.evals[${index}].review.allowed_workspace_changes`,
        ).map((entry, pathIndex) => parseEvalWorkspacePath(
          entry,
          `${label}.evals[${index}].review.allowed_workspace_changes[${pathIndex}]`,
          { allowTreePattern: true },
        ));
    const artifacts = review.artifacts === undefined
      ? []
      : review.artifacts;
    if (!Array.isArray(artifacts)) {
      throw new Error(`${label}.evals[${index}].review.artifacts must be an array.`);
    }
    const artifactPaths = artifacts.map((artifact, artifactIndex) => {
      const artifactLabel = `${label}.evals[${index}].review.artifacts[${artifactIndex}]`;
      const artifactRow = expectRecord(artifact, artifactLabel);
      expectOnlyKeys(
        artifactRow,
        ['path', 'exists', 'contains', 'not_contains', 'json'],
        artifactLabel,
      );
      const artifactPath = parseEvalWorkspacePath(
        artifactRow.path,
        `${artifactLabel}.path`,
        { allowTreePattern: false },
      );
      if (artifactRow.exists !== undefined) {
        expectBoolean(artifactRow.exists, `${artifactLabel}.exists`);
      }
      if (artifactRow.contains !== undefined) {
        parseStringArray(artifactRow.contains, `${artifactLabel}.contains`);
      }
      if (artifactRow.not_contains !== undefined) {
        parseStringArray(artifactRow.not_contains, `${artifactLabel}.not_contains`);
      }
      if (artifactRow.json !== undefined) {
        expectRecord(artifactRow.json, `${artifactLabel}.json`);
      }
      return artifactPath;
    });
    if (new Set(artifactPaths).size !== artifactPaths.length) {
      throw new Error(`${label}.evals[${index}].review.artifacts contains duplicate paths.`);
    }
    if (sandbox === 'workspace-write') {
      if (review.workspace_unchanged !== false) {
        throw new Error(`${label}.evals[${index}] workspace-write requires review.workspace_unchanged=false.`);
      }
      if (allowedWorkspaceChanges.length === 0) {
        throw new Error(`${label}.evals[${index}] workspace-write requires non-empty review.allowed_workspace_changes.`);
      }
      if (artifactPaths.length === 0) {
        throw new Error(`${label}.evals[${index}] workspace-write requires non-empty review.artifacts.`);
      }
      const unmatchedArtifact = artifactPaths.find((artifactPath) =>
        !allowedWorkspaceChanges.some((pattern) =>
          workspacePathMatchesPattern(artifactPath, pattern)));
      if (unmatchedArtifact) {
        throw new Error(`${label}.evals[${index}] artifact path ${JSON.stringify(unmatchedArtifact)} is outside review.allowed_workspace_changes.`);
      }
    }
    return row;
  });
}

function parseProfile(
  value: unknown,
  index: number,
  ownerPlugin: string,
): PluginEvalProfile {
  const row = expectRecord(value, `profiles[${index}]`);
  expectOnlyKeys(
    row,
    ['id', 'scope', 'plugins', 'runModel', 'requiredForRelease'],
    `profiles[${index}]`,
  );
  const id = expectString(row.id, `profiles[${index}].id`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new Error(`profiles[${index}].id must use lowercase kebab-case.`);
  }
  const scope = row.scope;
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`profiles[${index}].scope must be user or project.`);
  }
  if (!Array.isArray(row.plugins) || row.plugins.length === 0) {
    throw new Error(`profiles[${index}].plugins must be a non-empty array.`);
  }
  const seenPlugins = new Set<string>();
  const plugins = row.plugins.map((value, pluginIndex) => {
    const label = `profiles[${index}].plugins[${pluginIndex}]`;
    const plugin = expectRecord(value, label);
    expectOnlyKeys(plugin, ['name', 'config'], label);
    const name = expectString(plugin.name, `${label}.name`);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
      throw new Error(`${label}.name must use lowercase kebab-case.`);
    }
    if (seenPlugins.has(name)) {
      throw new Error(`profiles[${index}].plugins has duplicate plugin "${name}".`);
    }
    seenPlugins.add(name);
    return {
      name,
      config: plugin.config === undefined
        ? {}
        : expectRecord(plugin.config, `${label}.config`),
    };
  });
  if (!seenPlugins.has(ownerPlugin)) {
    throw new Error(
      `profiles[${index}].plugins must include owner plugin "${ownerPlugin}".`,
    );
  }
  return {
    id,
    scope,
    plugins,
    runModel: expectBoolean(row.runModel, `profiles[${index}].runModel`),
    requiredForRelease: expectBoolean(
      row.requiredForRelease,
      `profiles[${index}].requiredForRelease`,
    ),
  };
}

const VALID_SPLITS = new Set<PluginEvalSplit>(['train', 'validation', 'sanity', 'all']);
const VALID_TRIGGER_CASE_SPLITS = new Set<PluginEvalTriggerCase['split']>([
  'train',
  'validation',
  'sanity',
]);
const VALID_SUPPORTS = new Set<PluginEvalCommandSuite['supports'][number]>([
  'split',
  'runs',
  'case',
  'model',
  'codexBin',
  'timeout',
  'allowEnvironmentSkips',
]);

function parseIsolation(value: unknown, label: string): PluginEvalIsolation {
  const isolation = value ?? 'standard';
  if (isolation !== 'standard' && isolation !== 'strict') {
    throw new Error(`${label} must be standard or strict.`);
  }
  return isolation;
}

function parseSuite(
  pluginRoot: string,
  evalRoot: string,
  skill: string,
  value: unknown,
  index: number,
  profileIds: ReadonlySet<string>,
): PluginEvalSuite {
  const row = expectRecord(value, `suites[${index}]`);
  const id = expectString(row.id, `suites[${index}].id`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new Error(`suites[${index}].id must use lowercase kebab-case.`);
  }
  const kind = row.kind;
  if (kind !== 'command' && kind !== 'conversation' && kind !== 'trigger') {
    throw new Error(`suites[${index}].kind must be command, conversation, or trigger.`);
  }
  const profiles = parseStringArray(row.profiles, `suites[${index}].profiles`);
  for (const profile of profiles) {
    if (!profileIds.has(profile)) {
      throw new Error(`suites[${index}] references unknown profile "${profile}".`);
    }
  }
  const skills = parseStringArray(row.skills, `suites[${index}].skills`);
  const uniqueSkills = new Set<string>();
  for (const [skillIndex, participant] of skills.entries()) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(participant)) {
      throw new Error(`suites[${index}].skills[${skillIndex}] must use lowercase kebab-case.`);
    }
    if (uniqueSkills.has(participant)) {
      throw new Error(`suites[${index}].skills has duplicate Skill "${participant}".`);
    }
    uniqueSkills.add(participant);
  }
  if (!uniqueSkills.has(skill)) {
    throw new Error(`suites[${index}].skills must include owner Skill "${skill}".`);
  }
  const rawSplits = row.releaseSplits ?? [];
  if (!Array.isArray(rawSplits)) {
    throw new Error(`suites[${index}].releaseSplits must be an array.`);
  }
  const releaseSplits = rawSplits.map((entry, splitIndex) => {
    const split = expectString(entry, `suites[${index}].releaseSplits[${splitIndex}]`);
    if (!VALID_SPLITS.has(split as PluginEvalSplit)) {
      throw new Error(`Unsupported release split "${split}" in suite "${id}".`);
    }
    return split as PluginEvalSplit;
  });
  const common = {
    id,
    skill,
    skills,
    profiles,
    defaultRuns: expectPositiveInteger(row.defaultRuns, `suites[${index}].defaultRuns`),
    releaseSplits,
    requiredForRelease: expectBoolean(
      row.requiredForRelease,
      `suites[${index}].requiredForRelease`,
    ),
    perRunTimeoutMs: expectPositiveInteger(
      row.perRunTimeoutMs,
      `suites[${index}].perRunTimeoutMs`,
    ),
  };

  if (kind === 'conversation') {
    expectOnlyKeys(row, [
      'id', 'kind', 'skills', 'cases', 'profiles', 'defaultRuns', 'releaseSplits',
      'requiredForRelease', 'perRunTimeoutMs', 'isolation',
    ], `suites[${index}]`);
    return {
      ...common,
      kind,
      cases: validateEvalRelativeFile(
        pluginRoot,
        evalRoot,
        row.cases,
        `suites[${index}].cases`,
      ),
      isolation: parseIsolation(row.isolation, `suites[${index}].isolation`),
    };
  }

  if (kind === 'trigger') {
    expectOnlyKeys(row, [
      'id', 'kind', 'skills', 'cases', 'fixtureModule', 'observeSpawnAgent', 'isolation',
      'strictNegativeSplits', 'minimumPassRate', 'forbidMultipleSkillLoads',
      'profiles', 'defaultRuns', 'releaseSplits',
      'requiredForRelease', 'perRunTimeoutMs',
    ], `suites[${index}]`);
    const isolation = parseIsolation(row.isolation, `suites[${index}].isolation`);
    const rawStrictNegativeSplits = row.strictNegativeSplits ?? [];
    if (!Array.isArray(rawStrictNegativeSplits)) {
      throw new Error(`suites[${index}].strictNegativeSplits must be an array.`);
    }
    const strictNegativeSplits = rawStrictNegativeSplits.map((entry, splitIndex) => {
      const split = expectString(
        entry,
        `suites[${index}].strictNegativeSplits[${splitIndex}]`,
      );
      if (!VALID_TRIGGER_CASE_SPLITS.has(split as PluginEvalTriggerCase['split'])) {
        throw new Error(`Unsupported strict negative split "${split}" in suite "${id}".`);
      }
      return split as PluginEvalTriggerCase['split'];
    });
    const fixtureModule = row.fixtureModule === undefined
      ? undefined
      : validateEvalRelativeFile(
        pluginRoot,
        evalRoot,
        row.fixtureModule,
        `suites[${index}].fixtureModule`,
      );
    if (fixtureModule && path.extname(fixtureModule) !== '.mjs') {
      throw new Error(`suites[${index}].fixtureModule must reference an .mjs file.`);
    }
    return {
      ...common,
      kind,
      cases: validateEvalRelativeFile(
        pluginRoot,
        evalRoot,
        row.cases,
        `suites[${index}].cases`,
      ),
      ...(fixtureModule ? { fixtureModule } : {}),
      observeSpawnAgent: expectBoolean(
        row.observeSpawnAgent,
        `suites[${index}].observeSpawnAgent`,
      ),
      isolation,
      strictNegativeSplits,
      ...(row.minimumPassRate === undefined ? {} : {
        minimumPassRate: expectRate(
          row.minimumPassRate,
          `suites[${index}].minimumPassRate`,
        ),
      }),
      forbidMultipleSkillLoads: row.forbidMultipleSkillLoads === undefined
        ? false
        : expectBoolean(
          row.forbidMultipleSkillLoads,
          `suites[${index}].forbidMultipleSkillLoads`,
        ),
    };
  }

  const rawSupports = row.supports ?? [];
  expectOnlyKeys(row, [
    'id', 'kind', 'skills', 'entry', 'cases', 'profiles', 'defaultRuns', 'releaseSplits',
    'requiredForRelease', 'perRunTimeoutMs', 'suiteTimeoutMs', 'supports',
  ], `suites[${index}]`);
  if (!Array.isArray(rawSupports)) {
    throw new Error(`suites[${index}].supports must be an array.`);
  }
  const supports = rawSupports.map((entry, supportIndex) => {
    const support = expectString(entry, `suites[${index}].supports[${supportIndex}]`);
    if (!VALID_SUPPORTS.has(support as PluginEvalCommandSuite['supports'][number])) {
      throw new Error(`Unsupported command capability "${support}" in suite "${id}".`);
    }
    return support as PluginEvalCommandSuite['supports'][number];
  });
  const suiteTimeoutMs = expectPositiveInteger(
    row.suiteTimeoutMs,
    `suites[${index}].suiteTimeoutMs`,
  );
  if (suiteTimeoutMs < common.perRunTimeoutMs) {
    throw new Error(
      `suites[${index}].suiteTimeoutMs must be greater than or equal to perRunTimeoutMs.`,
    );
  }
  const cases = row.cases === undefined
    ? undefined
    : validateEvalRelativeFile(
      pluginRoot,
      evalRoot,
      row.cases,
      `suites[${index}].cases`,
    );
  if (supports.includes('case') && !cases) {
    throw new Error(`suites[${index}].cases is required when supports includes case.`);
  }
  if (cases && !supports.includes('case')) {
    throw new Error(`suites[${index}].cases requires supports to include case.`);
  }
  return {
    ...common,
    kind,
    entry: validateEvalRelativeFile(
      pluginRoot,
      evalRoot,
      row.entry,
      `suites[${index}].entry`,
    ),
    ...(cases ? { cases } : {}),
    suiteTimeoutMs,
    supports,
  };
}

function validatePluginEvalCommandCaseDocument(
  value: unknown,
  skill: string,
  label: string,
): void {
  const document = expectRecord(value, label);
  if (document.skill_name !== skill) {
    throw new Error(`${label}.skill_name must be ${JSON.stringify(skill)}.`);
  }
  if (!Array.isArray(document.evals) || document.evals.length === 0) {
    throw new Error(`${label}.evals must be a non-empty array.`);
  }
  const ids = document.evals.map((entry, index) => {
    const row = expectRecord(entry, `${label}.evals[${index}]`);
    const id = expectString(row.id, `${label}.evals[${index}].id`);
    if (!/^[a-z0-9_]+$/u.test(id)) {
      throw new Error(`${label}.evals[${index}].id must use lowercase letters, digits, and underscores.`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label}.evals contains duplicate ids.`);
  }
}

function parseTriggerCase(
  value: unknown,
  index: number,
  suite: PluginEvalTriggerSuite,
): PluginEvalTriggerCase {
  const row = expectRecord(value, `trigger cases[${index}]`);
  const id = expectString(row.id, `trigger cases[${index}].id`);
  if (!/^[a-z0-9][a-z0-9_]*$/u.test(id)) {
    throw new Error(`trigger cases[${index}].id must use lowercase snake_case.`);
  }
  const split = expectString(row.split, `trigger cases[${index}].split`);
  if (!VALID_TRIGGER_CASE_SPLITS.has(split as PluginEvalTriggerCase['split'])) {
    throw new Error(`trigger cases[${index}].split must be train, validation, or sanity.`);
  }
  const shouldSpawnAgent = row.should_spawn_agent === undefined
    ? undefined
    : expectBoolean(row.should_spawn_agent, `trigger cases[${index}].should_spawn_agent`);
  if (suite.observeSpawnAgent && shouldSpawnAgent === undefined) {
    throw new Error(
      `trigger cases[${index}].should_spawn_agent is required when observeSpawnAgent=true.`,
    );
  }
  if (!suite.observeSpawnAgent && shouldSpawnAgent !== undefined) {
    throw new Error(
      `trigger cases[${index}].should_spawn_agent requires observeSpawnAgent=true.`,
    );
  }
  const workspaceFixture = row.workspace_fixture === undefined
    ? undefined
    : expectString(row.workspace_fixture, `trigger cases[${index}].workspace_fixture`);
  const useProjectRules = row.use_project_rules === undefined
    ? undefined
    : expectBoolean(row.use_project_rules, `trigger cases[${index}].use_project_rules`);
  let tags: string[] | undefined;
  if (row.tags !== undefined) {
    tags = parseStringArray(row.tags, `trigger cases[${index}].tags`);
  }
  const usesLegacyExpectation = row.should_load_skill !== undefined;
  const usesRouteExpectation = row.expected_loaded_skills !== undefined;
  if (usesLegacyExpectation === usesRouteExpectation) {
    throw new Error(
      `trigger cases[${index}] must declare exactly one of should_load_skill or expected_loaded_skills.`,
    );
  }
  let expectedLoadedSkills: string[] | undefined;
  if (usesRouteExpectation) {
    if (!Array.isArray(row.expected_loaded_skills)) {
      throw new Error(`trigger cases[${index}].expected_loaded_skills must be an array.`);
    }
    expectedLoadedSkills = row.expected_loaded_skills.map((entry, skillIndex) =>
      expectString(entry, `trigger cases[${index}].expected_loaded_skills[${skillIndex}]`));
    if (new Set(expectedLoadedSkills).size !== expectedLoadedSkills.length) {
      throw new Error(
        `trigger cases[${index}].expected_loaded_skills must not contain duplicates.`,
      );
    }
    const unknownSkill = expectedLoadedSkills.find((entry) => !suite.skills.includes(entry));
    if (unknownSkill) {
      throw new Error(
        `trigger cases[${index}].expected_loaded_skills contains non-participant Skill "${unknownSkill}".`,
      );
    }
    if (suite.forbidMultipleSkillLoads && expectedLoadedSkills.length > 1) {
      throw new Error(
        `trigger cases[${index}] expects multiple Skills but suite "${suite.id}" forbids multiple Skill loads.`,
      );
    }
  }
  return {
    id,
    split: split as PluginEvalTriggerCase['split'],
    query: expectString(row.query, `trigger cases[${index}].query`),
    ...(usesLegacyExpectation ? {
      should_load_skill: expectBoolean(
        row.should_load_skill,
        `trigger cases[${index}].should_load_skill`,
      ),
    } : { expected_loaded_skills: expectedLoadedSkills! }),
    ...(shouldSpawnAgent === undefined ? {} : { should_spawn_agent: shouldSpawnAgent }),
    ...(workspaceFixture ? { workspace_fixture: workspaceFixture } : {}),
    ...(useProjectRules === undefined ? {} : { use_project_rules: useProjectRules }),
    ...(tags ? { tags } : {}),
  };
}

export async function readPluginEvalTriggerCases(
  pluginRoot: string,
  suite: PluginEvalTriggerSuite,
): Promise<PluginEvalTriggerCaseDocument> {
  const casesPath = path.resolve(pluginRoot, suite.cases.replace(/^\.\//u, ''));
  const raw = expectRecord(await fs.readJson(casesPath), `trigger cases for suite "${suite.id}"`);
  if (raw.schemaVersion !== PLUGIN_EVAL_CASE_SCHEMA_VERSION) {
    throw new Error(
      `trigger cases for suite "${suite.id}" must use schemaVersion ${PLUGIN_EVAL_CASE_SCHEMA_VERSION}.`,
    );
  }
  const skill = expectString(raw.skill, `trigger cases for suite "${suite.id}".skill`);
  if (skill !== suite.skill) {
    throw new Error(
      `trigger cases skill "${skill}" does not match suite skill "${suite.skill}".`,
    );
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`trigger cases for suite "${suite.id}" must contain a non-empty cases array.`);
  }
  const cases = raw.cases.map((entry, index) => parseTriggerCase(entry, index, suite));
  assertUniqueIds(cases, 'trigger case');
  if (!suite.fixtureModule && cases.some((entry) => entry.workspace_fixture)) {
    throw new Error(
      `Trigger suite "${suite.id}" requires fixtureModule because cases declare workspace_fixture.`,
    );
  }
  for (const split of suite.releaseSplits) {
    if (split !== 'all' && !cases.some((entry) => entry.split === split)) {
      throw new Error(`Trigger suite "${suite.id}" has no cases for release split "${split}".`);
    }
  }
  return {
    schemaVersion: PLUGIN_EVAL_CASE_SCHEMA_VERSION,
    skill,
    cases,
  };
}

function resolveDeclaredPluginPath(
  pluginRoot: string,
  declaredPath: string,
  label: string,
): string {
  const resolved = path.resolve(pluginRoot, declaredPath.replace(/^\.\//u, ''));
  if (!isPathInsideOrEqual(pluginRoot, resolved)) {
    throw new Error(`${label} must stay inside the plugin root.`);
  }
  return resolved;
}

export async function resolvePluginSkillAuthorRoot(
  pluginRoot: string,
  expectedSkill: string,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(expectedSkill)) {
    throw new Error('Skill name must use lowercase kebab-case without path separators.');
  }
  const pluginManifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const pluginManifest = expectRecord(
    await fs.readJson(pluginManifestPath),
    'plugin manifest',
  );
  const canonicalRoot = path.join(pluginRoot, 'skills', expectedSkill);
  let declared = false;
  if (typeof pluginManifest.skills === 'string' && pluginManifest.skills.trim() !== '') {
    const skillsRoot = resolveDeclaredPluginPath(pluginRoot, pluginManifest.skills, 'plugin manifest.skills');
    if (path.resolve(skillsRoot) !== path.resolve(pluginRoot, 'skills')) {
      throw new Error('plugin manifest.skills must be "./skills".');
    }
    declared = await fs.pathExists(canonicalRoot);
  }
  const artifacts = isRecord(pluginManifest.artifacts) &&
    Array.isArray(pluginManifest.artifacts.targets)
    ? pluginManifest.artifacts.targets
    : [];
  for (const value of artifacts) {
    if (!isRecord(value) || value.target !== 'codex.skill' || value.skillKey !== expectedSkill) {
      continue;
    }
    const sourceDirs = Array.isArray(value.sourceDirs) ? value.sourceDirs : [];
    for (const [index, sourceDir] of sourceDirs.entries()) {
      if (typeof sourceDir !== 'string' || sourceDir.trim() === '') continue;
      const candidate = resolveDeclaredPluginPath(
        pluginRoot,
        sourceDir,
        `codex.skill ${JSON.stringify(expectedSkill)} sourceDirs[${index}]`,
      );
      const relative = path.relative(canonicalRoot, candidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(
          `Dynamic Skill source directory must stay inside skills/${expectedSkill}.`,
        );
      }
      assertRealPathInside(pluginRoot, candidate, 'Dynamic Skill source directory', 'plugin root');
    }
    if (sourceDirs.length > 0) declared = true;
  }
  if (!declared) {
    throw new Error(
      `Plugin does not declare a Codex Skill source directory for ${JSON.stringify(expectedSkill)}.`,
    );
  }
  if (!(await fs.pathExists(canonicalRoot)) || !(await fs.stat(canonicalRoot)).isDirectory()) {
    throw new Error(`Plugin Skill source root not found: ${canonicalRoot}`);
  }
  assertRealPathInside(pluginRoot, canonicalRoot, 'Skill root', 'plugin root');
  return canonicalRoot;
}

export async function readPluginEvalManifest(
  pluginRoot: string,
  expectedSkill: string,
  expectedPluginName?: string,
): Promise<PluginEvalManifest> {
  const skillRoot = await resolvePluginSkillAuthorRoot(pluginRoot, expectedSkill);
  const evalRoot = path.join(skillRoot, 'evals');
  const manifestPath = path.join(evalRoot, 'manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    const legacyPath = path.join(pluginRoot, 'evals', 'manifest.json');
    if (await fs.pathExists(legacyPath)) {
      throw new Error(
        `Legacy plugin-wide eval manifest is not supported: ${legacyPath}. ` +
        `Move it to the ${expectedSkill} Skill directory as evals/manifest.json ` +
        'and use schemaVersion 2.',
      );
    }
    throw new Error(`Plugin eval manifest not found: ${manifestPath}`);
  }
  const raw = expectRecord(await fs.readJson(manifestPath), 'eval manifest');
  expectOnlyKeys(raw, ['schemaVersion', 'plugin', 'skill', 'profiles', 'suites'], 'eval manifest');
  if (raw.schemaVersion !== PLUGIN_EVAL_SCHEMA_VERSION) {
    throw new Error(`eval manifest schemaVersion must be ${PLUGIN_EVAL_SCHEMA_VERSION}.`);
  }
  const plugin = expectString(raw.plugin, 'eval manifest.plugin');
  if (expectedPluginName && plugin !== expectedPluginName) {
    throw new Error(
      `eval manifest.plugin "${plugin}" does not match plugin "${expectedPluginName}".`,
    );
  }
  const skill = expectString(raw.skill, 'eval manifest.skill');
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(skill)) {
    throw new Error('eval manifest.skill must use lowercase kebab-case.');
  }
  if (skill !== expectedSkill) {
    throw new Error(
      `eval manifest.skill "${skill}" does not match selected Skill "${expectedSkill}".`,
    );
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
    throw new Error('eval manifest.profiles must be a non-empty array.');
  }
  const profiles = raw.profiles.map((profile, index) =>
    parseProfile(profile, index, plugin));
  assertUniqueIds(profiles, 'profile');
  if (!profiles.some((profile) => profile.scope === 'project' && profile.runModel)) {
    throw new Error('eval manifest must define at least one project profile with runModel=true.');
  }
  if (profiles.some((profile) => profile.scope === 'user' && profile.runModel)) {
    throw new Error('v2 does not allow real model execution for user-scope profiles.');
  }
  if (!Array.isArray(raw.suites) || raw.suites.length === 0) {
    throw new Error('eval manifest.suites must be a non-empty array.');
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const suites = raw.suites.map((suite, index) =>
    parseSuite(pluginRoot, evalRoot, skill, suite, index, profileIds));
  assertUniqueIds(suites, 'suite');
  for (const suite of suites) {
    for (const profileId of suite.profiles) {
      const profile = profiles.find((entry) => entry.id === profileId)!;
      if (!profile.runModel) {
        throw new Error(`Suite "${suite.id}" cannot execute materialize-only profile "${profileId}".`);
      }
    }
    if (suite.releaseSplits.length > 0 && suite.kind === 'command' && !suite.supports.includes('split')) {
      throw new Error(`Suite "${suite.id}" declares releaseSplits but does not support split.`);
    }
    if (suite.kind === 'conversation' && suite.releaseSplits.length > 0) {
      throw new Error(
        `Conversation suite "${suite.id}" cannot declare releaseSplits because conversation cases do not support split filtering.`,
      );
    }
    if (suite.kind === 'trigger') {
      await readPluginEvalTriggerCases(pluginRoot, suite);
    } else if (suite.kind === 'conversation') {
      const casesPath = path.resolve(pluginRoot, suite.cases.replace(/^\.\//u, ''));
      validatePluginEvalConversationCaseDocument(
        await fs.readJson(casesPath),
        suite.skill,
        `conversation cases for suite "${suite.id}"`,
      );
    } else if (suite.cases) {
      const casesPath = path.resolve(pluginRoot, suite.cases.replace(/^\.\//u, ''));
      validatePluginEvalCommandCaseDocument(
        await fs.readJson(casesPath),
        suite.skill,
        `command cases for suite "${suite.id}"`,
      );
    }
  }
  return {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    plugin,
    skill,
    profiles,
    suites,
  };
}

export function combinePluginEvalOutcome(
  reports: readonly Pick<PluginEvalSuiteReport, 'outcome'>[],
): PluginEvalOutcome {
  if (reports.some((report) => report.outcome === 'incomplete')) {
    return 'incomplete';
  }
  if (reports.some((report) => report.outcome === 'failed')) {
    return 'failed';
  }
  if (reports.some((report) => report.outcome === 'needs_review')) {
    return 'needs_review';
  }
  return 'passed';
}
