import path from 'node:path';

import fs from 'fs-extra';

import type { Scope } from '../src/types.js';

export const PLUGIN_EVAL_SCHEMA_VERSION = 1 as const;

export type PluginEvalSplit = 'train' | 'validation' | 'sanity' | 'all';
export type PluginEvalOutcome = 'passed' | 'failed' | 'needs_review' | 'incomplete';
export type PluginEvalIsolation = 'standard' | 'strict';

export interface PluginEvalProfile {
  id: string;
  scope: Scope;
  config: Record<string, unknown>;
  runModel: boolean;
  requiredForRelease: boolean;
}

export interface PluginEvalCommandSuite {
  id: string;
  kind: 'command';
  entry: string;
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
  cases: string;
  fixtureModule?: string;
  observeSpawnAgent: boolean;
  isolation: PluginEvalIsolation;
  strictNegativeSplits: Array<Exclude<PluginEvalSplit, 'all'>>;
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
  should_load_skill: boolean;
  should_spawn_agent?: boolean;
  workspace_fixture?: string;
  use_project_rules?: boolean;
  tags?: string[];
}

export interface PluginEvalTriggerCaseDocument {
  schemaVersion: typeof PLUGIN_EVAL_SCHEMA_VERSION;
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
  pluginVersion: string;
  platform: 'codex';
  profile: string;
  scope: Scope;
  modelExecution: boolean;
  evidenceLevel: 'runtime-project' | 'materialized-user';
  root: string;
  configDigest: string;
  bundleDigest: string;
  artifacts: MaterializedPluginEvalArtifact[];
}

export interface PluginEvalSuiteReport {
  id: string;
  kind: PluginEvalSuite['kind'];
  profile: string;
  split: PluginEvalSplit | null;
  outcome: PluginEvalOutcome;
  complete: boolean;
  mechanicalPassed: boolean;
  qualitativeReview: 'not_required' | 'required' | 'passed' | 'failed';
  reportPath?: string;
  summary: Record<string, unknown>;
  diagnostics: string[];
}

export interface PluginEvaluationBundle {
  schemaVersion: typeof PLUGIN_EVAL_SCHEMA_VERSION;
  generatedAt: string;
  plugin: string;
  pluginVersion: string;
  platform: 'codex';
  codexVersion: string | null;
  model: string | null;
  modelProvider: string | null;
  credentialSource: 'embedded' | 'environment' | 'openai-auth' | 'none' | null;
  codexConfigDigest: string | null;
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

function validateRelativeFile(pluginRoot: string, value: unknown, label: string): string {
  const relativePath = expectString(value, label).replace(/^\.\//, '');
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) {
    throw new Error(`${label} must stay inside the plugin root.`);
  }
  const absolutePath = path.resolve(pluginRoot, relativePath);
  const relativeToRoot = path.relative(pluginRoot, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay inside the plugin root.`);
  }
  if (!fs.pathExistsSync(absolutePath)) {
    throw new Error(`${label} does not exist: ${relativePath}`);
  }
  if (!fs.statSync(absolutePath).isFile()) {
    throw new Error(`${label} must reference a file: ${relativePath}`);
  }
  assertRealPathInside(pluginRoot, absolutePath, label, 'plugin root');
  return `./${relativePath.split(path.sep).join('/')}`;
}

function validateEvalRelativeFile(pluginRoot: string, value: unknown, label: string): string {
  const relativePath = validateRelativeFile(pluginRoot, value, label);
  if (!relativePath.startsWith('./evals/')) {
    throw new Error(`${label} must stay inside the plugin evals directory.`);
  }
  assertRealPathInside(
    path.join(pluginRoot, 'evals'),
    path.resolve(pluginRoot, relativePath.replace(/^\.\//u, '')),
    label,
    'plugin evals directory',
  );
  return relativePath;
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
    if (!Array.isArray(row.scripted_replies)) {
      throw new Error(`${label}.evals[${index}].scripted_replies must be an array.`);
    }
    row.scripted_replies.forEach((reply, replyIndex) =>
      validateConversationReply(
        reply,
        `${label}.evals[${index}].scripted_replies[${replyIndex}]`,
      ));
    expectString(row.expected_output, `${label}.evals[${index}].expected_output`);
    const review = expectRecord(row.review, `${label}.evals[${index}].review`);
    parseStringArray(review.checks, `${label}.evals[${index}].review.checks`);
    if (review.workspace_unchanged !== undefined) {
      expectBoolean(
        review.workspace_unchanged,
        `${label}.evals[${index}].review.workspace_unchanged`,
      );
    }
    return row;
  });
}

function parseProfile(value: unknown, index: number): PluginEvalProfile {
  const row = expectRecord(value, `profiles[${index}]`);
  expectOnlyKeys(
    row,
    ['id', 'scope', 'config', 'runModel', 'requiredForRelease'],
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
  return {
    id,
    scope,
    config: row.config === undefined ? {} : expectRecord(row.config, `profiles[${index}].config`),
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
    const skill = expectString(row.skill, `suites[${index}].skill`);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(skill)) {
      throw new Error(`suites[${index}].skill must use lowercase kebab-case.`);
    }
    return {
      ...common,
      kind,
      skill,
      cases: validateEvalRelativeFile(pluginRoot, row.cases, `suites[${index}].cases`),
      isolation: parseIsolation(row.isolation, `suites[${index}].isolation`),
    };
  }

  if (kind === 'trigger') {
    const skill = expectString(row.skill, `suites[${index}].skill`);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(skill)) {
      throw new Error(`suites[${index}].skill must use lowercase kebab-case.`);
    }
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
        row.fixtureModule,
        `suites[${index}].fixtureModule`,
      );
    if (fixtureModule && path.extname(fixtureModule) !== '.mjs') {
      throw new Error(`suites[${index}].fixtureModule must reference an .mjs file.`);
    }
    return {
      ...common,
      kind,
      skill,
      cases: validateEvalRelativeFile(pluginRoot, row.cases, `suites[${index}].cases`),
      ...(fixtureModule ? { fixtureModule } : {}),
      observeSpawnAgent: expectBoolean(
        row.observeSpawnAgent,
        `suites[${index}].observeSpawnAgent`,
      ),
      isolation,
      strictNegativeSplits,
    };
  }

  const rawSupports = row.supports ?? [];
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
  return {
    ...common,
    kind,
    entry: validateRelativeFile(pluginRoot, row.entry, `suites[${index}].entry`),
    suiteTimeoutMs,
    supports,
  };
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
  return {
    id,
    split: split as PluginEvalTriggerCase['split'],
    query: expectString(row.query, `trigger cases[${index}].query`),
    should_load_skill: expectBoolean(
      row.should_load_skill,
      `trigger cases[${index}].should_load_skill`,
    ),
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
  if (raw.schemaVersion !== PLUGIN_EVAL_SCHEMA_VERSION) {
    throw new Error(
      `trigger cases for suite "${suite.id}" must use schemaVersion ${PLUGIN_EVAL_SCHEMA_VERSION}.`,
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
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    skill,
    cases,
  };
}

export async function readPluginEvalManifest(
  pluginRoot: string,
  expectedPluginName?: string,
): Promise<PluginEvalManifest> {
  const manifestPath = path.join(pluginRoot, 'evals', 'manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Plugin eval manifest not found: ${manifestPath}`);
  }
  const raw = expectRecord(await fs.readJson(manifestPath), 'eval manifest');
  if (raw.schemaVersion !== PLUGIN_EVAL_SCHEMA_VERSION) {
    throw new Error(`eval manifest schemaVersion must be ${PLUGIN_EVAL_SCHEMA_VERSION}.`);
  }
  const plugin = expectString(raw.plugin, 'eval manifest.plugin');
  if (expectedPluginName && plugin !== expectedPluginName) {
    throw new Error(
      `eval manifest.plugin "${plugin}" does not match plugin "${expectedPluginName}".`,
    );
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
    throw new Error('eval manifest.profiles must be a non-empty array.');
  }
  const profiles = raw.profiles.map(parseProfile);
  assertUniqueIds(profiles, 'profile');
  if (!profiles.some((profile) => profile.scope === 'project' && profile.runModel)) {
    throw new Error('eval manifest must define at least one project profile with runModel=true.');
  }
  if (profiles.some((profile) => profile.scope === 'user' && profile.runModel)) {
    throw new Error('v1 does not allow real model execution for user-scope profiles.');
  }
  if (!Array.isArray(raw.suites) || raw.suites.length === 0) {
    throw new Error('eval manifest.suites must be a non-empty array.');
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const suites = raw.suites.map((suite, index) =>
    parseSuite(pluginRoot, suite, index, profileIds));
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
    }
  }
  return {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    plugin,
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
