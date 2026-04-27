import chalk from 'chalk';

import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type {
  AgentDefinition,
  CommandAction,
  EnvironmentDetection,
  HookDefinition,
  InstructionDefinition,
  PlatformAdapter,
  PlatformName,
  PlatformSelection,
  PluginMeta,
  PermissionDefinition,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
} from '../utils/local-marketplace.js';
import { getTrackingRecord, readTrackingManifest } from '../utils/tracking.js';
import {
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
  source: 'currentCatalog' | 'historical';
}

type HistoricalExtensionKind = 'instruction' | 'permission' | 'hook' | 'agent';
type HistoricalExtensionKindsByPlatform = Record<PlatformName, Set<HistoricalExtensionKind>>;

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

  const { plugins: catalogPlugins } = await resolveCatalogPlugins(undefined, env);
  if (!pluginNames || pluginNames.length === 0) {
    if (catalogPlugins.length === 0) {
      throw new Error('没有发现可用插件。');
    }

    return catalogPlugins.map((plugin) => ({
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog' as const,
    }));
  }

  const catalogMap = new Map(catalogPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const targets: ResolvedPluginTarget[] = [];
  for (const pluginName of pluginNames) {
    const currentPlugin = catalogMap.get(pluginName);
    if (currentPlugin) {
      targets.push({
        pluginName,
        plugin: currentPlugin,
        currentPlugin,
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

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!availablePlatforms.includes(requestedPlatform)) {
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    if (availablePlatforms.length !== 2) {
      throw new Error('`--platform both` 只在同时检测到 Codex 和 Claude 时可用。');
    }
    return ['codex', 'claude'];
  }

  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

  if (availablePlatforms.length === 1) {
    return availablePlatforms;
  }

  if (action === 'status') {
    return ['codex', 'claude'];
  }

  const autoState = await getAutoPlatformState(adapters, plugins, scope);
  const unknownPlatforms = availablePlatforms.filter((platform) => autoState[platform] === 'unknown');
  if (unknownPlatforms.length > 0) {
    throw new Error(
      '当前环境同时检测到双平台，但至少一侧 `scopeInitialized = unknown`，`--platform auto` 无法安全推断，请显式传入 `--platform codex|claude|both`。',
    );
  }

  const initializedPlatforms = availablePlatforms.filter((platform) => autoState[platform] === 'yes');
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
