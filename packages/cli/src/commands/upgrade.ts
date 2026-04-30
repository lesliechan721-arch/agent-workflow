import {
  isCommandWarningError,
} from '../types.js';
import type {
  CodexCapabilitySnapshot,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeRecord,
  NativePluginsByPlatform,
  PlatformAdapter,
  PlatformName,
  ResolvedInstallOptions,
  Scope,
  SkippedUpgradeCode,
  SkippedUpgradeTarget,
  TrackingManifest,
  UpgradeCommandOptions,
  UpgradeCommandResult,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  collectCommandWarnings,
  createResolvedInstallOptionsKey,
  createResolvedInstallOptionsResolver,
  createAdapters,
  formatPolicyProducts,
  getGeneratedArtifactIdentityRefusal,
  getTrackingArtifactIdentityRefusal,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  listManagedPluginNamesForPreparedLedger,
  pluginSupportsPlatform,
  prepareCommandEnvironment,
  preparePluginTargetsForCommand,
  requiresRuntimeWritableMarketplaceForTargets,
  resolveInstallOptionsForTargets,
  resolveTargetPlatforms,
  wrapCommandErrorWithWarnings,
  type ResolvedPluginTarget,
} from './common.js';
import {
  createUpgradeRollbackBaselineKey,
  installTargetsOnPlatforms,
  type UpgradeRollbackBaseline,
} from './install.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  normalizeUpgradeCommandOptions,
  type RawUpgradeCommandOptions,
} from './options.js';
import {
  listExecutablePlatformsForNativeAndCodexProject,
  resolveEvidenceFirstAutoPlatform,
  type PlatformEvidenceState,
} from './platform-resolution.js';
import {
  createPluginConfigSchemaIdentity,
  preflightRequiredPluginConfigs,
} from '../utils/plugin-config.js';
import {
  assertCodexProjectInstallableTargets,
  getCodexProjectInstallability,
} from './codex-project-installability.js';
import {
  isCodexProjectWriteSafetyError,
  preflightCodexProjectWriteSafety,
} from './codex-project-safety.js';
import {
  captureArtifactRollbackState,
  uninstallTargetsOnPlatforms,
} from './uninstall.js';
import {
  resolveClaudeProjectKey,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../utils/paths.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import {
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import { mergeGeneratedArtifacts } from '../utils/generated-artifacts.js';
import { codexCapabilitySnapshotHasRepoManagedArtifacts } from '../utils/codex-project-surface.js';

type UpgradeCommandRuntime = CommandExecutionContextInput & {
  resolveInstallOptions?: (
    platform: PlatformName,
    target: ResolvedPluginTarget,
  ) => ResolvedInstallOptions;
};

type UpgradeAllTrackingState = 'none' | 'managed' | 'invalid';

interface UpgradeAllTrackingEvidence {
  state: UpgradeAllTrackingState;
  reason?: string;
}

interface UpgradeAllCandidatePlatformState {
  pluginNames: string[];
  evidenceState: PlatformEvidenceState;
}

interface UpgradeAllReadyTarget {
  platform: PlatformName;
  target: ResolvedPluginTarget;
}

function createSkippedUpgradeTarget(
  platform: PlatformName,
  scope: Scope,
  plugin: string,
  code: SkippedUpgradeCode,
  reason: string,
): SkippedUpgradeTarget {
  return {
    platform,
    scope,
    plugin,
    code,
    reason,
  };
}

async function resolveUpgradeAllScopeKeys(
  cwd: string,
  scope: Scope,
): Promise<Record<PlatformName, string | undefined>> {
  if (scope === 'user') {
    return {
      codex: undefined,
      claude: undefined,
    };
  }

  const [codexProjectKey, claudeProjectKey] = await Promise.all([
    resolveCodexProjectKey(cwd),
    resolveClaudeProjectKey(cwd),
  ]);
  return {
    codex: codexProjectKey,
    claude: claudeProjectKey,
  };
}

function getUpgradeAllInstalledScopeRecord(
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

function hasCompleteUpgradeAllLedgerEvidence(
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
  platform: PlatformName,
  scope: Scope,
): boolean {
  if (scopeRecord?.managed !== true) {
    return false;
  }

  if (platform !== 'codex' || scope !== 'project') {
    return true;
  }

  return codexCapabilitySnapshotHasRepoManagedArtifacts(
    scopeRecord.capabilitySnapshot as CodexCapabilitySnapshot | undefined,
  );
}

function resolveTrackingDirForPlatform(
  cwd: string,
  platform: PlatformName,
  scope: Scope,
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'codex'
    ? resolveCodexPaths(cwd, scope, env).trackingDir
    : resolveClaudePaths(cwd, scope, env).trackingDir;
}

async function readUpgradeAllTrackingManifest(
  cwd: string,
  platform: PlatformName,
  scope: Scope,
  env: NodeJS.ProcessEnv,
): Promise<{
  manifest?: TrackingManifest;
  readError?: string;
}> {
  const trackingDir = resolveTrackingDirForPlatform(cwd, platform, scope, env);
  try {
    return {
      manifest: await readTrackingManifest(trackingDir),
    };
  } catch (error) {
    return {
      readError: `${trackingDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function collectUpgradeAllTrackingPluginNames(
  manifest: TrackingManifest | undefined,
  platform: PlatformName,
): string[] {
  if (!manifest) {
    return [];
  }

  return Object.entries(manifest.plugins)
    .filter(([, record]) => record.artifacts.some((artifact) => artifact.platform === platform))
    .map(([pluginName]) => pluginName)
    .sort();
}

function trackingManifestHasIntegrityErrors(
  manifest: TrackingManifest | undefined,
  platform: PlatformName,
): boolean {
  if (!manifest) {
    return false;
  }

  return Object.values(manifest.plugins).some((record) =>
    getTrackingArtifactIntegrityErrors(
      record.artifacts.filter((artifact) => artifact.platform === platform),
    ).length > 0,
  );
}

function getUpgradeAllTrackingEvidenceForTarget(
  manifest: TrackingManifest | undefined,
  readError: string | undefined,
  pluginName: string,
  platform: PlatformName,
): UpgradeAllTrackingEvidence {
  if (readError) {
    return {
      state: 'invalid',
      reason: `无法读取 tracking manifest：${readError}`,
    };
  }

  const record = manifest ? getTrackingRecord(manifest, pluginName) : undefined;
  const platformArtifacts = (record?.artifacts ?? []).filter((artifact) => artifact.platform === platform);
  if (platformArtifacts.length === 0) {
    return {
      state: 'none',
    };
  }

  const integrityErrors = getTrackingArtifactIntegrityErrors(platformArtifacts);
  if (integrityErrors.length > 0) {
    return {
      state: 'invalid',
      reason: integrityErrors.map((error) => error.message).join('；'),
    };
  }

  return {
    state: 'managed',
  };
}

async function collectUpgradeAllCandidateStateByPlatform(
  scope: Scope,
  cwd: string,
  ledger: InstalledLedger,
  env: NodeJS.ProcessEnv,
): Promise<Record<PlatformName, UpgradeAllCandidatePlatformState>> {
  const scopeKeys = await resolveUpgradeAllScopeKeys(cwd, scope);
  const managedNamesByPlatform = {
    codex: await listManagedPluginNamesForPreparedLedger('codex', scope, cwd, ledger),
    claude: await listManagedPluginNamesForPreparedLedger('claude', scope, cwd, ledger),
  };

  if (scope !== 'project') {
    return {
      codex: {
        pluginNames: managedNamesByPlatform.codex,
        evidenceState: managedNamesByPlatform.codex.length > 0 ? 'yes' : 'no',
      },
      claude: {
        pluginNames: managedNamesByPlatform.claude,
        evidenceState: managedNamesByPlatform.claude.length > 0 ? 'yes' : 'no',
      },
    };
  }

  const [codexTracking, claudeTracking] = await Promise.all([
    readUpgradeAllTrackingManifest(cwd, 'codex', scope, env),
    readUpgradeAllTrackingManifest(cwd, 'claude', scope, env),
  ]);

  const codexTrackingNames = collectUpgradeAllTrackingPluginNames(codexTracking.manifest, 'codex');
  const claudeTrackingNames = collectUpgradeAllTrackingPluginNames(claudeTracking.manifest, 'claude');
  const legacyProjectCandidateNamesByPlatform = {
    codex: Object.entries(ledger.plugins)
      .filter(([, record]) => {
        const platformRecord = record.platforms.codex;
        if (!platformRecord || platformRecord.lastRequestedScope !== 'project') {
          return false;
        }
        return !platformRecord.projectScopes?.[scopeKeys.codex ?? '']?.managed;
      })
      .map(([pluginName]) => pluginName)
      .sort(),
    claude: Object.entries(ledger.plugins)
      .filter(([, record]) => {
        const platformRecord = record.platforms.claude;
        if (!platformRecord || platformRecord.lastRequestedScope !== 'project') {
          return false;
        }
        return !platformRecord.projectScopes?.[scopeKeys.claude ?? '']?.managed;
      })
      .map(([pluginName]) => pluginName)
      .sort(),
  };

  return {
    codex: {
      pluginNames: [
        ...new Set([
          ...managedNamesByPlatform.codex,
          ...codexTrackingNames,
          ...legacyProjectCandidateNamesByPlatform.codex,
        ]),
      ].sort(),
      evidenceState: codexTracking.readError || trackingManifestHasIntegrityErrors(codexTracking.manifest, 'codex')
        ? 'unknown'
        : managedNamesByPlatform.codex.length > 0 ||
            codexTrackingNames.length > 0 ||
            legacyProjectCandidateNamesByPlatform.codex.length > 0
          ? 'yes'
          : 'no',
    },
    claude: {
      pluginNames: [
        ...new Set([
          ...managedNamesByPlatform.claude,
          ...claudeTrackingNames,
          ...legacyProjectCandidateNamesByPlatform.claude,
        ]),
      ].sort(),
      evidenceState: claudeTracking.readError || trackingManifestHasIntegrityErrors(claudeTracking.manifest, 'claude')
        ? 'unknown'
        : managedNamesByPlatform.claude.length > 0 ||
            claudeTrackingNames.length > 0 ||
            legacyProjectCandidateNamesByPlatform.claude.length > 0
          ? 'yes'
          : 'no',
    },
  };
}

function mergeNativePlugins(
  target: NativePluginsByPlatform,
  source: NativePluginsByPlatform | undefined,
): void {
  if (!source) {
    return;
  }

  for (const [platform, pluginNames] of Object.entries(source) as Array<[PlatformName, string[] | undefined]>) {
    if (!pluginNames || pluginNames.length === 0) {
      continue;
    }
    target[platform] ??= [];
    for (const pluginName of pluginNames) {
      if (!target[platform].includes(pluginName)) {
        target[platform].push(pluginName);
      }
    }
  }
}

function resolveTrackingDir(
  cwd: string,
  platform: PlatformName,
  scope: UpgradeCommandOptions['scope'],
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'claude'
    ? resolveClaudePaths(cwd, scope, env).trackingDir
    : resolveCodexPaths(cwd, scope, env).trackingDir;
}

async function captureUpgradeRollbackBaseline(options: {
  platform: PlatformName;
  target: ResolvedPluginTarget;
  command: Pick<UpgradeCommandOptions, 'cwd' | 'scope'>;
  env: NodeJS.ProcessEnv;
}): Promise<UpgradeRollbackBaseline> {
  const trackingDir = resolveTrackingDir(
    options.command.cwd,
    options.platform,
    options.command.scope,
    options.env,
  );
  const [ledger, trackingManifest] = await Promise.all([
    readInstalledLedger(options.env),
    readTrackingManifest(trackingDir),
  ]);

  return {
    artifactRollbackState: await captureArtifactRollbackState(
      options.platform,
      options.target,
      options.command.scope,
      options.command.cwd,
      options.env,
    ),
    trackingDir,
    trackingManifest,
    ledger,
    degradedReasonOnRestoreFailure:
      options.platform === 'codex' && options.command.scope === 'project'
        ? 'capability_changed_upgrade_restore_incomplete'
        : 'operation_interrupted_after_artifact_write',
  };
}

async function listCodexProjectUpgradeAllNativeRunnerRequiredNames(
  cwd: string,
  ledger: InstalledLedger,
): Promise<string[]> {
  const projectKey = await resolveCodexProjectKey(cwd);
  return Object.entries(ledger.plugins)
    .filter(([, record]) => {
      const scopeRecord = record.platforms.codex?.projectScopes?.[projectKey];
      if (scopeRecord?.managed !== true) {
        return false;
      }

      return !codexCapabilitySnapshotHasRepoManagedArtifacts(scopeRecord.capabilitySnapshot);
    })
    .map(([pluginName]) => pluginName)
    .sort();
}

function createCodexUpgradeAllNativeRunnerRequiredError(
  scope: UpgradeCommandOptions['scope'],
  pluginNames: string[],
): Error {
  const suffix = pluginNames.length > 0
    ? ` native-only managed targets: ${pluginNames.join(', ')}。`
    : '';
  const reason = scope === 'project'
    ? 'Codex project upgrade --all 当前包含需要本机 Codex native runner 的目标'
    : 'Codex user upgrade --all 需要本机 Codex native runner';
  return new Error(
    `${reason}，但 PATH 中没有检测到可用 \`codex\`。${suffix}请安装 Codex CLI 或设置 AW_FORCE_CODEX_AVAILABLE=1 后重试。`,
  );
}

async function preflightUpgradeConfigs(
  targets: ResolvedPluginTarget[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
): Promise<void> {
  const context = createCommandExecutionContext(runtime);
  await preflightRequiredPluginConfigs({
    targets: targets
      .filter((target) => target.currentPlugin)
      .map((target) => ({
        pluginName: target.pluginName,
        manifest: target.currentPlugin!.manifest,
        schemaSourceIdentity: createPluginConfigSchemaIdentity(target.currentPlugin!.manifest),
      })),
    cwd: options.cwd,
    defaultScope: options.scope,
    context,
    interactive: true,
  });
}

async function resolveUpgradeAllPlatforms(
  requestedPlatform: UpgradeCommandOptions['platform'],
  cwd: string,
  scope: UpgradeCommandOptions['scope'],
  preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
  env: NodeJS.ProcessEnv,
): Promise<PlatformName[]> {
  const detection = await detectEnvironment(cwd, env);
  const nativeAvailablePlatforms = listDetectedPlatforms(detection);
  const candidateStateByPlatform = await collectUpgradeAllCandidateStateByPlatform(
    scope,
    cwd,
    preparedLedger,
    env,
  );
  const codexNativeRunnerRequiredNames =
    scope === 'project'
      ? await listCodexProjectUpgradeAllNativeRunnerRequiredNames(cwd, preparedLedger)
      : [];
  const availablePlatforms = listExecutablePlatformsForNativeAndCodexProject({
    nativeAvailablePlatforms,
    codexProjectExecutableWithoutNative:
      scope === 'project' && codexNativeRunnerRequiredNames.length === 0,
  });

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!availablePlatforms.includes(requestedPlatform)) {
      if (requestedPlatform === 'codex') {
        throw createCodexUpgradeAllNativeRunnerRequiredError(scope, codexNativeRunnerRequiredNames);
      }
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    if (availablePlatforms.length !== 2) {
      if (!availablePlatforms.includes('codex') && !detection.codex.available) {
        throw createCodexUpgradeAllNativeRunnerRequiredError(scope, codexNativeRunnerRequiredNames);
      }
      throw new Error('`--platform both` 只在同时检测到 Codex 和 Claude 时可用。');
    }
    return ['codex', 'claude'];
  }

  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

  if (requestedPlatform === 'auto' && scope === 'project') {
    const inferred = resolveEvidenceFirstAutoPlatform({
      evidenceStateByPlatform: {
        codex: candidateStateByPlatform.codex.evidenceState,
        claude: candidateStateByPlatform.claude.evidenceState,
      },
      availablePlatforms,
      unknownMessage: '当前 scope 至少一侧平台 evidence = unknown，`upgrade --all --platform auto` 无法安全推断；请先修复 tracking / status 诊断，或显式传入 `--platform codex|claude|both`。',
      ambiguousMessage: '当前 scope 同时存在 Claude 与 Codex project 受管证据，`upgrade --all --platform auto` 无法唯一推断目标平台；请显式传入 `--platform codex|claude|both`。',
      createUnavailableError: (platform) => platform === 'codex'
        ? createCodexUpgradeAllNativeRunnerRequiredError(scope, codexNativeRunnerRequiredNames)
        : new Error(`${platform} 当前环境不可用。`),
    });
    if (inferred) {
      return [inferred];
    }
  }

  if (availablePlatforms.length === 1) {
    return availablePlatforms;
  }

  const counts: Record<PlatformName, number> = {
    codex: candidateStateByPlatform.codex.pluginNames.length,
    claude: candidateStateByPlatform.claude.pluginNames.length,
  };
  const inferred = availablePlatforms.filter((platform) => counts[platform] > 0);
  if (inferred.length === 1) {
    return inferred;
  }

  throw new Error(
    '当前环境同时检测到双平台，且无法从当前 scope 的初始化状态唯一推断目标平台，请显式传入 `--platform codex|claude|both`。',
  );
}

async function requiresRuntimeWritableMarketplaceForUpgradeAll(
  platforms: PlatformName[],
  scope: UpgradeCommandOptions['scope'],
  cwd: string,
  ledger: InstalledLedger,
): Promise<boolean> {
  if (platforms.includes('claude')) {
    return true;
  }

  if (!platforms.includes('codex')) {
    return false;
  }

  if (scope === 'user') {
    return true;
  }

  return (await listCodexProjectUpgradeAllNativeRunnerRequiredNames(cwd, ledger)).length > 0;
}

async function evaluateUpgradeAllTarget(options: {
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  target: ResolvedPluginTarget;
  adapters: Record<PlatformName, PlatformAdapter>;
  ledger: InstalledLedger;
  scopeKeys: Record<PlatformName, string | undefined>;
  trackingManifests: Partial<Record<PlatformName, { manifest?: TrackingManifest; readError?: string }>>;
  commandOptions: UpgradeCommandOptions;
}): Promise<{
  ready?: UpgradeAllReadyTarget;
  resolvedInstallOptions?: ResolvedInstallOptions;
  skipped?: SkippedUpgradeTarget;
}> {
  const {
    platform,
    scope,
    cwd,
    env,
    target,
    adapters,
    ledger,
    scopeKeys,
    trackingManifests,
    commandOptions,
  } = options;

  const scopeRecord = getUpgradeAllInstalledScopeRecord(
    ledger,
    target.pluginName,
    platform,
    scope,
    scopeKeys,
  );
  const trackingEvidence = getUpgradeAllTrackingEvidenceForTarget(
    trackingManifests[platform]?.manifest,
    trackingManifests[platform]?.readError,
    target.pluginName,
    platform,
  );

  if (
    !hasCompleteUpgradeAllLedgerEvidence(scopeRecord, platform, scope) &&
    trackingEvidence.state === 'none'
  ) {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'scopeNotInitialized',
        `${target.pluginName} 在 ${platform} (${scope}) 没有可用于 upgrade --all 的完整受管证据；请先显式 reinstall，或先修复当前 scope 的 tracking / ledger。`,
      ),
    };
  }

  if (platform === 'codex' && scope === 'project') {
    try {
      await preflightCodexProjectWriteSafety({
        targets: [target],
        platforms: [platform],
        cwd,
        scope,
        env,
        operation: 'upgrade',
      });
    } catch (error) {
      if (!isCodexProjectWriteSafetyError(error)) {
        throw error;
      }

      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          error.code,
          error.message,
        ),
      };
    }
  } else {
    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd,
      env,
      platform,
      scope,
      pluginName: target.pluginName,
    });
    if (trackingIdentityRefusal) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'trackingIntegrityError',
          trackingIdentityRefusal,
        ),
      };
    }
  }

  let pluginStatus;
  const status = await adapters[platform].status(target.currentPlugin ?? target.plugin, scope);
  pluginStatus = status.plugins[0];

  if (!pluginStatus) {
    throw new Error(`无法读取 ${platform}/${target.pluginName} 的当前状态。`);
  }

  if (platform === 'codex' && scope === 'project') {
    if (
      pluginStatus.externalOwnership?.checkState === 'unknown' ||
      pluginStatus.projectTrust === 'unknown'
    ) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'externalOwnershipUnknown',
          pluginStatus.externalOwnership?.details ??
            `${target.pluginName} 在 Codex project scope 的 external ownership / project trust 当前无法可靠判定。`,
        ),
      };
    }
    if (pluginStatus.externalOwnership?.present) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'externalOwnershipPresent',
          pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。',
        ),
      };
    }
  } else if (pluginStatus.externalOwnership?.present) {
    throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
  }

  if (!target.currentPlugin || pluginStatus.catalogCompatibility === 'missing') {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'catalogNotCurrent',
        `${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`,
      ),
    };
  }

  if (pluginStatus.catalogCompatibility === 'capabilityChanged') {
    throw new Error(
      `${platform}/${target.pluginName}: catalogCompatibility=capabilityChanged，当前仍需要显式 upgrade 事务恢复，请改用逐插件升级。`,
    );
  }

  if (platform === 'codex' && scope === 'project') {
    const installability = getCodexProjectInstallability(target.currentPlugin);
    if (!installability.installable) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'catalogNotProjectInstallable',
          installability.reason ?? `${target.pluginName} 当前 catalog 版本不再支持 Codex project upgrade。`,
        ),
      };
    }
  }

  let resolvedInstallOptions: ResolvedInstallOptions;
  try {
    const resolved = await resolveInstallOptionsForTargets(
      'upgrade-all',
      [target],
      [platform],
      {
        ...commandOptions,
        cwd,
        scope,
        env,
      },
      ledger,
    );
    resolvedInstallOptions = [...resolved.values()][0]!;
  } catch (error) {
    if (isCommandWarningError(error)) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'installOptionsUnavailable',
          error.message,
        ),
      };
    }
    throw error;
  }

  return {
    ready: {
      platform,
      target,
    },
    resolvedInstallOptions,
  };
}

async function runExplicitUpgrade(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
): Promise<{ warnings: string[]; plugins: string[]; nativePlugins: NativePluginsByPlatform; repoManagedArtifacts: GeneratedArtifact[] }> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const warnings: string[] = [];
  const upgradedPlugins = new Set<string>();
  const nativePlugins: NativePluginsByPlatform = {};
  let repoManagedArtifacts: GeneratedArtifact[] = [];

  for (const platform of platforms) {
    for (const target of targets) {
      const status = await adapters[platform].status(target.plugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (!pluginStatus) {
        continue;
      }

      if (
        pluginStatus.externalOwnership?.present &&
        !(platform === 'codex' && options.scope === 'project')
      ) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
      }

      if (target.source === 'historical' && !hasHistoricalEvidence(pluginStatus)) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

      const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
        cwd: options.cwd,
        env,
        platform,
        scope: options.scope,
        pluginName: target.pluginName,
      });
      if (trackingIdentityRefusal) {
        throw new Error(trackingIdentityRefusal);
      }

      const identityRefusal = getGeneratedArtifactIdentityRefusal(pluginStatus);
      if (identityRefusal) {
        throw new Error(identityRefusal);
      }

      const managedEvidence = hasScopeManagedEvidence(pluginStatus);
      const fallbackOnly =
        !managedEvidence &&
        (
          pluginStatus.platformRuntimeEvidence?.present === true ||
          pluginStatus.platformNativeFallbackEvidence?.present === true
        );

      if (fallbackOnly) {
        throw new Error(
          `${target.pluginName} 在 ${platform} (${options.scope}) 缺少安装时快照，不能直接 upgrade；请先执行 uninstall，再重新 install。`,
        );
      }

      if (!managedEvidence) {
        throw new Error(
          `${target.pluginName} 在 ${platform} (${options.scope}) 尚未初始化，不能执行 upgrade。`,
        );
      }

      if (pluginStatus.catalogCompatibility === 'missing') {
        throw new Error(`${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`);
      }

      if (!target.currentPlugin) {
        throw new Error(`${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`);
      }

      const upgradeRollbackBaselines = new Map<string, UpgradeRollbackBaseline>();
      if (platform === 'codex' && options.scope === 'project') {
        upgradeRollbackBaselines.set(
          createUpgradeRollbackBaselineKey(platform, target.pluginName),
          await captureUpgradeRollbackBaseline({
            platform,
            target,
            command: options,
            env,
          }),
        );
      }

      if (pluginStatus.catalogCompatibility === 'capabilityChanged') {
        const uninstallResult = await uninstallTargetsOnPlatforms(
          [target],
          [platform],
          {
            cwd: options.cwd,
            platform,
            scope: options.scope,
            scriptTimeoutMs: options.scriptTimeoutMs,
          },
          {
            ...context,
            adapters,
            skipLifecycle: true,
            skipLifecycleSnapshotGc: true,
          },
        );
        warnings.push(...uninstallResult.warnings);
      }

      const installResult = await installTargetsOnPlatforms(
        [target],
        [platform],
        {
          cwd: options.cwd,
          platform,
          scope: options.scope,
          scriptTimeoutMs: options.scriptTimeoutMs,
        },
        {
          ...context,
          adapters,
          resolveInstallOptions: runtime.resolveInstallOptions,
          operation: 'upgrade',
          skipConfigPreflight: true,
          skipWriteSafetyPreflight: true,
          upgradeRollbackBaselines,
        },
      );
      warnings.push(...installResult.warnings);
      mergeNativePlugins(nativePlugins, installResult.nativePlugins);
      repoManagedArtifacts = mergeGeneratedArtifacts(
        repoManagedArtifacts,
        installResult.repoManagedArtifacts,
      );
      upgradedPlugins.add(target.pluginName);
    }
  }

  return {
    warnings,
    plugins: [...upgradedPlugins],
    nativePlugins,
    repoManagedArtifacts,
  };
}

async function runUpgradeAll(
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
  preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
  targets: ResolvedPluginTarget[],
): Promise<{
  warnings: string[];
  plugins: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  skipped: SkippedUpgradeTarget[];
}> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const scopeKeys = await resolveUpgradeAllScopeKeys(options.cwd, options.scope);
  const trackingManifests = {
    codex: platforms.includes('codex')
      ? await readUpgradeAllTrackingManifest(options.cwd, 'codex', options.scope, env)
      : undefined,
    claude: platforms.includes('claude')
      ? await readUpgradeAllTrackingManifest(options.cwd, 'claude', options.scope, env)
      : undefined,
  };
  const namesByPlatformState = await collectUpgradeAllCandidateStateByPlatform(
    options.scope,
    options.cwd,
    preparedLedger,
    env,
  );
  const targetMap = new Map(targets.map((target) => [target.pluginName, target]));
  const readyTargetsByPlatform: Record<PlatformName, ResolvedPluginTarget[]> = {
    codex: [],
    claude: [],
  };
  const skipped: SkippedUpgradeTarget[] = [];
  const resolvedInstallOptionsByKey = new Map<string, ResolvedInstallOptions>();

  for (const platform of platforms) {
    for (const pluginName of namesByPlatformState[platform].pluginNames) {
      const target = targetMap.get(pluginName);
      if (!target) {
        continue;
      }

      if (target.currentPlugin && !pluginSupportsPlatform(target.currentPlugin, platform)) {
        throw new Error(
          `${platform}/${pluginName}: marketplace.policy.products=[${formatPolicyProducts(target.currentPlugin)}], 需要 ${platform === 'codex' ? 'CODEX' : 'CLAUDE'}`,
        );
      }

      const evaluation = await evaluateUpgradeAllTarget({
        platform,
        scope: options.scope,
        cwd: options.cwd,
        env,
        target,
        adapters,
        ledger: preparedLedger,
        scopeKeys,
        trackingManifests,
        commandOptions: options,
      });
      if (evaluation.skipped) {
        skipped.push(evaluation.skipped);
        continue;
      }

      if (!evaluation.ready || !evaluation.resolvedInstallOptions) {
        continue;
      }

      readyTargetsByPlatform[platform].push(evaluation.ready.target);
      const projectScopeKey = scopeKeys[platform];
      if (options.scope === 'project' && !projectScopeKey) {
        throw new Error(`无法解析 ${platform} project scope key。`);
      }
      const scopeIdentity = options.scope === 'user'
        ? 'user'
        : `project:${projectScopeKey}`;
      resolvedInstallOptionsByKey.set(
        createResolvedInstallOptionsKey(
          platform,
          target.pluginName,
          scopeIdentity,
        ),
        evaluation.resolvedInstallOptions,
      );
    }
  }

  const readyTargets = [...readyTargetsByPlatform.codex, ...readyTargetsByPlatform.claude];
  const warnings: string[] = [];
  const upgradedPlugins = new Set<string>();
  const nativePlugins: NativePluginsByPlatform = {};
  let repoManagedArtifacts: GeneratedArtifact[] = [];
  const resolveInstallOptions = await createResolvedInstallOptionsResolver(
    resolvedInstallOptionsByKey,
    options.cwd,
    options.scope,
  );

  await emitCommandEvent(context, {
    type: 'skill-trigger:resolved',
    data: {
      entries: [...resolvedInstallOptionsByKey.entries()].map(([key, value]) => ({
        key,
        applicability: value.applicability,
        ...(value.applicability === 'overridable'
          ? {
              preference: value.skillTriggerPreference,
              source: value.skillTriggerSource,
            }
          : {}),
        ledgerTrust: value.ledgerTrust,
      })),
      skipped: skipped.map((entry) => ({
        platform: entry.platform,
        plugin: entry.plugin,
        code: entry.code,
      })),
    },
  });

  if (readyTargets.length > 0) {
    await preflightUpgradeConfigs(
      readyTargets,
      options,
      {
        ...context,
        adapters,
        resolveInstallOptions,
      },
    );
  }

  for (const platform of platforms) {
    const platformTargets = readyTargetsByPlatform[platform];

    if (platformTargets.length === 0) {
      continue;
    }

    const result = await installTargetsOnPlatforms(
      platformTargets,
      [platform],
      {
        cwd: options.cwd,
        platform,
        scope: options.scope,
        scriptTimeoutMs: options.scriptTimeoutMs,
      },
      {
        ...context,
        adapters,
        resolveInstallOptions,
        operation: 'upgrade',
        skipConfigPreflight: true,
      },
    );
    warnings.push(...result.warnings);
    mergeNativePlugins(nativePlugins, result.nativePlugins);
    repoManagedArtifacts = mergeGeneratedArtifacts(
      repoManagedArtifacts,
      result.repoManagedArtifacts,
    );
    for (const target of platformTargets) {
      upgradedPlugins.add(target.pluginName);
    }
  }

  return {
    warnings,
    plugins: [...upgradedPlugins],
    nativePlugins,
    repoManagedArtifacts,
    skipped,
  };
}

export async function upgradeCommand(
  pluginNames: string[],
  rawOptions: RawUpgradeCommandOptions,
  runtime: UpgradeCommandRuntime = {},
): Promise<UpgradeCommandResult> {
  const options = normalizeUpgradeCommandOptions(rawOptions);
  const context = createCommandExecutionContext(runtime);
  const env = context.env;

  if (!options.all && pluginNames.length === 0) {
    throw new Error('upgrade 命令需要插件名，或者显式传入 `--all`。');
  }

  if (options.all && options.requestedSkillTrigger) {
    throw new Error('`upgrade --all` 首版不支持 `--skill-trigger`，请改用显式插件名逐个升级。');
  }

  const adapters = createAdapters(options.cwd, context);
  if (options.all) {
    const prepared = await prepareCommandEnvironment({
      catalogMode: options.scope === 'project' ? 'readOnly' : 'runtimeWritable',
      env,
    });
    let commandWarnings = prepared.warnings;
    try {
      if (prepared.ledger.ledgerState.status === 'degraded') {
        throw new Error('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行，请先处理异常记录。');
      }

      const platforms = await resolveUpgradeAllPlatforms(
        options.platform,
        options.cwd,
        options.scope,
        prepared.ledger,
        env,
      );
      await emitCommandEvent(context, {
        type: 'platform:resolved',
        data: {
          requestedPlatform: options.platform,
          platforms,
          scope: options.scope,
          all: true,
        },
      });
      const runtimeWritableMarketplace = await requiresRuntimeWritableMarketplaceForUpgradeAll(
        platforms,
        options.scope,
        options.cwd,
        prepared.ledger,
      );
      const preparedForExecution = runtimeWritableMarketplace
        ? await prepareCommandEnvironment({
            catalogMode: 'runtimeWritable',
            env,
          })
        : prepared;
      const executionWarnings = preparedForExecution === prepared
        ? []
        : preparedForExecution.warnings;
      commandWarnings = [
        ...prepared.warnings,
        ...executionWarnings,
      ];
      const candidateStateByPlatform = await collectUpgradeAllCandidateStateByPlatform(
        options.scope,
        options.cwd,
        preparedForExecution.ledger,
        env,
      );
      const allNames = [
        ...new Set([
          ...(platforms.includes('codex')
            ? candidateStateByPlatform.codex.pluginNames
            : []),
          ...(platforms.includes('claude')
            ? candidateStateByPlatform.claude.pluginNames
            : []),
        ]),
      ].sort();
      const targets = await loadPluginTargetsForCommand(
        options.cwd,
        options.scope,
        allNames,
        {
          allowHistoricalFallback: true,
          env,
        },
      );
      await emitCommandEvent(context, {
        type: 'catalog:resolved',
        data: {
          plugins: targets.map((target) => ({
            name: target.pluginName,
            source: target.source,
            current: Boolean(target.currentPlugin),
          })),
          all: true,
        },
      });
      const result = await runUpgradeAll(platforms, options, {
        ...context,
        adapters,
      }, preparedForExecution.ledger, targets);

      return {
        platforms,
        plugins: result.plugins,
        skipped: result.skipped,
        nativePlugins: result.nativePlugins,
        repoManagedArtifacts: result.repoManagedArtifacts,
        marketplace: preparedForExecution.marketplace,
        warnings: [
          ...commandWarnings,
          ...collectCommandWarnings(platforms, options.scope),
          ...result.warnings,
        ],
      };
    } catch (error) {
      throw wrapCommandErrorWithWarnings(error, commandWarnings);
    }
  }

  const prepared = await preparePluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env,
    },
  );
  let commandWarnings = prepared.warnings;
  await emitCommandEvent(context, {
    type: 'catalog:resolved',
    data: {
      plugins: prepared.targets.map((target) => ({
        name: target.pluginName,
        source: target.source,
        current: Boolean(target.currentPlugin),
      })),
      warnings: prepared.warnings,
    },
  });
  try {
    const platforms = await resolveTargetPlatforms(
      'upgrade',
      options.platform,
      options.cwd,
      options.scope,
      prepared.targets.map((target) => target.plugin),
      adapters,
      env,
    );
    await emitCommandEvent(context, {
      type: 'platform:resolved',
      data: {
        requestedPlatform: options.platform,
        platforms,
        scope: options.scope,
      },
    });
    assertCodexProjectInstallableTargets(prepared.targets, platforms, options.scope);
    await preflightCodexProjectWriteSafety({
      targets: prepared.targets,
      platforms,
      cwd: options.cwd,
      scope: options.scope,
      env,
      operation: 'upgrade',
    });
    await preflightUpgradeConfigs(
      prepared.targets,
      options,
      context,
    );
    const runtimeWritableMarketplace = requiresRuntimeWritableMarketplaceForTargets(
      platforms,
      prepared.targets,
      options.scope,
    );
    const preparedForExecution = runtimeWritableMarketplace
      ? await prepareCommandEnvironment({
          catalogMode: 'runtimeWritable',
          env,
        })
      : prepared;
    const executionWarnings = preparedForExecution === prepared
      ? []
      : preparedForExecution.warnings;
    commandWarnings = [
      ...prepared.warnings,
      ...executionWarnings,
    ];
    const resolvedInstallOptionsByKey = await resolveInstallOptionsForTargets(
      'upgrade',
      prepared.targets,
      platforms,
      {
        ...options,
        env,
      },
      preparedForExecution.ledger,
    );
    await emitCommandEvent(context, {
      type: 'skill-trigger:resolved',
      data: {
        entries: [...resolvedInstallOptionsByKey.entries()].map(([key, value]) => ({
          key,
          applicability: value.applicability,
          ...(value.applicability === 'overridable'
            ? {
                preference: value.skillTriggerPreference,
                source: value.skillTriggerSource,
              }
            : {}),
          ledgerTrust: value.ledgerTrust,
        })),
      },
    });
    const resolveInstallOptions = await createResolvedInstallOptionsResolver(
      resolvedInstallOptionsByKey,
      options.cwd,
      options.scope,
    );
    const result = await runExplicitUpgrade(
      prepared.targets,
      platforms,
      options,
      {
        ...context,
        adapters,
        resolveInstallOptions,
      },
    );

    return {
      platforms,
      plugins: result.plugins,
      skipped: [],
      nativePlugins: result.nativePlugins,
      repoManagedArtifacts: result.repoManagedArtifacts,
      marketplace: preparedForExecution.marketplace,
      warnings: [
        ...commandWarnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...result.warnings,
      ],
    };
  } catch (error) {
    throw wrapCommandErrorWithWarnings(error, commandWarnings);
  }
}
