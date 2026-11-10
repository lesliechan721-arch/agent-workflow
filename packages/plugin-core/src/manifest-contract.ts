import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import fs from 'fs-extra';
import {
  computeAwCapabilitySetDigest,
  normalizeAwCapabilities,
} from './aw-capabilities.js';
import {
  normalizePluginManifestSchemaVersion,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION,
} from './manifest.js';
import { selectPluginConfigProfile, getPluginConfigDependencyKeys, normalizePluginConfigDefinition } from './plugin-config.js';

import type {
  CatalogMarketplaceIdentity,
  BuildConfig,
  BuildConfigFileRuleSet,
  BuildConfigTemplates,
  CatalogChannel,
  CatalogManifestEntry,
  MarketplaceAuthenticationPolicy,
  MarketplaceManifest,
  MarketplaceSourceMeta,
  PermissionDefinition,
  PlatformAgentOverrides,
  PlatformName,
  PlatformTarget,
  MarketplacePolicy,
  PlatformPluginManifest,
  PluginRequirements,
  PluginConfigSchema,
  PluginArtifactRenderScriptEntry,
  PluginArtifactsConfig,
  PluginExtensions,
  PluginInterfaceMeta,
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
import { loadPluginNativeToolClosure, normalizeNativeTools, validateNativeToolClosureFiles, validateNativeToolsManifest } from './native-tools.js';
import { parsePermissionCommand } from './permission-command.js';
import { normalizeManagedCommands, normalizeManagedCommandPermission, validateManagedCommandManifest, validateManagedCommandSources, type PermissionCommand } from './managed-commands.js';
import { applyFileRules } from './file-rules.js';
import { isAuthorOnlySkillCollection, isAuthorOnlySkillDirectory } from './skill-authoring.js';
import { applyPlatformOverride } from './platform-entries.js';
import type { HookFeedback, PluginComponent } from './plugin-components.js';
import {
  assertHookMatcherAllowed,
  assertNoDuplicateHookHandlers,
  assertPublicHookEvent,
} from './hooks-contract.js';
import {
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
} from './plugin-script-contract.js';
import { assertPluginInputTree, validateRuntimeExportSource } from './runtime-export-source.js';
import {
  formatManifestPlatformsForError,
  normalizePlatformTargets,
  resolveSupportedPlatforms,
  PLATFORM_TARGETS,
  NATIVE_PLATFORM_TARGETS,
  resolveSupportedNativePlatforms,
  normalizeMarketplaceProductToken,
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
const PLATFORM_PRODUCT_BY_NAME: Partial<Record<PlatformName, string>> = {
  claude: 'CLAUDE',
  codex: 'CODEX',
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
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
): PermissionCommand[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid ${fieldName}: expected an array.`);
  return value.map((entry, index) => {
    const label = `${fieldName}[${index}]`;
    if (typeof entry === 'string') {
      parsePermissionCommand(entry, label);
      return entry;
    }
    return normalizeManagedCommandPermission(entry, label);
  });
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

function normalizePluginRequirements(
  value: unknown,
  fieldName: string,
  options: { allowMissing: boolean },
): PluginRequirements | undefined {
  if (value === undefined) {
    if (options.allowMissing) return undefined;
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['aw']);
  const aw = assertObject(input.aw, `${fieldName}.aw`);
  assertAllowedKeys(aw, `${fieldName}.aw`, ['capabilities']);
  if (aw.capabilities !== undefined && !Array.isArray(aw.capabilities)) {
    throw new Error(`Invalid ${fieldName}.aw.capabilities: expected an array.`);
  }
  return {
    aw: {
      ...(aw.capabilities === undefined
        ? {}
        : { capabilities: normalizeAwCapabilities(aw.capabilities, `${fieldName}.aw.capabilities`) }),
    },
  };
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
  manifest: PluginManifestSource | NormalizedPluginManifest;
  fieldPath: string;
  requiredPlatform: PlatformTarget;
}): void {
  if (supportsPlatform(options.manifest, options.requiredPlatform)) {
    return;
  }

  throw new Error(
    `Invalid plugin "${options.pluginName}": ${options.fieldPath} requires ${options.requiredPlatform} support, but ${formatManifestPlatformsForError(options.manifest)}.`,
  );
}

function hasNonEmptyPlatformOverride(
  value: Record<string, unknown> | null | undefined,
): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

function assertAgentOverridePlatformsSupported(options: {
  pluginName: string;
  manifest: PluginManifestSource | NormalizedPluginManifest;
  fieldPath: string;
  agentOverrides: PlatformAgentOverrides<unknown> | undefined;
}): void {
  for (const platform of PLATFORM_TARGETS) {
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
  manifest: PluginManifestSource | NormalizedPluginManifest,
): void {
  for (const platform of PLATFORM_TARGETS) {
    if (manifest.buildConfig?.fileRules?.[platform] !== undefined) {
      assertPlatformFieldSupported({ pluginName, manifest,
        fieldPath: `buildConfig.fileRules.${platform}`, requiredPlatform: platform });
    }
  }
  for (const selector of ['skillRuntimeFiles', 'generatedSkillRuntimeFiles'] as const) {
    manifest.buildConfig?.[selector]?.forEach((entry, index) => {
      for (const platform of entry.platforms ?? []) {
        assertPlatformFieldSupported({ pluginName, manifest,
          fieldPath: `buildConfig.${selector}[${index}].platforms`, requiredPlatform: platform });
      }
    });
  }
  for (const platform of NATIVE_PLATFORM_TARGETS) {
    if (manifest.extensions?.nativeHooks?.[platform]?.length) {
      assertPlatformFieldSupported({ pluginName, manifest, fieldPath: `extensions.nativeHooks.${platform}`, requiredPlatform: platform });
    }
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
): MarketplacePolicy {
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
    policy: (() => {
      const { products: _products, ...policy } = normalizeMarketplacePolicy(input.policy, `${fieldName}.policy`);
      return policy;
    })(),
  };
}

function normalizeTemplateVarByPlatform(
  value: unknown,
  fieldName: string,
): TemplateVarByPlatform {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, [...PLATFORM_TARGETS]);
  if (Object.keys(input).length === 0) throw new Error(`Invalid ${fieldName}: expected at least one platform value.`);
  const output: TemplateVarByPlatform = {};
  for (const platform of PLATFORM_TARGETS) {
    const value = input[platform];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error(`Invalid ${fieldName}.${platform}: template vars must be string or boolean.`);
    }
    output[platform] = value;
  }
  return output;
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
    assertAllowedKeys(input, entryField, ['name', 'source', 'requires']);
    const name = normalizeRuntimeExportName(input.name, `${entryField}.name`);
    if (names.has(name)) {
      throw new Error(`Invalid ${fieldName}: duplicate export name "${name}".`);
    }
    names.add(name);
    const requires = normalizePluginRequirements(
      input.requires,
      `${entryField}.requires`,
      { allowMissing: false },
    )!;
    if (requires.aw.capabilities === undefined) {
      throw new Error(`Invalid ${entryField}.requires.aw.capabilities: expected an array.`);
    }
    return {
      name,
      source: normalizeCanonicalPluginFilePath(pluginRoot, input.source, `${entryField}.source`),
      requires: { aw: { capabilities: requires.aw.capabilities } },
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
    assertAllowedKeys(input, entryField, ['skill', 'target', 'platforms', 'source', 'import']);
    const skill = ensurePluginName(input.skill, `${entryField}.skill`);
    const target = normalizeSkillRuntimeTarget(input.target, `${entryField}.target`);
    const hasSource = input.source !== undefined;
    const hasImport = input.import !== undefined;
    if (hasSource === hasImport) {
      throw new Error(`Invalid ${entryField}: exactly one of source or import is required.`);
    }
    const platforms = input.platforms === undefined
      ? undefined : normalizePlatformTargets(input.platforms, `${entryField}.platforms`);
    for (const platform of platforms?.length ? platforms : PLATFORM_TARGETS) {
      const collisionKey = `${platform}:${skill}/${target}`;
      if (targets.has(collisionKey)) throw new Error(`Invalid ${fieldName}: duplicate target "${collisionKey}".`);
      targets.add(collisionKey);
    }
    return {
      skill,
      target,
      ...(platforms ? { platforms } : {}),
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
    assertAllowedKeys(input, entryField, ['skill', 'target', 'platforms']);
    const skill = ensurePluginName(input.skill, `${entryField}.skill`);
    const target = normalizeSkillRuntimeTarget(input.target, `${entryField}.target`);
    const platforms = input.platforms === undefined
      ? undefined : normalizePlatformTargets(input.platforms, `${entryField}.platforms`);
    for (const platform of platforms?.length ? platforms : PLATFORM_TARGETS) {
      const collisionKey = `${platform}:${skill}/${target}`;
      if (targets.has(collisionKey)) throw new Error(`Invalid ${fieldName}: duplicate target "${collisionKey}".`);
      targets.add(collisionKey);
    }
    return {
      skill,
      target,
      ...(platforms ? { platforms } : {}),
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
    assertAllowedKeys(fileRulesInput, `${fieldName}.fileRules`, [...PLATFORM_TARGETS]);
    buildConfig.fileRules = {};
    for (const platform of PLATFORM_TARGETS) {
      if (fileRulesInput[platform] === undefined) continue;
      const normalizedRuleSet = normalizeFileRuleSet(fileRulesInput[platform], `${fieldName}.fileRules.${platform}`);
      buildConfig.fileRules[platform] = normalizedRuleSet;
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

function ensureBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${fieldName}: expected a boolean.`);
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
): PluginNodeBuildScript {
  const input = assertObject(value, fieldName);
  if ('command' in input) {
    throw new Error(`Invalid ${fieldName}: inline command strings are not allowed.`);
  }
  if ('timeoutMs' in input || 'timeout' in input) {
    throw new Error(`Invalid ${fieldName}: per-event and per-selector timeouts are not supported.`);
  }
  assertAllowedKeys(input, fieldName, ['runner', 'path', 'args']);

  const runner = ensureString(input.runner, `${fieldName}.runner`);
  if (runner !== 'node') {
    throw new Error(`Invalid ${fieldName}.runner: expected "node".`);
  }

  const scriptPath = normalizePluginScriptPath(pluginRoot, input.path, `${fieldName}.path`);
  return {
    runner: 'node',
    path: scriptPath,
    args:
      input.args === undefined
        ? undefined
        : ensureStringArray(input.args, `${fieldName}.args`),
  };
}

function normalizePreApplyScript(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): NonNullable<PluginScriptsConfig['preApply']> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['path', 'timeoutMs']);
  const scriptPath = normalizePluginScriptPath(pluginRoot, input.path, `${fieldName}.path`);
  assertNodeRunnablePath(scriptPath, `${fieldName}.path`);
  return {
    path: scriptPath,
    ...(input.timeoutMs === undefined
      ? {}
      : { timeoutMs: normalizeScriptTimeout(input.timeoutMs, `${fieldName}.timeoutMs`) }),
  };
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
  const entry = normalizeScriptEntry(pluginRoot, value, fieldName);
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
  const entry = normalizeScriptEntry(pluginRoot, value, fieldName);
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
  assertAllowedKeys(input, fieldName, ['preApply', 'helpers', 'node', 'artifacts', 'tests']);

  const output: PluginScriptsConfig = {};

  if (input.preApply !== undefined) {
    output.preApply = normalizePreApplyScript(pluginRoot, input.preApply, `${fieldName}.preApply`);
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

function normalizeArtifactRuntimeImports(
  value: unknown,
  fieldName: string,
  reservedImports: ReservedImportRegistry | undefined,
): NonNullable<PluginArtifactsConfig['runtimeImports']> | undefined {
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
    let resolved: NonNullable<PluginArtifactsConfig['runtimeImports']>[number]['resolved'];
    if (input.resolved !== undefined) {
      const resolvedInput = assertObject(input.resolved, `${entryField}.resolved`);
      assertAllowedKeys(resolvedInput, `${entryField}.resolved`, [
        'path', 'digest', 'providerPluginId', 'providerVersion', 'source',
        'requiredCapabilities', 'capabilitySetDigest',
      ]);
      if (!Array.isArray(resolvedInput.requiredCapabilities)) {
        throw new Error(`Invalid ${entryField}.resolved.requiredCapabilities: expected an array.`);
      }
      const requiredCapabilities = normalizeAwCapabilities(
        resolvedInput.requiredCapabilities,
        `${entryField}.resolved.requiredCapabilities`,
      );
      const capabilitySetDigest = ensureDigestString(
        resolvedInput.capabilitySetDigest,
        `${entryField}.resolved.capabilitySetDigest`,
      );
      if (capabilitySetDigest !== computeAwCapabilitySetDigest(requiredCapabilities)) {
        throw new Error(`Invalid ${entryField}.resolved.capabilitySetDigest: digest does not match requiredCapabilities.`);
      }
      resolved = {
        path: normalizePluginChildPath('', ensureString(resolvedInput.path, `${entryField}.resolved.path`), `${entryField}.resolved.path`),
        digest: ensureDigestString(resolvedInput.digest, `${entryField}.resolved.digest`),
        providerPluginId: ensureString(resolvedInput.providerPluginId, `${entryField}.resolved.providerPluginId`),
        providerVersion: assertStrictSemVer(resolvedInput.providerVersion, `${entryField}.resolved.providerVersion`),
        source: ensureString(resolvedInput.source, `${entryField}.resolved.source`),
        requiredCapabilities,
        capabilitySetDigest,
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

function normalizeArtifacts(
  pluginRoot: string, value: unknown, fieldName: string,
  schema: PluginConfigSchema | undefined, platforms: readonly PlatformTarget[], reservedImports: ReservedImportRegistry | undefined,
): PluginArtifactsConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['configKeys', 'sourceDirs', 'runtimeImports', 'scopes']);
  const configKeys = ensureStringArray(input.configKeys, `${fieldName}.configKeys`);
  if (new Set(configKeys).size !== configKeys.length) throw new Error(`Invalid ${fieldName}.configKeys: duplicate key.`);
  for (const platform of platforms) {
    const profile = schema && selectPluginConfigProfile(schema, platform);
    for (const key of configKeys) {
      if (!profile?.fields[key]) throw new Error(`Invalid ${fieldName}.configKeys: unknown config key "${key}" for ${platform}.`);
    }
    if (profile) getPluginConfigDependencyKeys(profile, configKeys);
  }
  return {
    configKeys,
    ...(input.sourceDirs === undefined ? {} : { sourceDirs: normalizePathArray(pluginRoot, input.sourceDirs, `${fieldName}.sourceDirs`) }),
    ...(input.runtimeImports === undefined ? {} : { runtimeImports: normalizeArtifactRuntimeImports(input.runtimeImports, `${fieldName}.runtimeImports`, reservedImports) }),
    ...(input.scopes === undefined ? {} : { scopes: ensureStringArray(input.scopes, `${fieldName}.scopes`) as Array<'user' | 'project'> }),
  };
}

function normalizeExtensions(value: unknown, fieldName: string): PluginExtensions {
  // Structure and override fields have already passed the public v4 schema.
  const extensions = structuredClone(value) as PluginExtensions;
  for (const [index, permission] of (extensions.permissions ?? []).entries()) {
    for (const rule of ['allow', 'ask', 'deny'] as const) {
      if (permission[rule]) permission[rule] = normalizePermissionCommandArray(permission[rule], `${fieldName}.permissions[${index}].${rule}`);
    }
    for (const platform of PLATFORM_TARGETS) {
      const override = permission.agentOverrides?.[platform];
      if (!override) continue;
      for (const rule of ['allow', 'ask', 'deny'] as const) {
        if (override[rule]) override[rule] = normalizePermissionCommandArray(override[rule], `${fieldName}.permissions[${index}].agentOverrides.${platform}.${rule}`);
      }
      if (platform === 'claude' && 'sandbox' in override && override.sandbox) {
        const sandbox = override.sandbox as NonNullable<PermissionDefinition['sandbox']>;
        sandbox.excludedCommands = sandbox.excludedCommands.map((entry) => normalizeManagedCommandPermission(entry));
      }
    }
  }
  return extensions;
}

export function validateMarketplaceSourceMeta(rawValue: unknown): MarketplaceSourceMeta {
  const input = assertObject(rawValue, 'marketplace source metadata');
  assertAllowedKeys(input, 'marketplace source metadata', ['owner', 'interface', 'catalog']);

  const ownerInput = assertObject(input.owner, 'marketplace source metadata.owner');
  assertAllowedKeys(ownerInput, 'marketplace source metadata.owner', ['name', 'url']);
  const interfaceInput = assertObject(input.interface, 'marketplace source metadata.interface');
  assertAllowedKeys(interfaceInput, 'marketplace source metadata.interface', ['displayName']);
  const catalogInput = assertObject(input.catalog, 'marketplace source metadata.catalog');
  assertAllowedKeys(catalogInput, 'marketplace source metadata.catalog', ['version']);

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
      version: assertCatalogVersion(
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
  reservedImports?: ReservedImportRegistry;
}

export type ReservedImportRegistry = Readonly<Record<string, readonly string[]>>;

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
  options: ValidatePluginManifestOptions = {},
): NormalizedPluginManifest {
  const input = assertObject(
    normalizePluginManifestSchemaVersion(rawManifest),
    'plugin manifest',
  );
  assertAllowedKeys(input, 'plugin manifest', [
    'schemaVersion',
    'name',
    'version',
    'description',
    'dependencies',
    'requires',
    'skills',
    'mcpServers',
    'platforms',
    'marketplace',
    'interface',
    'extensions',
    'artifacts',
    'buildConfig',
    'scripts',
    'config',
    'managedCommands',
    'nativeTools',
  ]);

  const manifest: NormalizedPluginManifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    name: ensureString(input.name, 'name'),
    version: assertStrictSemVer(input.version, 'plugin manifest.version'),
    description: ensureString(input.description, 'description'),
    marketplace: normalizeMarketplaceMeta(input.marketplace, 'marketplace'),
  };

  const requires = normalizePluginRequirements(input.requires, 'requires', { allowMissing: true });
  if (requires !== undefined) manifest.requires = requires;

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
    const skills = normalizePluginRelativePath(pluginRoot, ensureString(input.skills, 'skills'), 'skills');
    if (skills !== './skills') throw new Error('Invalid plugin manifest: skills must be "./skills".');
    manifest.skills = './skills';
  }


  if (input.mcpServers !== undefined) {
    manifest.mcpServers = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.mcpServers, 'mcpServers'),
      'mcpServers',
    );
  }


  if (input.platforms !== undefined) {
    manifest.platforms = normalizePlatformTargets(input.platforms, 'platforms');
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
    manifest.config = normalizePluginConfigDefinition(input.config, 'config', {
      plugin: manifest.name, dependencies: manifest.dependencies ?? [],
    });
  }

  if (input.artifacts !== undefined) {
    manifest.artifacts = normalizeArtifacts(
      pluginRoot,
      input.artifacts,
      'artifacts',
      manifest.config,
      [...resolveSupportedPlatforms(manifest)],
      options.reservedImports,
    );
  }

  if (manifest.artifacts && !manifest.scripts?.artifacts?.render) throw new Error('Invalid artifacts: requires scripts.artifacts.render.');

  if (input.managedCommands !== undefined) {
    manifest.managedCommands = normalizeManagedCommands(input.managedCommands);
    validateManagedCommandManifest(manifest);
  }
  if (input.nativeTools !== undefined) {
    manifest.nativeTools = normalizeNativeTools(input.nativeTools);
    validateNativeToolsManifest(manifest);
  }
  assertManifestPlatformSupport(manifest.name, manifest);
  for (const platform of resolveSupportedPlatforms(manifest)) {
    const hooks: PluginComponent[] = [];
    const checkHook = (dialect: 'common' | 'native', hook: { id: string; event: string; feedback: HookFeedback; matcher?: string; command?: string }, fieldName: string): void => {
      const command = ensureString(hook.command, `${fieldName}.command for ${platform}`);
      assertHookMatcherAllowed({ kind: dialect === 'common' ? 'public' : 'native', platform, event: hook.event, matcher: hook.matcher, fieldName: `${fieldName}.matcher for ${platform}`, phase: 'source' });
      const identity = dialect === 'common' ? `hook:${hook.id}` : `native-hook:${platform}:${hook.id}`;
      hooks.push({ id: identity, name: identity, kind: 'hook', content: dialect === 'common'
        ? { dialect, event: assertPublicHookEvent(hook.event, `${fieldName}.event`), feedback: hook.feedback, matcher: hook.matcher, command }
        : { dialect, event: hook.event, feedback: hook.feedback, matcher: hook.matcher, command } });
    };
    for (const hook of manifest.extensions?.hooks ?? []) {
      const resolved = applyPlatformOverride(hook, platform);
      if (resolved) checkHook('common', resolved, `extensions.hooks.${hook.id}`);
    }
    for (const hook of manifest.extensions?.nativeHooks?.[platform] ?? []) {
      checkHook('native', hook, `extensions.nativeHooks.${platform}.${hook.id}`);
    }
    assertNoDuplicateHookHandlers(hooks, platform);
  }

  return manifest;
}

async function validateDeclaredNativeAssets(pluginRoot: string, manifest: PluginManifestSource | NormalizedPluginManifest): Promise<void> {
  for (const [field, relative] of [['skills', 'skills'], ['mcpServers', '.mcp.json']] as const) {
    if (!manifest[field] && await fs.pathExists(path.join(pluginRoot, relative))) {
      if (field === 'skills' && await isAuthorOnlySkillCollection(path.join(pluginRoot, relative))) continue;
      if (field === 'skills' && await skillTreeIsDeclaredDynamicInput(pluginRoot, manifest.artifacts?.sourceDirs ?? [])) continue;
      throw new Error(`Invalid plugin manifest: found ${relative} but missing "${field}" declaration.`);
    }
  }
}

async function skillTreeIsDeclaredDynamicInput(pluginRoot: string, sourceDirs: readonly string[]): Promise<boolean> {
  if (sourceDirs.length === 0) return false;
  const roots = sourceDirs.map(stripDotSlash);
  const visit = async (relative: string): Promise<boolean> => {
    const absolute = path.join(pluginRoot, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return false;
    if (roots.some((root) => relative === root || relative.startsWith(`${root}/`))) return true;
    if (!stat.isDirectory()) return false;
    if (relative !== 'skills' && await isAuthorOnlySkillDirectory(absolute)) return true;
    const entries = await fs.readdir(absolute);
    if (entries.length === 0) return false;
    for (const entry of entries) {
      if (!await visit(path.posix.join(relative, entry))) return false;
    }
    return true;
  };
  return visit('skills');
}

async function validateDeclaredAssetPathsExist(pluginRoot: string, manifest: PluginManifestSource | NormalizedPluginManifest): Promise<void> {
  for (const field of ['skills', 'mcpServers'] as const) {
    const relative = manifest[field];
    if (relative && !await fs.pathExists(path.join(pluginRoot, stripDotSlash(relative)))) {
      throw new Error(`Invalid plugin manifest: ${field} points to missing ${relative}.`);
    }
  }
  for (const sourceDir of manifest.artifacts?.sourceDirs ?? []) {
    const absolute = path.join(pluginRoot, stripDotSlash(sourceDir));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid artifacts.sourceDirs: expected an ordinary directory at ${sourceDir}.`);
  }
}

async function validateSourceSkillInventory(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<void> {
  const skillsRoot = manifest.skills && path.join(pluginRoot, stripDotSlash(manifest.skills));
  const entries = skillsRoot ? await fs.readdir(skillsRoot, { withFileTypes: true }) : [];
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && !await isAuthorOnlySkillDirectory(path.join(skillsRoot!, entry.name))) keys.add(entry.name);
  }
  for (const selector of ['skillRuntimeFiles', 'generatedSkillRuntimeFiles'] as const) {
    for (const entry of manifest.buildConfig?.[selector] ?? []) {
      if (!keys.has(entry.skill)) throw new Error(`Invalid buildConfig.${selector}: "${entry.skill}" is not a declared static Skill key.`);
    }
  }
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function isTemplateAsset(manifest: PluginManifestSource | NormalizedPluginManifest, relativePath: string): boolean {
  const normalized = stripDotSlash(relativePath).split(path.sep).join('/');
  const include = manifest.buildConfig?.templates?.include ?? [];
  return include.length > 0 && applyFileRules([normalized], include, []).length > 0;
}

async function validateSourceJsonNativeAsset(
  pluginRoot: string,
  manifest: PluginManifestSource | NormalizedPluginManifest,
  field: 'mcpServers',
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
  }
}

export async function validateSourcePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
  options: Pick<ValidatePluginManifestOptions, 'reservedImports'> = {},
): Promise<NormalizedPluginManifest> {
  await assertPluginInputTree(pluginRoot);
  const manifest = validatePluginManifest(pluginRoot, rawManifest, {
    reservedImports: options.reservedImports,
  });
  const parsedVersion = parseStrictSemVer(manifest.version, 'plugin manifest.version');
  if (parsedVersion.prerelease.length > 0 || parsedVersion.build.length > 0) {
    throw new Error(
      'Invalid plugin manifest.version: expected a stable SemVer without prerelease or build metadata.',
    );
  }
  if (manifest.artifacts?.runtimeImports?.some((runtimeImport) => runtimeImport.resolved !== undefined)) {
    throw new Error('Invalid plugin manifest: artifact runtime import resolved metadata is build-owned.');
  }
  await validateDeclaredNativeAssets(pluginRoot, manifest);
  await validateDeclaredAssetPathsExist(pluginRoot, manifest);
  await validateManagedCommandSources(pluginRoot, manifest);
  validateNativeToolsManifest(manifest, { source: true });
  await loadPluginNativeToolClosure(pluginRoot, manifest);
  await Promise.all([
    validateSourceJsonNativeAsset(pluginRoot, manifest, 'mcpServers'),
    validateSourceSkillInventory(pluginRoot, manifest),
    ...(manifest.buildConfig?.runtimeExports ?? []).map((entry) =>
      validateRuntimeExportSource({
        pluginRoot,
        name: entry.name,
        source: entry.source,
      })),
  ]);
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
    : validatePluginManifest(pluginRoot, rawManifest, { reservedImports: options.reservedImports });
  if (mode === 'bundle') {
    await validateManagedCommandSources(pluginRoot, manifest);
    const nativeTools = await loadPluginNativeToolClosure(pluginRoot, manifest);
    if (nativeTools) await validateNativeToolClosureFiles(pluginRoot, nativeTools);
  }
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
    policy: {
      ...plugin.manifest.marketplace.policy,
      products: [...resolveSupportedNativePlatforms(plugin.manifest)].map((platform) => PLATFORM_PRODUCT_BY_NAME[platform]).filter((value): value is string => value !== undefined).sort(),
    },
  };
}

export function createMarketplaceManifest(
  sourceMeta: MarketplaceSourceMeta,
  plugins: PluginMeta[],
  platform?: PlatformName,
): MarketplaceManifest {
  return {
    name: 'aw',
    owner: sourceMeta.owner,
    interface: sourceMeta.interface,
    plugins: plugins.filter((plugin) => platform === undefined
      ? resolveSupportedNativePlatforms(plugin.manifest).size > 0
      : supportsPlatform(plugin.manifest, platform))
      .map((plugin) => createMarketplaceManifestEntry(plugin)),
  };
}

export function normalizeManifestDigestInput(
  value: PluginManifestSource | NormalizedPluginManifest | CatalogManifestEntry,
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
  assertAllowedKeys(input, fieldName, [
    'name',
    'version',
    'description',
    'interface',
    'category',
    'tags',
    'strict',
    'policy',
    'dependencies',
    'requires',
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
    dependencies: input.dependencies === undefined
      ? []
      : normalizeComparableStringArray(ensureStringArray(input.dependencies, `${fieldName}.dependencies`))!
        .map((dependency, index) => ensurePluginName(dependency, `${fieldName}.dependencies[${index}]`)),
    requires: normalizePluginRequirements(input.requires, `${fieldName}.requires`, {
      allowMissing: false,
    })!,
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
  requires: PluginRequirements;
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
  const requires = normalizePluginRequirements(
    input.requires,
    `${fieldName}.requires`,
    { allowMissing: false },
  )!;
  return { catalogVersion, channel, requires };
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
  }
  return entries;
}

export function createBundleSourceManifest(
  plugin: PluginMeta,
  requiredCapabilities?: readonly string[],
): NormalizedPluginManifest {
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
    requires: requiredCapabilities === undefined
      ? structuredClone(plugin.manifest.requires)
      : { aw: { capabilities: normalizeAwCapabilities(requiredCapabilities) } },
    extensions: plugin.manifest.extensions
      ? {
          instructions: plugin.manifest.extensions.instructions
            ?.map((entry) => structuredClone(entry)),
          permissions: plugin.manifest.extensions.permissions
            ?.map((entry) => structuredClone(entry)),
          hooks: plugin.manifest.extensions.hooks
            ?.map((entry) => structuredClone(entry)),
          nativeHooks: plugin.manifest.extensions.nativeHooks ? structuredClone(plugin.manifest.extensions.nativeHooks) : undefined,
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
    interface: plugin.manifest.interface,
  };
}

function platformBundlePath(value: string, platform: PlatformName): string {
  return `./${platform}/${stripDotSlash(value)}`;
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
  const canonicalExpected = JSON.parse(JSON.stringify(expected)) as PlatformPluginManifest;
  if (!isDeepStrictEqual(rawManifest, canonicalExpected)) {
    throw new Error(`Invalid ${platform} platform manifest projection.`);
  }
  await Promise.all([...new Set(projectedPaths)].map((relativePath) =>
    assertPlatformProjectionPath(plugin, relativePath)));
  return canonicalExpected;
}
