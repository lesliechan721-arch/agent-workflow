import {
  buildCleanupEvaluation,
  cleanupCommand,
  isCleanupExecutionFailure,
  resolveCleanupTarget,
  type CleanupBlockingReason,
  type CleanupCommandRuntime,
  type CleanupPlanItem,
  type CleanupTargetPayload,
} from './cleanup.js';
import { installCommand } from './install.js';
import {
  assertAgentVersionsForWriteTargets,
  createAdapters,
  loadPluginTargetsForCommand,
  resolveCurrentCatalogWriteTargetPairs,
} from './common.js';
import {
  readInstallStateProjection,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import {
  applyCatalogSelectorEnv,
  normalizeCleanupCommandOptions,
  normalizeReinstallCommandOptions,
  type RawCleanupCommandOptions,
  type RawReinstallCommandOptions,
} from './options.js';
import { assertNoDuplicateInstall } from './scope-exclusivity-preflight.js';
import type { PlatformName, PluginLocation, ReceiptOverallState, Scope } from '../types.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/paths.js';

type InstallCommandResult = Awaited<ReturnType<typeof installCommand>>;
type CleanupCommandResult = Awaited<ReturnType<typeof cleanupCommand>>;
type InstallStateProjectionResult = Awaited<ReturnType<typeof readInstallStateProjection>>;

interface ReinstallCleanupStageTarget {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  targetType: CleanupTargetPayload['target']['targetType'];
  state: 'completed' | 'notNeeded';
  deletedItems: CleanupPlanItem[];
  skippedItems: CleanupPlanItem[];
  failedItems: CleanupPlanItem[];
  residueItems: CleanupPlanItem[];
  blockingReasons: CleanupBlockingReason[];
}

interface ReinstallPreflightResult {
  location: PluginLocation;
  projectionState: InstallStateProjectionResult;
  cleanupPayload: CleanupTargetPayload;
}

function renderReinstallLocation(location: {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string | null;
}): string {
  return location.scope === 'project'
    ? `${location.platform}/${location.plugin}/project:${location.projectKey ?? '(missing-project-key)'}`
    : `${location.platform}/${location.plugin}/user`;
}

function renderInstallAdoptExistingCommand(location: Pick<PluginLocation, 'plugin' | 'platform' | 'scope'>): string {
  return `aw install ${location.plugin} --platform ${location.platform} --scope ${location.scope} --adopt-existing`;
}

function projectionHasReason(
  projectionState: InstallStateProjectionResult,
  code: string,
): boolean {
  return projectionState.projection.reasonCodes.includes(
    code as InstallStateProjectionResult['projection']['reasonCodes'][number],
  );
}

function hasClaimableProjectArtifacts(
  location: PluginLocation,
  projectionState: InstallStateProjectionResult,
): boolean {
  return location.scope === 'project' && projectionState.evidence.adoptable.possible;
}

function summarizeCleanupFailure(payload: CleanupTargetPayload): string {
  const firstFailure = payload.failedItems[0];
  if (firstFailure) {
    return `${firstFailure.label}${firstFailure.path ? `：${firstFailure.path}` : ''}`;
  }
  const firstResidue = payload.residueItems[0];
  if (firstResidue) {
    return `${firstResidue.label}${firstResidue.path ? `：${firstResidue.path}` : ''}`;
  }
  return 'cleanup 未能完全完成';
}

function toCleanupStageTarget(payload: CleanupTargetPayload): ReinstallCleanupStageTarget {
  return {
    plugin: payload.target.plugin,
    platform: payload.target.platform,
    scope: payload.target.scope,
    ...(payload.target.projectKey ? { projectKey: payload.target.projectKey } : {}),
    targetType: payload.target.targetType,
    state: payload.deletedItems.length === 0 && payload.cleanupScope.length === 0
      ? 'notNeeded'
      : 'completed',
    deletedItems: payload.deletedItems,
    skippedItems: payload.skippedItems,
    failedItems: payload.failedItems,
    residueItems: payload.residueItems,
    blockingReasons: payload.blockingReasons,
  };
}

function createNoopCleanupStage(payload: CleanupTargetPayload): ReinstallCleanupStageTarget {
  return {
    plugin: payload.target.plugin,
    platform: payload.target.platform,
    scope: payload.target.scope,
    ...(payload.target.projectKey ? { projectKey: payload.target.projectKey } : {}),
    targetType: payload.target.targetType,
    state: 'notNeeded',
    deletedItems: [],
    skippedItems: [],
    failedItems: [],
    residueItems: [],
    blockingReasons: payload.blockingReasons,
  };
}

function toProjectKey(
  scope: Scope,
  projectKey?: string | null,
): string | null {
  return scope === 'project' ? (projectKey ?? null) : null;
}

function mergeWarnings(...warningLists: string[][]): string[] {
  return [...new Set(warningLists.flat())];
}

function inferTargetCleanupOverallState(targets: ReinstallCleanupStageTarget[]): ReceiptOverallState {
  return targets.some((target) =>
    target.failedItems.length > 0 || target.residueItems.length > 0 || target.blockingReasons.length > 0)
    ? 'failed'
    : 'succeeded';
}

function withReinstallReceiptDetails(
  installResult: InstallCommandResult,
  cleanupTargets: ReinstallCleanupStageTarget[],
  cleanupWarnings: string[],
): InstallCommandResult {
  const cleanupOverallState = inferTargetCleanupOverallState(cleanupTargets);
  const installStageOverallState = installResult.overallState ?? 'succeeded';

  return {
    ...installResult,
    warnings: mergeWarnings(cleanupWarnings, installResult.warnings),
    receiptDetails: {
      ...(installResult.receiptDetails ?? {}),
      reinstall: {
        configPreserved: true,
        cleanupStage: {
          overallState: cleanupOverallState,
          targets: cleanupTargets,
        },
        installStage: {
          overallState: installStageOverallState,
          targetResults: installResult.targetResults ?? [],
        },
      },
    } as InstallCommandResult['receiptDetails'],
  };
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

async function preflightReinstallLocation(options: {
  pluginName: string;
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanupRuntime: CleanupCommandRuntime;
}): Promise<ReinstallPreflightResult> {
  await assertNoDuplicateInstall({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const projectionState = await readInstallStateProjection({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });

  if (hasClaimableProjectArtifacts(options.location, projectionState)) {
    throw new Error(
      `${options.pluginName} 当前是可认领状态，reinstall 默认不会删除这些共享产物。请改用 \`${renderInstallAdoptExistingCommand(options.location)}\`。`,
    );
  }
  if (projectionState.projection.kind === 'external') {
    throw new Error(
      `${options.pluginName} 当前存在外部或无法确认归属的内容，reinstall 不会先删除再覆盖。请先手动移除这些外部内容，或改用 \`${renderInstallAdoptExistingCommand(options.location)}\` 认领可验证的 project artifacts。`,
    );
  }
  if (projectionState.removalProtection.blockedDependents.length > 0) {
    throw new Error(
      `${options.pluginName} 当前仍被其它 verified dependent 引用：${projectionState.removalProtection.blockedDependents.map(renderReinstallLocation).join('、')}。reinstall 不会在删除这些共享依赖后继续安装。`,
    );
  }
  if (!projectionState.removalProtection.allowed) {
    throw new Error(
      projectionState.removalProtection.failClosedReason
      ?? `${options.pluginName} 当前无法安全确认依赖边界，reinstall 会在新安装前停止。`,
    );
  }
  if (projectionState.cleanupSafety.protectedCodexUserNativeCleanup) {
    throw new Error(
      `${options.pluginName} 当前仍有 shared native refs 保护其它 project consumer，reinstall 不会删除这些共享原生条目后重装。`,
    );
  }
  if (projectionState.cleanupSafety.sharedRuntimeOwnerConflict) {
    const owner = projectionState.evidence.sharedRuntimeOwner.read.status === 'ok'
      ? renderReinstallLocation(projectionState.evidence.sharedRuntimeOwner.read.value.owner)
      : 'unknown owner';
    throw new Error(
      `${options.pluginName} 当前的 shared runtime 仍由 ${owner} 对应的有效安装控制；请先卸载、cleanup，或调整该 owner 对应的安装后再重试 reinstall。`,
    );
  }

  const resolvedTarget = await resolveCleanupTarget({
    pluginName: options.pluginName,
    scope: options.location.scope,
    cwd: options.cwd,
    env: options.env,
    resolver: options.cleanupRuntime.p9TargetResolver ?? loadPluginTargetsForRemovalCommandCompat,
  });
  const cleanupPayload = (await buildCleanupEvaluation({
    location: {
      plugin: options.location.plugin,
      platform: options.location.platform,
      scope: options.location.scope,
      ...(options.location.scope === 'project' ? { projectKey: options.location.projectKey ?? undefined } : {}),
    },
    commandOptions: normalizeCleanupCommandOptions({
      cwd: options.cwd,
      platform: options.location.platform,
      scope: options.location.scope,
    }),
    env: options.env,
    target: resolvedTarget.target,
    ...(resolvedTarget.error ? { targetResolutionError: resolvedTarget.error } : {}),
  })).payload;

  if (cleanupPayload.blockingReasons.length > 0) {
    const reason = cleanupPayload.blockingReasons[0]!;
    throw new Error(
      `${renderReinstallLocation(options.location)} 无法继续 reinstall：${reason.message}${reason.suggestedCommand ? ` 建议先运行 ${reason.suggestedCommand}。` : ''}`,
    );
  }

  return {
    location: options.location,
    projectionState,
    cleanupPayload,
  };
}

async function runCleanupStage(options: {
  pluginName: string;
  rawOptions: RawReinstallCommandOptions;
  cleanupImpl: typeof cleanupCommand;
  runtime: ReinstallCommandRuntime;
  location: PluginLocation;
  cleanupPayload: CleanupTargetPayload;
}): Promise<{
  target: ReinstallCleanupStageTarget;
  warnings: string[];
}> {
  if (options.cleanupPayload.cleanupScope.length === 0) {
    return {
      target: createNoopCleanupStage(options.cleanupPayload),
      warnings: [],
    };
  }

  const cleanupResult = await options.cleanupImpl(
    [options.pluginName],
    {
      ...options.rawOptions,
      cwd: options.rawOptions.cwd,
      platform: options.location.platform,
      scope: options.location.scope,
    } as RawCleanupCommandOptions,
    options.runtime,
  ) as CleanupCommandResult | undefined;

  if (!cleanupResult || typeof cleanupResult !== 'object' || !('payload' in cleanupResult)) {
    return {
      target: {
        ...createNoopCleanupStage(options.cleanupPayload),
        state: options.cleanupPayload.cleanupScope.length > 0 ? 'completed' : 'notNeeded',
        deletedItems: options.cleanupPayload.cleanupScope,
      },
      warnings: [],
    };
  }

  if (cleanupResult.payload.dependencyIndex) {
    throw new Error(`${renderReinstallLocation(options.location)} cleanup 返回了意外的 dependency-index receipt。`);
  }
  if (isCleanupExecutionFailure(cleanupResult.payload)) {
    throw new Error(
      `${renderReinstallLocation(options.location)} 在 reinstall 前未能完全清理：${summarizeCleanupFailure(cleanupResult.payload)}。`,
    );
  }

  return {
    target: toCleanupStageTarget(cleanupResult.payload),
    warnings: cleanupResult.warnings,
  };
}

async function ensureCurrentCatalogTargets(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginNames: string[];
  scope: Scope;
  platform: PlatformName | 'both';
  runtime: ReinstallCommandRuntime;
}): Promise<PluginLocation[]> {
  const adapters = createAdapters(options.cwd, options.env, options.runtime);
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    options.pluginNames,
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env: options.env,
    },
  );
  const requestedPairs = await resolveCurrentCatalogWriteTargetPairs(
    'install',
    options.platform,
    options.cwd,
    options.scope,
    targets,
    adapters,
    options.env,
  );
  return Promise.all(requestedPairs.map(async ({ pluginName, platform }) => ({
    plugin: pluginName,
    platform,
    scope: options.scope,
    projectKey: toProjectKey(
      options.scope,
      options.scope === 'project' ? await resolveProjectKey(platform, options.cwd) : null,
    ),
  } satisfies PluginLocation)));
}

async function loadHistoricalRecoveryLocations(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  scope: Scope;
  supportedPlatforms: PlatformName[];
}): Promise<PluginLocation[]> {
  const historicalRecoveryLocations: PluginLocation[] = [];
  for (const historicalPlatform of (['codex', 'claude'] as const).filter((candidatePlatform) =>
    !options.supportedPlatforms.includes(candidatePlatform),
  )) {
    const historicalLocation: PluginLocation = {
      plugin: options.pluginName,
      platform: historicalPlatform,
      scope: options.scope,
      projectKey: toProjectKey(
        options.scope,
        options.scope === 'project' ? await resolveProjectKey(historicalPlatform, options.cwd) : null,
      ),
    };
    const projectionState = await readInstallStateProjection({
      cwd: options.cwd,
      location: historicalLocation,
      env: options.env,
    });
    if (projectionState.projection.kind !== 'notInstalled') {
      historicalRecoveryLocations.push(historicalLocation);
    }
  }
  return historicalRecoveryLocations;
}

async function loadPluginTargetsForRemovalCommandCompat(
  cwd: string,
  scope: Scope,
  pluginNames?: string[],
  options: {
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const common = await import('./common.js');
  return common.loadPluginTargetsForRemovalCommand(cwd, scope, pluginNames, options);
}

export interface ReinstallCommandRuntime extends InstallStateRemovalRuntime {
  installCommandImpl?: typeof installCommand;
  cleanupCommandImpl?: typeof cleanupCommand;
}

export async function reinstallCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: ReinstallCommandRuntime = {},
): Promise<InstallCommandResult> {
  const options = normalizeReinstallCommandOptions(rawOptions, {
    defaultScope: 'user',
  });
  if (pluginNames.length !== 1) {
    throw new Error('reinstall 命令当前只支持单个插件目标。');
  }

  const env = applyCatalogSelectorEnv(runtime.env ?? process.env, options);
  const cleanupImpl = runtime.cleanupCommandImpl ?? cleanupCommand;
  const installImpl = runtime.installCommandImpl ?? installCommand;

  if (options.platform !== 'both') {
    await assertNoDuplicateInstall({
      cwd: options.cwd,
      location: {
        plugin: pluginNames[0]!,
        platform: options.platform,
        scope: options.scope,
        projectKey: toProjectKey(
          options.scope,
          options.scope === 'project' ? await resolveProjectKey(options.platform, options.cwd) : null,
        ),
      },
      env,
    });
  }

  if (options.platform === 'both') {
    const supportedLocations = await ensureCurrentCatalogTargets({
      cwd: options.cwd,
      env,
      pluginNames,
      scope: options.scope,
      platform: 'both',
      runtime,
    });
    const supportedPlatforms = [...new Set(supportedLocations.map((location) => location.platform))];
    const historicalRecoveryLocations = await loadHistoricalRecoveryLocations({
      cwd: options.cwd,
      env,
      pluginName: pluginNames[0]!,
      scope: options.scope,
      supportedPlatforms,
    });
    if (historicalRecoveryLocations.length > 0 && supportedLocations.length > 0) {
      throw new Error(
        [
          '`reinstall --platform both` 不能在同一次写入里同时清理历史不再支持的平台并重建当前支持的平台。',
          `请先单独 cleanup 这些历史 target：${historicalRecoveryLocations.map(renderReinstallLocation).join('、')}。`,
          `完成后再重新运行 aw reinstall ${pluginNames[0]} --platform both --scope ${options.scope}。`,
        ].join(' '),
      );
    }

    const preflightStates = await Promise.all(supportedLocations.map((location) =>
      preflightReinstallLocation({
        pluginName: pluginNames[0]!,
        location,
        cwd: options.cwd,
        env,
        cleanupRuntime: runtime,
      })));

    await assertAgentVersionsForWriteTargets({
      command: 'reinstall',
      platforms: supportedPlatforms,
      cwd: options.cwd,
      env,
      nativeCliRunner: runtime.nativeCliRunner,
    });

    const cleanupTargets: ReinstallCleanupStageTarget[] = [];
    const cleanupWarnings: string[] = [];
    for (const preflightState of preflightStates) {
      const cleanupStage = await runCleanupStage({
        pluginName: pluginNames[0]!,
        rawOptions: {
          ...rawOptions,
          cwd: options.cwd,
          scope: preflightState.location.scope,
          platform: preflightState.location.platform,
        },
        cleanupImpl,
        runtime,
        location: preflightState.location,
        cleanupPayload: preflightState.cleanupPayload,
      });
      cleanupTargets.push(cleanupStage.target);
      cleanupWarnings.push(...cleanupStage.warnings);
    }

    const installResult = await installImpl(pluginNames, {
      ...rawOptions,
      cwd: options.cwd,
      scope: options.scope,
      platform: 'both',
    }, runtime);
    return withReinstallReceiptDetails(installResult, cleanupTargets, cleanupWarnings);
  }

  const [location] = await ensureCurrentCatalogTargets({
    cwd: options.cwd,
    env,
    pluginNames,
    scope: options.scope,
    platform: options.platform,
    runtime,
  });
  if (!location) {
    throw new Error(`无法为 ${pluginNames[0]} 解析可重装的 current catalog target。`);
  }

  const preflightState = await preflightReinstallLocation({
    pluginName: pluginNames[0]!,
    location,
    cwd: options.cwd,
    env,
    cleanupRuntime: runtime,
  });
  await assertAgentVersionsForWriteTargets({
    command: 'reinstall',
    platforms: [location.platform],
    cwd: options.cwd,
    env,
    nativeCliRunner: runtime.nativeCliRunner,
  });

  const cleanupStage = await runCleanupStage({
    pluginName: pluginNames[0]!,
    rawOptions: {
      ...rawOptions,
      cwd: options.cwd,
      scope: location.scope,
      platform: location.platform,
    },
    cleanupImpl,
    runtime,
    location,
    cleanupPayload: preflightState.cleanupPayload,
  });

  const installResult = await installImpl(pluginNames, {
    ...rawOptions,
    cwd: options.cwd,
    scope: options.scope,
    platform: options.platform,
  }, runtime);
  return withReinstallReceiptDetails(installResult, [cleanupStage.target], cleanupStage.warnings);
}
