import crypto from 'node:crypto';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { PlatformName } from '../types.js';
import { statusCommandV4 } from '../commands/status-v4.js';
import {
  addCatalogSourceCommand,
  listCatalogSources,
  preflightCatalogSourceMutation,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceMutationProgress,
} from '../commands/catalog-source.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../commands/write-commands.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import {
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import {
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  parsePluginId,
} from '../utils/multi-source-catalog.js';
import {
  coercePluginConfigUpdates,
  readNamespacedPluginConfigStoreIdentity,
  readPluginConfigStore,
  resolveConfigRead,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { RebuildReviewPreflightEvidence } from '../commands/rebuild-command.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
} from './controller.js';
import { buildConfigGroups, buildConfigPage } from './model.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import { targetCanBeUninstalled } from '../utils/target-eligibility.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';

export interface TuiControllerRuntimeTestHooks {
  afterPluginOperationLocksAcquire?: () => Promise<void>;
  onCatalogSourceProgress?: (event: CatalogSourceMutationProgress) => Promise<void> | void;
}

let tuiControllerRuntimeTestHooks: TuiControllerRuntimeTestHooks | undefined;

export function setTuiControllerRuntimeTestHooksForTests(
  hooks: TuiControllerRuntimeTestHooks | undefined,
): void {
  tuiControllerRuntimeTestHooks = hooks;
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const SOURCE_PROGRESS_PHASES: Record<CatalogSourceMutationProgress['stage'], string> = {
  validatingCandidate: '验证候选来源',
  catalogReady: 'Catalog 已读取，索引已刷新',
  scanningReferences: '扫描现有引用和约束',
  savingConfig: '保存来源配置',
};

function pluginIntent(intent: OperationIntent): intent is Extract<OperationIntent, { pluginId: string }> {
  return 'pluginId' in intent;
}

function assertIntentIsLegal(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV4>>['payload']['targets'],
): void {
  const platforms: PlatformName[] = intent.platform === 'both'
    ? ['codex', 'claude']
    : [intent.platform];
  for (const platform of platforms) {
    const selected = targets.find((target) => target.platform === platform && target.scope === intent.scope);
    if (!selected || selected.errors.some((error) => error.code === 'unsupportedTarget')) {
      throw new TuiOperationBlockedError('unsupportedTarget', '所选插件不支持这个平台和使用位置。');
    }
    const otherScopeInstalled = targets.some((target) =>
      target.platform === platform
      && target.scope !== intent.scope
      && (target.state === 'present' || target.state === 'partial'));
    if (intent.action === 'install' && otherScopeInstalled) {
      throw new TuiOperationBlockedError('scopeConflict', '这个平台已安装在另一个使用位置。请先移除原位置。');
    }
    if (intent.action === 'install' && selected.state !== 'absent') {
      throw new TuiOperationBlockedError('targetAlreadyInstalled', '所选位置已经安装。');
    }
    if (intent.action === 'upgrade' && selected.state !== 'present') {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不允许执行这个操作。');
    }
    if (intent.action === 'uninstall' && !targetCanBeUninstalled(selected.state)) {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不允许执行这个操作。');
    }
    if ((intent.action === 'reinstall' || intent.action === 'cleanup') && selected.state === 'absent') {
      throw new TuiOperationBlockedError('targetAbsent', '所选位置没有可处理的 AW 安装。');
    }
  }
}

function assertTypedIssueOrigin(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV4>>['payload']['targets'],
): void {
  if (!intent.originIssue) return;
  const selected = targets.find((target) =>
    target.pluginId === intent.pluginId
    && target.platform === intent.platform
    && target.scope === intent.scope);
  if (intent.originIssue.category === 'incompleteInstallation') {
    if (!selected || !targetCanBeUninstalled(selected.state) || selected.state !== 'partial'
      || !((intent.originIssue.actionId === 'reinstall' && intent.action === 'reinstall')
        || (intent.originIssue.actionId === 'remove' && intent.action === 'uninstall'))) {
      throw new TuiOperationBlockedError('issueOriginInvalid', '原安装问题已变化。');
    }
    return;
  }
  if (intent.originIssue.category === 'scopeConflict') {
    const installedScopes = new Set(targets.filter((target) =>
      target.pluginId === intent.pluginId
      && target.platform === intent.platform
      && (target.state === 'present' || target.state === 'partial')).map((target) => target.scope));
    const correctBranch = intent.action === 'uninstall'
      && ((intent.originIssue.actionId === 'keepUserScope' && intent.scope === 'project')
        || (intent.originIssue.actionId === 'keepProjectScope' && intent.scope === 'user'));
    if (!correctBranch || !installedScopes.has('user') || !installedScopes.has('project')) {
      throw new TuiOperationBlockedError('issueOriginInvalid', '原位置冲突已变化。');
    }
    return;
  }
  throw new TuiOperationBlockedError('issueOriginInvalid', '这个问题没有安全的自动写入动作。');
}

function assertLockedPluginEvidence(
  current: RebuildReviewPreflightEvidence,
  expected: OperationEvidence,
): void {
  const source = expected.source;
  if (!source
    || current.configDigest !== expected.catalog.configDigest
    || current.sourceId !== source.sourceId
    || current.sourceIdentity !== source.sourceIdentity
    || current.resolvedCommit !== source.resolvedCommit
    || current.manifestDigest !== source.manifestDigest
    || current.snapshotDigest !== source.snapshotDigest
    || current.contentDigest !== source.contentDigest) {
    throw new Error('operationReviewStale: 确认后 Catalog 或来源证据发生变化。');
  }
}

export function createTuiControllerDependencies(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): TuiControllerDependencies {
  const loadStatus: TuiControllerDependencies['loadStatus'] = async (signal) => {
    signal.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await statusCommandV4({
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
        verbose: context.diagnostics.verbose,
      });
      signal.throwIfAborted();
      const configured = await listCatalogSources({ env: context.env });
      signal.throwIfAborted();
      if (result.payload.catalog.configDigest !== configured.configDigest) continue;
      const statusById = new Map(result.payload.catalog.sources.map((source) => [source.id, source]));
      return {
        payload: result.payload,
        pluginSummaries: result.pluginSummaries,
        sourceDetails: configured.sources.map((source) => {
          const status = statusById.get(source.id);
          return {
            id: source.id,
            type: source.type,
            primary: source.primary,
            locationSummary: projectCatalogSourceLocation(
              source.type === 'git' ? source.url : source.path,
            ),
            ...(source.type === 'git' ? {
              refPolicy: source.refPolicy.type,
              ...(source.refPolicy.type === 'explicit' ? { explicitRef: source.refPolicy.ref } : {}),
              ...(source.subdir ? { subdir: source.subdir } : {}),
            } : {}),
            pluginCount: 0,
            sourceIdentity: source.sourceIdentity,
            requestedRef: status?.requestedRef ?? (source.type === 'path' ? 'path' : 'AW channel'),
            ...(status?.resolvedCommit ? { resolvedCommit: status.resolvedCommit } : {}),
            ...(status?.catalogVersion ? { catalogVersion: status.catalogVersion } : {}),
            ...(status?.channel ? { channel: status.channel } : {}),
            ...(status?.freshness ? { freshness: status.freshness } : {}),
            configDigest: configured.configDigest,
          };
        }),
      };
    }
    throw new TuiOperationBlockedError(
      'operationReviewStale',
      '状态读取期间来源配置持续变化。请重试。',
    );
  };

  const captureOfflineResetEvidence = async (
    intent: Extract<OperationIntent, { kind: 'configReset' }>,
    signal?: AbortSignal,
  ): Promise<OperationEvidence> => {
    signal?.throwIfAborted();
    const { sourceId, pluginName } = parsePluginId(intent.pluginId);
    if (!sourceId) throw new TuiOperationBlockedError('invalidPluginId', '重置必须使用 canonical pluginId。');
    const configured = await readCatalogSourcesConfigSnapshot(context.env);
    const source = configured.config.sources.find((entry) => entry.id === sourceId);
    if (!source) throw new TuiOperationBlockedError('configResetUnavailable', '来源配置不存在。');
    const configuredIdentity = await calculateCatalogSourceIdentity(source);
    const identity = await readNamespacedPluginConfigStoreIdentity({
      sourceId,
      pluginName,
      scope: intent.scope,
      projectLayer: intent.projectLayer,
      cwd: context.cwd,
      env: context.env,
    });
    signal?.throwIfAborted();
    if (!identity || identity.sourceIdentity !== configuredIdentity
      || (intent.sourceIdentity && intent.sourceIdentity !== identity.sourceIdentity)) {
      throw new TuiOperationBlockedError('configResetUnavailable', '设置层身份不可验证。');
    }
    return {
      catalog: {
        configDigest: configured.digest,
        compositeDigest: digest({ configDigest: configured.digest, sourceId, sourceIdentity: configuredIdentity }),
      },
      source: { sourceId, sourceIdentity: configuredIdentity },
      config: {
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        storeDigest: digest({
          exists: identity.store.exists,
          sourceIdentity: identity.sourceIdentity,
          values: identity.store.values,
        }),
      },
    };
  };

  const captureEvidence: TuiControllerDependencies['captureEvidence'] = async (intent, signal) => {
    if (intent.kind === 'sourceMutation') {
      signal?.throwIfAborted();
      if (intent.action === 'add' && !intent.source
        || intent.action === 'update' && !intent.update) {
        throw new TuiOperationBlockedError('invalidSourceMutation', '来源操作缺少候选输入。');
      }
      const request = intent.action === 'add'
        ? { action: 'add' as const, source: intent.source! }
        : intent.action === 'update'
          ? { action: 'update' as const, sourceId: intent.sourceId, update: intent.update! }
          : { action: intent.action, sourceId: intent.sourceId };
      const preview = await preflightCatalogSourceMutation({
        request,
        cwd: context.cwd,
        env: context.env,
      });
      return {
        catalog: { configDigest: preview.configDigest, compositeDigest: preview.candidateDigest },
        sourceWrite: {
          configDigest: preview.configDigest,
          candidateDigest: preview.candidateDigest,
          ...(preview.sourceIdentity ? { sourceIdentity: preview.sourceIdentity } : {}),
          inventoryDigest: digest({ references: preview.references.references, errors: preview.references.errors }),
          referenceCount: preview.references.references.length,
          inventoryComplete: preview.references.errors.length === 0,
        },
      };
    }
    if (!pluginIntent(intent)) {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    if (intent.kind === 'configReset' && intent.offline) {
      return captureOfflineResetEvidence(intent, signal);
    }
    signal?.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const status = await statusCommandV4({
      plugins: [intent.pluginId],
      ...('platform' in intent ? { platform: intent.platform } : {}),
      ...(intent.kind !== 'pluginWrite' && intent.scope === 'project'
        ? { scope: intent.scope }
        : {}),
      cwd: context.cwd,
      env: context.env,
      cliVersion: packageInfo.version,
    });
    signal?.throwIfAborted();
    const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
    const selected = await withResolvedCatalogPlugin({
      selector: intent.pluginId,
      cliVersion: packageInfo.version,
      freshnessPolicy: 'cacheFirst',
      configSnapshot,
      env: context.env,
      ...(signal ? { signal } : {}),
      consume: ({ plugin, source }) => {
        const entry = source.manifest.entries.find((candidate) => candidate.name === plugin.manifest.name)!;
        return {
          pluginName: plugin.manifest.name,
          source: {
            sourceId: source.sourceId,
            sourceIdentity: source.sourceIdentity,
            requestedRef: source.requestedRef,
            resolvedCommit: source.resolvedCommit,
            manifestDigest: source.manifestDigest,
            snapshotDigest: source.snapshotDigest,
            contentDigest: entry.contentDigest,
          },
        };
      },
    });
    const evidence: OperationEvidence = {
      catalog: {
        configDigest: status.payload.catalog.configDigest,
        compositeDigest: status.payload.catalog.compositeDigest,
      },
      source: selected.source,
      targetFingerprint: digest(status.payload.targets.map((target) => ({
        pluginId: target.pluginId,
        sourceIdentity: target.sourceIdentity,
        platform: target.platform,
        scope: target.scope,
        state: target.state,
        errors: target.errors.map((error) => error.code).sort(),
        components: target.components.map((component) => [component.key, component.state])
          .sort(([left], [right]) => left!.localeCompare(right!, 'en')),
      })).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
        .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'))),
    };
    if (intent.kind === 'configSave' || intent.kind === 'configReset') {
      const store = await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      evidence.config = {
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        schemaIdentity: selected.source.manifestDigest,
        storeDigest: digest({ exists: store.exists, values: store.values }),
      };
    }
    return evidence;
  };

  const dependencies: TuiControllerDependencies = {
    loadStatus,
    async inspectSourceRemoval(sourceId, signal) {
      signal.throwIfAborted();
      const inventory = await inventoryCatalogSourceReferences({
        cwd: context.cwd,
        env: context.env,
        includeHistoricalProjects: true,
      });
      signal.throwIfAborted();
      const references = inventory.references.filter((reference) =>
        reference.sourceId === undefined || reference.sourceId === sourceId);
      const dependencies = new Map<string, {
        category: 'installation' | 'config' | 'lifecycle' | 'marketplace';
        pluginId?: string;
        sourceId?: string;
        platform?: PlatformName;
        scope?: 'user' | 'project';
      }>();
      for (const reference of references) {
        const kind = reference.kind.toLocaleLowerCase('en');
        const category: 'installation' | 'config' | 'lifecycle' | 'marketplace' = kind.includes('config')
          ? 'config'
          : kind.includes('lifecycle')
            ? 'lifecycle'
            : kind.includes('marketplace')
              ? 'marketplace'
              : 'installation';
        const stableSourceId = reference.sourceId;
        const pluginId = reference.pluginName && stableSourceId
          ? `${stableSourceId}/${reference.pluginName}`
          : undefined;
        const dependency: {
          category: 'installation' | 'config' | 'lifecycle' | 'marketplace';
          pluginId?: string;
          sourceId?: string;
          platform?: PlatformName;
          scope?: 'user' | 'project';
        } = {
          category,
          ...(pluginId ? { pluginId } : {}),
          ...(stableSourceId ? { sourceId: stableSourceId } : {}),
          ...(reference.platform === 'codex' || reference.platform === 'claude'
            ? { platform: reference.platform } : {}),
          ...(reference.scope === 'user' || reference.scope === 'project'
            ? { scope: reference.scope } : {}),
        };
        const key = [
          category,
          pluginId ?? '',
          stableSourceId ?? '',
          dependency.platform ?? '',
          dependency.scope ?? '',
          category === 'marketplace' ? reference.marketplaceName ?? '' : '',
        ].join('\0');
        dependencies.set(key, dependency);
      }
      const projected = [...dependencies.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([, dependency]) => dependency);
      const complete = inventory.errors.length === 0;
      const count = (category: typeof projected[number]['category']): number | undefined =>
        complete ? projected.filter((reference) => reference.category === category).length : undefined;
      return {
        blocked: !complete || references.length > 0,
        inventoryComplete: complete,
        installationCount: count('installation'),
        configCount: count('config'),
        lifecycleCount: count('lifecycle'),
        marketplaceCount: count('marketplace'),
        dependencies: projected,
      };
    },
    async validateIntent(intent, signal) {
      if (intent.kind === 'sourceMutation') {
        const evidence = await captureEvidence(intent, signal);
        if (evidence.sourceWrite?.configDigest === evidence.sourceWrite?.candidateDigest) {
          throw new TuiOperationBlockedError('sourceNoChanges', '来源没有变化。');
        }
        return;
      }
      if (intent.kind === 'configSave') {
        const packageInfo = await readCliPackageInfo();
        await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy: 'cacheFirst',
          env: context.env,
          signal,
          consume: async ({ plugin }) => {
            if (!plugin.manifest.config) {
              throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
            }
            await coercePluginConfigUpdates({
              schema: plugin.manifest.config.schema,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.schema[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          },
        });
        return;
      }
      if (intent.kind !== 'pluginWrite') return;
      signal.throwIfAborted();
      const packageInfo = await readCliPackageInfo();
      const status = await statusCommandV4({
        plugins: [intent.pluginId],
        platform: intent.platform,
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
      });
      signal.throwIfAborted();
      assertTypedIssueOrigin(intent, status.payload.targets);
      assertIntentIsLegal(intent, status.payload.targets);
    },
    async checkSource(sourceId, signal) {
      const packageInfo = await readCliPackageInfo();
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      return withResolvedMultiSourceCatalog({
        cliVersion: packageInfo.version,
        freshnessPolicy: 'forceRemote',
        sourceIds: [sourceId],
        configSnapshot,
        env: context.env,
        signal,
        consume: (catalog) => {
          const item = catalog.sources[0]!;
          if (item.error) throw item.error;
          return {
            sourceIdentity: item.resolution!.sourceIdentity,
            requestedRef: item.resolution!.requestedRef,
          };
        },
      });
    },
    captureEvidence,
    logError(_error, code, logContext) {
      return context.debugLogger.log({
        type: 'tui:controller-error',
        level: 'debug',
        target: 'debugLog',
        message: logContext?.privateConfigOperation
          ? 'TUI config operation failed.'
          : 'TUI controller operation failed.',
        data: { code },
      });
    },
    async getConfigGroups(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          return buildConfigGroups({ schema: plugin.manifest.config, read });
        },
      });
    },
    async getConfigPage(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          return buildConfigPage({ pluginId, schema: plugin.manifest.config, read });
        },
      });
    },
    async getConfigResetAvailability(pluginId, layer, signal) {
      signal.throwIfAborted();
      const { sourceId, pluginName } = parsePluginId(pluginId);
      if (!sourceId) return { exists: false, sourceIdentityPresent: false };
      const identity = await readNamespacedPluginConfigStoreIdentity({
        sourceId,
        pluginName,
        scope: layer.scope,
        projectLayer: layer.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      signal.throwIfAborted();
      if (!identity) return { exists: false, sourceIdentityPresent: false };
      const configured = await readCatalogSourcesConfigSnapshot(context.env);
      const source = configured.config.sources.find((entry) => entry.id === sourceId);
      const configuredIdentity = source
        ? await calculateCatalogSourceIdentity(source)
        : undefined;
      if (identity.sourceIdentity !== configuredIdentity) {
        return {
          exists: true,
          sourceIdentityPresent: false,
          sourceIdentity: identity.sourceIdentity,
        };
      }
      return {
        exists: true,
        sourceIdentityPresent: true,
        sourceIdentity: identity.sourceIdentity,
        storeDigest: digest({
          exists: identity.store.exists,
          sourceIdentity: identity.sourceIdentity,
          values: identity.store.values,
        }),
      };
    },
    async executeIntent(intent, expectedEvidence) {
      const currentEvidence = await captureEvidence(intent);
      if (operationEvidenceFingerprint(currentEvidence) !== operationEvidenceFingerprint(expectedEvidence)) {
        throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
      }
      if (intent.kind === 'sourceMutation') {
        const packageInfo = await readCliPackageInfo();
        const runtime = {
          onProgress: async (event: CatalogSourceMutationProgress) => {
            const phase = SOURCE_PROGRESS_PHASES[event.stage];
            progressFeed?.setCurrent(
              { target: 'Catalog 来源配置', phase },
              `来源操作：${phase}`,
            );
            await tuiControllerRuntimeTestHooks?.onCatalogSourceProgress?.(event);
          },
        };
        const common = {
          cwd: context.cwd,
          env: context.env,
          expectedConfigDigest: expectedEvidence.sourceWrite?.configDigest,
          runtime,
        };
        if (intent.action === 'add' && intent.source) {
          return addCatalogSourceCommand({ ...common, source: intent.source, cliVersion: packageInfo.version });
        }
        if (intent.action === 'update' && intent.update) {
          return updateCatalogSourceCommand({ ...common, sourceId: intent.sourceId, update: intent.update, cliVersion: packageInfo.version });
        }
        if (intent.action === 'setPrimary') {
          return setPrimaryCatalogSourceCommand({ ...common, sourceId: intent.sourceId });
        }
        if (intent.action === 'remove') {
          return removeCatalogSourceCommand({ ...common, sourceId: intent.sourceId });
        }
        throw new TuiOperationBlockedError('invalidSourceMutation', '来源操作缺少候选输入。');
      }
      if (intent.kind === 'pluginWrite') {
        const options = { cwd: context.cwd, platform: intent.platform, scope: intent.scope };
        const command = {
          install: installWriteCommand,
          upgrade: upgradeWriteCommand,
          reinstall: reinstallWriteCommand,
          uninstall: uninstallWriteCommand,
          cleanup: cleanupWriteCommand,
        }[intent.action];
        const expectedSource = expectedEvidence.source;
        if (!expectedSource) {
          throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少来源身份。');
        }
        return withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: (await readCliPackageInfo()).version,
          freshnessPolicy: 'requireRemote',
          env: context.env,
          consume: async ({ source }) => {
            if (source.sourceId !== expectedSource.sourceId
              || source.sourceIdentity !== expectedSource.sourceIdentity) {
              throw new TuiOperationBlockedError('operationReviewStale', '确认后来源身份发生变化。');
            }
            let fullEvidenceChecked = false;
            const result = await command([intent.pluginId], options, {
                ...context,
                expectedCatalogConfigDigest: expectedEvidence.catalog.configDigest,
                afterDependencyOperationLocksAcquire: async () => {
                  await tuiControllerRuntimeTestHooks?.afterPluginOperationLocksAcquire?.();
                },
                reviewPreflight: async (current) => {
                  assertLockedPluginEvidence(current, expectedEvidence);
                  const observed = await captureEvidence(intent);
                  const observedFingerprint = operationEvidenceFingerprint(fullEvidenceChecked
                    ? { ...observed, targetFingerprint: expectedEvidence.targetFingerprint }
                    : observed);
                  if (observedFingerprint !== operationEvidenceFingerprint(expectedEvidence)) {
                    throw new TuiOperationBlockedError(
                      'operationReviewStale',
                      'operationReviewStale: 确认后状态发生变化。',
                    );
                  }
                  fullEvidenceChecked = true;
                },
              });
              const staleFailure = result.targetResults.find((entry) => entry.state === 'failed'
                && (entry.errorCode === 'operationReviewStale'
                  || entry.errorCode === 'dependencyPlanStale'
                  || entry.message?.startsWith('operationReviewStale:')))
                ?? result.rebuildResults.find((entry) => entry.status === 'failed'
                  && (entry.error.message.startsWith('operationReviewStale:')
                    || entry.error.message.startsWith('dependencyPlanStale:')));
              if (staleFailure && !result.targetResults.some((entry) => entry.state === 'completed')) {
                throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
              }
            return result;
          },
        });
      }
      if (intent.kind === 'configSave' || intent.kind === 'configReset') {
        const packageInfo = await readCliPackageInfo();
        const reviewPreflight = async (): Promise<void> => {
          const lockedEvidence = await captureEvidence(intent);
          if (operationEvidenceFingerprint(lockedEvidence)
            !== operationEvidenceFingerprint(expectedEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
        };
        if (intent.kind === 'configReset' && intent.offline) {
          const source = expectedEvidence.source;
          if (!source || source.sourceId !== parsePluginId(intent.pluginId).sourceId) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少可信来源身份。');
          }
          return resetPluginConfigWithHelper({
            sourceId: source.sourceId,
            sourceIdentity: source.sourceIdentity,
            pluginName: parsePluginId(intent.pluginId).pluginName,
            plugin: null,
            scope: intent.scope,
            projectLayer: intent.projectLayer,
            cwd: context.cwd,
            env: context.env,
            nativeCliRunner: context.nativeCliRunner,
            rebuildRuntime: context,
            reviewPreflight,
          });
        }
        return withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy: intent.kind === 'configSave' ? 'requireRemote' : 'cacheFirst',
          env: context.env,
          consume: async ({ plugin }) => {
            const result = intent.kind === 'configSave'
              ? await applyPluginConfigWrite({
                  plugin,
                  pluginName: plugin.manifest.name,
                  scope: intent.scope,
                  projectLayer: intent.projectLayer,
                  cwd: context.cwd,
                  env: context.env,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: context,
                  request: { updates: intent.updates, removeKeys: intent.removeKeys },
                  reviewPreflight,
                })
              : await resetPluginConfigWithHelper({
                  plugin,
                  pluginName: plugin.manifest.name,
                  scope: intent.scope,
                  projectLayer: intent.projectLayer,
                  cwd: context.cwd,
                  env: context.env,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: context,
                  reviewPreflight,
                });
            return result;
          },
        });
      }
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    },
  };
  return dependencies;
}

export function createConsoleTuiV4Controller(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): TuiController {
  return new TuiController(createTuiControllerDependencies(context, progressFeed), progressFeed);
}
