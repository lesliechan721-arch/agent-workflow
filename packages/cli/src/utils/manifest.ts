import path from 'node:path';

import fs from 'fs-extra';

import type {
  AgentDefinition,
  ArtifactState,
  ArtifactTarget,
  BuildConfig,
  BuildConfigFileRuleSet,
  BuildConfigTemplates,
  ClaudeManifestOverrides,
  CodexProjectManagedKind,
  DynamicArtifactKind,
  HookDefinition,
  InstructionDefinition,
  MarketplaceManifest,
  MarketplaceSourceMeta,
  NativeHookDefinition,
  PermissionDefinition,
  PlatformAgentOverrides,
  PlatformName,
  PlatformPluginManifest,
  PluginConfigSchema,
  PluginArtifactRenderScriptEntry,
  PluginArtifactsConfig,
  PluginDependenciesConfig,
  PluginDependencyEntry,
  PluginArtifactTargetDefinition,
  PluginInterfaceMeta,
  PluginLifecycleScriptEntry,
  PluginLifecycleScriptSelector,
  PluginLifecycleRuntimeOs,
  PluginNodeBuildScript,
  PluginNodeScriptsConfig,
  PluginManifestSource,
  PluginMarketplaceMeta,
  PluginMeta,
  PluginScriptsConfig,
  SkillTriggerPolicy,
  TemplateVarByPlatform,
} from '../types.js';
import { readJsonFile } from './json.js';
import { parsePermissionCommand } from '../generators/permissions.js';
import { applyFileRules } from './file-rules.js';
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
import {
  formatMarketplaceProductsForError,
  normalizeMarketplaceProductToken,
  resolveSupportedPlatforms,
  supportsPlatform,
} from './platform-support.js';

export const SOURCE_MANIFEST_PATH = path.join('.agents-plugin', 'plugin.json');
export const MARKETPLACE_SOURCE_PATH = path.join('plugins', 'marketplace-source.json');
const MANIFEST_POLICY_PRODUCTS = new Set(['CODEX', 'CLAUDE']);
const PLUGIN_DEPENDENCY_PLATFORMS = new Set<PlatformName>(['codex', 'claude']);
const NODE_RUNNABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PLATFORM_PRODUCT_BY_NAME: Record<PlatformName, string> = {
  claude: 'CLAUDE',
  codex: 'CODEX',
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    assertPlatformFieldSupported({
      pluginName,
      manifest,
      fieldPath: `artifacts.targets[${index}].platform`,
      requiredPlatform: target.platform,
    });
  });
}

function ensurePluginName(value: unknown, fieldName: string): string {
  const name = ensureString(value, fieldName);
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${fieldName}: expected lowercase hyphen-case.`);
  }
  return name;
}

export function normalizePluginRelativePath(
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

  return {
    installation: ensureString(input.installation, `${fieldName}.installation`),
    authentication: ensureString(input.authentication, `${fieldName}.authentication`),
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

function normalizePluginDependencyPlatforms(
  value: unknown,
  fieldName: string,
): PlatformName[] {
  const platforms = ensureStringArray(value, fieldName);
  if (platforms.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected at least one platform.`);
  }

  const normalized: PlatformName[] = [];
  for (const [index, platform] of platforms.entries()) {
    if (!PLUGIN_DEPENDENCY_PLATFORMS.has(platform as PlatformName)) {
      throw new Error(`Invalid ${fieldName}[${index}]: expected "codex" or "claude".`);
    }
    if (normalized.includes(platform as PlatformName)) {
      throw new Error(`Invalid ${fieldName}[${index}]: duplicate platform "${platform}".`);
    }
    normalized.push(platform as PlatformName);
  }

  return normalized;
}

function normalizePluginDependencyEntry(
  pluginName: string,
  value: unknown,
  fieldName: string,
): PluginDependencyEntry {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'target', 'inheritInstallOptions', 'when']);

  const dependencyName = ensurePluginName(input.name, `${fieldName}.name`);
  if (dependencyName === pluginName) {
    throw new Error(`Invalid ${fieldName}.name: plugin "${pluginName}" cannot depend on itself.`);
  }

  const entry: PluginDependencyEntry = {
    name: dependencyName,
  };

  if (input.target !== undefined) {
    const target = assertObject(input.target, `${fieldName}.target`);
    assertAllowedKeys(target, `${fieldName}.target`, ['scope']);

    const scope = ensureString(target.scope, `${fieldName}.target.scope`);
    if (scope !== 'user' && scope !== 'project') {
      throw new Error(`Invalid ${fieldName}.target.scope: expected "user" or "project".`);
    }

    entry.target = { scope };
  }

  if (input.inheritInstallOptions !== undefined) {
    if (typeof input.inheritInstallOptions !== 'boolean') {
      throw new Error(`Invalid ${fieldName}.inheritInstallOptions: expected a boolean.`);
    }
    entry.inheritInstallOptions = input.inheritInstallOptions;
  }

  if (input.when !== undefined) {
    const when = assertObject(input.when, `${fieldName}.when`);
    assertAllowedKeys(when, `${fieldName}.when`, ['platforms']);
    entry.when = {
      platforms: normalizePluginDependencyPlatforms(when.platforms, `${fieldName}.when.platforms`),
    };
  }

  return entry;
}

function normalizedDependencyPlatforms(entry: PluginDependencyEntry): PlatformName[] {
  return entry.when?.platforms ? [...entry.when.platforms] : ['codex', 'claude'];
}

function validateOverlappingPluginDependencies(
  entries: PluginDependencyEntry[],
  fieldName: string,
): void {
  const seenByPlugin = new Map<string, Map<PlatformName, number>>();

  for (const [index, entry] of entries.entries()) {
    const seenPlatforms = seenByPlugin.get(entry.name) ?? new Map<PlatformName, number>();
    for (const platform of normalizedDependencyPlatforms(entry)) {
      const existingIndex = seenPlatforms.get(platform);
      if (existingIndex !== undefined) {
        throw new Error(
          `Invalid ${fieldName}[${index}].when.platforms: overlaps with ${fieldName}[${existingIndex}] for plugin "${entry.name}" on platform "${platform}".`,
        );
      }
      seenPlatforms.set(platform, index);
    }
    seenByPlugin.set(entry.name, seenPlatforms);
  }
}

function normalizePluginDependencies(
  pluginName: string,
  value: unknown,
  fieldName: string,
): PluginDependenciesConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['plugins']);

  if (!Array.isArray(input.plugins)) {
    throw new Error(`Invalid ${fieldName}.plugins: expected an array.`);
  }

  const plugins = input.plugins.map((entry, index) =>
    normalizePluginDependencyEntry(pluginName, entry, `${fieldName}.plugins[${index}]`),
  );
  validateOverlappingPluginDependencies(plugins, `${fieldName}.plugins`);

  return { plugins };
}

function normalizeSkillTriggerPolicies(
  value: unknown,
  fieldName: string,
): Record<string, SkillTriggerPolicy> {
  const input = assertObject(value, fieldName);
  const policies: Record<string, SkillTriggerPolicy> = {};

  for (const [skillName, entry] of Object.entries(input)) {
    const policyFieldName = `${fieldName}.${skillName}`;
    const policy = assertObject(entry, policyFieldName);
    assertAllowedKeys(policy, policyFieldName, ['allowInstallOverride']);

    if (typeof policy.allowInstallOverride !== 'boolean') {
      throw new Error(`Invalid ${policyFieldName}.allowInstallOverride: expected a boolean.`);
    }

    policies[skillName] = {
      allowInstallOverride: policy.allowInstallOverride,
    };
  }

  return policies;
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

function normalizeBuildConfig(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): BuildConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['templates', 'fileRules', 'manifestOverrides']);

  const buildConfig: BuildConfig = {};

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

function normalizePluginConfigSchema(value: unknown, fieldName: string): PluginConfigSchema {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['schema']);

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

  return { schema };
}

const ARTIFACT_TARGETS = new Set<ArtifactTarget>([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
]);

const ARTIFACT_STATES = new Set<ArtifactState>(['present', 'disabled']);
const DYNAMIC_ARTIFACT_KINDS = new Set<DynamicArtifactKind>(['instruction', 'codexRole']);
const ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET: Record<ArtifactTarget, CodexProjectManagedKind> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'agent',
};
const ARTIFACT_KIND_BY_TARGET: Record<ArtifactTarget, DynamicArtifactKind> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'codexRole',
};

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

function normalizeArtifactTargetEntry(
  entry: unknown,
  fieldName: string,
  schema: PluginConfigSchema | undefined,
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
  ]);

  const id = ensureString(input.id, `${fieldName}.id`);
  validateArtifactId(id, `${fieldName}.id`);

  const platform = normalizePlatformName(input.platform, `${fieldName}.platform`);
  const target = normalizeArtifactTarget(input.target, `${fieldName}.target`);
  if (platform !== 'codex') {
    throw new Error(`Invalid ${fieldName}.platform: target "${target}" is only supported on "codex".`);
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
      `Invalid ${fieldName}.projectManagedKind: target "${target}" must map to "${expectedProjectManagedKind}".`,
    );
  }

  const roleKey =
    input.roleKey === undefined
      ? undefined
      : ensureString(input.roleKey, `${fieldName}.roleKey`);
  if (target === 'codex.agentRole') {
    if (!roleKey) {
      throw new Error(`Invalid ${fieldName}.roleKey: codex.agentRole targets must declare a static roleKey.`);
    }
    validateCodexRoleKey(roleKey, `${fieldName}.roleKey`);
  } else if (roleKey !== undefined) {
    throw new Error(`Invalid ${fieldName}.roleKey: roleKey is only supported for codex.agentRole targets.`);
  }

  return {
    id,
    platform,
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
  };
}

function normalizeArtifacts(
  value: unknown,
  fieldName: string,
  schema: PluginConfigSchema | undefined,
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
        return targetsInput.map((entry, index) => {
          const target = normalizeArtifactTargetEntry(entry, `${fieldName}.targets[${index}]`, schema);
          const key = `${target.id}:${target.target}`;
          if (seen.has(key)) {
            throw new Error(`Invalid ${fieldName}.targets[${index}]: duplicate artifact id + target "${key}".`);
          }
          seen.add(key);
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
): NonNullable<PluginManifestSource['extensions']>['nativeHooks'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const output: NonNullable<PluginManifestSource['extensions']>['nativeHooks'] = {};
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
  extensions: NonNullable<PluginManifestSource['extensions']>,
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
): PluginManifestSource['extensions'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['instructions', 'permissions', 'hooks', 'nativeHooks', 'agents']);

  const extensions: NonNullable<PluginManifestSource['extensions']> = {
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
  assertAllowedKeys(input, 'marketplace source metadata', ['owner', 'interface']);

  const ownerInput = assertObject(input.owner, 'marketplace source metadata.owner');
  assertAllowedKeys(ownerInput, 'marketplace source metadata.owner', ['name', 'url']);
  const interfaceInput = assertObject(input.interface, 'marketplace source metadata.interface');
  assertAllowedKeys(interfaceInput, 'marketplace source metadata.interface', ['displayName']);

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
  };
}

export async function readMarketplaceSourceMeta(repoRoot: string): Promise<MarketplaceSourceMeta> {
  const sourcePath = path.join(repoRoot, MARKETPLACE_SOURCE_PATH);
  const rawValue = await readJsonFile<unknown>(sourcePath);
  return validateMarketplaceSourceMeta(rawValue);
}

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
): PluginManifestSource {
  const input = assertObject(rawManifest, 'plugin manifest');
  if (Object.hasOwn(input, 'commands')) {
    throw new Error(
      'Invalid plugin manifest: top-level "commands" has been removed; use "slashCommands" instead.',
    );
  }
  assertAllowedKeys(input, 'plugin manifest', [
    'name',
    'version',
    'description',
    'skills',
    'slashCommands',
    'skillTriggers',
    'mcpServers',
    'apps',
    'marketplace',
    'interface',
    'dependencies',
    'extensions',
    'artifacts',
    'buildConfig',
    'scripts',
    'config',
  ]);

  const manifest: PluginManifestSource = {
    name: ensureString(input.name, 'name'),
    version: ensureString(input.version, 'version'),
    description: ensureString(input.description, 'description'),
    marketplace: normalizeMarketplaceMeta(input.marketplace, 'marketplace'),
  };

  if (input.skills !== undefined) {
    manifest.skills = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.skills, 'skills'),
      'skills',
    );
  }

  if (input.slashCommands !== undefined) {
    manifest.slashCommands = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.slashCommands, 'slashCommands'),
      'slashCommands',
    );
  }

  if (input.skillTriggers !== undefined) {
    if (manifest.skills === undefined) {
      throw new Error('Invalid plugin manifest: "skillTriggers" requires a declared "skills" directory.');
    }

    manifest.skillTriggers = normalizeSkillTriggerPolicies(input.skillTriggers, 'skillTriggers');
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

  if (input.interface !== undefined) {
    manifest.interface = normalizePluginInterface(input.interface, 'interface');
  }

  if (input.dependencies !== undefined) {
    manifest.dependencies = normalizePluginDependencies(
      manifest.name,
      input.dependencies,
      'dependencies',
    );
  }

  if (input.extensions !== undefined) {
    manifest.extensions = normalizeExtensions(input.extensions, 'extensions');
  }

  if (input.buildConfig !== undefined) {
    manifest.buildConfig = normalizeBuildConfig(pluginRoot, input.buildConfig, 'buildConfig');
  }

  if (input.scripts !== undefined) {
    manifest.scripts = normalizePluginScripts(pluginRoot, input.scripts, 'scripts');
  }

  if (input.config !== undefined) {
    manifest.config = normalizePluginConfigSchema(input.config, 'config');
  }

  if (input.artifacts !== undefined) {
    manifest.artifacts = normalizeArtifacts(input.artifacts, 'artifacts', manifest.config);
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
}

async function validateSourceSkillTriggerPolicies(
  pluginRoot: string,
  manifest: PluginManifestSource,
): Promise<void> {
  if (!manifest.skills || !manifest.skillTriggers || Object.keys(manifest.skillTriggers).length === 0) {
    return;
  }

  const skillsRoot = path.join(pluginRoot, stripDotSlash(manifest.skills));
  for (const skillName of Object.keys(manifest.skillTriggers)) {
    const skillDir = path.join(skillsRoot, skillName);
    const stats = await fs.stat(skillDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(
        `Invalid skillTriggers.${skillName}: expected a skill directory at "${path.relative(pluginRoot, skillDir).split(path.sep).join('/')}".`,
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
): Promise<PluginManifestSource> {
  const manifest = validatePluginManifest(pluginRoot, rawManifest);
  await validateDeclaredNativeAssets(pluginRoot, manifest);
  await validateDeclaredAssetPathsExist(pluginRoot, manifest);
  await Promise.all([
    validateSourceJsonNativeAsset(pluginRoot, manifest, 'mcpServers'),
    validateSourceJsonNativeAsset(pluginRoot, manifest, 'apps'),
    validateSourceSkillTriggerPolicies(pluginRoot, manifest),
    resolveSlashCommands(pluginRoot, manifest, {
      targetPlatforms: resolveSupportedPlatforms(manifest),
    }),
  ]);
  return manifest;
}

export interface ReadPluginManifestOptions {
  mode?: 'source' | 'bundle';
}

export async function readPluginManifest(
  pluginRoot: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta> {
  const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
  const rawManifest = await readJsonFile<unknown>(manifestPath);
  const mode = options.mode ?? 'source';
  const manifest = mode === 'source'
    ? await validateSourcePluginManifest(pluginRoot, rawManifest)
    : validatePluginManifest(pluginRoot, rawManifest);
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

export async function discoverPlugins(repoRoot: string): Promise<PluginMeta[]> {
  return discoverPluginsInDirectory(path.join(repoRoot, 'plugins'));
}

export function validatePluginDependencyReferences(
  plugins: readonly PluginMeta[],
): void {
  const pluginNames = new Set(plugins.map((plugin) => plugin.manifest.name));

  for (const plugin of plugins) {
    for (const [index, dependency] of (plugin.manifest.dependencies?.plugins ?? []).entries()) {
      if (!pluginNames.has(dependency.name)) {
        throw new Error(
          `Invalid dependencies.plugins[${index}].name for plugin "${plugin.manifest.name}": current catalog is missing plugin "${dependency.name}".`,
        );
      }
    }
  }
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
): Promise<PluginMeta[]> {
  const plugins = await discoverPlugins(repoRoot);
  return selectPlugins(plugins, pluginNames);
}

export async function resolvePluginsFromCatalog(
  catalogRoot: string,
  pluginNames?: string[],
): Promise<PluginMeta[]> {
  const plugins = await discoverPluginsInDirectory(
    path.join(catalogRoot, 'plugins'),
    { mode: 'bundle' },
  );
  validatePluginDependencyReferences(plugins);
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

export function createBundleSourceManifest(plugin: PluginMeta): PluginManifestSource {
  const scripts = plugin.manifest.scripts
    ? structuredClone(plugin.manifest.scripts)
    : undefined;
  if (scripts?.tests) {
    delete scripts.tests;
  }
  if (scripts?.node?.build) {
    delete scripts.node.build;
  }

  return {
    ...plugin.manifest,
    dependencies: plugin.manifest.dependencies
      ? structuredClone(plugin.manifest.dependencies)
      : undefined,
    skillTriggers: plugin.manifest.skillTriggers
      ? structuredClone(plugin.manifest.skillTriggers)
      : undefined,
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
    interface: plugin.manifest.interface,
  };
}
