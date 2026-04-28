import type {
  PlatformAdapter,
  PlatformName,
  ResolvedInstallOptions,
  UpgradeCommandOptions,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  collectCommandWarnings,
  createResolvedInstallOptionsResolver,
  createAdapters,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  listManagedPluginNamesForPreparedLedger,
  prepareCommandEnvironment,
  preparePluginTargetsForCommand,
  resolveInstallOptionsForTargets,
  resolveTargetPlatforms,
  wrapCommandErrorWithWarnings,
  type ResolvedPluginTarget,
} from './common.js';
import { installTargetsOnPlatforms } from './install.js';
import { uninstallTargetsOnPlatforms } from './uninstall.js';

interface CommandRuntime {
  adapters?: Record<PlatformName, PlatformAdapter>;
  env?: NodeJS.ProcessEnv;
  resolveInstallOptions?: (
    platform: PlatformName,
    target: ResolvedPluginTarget,
  ) => ResolvedInstallOptions;
}

async function resolveUpgradeAllPlatforms(
  requestedPlatform: UpgradeCommandOptions['platform'],
  cwd: string,
  scope: UpgradeCommandOptions['scope'],
  preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
  env: NodeJS.ProcessEnv,
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

  const counts = {
    codex: (await listManagedPluginNamesForPreparedLedger('codex', scope, cwd, preparedLedger)).length,
    claude: (await listManagedPluginNamesForPreparedLedger('claude', scope, cwd, preparedLedger)).length,
  };
  const inferred = availablePlatforms.filter((platform) => counts[platform] > 0);
  if (inferred.length === 1) {
    return inferred;
  }

  throw new Error(
    '当前环境同时检测到双平台，且无法从当前 scope 的初始化状态唯一推断目标平台，请显式传入 `--platform codex|claude|both`。',
  );
}

async function runExplicitUpgrade(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: CommandRuntime,
): Promise<{ warnings: string[]; plugins: string[] }> {
  const env = runtime.env ?? process.env;
  const adapters = runtime.adapters ?? createAdapters(options.cwd, env);
  const warnings: string[] = [];
  const upgradedPlugins = new Set<string>();

  for (const platform of platforms) {
    for (const target of targets) {
      const status = await adapters[platform].status(target.plugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (!pluginStatus) {
        continue;
      }

      if (pluginStatus.externalOwnership?.present) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
      }

      if (target.source === 'historical' && !hasHistoricalEvidence(pluginStatus)) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
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

      if (pluginStatus.catalogCompatibility === 'capabilityChanged') {
        const uninstallResult = await uninstallTargetsOnPlatforms(
          [target],
          [platform],
          {
            cwd: options.cwd,
            platform,
            scope: options.scope,
          },
          {
            adapters,
            env,
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
        },
        {
          adapters,
          env,
          resolveInstallOptions: runtime.resolveInstallOptions,
        },
      );
      warnings.push(...installResult.warnings);
      upgradedPlugins.add(target.pluginName);
    }
  }

  return {
    warnings,
    plugins: [...upgradedPlugins],
  };
}

async function runUpgradeAll(
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: CommandRuntime,
  preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
): Promise<{ warnings: string[]; plugins: string[] }> {
  const env = runtime.env ?? process.env;
  const adapters = runtime.adapters ?? createAdapters(options.cwd, env);

  const namesByPlatform = {
    codex: platforms.includes('codex')
      ? await listManagedPluginNamesForPreparedLedger('codex', options.scope, options.cwd, preparedLedger)
      : [],
    claude: platforms.includes('claude')
      ? await listManagedPluginNamesForPreparedLedger('claude', options.scope, options.cwd, preparedLedger)
      : [],
  };

  const allNames = [...new Set([...namesByPlatform.codex, ...namesByPlatform.claude])].sort();
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    allNames,
    {
      allowHistoricalFallback: true,
      env,
    },
  );
  const targetMap = new Map(targets.map((target) => [target.pluginName, target]));

  const blockingReasons: string[] = [];
  for (const platform of platforms) {
    for (const pluginName of namesByPlatform[platform]) {
      const target = targetMap.get(pluginName);
      if (!target) {
        continue;
      }

      const status = await adapters[platform].status(target.plugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (!pluginStatus) {
        continue;
      }

      if (pluginStatus.externalOwnership?.present) {
        blockingReasons.push(
          `${platform}/${pluginName}: ${pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。'}`,
        );
        continue;
      }

      if (
        pluginStatus.catalogCompatibility !== 'current' ||
        pluginStatus.scopeInitialized !== 'yes'
      ) {
        blockingReasons.push(
          `${platform}/${pluginName}: scopeInitialized=${pluginStatus.scopeInitialized ?? '-'} catalogCompatibility=${pluginStatus.catalogCompatibility ?? '-'}`,
        );
      }
    }
  }

  if (blockingReasons.length > 0) {
    throw new Error(
      `\`upgrade --all\` 发现需要显式处理的插件：\n${blockingReasons.map((reason) => `- ${reason}`).join('\n')}`,
    );
  }

  const warnings: string[] = [];
  const upgradedPlugins = new Set<string>();
  for (const platform of platforms) {
    const platformTargets = namesByPlatform[platform]
      .map((pluginName) => targetMap.get(pluginName))
      .filter((target): target is ResolvedPluginTarget => Boolean(target));

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
      },
      {
        adapters,
        env,
        resolveInstallOptions: runtime.resolveInstallOptions,
      },
    );
    warnings.push(...result.warnings);
    for (const target of platformTargets) {
      upgradedPlugins.add(target.pluginName);
    }
  }

  return {
    warnings,
    plugins: [...upgradedPlugins],
  };
}

export async function upgradeCommand(
  pluginNames: string[],
  options: UpgradeCommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  const env = runtime.env ?? process.env;

  if (!options.all && pluginNames.length === 0) {
    throw new Error('upgrade 命令需要插件名，或者显式传入 `--all`。');
  }

  if (options.all && options.requestedSkillTrigger) {
    throw new Error('`upgrade --all` 首版不支持 `--skill-trigger`，请改用显式插件名逐个升级。');
  }

  const adapters = runtime.adapters ?? createAdapters(options.cwd, env);
  if (options.all) {
    const prepared = await prepareCommandEnvironment({
      ensureLocalMarketplace: true,
      env,
    });
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
      const allNames = [
        ...new Set([
          ...(platforms.includes('codex')
            ? await listManagedPluginNamesForPreparedLedger('codex', options.scope, options.cwd, prepared.ledger)
            : []),
          ...(platforms.includes('claude')
            ? await listManagedPluginNamesForPreparedLedger('claude', options.scope, options.cwd, prepared.ledger)
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
      const resolvedInstallOptionsByKey = await resolveInstallOptionsForTargets(
        'upgrade-all',
        targets,
        platforms,
        options,
        prepared.ledger,
      );
      const resolveInstallOptions = await createResolvedInstallOptionsResolver(
        resolvedInstallOptionsByKey,
        options.cwd,
        options.scope,
      );
      const result = await runUpgradeAll(platforms, options, {
        adapters,
        env,
        resolveInstallOptions,
      }, prepared.ledger);

      return {
        platforms,
        plugins: result.plugins,
        warnings: [
          ...prepared.warnings,
          ...collectCommandWarnings(platforms, options.scope),
          ...result.warnings,
        ],
      };
    } catch (error) {
      throw wrapCommandErrorWithWarnings(error, prepared.warnings);
    }
  }

  const prepared = await preparePluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      ensureLocalMarketplace: true,
      allowHistoricalFallback: true,
      env,
    },
  );
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
    const resolvedInstallOptionsByKey = await resolveInstallOptionsForTargets(
      'upgrade',
      prepared.targets,
      platforms,
      options,
      prepared.ledger,
    );
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
        adapters,
        env,
        resolveInstallOptions,
      },
    );

    return {
      platforms,
      plugins: result.plugins,
      warnings: [
        ...prepared.warnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...result.warnings,
      ],
    };
  } catch (error) {
    throw wrapCommandErrorWithWarnings(error, prepared.warnings);
  }
}
