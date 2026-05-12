import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import type {
  CatalogResolution,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeInstallOptions,
  InstalledScopeRecord,
  LifecycleConfigSnapshotMetadata,
  PlatformName,
  PluginMeta,
  Scope,
  SkillTriggerApplicability,
  SkillTriggerPreference,
} from '../types.js';
import { renderCodexOpenAiYamlWithAllowImplicitInvocation } from './codex-skill-staging.js';
import { readPluginManifest } from './manifest.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from './plugin-scripts.js';

type ParsedTriggerBoolean = boolean | 'absent';

const CODEX_DEFAULT_ALLOW_IMPLICIT_INVOCATION = true;
const CLAUDE_DEFAULT_DISABLE_MODEL_INVOCATION = false;
const CLAUDE_DEFAULT_USER_INVOCABLE = true;

function normalizeCodexAllowImplicitInvocation(value: ParsedTriggerBoolean): boolean {
  return value === 'absent' ? CODEX_DEFAULT_ALLOW_IMPLICIT_INVOCATION : value;
}

function normalizeClaudeDisableModelInvocation(value: ParsedTriggerBoolean): boolean {
  return value === 'absent' ? CLAUDE_DEFAULT_DISABLE_MODEL_INVOCATION : value;
}

function normalizeClaudeUserInvocable(value: ParsedTriggerBoolean): boolean {
  return value === 'absent' ? CLAUDE_DEFAULT_USER_INVOCABLE : value;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createTempDirectoryName(prefix: string): string {
  return `.${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isInsidePath(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function serializeComparableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => JSON.parse(serializeComparableValue(entry))));
  }

  if (isRecord(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, JSON.parse(serializeComparableValue(entry))]),
      ),
    );
  }

  return JSON.stringify(value);
}

async function listSkillDirectories(rootDir: string): Promise<string[]> {
  if (!(await fs.pathExists(rootDir))) {
    return [];
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function getEmbeddedPluginRoot(embeddedRoot: string, pluginName: string): string {
  return path.join(embeddedRoot, 'plugins', pluginName);
}

function getSkillTriggerSourcePluginRoot(options: {
  embeddedRoot: string;
  pluginName: string;
  sourcePluginRoot?: string;
}): string {
  return options.sourcePluginRoot ?? getEmbeddedPluginRoot(options.embeddedRoot, options.pluginName);
}

function getMarketplacePluginRoot(marketplaceRoot: string, pluginName: string): string {
  return path.join(marketplaceRoot, 'plugins', pluginName);
}

function getRepoSkillRoot(repoSkillsRoot: string, skillName: string): string {
  return path.join(repoSkillsRoot, skillName);
}

function getPlatformSkillsRoot(
  pluginRoot: string,
  platform: PlatformName,
): string {
  return path.join(pluginRoot, platform, 'skills');
}

function getCodexSkillMetadataPath(pluginRoot: string, skillName: string): string {
  return path.join(pluginRoot, 'codex', 'skills', skillName, 'agents', 'openai.yaml');
}

function getClaudeSkillMetadataPath(pluginRoot: string, skillName: string): string {
  return path.join(pluginRoot, 'claude', 'skills', skillName, 'SKILL.md');
}

function getTargetSkillRoot(
  target: SkillTriggerMaterializationTarget,
  pluginName: string,
  skillName: string,
): string {
  if (target.kind === 'repoSkill') {
    return getRepoSkillRoot(target.root, skillName);
  }

  return path.join(
    getPlatformSkillsRoot(getMarketplacePluginRoot(target.root, pluginName), target.platform),
    skillName,
  );
}

function createLegacyMaterializationTarget(options: {
  marketplaceRootOrStagingRoot: string;
  platform: PlatformName;
}): SkillTriggerMaterializationTarget {
  return options.platform === 'codex'
    ? {
        platform: 'codex',
        scope: 'user',
        kind: 'localMarketplaceRuntime',
        root: options.marketplaceRootOrStagingRoot,
      }
    : {
        platform: 'claude',
        scope: 'user',
        kind: 'localMarketplaceRuntime',
        root: options.marketplaceRootOrStagingRoot,
      };
}

export function classifySharedSkillTriggerRuntimeTarget(
  target: SkillTriggerMaterializationTarget,
): SharedSkillTriggerRuntimeTargetKind {
  if (target.platform === 'codex' && target.scope === 'project' && target.kind === 'repoSkill') {
    return 'repoLocalCodexProject';
  }

  return 'sharedRuntime';
}

export function participatesInSharedSkillTriggerRuntimeOwner(
  target: SkillTriggerMaterializationTarget,
): boolean {
  return classifySharedSkillTriggerRuntimeTarget(target) === 'sharedRuntime';
}

function normalizeYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillTriggerPolicyEntry {
  skillName: string;
  allowInstallOverride: boolean;
  allowInstallOverrideDeclared: boolean;
  codexFilePath: string;
  claudeFilePath: string;
}

export interface SkillTriggerPolicyResolution {
  pluginName: string;
  manifestPath: string;
  pluginRoot: string;
  platform: PlatformName;
  applicability: SkillTriggerApplicability;
  policies: SkillTriggerPolicyEntry[];
}

export interface SkillTriggerDiagnostic {
  pluginName: string;
  platform: PlatformName;
  skillName: string;
  filePath: string;
  reason: string;
}

interface CodexSkillSignatureEntry {
  skillName: string;
  allowInstallOverride: boolean;
  allowImplicitInvocation: boolean;
}

interface ClaudeSkillSignatureEntry {
  skillName: string;
  allowInstallOverride: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
}

type SkillTriggerSignatureEntry = CodexSkillSignatureEntry | ClaudeSkillSignatureEntry;

export interface KnownSkillTriggerSignature {
  status: 'known';
  pluginName: string;
  platform: PlatformName;
  preference: SkillTriggerPreference | 'runtime';
  signature: string;
  entries: SkillTriggerSignatureEntry[];
}

export interface UnknownSkillTriggerSignature {
  status: 'unknown';
  pluginName: string;
  platform: PlatformName;
  preference: SkillTriggerPreference | 'runtime';
  diagnostics: SkillTriggerDiagnostic[];
}

export type SkillTriggerSignatureResult =
  | KnownSkillTriggerSignature
  | UnknownSkillTriggerSignature;

export type SkillTriggerMaterializationMode = 'strictExplicit' | 'bestEffortReplay';

export type SkillTriggerMaterializationTarget =
  | { platform: 'codex'; scope: 'user'; kind: 'localMarketplaceRuntime'; root: string }
  | { platform: 'codex'; scope: 'project'; kind: 'repoSkill'; root: string }
  | { platform: 'claude'; scope: Scope; kind: 'localMarketplaceRuntime'; root: string };

export type SharedSkillTriggerRuntimeTargetKind = 'sharedRuntime' | 'repoLocalCodexProject';

export interface SharedSkillTriggerRuntimeSemanticsAssessment {
  pluginName: string;
  platform: PlatformName;
  locationScope: Scope;
  targetKind: SharedSkillTriggerRuntimeTargetKind;
  participatesInSharedRuntimeOwner: boolean;
  semanticDelta: 'change' | 'noChange' | 'unknown';
  currentRuntimeSignature: SkillTriggerSignatureResult | null;
  plannedRuntimeSignature: SkillTriggerSignatureResult | null;
}

export interface SkillTriggerMaterializationRollbackHandle {
  committed: boolean;
  targetSkillsRoot: string;
  backupSkillsRoot: string | null;
  operations: Array<{
    targetSkillsRoot: string;
    backupSkillsRoot: string | null;
  }>;
}

export interface SkillTriggerMaterializationSummary {
  status: 'pristine' | 'patched' | 'skipped';
  preference: SkillTriggerPreference;
  patchedSkills: string[];
  skippedSkills: string[];
}

export interface SkillTriggerMaterializationResult {
  committed: boolean;
  summary: SkillTriggerMaterializationSummary;
  warnings: string[];
  rollbackHandle: SkillTriggerMaterializationRollbackHandle;
  generatedArtifacts: GeneratedArtifact[];
}

export interface SkillTriggerReplayResult {
  warnings: string[];
}

export interface SkillTriggerPostUninstallMaterializationResult {
  warnings: string[];
  materialization?: SkillTriggerMaterializationResult;
}

export interface EffectiveSkillTriggerRecord {
  scopeIdentity: string;
  preference: SkillTriggerPreference;
  writeOrder: number | null;
  updatedAt: string;
  record: InstalledScopeRecord<Record<string, unknown>>;
}

export interface SkillTriggerSiblingConflictResult {
  warnings: string[];
  diagnostics: string[];
}

export interface SkillTriggerStatusReportFields {
  skillTriggerApplicability: SkillTriggerApplicability;
  installOptions?: InstalledScopeInstallOptions;
  skillTriggerPreference?: SkillTriggerPreference;
  skillTriggerRuntimeMatches?: SkillTriggerPreference[];
  skillTriggerRuntimeState?: 'matched' | 'mixed' | 'unknown';
  skillTriggerDrift?: 'yes' | 'no' | 'unknown';
  warnings: string[];
}

function buildSkillTriggerError(options: {
  pluginName: string;
  platform: PlatformName;
  skillName: string;
  filePath: string;
  reason: string;
}): Error {
  return new Error(
    `${options.pluginName} 的 ${options.platform} skill trigger 无法物化：skill=${options.skillName} file=${options.filePath} ${options.reason}`,
  );
}

async function embeddedPlatformSkillsRootExists(
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
): Promise<boolean> {
  return fs.pathExists(
    getPlatformSkillsRoot(getEmbeddedPluginRoot(embeddedRoot, pluginName), platform),
  );
}

async function marketplacePlatformSkillsRootExists(
  marketplaceRoot: string,
  pluginName: string,
  platform: PlatformName,
): Promise<boolean> {
  return fs.pathExists(
    getPlatformSkillsRoot(getMarketplacePluginRoot(marketplaceRoot, pluginName), platform),
  );
}

type SkillTriggerReplaySourceValidationResult =
  | {
    status: 'ok';
    sourcePluginRoot: string;
  }
  | {
    status: 'invalid';
    reason: string;
  };

type SnapshotReplayValidationResult =
  | {
    status: 'ok';
    sourcePluginRoot: string;
  }
  | {
    status: 'invalid';
    reason: string;
  };

async function validateSkillTriggerReplaySource(options: {
  pluginName: string;
  platform: PlatformName;
  sourcePluginRoot: string;
}): Promise<SkillTriggerReplaySourceValidationResult> {
  let sourcePluginRoot: string;
  let plugin: PluginMeta;
  try {
    sourcePluginRoot = await fs.realpath(options.sourcePluginRoot);
    plugin = await readPluginManifest(sourcePluginRoot, { mode: 'bundle' });
  } catch (error) {
    return {
      status: 'invalid',
      reason: `source bundle manifest 不可验证：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (plugin.manifest.name !== options.pluginName) {
    return {
      status: 'invalid',
      reason: `source bundle 属于 ${plugin.manifest.name}，不是 ${options.pluginName}`,
    };
  }

  const skillsRoot = getPlatformSkillsRoot(sourcePluginRoot, options.platform);
  if (!(await fs.pathExists(skillsRoot))) {
    return {
      status: 'invalid',
      reason: `缺少 ${options.platform} skill source 子树`,
    };
  }

  let resolution: SkillTriggerPolicyResolution;
  try {
    resolution = await resolveSkillTriggerPoliciesFromPluginRoot({
      pluginRoot: sourcePluginRoot,
      pluginName: plugin.manifest.name,
      manifestPath: plugin.manifestPath,
      manifest: plugin.manifest,
      platform: options.platform,
    });
  } catch (error) {
    return {
      status: 'invalid',
      reason: `skill trigger policy 不可解析：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const diagnostics: SkillTriggerDiagnostic[] = [];
  for (const policy of resolution.policies) {
    const filePath = options.platform === 'codex'
      ? policy.codexFilePath
      : policy.claudeFilePath;
    try {
      if (options.platform === 'codex') {
        await parseCodexSkillMetadata(filePath);
      } else {
        await parseClaudeSkillMetadata(filePath);
      }
    } catch (error) {
      diagnostics.push({
        pluginName: options.pluginName,
        platform: options.platform,
        skillName: policy.skillName,
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      status: 'invalid',
      reason: `skill metadata 不可验证：${formatSignatureDiagnostics(diagnostics)}`,
    };
  }

  return {
    status: 'ok',
    sourcePluginRoot,
  };
}

async function validateLifecycleSnapshotForSkillTriggerReplay(options: {
  pluginName: string;
  platform: PlatformName;
  snapshot: LifecycleConfigSnapshotMetadata;
  currentPlugin?: PluginMeta;
  currentSourcePluginRoot?: string;
}): Promise<SnapshotReplayValidationResult> {
  const { snapshot } = options;

  if (snapshot.pluginName !== options.pluginName) {
    return {
      status: 'invalid',
      reason: `snapshot 属于 ${snapshot.pluginName}，不是 ${options.pluginName}`,
    };
  }

  let snapshotRoot: string;
  let bundleRoot: string;
  let manifestPath: string;
  try {
    snapshotRoot = await fs.realpath(snapshot.snapshotRoot);
    bundleRoot = await fs.realpath(snapshot.bundleRoot);
    const expectedBundleRoot = await fs.realpath(path.join(snapshotRoot, 'bundle'));
    if (bundleRoot !== expectedBundleRoot || !isInsidePath(bundleRoot, snapshotRoot)) {
      return {
        status: 'invalid',
        reason: 'snapshot bundle root 不在 snapshot root 内',
      };
    }

    manifestPath = await fs.realpath(snapshot.manifestPath);
    if (!isInsidePath(manifestPath, bundleRoot)) {
      return {
        status: 'invalid',
        reason: 'snapshot manifest path 不在 bundle root 内',
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: `snapshot 路径不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const [manifestDigest, bundleFingerprint, snapshotPlugin] = await Promise.all([
      calculateFileDigest(manifestPath),
      calculatePluginBundleFingerprint(bundleRoot),
      readPluginManifest(bundleRoot, { mode: 'bundle' }),
    ]);
    if (manifestDigest !== snapshot.sourceManifestDigest) {
      return {
        status: 'invalid',
        reason: 'snapshot manifest digest 与 ledger metadata 不一致',
      };
    }
    if (bundleFingerprint !== snapshot.bundleFingerprint) {
      return {
        status: 'invalid',
        reason: 'snapshot bundle fingerprint 与 ledger metadata 不一致',
      };
    }
    if (
      snapshotPlugin.manifest.name !== snapshot.pluginName ||
      snapshotPlugin.manifest.version !== snapshot.pluginVersion
    ) {
      return {
        status: 'invalid',
        reason: 'snapshot manifest identity 与 ledger metadata 不一致',
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: `snapshot 内容不可验证：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (options.currentPlugin && options.currentPlugin.manifest.version !== snapshot.pluginVersion) {
    return {
      status: 'invalid',
      reason: `snapshot version ${snapshot.pluginVersion} 与当前 bundle version ${options.currentPlugin.manifest.version} 不一致`,
    };
  }

  if (options.currentSourcePluginRoot) {
    try {
      const currentPlugin = await readPluginManifest(options.currentSourcePluginRoot, { mode: 'bundle' });
      if (currentPlugin.manifest.name !== options.pluginName) {
        return {
          status: 'invalid',
          reason: `当前 bundle 属于 ${currentPlugin.manifest.name}，不是 ${options.pluginName}`,
        };
      }
      if (currentPlugin.manifest.version !== snapshot.pluginVersion) {
        return {
          status: 'invalid',
          reason: `snapshot version ${snapshot.pluginVersion} 与当前 bundle version ${currentPlugin.manifest.version} 不一致`,
        };
      }
    } catch (error) {
      return {
        status: 'invalid',
        reason: `当前 bundle 不可验证：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else if (!options.currentPlugin) {
    return {
      status: 'invalid',
      reason: '缺少当前 bundle 参照，无法判断 lifecycle snapshot 是否过期',
    };
  }

  if (!(await fs.pathExists(getPlatformSkillsRoot(bundleRoot, options.platform)))) {
    return {
      status: 'invalid',
      reason: `snapshot 缺少 ${options.platform} skill source 子树`,
    };
  }

  const sourceValidation = await validateSkillTriggerReplaySource({
    pluginName: options.pluginName,
    platform: options.platform,
    sourcePluginRoot: bundleRoot,
  });
  if (sourceValidation.status !== 'ok') {
    return {
      status: 'invalid',
      reason: `snapshot source 不可用于 skill trigger replay：${sourceValidation.reason}`,
    };
  }

  return {
    status: 'ok',
    sourcePluginRoot: sourceValidation.sourcePluginRoot,
  };
}

function getSkillTriggerApplicabilityFromAllowInstallOverrides(
  values: boolean[],
): SkillTriggerApplicability {
  if (values.length === 0) {
    return 'none';
  }

  return values.some((allowInstallOverride) => allowInstallOverride)
    ? 'overridable'
    : 'fixed';
}

function getSkillTriggerApplicabilityFromPolicies(
  policies: SkillTriggerPolicyEntry[],
): SkillTriggerApplicability {
  return getSkillTriggerApplicabilityFromAllowInstallOverrides(
    policies.map((policy) => policy.allowInstallOverride),
  );
}

function mergeSkillTriggerApplicability(
  values: SkillTriggerApplicability[],
): SkillTriggerApplicability {
  if (values.includes('overridable')) {
    return 'overridable';
  }
  if (values.includes('fixed')) {
    return 'fixed';
  }
  return 'none';
}

function getExcludedDynamicCodexSkillKeys(options: {
  manifest: PluginMeta['manifest'];
  platform: PlatformName;
}): Set<string> {
  if (options.platform !== 'codex') {
    return new Set();
  }

  return new Set(
    (options.manifest.artifacts?.targets ?? [])
      .filter((target) => target.platform === 'codex')
      .filter((target) => target.target === 'codex.skill')
      .map((target) => target.skillKey?.trim())
      .filter((skillKey): skillKey is string => Boolean(skillKey)),
  );
}

function getDynamicCodexSkillTriggerApplicability(options: {
  manifest: PluginMeta['manifest'];
  platform: PlatformName;
}): SkillTriggerApplicability {
  const skillKeys = [...getExcludedDynamicCodexSkillKeys(options)];
  if (skillKeys.length === 0) {
    return 'none';
  }

  const manifestPolicies = options.manifest.skillTriggers ?? {};
  return getSkillTriggerApplicabilityFromAllowInstallOverrides(
    skillKeys.map((skillName) => manifestPolicies[skillName]?.allowInstallOverride === true),
  );
}

async function resolveSkillTriggerPoliciesFromPluginRoot(options: {
  pluginRoot: string;
  pluginName: string;
  manifestPath: string;
  manifest: PluginMeta['manifest'];
  platform: PlatformName;
}): Promise<SkillTriggerPolicyResolution> {
  const manifestPolicies = options.manifest.skillTriggers ?? {};
  const excludedDynamicSkillKeys = getExcludedDynamicCodexSkillKeys({
    manifest: options.manifest,
    platform: options.platform,
  });
  const skillNames = await listSkillDirectories(
    getPlatformSkillsRoot(options.pluginRoot, options.platform),
  );
  const policies = skillNames
    .filter((skillName) => !excludedDynamicSkillKeys.has(skillName))
    .map((skillName) => {
      const policy = manifestPolicies[skillName];
      return {
        skillName,
        allowInstallOverride: policy?.allowInstallOverride === true,
        allowInstallOverrideDeclared: policy !== undefined && Object.hasOwn(policy, 'allowInstallOverride'),
        codexFilePath: getCodexSkillMetadataPath(options.pluginRoot, skillName),
        claudeFilePath: getClaudeSkillMetadataPath(options.pluginRoot, skillName),
      };
    });

  return {
    pluginName: options.pluginName,
    manifestPath: options.manifestPath,
    pluginRoot: options.pluginRoot,
    platform: options.platform,
    applicability: getSkillTriggerApplicabilityFromPolicies(policies),
    policies,
  };
}

export async function resolveSkillTriggerPolicies(options: {
  embeddedRoot: string;
  pluginName: string;
  platform: PlatformName;
  policyPlugin?: PluginMeta;
  sourcePluginRoot?: string;
}): Promise<SkillTriggerPolicyResolution> {
  const pluginRoot = getSkillTriggerSourcePluginRoot(options);
  const plugin = options.policyPlugin ?? await readPluginManifest(pluginRoot, { mode: 'bundle' });
  return resolveSkillTriggerPoliciesFromPluginRoot({
    pluginRoot,
    pluginName: plugin.manifest.name,
    manifestPath: plugin.manifestPath,
    manifest: plugin.manifest,
    platform: options.platform,
  });
}

export async function resolveSkillTriggerApplicabilityForPlugin(
  plugin: PluginMeta,
  platform: PlatformName,
): Promise<SkillTriggerApplicability> {
  const resolution = await resolveSkillTriggerPoliciesFromPluginRoot({
    pluginRoot: plugin.rootDir,
    pluginName: plugin.manifest.name,
    manifestPath: plugin.manifestPath,
    manifest: plugin.manifest,
    platform,
  });
  return mergeSkillTriggerApplicability([
    resolution.applicability,
    getDynamicCodexSkillTriggerApplicability({
      manifest: plugin.manifest,
      platform,
    }),
  ]);
}

interface ParsedCodexSkill {
  allowImplicitInvocation: ParsedTriggerBoolean;
}

async function parseCodexSkillMetadata(filePath: string): Promise<ParsedCodexSkill> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('缺少 agents/openai.yaml。');
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawContent);
  } catch (error) {
    throw new Error(`openai.yaml YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('openai.yaml 根节点必须是 object。');
  }

  const policy = parsed.policy;
  if (policy === undefined) {
    return {
      allowImplicitInvocation: 'absent',
    };
  }

  if (!isRecord(policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }

  const allowImplicitInvocation = policy.allow_implicit_invocation;
  if (allowImplicitInvocation === undefined) {
    return {
      allowImplicitInvocation: 'absent',
    };
  }

  if (typeof allowImplicitInvocation !== 'boolean') {
    throw new Error('openai.yaml 的 policy.allow_implicit_invocation 必须是 boolean。');
  }

  return {
    allowImplicitInvocation,
  };
}

interface ParsedClaudeFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseClaudeFrontmatter(rawContent: string): ParsedClaudeFrontmatter {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md 缺少 YAML frontmatter。');
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEof = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEof) {
    throw new Error('SKILL.md frontmatter 缺少结束分隔符。');
  }

  const yamlEndIndex = closingAtEof ? normalized.length - '\n---'.length : closingIndex;
  const yamlContent = normalized.slice(4, yamlEndIndex);
  const body = closingAtEof ? '' : normalized.slice(yamlEndIndex + '\n---\n'.length);

  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(yamlContent);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(frontmatter)) {
    throw new Error('SKILL.md frontmatter 根节点必须是 object。');
  }

  return {
    frontmatter,
    body,
  };
}

interface ParsedClaudeSkill {
  disableModelInvocation: ParsedTriggerBoolean;
  userInvocable: ParsedTriggerBoolean;
}

async function parseClaudeSkillMetadata(filePath: string): Promise<ParsedClaudeSkill> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('缺少 SKILL.md。');
  }

  const { frontmatter } = parseClaudeFrontmatter(rawContent);

  const disableModelInvocation = frontmatter['disable-model-invocation'];
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== 'boolean') {
    throw new Error('SKILL.md frontmatter 的 disable-model-invocation 必须是 boolean。');
  }

  const userInvocable = frontmatter['user-invocable'];
  if (userInvocable !== undefined && typeof userInvocable !== 'boolean') {
    throw new Error('SKILL.md frontmatter 的 user-invocable 必须是 boolean。');
  }

  return {
    disableModelInvocation:
      typeof disableModelInvocation === 'boolean' ? disableModelInvocation : 'absent',
    userInvocable: typeof userInvocable === 'boolean' ? userInvocable : 'absent',
  };
}

function applyPreferenceToCodexSkill(
  skill: ParsedCodexSkill,
  preference: SkillTriggerPreference,
  allowInstallOverride: boolean,
): ParsedCodexSkill {
  if (preference === 'default' || !allowInstallOverride) {
    return skill;
  }

  return {
    allowImplicitInvocation: preference === 'auto',
  };
}

function applyPreferenceToClaudeSkill(
  skill: ParsedClaudeSkill,
  preference: SkillTriggerPreference,
  allowInstallOverride: boolean,
): ParsedClaudeSkill {
  if (preference === 'default' || !allowInstallOverride) {
    return skill;
  }

  return preference === 'manual'
    ? {
        disableModelInvocation: true,
        userInvocable: true,
      }
    : {
        disableModelInvocation: false,
        userInvocable: skill.userInvocable,
      };
}

export async function patchCodexOpenAiYaml(
  filePath: string,
  preference: Exclude<SkillTriggerPreference, 'default'>,
): Promise<void> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('缺少 agents/openai.yaml。');
  }

  await fs.writeFile(
    filePath,
    renderCodexOpenAiYamlWithAllowImplicitInvocation({
      rawContent,
      allowImplicitInvocation: preference === 'auto',
    }),
    'utf8',
  );
}

export async function patchClaudeSkillFrontmatter(
  filePath: string,
  preference: Exclude<SkillTriggerPreference, 'default'>,
): Promise<void> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('缺少 SKILL.md。');
  }

  const { frontmatter, body } = parseClaudeFrontmatter(rawContent);
  if (preference === 'manual') {
    frontmatter['disable-model-invocation'] = true;
    frontmatter['user-invocable'] = true;
  } else {
    frontmatter['disable-model-invocation'] = false;
  }

  const renderedFrontmatter = YAML.stringify(frontmatter).trimEnd();
  await fs.writeFile(filePath, `---\n${renderedFrontmatter}\n---\n${body}`, 'utf8');
}

async function copyEmbeddedSkillsToStaging(
  sourcePluginRoot: string,
  platform: PlatformName,
  stagingSkillsRoot: string,
): Promise<void> {
  const sourceSkillsRoot = getPlatformSkillsRoot(sourcePluginRoot, platform);
  if (!(await fs.pathExists(sourceSkillsRoot))) {
    throw new Error(`缺少 skill source 子树：${sourceSkillsRoot}`);
  }

  await fs.copy(sourceSkillsRoot, stagingSkillsRoot, { overwrite: true });
}

async function resetStagingSkillsToPristine(
  sourcePluginRoot: string,
  platform: PlatformName,
  stagingSkillsRoot: string,
): Promise<void> {
  await fs.remove(stagingSkillsRoot);
  await copyEmbeddedSkillsToStaging(sourcePluginRoot, platform, stagingSkillsRoot);
}

async function copyEmbeddedSkillToStaging(
  sourcePluginRoot: string,
  platform: PlatformName,
  skillName: string,
  stagingSkillRoot: string,
): Promise<void> {
  const sourceSkillRoot = path.join(
    getPlatformSkillsRoot(sourcePluginRoot, platform),
    skillName,
  );
  if (!(await fs.pathExists(sourceSkillRoot))) {
    throw new Error(`缺少 skill source 目录：${sourceSkillRoot}`);
  }

  await fs.copy(sourceSkillRoot, stagingSkillRoot, { overwrite: true });
}

async function replaceSkillsSubtree(
  targetSkillsRoot: string,
  stagingSkillsRoot: string,
): Promise<SkillTriggerMaterializationRollbackHandle> {
  const targetParent = path.dirname(targetSkillsRoot);
  const backupSkillsRoot = path.join(
    targetParent,
    createTempDirectoryName(`${path.basename(targetSkillsRoot)}-backup`),
  );
  const targetExists = await fs.pathExists(targetSkillsRoot);

  try {
    if (targetExists) {
      await fs.move(targetSkillsRoot, backupSkillsRoot, { overwrite: true });
    }
    await fs.move(stagingSkillsRoot, targetSkillsRoot, { overwrite: true });
  } catch (error) {
    try {
      if (targetExists && await fs.pathExists(backupSkillsRoot)) {
        await fs.move(backupSkillsRoot, targetSkillsRoot, { overwrite: true });
      }
    } catch {
      // noop
    }
    throw error;
  }

  return {
    committed: true,
    targetSkillsRoot,
    backupSkillsRoot: targetExists ? backupSkillsRoot : null,
    operations: [{
      targetSkillsRoot,
      backupSkillsRoot: targetExists ? backupSkillsRoot : null,
    }],
  };
}

function createRollbackHandleFromOperations(
  operations: Array<{
    targetSkillsRoot: string;
    backupSkillsRoot: string | null;
  }>,
): SkillTriggerMaterializationRollbackHandle {
  const [firstOperation] = operations;
  return {
    committed: operations.length > 0,
    targetSkillsRoot: firstOperation?.targetSkillsRoot ?? '',
    backupSkillsRoot: firstOperation?.backupSkillsRoot ?? null,
    operations,
  };
}

async function readEmbeddedSignatureEntries(
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
  preference: SkillTriggerPreference,
): Promise<SkillTriggerSignatureResult> {
  const resolution = await resolveSkillTriggerPolicies({
    embeddedRoot,
    pluginName,
    platform,
  });
  const diagnostics: SkillTriggerDiagnostic[] = [];

  if (platform === 'codex') {
    const entries: CodexSkillSignatureEntry[] = [];
    for (const policy of resolution.policies) {
      try {
        const skill = await parseCodexSkillMetadata(policy.codexFilePath);
        const applied = applyPreferenceToCodexSkill(
          skill,
          preference,
          policy.allowInstallOverride,
        );
        entries.push({
          skillName: policy.skillName,
          allowInstallOverride: policy.allowInstallOverride,
          allowImplicitInvocation: normalizeCodexAllowImplicitInvocation(
            applied.allowImplicitInvocation,
          ),
        });
      } catch (error) {
        diagnostics.push({
          pluginName,
          platform,
          skillName: policy.skillName,
          filePath: policy.codexFilePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (diagnostics.length > 0) {
      return {
        status: 'unknown',
        pluginName,
        platform,
        preference,
        diagnostics,
      };
    }

    return {
      status: 'known',
      pluginName,
      platform,
      preference,
      entries,
      signature: serializeComparableValue(entries),
    };
  }

  const entries: ClaudeSkillSignatureEntry[] = [];
  for (const policy of resolution.policies) {
    try {
      const skill = await parseClaudeSkillMetadata(policy.claudeFilePath);
      const applied = applyPreferenceToClaudeSkill(
        skill,
        preference,
        policy.allowInstallOverride,
      );
      entries.push({
        skillName: policy.skillName,
        allowInstallOverride: policy.allowInstallOverride,
        disableModelInvocation: normalizeClaudeDisableModelInvocation(
          applied.disableModelInvocation,
        ),
        userInvocable: normalizeClaudeUserInvocable(applied.userInvocable),
      });
    } catch (error) {
      diagnostics.push({
        pluginName,
        platform,
        skillName: policy.skillName,
        filePath: policy.claudeFilePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      status: 'unknown',
      pluginName,
      platform,
      preference,
      diagnostics,
    };
  }

  return {
    status: 'known',
    pluginName,
    platform,
    preference,
    entries,
    signature: serializeComparableValue(entries),
  };
}

async function readRuntimeSignatureEntries(
  target: SkillTriggerMaterializationTarget,
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
): Promise<SkillTriggerSignatureResult> {
  const resolution = await resolveSkillTriggerPolicies({
    embeddedRoot,
    pluginName,
    platform,
  });
  const diagnostics: SkillTriggerDiagnostic[] = [];

  if (platform === 'codex') {
    const entries: CodexSkillSignatureEntry[] = [];
    for (const policy of resolution.policies) {
      const runtimePath = path.join(
        getTargetSkillRoot(target, pluginName, policy.skillName),
        'agents',
        'openai.yaml',
      );
      try {
        const skill = await parseCodexSkillMetadata(runtimePath);
        entries.push({
          skillName: policy.skillName,
          allowInstallOverride: policy.allowInstallOverride,
          allowImplicitInvocation: normalizeCodexAllowImplicitInvocation(
            skill.allowImplicitInvocation,
          ),
        });
      } catch (error) {
        diagnostics.push({
          pluginName,
          platform,
          skillName: policy.skillName,
          filePath: runtimePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (diagnostics.length > 0) {
      return {
        status: 'unknown',
        pluginName,
        platform,
        preference: 'runtime',
        diagnostics,
      };
    }

    return {
      status: 'known',
      pluginName,
      platform,
      preference: 'runtime',
      entries,
      signature: serializeComparableValue(entries),
    };
  }

  const entries: ClaudeSkillSignatureEntry[] = [];
  for (const policy of resolution.policies) {
    const runtimePath = path.join(
      getTargetSkillRoot(target, pluginName, policy.skillName),
      'SKILL.md',
    );
    try {
      const skill = await parseClaudeSkillMetadata(runtimePath);
      entries.push({
        skillName: policy.skillName,
        allowInstallOverride: policy.allowInstallOverride,
        disableModelInvocation: normalizeClaudeDisableModelInvocation(
          skill.disableModelInvocation,
        ),
        userInvocable: normalizeClaudeUserInvocable(skill.userInvocable),
      });
    } catch (error) {
      diagnostics.push({
        pluginName,
        platform,
        skillName: policy.skillName,
        filePath: runtimePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      status: 'unknown',
      pluginName,
      platform,
      preference: 'runtime',
      diagnostics,
    };
  }

  return {
    status: 'known',
    pluginName,
    platform,
    preference: 'runtime',
    entries,
    signature: serializeComparableValue(entries),
  };
}

export async function buildSkillTriggerMaterializationSignature(options: {
  pluginName: string;
  platform: PlatformName;
  preference: SkillTriggerPreference;
  embeddedRoot: string;
}): Promise<SkillTriggerSignatureResult> {
  return readEmbeddedSignatureEntries(
    options.embeddedRoot,
    options.pluginName,
    options.platform,
    options.preference,
  );
}

export async function readCurrentSkillTriggerRuntimeSignature(options: {
  pluginName: string;
  platform: PlatformName;
  embeddedRoot: string;
  target?: SkillTriggerMaterializationTarget;
  marketplaceRoot?: string;
}): Promise<SkillTriggerSignatureResult> {
  const target = options.target ?? (
    options.marketplaceRoot
      ? createLegacyMaterializationTarget({
          marketplaceRootOrStagingRoot: options.marketplaceRoot,
          platform: options.platform,
        })
      : undefined
  );
  if (!target) {
    throw new Error('readCurrentSkillTriggerRuntimeSignature 缺少 materialization target。');
  }

  return readRuntimeSignatureEntries(
    target,
    options.embeddedRoot,
    options.pluginName,
    options.platform,
  );
}

export async function assessSharedSkillTriggerRuntimeSemantics(options: {
  pluginName: string;
  platform: PlatformName;
  locationScope: Scope;
  preference: SkillTriggerPreference;
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
}): Promise<SharedSkillTriggerRuntimeSemanticsAssessment> {
  const targetKind = classifySharedSkillTriggerRuntimeTarget(options.target);
  if (targetKind === 'repoLocalCodexProject') {
    return {
      pluginName: options.pluginName,
      platform: options.platform,
      locationScope: options.locationScope,
      targetKind,
      participatesInSharedRuntimeOwner: false,
      semanticDelta: 'noChange',
      currentRuntimeSignature: null,
      plannedRuntimeSignature: null,
    };
  }

  const [plannedRuntimeSignature, currentRuntimeSignature] = await Promise.all([
    buildSkillTriggerMaterializationSignature({
      pluginName: options.pluginName,
      platform: options.platform,
      preference: options.preference,
      embeddedRoot: options.embeddedRoot,
    }),
    readCurrentSkillTriggerRuntimeSignature({
      pluginName: options.pluginName,
      platform: options.platform,
      embeddedRoot: options.embeddedRoot,
      target: options.target,
    }),
  ]);

  const semanticDelta = plannedRuntimeSignature.status === 'known'
    && currentRuntimeSignature.status === 'known'
    && plannedRuntimeSignature.signature === currentRuntimeSignature.signature
    ? 'noChange'
    : plannedRuntimeSignature.status === 'known' && currentRuntimeSignature.status === 'known'
      ? 'change'
      : 'unknown';

  return {
    pluginName: options.pluginName,
    platform: options.platform,
    locationScope: options.locationScope,
    targetKind,
    participatesInSharedRuntimeOwner: true,
    semanticDelta,
    currentRuntimeSignature,
    plannedRuntimeSignature,
  };
}

function getSkillTriggerScopeRecord(options: {
  ledger: InstalledLedger;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
}): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = options.ledger.plugins[options.pluginName]?.platforms[options.platform];
  if (!platformRecord) {
    return undefined;
  }

  if (options.scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  return options.projectKey
    ? platformRecord.projectScopes?.[options.projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

function formatSignatureDiagnostics(diagnostics: SkillTriggerDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) =>
      `${diagnostic.platform}/${diagnostic.skillName} file=${diagnostic.filePath} ${diagnostic.reason}`
    )
    .join('; ');
}

function formatRuntimeMatches(
  state: 'matched' | 'mixed' | 'unknown',
  matches: SkillTriggerPreference[] | undefined,
): string {
  if (state === 'unknown') {
    return 'unknown';
  }

  if (state === 'mixed') {
    return 'mixed';
  }

  if (!matches || matches.length === 0) {
    return 'mixed';
  }

  return matches.length === 1 ? matches[0] : `matches(${matches.join(',')})`;
}

async function collectLocalManifestDriftWarning(options: {
  embeddedRoot: string;
  marketplaceRoot: string;
  pluginName: string;
}): Promise<string | null> {
  try {
    const [embeddedPlugin, localPlugin] = await Promise.all([
      readPluginManifest(getEmbeddedPluginRoot(options.embeddedRoot, options.pluginName), {
        mode: 'bundle',
      }),
      readPluginManifest(getMarketplacePluginRoot(options.marketplaceRoot, options.pluginName), {
        mode: 'bundle',
      }),
    ]);
    const embeddedSkillTriggers = embeddedPlugin.manifest.skillTriggers ?? {};
    const localSkillTriggers = localPlugin.manifest.skillTriggers ?? {};
    if (serializeComparableValue(embeddedSkillTriggers) === serializeComparableValue(localSkillTriggers)) {
      return null;
    }

    return 'local marketplace manifest 的 skillTriggers 与 embedded manifest 不一致；status 已按 embedded manifest 判定。';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `local marketplace manifest 无法用于 skillTriggers drift 佐证：${message}`;
  }
}

export async function resolveSkillTriggerStatusReportFields(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  ledger: InstalledLedger;
  currentCatalog: CatalogResolution;
  currentCatalogAvailable: boolean;
  embeddedRoot: string;
  runtimeTarget?: SkillTriggerMaterializationTarget;
}): Promise<SkillTriggerStatusReportFields | null> {
  const scopeRecord = getSkillTriggerScopeRecord({
    ledger: options.ledger,
    pluginName: options.pluginName,
    platform: options.platform,
    scope: options.scope,
    projectKey: options.projectKey,
  });

  let policyResolution: SkillTriggerPolicyResolution;
  try {
    policyResolution = await resolveSkillTriggerPolicies({
      embeddedRoot: options.embeddedRoot,
      pluginName: options.pluginName,
      platform: options.platform,
    });
  } catch (error) {
    if (!options.currentCatalogAvailable) {
      return {
        skillTriggerApplicability: 'none',
        skillTriggerRuntimeState: 'unknown',
        skillTriggerDrift: 'unknown',
        warnings: [],
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      skillTriggerApplicability: 'none',
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings: [`skill trigger policy 无法从 embedded bundle 读取：${message}`],
    };
  }

  const base: SkillTriggerStatusReportFields = {
    skillTriggerApplicability: policyResolution.applicability,
    warnings: [],
  };
  const ledgerPreference = scopeRecord?.installOptions?.skillTriggerPreference;
  if (policyResolution.applicability === 'overridable' && ledgerPreference) {
    base.installOptions = {
      skillTriggerPreference: ledgerPreference,
    };
    base.skillTriggerPreference = ledgerPreference;
  }

  if (policyResolution.applicability === 'none') {
    return base;
  }

  if (!options.currentCatalogAvailable) {
    return {
      ...base,
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings: [],
    };
  }

  const warnings: string[] = [];
  if (!options.runtimeTarget && options.currentCatalog.source === 'local') {
    const manifestDriftWarning = await collectLocalManifestDriftWarning({
      embeddedRoot: options.embeddedRoot,
      marketplaceRoot: options.currentCatalog.rootDir,
      pluginName: options.pluginName,
    });
    if (manifestDriftWarning) {
      warnings.push(manifestDriftWarning);
    }
  }

  if (
    policyResolution.applicability === 'overridable' &&
    options.ledger.ledgerState.status !== 'available' &&
    (
      options.runtimeTarget?.kind !== 'repoSkill' ||
      !ledgerPreference
    )
  ) {
    return {
      ...base,
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings,
    };
  }

  if (!options.runtimeTarget && options.currentCatalog.source !== 'local') {
    return {
      ...base,
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings,
    };
  }

  const preferences: SkillTriggerPreference[] = ['default', 'manual', 'auto'];
  const candidateEntries = await Promise.all(
    preferences.map(async (preference) => ({
      preference,
      signature: await buildSkillTriggerMaterializationSignature({
        pluginName: options.pluginName,
        platform: options.platform,
        preference,
        embeddedRoot: options.embeddedRoot,
      }),
    })),
  );
  const unknownCandidate = candidateEntries.find((entry) => entry.signature.status === 'unknown');
  if (unknownCandidate?.signature.status === 'unknown') {
    return {
      ...base,
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings: [
        ...warnings,
        `skill trigger 候选签名无法确定：${formatSignatureDiagnostics(unknownCandidate.signature.diagnostics)}`,
      ],
    };
  }

  const runtimeSignature = await readCurrentSkillTriggerRuntimeSignature({
    pluginName: options.pluginName,
    platform: options.platform,
    embeddedRoot: options.embeddedRoot,
    ...(options.runtimeTarget
      ? { target: options.runtimeTarget }
      : { marketplaceRoot: options.currentCatalog.rootDir }),
  });
  if (runtimeSignature.status === 'unknown') {
    return {
      ...base,
      skillTriggerRuntimeState: 'unknown',
      skillTriggerDrift: 'unknown',
      warnings: [
        ...warnings,
        `skill trigger runtime 签名无法确定：${formatSignatureDiagnostics(runtimeSignature.diagnostics)}`,
      ],
    };
  }

  const knownCandidates = candidateEntries.map((entry) => ({
    preference: entry.preference,
    signature: entry.signature as KnownSkillTriggerSignature,
  }));
  const matches = knownCandidates
    .filter((entry) => entry.signature.signature === runtimeSignature.signature)
    .map((entry) => entry.preference);
  const runtimeState = matches.length > 0 ? 'matched' : 'mixed';
  const expectedPreference = policyResolution.applicability === 'overridable'
    ? ledgerPreference
    : 'default';
  const expectedSignature = knownCandidates.find((entry) => entry.preference === expectedPreference)?.signature;
  const drift = expectedSignature?.signature === runtimeSignature.signature ? 'no' : 'yes';

  if (drift === 'yes' && ledgerPreference) {
    warnings.push(
      `skill trigger runtime 与当前 scope ledger 偏好不一致（skillTriggerLedger=${ledgerPreference}, skillTriggerRuntime=${formatRuntimeMatches(runtimeState, matches)}）。`,
    );
  }

  return {
    ...base,
    skillTriggerRuntimeMatches: matches,
    skillTriggerRuntimeState: runtimeState,
    skillTriggerDrift: drift,
    warnings,
  };
}

export async function materializeSkillTriggerPreference(options: {
  pluginName: string;
  platform: PlatformName;
  resolvedOptions: { skillTriggerPreference: SkillTriggerPreference };
  embeddedRoot: string;
  policyPlugin?: PluginMeta;
  sourcePluginRoot?: string;
  target?: SkillTriggerMaterializationTarget;
  marketplaceRootOrStagingRoot?: string;
  mode: SkillTriggerMaterializationMode;
}): Promise<SkillTriggerMaterializationResult> {
  const preference = options.resolvedOptions.skillTriggerPreference;
  const target = options.target ?? (
    options.marketplaceRootOrStagingRoot
      ? createLegacyMaterializationTarget({
          marketplaceRootOrStagingRoot: options.marketplaceRootOrStagingRoot,
          platform: options.platform,
        })
      : undefined
  );
  if (!target) {
    throw new Error('materializeSkillTriggerPreference 缺少 materialization target。');
  }
  const sourcePluginRoot = getSkillTriggerSourcePluginRoot(options);
  const resolution = await resolveSkillTriggerPolicies({
    embeddedRoot: options.embeddedRoot,
    pluginName: options.pluginName,
    platform: options.platform,
    policyPlugin: options.policyPlugin,
    sourcePluginRoot,
  });

  const warnings: string[] = [];
  const patchedSkills: string[] = [];
  const skippedSkills: string[] = [];
  const generatedArtifacts: GeneratedArtifact[] = [];

  if (resolution.policies.length === 0) {
    return {
      committed: false,
      warnings,
      summary: {
        status: 'skipped',
        preference,
        patchedSkills,
        skippedSkills,
      },
      rollbackHandle: {
        committed: false,
        targetSkillsRoot: '',
        backupSkillsRoot: null,
        operations: [],
      },
      generatedArtifacts,
    };
  }

  const patchSkill = async (skillRoot: string, policy: SkillTriggerPolicyEntry): Promise<void> => {
    if (preference === 'default') {
      return;
    }

    if (!policy.allowInstallOverride) {
      skippedSkills.push(policy.skillName);
      if (!policy.allowInstallOverrideDeclared) {
        warnings.push(
          `${options.pluginName} 的 ${options.platform} skill ${policy.skillName} 未声明 allowInstallOverride，保留默认触发策略。`,
        );
      }
      return;
    }

    try {
      if (options.platform === 'codex') {
        await patchCodexOpenAiYaml(
          path.join(skillRoot, 'agents', 'openai.yaml'),
          preference,
        );
      } else {
        await patchClaudeSkillFrontmatter(
          path.join(skillRoot, 'SKILL.md'),
          preference,
        );
      }
      patchedSkills.push(policy.skillName);
    } catch (error) {
      throw buildSkillTriggerError({
        pluginName: options.pluginName,
        platform: options.platform,
        skillName: policy.skillName,
        filePath: options.platform === 'codex'
          ? policy.codexFilePath
          : policy.claudeFilePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let rollbackHandle: SkillTriggerMaterializationRollbackHandle;
  if (target.kind === 'repoSkill') {
    await fs.ensureDir(target.root);
    const operations: SkillTriggerMaterializationRollbackHandle['operations'] = [];
    const stagedSkills: Array<{ policy: SkillTriggerPolicyEntry; stagingSkillRoot: string }> = [];

    for (const policy of resolution.policies) {
      const stagingSkillRoot = path.join(
        target.root,
        createTempDirectoryName(`${policy.skillName}-staging`),
      );

      await copyEmbeddedSkillToStaging(
        sourcePluginRoot,
        options.platform,
        policy.skillName,
        stagingSkillRoot,
      );
      stagedSkills.push({ policy, stagingSkillRoot });

      try {
        await patchSkill(stagingSkillRoot, policy);
      } catch (error) {
        if (options.mode === 'strictExplicit') {
          await fs.remove(stagingSkillRoot).catch(() => undefined);
          throw error;
        }

        warnings.push(
          `${options.pluginName} 的 ${options.platform} skill trigger 偏好跳过覆盖：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const { policy, stagingSkillRoot } of stagedSkills) {
      const replacement = await replaceSkillsSubtree(
        getRepoSkillRoot(target.root, policy.skillName),
        stagingSkillRoot,
      );
      operations.push(...replacement.operations);
      generatedArtifacts.push({
        path: getRepoSkillRoot(target.root, policy.skillName),
        kind: 'skill',
        platform: 'codex',
        artifactKey: policy.skillName,
      });
    }

    rollbackHandle = createRollbackHandleFromOperations(operations);
  } else {
    const targetPluginRoot = getMarketplacePluginRoot(target.root, options.pluginName);
    const targetSkillsRoot = getPlatformSkillsRoot(targetPluginRoot, options.platform);
    const targetParent = path.dirname(targetSkillsRoot);
    const stagingSkillsRoot = path.join(
      targetParent,
      createTempDirectoryName(`${path.basename(targetSkillsRoot)}-staging`),
    );

    await fs.ensureDir(targetParent);
    await copyEmbeddedSkillsToStaging(
      sourcePluginRoot,
      options.platform,
      stagingSkillsRoot,
    );

    try {
      for (const policy of resolution.policies) {
        await patchSkill(path.join(stagingSkillsRoot, policy.skillName), policy);
      }
    } catch (error) {
      if (options.mode === 'strictExplicit') {
        await fs.remove(stagingSkillsRoot).catch(() => undefined);
        throw error;
      }

      warnings.push(
        `${options.pluginName} 的 ${options.platform} skill trigger 偏好跳过覆盖：${error instanceof Error ? error.message : String(error)}`,
      );
      patchedSkills.length = 0;
      await resetStagingSkillsToPristine(
        sourcePluginRoot,
        options.platform,
        stagingSkillsRoot,
      );
    }

    rollbackHandle = await replaceSkillsSubtree(targetSkillsRoot, stagingSkillsRoot);
  }

  return {
    committed: rollbackHandle.committed,
    warnings,
    summary: {
      status: preference === 'default'
        ? 'pristine'
        : patchedSkills.length > 0
          ? 'patched'
          : 'skipped',
      preference,
      patchedSkills,
      skippedSkills,
    },
    rollbackHandle,
    generatedArtifacts,
  };
}

export async function rollbackMaterializedSkillTriggerPreference(
  handle: SkillTriggerMaterializationRollbackHandle,
): Promise<void> {
  if (!handle.committed) {
    return;
  }

  const operations = handle.operations.length > 0
    ? [...handle.operations].reverse()
    : [{
        targetSkillsRoot: handle.targetSkillsRoot,
        backupSkillsRoot: handle.backupSkillsRoot,
      }];

  for (const operation of operations) {
    await fs.remove(operation.targetSkillsRoot).catch(() => undefined);
    if (operation.backupSkillsRoot) {
      await fs.move(operation.backupSkillsRoot, operation.targetSkillsRoot, { overwrite: true });
    }
  }
  handle.committed = false;
  handle.backupSkillsRoot = null;
  handle.operations = [];
}

export async function commitMaterializedSkillTriggerPreference(
  handle: SkillTriggerMaterializationRollbackHandle,
): Promise<void> {
  if (!handle.committed) {
    return;
  }

  const operations = handle.operations.length > 0
    ? handle.operations
    : [{
        targetSkillsRoot: handle.targetSkillsRoot,
        backupSkillsRoot: handle.backupSkillsRoot,
      }];

  for (const operation of operations) {
    if (operation.backupSkillsRoot) {
      await fs.remove(operation.backupSkillsRoot);
    }
  }
  handle.committed = false;
  handle.backupSkillsRoot = null;
  handle.operations = [];
}

function collectManagedScopeRecords(
  ledger: InstalledLedger,
  pluginName: string,
  platform: PlatformName,
  mode: 'allScopes' | 'sharedRuntime' = 'allScopes',
): EffectiveSkillTriggerRecord[] {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return [];
  }

  const records: EffectiveSkillTriggerRecord[] = [];
  if (platformRecord.userScope?.managed === true) {
    records.push({
      scopeIdentity: 'user',
      preference: platformRecord.userScope.installOptions?.skillTriggerPreference ?? 'default',
      writeOrder: platformRecord.userScope.skillTriggerWriteOrder ?? null,
      updatedAt: platformRecord.userScope.updatedAt,
      record: platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>>,
    });
  }

  const includeProjectScopes = !(mode === 'sharedRuntime' && platform === 'codex');
  if (!includeProjectScopes) {
    return records;
  }

  for (const [scopeKey, scopeRecord] of Object.entries(platformRecord.projectScopes ?? {})) {
    if (scopeRecord.managed !== true) {
      continue;
    }

    records.push({
      scopeIdentity: `project:${scopeKey}`,
      preference: scopeRecord.installOptions?.skillTriggerPreference ?? 'default',
      writeOrder: scopeRecord.skillTriggerWriteOrder ?? null,
      updatedAt: scopeRecord.updatedAt,
      record: scopeRecord as InstalledScopeRecord<Record<string, unknown>>,
    });
  }

  return records;
}

export function getNextSkillTriggerWriteOrder(options: {
  ledger: InstalledLedger;
  pluginName: string;
  platform: PlatformName;
}): number {
  const records = collectManagedScopeRecords(
    options.ledger,
    options.pluginName,
    options.platform,
  );
  const maxWriteOrder = records.reduce((currentMax, record) => {
    if (typeof record.writeOrder !== 'number' || !Number.isInteger(record.writeOrder) || record.writeOrder < 0) {
      return currentMax;
    }
    return Math.max(currentMax, record.writeOrder);
  }, 0);

  return maxWriteOrder + 1;
}

export function selectEffectiveSkillTriggerRecord(options: {
  ledger: InstalledLedger;
  pluginName: string;
  platform: PlatformName;
}): EffectiveSkillTriggerRecord | null {
  if (options.ledger.ledgerState.status !== 'available') {
    throw new Error('degraded installed.json 不能用于确定 skill trigger 胜者。');
  }

  const records = collectManagedScopeRecords(
    options.ledger,
    options.pluginName,
    options.platform,
    'sharedRuntime',
  );
  records.sort((left, right) => {
    const leftWriteOrder = left.writeOrder ?? 0;
    const rightWriteOrder = right.writeOrder ?? 0;
    if (leftWriteOrder !== rightWriteOrder) {
      return rightWriteOrder - leftWriteOrder;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
    return left.scopeIdentity.localeCompare(right.scopeIdentity);
  });

  return records[0] ?? null;
}

export function selectEffectiveSkillTriggerPreference(options: {
  ledger: InstalledLedger;
  pluginName: string;
  platform: PlatformName;
}): SkillTriggerPreference {
  return selectEffectiveSkillTriggerRecord(options)?.preference ?? 'default';
}

function formatDiagnostics(
  pluginName: string,
  platform: PlatformName,
  diagnostics: SkillTriggerDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) =>
      `[${platform}/${pluginName}] 跳过 skill trigger sibling 冲突判断：skill=${diagnostic.skillName} file=${diagnostic.filePath} ${diagnostic.reason}`,
    )
    .join('\n');
}

export async function collectSkillTriggerSiblingConflictWarnings(options: {
  ledgerBefore: InstalledLedger;
  ledgerAfter: InstalledLedger;
  pluginName: string;
  platform: PlatformName;
  writtenScopeIdentity: string;
  runtimeSignatureBefore: SkillTriggerSignatureResult;
  plannedRuntimeSignatureAfter: SkillTriggerSignatureResult;
  embeddedRoot: string;
}): Promise<SkillTriggerSiblingConflictResult> {
  if (
    options.ledgerBefore.ledgerState.status !== 'available' ||
    options.ledgerAfter.ledgerState.status !== 'available'
  ) {
    return {
      warnings: [],
      diagnostics: [
        `[${options.platform}/${options.pluginName}] 跳过 skill trigger sibling 冲突判断：installed.json 不是 available。`,
      ],
    };
  }

  if (options.runtimeSignatureBefore.status === 'unknown') {
    return {
      warnings: [],
      diagnostics: [formatDiagnostics(
        options.pluginName,
        options.platform,
        options.runtimeSignatureBefore.diagnostics,
      )],
    };
  }

  if (options.plannedRuntimeSignatureAfter.status === 'unknown') {
    return {
      warnings: [],
      diagnostics: [formatDiagnostics(
        options.pluginName,
        options.platform,
        options.plannedRuntimeSignatureAfter.diagnostics,
      )],
    };
  }

  if (options.runtimeSignatureBefore.signature === options.plannedRuntimeSignatureAfter.signature) {
    return {
      warnings: [],
      diagnostics: [],
    };
  }

  const siblingRecords = collectManagedScopeRecords(
    options.ledgerAfter,
    options.pluginName,
    options.platform,
    'sharedRuntime',
  ).filter((record) => record.scopeIdentity !== options.writtenScopeIdentity);

  if (siblingRecords.length === 0) {
    return {
      warnings: [],
      diagnostics: [],
    };
  }

  const siblingExpectations = await Promise.all(
    siblingRecords.map(async (record) => ({
      scopeIdentity: record.scopeIdentity,
      preference: record.preference,
      signature: await buildSkillTriggerMaterializationSignature({
        pluginName: options.pluginName,
        platform: options.platform,
        preference: record.preference,
        embeddedRoot: options.embeddedRoot,
      }),
    })),
  );

  const unknownSibling = siblingExpectations.find(
    (entry) => entry.signature.status === 'unknown',
  );
  if (unknownSibling && unknownSibling.signature.status === 'unknown') {
    return {
      warnings: [],
      diagnostics: [formatDiagnostics(
        options.pluginName,
        options.platform,
        unknownSibling.signature.diagnostics,
      )],
    };
  }

  const driftedScopes = siblingExpectations
    .filter((entry) =>
      entry.signature.status === 'known' &&
      options.plannedRuntimeSignatureAfter.status === 'known' &&
      entry.signature.signature !== options.plannedRuntimeSignatureAfter.signature,
    )
    .map((entry) => `${entry.scopeIdentity} (${entry.preference})`);

  if (driftedScopes.length === 0) {
    return {
      warnings: [],
      diagnostics: [],
    };
  }

  return {
    warnings: [
      `[${options.platform}/${options.pluginName}] 本次写入改变了共享 skill trigger 语义，以下 sibling scope 将与当前 runtime 不一致：${driftedScopes.join(', ')}`,
    ],
    diagnostics: [],
  };
}

export async function replaySkillTriggerPreferencesFromLedger(options: {
  ledger: InstalledLedger;
  marketplaceRoot: string;
  embeddedRoot: string;
  previousMarketplaceRoot?: string;
  warnOnDegraded?: boolean;
}): Promise<SkillTriggerReplayResult> {
  if (options.ledger.ledgerState.status !== 'available') {
    return {
      warnings: options.warnOnDegraded === false
        ? []
        : [
            `installed.json 处于 degraded 状态（${options.ledger.ledgerState.reason ?? 'unknown'}），跳过 skill trigger 偏好 replay，保留 embedded pristine 默认策略。`,
          ],
    };
  }

  const warnings: string[] = [];
  const platforms: PlatformName[] = ['codex', 'claude'];
  const pluginNames = Object.keys(options.ledger.plugins).sort();

  for (const pluginName of pluginNames) {
    for (const platform of platforms) {
      const effectiveRecord = selectEffectiveSkillTriggerRecord({
        ledger: options.ledger,
        pluginName,
        platform,
      });
      if (!effectiveRecord) {
        continue;
      }

      if (!(await embeddedPlatformSkillsRootExists(options.embeddedRoot, pluginName, platform))) {
        continue;
      }

      let runtimeSignatureBefore: SkillTriggerSignatureResult | undefined;
      if (
        options.previousMarketplaceRoot &&
        await marketplacePlatformSkillsRootExists(options.previousMarketplaceRoot, pluginName, platform)
      ) {
        runtimeSignatureBefore = await readCurrentSkillTriggerRuntimeSignature({
          pluginName,
          platform,
          marketplaceRoot: options.previousMarketplaceRoot,
          embeddedRoot: options.embeddedRoot,
        });
      }

      const materialization = await materializeSkillTriggerPreference({
        pluginName,
        platform,
        resolvedOptions: {
          skillTriggerPreference: effectiveRecord.preference,
        },
        embeddedRoot: options.embeddedRoot,
        marketplaceRootOrStagingRoot: options.marketplaceRoot,
        mode: 'bestEffortReplay',
      });
      warnings.push(...materialization.warnings);
      try {
        await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`[${platform}/${pluginName}] skill trigger 备份目录清理失败：${detail}`);
      }

      if (!runtimeSignatureBefore) {
        continue;
      }

      const runtimeSignatureAfter = await readCurrentSkillTriggerRuntimeSignature({
        pluginName,
        platform,
        marketplaceRoot: options.marketplaceRoot,
        embeddedRoot: options.embeddedRoot,
      });
      const conflictResult = await collectSkillTriggerSiblingConflictWarnings({
        ledgerBefore: options.ledger,
        ledgerAfter: options.ledger,
        pluginName,
        platform,
        writtenScopeIdentity: effectiveRecord.scopeIdentity,
        runtimeSignatureBefore,
        plannedRuntimeSignatureAfter: runtimeSignatureAfter,
        embeddedRoot: options.embeddedRoot,
      });
      warnings.push(
        ...conflictResult.warnings,
        ...conflictResult.diagnostics.filter(Boolean),
      );
    }
  }

  return {
    warnings,
  };
}

export async function rematerializeSkillTriggerPreferenceAfterUninstall(options: {
  pluginName: string;
  platform: PlatformName;
  ledgerAfterUninstall: InstalledLedger;
  embeddedRoot: string;
  marketplaceRoot: string;
  policyPlugin?: PluginMeta;
  fallbackSourcePluginRoot?: string;
  force?: boolean;
}): Promise<SkillTriggerPostUninstallMaterializationResult> {
  if (options.ledgerAfterUninstall.ledgerState.status !== 'available') {
    return {
      warnings: [
        `[${options.platform}/${options.pluginName}] installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。`,
      ],
    };
  }

  if (!(await fs.pathExists(getMarketplacePluginRoot(options.marketplaceRoot, options.pluginName)))) {
    return {
      warnings: [],
    };
  }

  const effectiveRecord = selectEffectiveSkillTriggerRecord({
    ledger: options.ledgerAfterUninstall,
    pluginName: options.pluginName,
    platform: options.platform,
  });

  const embeddedSourceValidation = await validateSkillTriggerReplaySource({
    pluginName: options.pluginName,
    platform: options.platform,
    sourcePluginRoot: getEmbeddedPluginRoot(options.embeddedRoot, options.pluginName),
  });
  const embeddedSourceAvailable = embeddedSourceValidation.status === 'ok';
  let fallbackSourcePluginRoot: string | undefined;

  if (!embeddedSourceAvailable) {
    const snapshot = effectiveRecord?.record.lifecycleConfigSnapshot;
    if (snapshot) {
      const snapshotValidation = await validateLifecycleSnapshotForSkillTriggerReplay({
        pluginName: options.pluginName,
        platform: options.platform,
        snapshot,
        currentPlugin: options.policyPlugin,
        currentSourcePluginRoot: options.fallbackSourcePluginRoot,
      });
      if (snapshotValidation.status === 'ok') {
        fallbackSourcePluginRoot = snapshotValidation.sourcePluginRoot;
      } else {
        const message =
          `[${options.platform}/${options.pluginName}] lifecycle snapshot bundle 不可用于卸载后的 skill trigger 重选：${snapshotValidation.reason}`;
        if (options.force === true) {
          return {
            warnings: [`${message}；已因 --force 跳过重放。`],
          };
        }
        throw new Error(`${message}。如需继续卸载并保留后续 repair 处理，请加 --force。`);
      }
    } else if (options.fallbackSourcePluginRoot) {
      fallbackSourcePluginRoot = options.fallbackSourcePluginRoot;
    }
  }

  const fallbackSourceValidation = !embeddedSourceAvailable && fallbackSourcePluginRoot
    ? await validateSkillTriggerReplaySource({
        pluginName: options.pluginName,
        platform: options.platform,
        sourcePluginRoot: fallbackSourcePluginRoot,
      })
    : undefined;
  const fallbackSourceAvailable = fallbackSourceValidation?.status === 'ok';
  if (fallbackSourceValidation?.status === 'ok') {
    fallbackSourcePluginRoot = fallbackSourceValidation.sourcePluginRoot;
  }
  if (!embeddedSourceAvailable && !fallbackSourceAvailable) {
    const embeddedReason = embeddedSourceValidation.status === 'invalid'
      ? `（${embeddedSourceValidation.reason}）`
      : '';
    const fallbackReason = fallbackSourceValidation?.status === 'invalid'
      ? `；fallback source 不可用：${fallbackSourceValidation.reason}`
      : '';
    return {
      warnings: [
        `[${options.platform}/${options.pluginName}] embedded bundle 不可用${embeddedReason}，且缺少可回放的 lifecycle snapshot bundle，跳过卸载后的 skill trigger 重选${fallbackReason}。`,
      ],
    };
  }
  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.pluginName,
    platform: options.platform,
    resolvedOptions: {
      skillTriggerPreference: effectiveRecord?.preference ?? 'default',
    },
    embeddedRoot: options.embeddedRoot,
    policyPlugin: embeddedSourceAvailable ? options.policyPlugin : undefined,
    ...(embeddedSourceAvailable || !fallbackSourcePluginRoot
      ? {}
      : { sourcePluginRoot: fallbackSourcePluginRoot }),
    marketplaceRootOrStagingRoot: options.marketplaceRoot,
    mode: 'bestEffortReplay',
  });

  return {
    warnings: materialization.warnings,
    materialization,
  };
}
