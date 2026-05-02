import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import type {
  CatalogResolution,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeInstallOptions,
  InstalledScopeRecord,
  PlatformName,
  PluginMeta,
  Scope,
  SkillTriggerApplicability,
  SkillTriggerPreference,
} from '../types.js';
import { readPluginManifest } from './manifest.js';

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

function normalizeYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillTriggerPolicyEntry {
  skillName: string;
  allowInstallOverride: boolean;
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

function getSkillTriggerApplicabilityFromPolicies(
  policies: SkillTriggerPolicyEntry[],
): SkillTriggerApplicability {
  if (policies.length === 0) {
    return 'none';
  }

  return policies.some((policy) => policy.allowInstallOverride)
    ? 'overridable'
    : 'fixed';
}

async function resolveSkillTriggerPoliciesFromPluginRoot(options: {
  pluginRoot: string;
  pluginName: string;
  manifestPath: string;
  manifest: PluginMeta['manifest'];
  platform: PlatformName;
}): Promise<SkillTriggerPolicyResolution> {
  const manifestPolicies = options.manifest.skillTriggers ?? {};
  const skillNames = await listSkillDirectories(
    getPlatformSkillsRoot(options.pluginRoot, options.platform),
  );
  const policies = skillNames.map((skillName) => ({
    skillName,
    allowInstallOverride: manifestPolicies[skillName]?.allowInstallOverride === true,
    codexFilePath: getCodexSkillMetadataPath(options.pluginRoot, skillName),
    claudeFilePath: getClaudeSkillMetadataPath(options.pluginRoot, skillName),
  }));

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
}): Promise<SkillTriggerPolicyResolution> {
  const pluginRoot = getEmbeddedPluginRoot(options.embeddedRoot, options.pluginName);
  const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
  return resolveSkillTriggerPoliciesFromPluginRoot({
    pluginRoot,
    pluginName: options.pluginName,
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
  return resolution.applicability;
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

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawContent);
  } catch (error) {
    throw new Error(`openai.yaml YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('openai.yaml 根节点必须是 object。');
  }

  if (parsed.policy === undefined) {
    parsed.policy = {};
  } else if (!isRecord(parsed.policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }

  const policy = parsed.policy;
  if (!isRecord(policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }
  policy.allow_implicit_invocation = preference === 'auto';
  await fs.writeFile(filePath, YAML.stringify(parsed), 'utf8');
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
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
  stagingSkillsRoot: string,
): Promise<void> {
  const embeddedSkillsRoot = getPlatformSkillsRoot(
    getEmbeddedPluginRoot(embeddedRoot, pluginName),
    platform,
  );
  if (!(await fs.pathExists(embeddedSkillsRoot))) {
    throw new Error(`缺少 embedded skills 子树：${embeddedSkillsRoot}`);
  }

  await fs.copy(embeddedSkillsRoot, stagingSkillsRoot, { overwrite: true });
}

async function resetStagingSkillsToPristine(
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
  stagingSkillsRoot: string,
): Promise<void> {
  await fs.remove(stagingSkillsRoot);
  await copyEmbeddedSkillsToStaging(embeddedRoot, pluginName, platform, stagingSkillsRoot);
}

async function copyEmbeddedSkillToStaging(
  embeddedRoot: string,
  pluginName: string,
  platform: PlatformName,
  skillName: string,
  stagingSkillRoot: string,
): Promise<void> {
  const embeddedSkillRoot = path.join(
    getPlatformSkillsRoot(getEmbeddedPluginRoot(embeddedRoot, pluginName), platform),
    skillName,
  );
  if (!(await fs.pathExists(embeddedSkillRoot))) {
    throw new Error(`缺少 embedded skill 目录：${embeddedSkillRoot}`);
  }

  await fs.copy(embeddedSkillRoot, stagingSkillRoot, { overwrite: true });
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
  const resolution = await resolveSkillTriggerPolicies({
    embeddedRoot: options.embeddedRoot,
    pluginName: options.pluginName,
    platform: options.platform,
  });

  const warnings: string[] = [];
  const patchedSkills: string[] = [];
  const skippedSkills: string[] = [];
  const generatedArtifacts: GeneratedArtifact[] = [];

  const patchSkill = async (skillRoot: string, policy: SkillTriggerPolicyEntry): Promise<void> => {
    if (preference === 'default') {
      return;
    }

    if (!policy.allowInstallOverride) {
      skippedSkills.push(policy.skillName);
      warnings.push(
        `${options.pluginName} 的 ${options.platform} skill ${policy.skillName} 未声明 allowInstallOverride，保留默认触发策略。`,
      );
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
        options.embeddedRoot,
        options.pluginName,
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
      options.embeddedRoot,
      options.pluginName,
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
        options.embeddedRoot,
        options.pluginName,
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
}): Promise<SkillTriggerPostUninstallMaterializationResult> {
  if (options.ledgerAfterUninstall.ledgerState.status !== 'available') {
    return {
      warnings: [
        `[${options.platform}/${options.pluginName}] installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。`,
      ],
    };
  }

  if (!(await embeddedPlatformSkillsRootExists(options.embeddedRoot, options.pluginName, options.platform))) {
    return {
      warnings: [],
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
  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.pluginName,
    platform: options.platform,
    resolvedOptions: {
      skillTriggerPreference: effectiveRecord?.preference ?? 'default',
    },
    embeddedRoot: options.embeddedRoot,
    marketplaceRootOrStagingRoot: options.marketplaceRoot,
    mode: 'bestEffortReplay',
  });

  return {
    warnings: materialization.warnings,
    materialization,
  };
}
