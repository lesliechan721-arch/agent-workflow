import chalk from 'chalk';

import { CommandWarningError, isCommandWarningError } from '../types.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type {
  AgentDefinition,
  CommandAction,
  EnvironmentDetection,
  HookDefinition,
  InstallCommandOptions,
  InstalledLedger,
  InstalledScopeRecord,
  InstructionDefinition,
  PlatformAdapter,
  PlatformName,
  PlatformSelection,
  PluginMeta,
  PermissionDefinition,
  PluginStatusReport,
  ResolvedInstallOptions,
  Scope,
  StatusReport,
  UpgradeCommandOptions,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
} from '../utils/local-marketplace.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import { getTrackingRecord, readTrackingManifest } from '../utils/tracking.js';
import {
  resolveEmbeddedPluginsRoot,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../utils/paths.js';
import { resolveCatalogPlugins } from '../utils/plugin-catalog.js';

export function createAdapters(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<PlatformName, PlatformAdapter> {
  return {
    codex: new CodexAdapter(cwd, env),
    claude: new ClaudeAdapter(cwd, undefined, env),
  };
}

export interface ResolvedPluginTarget {
  pluginName: string;
  plugin: PluginMeta;
  currentPlugin?: PluginMeta;
  embeddedPlugin?: PluginMeta;
  source: 'currentCatalog' | 'historical';
}

export interface PreparedPluginCommandContext {
  ledger: InstalledLedger;
  targets: ResolvedPluginTarget[];
  warnings: string[];
}

type HistoricalExtensionKind = 'instruction' | 'permission' | 'hook' | 'agent';
type HistoricalExtensionKindsByPlatform = Record<PlatformName, Set<HistoricalExtensionKind>>;

const PLATFORM_PRODUCT_BY_NAME: Record<PlatformName, string> = {
  codex: 'CODEX',
  claude: 'CLAUDE',
};

const PLATFORM_DISPLAY_BY_NAME: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function normalizeProductToken(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function formatPolicyProducts(plugin: PluginMeta): string {
  const products = plugin.manifest.marketplace.policy.products;
  return products && products.length > 0 ? products.join(', ') : '未限制';
}

export function pluginSupportsPlatform(plugin: PluginMeta, platform: PlatformName): boolean {
  const products = plugin.manifest.marketplace.policy.products;
  if (!products || products.length === 0) {
    return true;
  }

  const normalizedProducts = new Set(products.map((product) => normalizeProductToken(product)));
  return normalizedProducts.has(PLATFORM_PRODUCT_BY_NAME[platform]);
}

export function assertPluginsSupportPlatforms(
  plugins: PluginMeta[],
  platforms: PlatformName[],
): void {
  const unsupported = plugins.flatMap((plugin) =>
    platforms
      .filter((platform) => !pluginSupportsPlatform(plugin, platform))
      .map((platform) => ({
        plugin,
        platform,
      })),
  );

  if (unsupported.length === 0) {
    return;
  }

  const details = unsupported
    .map(({ plugin, platform }) =>
      `${plugin.manifest.name} -> ${PLATFORM_DISPLAY_BY_NAME[platform]} (marketplace.policy.products=[${formatPolicyProducts(plugin)}], 需要 ${PLATFORM_PRODUCT_BY_NAME[platform]})`,
    )
    .join('；');
  throw new Error(`插件不支持目标平台：${details}`);
}

function createHistoricalExtensionKinds(
  kindsByPlatform: HistoricalExtensionKindsByPlatform,
): PluginMeta['manifest']['extensions'] | undefined {
  const hasKind = (kind: HistoricalExtensionKind): boolean =>
    kindsByPlatform.claude.has(kind) || kindsByPlatform.codex.has(kind);
  const platformOverrides = (kind: HistoricalExtensionKind) => ({
    claude: kindsByPlatform.claude.has(kind) ? undefined : null,
    codex: kindsByPlatform.codex.has(kind) ? undefined : null,
  });

  if (!Object.values(kindsByPlatform).some((kinds) => kinds.size > 0)) {
    return undefined;
  }

  return {
    instructions: hasKind('instruction')
      ? [{
          name: 'historical-instruction',
          title: 'Historical Instruction',
          content: 'Historical managed instruction placeholder.',
          agentOverrides: platformOverrides('instruction') as InstructionDefinition['agentOverrides'],
        }]
      : undefined,
    permissions: hasKind('permission')
      ? [{
          name: 'historical-permission',
          allow: [],
          ask: [],
          deny: [],
          agentOverrides: platformOverrides('permission') as PermissionDefinition['agentOverrides'],
        }]
      : undefined,
    hooks: hasKind('hook')
      ? [{
          event: 'session_start',
          command: 'true',
          agentOverrides: platformOverrides('hook') as HookDefinition['agentOverrides'],
        }]
      : undefined,
    agents: hasKind('agent')
      ? [{
          name: 'historical-agent',
          description: 'Historical agent placeholder.',
          prompt: 'Historical agent placeholder.',
          tools: [],
          agentOverrides: platformOverrides('agent') as AgentDefinition['agentOverrides'],
        }]
      : undefined,
  };
}

async function createHistoricalPluginMeta(
  cwd: string,
  scope: Scope,
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginMeta> {
  const ledger = await readInstalledLedger(env);
  const pluginRecord = ledger.plugins[pluginName];
  const [claudeProjectKey, codexProjectKey] = await Promise.all([
    resolveClaudeProjectKey(cwd),
    resolveCodexProjectKey(cwd),
  ]);

  const trackedKindsByPlatform: HistoricalExtensionKindsByPlatform = {
    claude: new Set(),
    codex: new Set(),
  };
  const [claudeTracking, codexTracking] = await Promise.all([
    readTrackingManifest(resolveClaudePaths(cwd, scope, env).trackingDir),
    readTrackingManifest(resolveCodexPaths(cwd, scope, env).trackingDir),
  ]);

  for (const manifest of [claudeTracking, codexTracking]) {
    const record = getTrackingRecord(manifest, pluginName);
    for (const artifact of record?.artifacts ?? []) {
      trackedKindsByPlatform[artifact.platform].add(artifact.kind);
    }
  }

  const claudeScopeRecord =
    scope === 'user'
      ? pluginRecord?.platforms.claude?.userScope
      : pluginRecord?.platforms.claude?.projectScopes?.[claudeProjectKey];
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('instructions')) {
    trackedKindsByPlatform.claude.add('instruction');
  }
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('permissions')) {
    trackedKindsByPlatform.claude.add('permission');
  }
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('hooks')) {
    trackedKindsByPlatform.claude.add('hook');
  }

  const codexScopeRecord =
    scope === 'user'
      ? pluginRecord?.platforms.codex?.userScope
      : pluginRecord?.platforms.codex?.projectScopes?.[codexProjectKey];

  return {
    rootDir: '',
    manifestPath: '',
    manifest: {
      name: pluginName,
      version: pluginRecord?.lastResolvedVersion ?? '0.0.0',
      description: 'Historical managed plugin placeholder.',
      skills: codexScopeRecord?.capabilitySnapshot.requiresNativePlugin ? './historical-skills' : undefined,
      marketplace: {
        category: 'historical',
        strict: true,
        policy: {
          installation: 'HISTORICAL',
          authentication: 'NONE',
        },
      },
      extensions: createHistoricalExtensionKinds(trackedKindsByPlatform),
    },
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

export function wrapCommandErrorWithWarnings(error: unknown, warnings: string[]): Error {
  const normalizedError = normalizeError(error);
  if (warnings.length === 0) {
    return normalizedError;
  }

  if (isCommandWarningError(normalizedError)) {
    return new CommandWarningError(normalizedError.message, {
      warnings: [...warnings, ...normalizedError.warnings],
      exitCode: normalizedError.exitCode,
    });
  }

  return new CommandWarningError(normalizedError.message, {
    warnings,
  });
}

async function resolveScopeKeys(
  cwd: string,
  scope: Scope,
): Promise<Record<PlatformName, string | undefined>> {
  if (scope === 'user') {
    return {
      codex: undefined,
      claude: undefined,
    };
  }

  const [claudeProjectKey, codexProjectKey] = await Promise.all([
    resolveClaudeProjectKey(cwd),
    resolveCodexProjectKey(cwd),
  ]);

  return {
    codex: codexProjectKey,
    claude: claudeProjectKey,
  };
}

function getScopeIdentity(
  platform: PlatformName,
  scope: Scope,
  scopeKeys: Record<PlatformName, string | undefined>,
): string {
  if (scope === 'user') {
    return 'user';
  }

  const scopeKey = scopeKeys[platform];
  if (!scopeKey) {
    throw new Error(`无法解析 ${platform} 的 project scope key。`);
  }

  return `project:${scopeKey}`;
}

function getInstalledScopeRecordForTarget(
  ledger: InstalledLedger,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  scopeKeys: Record<PlatformName, string | undefined>,
): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  const scopeKey = scopeKeys[platform];
  return scopeKey
    ? platformRecord.projectScopes?.[scopeKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

export function createResolvedInstallOptionsKey(
  platform: PlatformName,
  pluginName: string,
  scopeIdentity: string,
): string {
  return `${platform}:${pluginName}:${scopeIdentity}`;
}

function resolveLedgerBackedPreference(
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
): Pick<ResolvedInstallOptions, 'skillTriggerPreference' | 'skillTriggerSource'> {
  const ledgerPreference = scopeRecord?.installOptions?.skillTriggerPreference;
  return ledgerPreference
    ? {
        skillTriggerPreference: ledgerPreference,
        skillTriggerSource: 'ledger',
      }
    : {
        skillTriggerPreference: 'default',
        skillTriggerSource: 'default',
      };
}

export async function preparePluginTargetsForCommand(
  cwd: string,
  scope: Scope,
  pluginNames: string[] | undefined,
  options: {
    ensureLocalMarketplace?: boolean;
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<PreparedPluginCommandContext> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  if (options.ensureLocalMarketplace) {
    const ensured = await ensureLocalMarketplace(env);
    warnings.push(...(ensured.warnings ?? []));
  }

  const [ledger, targets] = await Promise.all([
    readInstalledLedger(env),
    loadPluginTargetsForCommand(cwd, scope, pluginNames, {
      allowHistoricalFallback: options.allowHistoricalFallback,
      env,
    }),
  ]);

  return {
    ledger,
    targets,
    warnings: dedupeWarnings(warnings),
  };
}

export async function prepareCommandEnvironment(
  options: {
    ensureLocalMarketplace?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Pick<PreparedPluginCommandContext, 'ledger' | 'warnings'>> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  if (options.ensureLocalMarketplace) {
    const ensured = await ensureLocalMarketplace(env);
    warnings.push(...(ensured.warnings ?? []));
  }

  return {
    ledger: await readInstalledLedger(env),
    warnings: dedupeWarnings(warnings),
  };
}

export async function listManagedPluginNamesForPreparedLedger(
  platform: PlatformName,
  scope: Scope,
  cwd: string,
  ledger: InstalledLedger,
): Promise<string[]> {
  const scopeKeys = await resolveScopeKeys(cwd, scope);
  return Object.keys(ledger.plugins)
    .filter((pluginName) =>
      getInstalledScopeRecordForTarget(ledger, pluginName, platform, scope, scopeKeys)?.managed === true,
    )
    .sort();
}

export async function resolveInstallOptionsForTargets(
  mode: 'install' | 'upgrade' | 'upgrade-all',
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: Pick<InstallCommandOptions | UpgradeCommandOptions, 'cwd' | 'scope' | 'requestedSkillTrigger'>,
  ledger: InstalledLedger,
): Promise<Map<string, ResolvedInstallOptions>> {
  const scopeKeys = await resolveScopeKeys(options.cwd, options.scope);
  const resolved = new Map<string, ResolvedInstallOptions>();
  const requestedPreference = options.requestedSkillTrigger;
  const ledgerTrust: ResolvedInstallOptions['ledgerTrust'] =
    ledger.ledgerState.status === 'available' ? 'available' : 'degraded';

  for (const platform of platforms) {
    const scopeIdentity = getScopeIdentity(platform, options.scope, scopeKeys);

    for (const target of targets) {
      const scopeRecord = getInstalledScopeRecordForTarget(
        ledger,
        target.pluginName,
        platform,
        options.scope,
        scopeKeys,
      );
      const isManagedTarget = scopeRecord?.managed === true;

      let nextOptions: ResolvedInstallOptions;
      if (requestedPreference) {
        nextOptions = {
          skillTriggerPreference: requestedPreference,
          skillTriggerSource: 'cli',
          ledgerTrust,
        };
      } else if (mode === 'install') {
        if (ledger.ledgerState.status === 'available') {
          nextOptions = {
            ...resolveLedgerBackedPreference(scopeRecord),
            ledgerTrust,
          };
        } else if (isManagedTarget) {
          throw new CommandWarningError(
            `${target.pluginName} 在 ${platform} (${options.scope}) 已受管；installed.json 处于 degraded 状态时不能隐式继承旧的 skill trigger 偏好，请显式传入 \`--skill-trigger default|manual|auto\`。`,
          );
        } else {
          nextOptions = {
            skillTriggerPreference: 'default',
            skillTriggerSource: 'default',
            ledgerTrust,
          };
        }
      } else {
        if (ledger.ledgerState.status === 'available') {
          nextOptions = {
            ...resolveLedgerBackedPreference(scopeRecord),
            ledgerTrust,
          };
        } else {
          throw new CommandWarningError(
            `${target.pluginName} 在 ${platform} (${options.scope}) 的 skill trigger 偏好无法从 degraded installed.json 安全恢复，请显式传入 \`--skill-trigger default|manual|auto\`。`,
          );
        }
      }

      resolved.set(
        createResolvedInstallOptionsKey(platform, target.pluginName, scopeIdentity),
        nextOptions,
      );
    }
  }

  return resolved;
}

export async function createResolvedInstallOptionsResolver(
  resolvedOptionsByKey: Map<string, ResolvedInstallOptions>,
  cwd: string,
  scope: Scope,
): Promise<(platform: PlatformName, target: ResolvedPluginTarget) => ResolvedInstallOptions> {
  const scopeKeys = await resolveScopeKeys(cwd, scope);

  return (platform: PlatformName, target: ResolvedPluginTarget): ResolvedInstallOptions => {
    const scopeIdentity = getScopeIdentity(platform, scope, scopeKeys);
    const resolved = resolvedOptionsByKey.get(
      createResolvedInstallOptionsKey(platform, target.pluginName, scopeIdentity),
    );
    if (!resolved) {
      throw new Error(
        `缺少 ${platform}/${target.pluginName} (${scopeIdentity}) 的 resolved install options。`,
      );
    }

    return resolved;
  };
}

export async function loadPluginTargetsForCommand(
  cwd: string,
  scope: Scope,
  pluginNames?: string[],
  options: {
    ensureLocalMarketplace?: boolean;
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ResolvedPluginTarget[]> {
  const env = options.env ?? process.env;
  if (options.ensureLocalMarketplace) {
    await ensureLocalMarketplace(env);
  }

  const [{ plugins: catalogPlugins }, embeddedRoot] = await Promise.all([
    resolveCatalogPlugins(undefined, env),
    resolveEmbeddedPluginsRoot(),
  ]);
  const embeddedPlugins = await resolvePluginsFromCatalog(embeddedRoot, undefined);
  if (!pluginNames || pluginNames.length === 0) {
    if (catalogPlugins.length === 0) {
      throw new Error('没有发现可用插件。');
    }

    const embeddedPluginMap = new Map(
      embeddedPlugins.map((plugin) => [plugin.manifest.name, plugin]),
    );
    return catalogPlugins.map((plugin) => ({
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: embeddedPluginMap.get(plugin.manifest.name),
      source: 'currentCatalog' as const,
    }));
  }

  const catalogMap = new Map(catalogPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const embeddedPluginMap = new Map(
    embeddedPlugins.map((plugin) => [plugin.manifest.name, plugin]),
  );
  const targets: ResolvedPluginTarget[] = [];
  for (const pluginName of pluginNames) {
    const currentPlugin = catalogMap.get(pluginName);
    if (currentPlugin) {
      targets.push({
        pluginName,
        plugin: currentPlugin,
        currentPlugin,
        embeddedPlugin: embeddedPluginMap.get(pluginName),
        source: 'currentCatalog',
      });
      continue;
    }

    if (!options.allowHistoricalFallback) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }

    targets.push({
      pluginName,
      plugin: await createHistoricalPluginMeta(cwd, scope, pluginName, env),
      currentPlugin: undefined,
      embeddedPlugin: embeddedPluginMap.get(pluginName),
      source: 'historical',
    });
  }

  return targets;
}

export function hasScopeManagedEvidence(plugin: PluginStatusReport): boolean {
  return Boolean(
    plugin.scopeManagedEvidence?.ledger ||
      plugin.scopeManagedEvidence?.tracking ||
      plugin.scopeManagedEvidence?.sharedNativeRef,
  );
}

export function hasHistoricalEvidence(plugin: PluginStatusReport): boolean {
  return (
    hasScopeManagedEvidence(plugin) ||
    plugin.platformRuntimeEvidence?.present === true ||
    plugin.platformNativeFallbackEvidence?.present === true ||
    plugin.externalOwnership?.present === true
  );
}

async function getAutoPlatformState(
  adapters: Record<PlatformName, PlatformAdapter>,
  plugins: PluginMeta[],
  scope: Scope,
): Promise<Record<PlatformName, 'yes' | 'no' | 'unknown'>> {
  const states: Record<PlatformName, 'yes' | 'no' | 'unknown'> = {
    codex: 'no',
    claude: 'no',
  };

  for (const platform of ['codex', 'claude'] as const) {
    let hasYes = false;
    let hasUnknown = false;
    for (const plugin of plugins) {
      const status = await adapters[platform].status(plugin, scope);
      const pluginScopeState = status.plugins[0]?.scopeInitialized ?? status.scopeInitialized ?? 'unknown';
      if (pluginScopeState === 'unknown') {
        hasUnknown = true;
      } else if (pluginScopeState === 'yes') {
        hasYes = true;
      }
    }

    states[platform] = hasUnknown ? 'unknown' : hasYes ? 'yes' : 'no';
  }

  return states;
}

export async function resolveTargetPlatforms(
  action: CommandAction,
  requestedPlatform: PlatformSelection,
  cwd: string,
  scope: Scope,
  plugins: PluginMeta[],
  adapters: Record<PlatformName, PlatformAdapter>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformName[]> {
  const detection = await detectEnvironment(cwd, env);
  const availablePlatforms = listDetectedPlatforms(detection);
  const shouldEnforceProducts = action === 'install' || action === 'upgrade';
  const compatibleAvailablePlatforms = shouldEnforceProducts
    ? availablePlatforms.filter((platform) =>
        plugins.every((plugin) => pluginSupportsPlatform(plugin, platform)),
      )
    : availablePlatforms;

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!availablePlatforms.includes(requestedPlatform)) {
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    if (shouldEnforceProducts) {
      assertPluginsSupportPlatforms(plugins, [requestedPlatform]);
    }
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    if (availablePlatforms.length !== 2) {
      throw new Error('`--platform both` 只在同时检测到 Codex 和 Claude 时可用。');
    }
    if (shouldEnforceProducts) {
      assertPluginsSupportPlatforms(plugins, ['codex', 'claude']);
    }
    return ['codex', 'claude'];
  }

  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

  if (compatibleAvailablePlatforms.length === 0) {
    assertPluginsSupportPlatforms(plugins, availablePlatforms);
    throw new Error('当前环境没有和插件 marketplace.policy.products 匹配的可用平台。');
  }

  if (compatibleAvailablePlatforms.length === 1) {
    return compatibleAvailablePlatforms;
  }

  if (action === 'status') {
    return compatibleAvailablePlatforms;
  }

  const autoState = await getAutoPlatformState(adapters, plugins, scope);
  const unknownPlatforms = compatibleAvailablePlatforms.filter((platform) => autoState[platform] === 'unknown');
  if (unknownPlatforms.length > 0) {
    throw new Error(
      '当前环境同时检测到双平台，但至少一侧 `scopeInitialized = unknown`，`--platform auto` 无法安全推断，请显式传入 `--platform codex|claude|both`。',
    );
  }

  const initializedPlatforms = compatibleAvailablePlatforms.filter((platform) => autoState[platform] === 'yes');
  if (initializedPlatforms.length === 1) {
    return initializedPlatforms;
  }

  throw new Error(
    '当前环境同时检测到双平台，且无法从当前 scope 的初始化状态唯一推断目标平台，请显式传入 `--platform codex|claude|both`。',
  );
}

export function formatDetectedPlatforms(detection: EnvironmentDetection): string[] {
  const lines = [chalk.bold('detected-platforms')];

  for (const platform of ['codex', 'claude'] as const) {
    const result = detection[platform];
    const scopes = result.scopes.length > 0 ? result.scopes.join(',') : '-';
    lines.push(
      `  - ${platform}: ${result.available ? 'available' : 'unavailable'} scopes=${scopes}${result.reason ? ` reason=${result.reason}` : ''}`,
    );
  }

  return lines;
}

export function collectCommandWarnings(
  platforms: PlatformName[],
  scope: Scope,
): string[] {
  if (scope === 'project' && platforms.includes('codex')) {
    return [
      'Codex 原生 plugin / marketplace 注册仅支持 user scope，已回退到 `~/.codex/config.toml`；`--scope project` 只影响 `.codex/` 自定义扩展。',
    ];
  }

  return [];
}

function formatSkillTriggerRuntime(plugin: PluginStatusReport): string {
  if (plugin.skillTriggerRuntimeState === 'unknown') {
    return 'unknown';
  }

  if (plugin.skillTriggerRuntimeState === 'mixed') {
    return 'mixed';
  }

  const matches = plugin.skillTriggerRuntimeMatches ?? [];
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    return `matches(${matches.join(',')})`;
  }

  return 'mixed';
}

export function formatStatusReports(reports: StatusReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(chalk.bold(`${report.platform} (${report.scope})`));
    lines.push(`  initialized: ${report.initialized ? 'yes' : 'no'}`);
    if (report.scopeInitialized) {
      lines.push(`  scopeInitialized: ${report.scopeInitialized}`);
    }
    for (const plugin of report.plugins) {
      lines.push(`  - ${plugin.pluginName}`);
      lines.push('    native-state:');
      lines.push(
        `      marketplaceRegistered=${plugin.native.marketplaceRegistered ? 'yes' : 'no'} pluginAvailable=${plugin.native.pluginAvailable ? 'yes' : 'no'} pluginInstalled=${plugin.native.pluginInstalled ? 'yes' : 'no'} version=${plugin.native.version ?? '-'}`,
      );
      if (plugin.native.details) {
        lines.push(`      details=${plugin.native.details}`);
      }
      if (plugin.native.declaredSource) {
        lines.push(`      declaredSource=${plugin.native.declaredSource}`);
      }
      if (plugin.native.materializedInstallLocation) {
        lines.push(`      materializedInstallLocation=${plugin.native.materializedInstallLocation}`);
      }
      if (plugin.native.activeLocalBundlePath) {
        lines.push(`      activeLocalBundlePath=${plugin.native.activeLocalBundlePath}`);
      }
      if (plugin.externalOwnership?.present) {
        lines.push(
          `      externalOwnership=${plugin.externalOwnership.marketplace ?? '-'}${plugin.externalOwnership.details ? ` (${plugin.externalOwnership.details})` : ''}`,
        );
      }
      if (plugin.platformRuntimeEvidence?.present || plugin.platformRuntimeEvidence?.details) {
        lines.push(
          `      runtimeEvidence=${plugin.platformRuntimeEvidence.present ? 'yes' : 'no'}${plugin.platformRuntimeEvidence.details ? ` (${plugin.platformRuntimeEvidence.details})` : ''}`,
        );
      }
      if (plugin.platformNativeFallbackEvidence?.present || plugin.platformNativeFallbackEvidence?.details) {
        lines.push(
          `      nativeFallbackEvidence=${plugin.platformNativeFallbackEvidence.present ? 'yes' : 'no'}${plugin.platformNativeFallbackEvidence.details ? ` (${plugin.platformNativeFallbackEvidence.details})` : ''}`,
        );
      }

      lines.push('    initialization:');
      lines.push(`      scopeInitialized=${plugin.scopeInitialized ?? '-'}`);
      if (plugin.ledgerStateStatus) {
        lines.push(
          `      ledgerState=${plugin.ledgerStateStatus}${plugin.ledgerStateReason ? ` (${plugin.ledgerStateReason})` : ''}`,
        );
      }
      if (plugin.catalogCompatibility) {
        lines.push(`      catalogCompatibility=${plugin.catalogCompatibility}`);
      }
      if (plugin.scopeManagedEvidence) {
        lines.push(
          `      managedEvidence=ledger:${plugin.scopeManagedEvidence.ledger ? 'yes' : 'no'},tracking:${plugin.scopeManagedEvidence.tracking ? 'yes' : 'no'},sharedNativeRef:${plugin.scopeManagedEvidence.sharedNativeRef ? 'yes' : 'no'}`,
        );
      }
      if (plugin.skillTriggerPreference) {
        lines.push(`      skillTriggerLedger=${plugin.skillTriggerPreference}`);
      }
      if (plugin.skillTriggerRuntimeState) {
        lines.push(`      skillTriggerRuntime=${formatSkillTriggerRuntime(plugin)}`);
      }
      if (plugin.skillTriggerDrift) {
        lines.push(`      skillTriggerDrift=${plugin.skillTriggerDrift}`);
      }
      if (plugin.currentCatalog) {
        lines.push(
          `      currentCatalog=source:${plugin.currentCatalog.source},available:${plugin.currentCatalog.available ? 'yes' : 'no'},root:${plugin.currentCatalog.rootDir}${plugin.currentCatalog.reason ? `,reason:${plugin.currentCatalog.reason}` : ''}`,
        );
      }
      if (plugin.activeLocalBundle) {
        lines.push(`      activeLocalBundle=${plugin.activeLocalBundle}`);
      }

      lines.push('    generated-artifacts:');
      if (plugin.artifactsInitialized !== undefined) {
        lines.push(`      artifactsInitialized=${plugin.artifactsInitialized ? 'yes' : 'no'}`);
      }
      if (plugin.generatedArtifacts.length === 0) {
        lines.push('      none');
      } else {
        for (const artifact of plugin.generatedArtifacts) {
          lines.push(
            `      ${artifact.kind}=${artifact.exists ? 'present' : 'missing'} path=${artifact.path}`,
          );
        }
      }

      lines.push('    session-state:');
      if (plugin.projectTrust) {
        lines.push(`      projectTrust=${plugin.projectTrust}`);
      }
      if (plugin.repoManagedSessionState) {
        lines.push(
          `      instructions=${plugin.repoManagedSessionState.instructions} rules=${plugin.repoManagedSessionState.rules} hooks=${plugin.repoManagedSessionState.hooks} agents=${plugin.repoManagedSessionState.agents}`,
        );
      } else {
        lines.push('      not_applicable');
      }

      if (plugin.driftWarnings.length === 0) {
        lines.push('    drift: none');
      } else {
        for (const warning of plugin.driftWarnings) {
          lines.push(`    drift: ${warning}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatStatusOutput(
  detection: EnvironmentDetection,
  reports: StatusReport[],
): string {
  return [...formatDetectedPlatforms(detection), '', formatStatusReports(reports)]
    .join('\n')
    .trimEnd();
}
