import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import fs from 'fs-extra';
import {
  normalizePluginManifestSchemaVersion,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION,
} from './manifest.js';

import type {
  CatalogMarketplaceIdentity,
  AgentDefinition,
  ArtifactState,
  ArtifactTarget,
  BuildConfig,
  BuildConfigFileRuleSet,
  BuildConfigTemplates,
  CatalogChannel,
  CatalogManifestEntry,
  ClaudeManifestOverrides,
  CodexProjectManagedKind,
  DynamicArtifactKind,
  HookDefinition,
  InstructionDefinition,
  MarketplaceAuthenticationPolicy,
  MarketplaceManifest,
  MarketplaceSourceMeta,
  NativeHookDefinition,
  PermissionDefinition,
  PlatformAgentOverrides,
  PlatformName,
  PlatformPluginManifest,
  PluginCompatibility,
  PluginConfigSchema,
  PluginArtifactRenderScriptEntry,
  PluginArtifactsConfig,
  PluginArtifactTargetDefinition,
  PluginExtensions,
  PluginInterfaceMeta,
  PluginLifecycleScriptEntry,
  PluginLifecycleScriptSelector,
  PluginLifecycleRuntimeOs,
  PluginNodeBuildScript,
  PluginNodeScriptsConfig,
  PluginManifestSource,
  NormalizedPluginManifest,
  PluginMarketplaceMeta,
  PluginMeta,
  PluginScriptsConfig,
  TemplateVarByPlatform,
} from './types.js';
import { readJsonFile } from './read-json.js';
import { parsePermissionCommand } from './permission-command.js';
import { applyFileRules } from './file-rules.js';
import { resolvePlatformEntries } from './platform-entries.js';
import {
  validatePortableSkillDirectoriesRoot,
  validatePortableSkillName,
} from './portable-skill-validation.js';
import {
  assertHookMatcherAllowed,
  assertNativeHookEvent,
  assertPublicHookEvent,
  normalizeRenderedHookGroupIdentity,
  renderHookDefinitionGroup,
  resolvePlatformHookDefinitions,
} from './hooks-contract.js';
import {
  inferLifecycleScriptRunnerFromPath,
  isPluginLifecycleOsSelector,
  isPluginScriptRunner,
  PLUGIN_AUTO_RUNNER_EXTENSIONS,
  PLUGIN_LIFECYCLE_EVENTS,
  PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS,
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
  resolveLifecycleScriptForOs,
} from './plugin-script-contract.js';
import {
  DEFAULT_SLASH_COMMANDS_PATH,
  resolveSlashCommands,
} from './slash-commands.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import { assertPluginInputTree, validateRuntimeExportSource } from './runtime-export-source.js';
import {
  formatMarketplaceProductsForError,
  normalizeMarketplaceProductToken,
  resolveSupportedPlatforms,
  supportsPlatform,
} from './platform-support.js';

export const SOURCE_MANIFEST_PATH = path.join('.agents-plugin', 'plugin.json');
export { SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION };
export const MARKETPLACE_SOURCE_PATH = path.join('plugins', 'marketplace-source.json');
const MANIFEST_POLICY_PRODUCTS = new Set(['CODEX', 'CLAUDE']);
const MARKETPLACE_AUTHENTICATION_POLICIES = new Set<MarketplaceAuthenticationPolicy>([
  'ON_INSTALL',
  'ON_USE',
]);
const CATALOG_CHANNELS = new Set<CatalogChannel>(['latest', 'beta']);
const NODE_RUNNABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PLATFORM_PRODUCT_BY_NAME: Record<PlatformName, string> = {
  claude: 'CLAUDE',
  codex: 'CODEX',
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DEFAULT_SOURCE_PLUGIN_AW_MIN_VERSION = '0.0.0';
const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface StrictSemVer {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export const STRICT_SEMVER_VALIDATION_CODE = 'invalidStrictSemVer';

export interface StrictSemVerValidationIssue {
  code: typeof STRICT_SEMVER_VALIDATION_CODE;
  fieldPath: string;
  value: unknown;
  message: string;
}

export class StrictSemVerValidationError extends Error {
  readonly code = STRICT_SEMVER_VALIDATION_CODE;
  readonly fieldPath: string;
  readonly value: unknown;

  constructor(issue: StrictSemVerValidationIssue) {
    super(issue.message);
    this.name = 'StrictSemVerValidationError';
    this.fieldPath = issue.fieldPath;
    this.value = issue.value;
  }
}

function formatStrictSemVerValidationValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return 'undefined';
  }

  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

export function createStrictSemVerValidationIssue(
  value: unknown,
  fieldPath: string,
): StrictSemVerValidationIssue {
  return {
    code: STRICT_SEMVER_VALIDATION_CODE,
    fieldPath,
    value,
    message: `Invalid ${fieldPath}: expected a strict SemVer 2.0.0 string. Received ${formatStrictSemVerValidationValue(value)}.`,
  };
}

export function getStrictSemVerValidationIssue(
  value: unknown,
  fieldPath: string,
): StrictSemVerValidationIssue | null {
  return tryParseStrictSemVer(value)
    ? null
    : createStrictSemVerValidationIssue(value, fieldPath);
}

export function isStrictSemVerValidationError(error: unknown): error is StrictSemVerValidationError {
  return error instanceof StrictSemVerValidationError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === STRICT_SEMVER_VALIDATION_CODE
    );
}

export function compareStrictSemVerFields(options: {
  left: {
    value: unknown;
    fieldPath: string;
  };
  right: {
    value: unknown;
    fieldPath: string;
  };
}):
  | { kind: 'ordered'; relation: number; left: StrictSemVer; right: StrictSemVer }
  | { kind: 'invalid'; issues: StrictSemVerValidationIssue[] } {
  const leftIssue = getStrictSemVerValidationIssue(options.left.value, options.left.fieldPath);
  const rightIssue = getStrictSemVerValidationIssue(options.right.value, options.right.fieldPath);
  if (leftIssue || rightIssue) {
    return {
      kind: 'invalid',
      issues: [leftIssue, rightIssue].filter((issue): issue is StrictSemVerValidationIssue => issue !== null),
    };
  }

  const left = tryParseStrictSemVer(options.left.value);
  const right = tryParseStrictSemVer(options.right.value);
  if (!left || !right) {
    throw new Error('Strict SemVer comparison reached an unreachable invalid state.');
  }

  return {
    kind: 'ordered',
    relation: compareStrictSemVer(left, right),
    left,
    right,
  };
}

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
}

export function assertStrictSemVer(value: unknown, fieldPath: string): string {
  return parseStrictSemVer(value, fieldPath).raw;
}

export function assertCatalogVersion(value: unknown, fieldPath: string): string {
  const parsed = parseStrictSemVer(value, fieldPath);
  const isStable = parsed.prerelease.length === 0 && parsed.build.length === 0;
  const isBeta = parsed.prerelease.length === 2
    && parsed.prerelease[0] === 'beta'
    && /^[1-9]\d*$/u.test(parsed.prerelease[1] ?? '')
    && parsed.build.length === 0;
  if (!isStable && !isBeta) {
    throw new Error(`Invalid ${fieldPath}: expected a stable SemVer or an exact x.y.z-beta.N version.`);
  }
  return parsed.raw;
}

export function tryParseStrictSemVer(value: unknown): StrictSemVer | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = STRICT_SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

export function parseStrictSemVer(value: unknown, fieldPath: string): StrictSemVer {
  const issue = getStrictSemVerValidationIssue(value, fieldPath);
  if (issue) {
    throw new StrictSemVerValidationError(issue);
  }

  return tryParseStrictSemVer(value)!;
}

function isNumericSemVerIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = isNumericSemVerIdentifier(left);
  const rightNumeric = isNumericSemVerIdentifier(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareStrictSemVer(
  left: string | StrictSemVer,
  right: string | StrictSemVer,
): number {
  const resolvedLeft = typeof left === 'string'
    ? parseStrictSemVer(left, 'left version')
    : left;
  const resolvedRight = typeof right === 'string'
    ? parseStrictSemVer(right, 'right version')
    : right;

  if (resolvedLeft.major !== resolvedRight.major) {
    return resolvedLeft.major - resolvedRight.major;
  }
  if (resolvedLeft.minor !== resolvedRight.minor) {
    return resolvedLeft.minor - resolvedRight.minor;
  }
  if (resolvedLeft.patch !== resolvedRight.patch) {
    return resolvedLeft.patch - resolvedRight.patch;
  }

  if (resolvedLeft.prerelease.length === 0 && resolvedRight.prerelease.length === 0) {
    return 0;
  }
  if (resolvedLeft.prerelease.length === 0) {
    return 1;
  }
  if (resolvedRight.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(resolvedLeft.prerelease.length, resolvedRight.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = resolvedLeft.prerelease[index];
    const rightIdentifier = resolvedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const result = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

function ensureStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) => ensureString(entry, `${fieldName}[${index}]`));
}

function normalizePermissionCommandArray(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries = ensureStringArray(value, fieldName);
  for (const [index, entry] of entries.entries()) {
    parsePermissionCommand(entry, `${fieldName}[${index}]`);
  }

  return entries;
}

function normalizeComparableStringArray(value: string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function ensureDigestString(value: unknown, fieldName: string): string {
  const digest = ensureString(value, fieldName);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`Invalid ${fieldName}: expected a sha256 digest string.`);
  }

  return digest;
}

function isPrereleaseVersion(value: string): boolean {
  return parseStrictSemVer(value, 'version').prerelease.length > 0;
}

function assertCatalogChannel(value: unknown, fieldName: string): CatalogChannel {
  const channel = ensureString(value, fieldName);
  if (!CATALOG_CHANNELS.has(channel as CatalogChannel)) {
    throw new Error(`Invalid ${fieldName}: expected "latest" or "beta".`);
  }

  return channel as CatalogChannel;
}

function createPluginCompatibility(minVersion: string): PluginCompatibility {
  return {
    aw: {
      minVersion,
    },
  };
}

function normalizePluginCompatibility(
  value: unknown,
  fieldName: string,
  options: {
    allowMissing: boolean;
    defaultMinVersion?: string;
  },
): PluginCompatibility {
  if (value === undefined) {
    if (options.allowMissing) {
      return createPluginCompatibility(
        assertStrictSemVer(
          options.defaultMinVersion ?? DEFAULT_SOURCE_PLUGIN_AW_MIN_VERSION,
          `${fieldName}.aw.minVersion`,
        ),
      );
    }

    throw new Error(`Invalid ${fieldName}.aw.minVersion: expected a strict SemVer 2.0.0 string. Received undefined.`);
  }

  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['aw']);
  const aw = assertObject(input.aw, `${fieldName}.aw`);
  assertAllowedKeys(aw, `${fieldName}.aw`, ['minVersion']);

  return createPluginCompatibility(
    assertStrictSemVer(aw.minVersion, `${fieldName}.aw.minVersion`),
  );
}

function assertPluginMinVersionWithinCatalogBounds(options: {
  pluginName: string;
  pluginMinVersion: string;
  catalogMinVersion: string;
  fieldName: string;
}): void {
  if (compareStrictSemVer(options.pluginMinVersion, options.catalogMinVersion) > 0) {
    throw new Error(
      `Invalid ${options.fieldName}: plugin "${options.pluginName}" requires aw ${options.pluginMinVersion}, which is higher than catalog minimum ${options.catalogMinVersion}.`,
    );
  }
}

function normalizeMarketplaceProducts(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const products = ensureStringArray(value, fieldName);
  for (const [index, product] of products.entries()) {
    const normalized = normalizeMarketplaceProductToken(product);
    if (!MANIFEST_POLICY_PRODUCTS.has(normalized)) {
      throw new Error(`Invalid ${fieldName}[${index}]: expected one of "CODEX" or "CLAUDE".`);
    }
  }

  return normalizeComparableStringArray(products);
}

export function assertPlatformFieldSupported(options: {
  pluginName: string;
  manifest: PluginManifestSource;
  fieldPath: string;
  requiredPlatform: PlatformName;
}): void {
  if (supportsPlatform(options.manifest, options.requiredPlatform)) {
    return;
  }

  throw new Error(
    `Invalid plugin "${options.pluginName}": ${options.fieldPath} requires ${PLATFORM_PRODUCT_BY_NAME[options.requiredPlatform]} support, but ${formatMarketplaceProductsForError(options.manifest)}.`,
  );
}

function hasNonEmptyPlatformOverride(
  value: Record<string, unknown> | null | undefined,
): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

function omitUndefinedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function assertAgentOverridePlatformsSupported(options: {
  pluginName: string;
  manifest: PluginManifestSource;
  fieldPath: string;
  agentOverrides: PlatformAgentOverrides<unknown> | undefined;
}): void {
  for (const platform of ['claude', 'codex'] as const) {
    if (
      hasNonEmptyPlatformOverride(
        options.agentOverrides?.[platform] as Record<string, unknown> | null | undefined,
      )
    ) {
      assertPlatformFieldSupported({
        pluginName: options.pluginName,
        manifest: options.manifest,
        fieldPath: `${options.fieldPath}.agentOverrides.${platform}`,
        requiredPlatform: platform,
      });
    }
  }
}

export function assertManifestPlatformSupport(
  pluginName: string,
  manifest: PluginManifestSource,
): void {
  if (manifest.buildConfig?.fileRules?.claude !== undefined) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'buildConfig.fileRules.claude',
      requiredPlatform: 'claude',
    });
  }
  if (manifest.buildConfig?.fileRules?.codex !== undefined) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'buildConfig.fileRules.codex',
      requiredPlatform: 'codex',
    });
  }
  if (manifest.buildConfig?.manifestOverrides?.claude !== undefined) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'buildConfig.manifestOverrides.claude',
      requiredPlatform: 'claude',
    });
  }
  if (manifest.buildConfig?.manifestOverrides?.codex !== undefined) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'buildConfig.manifestOverrides.codex',
      requiredPlatform: 'codex',
    });
  }
  manifest.buildConfig?.skillRuntimeFiles?.forEach((entry, index) => {
    for (const platform of entry.platforms ?? []) {
      assertPlatformFieldSupported({
        pluginName,
        manifest,
        fieldPath: `buildConfig.skillRuntimeFiles[${index}].platforms`,
        requiredPlatform: platform,
      });
    }
  });
  if (manifest.apps) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'apps',
      requiredPlatform: 'codex',
    });
  }

  if ((manifest.extensions?.nativeHooks?.claude?.length ?? 0) > 0) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'extensions.nativeHooks.claude',
      requiredPlatform: 'claude',
    });
  }
  if ((manifest.extensions?.nativeHooks?.codex?.length ?? 0) > 0) {
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: 'extensions.nativeHooks.codex',
      requiredPlatform: 'codex',
    });
  }

  for (const [fieldName, entries] of [
    ['extensions.instructions', manifest.extensions?.instructions],
    ['extensions.permissions', manifest.extensions?.permissions],
    ['extensions.hooks', manifest.extensions?.hooks],
    ['extensions.agents', manifest.extensions?.agents],
  ] as const) {
    entries?.forEach((entry, index) => {
      assertAgentOverridePlatformsSupported({
        pluginName,
        manifest,
        fieldPath: `${fieldName}[${index}]`,
        agentOverrides: entry.agentOverrides,
      });
    });
  }

  manifest.artifacts?.targets?.forEach((target, index) => {
    if (!target.platform) return;
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: `artifacts.targets[${index}].platform`,
      requiredPlatform: target.platform,
    });
  });
}

export function ensurePluginName(value: unknown, fieldName: string): string {
  const name = ensureString(value, fieldName);
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${fieldName}: expected lowercase hyphen-case.`);
  }
  return name;
}

function normalizePluginChildPath(
  pluginRoot: string,
  value: string,
  fieldName: string,
): string {
  if (path.isAbsolute(value)) {
    throw new Error(`Invalid ${fieldName}: absolute paths are not allowed.`);
  }

  if (!value.startsWith('./')) {
    throw new Error(`Invalid ${fieldName}: path must start with "./".`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid ${fieldName}: path must stay inside the plugin root.`);
  }

  const resolved = path.resolve(pluginRoot, normalized);
  const relativeToRoot = path.relative(pluginRoot, resolved);
  if (relativeToRoot === '' || relativeToRoot === '.' || relativeToRoot.startsWith('..')) {
    throw new Error(`Invalid ${fieldName}: path must point to a child path inside the plugin root.`);
  }

  return normalized.startsWith('./') ? normalized : `./${normalized}`;
}

export function normalizePluginRelativePath(
  pluginRoot: string,
  value: string,
  fieldName: string,
): string {
  const normalized = normalizePluginChildPath(pluginRoot, value, fieldName);
  const ignoredSegment = normalized.split(/[\\/]/u).find((segment) =>
    segment === '.git' || segment === 'node_modules');
  if (ignoredSegment) {
    throw new Error(`Invalid ${fieldName}: source paths must not enter ${ignoredSegment}.`);
  }
  return normalized;
}

function normalizePathArray(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return ensureStringArray(value, fieldName).map((entry, index) =>
    normalizePluginRelativePath(pluginRoot, entry, `${fieldName}[${index}]`),
  );
}

function normalizePluginInterface(
  value: unknown,
  fieldName: string,
): PluginInterfaceMeta {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['displayName', 'shortDescription', 'capabilities']);

  return {
    displayName:
      typeof input.displayName === 'string' ? input.displayName : undefined,
    shortDescription:
      typeof input.shortDescription === 'string' ? input.shortDescription : undefined,
    capabilities:
      input.capabilities === undefined
        ? undefined
        : ensureStringArray(input.capabilities, `${fieldName}.capabilities`),
  };
}

function normalizeMarketplacePolicy(
  value: unknown,
  fieldName: string,
): PluginMarketplaceMeta['policy'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['installation', 'authentication', 'products']);
  const authentication = ensureString(
    input.authentication,
    `${fieldName}.authentication`,
  );
  if (
    !MARKETPLACE_AUTHENTICATION_POLICIES.has(
      authentication as MarketplaceAuthenticationPolicy,
    )
  ) {
    throw new Error(
      `Invalid ${fieldName}.authentication: expected "ON_INSTALL" or "ON_USE".`,
    );
  }
  const installation = ensureString(input.installation, `${fieldName}.installation`);
  if (!['AVAILABLE', 'NOT_AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(installation)) {
    throw new Error(
      `Invalid ${fieldName}.installation: expected "AVAILABLE", "NOT_AVAILABLE", or "INSTALLED_BY_DEFAULT".`,
    );
  }

  return {
    installation: installation as PluginMarketplaceMeta['policy']['installation'],
    authentication: authentication as MarketplaceAuthenticationPolicy,
    products: normalizeMarketplaceProducts(input.products, `${fieldName}.products`),
  };
}

function normalizeMarketplaceMeta(
  value: unknown,
  fieldName: string,
): PluginMarketplaceMeta {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['category', 'tags', 'strict', 'policy']);

  if (typeof input.strict !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.strict: expected a boolean.`);
  }

  return {
    category: ensureString(input.category, `${fieldName}.category`),
    tags:
      input.tags === undefined
        ? undefined
        : normalizeComparableStringArray(ensureStringArray(input.tags, `${fieldName}.tags`)),
    strict: input.strict,
    policy: normalizeMarketplacePolicy(input.policy, `${fieldName}.policy`),
  };
}

function normalizeTemplateVarByPlatform(
  value: unknown,
  fieldName: string,
): TemplateVarByPlatform {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const claude = input.claude;
  const codex = input.codex;
  if (
    (typeof claude !== 'string' && typeof claude !== 'boolean') ||
    (typeof codex !== 'string' && typeof codex !== 'boolean')
  ) {
    throw new Error(`Invalid ${fieldName}: template vars must be string or boolean per platform.`);
  }

  return {
    claude,
    codex,
  };
}

function normalizeBuildConfigTemplates(
  value: unknown,
  fieldName: string,
): BuildConfigTemplates {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['vars', 'include']);

  const varsInput = assertObject(input.vars ?? {}, `${fieldName}.vars`);
  const vars: BuildConfigTemplates['vars'] = {};

  for (const [key, entry] of Object.entries(varsInput)) {
    vars[key] = normalizeTemplateVarByPlatform(entry, `${fieldName}.vars.${key}`);
  }

  return {
    vars,
    include: ensureStringArray(input.include ?? [], `${fieldName}.include`),
  };
}

function normalizeFileRuleSet(
  value: unknown,
  fieldName: string,
): BuildConfigFileRuleSet {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['include', 'exclude']);

  return {
    include: ensureStringArray(input.include ?? [], `${fieldName}.include`),
    exclude: ensureStringArray(input.exclude ?? [], `${fieldName}.exclude`),
  };
}

function normalizeClaudeManifestOverrides(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): ClaudeManifestOverrides {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['commands', 'outputStyles', 'lspServers', 'userConfig', 'channels']);

  const output: ClaudeManifestOverrides = {};

  if (input.commands !== undefined) {
    output.commands = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.commands, `${fieldName}.commands`),
      `${fieldName}.commands`,
    );
  }

  if (input.outputStyles !== undefined) {
    output.outputStyles = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.outputStyles, `${fieldName}.outputStyles`),
      `${fieldName}.outputStyles`,
    );
  }

  if (input.lspServers !== undefined) {
    if (typeof input.lspServers === 'string') {
      output.lspServers = normalizePluginRelativePath(
        pluginRoot,
        ensureString(input.lspServers, `${fieldName}.lspServers`),
        `${fieldName}.lspServers`,
      );
    } else if (Array.isArray(input.lspServers)) {
      output.lspServers = input.lspServers.map((entry, index) =>
        typeof entry === 'string'
          ? normalizePluginRelativePath(
              pluginRoot,
              ensureString(entry, `${fieldName}.lspServers[${index}]`),
              `${fieldName}.lspServers[${index}]`,
            )
          : assertObject(entry, `${fieldName}.lspServers[${index}]`),
      );
    } else {
      output.lspServers = assertObject(input.lspServers, `${fieldName}.lspServers`);
    }
  }

  if (input.userConfig !== undefined) {
    output.userConfig = assertObject(input.userConfig, `${fieldName}.userConfig`);
  }

  if (input.channels !== undefined) {
    if (Array.isArray(input.channels)) {
      output.channels = input.channels.map((entry, index) =>
        assertObject(entry, `${fieldName}.channels[${index}]`),
      );
    } else {
      output.channels = assertObject(input.channels, `${fieldName}.channels`);
    }
  }

  return output;
}

function normalizeRuntimeExportName(value: unknown, fieldName: string): string {
  return ensurePluginName(value, fieldName);
}

function normalizeCanonicalPluginFilePath(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): string {
  const raw = ensureString(value, fieldName);
  if (raw.includes('\\')) {
    throw new Error(`Invalid ${fieldName}: expected a canonical POSIX path.`);
  }
  const normalized = normalizePluginRelativePath(pluginRoot, raw, fieldName);
  if (normalized !== raw) {
    throw new Error(`Invalid ${fieldName}: expected a canonical POSIX path.`);
  }
  return normalized;
}

function normalizeImportReference(
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): { plugin: string; export: string } {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['plugin', 'export']);
  const plugin = ensureString(input.plugin, `${fieldName}.plugin`);
  const exportName = normalizeRuntimeExportName(input.export, `${fieldName}.export`);
  if (plugin.startsWith('@')) {
    const allowedExports = reservedImports && Object.hasOwn(reservedImports, plugin)
      ? reservedImports[plugin]
      : undefined;
    if (!allowedExports) {
      throw new Error(`Invalid ${fieldName}.plugin: unknown reserved provider "${plugin}".`);
    }
    if (!allowedExports.includes(exportName)) {
      throw new Error(
        `Invalid ${fieldName}.export: unknown reserved export "${exportName}" for provider "${plugin}".`,
      );
    }
  } else {
    ensurePluginName(plugin, `${fieldName}.plugin`);
  }
  return {
    plugin,
    export: exportName,
  };
}

function normalizeRuntimeExports(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): NonNullable<BuildConfig['runtimeExports']> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${fieldName}[${index}]`;
    const input = assertObject(entry, entryField);
    assertAllowedKeys(input, entryField, ['name', 'source']);
    const name = normalizeRuntimeExportName(input.name, `${entryField}.name`);
    if (names.has(name)) {
      throw new Error(`Invalid ${fieldName}: duplicate export name "${name}".`);
    }
    names.add(name);
    return {
      name,
      source: normalizeCanonicalPluginFilePath(pluginRoot, input.source, `${entryField}.source`),
    };
  });
}

function normalizeBuildImports(
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): NonNullable<BuildConfig['buildImports']> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }
  const envNames = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${fieldName}[${index}]`;
    const input = assertObject(entry, entryField);
    assertAllowedKeys(input, entryField, ['plugin', 'export', 'env']);
    const reference = normalizeImportReference(
      { plugin: input.plugin, export: input.export },
      entryField,
      reservedImports,
    );
    const env = ensureString(input.env, `${entryField}.env`);
    if (!/^AW_PLUGIN_IMPORT_[A-Z0-9_]+$/u.test(env)) {
      throw new Error(`Invalid ${entryField}.env: expected an AW_PLUGIN_IMPORT_ prefixed variable name.`);
    }
    if (envNames.has(env)) {
      throw new Error(`Invalid ${fieldName}: duplicate env name "${env}".`);
    }
    envNames.add(env);
    return { ...reference, env };
  });
}

function normalizeSkillRuntimeTarget(value: unknown, fieldName: string): string {
  const target = ensureString(value, fieldName);
  if (
    target.includes('\\')
    || target.startsWith('./')
    || path.posix.isAbsolute(target)
    || path.posix.normalize(target) !== target
    || !/^(?:references|assets|scripts)\/.+/u.test(target)
    || target.endsWith('/')
  ) {
    throw new Error(
      `Invalid ${fieldName}: expected a canonical file path below references/, assets/, or scripts/.`,
    );
  }
  return target;
}

function normalizeSkillRuntimeFiles(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): NonNullable<BuildConfig['skillRuntimeFiles']> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }
  const targets = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${fieldName}[${index}]`;
    const input = assertObject(entry, entryField);
    assertAllowedKeys(input, entryField, ['skill', 'target', 'platforms', 'distributions', 'source', 'import']);
    const skill = ensurePluginName(input.skill, `${entryField}.skill`);
    const target = normalizeSkillRuntimeTarget(input.target, `${entryField}.target`);
    const collisionKey = `${skill}/${target}`;
    if (targets.has(collisionKey)) {
      throw new Error(`Invalid ${fieldName}: duplicate target "${collisionKey}".`);
    }
    targets.add(collisionKey);
    const hasSource = input.source !== undefined;
    const hasImport = input.import !== undefined;
    if (hasSource === hasImport) {
      throw new Error(`Invalid ${entryField}: exactly one of source or import is required.`);
    }
    let platforms: PlatformName[] | undefined;
    if (input.platforms !== undefined) {
      const values = ensureStringArray(input.platforms, `${entryField}.platforms`);
      platforms = values.map((platform, platformIndex) => {
        if (platform !== 'claude' && platform !== 'codex') {
          throw new Error(`Invalid ${entryField}.platforms[${platformIndex}]: expected claude or codex.`);
        }
        return platform;
      });
      if (new Set(platforms).size !== platforms.length) {
        throw new Error(`Invalid ${entryField}.platforms: duplicate platform.`);
      }
    }
    let distributions: Array<'agent-skills'> | undefined;
    if (input.distributions !== undefined) {
      const values = ensureStringArray(input.distributions, `${entryField}.distributions`);
      distributions = values.map((distribution, distributionIndex) => {
        if (distribution !== 'agent-skills') {
          throw new Error(`Invalid ${entryField}.distributions[${distributionIndex}]: expected agent-skills.`);
        }
        return distribution;
      });
      if (new Set(distributions).size !== distributions.length) {
        throw new Error(`Invalid ${entryField}.distributions: duplicate distribution.`);
      }
    }
    return {
      skill,
      target,
      ...(platforms ? { platforms } : {}),
      ...(distributions ? { distributions } : {}),
      ...(hasSource
        ? { source: normalizeCanonicalPluginFilePath(pluginRoot, input.source, `${entryField}.source`) }
        : { import: normalizeImportReference(input.import, `${entryField}.import`, reservedImports) }),
    };
  });
}

function normalizeGeneratedSkillRuntimeFiles(
  value: unknown,
  fieldName: string,
): NonNullable<BuildConfig['generatedSkillRuntimeFiles']> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }
  const targets = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${fieldName}[${index}]`;
    const input = assertObject(entry, entryField);
    assertAllowedKeys(input, entryField, ['skill', 'target', 'distributions']);
    const skill = ensurePluginName(input.skill, `${entryField}.skill`);
    const target = normalizeSkillRuntimeTarget(input.target, `${entryField}.target`);
    const collisionKey = `${skill}/${target}`;
    if (targets.has(collisionKey)) {
      throw new Error(`Invalid ${fieldName}: duplicate target "${collisionKey}".`);
    }
    targets.add(collisionKey);
    const distributions: Array<'agent-skills'> | undefined = input.distributions === undefined
      ? undefined
      : ensureStringArray(input.distributions, `${entryField}.distributions`).map((distribution, distributionIndex) => {
          if (distribution !== 'agent-skills') {
            throw new Error(`Invalid ${entryField}.distributions[${distributionIndex}]: expected agent-skills.`);
          }
          return distribution;
        });
    if (distributions && new Set(distributions).size !== distributions.length) {
      throw new Error(`Invalid ${entryField}.distributions: duplicate distribution.`);
    }
    return {
      skill,
      target,
      ...(distributions ? { distributions } : {}),
    };
  });
}

function normalizeBuildConfig(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): BuildConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, [
    'cacheable',
    'templates',
    'fileRules',
    'manifestOverrides',
    'runtimeExports',
    'buildImports',
    'skillRuntimeFiles',
    'generatedSkillRuntimeFiles',
  ]);

  const buildConfig: BuildConfig = {};

  if (input.cacheable !== undefined) {
    if (input.cacheable !== true) {
      throw new Error(`Invalid ${fieldName}.cacheable: expected true.`);
    }
    buildConfig.cacheable = true;
  }

  if (input.templates !== undefined) {
    buildConfig.templates = normalizeBuildConfigTemplates(
      input.templates,
      `${fieldName}.templates`,
    );
  }

  if (input.fileRules !== undefined) {
    const fileRulesInput = assertObject(input.fileRules, `${fieldName}.fileRules`);
    assertAllowedKeys(fileRulesInput, `${fieldName}.fileRules`, ['claude', 'codex']);
    buildConfig.fileRules = {};

    if (fileRulesInput.claude !== undefined) {
      const normalizedRuleSet = normalizeFileRuleSet(
        fileRulesInput.claude,
        `${fieldName}.fileRules.claude`,
      );
      assertNoDeprecatedCommandFileRules(normalizedRuleSet, `${fieldName}.fileRules.claude`);
      buildConfig.fileRules.claude = normalizedRuleSet;
    }

    if (fileRulesInput.codex !== undefined) {
      const normalizedRuleSet = normalizeFileRuleSet(
        fileRulesInput.codex,
        `${fieldName}.fileRules.codex`,
      );
      assertNoDeprecatedCommandFileRules(normalizedRuleSet, `${fieldName}.fileRules.codex`);
      buildConfig.fileRules.codex = normalizedRuleSet;
    }
  }

  if (input.manifestOverrides !== undefined) {
    const overridesInput = assertObject(
      input.manifestOverrides,
      `${fieldName}.manifestOverrides`,
    );
    assertAllowedKeys(overridesInput, `${fieldName}.manifestOverrides`, ['claude', 'codex']);
    buildConfig.manifestOverrides = {};

    if (overridesInput.claude !== undefined) {
      const claudeOverridesInput = assertObject(
        overridesInput.claude,
        `${fieldName}.manifestOverrides.claude`,
      );
      if (Object.hasOwn(claudeOverridesInput, 'commands')) {
        throw new Error(
          'Invalid buildConfig.manifestOverrides.claude.commands: source manifests must use "slashCommands" instead.',
        );
      }
      buildConfig.manifestOverrides.claude = normalizeClaudeManifestOverrides(
        pluginRoot,
        claudeOverridesInput,
        `${fieldName}.manifestOverrides.claude`,
      );
    }

    if (overridesInput.codex !== undefined) {
      const codexOverrides = assertObject(
        overridesInput.codex,
        `${fieldName}.manifestOverrides.codex`,
      );
      assertAllowedKeys(codexOverrides, `${fieldName}.manifestOverrides.codex`, []);
      buildConfig.manifestOverrides.codex = {};
    }
  }

  if (input.runtimeExports !== undefined) {
    buildConfig.runtimeExports = normalizeRuntimeExports(
      pluginRoot,
      input.runtimeExports,
      `${fieldName}.runtimeExports`,
    );
  }
  if (input.buildImports !== undefined) {
    buildConfig.buildImports = normalizeBuildImports(
      input.buildImports,
      `${fieldName}.buildImports`,
      reservedImports,
    );
  }
  if (input.skillRuntimeFiles !== undefined) {
    buildConfig.skillRuntimeFiles = normalizeSkillRuntimeFiles(
      pluginRoot,
      input.skillRuntimeFiles,
      `${fieldName}.skillRuntimeFiles`,
      reservedImports,
    );
  }
  if (input.generatedSkillRuntimeFiles !== undefined) {
    buildConfig.generatedSkillRuntimeFiles = normalizeGeneratedSkillRuntimeFiles(
      input.generatedSkillRuntimeFiles,
      `${fieldName}.generatedSkillRuntimeFiles`,
    );
  }

  return buildConfig;
}

function assertNoDeprecatedCommandFileRules(
  fileRuleSet: BuildConfigFileRuleSet,
  fieldName: string,
): void {
  for (const pattern of [...fileRuleSet.include, ...fileRuleSet.exclude]) {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalizedPattern === 'commands' || normalizedPattern.startsWith('commands/')) {
      throw new Error(
        `Invalid ${fieldName}: legacy "commands/**" source rules are no longer supported; use "slashCommands" instead.`,
      );
    }
  }
}

function ensureBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${fieldName}: expected a boolean.`);
  }

  return value;
}

function ensureFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldName}: expected a number.`);
  }

  return value;
}

function normalizeScriptTimeout(value: unknown, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < PLUGIN_SCRIPT_TIMEOUT_MIN_MS ||
    value > PLUGIN_SCRIPT_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `Invalid ${fieldName}: expected an integer between ${PLUGIN_SCRIPT_TIMEOUT_MIN_MS} and ${PLUGIN_SCRIPT_TIMEOUT_MAX_MS}.`,
    );
  }

  return value;
}

function assertNodeRunnablePath(value: string, fieldName: string): void {
  const extension = path.posix.extname(value).toLowerCase();
  if (!NODE_RUNNABLE_EXTENSIONS.has(extension)) {
    throw new Error(`Invalid ${fieldName}: expected a Node runnable file extension (.js, .mjs, or .cjs).`);
  }
}

function assertAutoRunnablePath(value: string, fieldName: string): void {
  if (!inferLifecycleScriptRunnerFromPath(value)) {
    throw new Error(
      `Invalid ${fieldName}: runner "auto" requires one of these file extensions: ${PLUGIN_AUTO_RUNNER_EXTENSIONS.join(', ')}.`,
    );
  }
}

function assertNotInlineCommandLike(value: string, fieldName: string): void {
  if (/\s|[;&|<>`]/.test(value) || value.includes('$(')) {
    throw new Error(`Invalid ${fieldName}: inline command strings are not allowed.`);
  }
}

function normalizePluginScriptPath(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): string {
  const rawPath = ensureString(value, fieldName);
  assertNotInlineCommandLike(rawPath, fieldName);
  return normalizePluginRelativePath(pluginRoot, rawPath, fieldName);
}

function normalizeScriptEntry(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
  options: { requireNodeRunner?: boolean } = {},
): PluginLifecycleScriptEntry {
  const input = assertObject(value, fieldName);
  if ('command' in input) {
    throw new Error(`Invalid ${fieldName}: inline command strings are not allowed.`);
  }
  if ('timeoutMs' in input || 'timeout' in input) {
    throw new Error(`Invalid ${fieldName}: per-event and per-selector timeouts are not supported.`);
  }
  assertAllowedKeys(input, fieldName, ['runner', 'path', 'args']);

  const runner = ensureString(input.runner, `${fieldName}.runner`);
  if (!isPluginScriptRunner(runner)) {
    throw new Error(`Invalid ${fieldName}.runner: unsupported runner "${runner}".`);
  }
  if (options.requireNodeRunner && runner !== 'node') {
    throw new Error(`Invalid ${fieldName}.runner: expected "node".`);
  }

  const scriptPath = normalizePluginScriptPath(pluginRoot, input.path, `${fieldName}.path`);
  if (runner === 'auto') {
    assertAutoRunnablePath(scriptPath, `${fieldName}.path`);
  }

  return {
    runner,
    path: scriptPath,
    args:
      input.args === undefined
        ? undefined
        : ensureStringArray(input.args, `${fieldName}.args`),
  };
}

function normalizeLifecycleScriptDefinition(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): PluginLifecycleScriptSelector {
  if (typeof value === 'string') {
    const scriptPath = normalizePluginScriptPath(pluginRoot, value, fieldName);
    assertAutoRunnablePath(scriptPath, fieldName);
    return {
      default: {
        runner: 'auto',
        path: scriptPath,
      },
    };
  }

  const input = assertObject(value, fieldName);
  if ('runner' in input || 'path' in input || 'command' in input) {
    throw new Error(`Invalid ${fieldName}: lifecycle scripts must be declared under OS selectors.`);
  }
  if ('timeoutMs' in input || 'timeout' in input) {
    throw new Error(`Invalid ${fieldName}: per-event and per-selector timeouts are not supported.`);
  }

  for (const key of Object.keys(input)) {
    if (!isPluginLifecycleOsSelector(key)) {
      throw new Error(`Invalid ${fieldName}: unknown OS selector "${key}".`);
    }
  }

  const output: PluginLifecycleScriptSelector = {};
  for (const [selector, entry] of Object.entries(input)) {
    output[selector as keyof PluginLifecycleScriptSelector] = normalizeScriptEntry(
      pluginRoot,
      entry,
      `${fieldName}.${selector}`,
    );
  }

  for (const osName of ['linux', 'darwin', 'win32'] as const satisfies readonly PluginLifecycleRuntimeOs[]) {
    if (!resolveLifecycleScriptForOs(output, osName)) {
      throw new Error(`Invalid ${fieldName}: no lifecycle entry resolves on ${osName}.`);
    }
  }

  return output;
}

function normalizeLifecycleScripts(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): NonNullable<PluginScriptsConfig['lifecycle']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, [...PLUGIN_LIFECYCLE_EVENTS]);

  const output: NonNullable<PluginScriptsConfig['lifecycle']> = {};
  for (const event of PLUGIN_LIFECYCLE_EVENTS) {
    if (input[event] === undefined) {
      continue;
    }
    output[event] = normalizeLifecycleScriptDefinition(
      pluginRoot,
      input[event],
      `${fieldName}.${event}`,
    );
  }

  return output;
}

function normalizeScriptHelpers(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): NonNullable<PluginScriptsConfig['helpers']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['config']);

  if (input.config === undefined) {
    throw new Error(`Invalid ${fieldName}: expected explicit "config" helper declaration.`);
  }

  const config = normalizePluginScriptPath(pluginRoot, input.config, `${fieldName}.config`);
  assertNodeRunnablePath(config, `${fieldName}.config`);

  return { config };
}

function normalizeNodeBuildScript(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): PluginNodeBuildScript {
  const entry = normalizeScriptEntry(pluginRoot, value, fieldName, {
    requireNodeRunner: true,
  });
  assertNodeRunnablePath(entry.path, `${fieldName}.path`);
  return {
    runner: 'node',
    path: entry.path,
    args: entry.args,
  };
}

function normalizePackageDependencyRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const input = assertObject(value, fieldName);
  const output: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(input)) {
    output[ensureString(name, `${fieldName} key`)] = ensureString(
      specifier,
      `${fieldName}.${name}`,
    );
  }

  return output;
}

function isNonRegistryDependencySpecifier(specifier: string): boolean {
  const trimmed = specifier.trim();
  return (
    /^(?:workspace|file|link|portal):/i.test(trimmed) ||
    /^(?:git\+|git:|ssh:)/i.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /(?:\.tgz|\.tar\.gz)(?:[#?].*)?$/i.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(trimmed)
  );
}

function validatePackageDependencies(packageJson: Record<string, unknown>, fieldName: string): void {
  if (packageJson.optionalDependencies !== undefined) {
    throw new Error(`Invalid ${fieldName}.optionalDependencies: optionalDependencies are not supported.`);
  }
  if (packageJson.bundledDependencies !== undefined || packageJson.bundleDependencies !== undefined) {
    throw new Error(`Invalid ${fieldName}.bundledDependencies: bundledDependencies are not supported.`);
  }

  for (const dependencyField of ['dependencies', 'devDependencies'] as const) {
    const dependencies = normalizePackageDependencyRecord(
      packageJson[dependencyField],
      `${fieldName}.${dependencyField}`,
    );
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (isNonRegistryDependencySpecifier(specifier)) {
        throw new Error(
          `Invalid ${fieldName}.${dependencyField}.${name}: dependency specifier "${specifier}" is not registry-backed.`,
        );
      }
    }
  }
}

function validateNodePackageRoot(pluginRoot: string, packageRoot: string, fieldName: string): void {
  const absolutePackageRoot = path.join(pluginRoot, stripDotSlash(packageRoot));
  const stats = fs.statSync(absolutePackageRoot, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) {
    throw new Error(`Invalid ${fieldName}: expected a package directory at "${packageRoot}".`);
  }

  const packageJsonPath = path.join(absolutePackageRoot, 'package.json');
  const lockfilePath = path.join(absolutePackageRoot, 'pnpm-lock.yaml');
  for (const lockfile of ['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (fs.pathExistsSync(path.join(absolutePackageRoot, lockfile))) {
      throw new Error(`Invalid ${fieldName}: only pnpm-lock.yaml is supported, found ${lockfile}.`);
    }
  }
  if (!fs.pathExistsSync(packageJsonPath)) {
    throw new Error(`Invalid ${fieldName}: missing package.json.`);
  }
  if (!fs.pathExistsSync(lockfilePath)) {
    throw new Error(`Invalid ${fieldName}: missing pnpm-lock.yaml.`);
  }

  let packageJson: unknown;
  try {
    packageJson = fs.readJsonSync(packageJsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}.package.json: ${message}`);
  }
  validatePackageDependencies(
    assertObject(packageJson, `${fieldName}.package.json`),
    `${fieldName}.package.json`,
  );
}

function normalizeNodeScripts(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): PluginNodeScriptsConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['packageRoot', 'build']);

  const output: PluginNodeScriptsConfig = {};
  if (input.packageRoot !== undefined) {
    output.packageRoot = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.packageRoot, `${fieldName}.packageRoot`),
      `${fieldName}.packageRoot`,
    );
    validateNodePackageRoot(pluginRoot, output.packageRoot, `${fieldName}.packageRoot`);
  }

  if (input.build !== undefined) {
    output.build = normalizeNodeBuildScript(pluginRoot, input.build, `${fieldName}.build`);
  }

  return output;
}

function normalizeScriptTests(
  value: unknown,
  fieldName: string,
): NonNullable<PluginScriptsConfig['tests']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['node']);

  return {
    node:
      input.node === undefined
        ? undefined
        : ensureStringArray(input.node, `${fieldName}.node`),
  };
}

function normalizeArtifactRenderScript(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): PluginArtifactRenderScriptEntry {
  const entry = normalizeScriptEntry(pluginRoot, value, fieldName, {
    requireNodeRunner: true,
  });
  assertNodeRunnablePath(entry.path, `${fieldName}.path`);
  return {
    runner: 'node',
    path: entry.path,
    args: entry.args,
  };
}

function normalizeArtifactScripts(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): NonNullable<PluginScriptsConfig['artifacts']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['render']);

  return {
    render:
      input.render === undefined
        ? undefined
        : normalizeArtifactRenderScript(pluginRoot, input.render, `${fieldName}.render`),
  };
}

function normalizePluginScripts(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): PluginScriptsConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['timeoutMs', 'lifecycle', 'helpers', 'node', 'artifacts', 'tests']);

  const output: PluginScriptsConfig = {
    timeoutMs:
      input.timeoutMs === undefined
        ? PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS
        : normalizeScriptTimeout(input.timeoutMs, `${fieldName}.timeoutMs`),
  };

  if (input.lifecycle !== undefined) {
    output.lifecycle = normalizeLifecycleScripts(pluginRoot, input.lifecycle, `${fieldName}.lifecycle`);
  }

  if (input.helpers !== undefined) {
    output.helpers = normalizeScriptHelpers(pluginRoot, input.helpers, `${fieldName}.helpers`);
  }

  if (input.node !== undefined) {
    output.node = normalizeNodeScripts(pluginRoot, input.node, `${fieldName}.node`);
  }

  if (input.artifacts !== undefined) {
    output.artifacts = normalizeArtifactScripts(pluginRoot, input.artifacts, `${fieldName}.artifacts`);
  }

  if (input.tests !== undefined) {
    output.tests = normalizeScriptTests(input.tests, `${fieldName}.tests`);
  }

  return output;
}

function validateConfigKey(key: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid ${fieldName}: config key "${key}" is not valid.`);
  }
}

function validateConfigDefault(
  type: string,
  value: unknown,
  values: string[] | undefined,
  min: number | undefined,
  max: number | undefined,
  fieldName: string,
): string | number | boolean {
  if (type === 'string' || type === 'file' || type === 'directory') {
    return ensureString(value, fieldName);
  }
  if (type === 'boolean') {
    return ensureBoolean(value, fieldName);
  }
  if (type === 'number') {
    const numberValue = ensureFiniteNumber(value, fieldName);
    if (min !== undefined && numberValue < min) {
      throw new Error(`Invalid ${fieldName}: default is smaller than min.`);
    }
    if (max !== undefined && numberValue > max) {
      throw new Error(`Invalid ${fieldName}: default is greater than max.`);
    }
    return numberValue;
  }
  if (type === 'enum') {
    const enumValue = ensureString(value, fieldName);
    if (!values?.includes(enumValue)) {
      throw new Error(`Invalid ${fieldName}: enum default must be one of values.`);
    }
    return enumValue;
  }

  throw new Error(`Invalid ${fieldName}: unsupported config type "${type}".`);
}

function normalizePluginConfigPresentation(
  value: unknown,
  schema: PluginConfigSchema['schema'],
  fieldName: string,
): NonNullable<PluginConfigSchema['presentation']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['groups', 'fields', 'presets']);
  const schemaKeys = new Set(Object.keys(schema));
  const presentation: NonNullable<PluginConfigSchema['presentation']> = {};

  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) {
      throw new Error(`Invalid ${fieldName}.groups: expected an array.`);
    }
    const groupIds = new Set<string>();
    const groupedFields = new Set<string>();
    presentation.groups = input.groups.map((rawGroup, index) => {
      const groupFieldName = `${fieldName}.groups[${index}]`;
      const group = assertObject(rawGroup, groupFieldName);
      assertAllowedKeys(group, groupFieldName, [
        'id',
        'title',
        'description',
        'fields',
        'advanced',
      ]);
      const id = ensureString(group.id, `${groupFieldName}.id`);
      if (groupIds.has(id)) {
        throw new Error(`Invalid ${groupFieldName}.id: duplicate group id "${id}".`);
      }
      groupIds.add(id);
      const fields = ensureStringArray(group.fields, `${groupFieldName}.fields`);
      for (const [fieldIndex, key] of fields.entries()) {
        if (!schemaKeys.has(key)) {
          throw new Error(
            `Invalid ${groupFieldName}.fields[${fieldIndex}]: unknown config key "${key}".`,
          );
        }
        if (groupedFields.has(key)) {
          throw new Error(
            `Invalid ${groupFieldName}.fields[${fieldIndex}]: config key "${key}" is assigned to more than one group.`,
          );
        }
        groupedFields.add(key);
      }
      return {
        id,
        title: ensureString(group.title, `${groupFieldName}.title`),
        description:
          group.description === undefined
            ? undefined
            : ensureString(group.description, `${groupFieldName}.description`),
        fields,
        advanced:
          group.advanced === undefined
            ? undefined
            : ensureBoolean(group.advanced, `${groupFieldName}.advanced`),
      };
    });
  }

  if (input.fields !== undefined) {
    const fieldsInput = assertObject(input.fields, `${fieldName}.fields`);
    presentation.fields = {};
    for (const [key, rawPresentationField] of Object.entries(fieldsInput)) {
      if (!schemaKeys.has(key)) {
        throw new Error(`Invalid ${fieldName}.fields: unknown config key "${key}".`);
      }
      const presentationFieldName = `${fieldName}.fields.${key}`;
      const presentationField = assertObject(rawPresentationField, presentationFieldName);
      assertAllowedKeys(presentationField, presentationFieldName, [
        'valueLabels',
        'recommendedValue',
        'placeholder',
        'unit',
        'advanced',
      ]);
      const schemaField = schema[key]!;
      let valueLabels: Record<string, string> | undefined;
      if (presentationField.valueLabels !== undefined) {
        if (schemaField.type !== 'enum') {
          throw new Error(
            `Invalid ${presentationFieldName}.valueLabels: valueLabels are only supported for enum config.`,
          );
        }
        const labelsInput = assertObject(
          presentationField.valueLabels,
          `${presentationFieldName}.valueLabels`,
        );
        valueLabels = {};
        for (const [token, rawLabel] of Object.entries(labelsInput)) {
          if (!schemaField.values?.includes(token)) {
            throw new Error(
              `Invalid ${presentationFieldName}.valueLabels: unknown enum token "${token}".`,
            );
          }
          valueLabels[token] = ensureString(
            rawLabel,
            `${presentationFieldName}.valueLabels.${token}`,
          );
        }
      }
      presentation.fields[key] = {
        valueLabels,
        recommendedValue:
          presentationField.recommendedValue === undefined
            ? undefined
            : validateConfigDefault(
                schemaField.type,
                presentationField.recommendedValue,
                schemaField.values,
                schemaField.min,
                schemaField.max,
                `${presentationFieldName}.recommendedValue`,
              ),
        placeholder:
          presentationField.placeholder === undefined
            ? undefined
            : ensureString(presentationField.placeholder, `${presentationFieldName}.placeholder`),
        unit:
          presentationField.unit === undefined
            ? undefined
            : ensureString(presentationField.unit, `${presentationFieldName}.unit`),
        advanced:
          presentationField.advanced === undefined
            ? undefined
            : ensureBoolean(presentationField.advanced, `${presentationFieldName}.advanced`),
      };
    }
  }

  if (input.presets !== undefined) {
    if (!Array.isArray(input.presets)) {
      throw new Error(`Invalid ${fieldName}.presets: expected an array.`);
    }
    const presetIds = new Set<string>();
    presentation.presets = input.presets.map((rawPreset, index) => {
      const presetFieldName = `${fieldName}.presets[${index}]`;
      const preset = assertObject(rawPreset, presetFieldName);
      assertAllowedKeys(preset, presetFieldName, ['id', 'title', 'description', 'values']);
      const id = ensureString(preset.id, `${presetFieldName}.id`);
      if (presetIds.has(id)) {
        throw new Error(`Invalid ${presetFieldName}.id: duplicate preset id "${id}".`);
      }
      presetIds.add(id);
      const valuesInput = assertObject(preset.values, `${presetFieldName}.values`);
      const values: Record<string, string | number | boolean> = {};
      for (const [key, rawValue] of Object.entries(valuesInput)) {
        const schemaField = schema[key];
        if (!schemaField) {
          throw new Error(`Invalid ${presetFieldName}.values: unknown config key "${key}".`);
        }
        if (schemaField.sensitive === true
          || schemaField.type === 'file'
          || schemaField.type === 'directory') {
          throw new Error(
            `Invalid ${presetFieldName}.values.${key}: presets cannot contain sensitive, file, or directory config values.`,
          );
        }
        values[key] = validateConfigDefault(
          schemaField.type,
          rawValue,
          schemaField.values,
          schemaField.min,
          schemaField.max,
          `${presetFieldName}.values.${key}`,
        );
      }
      return {
        id,
        title: ensureString(preset.title, `${presetFieldName}.title`),
        description:
          preset.description === undefined
            ? undefined
            : ensureString(preset.description, `${presetFieldName}.description`),
        values,
      };
    });
  }

  return presentation;
}

function normalizePluginConfigSchema(value: unknown, fieldName: string): PluginConfigSchema {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['schema', 'presentation']);

  const schemaInput = assertObject(input.schema, `${fieldName}.schema`);
  const schema: PluginConfigSchema['schema'] = {};
  const supportedTypes = new Set(['string', 'number', 'boolean', 'enum', 'file', 'directory']);

  for (const [key, rawField] of Object.entries(schemaInput)) {
    validateConfigKey(key, `${fieldName}.schema`);
    const schemaFieldName = `${fieldName}.schema.${key}`;
    const configField = assertObject(rawField, schemaFieldName);
    assertAllowedKeys(configField, schemaFieldName, [
      'type',
      'title',
      'description',
      'default',
      'required',
      'sensitive',
      'values',
      'min',
      'max',
    ]);

    const type = ensureString(configField.type, `${schemaFieldName}.type`);
    if (!supportedTypes.has(type)) {
      throw new Error(`Invalid ${schemaFieldName}.type: expected string, number, boolean, enum, file, or directory.`);
    }

    const required =
      configField.required === undefined
        ? undefined
        : ensureBoolean(configField.required, `${schemaFieldName}.required`);
    const sensitive =
      configField.sensitive === undefined
        ? undefined
        : ensureBoolean(configField.sensitive, `${schemaFieldName}.sensitive`);
    const values =
      configField.values === undefined
        ? undefined
        : ensureStringArray(configField.values, `${schemaFieldName}.values`);
    if (type !== 'enum' && values !== undefined) {
      throw new Error(`Invalid ${schemaFieldName}.values: values are only supported for enum config.`);
    }
    if (type === 'enum' && (!values || values.length === 0)) {
      throw new Error(`Invalid ${schemaFieldName}.values: enum config requires at least one value.`);
    }
    if (values && new Set(values).size !== values.length) {
      throw new Error(`Invalid ${schemaFieldName}.values: enum values must be unique.`);
    }

    const min =
      configField.min === undefined
        ? undefined
        : ensureFiniteNumber(configField.min, `${schemaFieldName}.min`);
    const max =
      configField.max === undefined
        ? undefined
        : ensureFiniteNumber(configField.max, `${schemaFieldName}.max`);
    if (type !== 'number' && (min !== undefined || max !== undefined)) {
      throw new Error(`Invalid ${schemaFieldName}: min/max are only supported for number config.`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`Invalid ${schemaFieldName}: min must be less than or equal to max.`);
    }

    schema[key] = {
      type: type as PluginConfigSchema['schema'][string]['type'],
      title:
        configField.title === undefined
          ? undefined
          : ensureString(configField.title, `${schemaFieldName}.title`),
      description:
        configField.description === undefined
          ? undefined
          : ensureString(configField.description, `${schemaFieldName}.description`),
      default:
        configField.default === undefined
          ? undefined
          : validateConfigDefault(
              type,
              configField.default,
              values,
              min,
              max,
              `${schemaFieldName}.default`,
            ),
      required,
      sensitive,
      values,
      min,
      max,
    };
  }

  return {
    schema,
    presentation:
      input.presentation === undefined
        ? undefined
        : normalizePluginConfigPresentation(
            input.presentation,
            schema,
            `${fieldName}.presentation`,
          ),
  };
}

const ARTIFACT_TARGETS = new Set<ArtifactTarget>([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
  'codex.skill',
  'claude.skill',
  'agent-skills.skill',
]);

const ARTIFACT_STATES = new Set<ArtifactState>(['present', 'disabled']);
const DYNAMIC_ARTIFACT_KINDS = new Set<DynamicArtifactKind>(['instruction', 'codexRole', 'skill']);
const ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET: Partial<Record<ArtifactTarget, CodexProjectManagedKind>> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'agent',
  'codex.skill': 'skill',
};
const ARTIFACT_KIND_BY_TARGET: Record<ArtifactTarget, DynamicArtifactKind> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'codexRole',
  'codex.skill': 'skill',
  'claude.skill': 'skill',
  'agent-skills.skill': 'skill',
};

function normalizeArtifactRuntimeImports(
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): NonNullable<PluginArtifactTargetDefinition['runtimeImports']> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${fieldName}[${index}]`;
    const input = assertObject(entry, entryField);
    assertAllowedKeys(input, entryField, ['name', 'plugin', 'export', 'resolved']);
    const name = ensurePluginName(input.name, `${entryField}.name`);
    if (names.has(name)) {
      throw new Error(`Invalid ${fieldName}: duplicate import name "${name}".`);
    }
    names.add(name);
    let resolved: NonNullable<PluginArtifactTargetDefinition['runtimeImports']>[number]['resolved'];
    if (input.resolved !== undefined) {
      const resolvedInput = assertObject(input.resolved, `${entryField}.resolved`);
      assertAllowedKeys(resolvedInput, `${entryField}.resolved`, [
        'path', 'digest', 'providerPluginId', 'providerVersion', 'source',
      ]);
      resolved = {
        path: normalizePluginChildPath('', ensureString(resolvedInput.path, `${entryField}.resolved.path`), `${entryField}.resolved.path`),
        digest: ensureDigestString(resolvedInput.digest, `${entryField}.resolved.digest`),
        providerPluginId: ensureString(resolvedInput.providerPluginId, `${entryField}.resolved.providerPluginId`),
        providerVersion: assertStrictSemVer(resolvedInput.providerVersion, `${entryField}.resolved.providerVersion`),
        source: ensureString(resolvedInput.source, `${entryField}.resolved.source`),
      };
    }
    return {
      name,
      ...normalizeImportReference(
        { plugin: input.plugin, export: input.export },
        entryField,
        reservedImports,
      ),
      ...(resolved ? { resolved } : {}),
    };
  });
}

function normalizePlatformName(value: unknown, fieldName: string): PlatformName {
  const platform = ensureString(value, fieldName);
  if (platform !== 'codex' && platform !== 'claude') {
    throw new Error(`Invalid ${fieldName}: expected "codex" or "claude".`);
  }

  return platform;
}

function normalizeScopeArray(value: unknown, fieldName: string): Array<'user' | 'project'> {
  const scopes = ensureStringArray(value, fieldName);
  const normalized: Array<'user' | 'project'> = [];
  for (const [index, scope] of scopes.entries()) {
    if (scope !== 'user' && scope !== 'project') {
      throw new Error(`Invalid ${fieldName}[${index}]: expected "user" or "project".`);
    }
    if (!normalized.includes(scope)) {
      normalized.push(scope);
    }
  }

  if (normalized.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected at least one scope.`);
  }

  return normalized;
}

function normalizeArtifactTarget(value: unknown, fieldName: string): ArtifactTarget {
  const target = ensureString(value, fieldName);
  if (!ARTIFACT_TARGETS.has(target as ArtifactTarget)) {
    throw new Error(`Invalid ${fieldName}: unsupported artifact target "${target}".`);
  }

  return target as ArtifactTarget;
}

function normalizeArtifactStates(value: unknown, fieldName: string): ArtifactState[] {
  const states = ensureStringArray(value, fieldName);
  const normalized: ArtifactState[] = [];
  for (const [index, state] of states.entries()) {
    if (!ARTIFACT_STATES.has(state as ArtifactState)) {
      throw new Error(`Invalid ${fieldName}[${index}]: unsupported artifact state "${state}".`);
    }
    if (!normalized.includes(state as ArtifactState)) {
      normalized.push(state as ArtifactState);
    }
  }

  if (normalized.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected at least one state.`);
  }

  return normalized;
}

function normalizeArtifactRefreshKeys(
  value: unknown,
  fieldName: string,
  schema: PluginConfigSchema | undefined,
): string[] {
  const refreshKeys = ensureStringArray(value, fieldName);
  const schemaKeys = new Set(Object.keys(schema?.schema ?? {}));
  const normalized: string[] = [];

  for (const [index, key] of refreshKeys.entries()) {
    if (!schemaKeys.has(key)) {
      throw new Error(`Invalid ${fieldName}[${index}]: unknown config key "${key}".`);
    }
    if (!normalized.includes(key)) {
      normalized.push(key);
    }
  }

  return normalized;
}

function normalizeDynamicArtifactKind(value: unknown, fieldName: string): DynamicArtifactKind {
  const kind = ensureString(value, fieldName);
  if (!DYNAMIC_ARTIFACT_KINDS.has(kind as DynamicArtifactKind)) {
    throw new Error(`Invalid ${fieldName}: unsupported artifact kind "${kind}".`);
  }

  return kind as DynamicArtifactKind;
}

function normalizeProjectManagedKind(value: unknown, fieldName: string): CodexProjectManagedKind {
  const kind = ensureString(value, fieldName);
  if (!['skill', 'mcpServer', 'instruction', 'permission', 'hook', 'agent'].includes(kind)) {
    throw new Error(`Invalid ${fieldName}: unsupported Codex project managed kind "${kind}".`);
  }

  return kind as CodexProjectManagedKind;
}

function validateArtifactId(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a stable id using letters, numbers, ".", "_" or "-".`);
  }
}

function validateCodexRoleKey(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a valid Codex role key.`);
  }
}

function validateCodexSkillKey(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a valid Codex skill key.`);
  }
}

function normalizeArtifactTargetEntry(
  pluginRoot: string,
  entry: unknown,
  fieldName: string,
  schema: PluginConfigSchema | undefined,
  reservedImports: ReservedImportRegistry | undefined,
): PluginArtifactTargetDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, [
    'id',
    'platform',
    'scopes',
    'target',
    'kind',
    'projectManagedKind',
    'states',
    'refreshKeys',
    'requiresCodexProjectConfig',
    'roleKey',
    'skillKey',
    'sourceDirs',
    'distribution',
    'runtimeImports',
  ]);

  const id = ensureString(input.id, `${fieldName}.id`);
  validateArtifactId(id, `${fieldName}.id`);

  const target = normalizeArtifactTarget(input.target, `${fieldName}.target`);
  const portable = target === 'agent-skills.skill';
  const platform = portable ? undefined : normalizePlatformName(input.platform, `${fieldName}.platform`);
  const distribution = portable
    ? ensureString(input.distribution, `${fieldName}.distribution`)
    : undefined;
  if (portable) {
    if (distribution !== 'agent-skills') {
      throw new Error(`Invalid ${fieldName}.distribution: expected "agent-skills".`);
    }
    if (input.platform !== undefined) {
      throw new Error(`Invalid ${fieldName}.platform: distribution targets do not support platform.`);
    }
  } else {
    const expectedPlatform: PlatformName = target === 'claude.skill' ? 'claude' : 'codex';
    if (platform !== expectedPlatform) {
      throw new Error(
        `Invalid ${fieldName}.platform: target "${target}" is only supported on "${expectedPlatform}".`,
      );
    }
    if (input.distribution !== undefined) {
      throw new Error(`Invalid ${fieldName}.distribution: platform targets do not support distribution.`);
    }
  }

  const expectedKind = ARTIFACT_KIND_BY_TARGET[target];
  const kind = input.kind === undefined
    ? expectedKind
    : normalizeDynamicArtifactKind(input.kind, `${fieldName}.kind`);
  if (kind !== expectedKind) {
    throw new Error(`Invalid ${fieldName}.kind: target "${target}" requires kind "${expectedKind}".`);
  }

  const expectedProjectManagedKind = ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET[target];
  const projectManagedKind = input.projectManagedKind === undefined
    ? expectedProjectManagedKind
    : normalizeProjectManagedKind(input.projectManagedKind, `${fieldName}.projectManagedKind`);
  if (projectManagedKind !== expectedProjectManagedKind) {
    throw new Error(
      expectedProjectManagedKind
        ? `Invalid ${fieldName}.projectManagedKind: target "${target}" must map to "${expectedProjectManagedKind}".`
        : `Invalid ${fieldName}.projectManagedKind: target "${target}" does not support projectManagedKind.`,
    );
  }

  const roleKey =
    input.roleKey === undefined
      ? undefined
      : ensureString(input.roleKey, `${fieldName}.roleKey`);
  const skillKey =
    input.skillKey === undefined
      ? undefined
      : ensureString(input.skillKey, `${fieldName}.skillKey`);
  if (target === 'codex.agentRole') {
    if (!roleKey) {
      throw new Error(`Invalid ${fieldName}.roleKey: codex.agentRole targets must declare a static roleKey.`);
    }
    validateCodexRoleKey(roleKey, `${fieldName}.roleKey`);
  } else if (roleKey !== undefined) {
    throw new Error(`Invalid ${fieldName}.roleKey: roleKey is only supported for codex.agentRole targets.`);
  }

  if (target === 'codex.skill' || target === 'claude.skill' || target === 'agent-skills.skill') {
    if (!skillKey) {
      throw new Error(`Invalid ${fieldName}.skillKey: ${target} targets must declare a static skillKey.`);
    }
    if (portable) validatePortableSkillName(skillKey, `${fieldName}.skillKey`);
    else validateCodexSkillKey(skillKey, `${fieldName}.skillKey`);
  } else if (skillKey !== undefined) {
    throw new Error(`Invalid ${fieldName}.skillKey: skillKey is only supported for skill targets.`);
  }

  const sourceDirs = normalizePathArray(pluginRoot, input.sourceDirs, `${fieldName}.sourceDirs`);
  if (sourceDirs && target !== 'codex.skill' && target !== 'claude.skill' && target !== 'agent-skills.skill') {
    throw new Error(`Invalid ${fieldName}.sourceDirs: sourceDirs are only supported for skill targets.`);
  }
  if (sourceDirs && new Set(sourceDirs).size !== sourceDirs.length) {
    throw new Error(`Invalid ${fieldName}.sourceDirs: duplicate source directory.`);
  }
  if (sourceDirs && skillKey && !portable) {
    const canonicalRoot = `skills/${skillKey}`;
    const invalidSource = sourceDirs.find((sourceDir) => {
      const normalized = stripDotSlash(sourceDir);
      return normalized !== canonicalRoot && !normalized.startsWith(`${canonicalRoot}/`);
    });
    if (invalidSource) {
      throw new Error(
        `Invalid ${fieldName}.sourceDirs: "${invalidSource}" must stay inside "./${canonicalRoot}".`,
      );
    }
    const authorOnlySource = sourceDirs.find((sourceDir) =>
      isSkillAuthorOnlyPath(path.posix.relative(canonicalRoot, stripDotSlash(sourceDir))));
    if (authorOnlySource) {
      throw new Error(
        `Invalid ${fieldName}.sourceDirs: "${authorOnlySource}" points inside an author-only Skill directory.`,
      );
    }
    if (!sourceDirs.some((sourceDir) => stripDotSlash(sourceDir) === canonicalRoot)) {
      throw new Error(
        `Invalid ${fieldName}.sourceDirs: dynamic Skill sources must include "./${canonicalRoot}" so README.md is published.`,
      );
    }
  }
  if ((platform === 'claude' || portable) && input.requiresCodexProjectConfig !== undefined) {
    throw new Error(
      `Invalid ${fieldName}.requiresCodexProjectConfig: Claude targets do not support requiresCodexProjectConfig.`,
    );
  }
  if (!portable && input.runtimeImports !== undefined) {
    throw new Error(`Invalid ${fieldName}.runtimeImports: runtimeImports are only supported for agent-skills.skill targets.`);
  }

  return {
    id,
    platform,
    distribution: distribution as 'agent-skills' | undefined,
    scopes: normalizeScopeArray(input.scopes, `${fieldName}.scopes`),
    target,
    kind,
    projectManagedKind,
    states: normalizeArtifactStates(input.states, `${fieldName}.states`),
    refreshKeys: normalizeArtifactRefreshKeys(input.refreshKeys, `${fieldName}.refreshKeys`, schema),
    requiresCodexProjectConfig:
      input.requiresCodexProjectConfig === undefined
        ? undefined
        : ensureBoolean(input.requiresCodexProjectConfig, `${fieldName}.requiresCodexProjectConfig`),
    roleKey,
    skillKey,
    sourceDirs,
    runtimeImports: normalizeArtifactRuntimeImports(
      input.runtimeImports,
      `${fieldName}.runtimeImports`,
      reservedImports,
    ),
  };
}

function normalizeArtifacts(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
  schema: PluginConfigSchema | undefined,
  reservedImports: ReservedImportRegistry | undefined,
): PluginArtifactsConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['targets']);

  const targetsInput = input.targets;
  const targets = targetsInput === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(targetsInput)) {
          throw new Error(`Invalid ${fieldName}.targets: expected an array.`);
        }

        const seen = new Set<string>();
        const seenSkillOwners = new Set<string>();
        return targetsInput.map((entry, index) => {
          const target = normalizeArtifactTargetEntry(
            pluginRoot,
            entry,
            `${fieldName}.targets[${index}]`,
            schema,
            reservedImports,
          );
          const key = `${target.id}:${target.target}`;
          if (seen.has(key)) {
            throw new Error(`Invalid ${fieldName}.targets[${index}]: duplicate artifact id + target "${key}".`);
          }
          seen.add(key);
          if ((target.target === 'codex.skill' || target.target === 'claude.skill' || target.target === 'agent-skills.skill') && target.skillKey) {
            for (const scope of target.scopes) {
              const ownerKey = `${target.platform ?? target.distribution}:${scope}:${target.skillKey}`;
              if (seenSkillOwners.has(ownerKey)) {
                throw new Error(
                  `Invalid ${fieldName}.targets[${index}]: duplicate dynamic skill owner "${ownerKey}".`,
                );
              }
              seenSkillOwners.add(ownerKey);
            }
          }
          return target;
        });
      })();

  return { targets };
}

function normalizePlatformAgentOverrides<T>(
  value: unknown,
  fieldName: string,
  normalizer: (value: Record<string, unknown>, fieldName: string) => Partial<T>,
): PlatformAgentOverrides<T> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const output: PlatformAgentOverrides<T> = {};
  for (const platform of ['claude', 'codex'] as const) {
    const entry = input[platform];
    if (entry === undefined) {
      continue;
    }

    if (entry === null) {
      output[platform] = null;
      continue;
    }

    output[platform] = omitUndefinedValues(
      normalizer(
        assertObject(entry, `${fieldName}.${platform}`),
        `${fieldName}.${platform}`,
      ) as Record<string, unknown>,
    ) as Partial<T>;
  }

  return output;
}

function normalizeInstructionEntry(
  entry: unknown,
  fieldName: string,
): InstructionDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'title', 'content', 'paths', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    title: ensureString(input.title, `${fieldName}.title`),
    content: ensureString(input.content, `${fieldName}.content`),
    paths:
      input.paths === undefined
        ? undefined
        : ensureStringArray(input.paths, `${fieldName}.paths`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<InstructionDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, ['name', 'title', 'content', 'paths']);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                title:
                  overrideInput.title === undefined
                    ? undefined
                    : ensureString(overrideInput.title, `${overrideFieldName}.title`),
                content:
                  overrideInput.content === undefined
                    ? undefined
                    : ensureString(overrideInput.content, `${overrideFieldName}.content`),
                paths:
                  overrideInput.paths === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.paths, `${overrideFieldName}.paths`),
              };
            },
          ),
  };
}

function normalizePermissionEntry(
  entry: unknown,
  fieldName: string,
): PermissionDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'allow', 'ask', 'deny', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    allow: normalizePermissionCommandArray(input.allow, `${fieldName}.allow`),
    ask: normalizePermissionCommandArray(input.ask, `${fieldName}.ask`),
    deny: normalizePermissionCommandArray(input.deny, `${fieldName}.deny`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<PermissionDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, ['name', 'allow', 'ask', 'deny']);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                allow: normalizePermissionCommandArray(
                  overrideInput.allow,
                  `${overrideFieldName}.allow`,
                ),
                ask: normalizePermissionCommandArray(
                  overrideInput.ask,
                  `${overrideFieldName}.ask`,
                ),
                deny: normalizePermissionCommandArray(
                  overrideInput.deny,
                  `${overrideFieldName}.deny`,
                ),
              };
            },
          ),
  };
}

function normalizeHookEntry(entry: unknown, fieldName: string): HookDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['event', 'matcher', 'command', 'agentOverrides']);

  const normalized: HookDefinition = {
    event: assertPublicHookEvent(input.event, `${fieldName}.event`),
    matcher:
      input.matcher === undefined
        ? undefined
        : ensureString(input.matcher, `${fieldName}.matcher`),
    command: ensureString(input.command, `${fieldName}.command`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<HookDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, ['event', 'matcher', 'command']);
              return {
                event:
                  overrideInput.event === undefined
                    ? undefined
                    : assertPublicHookEvent(overrideInput.event, `${overrideFieldName}.event`),
                matcher:
                  overrideInput.matcher === undefined
                    ? undefined
                    : ensureString(overrideInput.matcher, `${overrideFieldName}.matcher`),
                command:
                  overrideInput.command === undefined
                    ? undefined
                    : ensureString(overrideInput.command, `${overrideFieldName}.command`),
              };
            },
          ),
  };

  assertHookMatcherAllowed({
    kind: 'public',
    event: normalized.event,
    matcher: normalized.matcher,
    fieldName: `${fieldName}.matcher`,
  });

  for (const platform of ['claude', 'codex'] as const) {
    const override = normalized.agentOverrides?.[platform];
    if (!override || override === null) {
      continue;
    }

    assertHookMatcherAllowed({
      kind: 'public',
      event: override.event ?? normalized.event,
      matcher: override.matcher ?? normalized.matcher,
      fieldName: `${fieldName}.agentOverrides.${platform}.matcher`,
    });
  }

  return normalized;
}

function normalizeNativeHookEntry(
  entry: unknown,
  platform: PlatformName,
  fieldName: string,
): NativeHookDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['event', 'matcher', 'command']);

  const event = assertNativeHookEvent(
    ensureString(input.event, `${fieldName}.event`),
    platform,
    `${fieldName}.event`,
  );
  const matcher =
    input.matcher === undefined
      ? undefined
      : ensureString(input.matcher, `${fieldName}.matcher`);

  assertHookMatcherAllowed({
    kind: 'native',
    platform,
    event,
    matcher,
    fieldName: `${fieldName}.matcher`,
  });

  return {
    event,
    matcher,
    command: ensureString(input.command, `${fieldName}.command`),
  };
}

function normalizeNativeHooks(
  value: unknown,
  fieldName: string,
): PluginExtensions['nativeHooks'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const output: NonNullable<PluginExtensions['nativeHooks']> = {};
  for (const platform of ['claude', 'codex'] as const) {
    const entries = input[platform];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid ${fieldName}.${platform}: expected an array.`);
    }

    output[platform] = entries.map((entry, index) =>
      normalizeNativeHookEntry(entry, platform, `${fieldName}.${platform}[${index}]`),
    );
  }

  return output;
}

function assertNoDuplicatePlatformHooks(
  extensions: PluginExtensions,
  fieldName: string,
): void {
  for (const platform of ['claude', 'codex'] as const) {
    const seen = new Set<string>();
    for (const definition of resolvePlatformHookDefinitions({ extensions }, platform)) {
      const group = renderHookDefinitionGroup(definition, platform);
      const identity = normalizeRenderedHookGroupIdentity({
        platform,
        event: group.event,
        matcher: group.matcher,
        command: group.hooks[0].command,
      });
      const key = JSON.stringify([
        identity.event,
        identity.matcher ?? null,
        identity.command,
      ]);
      if (seen.has(key)) {
        throw new Error(
          `Invalid ${fieldName}: duplicate ${platform} hook for event "${identity.event}" and command "${identity.command}".`,
        );
      }
      seen.add(key);
    }
  }
}

function normalizeAgentEntry(entry: unknown, fieldName: string): AgentDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'description', 'prompt', 'tools', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    description: ensureString(input.description, `${fieldName}.description`),
    prompt: ensureString(input.prompt, `${fieldName}.prompt`),
    tools:
      input.tools === undefined
        ? undefined
        : ensureStringArray(input.tools, `${fieldName}.tools`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<AgentDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, [
                'name',
                'description',
                'prompt',
                'tools',
              ]);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                description:
                  overrideInput.description === undefined
                    ? undefined
                    : ensureString(
                        overrideInput.description,
                        `${overrideFieldName}.description`,
                      ),
                prompt:
                  overrideInput.prompt === undefined
                    ? undefined
                    : ensureString(overrideInput.prompt, `${overrideFieldName}.prompt`),
                tools:
                  overrideInput.tools === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.tools, `${overrideFieldName}.tools`),
              };
            },
          ),
  };
}

function normalizeExtensions(
  value: unknown,
  fieldName: string,
): PluginExtensions {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['instructions', 'permissions', 'hooks', 'nativeHooks', 'agents']);

  const extensions: PluginExtensions = {
    instructions: Array.isArray(input.instructions)
      ? input.instructions.map((entry, index) =>
          normalizeInstructionEntry(entry, `${fieldName}.instructions[${index}]`),
        )
      : [],
    permissions: Array.isArray(input.permissions)
      ? input.permissions.map((entry, index) =>
          normalizePermissionEntry(entry, `${fieldName}.permissions[${index}]`),
        )
      : [],
    hooks: Array.isArray(input.hooks)
      ? input.hooks.map((entry, index) =>
          normalizeHookEntry(entry, `${fieldName}.hooks[${index}]`),
        )
      : [],
    nativeHooks:
      input.nativeHooks === undefined
        ? undefined
        : normalizeNativeHooks(input.nativeHooks, `${fieldName}.nativeHooks`),
    agents: Array.isArray(input.agents)
      ? input.agents.map((entry, index) =>
          normalizeAgentEntry(entry, `${fieldName}.agents[${index}]`),
        )
      : [],
  };

  assertNoDuplicatePlatformHooks(extensions, fieldName);
  return extensions;
}

export function validateMarketplaceSourceMeta(rawValue: unknown): MarketplaceSourceMeta {
  const input = assertObject(rawValue, 'marketplace source metadata');
  assertAllowedKeys(input, 'marketplace source metadata', ['owner', 'interface', 'catalog']);

  const ownerInput = assertObject(input.owner, 'marketplace source metadata.owner');
  assertAllowedKeys(ownerInput, 'marketplace source metadata.owner', ['name', 'url']);
  const interfaceInput = assertObject(input.interface, 'marketplace source metadata.interface');
  assertAllowedKeys(interfaceInput, 'marketplace source metadata.interface', ['displayName']);
  const catalogInput = input.catalog === undefined
    ? null
    : assertObject(input.catalog, 'marketplace source metadata.catalog');
  if (catalogInput) assertAllowedKeys(catalogInput, 'marketplace source metadata.catalog', ['version']);

  return {
    owner: {
      name: ensureString(ownerInput.name, 'marketplace source metadata.owner.name'),
      url: ensureString(ownerInput.url, 'marketplace source metadata.owner.url'),
    },
    interface: {
      displayName: ensureString(
        interfaceInput.displayName,
        'marketplace source metadata.interface.displayName',
      ),
    },
    catalog: {
      version: catalogInput === null
        ? '0.1.0'
        : assertCatalogVersion(
            catalogInput.version,
            'marketplace source metadata.catalog.version',
          ),
    },
  };
}

export function normalizeCatalogMarketplaceIdentity(
  rawValue: unknown,
  fieldName = 'catalog manifest marketplace',
): CatalogMarketplaceIdentity {
  const input = assertObject(rawValue, fieldName);
  assertAllowedKeys(input, fieldName, ['owner', 'interface']);
  const normalized = validateMarketplaceSourceMeta({
    owner: input.owner,
    interface: input.interface,
    catalog: { version: '0.1.0' },
  });
  return { owner: normalized.owner, interface: normalized.interface };
}

export async function readMarketplaceSourceMeta(repoRoot: string): Promise<MarketplaceSourceMeta> {
  const sourcePath = path.join(repoRoot, MARKETPLACE_SOURCE_PATH);
  const rawValue = await readJsonFile<unknown>(sourcePath);
  return validateMarketplaceSourceMeta(rawValue);
}

export interface ValidatePluginManifestOptions {
  compatibilityMode?: 'defaulted' | 'required';
  defaultMinVersion?: string;
  reservedImports?: ReservedImportRegistry;
}

export type ReservedImportRegistry = Readonly<Record<string, readonly string[]>>;

function hasDeclaredNativePluginCapability(manifest: PluginManifestSource): boolean {
  return Boolean(
    (manifest.extensions?.instructions?.length ?? 0) > 0
    || (manifest.extensions?.permissions?.length ?? 0) > 0
    || (manifest.extensions?.hooks?.length ?? 0) > 0
    || (manifest.extensions?.nativeHooks?.claude?.length ?? 0) > 0
    || (manifest.extensions?.nativeHooks?.codex?.length ?? 0) > 0
    || (manifest.extensions?.agents?.length ?? 0) > 0
    || (manifest.artifacts?.targets ?? []).some((target) =>
      target.platform !== undefined && target.states.includes('present'))
  );
}

async function directoryContainsRegularFile(
  root: string,
  fileName?: string,
  exact = false,
): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && (!fileName || (exact ? entry.name === fileName : entry.name.endsWith(fileName)))) {
      return true;
    }
    if (entry.isDirectory() && await directoryContainsRegularFile(entryPath, fileName, exact)) return true;
  }
  return false;
}

async function jsonAssetHasEntries(
  pluginRoot: string,
  relativePath: string | undefined,
  key: 'mcpServers' | 'apps',
): Promise<boolean> {
  if (!relativePath) return false;
  const content = await fs.readJson(path.join(pluginRoot, stripDotSlash(relativePath))).catch(() => undefined);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  const entries = (content as Record<string, unknown>)[key];
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries)
    && Object.keys(entries as Record<string, unknown>).length > 0);
}

export async function assertActualNativePluginCapability(
  pluginRoot: string,
  manifest: PluginManifestSource,
  mode: 'source' | 'bundle' = 'source',
): Promise<void> {
  if (!manifest.distributions?.agentSkills || hasDeclaredNativePluginCapability(manifest)) return;
  const skills = manifest.skills
    ? await directoryContainsRegularFile(path.join(pluginRoot, stripDotSlash(manifest.skills)), 'SKILL.md', true)
    : false;
  const slashCommands = manifest.slashCommands
    ? await directoryContainsRegularFile(path.join(pluginRoot, stripDotSlash(manifest.slashCommands)), '.md')
    : false;
  const [mcpServers, apps] = await Promise.all([
    jsonAssetHasEntries(pluginRoot, manifest.mcpServers, 'mcpServers'),
    jsonAssetHasEntries(pluginRoot, manifest.apps, 'apps'),
  ]);
  let bundled = false;
  if (mode === 'bundle' && !skills && !slashCommands && !mcpServers && !apps) {
    for (const platform of ['claude', 'codex'] as const) {
      const platformManifest = await fs.readJson(
        path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json'),
      ).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!platformManifest) continue;
      const platformSkills = typeof platformManifest.skills === 'string'
        && await directoryContainsRegularFile(
          path.join(pluginRoot, stripDotSlash(platformManifest.skills)),
          'SKILL.md',
          true,
        );
      const commands = typeof platformManifest.commands === 'string'
        && await directoryContainsRegularFile(
          path.join(pluginRoot, stripDotSlash(platformManifest.commands)),
          '.md',
        );
      bundled = Boolean(platformSkills || commands
        || (Array.isArray(platformManifest.agents) && platformManifest.agents.length > 0)
        || (platformManifest.hooks && typeof platformManifest.hooks === 'object'
          && Object.keys(platformManifest.hooks as Record<string, unknown>).length > 0)
        || await jsonAssetHasEntries(
          pluginRoot,
          typeof platformManifest.mcpServers === 'string' ? platformManifest.mcpServers : undefined,
          'mcpServers',
        )
        || await jsonAssetHasEntries(
          pluginRoot,
          typeof platformManifest.apps === 'string' ? platformManifest.apps : undefined,
          'apps',
        ));
      if (bundled) break;
    }
  }
  if (!skills && !slashCommands && !mcpServers && !apps && !bundled) {
    throw new Error('Invalid plugin manifest: portable-only plugins are not supported in V1. Declare at least one non-empty native capability.');
  }
}

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
  options: ValidatePluginManifestOptions = {},
): NormalizedPluginManifest {
  const input = assertObject(
    normalizePluginManifestSchemaVersion(rawManifest),
    'plugin manifest',
  );
  if (Object.hasOwn(input, 'commands')) {
    throw new Error(
      'Invalid plugin manifest: top-level "commands" has been removed; use "slashCommands" instead.',
    );
  }
  assertAllowedKeys(input, 'plugin manifest', [
    'schemaVersion',
    'name',
    'version',
    'description',
    'dependencies',
    'compatibility',
    'skills',
    'slashCommands',
    'mcpServers',
    'apps',
    'distributions',
    'marketplace',
    'interface',
    'extensions',
    'artifacts',
    'buildConfig',
    'scripts',
    'config',
  ]);

  const manifest: NormalizedPluginManifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    name: ensureString(input.name, 'name'),
    version: assertStrictSemVer(input.version, 'plugin manifest.version'),
    description: ensureString(input.description, 'description'),
    compatibility: normalizePluginCompatibility(input.compatibility, 'compatibility', {
      allowMissing: (options.compatibilityMode ?? 'defaulted') === 'defaulted',
      defaultMinVersion: options.defaultMinVersion,
    }),
    marketplace: normalizeMarketplaceMeta(input.marketplace, 'marketplace'),
  };

  if (input.dependencies !== undefined) {
    const dependencies = ensureStringArray(input.dependencies, 'dependencies');
    if (dependencies.length > 64) {
      throw new Error('Invalid dependencies: expected at most 64 direct plugin dependencies.');
    }
    const seen = new Set<string>();
    const normalizedDependencies = dependencies.map((dependency, index) => {
      const name = ensurePluginName(dependency, `dependencies[${index}]`);
      if (name === manifest.name) {
        throw new Error(`Invalid dependencies[${index}]: plugin "${manifest.name}" cannot depend on itself.`);
      }
      if (seen.has(name)) {
        throw new Error(`Invalid dependencies: duplicate plugin "${name}".`);
      }
      seen.add(name);
      return name;
    });
    if (normalizedDependencies.length > 0) {
      manifest.dependencies = normalizedDependencies;
    }
  }

  if (input.skills !== undefined) {
    manifest.skills = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.skills, 'skills'),
      'skills',
    );
    if (stripDotSlash(manifest.skills) !== 'skills') {
      throw new Error('Invalid plugin manifest: skills must be "./skills".');
    }
  }

  if (input.slashCommands !== undefined) {
    manifest.slashCommands = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.slashCommands, 'slashCommands'),
      'slashCommands',
    );
  }

  if (input.mcpServers !== undefined) {
    manifest.mcpServers = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.mcpServers, 'mcpServers'),
      'mcpServers',
    );
  }

  if (input.apps !== undefined) {
    manifest.apps = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.apps, 'apps'),
      'apps',
    );
  }

  if (input.distributions !== undefined) {
    const distributions = assertObject(input.distributions, 'distributions');
    assertAllowedKeys(distributions, 'distributions', ['agentSkills']);
    if (distributions.agentSkills !== undefined) {
      const agentSkills = assertObject(distributions.agentSkills, 'distributions.agentSkills');
      assertAllowedKeys(agentSkills, 'distributions.agentSkills', ['skills']);
      manifest.distributions = {
        agentSkills: {
          skills: agentSkills.skills === undefined
            ? undefined
            : normalizePluginRelativePath(
                pluginRoot,
                ensureString(agentSkills.skills, 'distributions.agentSkills.skills'),
                'distributions.agentSkills.skills',
              ),
        },
      };
    } else {
      manifest.distributions = {};
    }
  }

  if (input.interface !== undefined) {
    manifest.interface = normalizePluginInterface(input.interface, 'interface');
  }

  if (input.extensions !== undefined) {
    manifest.extensions = normalizeExtensions(input.extensions, 'extensions');
  }

  if (input.buildConfig !== undefined) {
    manifest.buildConfig = normalizeBuildConfig(
      pluginRoot,
      input.buildConfig,
      'buildConfig',
      options.reservedImports,
    );
  }

  if (input.scripts !== undefined) {
    manifest.scripts = normalizePluginScripts(pluginRoot, input.scripts, 'scripts');
  }

  if (manifest.buildConfig?.cacheable && !manifest.scripts?.node?.build) {
    throw new Error('Invalid buildConfig.cacheable: true requires scripts.node.build.');
  }

  if (input.config !== undefined) {
    manifest.config = normalizePluginConfigSchema(input.config, 'config');
  }

  if (input.artifacts !== undefined) {
    manifest.artifacts = normalizeArtifacts(
      pluginRoot,
      input.artifacts,
      'artifacts',
      manifest.config,
      options.reservedImports,
    );
  }

  if (
    (manifest.artifacts?.targets ?? []).some((target) => target.distribution === 'agent-skills')
    && !manifest.distributions?.agentSkills
  ) {
    throw new Error('Invalid artifacts.targets: agent-skills targets require distributions.agentSkills declaration.');
  }
  assertManifestPlatformSupport(manifest.name, manifest);

  return manifest;
}

async function validateDeclaredNativeAssets(
  pluginRoot: string,
  manifest: PluginManifestSource,
): Promise<void> {
  const declaredAssets = [
    { field: 'skills', defaultPath: 'skills' },
    { field: 'slashCommands', defaultPath: stripDotSlash(DEFAULT_SLASH_COMMANDS_PATH) },
    { field: 'mcpServers', defaultPath: '.mcp.json' },
    { field: 'apps', defaultPath: '.app.json' },
  ] as const;

  await Promise.all(
    declaredAssets.map(async ({ field, defaultPath }) => {
      if (manifest[field]) {
        return;
      }

      if (await fs.pathExists(path.join(pluginRoot, defaultPath))) {
        if (field === 'skills') {
          const entries = await fs.readdir(path.join(pluginRoot, defaultPath), {
            withFileTypes: true,
          });
          const dynamicSkills = new Set(
            (manifest.artifacts?.targets ?? [])
              .filter((target) =>
                (target.target === 'codex.skill' || target.target === 'claude.skill') &&
                target.skillKey &&
                (target.sourceDirs?.length ?? 0) > 0 &&
                (target.sourceDirs ?? []).every((sourceDir) =>
                  stripDotSlash(sourceDir) === `skills/${target.skillKey}` ||
                  stripDotSlash(sourceDir).startsWith(`skills/${target.skillKey}/`)))
              .map((target) => target.skillKey!),
          );
          if (
            entries.length > 0 &&
            entries.every((entry) => entry.isDirectory() && dynamicSkills.has(entry.name))
          ) {
            return;
          }
        }
        throw new Error(
          `Invalid plugin manifest: found ${defaultPath} but missing "${field}" declaration.`,
        );
      }
    }),
  );
}

async function validateDeclaredAssetPathsExist(
  pluginRoot: string,
  manifest: PluginManifestSource,
): Promise<void> {
  const declaredAssets = ['skills', 'slashCommands', 'mcpServers', 'apps'] as const;

  await Promise.all(
    declaredAssets.map(async (field) => {
      const relativePath = manifest[field];
      if (!relativePath) {
        return;
      }

      const absolutePath = path.join(pluginRoot, stripDotSlash(relativePath));
      if (!(await fs.pathExists(absolutePath))) {
        throw new Error(
          `Invalid plugin manifest: ${field} points to "${relativePath}" but path does not exist.`,
        );
      }
    }),
  );

  const portableSkills = manifest.distributions?.agentSkills?.skills;
  if (portableSkills) {
    const absolutePath = path.join(pluginRoot, stripDotSlash(portableSkills));
    const stats = await fs.lstat(absolutePath).catch(() => undefined);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        `Invalid plugin manifest: distributions.agentSkills.skills points to "${portableSkills}" but it is not a regular directory.`,
      );
    }
  }

  await Promise.all(
    (manifest.artifacts?.targets ?? []).flatMap((target, targetIndex) =>
      (target.sourceDirs ?? []).map(async (sourceDir, sourceIndex) => {
        const absolutePath = path.join(pluginRoot, stripDotSlash(sourceDir));
        const stats = await fs.lstat(absolutePath).catch(() => null);
        if (!stats?.isDirectory() || stats.isSymbolicLink()) {
          throw new Error(
            `Invalid artifacts.targets[${targetIndex}].sourceDirs[${sourceIndex}]: ` +
              `expected a directory at "${sourceDir}".`,
          );
        }
      }),
    ),
  );
}

async function validateSourceSkillInventory(
  pluginRoot: string,
  manifest: NormalizedPluginManifest,
): Promise<void> {
  const skillsRoot = manifest.skills ? path.join(pluginRoot, stripDotSlash(manifest.skills)) : null;
  const skillEntries = skillsRoot
    ? await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
    : [];
  const staticSkillNames = skillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const staticSkillNameSet = new Set(staticSkillNames);
  const dynamicSkillNames = (manifest.artifacts?.targets ?? [])
    .filter((target) => target.target === 'codex.skill' || target.target === 'claude.skill')
    .map((target) => target.skillKey?.trim())
    .filter((skillKey): skillKey is string => Boolean(skillKey))
    .sort();
  const dynamicSkillNameSet = new Set(dynamicSkillNames);
  const portableSkillsRoot = manifest.distributions?.agentSkills?.skills
    ? path.join(pluginRoot, stripDotSlash(manifest.distributions.agentSkills.skills))
    : null;
  const portableSkillEntries = portableSkillsRoot
    ? await fs.readdir(portableSkillsRoot, { withFileTypes: true }).catch(() => [])
    : [];
  const portableSkillNameSet = new Set(
    portableSkillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );

  for (const [index, entry] of (manifest.buildConfig?.skillRuntimeFiles ?? []).entries()) {
    const nativeSelected = entry.distributions === undefined;
    const portableSelected = entry.distributions?.includes('agent-skills') ?? false;
    if (nativeSelected && (!manifest.skills || !staticSkillNameSet.has(entry.skill))) {
      throw new Error(
        `Invalid buildConfig.skillRuntimeFiles[${index}].skill: "${entry.skill}" is not a declared static Skill key.`,
      );
    }
    if (portableSelected && !portableSkillNameSet.has(entry.skill)) {
      throw new Error(
        `Invalid buildConfig.skillRuntimeFiles[${index}].skill: "${entry.skill}" is not a declared portable Skill key.`,
      );
    }
    if (nativeSelected && dynamicSkillNameSet.has(entry.skill)) {
      throw new Error(
        `Invalid buildConfig.skillRuntimeFiles[${index}].skill: dynamic Skill targets are not supported.`,
      );
    }
  }
  for (const [index, entry] of (manifest.buildConfig?.generatedSkillRuntimeFiles ?? []).entries()) {
    const nativeSelected = entry.distributions === undefined;
    const portableSelected = entry.distributions?.includes('agent-skills') ?? false;
    if (nativeSelected && (!manifest.skills || !staticSkillNameSet.has(entry.skill))) {
      throw new Error(
        `Invalid buildConfig.generatedSkillRuntimeFiles[${index}].skill: "${entry.skill}" is not a declared static Skill key.`,
      );
    }
    if (portableSelected && !portableSkillNameSet.has(entry.skill)) {
      throw new Error(
        `Invalid buildConfig.generatedSkillRuntimeFiles[${index}].skill: "${entry.skill}" is not a declared portable Skill key.`,
      );
    }
    if (nativeSelected && dynamicSkillNameSet.has(entry.skill)) {
      throw new Error(
        `Invalid buildConfig.generatedSkillRuntimeFiles[${index}].skill: dynamic Skill targets are not supported.`,
      );
    }
  }

  if (!manifest.slashCommands) {
    return;
  }
  const slashCommands = await resolveSlashCommands(pluginRoot, manifest, {
    targetPlatforms: resolveSupportedPlatforms(manifest),
  });
  for (const command of slashCommands?.commands ?? []) {
    if (staticSkillNameSet.has(command.name) || dynamicSkillNameSet.has(command.name)) {
      throw new Error(
        `Invalid skill inventory: slash command "${command.name}" conflicts with a declared skill of the same name.`,
      );
    }
  }
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function isTemplateAsset(manifest: PluginManifestSource, relativePath: string): boolean {
  const normalized = stripDotSlash(relativePath).split(path.sep).join('/');
  const include = manifest.buildConfig?.templates?.include ?? [];
  return include.length > 0 && applyFileRules([normalized], include, []).length > 0;
}

async function validateSourceJsonNativeAsset(
  pluginRoot: string,
  manifest: PluginManifestSource,
  field: 'mcpServers' | 'apps',
): Promise<void> {
  const relativePath = manifest[field];
  if (!relativePath || isTemplateAsset(manifest, relativePath)) {
    return;
  }

  const absolutePath = path.join(pluginRoot, stripDotSlash(relativePath));
  if (!(await fs.pathExists(absolutePath))) {
    return;
  }

  let content: unknown;
  try {
    content = await fs.readJson(absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${field}: source JSON is invalid (${message}).`);
  }

  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(`Invalid ${field}: expected a JSON object.`);
  }

  const record = content as Record<string, unknown>;
  if (field === 'mcpServers') {
    if (!record.mcpServers || typeof record.mcpServers !== 'object' || Array.isArray(record.mcpServers)) {
      throw new Error('Invalid mcpServers: expected top-level "mcpServers" object.');
    }
  } else if (!record.apps || typeof record.apps !== 'object' || Array.isArray(record.apps)) {
    throw new Error('Invalid apps: expected top-level "apps" object.');
  }
}

export async function validateSourcePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
  options: Pick<ValidatePluginManifestOptions, 'reservedImports'> = {},
): Promise<NormalizedPluginManifest> {
  await assertPluginInputTree(pluginRoot);
  const distributionsInput = rawManifest !== null
    && typeof rawManifest === 'object'
    && !Array.isArray(rawManifest)
    ? (rawManifest as Record<string, unknown>).distributions
    : undefined;
  const requiresExplicitMinVersion = distributionsInput !== null
    && typeof distributionsInput === 'object'
    && !Array.isArray(distributionsInput)
    && Object.hasOwn(distributionsInput, 'agentSkills');
  const manifest = validatePluginManifest(pluginRoot, rawManifest, {
    compatibilityMode: requiresExplicitMinVersion ? 'required' : 'defaulted',
    defaultMinVersion: DEFAULT_SOURCE_PLUGIN_AW_MIN_VERSION,
    reservedImports: options.reservedImports,
  });
  const parsedVersion = parseStrictSemVer(manifest.version, 'plugin manifest.version');
  if (parsedVersion.prerelease.length > 0 || parsedVersion.build.length > 0) {
    throw new Error(
      'Invalid plugin manifest.version: expected a stable SemVer without prerelease or build metadata.',
    );
  }
  if ((manifest.artifacts?.targets ?? []).some((target) =>
    target.runtimeImports?.some((runtimeImport) => runtimeImport.resolved !== undefined))) {
    throw new Error('Invalid plugin manifest: artifact runtime import resolved metadata is build-owned.');
  }
  await validateDeclaredNativeAssets(pluginRoot, manifest);
  await validateDeclaredAssetPathsExist(pluginRoot, manifest);
  await Promise.all([
    validateSourceJsonNativeAsset(pluginRoot, manifest, 'mcpServers'),
    validateSourceJsonNativeAsset(pluginRoot, manifest, 'apps'),
    validateSourceSkillInventory(pluginRoot, manifest),
    ...(manifest.distributions?.agentSkills?.skills
      ? [validatePortableSkillDirectoriesRoot(path.join(
          pluginRoot,
          stripDotSlash(manifest.distributions.agentSkills.skills),
        ))]
      : []),
    ...(manifest.buildConfig?.runtimeExports ?? []).map((entry) =>
      validateRuntimeExportSource({
        pluginRoot,
        name: entry.name,
        source: entry.source,
      })),
  ]);
  await assertActualNativePluginCapability(pluginRoot, manifest);
  return manifest;
}

export interface ReadPluginManifestOptions {
  mode?: 'source' | 'bundle';
  reservedImports?: ReservedImportRegistry;
}

export async function readPluginManifest(
  pluginRoot: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta> {
  await assertPluginInputTree(pluginRoot);
  const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
  const rawManifest = await readJsonFile<unknown>(manifestPath);
  const mode = options.mode ?? 'source';
  const manifest = mode === 'source'
    ? await validateSourcePluginManifest(pluginRoot, rawManifest, {
      reservedImports: options.reservedImports,
    })
    : validatePluginManifest(pluginRoot, rawManifest, {
      compatibilityMode: 'required',
      reservedImports: options.reservedImports,
    });
  if (mode === 'bundle') await assertActualNativePluginCapability(pluginRoot, manifest, 'bundle');
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

export async function discoverPluginsInDirectory(
  pluginsDir: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  if (!(await fs.pathExists(pluginsDir))) {
    return [];
  }

  const entries = await fs.readdir(pluginsDir);
  const plugins = await Promise.all(
    entries.map(async (entry) => {
      const pluginRoot = path.join(pluginsDir, entry);
      const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
      if (!(await fs.pathExists(manifestPath))) {
        return null;
      }

      return readPluginManifest(pluginRoot, options);
    }),
  );

  return plugins
    .filter((plugin): plugin is PluginMeta => plugin !== null)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export async function discoverPlugins(
  repoRoot: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  return discoverPluginsInDirectory(path.join(repoRoot, 'plugins'), options);
}

function selectPlugins(plugins: PluginMeta[], pluginNames?: string[]): PluginMeta[] {
  if (!pluginNames || pluginNames.length === 0) {
    return plugins;
  }

  const pluginMap = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  return pluginNames.map((pluginName) => {
    const plugin = pluginMap.get(pluginName);
    if (!plugin) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }
    return plugin;
  });
}

export async function resolvePlugins(
  repoRoot: string,
  pluginNames?: string[],
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  const plugins = await discoverPlugins(repoRoot, options);
  return selectPlugins(plugins, pluginNames);
}

export async function resolvePluginsFromCatalog(
  catalogRoot: string,
  pluginNames?: string[],
  options: Omit<ReadPluginManifestOptions, 'mode'> = {},
): Promise<PluginMeta[]> {
  const plugins = await discoverPluginsInDirectory(
    path.join(catalogRoot, 'plugins'),
    { ...options, mode: 'bundle' },
  );
  return selectPlugins(plugins, pluginNames);
}

export function createMarketplaceManifestEntry(plugin: PluginMeta): MarketplaceManifest['plugins'][number] {
  return {
    name: plugin.manifest.name,
    source: `./plugins/${plugin.manifest.name}`,
    description: plugin.manifest.description,
    interface: plugin.manifest.interface,
    category: plugin.manifest.marketplace.category,
    tags: plugin.manifest.marketplace.tags,
    strict: plugin.manifest.marketplace.strict,
    policy: plugin.manifest.marketplace.policy,
  };
}

export function createMarketplaceManifest(
  sourceMeta: MarketplaceSourceMeta,
  plugins: PluginMeta[],
): MarketplaceManifest {
  return {
    name: 'aw',
    owner: sourceMeta.owner,
    interface: sourceMeta.interface,
    plugins: plugins.map((plugin) => createMarketplaceManifestEntry(plugin)),
  };
}

export function normalizeManifestDigestInput(
  value: PluginManifestSource | CatalogManifestEntry,
): string {
  return stableStringify(value);
}

function normalizeCatalogRelativePath(value: unknown, fieldName: string): string {
  const relativePath = ensureString(value, fieldName);
  if (path.posix.isAbsolute(relativePath)) {
    throw new Error(`Invalid ${fieldName}: absolute paths are not allowed.`);
  }
  if (!relativePath.startsWith('./')) {
    throw new Error(`Invalid ${fieldName}: path must start with "./".`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid ${fieldName}: path must stay inside the catalog package.`);
  }

  return normalized.startsWith('./') ? normalized : `./${normalized}`;
}

function assertCatalogChannelVersionContract(options: {
  channel: CatalogChannel;
  version: string;
  fieldName: string;
  kind: 'catalog' | 'plugin';
}): void {
  const prerelease = isPrereleaseVersion(options.version);
  if (options.channel === 'latest' && prerelease) {
    throw new Error(`Invalid ${options.fieldName}: latest catalog rejects prerelease ${options.kind} versions.`);
  }
  if (options.channel === 'beta' && options.kind === 'catalog' && !prerelease) {
    throw new Error(`Invalid ${options.fieldName}: beta catalog requires a prerelease catalog version.`);
  }
}

function normalizeCatalogManifestEntry(
  value: unknown,
  fieldName: string,
): CatalogManifestEntry {
  const input = assertObject(value, fieldName);
  if (Object.hasOwn(input, 'dependencies')) {
    throw new Error(`Invalid ${fieldName}: "dependencies" is unsupported.`);
  }
  assertAllowedKeys(input, fieldName, [
    'name',
    'version',
    'description',
    'interface',
    'category',
    'tags',
    'strict',
    'policy',
    'compatibility',
    'source',
    'artifactDigest',
    'manifestDigest',
  ]);

  const entry: CatalogManifestEntry = {
    name: ensurePluginName(input.name, `${fieldName}.name`),
    version: assertStrictSemVer(input.version, `${fieldName}.version`),
    description: ensureString(input.description, `${fieldName}.description`),
    category: ensureString(input.category, `${fieldName}.category`),
    strict: ensureBoolean(input.strict, `${fieldName}.strict`),
    policy: normalizeMarketplacePolicy(input.policy, `${fieldName}.policy`),
    compatibility: normalizePluginCompatibility(input.compatibility, `${fieldName}.compatibility`, {
      allowMissing: false,
    }),
    source: normalizeCatalogRelativePath(input.source, `${fieldName}.source`),
    artifactDigest: ensureDigestString(input.artifactDigest, `${fieldName}.artifactDigest`),
    manifestDigest: ensureDigestString(input.manifestDigest, `${fieldName}.manifestDigest`),
  };

  if (input.tags !== undefined) {
    entry.tags = normalizeComparableStringArray(ensureStringArray(input.tags, `${fieldName}.tags`));
  }
  if (input.interface !== undefined) {
    entry.interface = normalizePluginInterface(input.interface, `${fieldName}.interface`);
  }
  return entry;
}

export interface NormalizedCatalogManifestBase {
  catalogVersion: string;
  channel: CatalogChannel;
  compatibility: PluginCompatibility;
}

export function normalizeCatalogManifestBase(
  input: Record<string, unknown>,
  fieldName: string,
): NormalizedCatalogManifestBase {
  const catalogVersion = assertCatalogVersion(input.catalogVersion, `${fieldName}.catalogVersion`);
  const channel = assertCatalogChannel(input.channel, `${fieldName}.channel`);
  assertCatalogChannelVersionContract({
    channel,
    version: catalogVersion,
    fieldName: `${fieldName}.catalogVersion`,
    kind: 'catalog',
  });
  const compatibility = normalizePluginCompatibility(
    input.compatibility,
    `${fieldName}.compatibility`,
    { allowMissing: false },
  );
  return { catalogVersion, channel, compatibility };
}

export function normalizeCatalogManifestEntries(
  rawEntries: unknown,
  base: NormalizedCatalogManifestBase,
  fieldName: string,
): CatalogManifestEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new Error(`Invalid ${fieldName}.entries: expected an array.`);
  }
  const entries = rawEntries.map((entry, index) =>
    normalizeCatalogManifestEntry(entry, `${fieldName}.entries[${index}]`),
  );
  const entriesByName = new Map<string, CatalogManifestEntry>();
  for (const entry of entries) {
    if (entriesByName.has(entry.name)) {
      throw new Error(`Invalid ${fieldName}.entries: duplicate plugin "${entry.name}".`);
    }
    entriesByName.set(entry.name, entry);
    if (!(base.channel === 'beta' && !entry.version.includes('-'))) {
      assertCatalogChannelVersionContract({
        channel: base.channel,
        version: entry.version,
        fieldName: `${fieldName}.entries.${entry.name}.version`,
        kind: 'plugin',
      });
    }
    assertPluginMinVersionWithinCatalogBounds({
      pluginName: entry.name,
      pluginMinVersion: entry.compatibility.aw.minVersion,
      catalogMinVersion: base.compatibility.aw.minVersion,
      fieldName: `${fieldName}.entries.${entry.name}.compatibility.aw.minVersion`,
    });
  }
  return entries;
}

export function createBundleSourceManifest(plugin: PluginMeta): NormalizedPluginManifest {
  const scripts = plugin.manifest.scripts
    ? structuredClone(plugin.manifest.scripts)
    : undefined;
  if (scripts?.tests) {
    delete scripts.tests;
  }
  if (scripts?.node?.build) {
    delete scripts.node.build;
  }
  let buildConfig = plugin.manifest.buildConfig
    ? structuredClone(plugin.manifest.buildConfig)
    : undefined;
  if (buildConfig) {
    delete buildConfig.cacheable;
    delete buildConfig.runtimeExports;
    delete buildConfig.buildImports;
    delete buildConfig.skillRuntimeFiles;
    delete buildConfig.generatedSkillRuntimeFiles;
    if (Object.keys(buildConfig).length === 0) {
      buildConfig = undefined;
    }
  }

  return {
    ...plugin.manifest,
    buildConfig,
    compatibility: plugin.manifest.compatibility
      ? structuredClone(plugin.manifest.compatibility)
      : createPluginCompatibility(DEFAULT_SOURCE_PLUGIN_AW_MIN_VERSION),
    extensions: plugin.manifest.extensions
      ? {
          instructions: plugin.manifest.extensions.instructions
            ?.map((entry) => structuredClone(entry)),
          permissions: plugin.manifest.extensions.permissions
            ?.map((entry) => structuredClone(entry)),
          hooks: plugin.manifest.extensions.hooks
            ?.map((entry) => structuredClone(entry)),
          nativeHooks: plugin.manifest.extensions.nativeHooks
            ? {
                claude: plugin.manifest.extensions.nativeHooks.claude
                  ?.map((entry) => structuredClone(entry)),
                codex: plugin.manifest.extensions.nativeHooks.codex
                  ?.map((entry) => structuredClone(entry)),
              }
            : undefined,
          agents: plugin.manifest.extensions.agents
            ?.map((entry) => structuredClone(entry)),
        }
      : undefined,
    artifacts: plugin.manifest.artifacts
      ? structuredClone(plugin.manifest.artifacts)
      : undefined,
    scripts,
    config: plugin.manifest.config
      ? structuredClone(plugin.manifest.config)
      : undefined,
  };
}

export function createPlatformManifestBase(plugin: PluginMeta): PlatformPluginManifest {
  return {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    compatibility: structuredClone(plugin.manifest.compatibility ?? {
      aw: {
        minVersion: '0.0.0',
      },
    }),
    interface: plugin.manifest.interface,
  };
}

function platformBundlePath(value: string, platform: PlatformName): string {
  return `./${platform}/${stripDotSlash(value)}`;
}

function generatedPlatformEntryName(pluginName: string, itemName: string): string {
  const slugify = (value: string): string => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `aw-${slugify(pluginName)}-${slugify(itemName)}`;
}

function renderExpectedPlatformHooks(
  plugin: PluginMeta,
  platform: PlatformName,
): PlatformPluginManifest['hooks'] {
  const groups = resolvePlatformHookDefinitions(plugin.manifest, platform)
    .map((definition) => renderHookDefinitionGroup(definition, platform))
    .sort((left, right) => JSON.stringify(normalizeRenderedHookGroupIdentity({
      platform,
      event: left.event,
      matcher: left.matcher,
      command: left.hooks[0]!.command,
    })).localeCompare(JSON.stringify(normalizeRenderedHookGroupIdentity({
      platform,
      event: right.event,
      matcher: right.matcher,
      command: right.hooks[0]!.command,
    }))));
  if (groups.length === 0) return undefined;
  if (platform === 'claude') return './claude/hooks/hooks.json';
  const hooks: NonNullable<Extract<PlatformPluginManifest['hooks'], object>>['hooks'] = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event]!.push({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: group.hooks,
    });
  }
  return { hooks };
}

async function isProjectedDirectory(plugin: PluginMeta, relativePath: string): Promise<boolean> {
  const stats = await fs.lstat(path.join(plugin.rootDir, stripDotSlash(relativePath))).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Invalid platform manifest projection path: expected a regular directory at ${relativePath}.`);
  }
  return true;
}

async function assertPlatformProjectionPath(plugin: PluginMeta, relativePath: string): Promise<void> {
  if (!relativePath.startsWith('./')) {
    throw new Error(`Invalid platform manifest projection path ${JSON.stringify(relativePath)}.`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid platform manifest projection path ${JSON.stringify(relativePath)}.`);
  }
  let current = plugin.rootDir;
  for (const segment of stripDotSlash(normalized).split('/')) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch(() => undefined);
    if (!stats) throw new Error(`Invalid platform manifest projection: missing ${relativePath}.`);
    if (stats.isSymbolicLink()) {
      throw new Error(`Invalid platform manifest projection: symbolic links are not supported (${relativePath}).`);
    }
  }
}

export async function validatePlatformManifestProjection(
  plugin: PluginMeta,
  platform: PlatformName,
  rawManifest: unknown,
): Promise<PlatformPluginManifest> {
  const expected: PlatformPluginManifest = createPlatformManifestBase(plugin);
  const projectedPaths: string[] = [];
  if (plugin.manifest.skills) {
    const projected = platformBundlePath(plugin.manifest.skills, platform);
    if (await isProjectedDirectory(plugin, projected)) {
      expected.skills = projected;
      projectedPaths.push(projected);
    }
  }
  if (plugin.manifest.mcpServers) {
    expected.mcpServers = platformBundlePath(plugin.manifest.mcpServers, platform);
    projectedPaths.push(expected.mcpServers);
  }
  if (platform === 'codex' && plugin.manifest.apps) {
    expected.apps = platformBundlePath(plugin.manifest.apps, platform);
    projectedPaths.push(expected.apps);
  }
  expected.hooks = renderExpectedPlatformHooks(plugin, platform);
  if (typeof expected.hooks === 'string') projectedPaths.push(expected.hooks);

  if (platform === 'claude') {
    const overrides = plugin.manifest.buildConfig?.manifestOverrides?.claude;
    if (overrides?.outputStyles) {
      expected.outputStyles = platformBundlePath(overrides.outputStyles, platform);
      projectedPaths.push(expected.outputStyles);
    }
    if (overrides?.lspServers !== undefined) {
      const projectLspPath = (value: string): string => {
        const projected = platformBundlePath(value, platform);
        projectedPaths.push(projected);
        return projected;
      };
      expected.lspServers = typeof overrides.lspServers === 'string'
        ? projectLspPath(overrides.lspServers)
        : Array.isArray(overrides.lspServers)
          ? overrides.lspServers.map((entry) => typeof entry === 'string' ? projectLspPath(entry) : entry)
          : overrides.lspServers;
    }
    expected.userConfig = overrides?.userConfig;
    expected.channels = overrides?.channels;
    const agents = resolvePlatformEntries(plugin.manifest.extensions?.agents, 'claude');
    if (agents.length > 0) {
      expected.agents = agents.map((agent) =>
        `./claude/agents/${generatedPlatformEntryName(plugin.manifest.name, agent.name)}.md`);
      projectedPaths.push(...expected.agents);
    }
    if (plugin.manifest.slashCommands) {
      expected.commands = './claude/commands';
      projectedPaths.push(expected.commands);
    }
  } else if (plugin.manifest.slashCommands) {
    expected.skills ??= './codex/skills';
    if (!projectedPaths.includes(expected.skills)) projectedPaths.push(expected.skills);
  }

  const canonicalExpected = JSON.parse(JSON.stringify(expected)) as PlatformPluginManifest;
  if (!isDeepStrictEqual(rawManifest, canonicalExpected)) {
    throw new Error(`Invalid ${platform} platform manifest projection.`);
  }
  await Promise.all([...new Set(projectedPaths)].map((relativePath) =>
    assertPlatformProjectionPath(plugin, relativePath)));
  return canonicalExpected;
}
